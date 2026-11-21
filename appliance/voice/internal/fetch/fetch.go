// Package fetch is the model fetcher (NX-473): it downloads the speech models the runtime asks for from the sources the
// release's manifest names, one at a time, resuming a download where it stopped, and puts a model where the voice
// service reads it only once its size and sha256 match. What it was asked for is kept beside the models
// (`.wanted.json`), so a download carries on after a restart. It never decides what to fetch; the runtime does.
package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Margin is the room a download leaves free on the models' disk beside the model itself.
const Margin = 256 << 20

// IdleTimeout ends a download that received nothing for this long (it waits and resumes).
const IdleTimeout = 60 * time.Second

// wantedFile keeps the ids the runtime asked for and that aren't there yet.
const wantedFile = ".wanted.json"

// Fetcher downloads the manifest's models into Dir.
type Fetcher struct {
	Manifest models.Manifest
	Dir      string
	Client   *http.Client
	Log      func(format string, args ...any)
	// Free is the room left where the models are (statfs; tests set their own).
	Free func(dir string) (int64, error)
	// Backoff is the wait before try n (1, 2, …) after a download that couldn't go on.
	Backoff func(n int) time.Duration
	// Idle is how long a download may receive nothing (IdleTimeout when 0).
	Idle time.Duration

	mu      sync.Mutex
	entries map[string]*entry
	wake    chan struct{}
}

type entry struct {
	model    models.Model
	state    string
	received int64
	problem  string
	// wanted: asked for and not there yet; asked orders the queue.
	wanted  bool
	asked   time.Time
	retryAt time.Time
	// tries counts downloads that couldn't go on, bad the ones whose bytes were wrong.
	tries, bad int
	cancel     context.CancelFunc
}

// Classes of a download's end.
var (
	errNoRoom   = errors.New("not enough room")
	errBadBytes = errors.New("the download isn't what the manifest says")
	errRefused  = errors.New("the source refused it")
	errServer   = errors.New("the source failed")
)

// Start reads what is on disk and what was asked for, and runs the downloads until ctx ends.
func (f *Fetcher) Start(ctx context.Context) error {
	if f.Free == nil {
		f.Free = freeBytes
	}
	if f.Backoff == nil {
		f.Backoff = Backoff
	}
	if f.Idle == 0 {
		f.Idle = IdleTimeout
	}
	f.wake = make(chan struct{}, 1)
	f.entries = map[string]*entry{}
	wanted := f.readWanted()
	now := time.Now()
	for _, m := range f.Manifest.Models {
		e := &entry{model: m, state: local.VoiceModelStateAbsent}
		if models.Present(f.Dir, m) {
			e.state, e.received = local.VoiceModelStateReady, m.TotalSize()
		} else {
			e.received = models.PartialSize(f.Dir, m)
			// Opt-in Dutch voice (supertonic) is never auto-resumed from .wanted.json
			// at startup; the server asks again only while the saved setting is on.
			if m.ID != local.VoiceModelSupertonic && slices.Contains(wanted, m.ID) {
				e.state, e.wanted, e.asked = local.VoiceModelStateWaiting, true, now
			}
		}
		f.entries[m.ID] = e
	}
	go f.loop(ctx)
	return nil
}

// State is every model in the manifest and how far it is (VoiceModelsState).
func (f *Fetcher) State() local.VoiceModelsState {
	return f.state(nil, true)
}

// StateFor is the v1 HTTP API state for a caller: speech-recognition models are always returned, while opt-in models
// such as supertonic are included only when explicitly named in include so a rolled-back runtime whose v1 contract
// accepts only speech-recognition models still parses the response.
func (f *Fetcher) StateFor(include []string) local.VoiceModelsState {
	return f.state(include, false)
}

func isDefaultV1Model(id string) bool {
	return id == local.VoiceModelParakeet || id == local.VoiceModelWhisper
}

func (f *Fetcher) state(include []string, all bool) local.VoiceModelsState {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := local.VoiceModelsState{V: 1, Models: []local.VoiceModelState{}}
	for _, m := range f.Manifest.Models {
		if !all && !isDefaultV1Model(m.ID) && !slices.Contains(include, m.ID) {
			continue
		}
		e := f.entries[m.ID]
		s := local.VoiceModelState{ID: m.ID, State: e.state, Size: m.TotalSize(), Received: e.received}
		if e.problem != "" {
			p := e.problem
			s.Problem = &p
		}
		out.Models = append(out.Models, s)
	}
	if free, err := f.Free(f.Dir); err == nil {
		out.Free = &free
	}
	return out
}

