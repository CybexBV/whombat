package quarantine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// The set-aside journal: <persist>/whombat-set-aside-<stamp>/set-aside.json, root's, next to what prepare set aside.
// It records what a restore changed on this box, written before each change, so whatever stops a restore (an error,
// a crash, the power) is undone from it: by the restore itself, and at the next start by Recover.

// JournalKind of the set-aside journal.
const JournalKind = "whombat.set-aside/1"

const (
	asidePrefix = "whombat-set-aside-"
	journalName = "set-aside.json"
)

// Stages of the app's restore in the journal.
const (
	// StageRestoring: prepare and apply are running.
	StageRestoring = "restoring"
	// StageRestored: the checkpoint is in place; the restore unit's schema step hasn't finished yet.
	StageRestored = "restored"
	// StageDone: the schema step finished and the runtime runs in quarantine for the person's answers.
	StageDone = "done"
)

// Journal is what a restore set aside and how far it got.
type Journal struct {
	Kind  string    `json:"kind"`
	Stamp string    `json:"stamp"`
	At    time.Time `json:"at"`
	// DB is the runtime's database; AsideDB what prepare renames it to ("" when there was none). Written before the
	// rename.
	DB      string `json:"db,omitempty"`
	AsideDB string `json:"asideDb,omitempty"`
	// Prepared: everything is set aside, so from here on the sources may hold restored data (an undo empties them).
	Prepared bool `json:"prepared"`
	// Emptied: an undo removed what the restore put in the sources (a second undo mustn't empty them again: what
	// was moved back is the fresh install's).
	Emptied bool `json:"emptied,omitempty"`
	// App is the app's restore (nil for the console's prepare and apply).
	App *AppJournal `json:"app,omitempty"`

	dir string
}

// AppJournal is the app's restore in the journal.
type AppJournal struct {
	CheckpointID string `json:"checkpointId"`
	Stage        string `json:"stage"`
}

// Dir is where the journal and what was set aside are.
func (j *Journal) Dir() string { return j.dir }

func (j *Journal) save() error {
	b, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	return writeRootFile(filepath.Join(j.dir, journalName), append(b, '\n'))
}

// writeRootFile writes a file in a directory of root's (the set-aside folder in /persist): a new temp file, fsync,
// rename, fsync of the directory. Nobody else can write there, so nothing is followed or swapped.
func writeRootFile(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// newJournal makes the set-aside folder and its journal, before anything is moved.
func newJournal(c *state.Config, db string, app *AppJournal) (*Journal, error) {
	stamp := time.Now().UTC().Format("20060102T150405.000Z")
	stamp = strings.ReplaceAll(stamp, ".", "")
	dir := filepath.Join(c.Persist, asidePrefix+stamp)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	j := &Journal{Kind: JournalKind, Stamp: stamp, At: time.Now().UTC(), DB: db, App: app, dir: dir}
	err := j.save()
	if err == nil {
		err = syncFS(c.Persist) // the folder itself survives a power cut before anything moves into it
	}
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return j, nil
}

// Journals lists the set-aside folders that have a journal, oldest first. Folders without one (made before the
// journal existed) are left alone.
func Journals(c *state.Config) ([]*Journal, error) {
	ents, err := os.ReadDir(c.Persist)
	if err != nil {
		return nil, err
	}
	var out []*Journal
	for _, e := range ents {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), asidePrefix) {
			continue
		}
		j, err := loadJournal(filepath.Join(c.Persist, e.Name()))
		if err != nil {
			continue
		}
		out = append(out, j)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Stamp < out[b].Stamp })
	return out, nil
}

func loadJournal(dir string) (*Journal, error) {
	fi, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	b, err := os.ReadFile(filepath.Join(dir, journalName))
	if err != nil {
		return nil, err
	}
	var j Journal
	if err := json.Unmarshal(b, &j); err != nil || j.Kind != JournalKind {
		return nil, fmt.Errorf("%s: not a set-aside journal", dir)
	}
	j.dir = dir
	return &j, nil
}

// Pending is the journal of the restore an undo puts back: the marker's, else the newest not released (nil: none).
func Pending(c *state.Config, m *Marker) *Journal {
	if m != nil {
		return journalFor(c, m)
	}
	return pending(c)
}

// journalFor is the journal of the marker's restore: the one it names, else (a marker from before) the newest.
func journalFor(c *state.Config, m *Marker) *Journal {
	js, _ := Journals(c)
	for _, j := range js {
		if m != nil && m.SetAside == j.Stamp {
			return j
		}
	}
	if (m == nil || m.SetAside == "") && len(js) > 0 {
		return js[len(js)-1]
	}
	return nil
}

/* The restore lock -------------------------------------------------------------------------------------------- */

// <persist>/.whombat-restore.lock is held for a whole restore: the app's (the restore unit, its schema step
// included) and the console's prepare, apply and release. Recover leaves alone what a running restore does.
const restoreLockName = ".whombat-restore.lock"

// ErrRestoring: another restore is running.
var ErrRestoring = errors.New("a restore is running on this Whombat")

type heldLock struct{ n, fd int }

var (
	heldMu sync.Mutex
	held   = map[string]*heldLock{} // lock path → this process's hold (nested holds share it)
)

func restoreLockPath(c *state.Config) string { return filepath.Join(c.Persist, restoreLockName) }

// LockHeldByCaller says the restore lock is held by the process that started this one (the restore unit's script
// holds it across its steps).
func LockHeldByCaller(c *state.Config) {
	heldMu.Lock()
	defer heldMu.Unlock()
	if h := held[restoreLockPath(c)]; h != nil {
		h.n++
		return
	}
	held[restoreLockPath(c)] = &heldLock{n: 1, fd: -1}
}

func lockRestore(c *state.Config) (func(), error) {
	heldMu.Lock()
	defer heldMu.Unlock()
	path := restoreLockPath(c)
	release := func() {
		heldMu.Lock()
		defer heldMu.Unlock()
		h := held[path]
		if h == nil {
			return
		}
		if h.n--; h.n == 0 {
			delete(held, path)
			if h.fd >= 0 {
				_ = unix.Flock(h.fd, unix.LOCK_UN)
				_ = unix.Close(h.fd)
			}
		}
	}
	if h := held[path]; h != nil {
		h.n++
		return release, nil
	}
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		unix.Close(fd)
		return nil, ErrRestoring
	}
	held[path] = &heldLock{n: 1, fd: fd}
	return release, nil
}

// waitRunLock takes the backup service's run lock, waiting for a checkpoint or drill that holds it (Recover must not
// give up because a backup happened to start at boot).
func waitRunLock(ctx context.Context, c *state.Config, limit time.Duration) (*state.Lock, error) {
	deadline := time.Now().Add(limit)
	for {
		l, err := state.TryLock(c)
		if !errors.Is(err, state.ErrBusy) || time.Now().After(deadline) {
			return l, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}