// ErrUnknown is a model the manifest doesn't name.
var ErrUnknown = errors.New("no such model in this release")

// Fetch asks for model id: a model that is there or on its way stays as it is; a failed one starts again.
func (f *Fetcher) Fetch(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.entries[id]
	if !ok {
		return ErrUnknown
	}
	if e.state == local.VoiceModelStateReady || e.wanted {
		return nil
	}
	e.wanted, e.asked, e.retryAt, e.tries, e.bad = true, time.Now(), time.Time{}, 0, 0
	e.state, e.problem = local.VoiceModelStateWaiting, ""
	f.saveWanted()
	f.poke()
	f.logf("%s: asked for (%d MB)", id, e.model.TotalSize()>>20)
	return nil
}

// Remove stops model id's download and deletes it.
func (f *Fetcher) Remove(id string) error {
	f.mu.Lock()
	e, ok := f.entries[id]
	if !ok {
		f.mu.Unlock()
		return ErrUnknown
	}
	if e.cancel != nil {
		e.cancel()
		e.cancel = nil
	}
	e.wanted, e.state, e.problem, e.received = false, local.VoiceModelStateAbsent, "", 0
	f.saveWanted()
	f.mu.Unlock()
	for _, p := range []string{models.Path(f.Dir, e.model), models.PartPath(f.Dir, e.model)} {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	f.logf("%s: removed", id)
	return nil
}

func (f *Fetcher) poke() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// loop runs the next wanted download whose time has come, one at a time.
func (f *Fetcher) loop(ctx context.Context) {
	for {
		e, wait := f.next()
		if e == nil {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-f.wake:
			case <-timer.C:
			}
			timer.Stop()
			continue
		}
		f.run(ctx, e)
		if ctx.Err() != nil {
			return
		}
	}
}

// next is the first wanted model whose wait is over, or how long until one's is.
func (f *Fetcher) next() (*entry, time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var best *entry
	wait := time.Hour
	now := time.Now()
	for _, m := range f.Manifest.Models {
		e := f.entries[m.ID]
		if !e.wanted {
			continue
		}
		if d := e.retryAt.Sub(now); d > 0 {
			wait = min(wait, d)
			continue
		}
		if best == nil || e.asked.Before(best.asked) {
			best = e
		}
	}
	return best, wait
}

// run downloads e and decides what follows: ready, wait and try again, or failed until asked again.
func (f *Fetcher) run(ctx context.Context, e *entry) {
	dctx, cancel := context.WithCancel(ctx)
	f.mu.Lock()
	e.cancel, e.state = cancel, local.VoiceModelStateDownloading
	f.mu.Unlock()
	start := time.Now()
	err := f.download(dctx, e)
	cancel()
	f.mu.Lock()
	defer f.mu.Unlock()
	e.cancel = nil
	if !e.wanted { // removed while it ran: nothing of it stays, even if it had just finished
		_ = os.RemoveAll(models.Path(f.Dir, e.model))
		_ = os.RemoveAll(models.PartPath(f.Dir, e.model))
		e.state, e.received = local.VoiceModelStateAbsent, 0
		return
	}
	total := e.model.TotalSize()
	switch {
	case err == nil:
		e.state, e.received, e.problem, e.wanted = local.VoiceModelStateReady, total, "", false
		f.logf("%s: ready, %d MB in %s", e.model.ID, total>>20, time.Since(start).Round(time.Second))
	case ctx.Err() != nil: // the service stops: the part stays, the next start carries on
		e.state = local.VoiceModelStateWaiting
		return
	case errors.Is(err, errBadBytes) && e.bad < 1:
		e.bad++
		e.state, e.problem = local.VoiceModelStateWaiting, local.VoiceModelProblemBadDownload
		f.logf("%s: the download was damaged, starting again: %v", e.model.ID, err)
	case errors.Is(err, errBadBytes):
		_ = os.RemoveAll(models.PartPath(f.Dir, e.model))
		e.received = 0
		f.fail(e, local.VoiceModelProblemBadDownload, err)
	case errors.Is(err, errNoRoom):
		f.fail(e, local.VoiceModelProblemNoRoom, err)
	case errors.Is(err, errRefused):
		f.fail(e, local.VoiceModelProblemFailed, err)
	default:
		e.tries++
		e.state, e.problem = local.VoiceModelStateWaiting, local.VoiceModelProblemNoNetwork
		if errors.Is(err, errServer) {
			e.problem = local.VoiceModelProblemFailed
		}
		e.retryAt = time.Now().Add(f.Backoff(e.tries))
		f.logf("%s: stopped at %d of %d MB, trying again in %s: %v", e.model.ID, e.received>>20, total>>20, f.Backoff(e.tries), err)
	}
	f.saveWanted()
}

func (f *Fetcher) fail(e *entry, problem string, err error) {
	e.state, e.problem, e.wanted = local.VoiceModelStateFailed, problem, false
	f.logf("%s: failed (%s): %v", e.model.ID, problem, err)
}

// download fetches e's model into its staging file or directory (resuming), checks it and renames it into place.
func (f *Fetcher) download(ctx context.Context, e *entry) error {
	if e.model.Multi() {
		return f.downloadMulti(ctx, e)
	}
	m := e.model
	if err := f.fetchFile(ctx, e, m.URL, models.PartPath(f.Dir, m), models.Path(f.Dir, m), m.Size, m.SHA256, 0, m.Size); err != nil {
		return err
	}
	syncDir(f.Dir)
	return nil
}

// downloadMulti fetches every file of a multi-file model into a staging directory, checks each file's size and sha256,
// and renames the directory into place only once every file matches.
func (f *Fetcher) downloadMulti(ctx context.Context, e *entry) error {
	m := e.model
	stage := models.PartPath(f.Dir, m)
	final := models.Path(f.Dir, m)
	total := m.TotalSize()
	already := models.PartialSize(f.Dir, m)
	if free, err := f.Free(f.Dir); err == nil && free < total-already+Margin {
		return fmt.Errorf("%w: %d MB free, %d MB needed", errNoRoom, free>>20, (total-already+Margin)>>20)
	}
	if err := os.MkdirAll(stage, 0o750); err != nil {
		return fmt.Errorf("%w: %v", errNoRoom, err)
	}
	want := make(map[string]bool, len(m.Files))
	var done int64
	for _, mf := range m.Files {
		want[mf.Name] = true
		dest := filepath.Join(stage, mf.Name)
		part := filepath.Join(stage, "."+mf.Name+models.PartSuffix)
		if verifyFile(dest, mf.Size, mf.SHA256) {
			_ = os.Remove(part)
			done += mf.Size
			f.progress(e, done)
			continue
		}
		_ = os.Remove(dest)
		if err := f.fetchFile(ctx, e, mf.URL, part, dest, mf.Size, mf.SHA256, done, total); err != nil {
			return err
		}
		done += mf.Size
		f.progress(e, done)
	}
	if entries, err := os.ReadDir(stage); err == nil {
		for _, ent := range entries {
			if !want[ent.Name()] {
				_ = os.RemoveAll(filepath.Join(stage, ent.Name()))
			}
		}
	}
	syncDir(stage)
	// An incomplete final directory would block Rename; we only reach here when the model isn't complete yet.
	_ = os.RemoveAll(final)
	if err := os.Rename(stage, final); err != nil {
		return err
	}
	syncDir(f.Dir)
	return nil
}

// fetchFile downloads one file from url into part (resuming where it stopped), verifies its size and sha256, and
// renames it to dest.
func (f *Fetcher) fetchFile(ctx context.Context, e *entry, url, part, dest string, size int64, wantSHA string, progressBase, total int64) error {
	fh, err := os.OpenFile(part, os.O_RDWR|os.O_CREATE, 0o640)
	if err != nil {
		return fmt.Errorf("%w: %v", errNoRoom, err)
	}
	defer fh.Close()
	have, err := fh.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if have > size {
		if err := restart(fh); err != nil {
			return err
		}
		have = 0
	}
	h := sha256.New()
	if have > 0 {
		if _, err := fh.Seek(0, io.SeekStart); err != nil {
			return err
		}
		if _, err := io.CopyN(h, fh, have); err != nil {
			return err
		}
	}
	f.progress(e, progressBase+have)
	remaining := max(total-(progressBase+have), size-have)
	if free, err := f.Free(f.Dir); err == nil && free < remaining+Margin {
		return fmt.Errorf("%w: %d MB free, %d MB needed", errNoRoom, free>>20, (remaining+Margin)>>20)
	}
	if have < size {
		got, err := f.get(ctx, e, url, fh, h, have, size, progressBase)
		have = got
		if err != nil {
			if errors.Is(err, errBadBytes) {
				_ = fh.Close()
				_ = os.Remove(part)
				f.progress(e, progressBase)
			}
			return err
		}
	}
	if have != size {
		return fmt.Errorf("%d of %d bytes", have, size)
	}
	if sum := hex.EncodeToString(h.Sum(nil)); sum != wantSHA {
		_ = fh.Close()
		_ = os.Remove(part)
		f.progress(e, progressBase)
		return fmt.Errorf("%w: sha256 %s", errBadBytes, sum)
	}
	if err := fh.Sync(); err != nil {
		return err
	}
	if err := fh.Close(); err != nil {
		return err
	}
	return os.Rename(part, dest)
}

// get requests the rest of url from have on and appends it to fh, hashing as it goes; returns the bytes fh holds then.
func (f *Fetcher) get(ctx context.Context, e *entry, url string, fh *os.File, h hash.Hash, have, size, progressBase int64) (int64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return have, fmt.Errorf("%w: %v", errRefused, err)
	}
	req.Header.Set("User-Agent", "whombat-voice-models")
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return have, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusPartialContent && have > 0:
		var start int64
		if _, err := fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-", &start); err != nil || start != have {
			return have, fmt.Errorf("%w: the source answered another range (%s)", errServer, resp.Header.Get("Content-Range"))
		}
	case resp.StatusCode == http.StatusOK:
		// The whole file again (a source that doesn't do ranges): start over.
		if have > 0 {
			if err := restart(fh); err != nil {
				return have, err
			}
			h.Reset()
			have = 0
			f.progress(e, progressBase)
		}
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && have == size:
		return have, nil
	case resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		_ = restart(fh)
		f.progress(e, progressBase)
		return 0, fmt.Errorf("%w: range %d refused", errServer, have)
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode >= 500:
		return have, fmt.Errorf("%w: %s", errServer, resp.Status)
	default:
		return have, fmt.Errorf("%w: %s", errRefused, resp.Status)
	}
	if _, err := fh.Seek(have, io.SeekStart); err != nil {
		return have, err
	}
	// Nothing for Idle: the download stops (and waits to resume).
	idle := time.AfterFunc(f.Idle, cancel)
	defer idle.Stop()
	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(f.Idle)
			if have+int64(n) > size {
				return have, fmt.Errorf("%w: more than %d bytes", errBadBytes, size)
			}
			if _, err := fh.Write(buf[:n]); err != nil {
				if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
					return have, fmt.Errorf("%w: %v", errNoRoom, err)
				}
				return have, err
			}
			_, _ = h.Write(buf[:n])
			have += int64(n)
			f.progress(e, progressBase+have)
		}
		if rerr == io.EOF {
			return have, nil
		}
		if rerr != nil {
			return have, rerr
		}
	}
}

func verifyFile(path string, size int64, wantSHA string) bool {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != size {
		return false
	}
	fh, err := os.Open(path)
	if err != nil {
		return false
	}
	defer fh.Close()
	h := sha256.New()
	n, err := io.Copy(h, fh)
	return err == nil && n == size && hex.EncodeToString(h.Sum(nil)) == wantSHA
}

func syncDir(path string) {
	if d, err := os.Open(path); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
}

func restart(fh *os.File) error {
	if err := fh.Truncate(0); err != nil {
		return err
	}
	_, err := fh.Seek(0, io.SeekStart)
	return err
}

func (f *Fetcher) progress(e *entry, n int64) {
	f.mu.Lock()
	e.received = n
	f.mu.Unlock()
}

// readWanted is the ids asked for before a restart.
func (f *Fetcher) readWanted() []string {
	var ids []string
	if b, err := os.ReadFile(filepath.Join(f.Dir, wantedFile)); err == nil {
		_ = json.Unmarshal(b, &ids)
	}
	return ids
}

// saveWanted keeps the ids that are asked for and not there (f.mu held).
// Opt-in supertonic is omitted so a restart never resumes it without the server asking again.
func (f *Fetcher) saveWanted() {
	ids := []string{}
	for _, m := range f.Manifest.Models {
		if m.ID == local.VoiceModelSupertonic {
			continue
		}
		if f.entries[m.ID].wanted {
			ids = append(ids, m.ID)
		}
	}
	b, _ := json.Marshal(ids)
	tmp := filepath.Join(f.Dir, wantedFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o640); err == nil {
		_ = os.Rename(tmp, filepath.Join(f.Dir, wantedFile))
	}
}

// Backoff is 30 s, 1, 2, 5, 10, then 15 minutes.
func Backoff(n int) time.Duration {
	steps := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute}
	if n-1 < len(steps) {
		return steps[max(n-1, 0)]
	}
	return 15 * time.Minute
}

func freeBytes(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func (f *Fetcher) logf(format string, args ...any) {
	if f.Log != nil {
		f.Log(format, args...)
	}
}
