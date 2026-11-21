// Package ghpublish publishes releases to the GitHub repository (Whombat LNK-24): the files as release assets of
// CybexBV/whombat-releases, the role metadata as commits to its metadata/ folder, which the repository's workflow
// signs (snapshot, timestamp) and deploys to GitHub Pages at releases.whombat.com.
//
// The order never lets a box see metadata for files that aren't there: blobs (each once, into its nar-xx bucket
// release) → the release's tuple and indexes (release <release-id>) → the role metadata (git push) → the workflow's
// snapshot and timestamp. A publish that stopped before its push holds every other publish back until it is run
// again (.publish-pending.json), so its signed role never goes up with another's; one that left nothing signed or
// unpushed is given up by itself. A publish commits only the metadata it signed (a clients role the channel publisher
// signs during its upload waits for gh-clients) and is done only once the remote's branch has its commit. One publish
// at a time (a lock in the repository directory). The GitHub REST API is used with a token from the environment;
// boxes never call it.
package ghpublish

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"golang.org/x/sys/unix"
)

// MaxFileBytes is the largest file the publisher sends: GitHub refuses release assets of 2 GiB and more.
const MaxFileBytes int64 = 2<<30 - 1

// The identity of the publisher's commits to the releases repository (the workflow's too).
const (
	CommitName  = "Whombat releases"
	CommitEmail = "releases@whombat.com"
)

// MaxAssets is GitHub's limit of assets in one release.
const MaxAssets = 1000

// TokenEnv is the environment variable the token comes from (a fine-grained token with Contents: read and write
// on CybexBV/whombat-releases only).
const TokenEnv = "WHOMBAT_RELEASES_TOKEN"

// Config configures a publisher.
type Config struct {
	// Dir is the GitHub-layout repository: a clone of whombat-releases whose metadata/ is the Pages site, with the
	// devtuf state, targets/ (the local copy of every file) and the online keys outside git (.gitignore).
	Dir         string
	Owner, Repo string
	// APIURL is the REST API (https://api.github.com).
	APIURL string
	Token  string
	HTTP   *http.Client
	// Git is the git program; Remote and Branch where the metadata is pushed (origin, main).
	Git, Remote, Branch string
	// MaxFile defaults to MaxFileBytes (tests make it small).
	MaxFile int64
	// Retries and Backoff for GitHub's 5xx and 429 answers (default 3, 2 s).
	Retries int
	Backoff time.Duration
	// Log receives one line per step.
	Log func(format string, a ...any)
}

// Publisher publishes to one GitHub repository.
type Publisher struct {
	cfg Config
}

// New checks the configuration.
func New(cfg Config) (*Publisher, error) {
	if cfg.Dir == "" || cfg.Owner == "" || cfg.Repo == "" || cfg.Token == "" {
		return nil, errors.New("ghpublish: the repository directory, owner, repository and token are required")
	}
	if cfg.APIURL == "" {
		cfg.APIURL = "https://api.github.com"
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 2 * time.Hour}
	}
	if cfg.Git == "" {
		cfg.Git = "git"
	}
	if cfg.Remote == "" {
		cfg.Remote = "origin"
	}
	if cfg.Branch == "" {
		cfg.Branch = "main"
	}
	if cfg.MaxFile == 0 {
		cfg.MaxFile = MaxFileBytes
	}
	if cfg.Retries == 0 {
		cfg.Retries = 3
	}
	if cfg.Backoff == 0 {
		cfg.Backoff = 2 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = func(string, ...any) {}
	}
	return &Publisher{cfg: cfg}, nil
}

// Result reports a publish.
type Result struct {
	ReleaseID      string   `json:"releaseId,omitempty"`
	Channel        string   `json:"channel,omitempty"`
	Uploaded       []string `json:"uploaded"`
	Present        int      `json:"present"`
	UploadedBytes  int64    `json:"uploadedBytes"`
	MetadataPushed bool     `json:"metadataPushed"`
	Commit         string   `json:"commit,omitempty"`
}

// lock serializes publishes (<dir>/.publish.lock; the devtuf lock is taken around signing only).
func (p *Publisher) lock(wait time.Duration) (func(), error) {
	f, err := os.OpenFile(filepath.Join(p.cfg.Dir, ".publish.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err == nil {
			return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
		} else if err != unix.EWOULDBLOCK || time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("ghpublish: another publish holds %s: %w", p.cfg.Dir, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// pendingFile records a publish that may have signed role metadata whose files aren't all on GitHub yet: until the
// same publish runs again and pushes, no other publish may push the metadata folder (it would carry that role along).
const pendingFile = ".publish-pending.json"

type pendingPublish struct {
	Channel   string `json:"channel"`
	ReleaseID string `json:"releaseId"`
	// Action distinguishes non-release metadata operations on the same channel (e.g. pause vs resume).
	Action string `json:"action,omitempty"`
	// Base is what the metadata folder had unpushed before this publish signed (another signer's, never pushed by it);
	// Files what its signing wrote (path → sha256). Only Files are committed: a role another signer (the client channel
	// publisher) writes during the upload stays for its own publish. A record without Files (stopped while signing)
	// takes what changed since Base of its own channel's role (and the snapshot and timestamp, where the clone holds
	// their keys): a clients role signed since then is never pushed with it.
	Base  map[string]string `json:"base,omitempty"`
	Files map[string]string `json:"files,omitempty"`
	// Signed: its signing finished and Files are what it wrote. A run again pushes them and never signs again (R1 #4:
	// the key ceremony's signer can't sign a second time once its old keys would be gone).
	Signed bool `json:"signed,omitempty"`
}

func (pp *pendingPublish) same(o *pendingPublish) bool {
	return pp.Channel == o.Channel && pp.ReleaseID == o.ReleaseID && pp.Action == o.Action
}

// own is what of the metadata folder's unpushed files (path → sha256) this publish signed.
func (pp *pendingPublish) own(dirty map[string]string) map[string]string {
	out := map[string]string{}
	if pp.Files != nil {
		for f, h := range pp.Files {
			if dirty[f] == h {
				out[f] = h
			}
		}
		return out
	}
	for f, h := range dirty {
		if (pp.Base == nil || pp.Base[f] != h) && pp.signs(f) {
			out[f] = h
		}
	}
	return out
}

// signs reports whether a metadata file is one this publish's signing writes: its channel's role, or the snapshot and
// timestamp signed over it where the clone holds their keys (tests, a local repository). The key ceremony (channel
// "root") writes the root and the top-level targets.
func (pp *pendingPublish) signs(f string) bool {
	base := filepath.Base(f)
	if base == "timestamp.json" || base == "snapshot.json" || strings.HasSuffix(base, ".snapshot.json") {
		return true
	}
	if pp.Channel == metadata.ROOT && (base == "root.json" || strings.HasSuffix(base, ".targets.json")) {
		return true
	}
	return pp.Channel != "" && strings.HasSuffix(base, "."+pp.Channel+".json")
}

func (p *Publisher) readPending() (*pendingPublish, error) {
	b, err := os.ReadFile(filepath.Join(p.cfg.Dir, pendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var pp pendingPublish
	if err := json.Unmarshal(b, &pp); err != nil {
		return nil, fmt.Errorf("ghpublish: %s: %w", pendingFile, err)
	}
	return &pp, nil
}

// writePending replaces the record in one step (a new file renamed over it): a publish stopped while writing leaves
// the earlier record whole, never a broken one that holds every publish back.
func (p *Publisher) writePending(pp *pendingPublish) error {
	b, _ := json.Marshal(pp)
	path := filepath.Join(p.cfg.Dir, pendingFile)
	f, err := os.CreateTemp(p.cfg.Dir, pendingFile+".*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(f.Name(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	if d, err := os.Open(p.cfg.Dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

func (p *Publisher) clearPending() error {
	if err := os.Remove(filepath.Join(p.cfg.Dir, pendingFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// unpushed lists the files of the metadata folder that differ from the last commit (signed, not committed).
func (p *Publisher) unpushed(ctx context.Context) ([]string, error) {
	out, err := p.git(ctx, "status", "--porcelain", "--untracked-files=all", "--", "metadata")
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		if f := strings.Fields(line); len(f) >= 2 {
			files = append(files, f[len(f)-1]) // the metadata's names have no spaces
		}
	}
	sort.Strings(files)
	return files, nil
}

// unpushedHashes is unpushed with each file's sha256 ("" for a removed file).
func (p *Publisher) unpushedHashes(ctx context.Context) (map[string]string, error) {
	files, err := p.unpushed(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(p.cfg.Dir, f))
		switch {
		case errors.Is(err, os.ErrNotExist):
			out[f] = ""
		case err != nil:
			return nil, err
		default:
			sum := sha256.Sum256(b)
			out[f] = hex.EncodeToString(sum[:])
		}
	}
	return out, nil
}

// ahead reports whether the clone has metadata commits the remote's branch lacks (a push that failed after its commit).
func (p *Publisher) ahead(ctx context.Context) (bool, error) {
	if _, err := p.git(ctx, "fetch", "-q", p.cfg.Remote, p.cfg.Branch); err != nil {
		return false, err
	}
	n, err := p.git(ctx, "rev-list", "--count", "FETCH_HEAD..HEAD")
	if err != nil {
		return false, err
	}
	return n != "0", nil
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// abandoned drops the record of a stopped publish that left nothing behind: none of its signed files unpushed and no
// commit the remote lacks (it stopped before signing, or its metadata was put back by hand). Nothing of it can reach
// GitHub, so it no longer holds the others back.
func (p *Publisher) abandoned(ctx context.Context, pend *pendingPublish) (bool, error) {
	dirty, err := p.unpushedHashes(ctx)
	if err != nil {
		return false, err
	}
	if len(pend.own(dirty)) > 0 {
		return false, nil
	}
	if ahead, err := p.ahead(ctx); err != nil || ahead {
		return false, err
	}
	p.cfg.Log("the publish of %s left nothing signed or unpushed: its record is dropped", pend.what())
	return true, p.clearPending()
}

func (pp *pendingPublish) what() string {
	if pp.ReleaseID == "" {
		if pp.Action != "" {
			return pp.Action + " of " + pp.Channel
		}
		return "a metadata change of " + pp.Channel
	}
	return pp.ReleaseID + " (" + pp.Channel + ")"
}

// Publish signs with sign (it changes the loaded repository: a release into a channel, a promotion), then uploads
// what the channel release id needs (id "" uploads nothing: a change of metadata only, after checking nothing), then
// commits and pushes the role metadata. Before anything it brings the clone up to date (the workflow's snapshot and
// timestamp). A publish that stopped before its push is finished by running it again (its role is signed already);
// until then every other publish is refused, so its role never reaches GitHub before its files.
func (p *Publisher) Publish(ctx context.Context, channel, id string, sign func(r *devtuf.Repo) error) (*Result, error) {
	return p.publish(ctx, channel, id, "", "", sign)
}

func (p *Publisher) publish(ctx context.Context, channel, id, action, commitMsg string, sign func(r *devtuf.Repo) error) (*Result, error) {
	unlock, err := p.lock(10 * time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlock()
	res := &Result{ReleaseID: id, Channel: channel, Uploaded: []string{}}
	if err := p.pull(ctx); err != nil {
		return nil, err
	}
	pend, err := p.readPending()
	if err != nil {
		return nil, err
	}
	this := &pendingPublish{Channel: channel, ReleaseID: id, Action: action}
	if pend != nil && !pend.same(this) {
		gone, err := p.abandoned(ctx, pend)
		if err != nil {
			return nil, err
		}
		if !gone {
			return nil, fmt.Errorf("ghpublish: the publish of %s didn't finish: run it again first; its signed metadata isn't pushed until all its files are on GitHub (to give it up instead: docs/runbooks/updates.md, “A publish that stopped”)", pend.what())
		}
		pend = nil
	}
	fresh := pend == nil
	if fresh {
		dirty, err := p.unpushed(ctx)
		if err != nil {
			return nil, err
		}
		if len(dirty) > 0 {
			return nil, fmt.Errorf("ghpublish: the metadata folder has signed changes no publish pushed (%s): a signed clients role goes up with tufrepo gh-clients; anything else, remove it", strings.Join(dirty, ", "))
		}
	} else {
		this = pend
	}
	var files []devtuf.ReleaseFile
	// Signing and choosing the files hold the devtuf lock, as the client channel publisher's signing does; the upload
	// doesn't (it can take an hour), so a clients role may be signed meanwhile: only the files this signing wrote are
	// committed (this.Files), never a role whose files this upload didn't send.
	signErr := func() error {
		unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlockRepo()
		before, err := p.unpushedHashes(ctx)
		if err != nil {
			return err
		}
		if fresh {
			this.Base = before // another signer's, signed since the check above
		}
		if err := p.writePending(this); err != nil {
			return err
		}
		r, err := devtuf.Load(p.cfg.Dir, devtuf.Options{})
		if err != nil {
			return err
		}
		if !r.GitHub() {
			return errors.New("ghpublish: the repository is not of the GitHub layout")
		}
		if sign != nil && !this.Signed {
			p.cfg.Log("signing: %s", channel)
			if err := sign(r); err != nil {
				return err
			}
		} else if this.Signed {
			p.cfg.Log("signed before: %s", this.what())
		}
		after, err := p.unpushedHashes(ctx)
		if err != nil {
			return err
		}
		mine := this.own(before)
		for f, h := range after {
			if before[f] != h {
				mine[f] = h
			}
		}
		this.Files = mine
		this.Signed = true
		if err := p.writePending(this); err != nil {
			return err
		}
		if id != "" {
			r.InChannel("")
			if files, err = r.ReleaseFiles(channel, id); err != nil {
				return err
			}
		}
		return nil
	}()
	if signErr != nil {
		// Nothing signed (the refusal came first): no publish to finish.
		if dirty, derr := p.unpushedHashes(ctx); derr == nil && len(this.own(dirty)) == 0 {
			if ahead, aerr := p.ahead(ctx); aerr == nil && !ahead {
				_ = p.clearPending()
			}
		}
		return nil, signErr
	}
	if err := p.Upload(ctx, files, res); err != nil {
		return res, err
	}
	msg := commitMsg
	if msg == "" {
		msg = "metadata"
		if id != "" {
			msg = channel + ": " + id
		}
	}
	commit, err := p.commitPush(ctx, msg, this.Files)
	if err != nil {
		return res, err
	}
	res.MetadataPushed, res.Commit = commit != "", commit
	return res, p.clearPending()
}

// Rotate is the key ceremony (ONE-05) published: devtuf's RotateTopLevel signs the new root and top-level targets,
// Publish pushes them, and only then are the old online root and targets keys retired (FinishRotation, R1 #4). A run
// that stopped at its push pushes what is signed without signing again; one that stopped while signing carries on with
// the same keys (devtuf's record); one that stopped after its push retires the keys. res is nil when nothing was signed
// in this run.
func (p *Publisher) Rotate(ctx context.Context, o devtuf.RotateOptions) (*Result, *devtuf.RotateResult, error) {
	var res *devtuf.RotateResult
	gh, err := p.Publish(ctx, metadata.ROOT, "", func(r *devtuf.Repo) error {
		var err error
		res, err = r.RotateTopLevel(o)
		return err
	})
	if err != nil {
		return gh, res, err
	}
	unlock, err := devtuf.Lock(p.cfg.Dir, time.Minute)
	if err != nil {
		return gh, res, err
	}
	defer unlock()
	r, err := devtuf.Load(p.cfg.Dir, devtuf.Options{})
	if err != nil {
		return gh, res, err
	}
	if done, err := r.FinishRotation(); err != nil {
		return gh, res, err
	} else if done {
		p.cfg.Log("the ceremony's root is pushed: the old online root and targets keys are retired")
	}
	return gh, res, nil
}

// Upload sends files GitHub doesn't have yet: every file is checked against the size limit first (nothing goes up
// when one is too large), then the blob buckets, then the release's own assets.
func (p *Publisher) Upload(ctx context.Context, files []devtuf.ReleaseFile, res *Result) error {
	for _, f := range files {
		st, err := os.Stat(f.Local)
		if err != nil {
			return fmt.Errorf("ghpublish: %s: %w", f.Name, err)
		}
		if st.Size() != f.Length {
			return fmt.Errorf("ghpublish: %s is %d bytes, the metadata says %d", f.Local, st.Size(), f.Length)
		}
		if f.Length > p.cfg.MaxFile {
			return fmt.Errorf("ghpublish: %s (%s, %d bytes) is larger than GitHub takes (%d bytes); it can't be published", f.Name, f.Local, f.Length, p.cfg.MaxFile)
		}
	}
	byTag := map[string][]devtuf.ReleaseFile{}
	var tags []string
	for _, f := range files {
		if _, ok := byTag[f.Tag]; !ok {
			tags = append(tags, f.Tag)
		}
		byTag[f.Tag] = append(byTag[f.Tag], f)
	}
	// Blob buckets first, then the rest (the release's own tag last of all).
	sort.SliceStable(tags, func(i, j int) bool {
		return strings.HasPrefix(tags[i], "nar-") && !strings.HasPrefix(tags[j], "nar-")
	})
	for _, tag := range tags {
		if err := p.uploadTag(ctx, tag, byTag[tag], res); err != nil {
			return err
		}
	}
	return nil
}

type ghRelease struct {
	ID        int64  `json:"id"`
	TagName   string `json:"tag_name"`
	UploadURL string `json:"upload_url"`
}

type ghAsset struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	State string `json:"state"`
	// Digest is "sha256:<hex>" (GitHub reports it for assets uploaded since mid-2025; empty for older ones).
	Digest string `json:"digest"`
}

// whole reports whether an asset is the file: uploaded, of its length, and of its sha256 where GitHub reports one.
func (a ghAsset) whole(f devtuf.ReleaseFile) bool {
	return a.State == "uploaded" && a.Size == f.Length && (a.Digest == "" || f.SHA256 == "" || a.Digest == "sha256:"+f.SHA256)
}

func (p *Publisher) uploadTag(ctx context.Context, tag string, files []devtuf.ReleaseFile, res *Result) error {
	rel, err := p.release(ctx, tag)
	if err != nil {
		return err
	}
	assets, err := p.assets(ctx, rel.ID)
	if err != nil {
		return err
	}
	have := map[string]ghAsset{}
	for _, a := range assets {
		have[a.Name] = a
	}
	var todo []devtuf.ReleaseFile
	for _, f := range files {
		a, ok := have[f.Name]
		switch {
		case ok && a.whole(f):
			res.Present++
		case ok:
			// A broken upload (GitHub keeps a "starter" asset when one is cut off) or other bytes under the name: remove
			// it, send it again.
			p.cfg.Log("removing the broken asset %s/%s (%s, %d bytes, %s)", tag, f.Name, a.State, a.Size, a.Digest)
			if err := p.deleteAsset(ctx, a.ID); err != nil {
				return err
			}
			delete(have, f.Name)
			todo = append(todo, f)
		default:
			todo = append(todo, f)
		}
	}
	if len(have)+len(todo) > MaxAssets {
		return fmt.Errorf("ghpublish: release %s would have %d assets; GitHub takes %d", tag, len(have)+len(todo), MaxAssets)
	}
	if len(todo) > 0 {
		p.cfg.Log("uploading %d file(s) to %s (%d there already)", len(todo), tag, len(have))
	}
	for _, f := range todo {
		if err := p.upload(ctx, rel, f); err != nil {
			return err
		}
		res.Uploaded = append(res.Uploaded, tag+"/"+f.Name)
		res.UploadedBytes += f.Length
	}
	return nil
}

// api calls the REST API with retries on 5xx and 429. body: nil, []byte (JSON) or a file.
func (p *Publisher) api(ctx context.Context, method, u string, body any, contentType string, length int64, out any) (int, error) {
	var last error
	for attempt := 0; attempt < p.cfg.Retries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-time.After(p.cfg.Backoff * time.Duration(attempt)):
			}
		}
		var rd io.Reader
		switch b := body.(type) {
		case []byte:
			rd = bytes.NewReader(b)
		case string:
			f, err := os.Open(b)
			if err != nil {
				return 0, err
			}
			defer f.Close()
			rd = f
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rd)
		if err != nil {
			return 0, err
		}
		if rd != nil {
			req.ContentLength = length
			req.Header.Set("Content-Type", contentType)
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("Authorization", "Bearer "+p.cfg.Token)
		req.Header.Set("User-Agent", "whombat-release-publisher")
		resp, err := p.cfg.HTTP.Do(req)
		if err != nil {
			last = err
			continue
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			last = fmt.Errorf("ghpublish: %s %s: HTTP %d", method, u, resp.StatusCode)
			continue
		}
		if out != nil && resp.StatusCode < 300 && len(data) > 0 {
			if err := json.Unmarshal(data, out); err != nil {
				return resp.StatusCode, fmt.Errorf("ghpublish: %s %s: %w", method, u, err)
			}
		}
		if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
			var m struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(data, &m)
			return resp.StatusCode, fmt.Errorf("ghpublish: %s %s: HTTP %d %s", method, u, resp.StatusCode, m.Message)
		}
		return resp.StatusCode, nil
	}
	return 0, last
}

func (p *Publisher) repoURL(rest string) string {
	return strings.TrimSuffix(p.cfg.APIURL, "/") + "/repos/" + p.cfg.Owner + "/" + p.cfg.Repo + "/" + rest
}

// release returns the release of a tag, creating it (a pre-release, never "latest") when there is none.
func (p *Publisher) release(ctx context.Context, tag string) (*ghRelease, error) {
	found, err := p.findRelease(ctx, tag)
	if err != nil || found != nil {
		return found, err
	}
	var rel ghRelease
	p.cfg.Log("creating the release %s", tag)
	body, _ := json.Marshal(map[string]any{"tag_name": tag, "name": tag, "prerelease": true, "make_latest": "false",
		"body": "Whombat update files (" + tag + "). Boxes read them through the signed metadata at releases.whombat.com."})
	if _, err := p.api(ctx, http.MethodPost, p.repoURL("releases"), body, "application/json", int64(len(body)), &rel); err != nil {
		return nil, err
	}
	if rel.ID == 0 || rel.UploadURL == "" {
		return nil, fmt.Errorf("ghpublish: creating %s gave no release", tag)
	}
	return &rel, nil
}

// findRelease returns the release of a tag, nil when there is none.
func (p *Publisher) findRelease(ctx context.Context, tag string) (*ghRelease, error) {
	var rel ghRelease
	code, err := p.api(ctx, http.MethodGet, p.repoURL("releases/tags/"+url.PathEscape(tag)), nil, "", 0, &rel)
	if err != nil || code != http.StatusOK {
		return nil, err
	}
	return &rel, nil
}

// Verify checks that GitHub has every file whole (Publisher.Upload's files): an uploaded asset of its name, length and,
// where GitHub reports one, sha256. It names the first few that aren't.
func (p *Publisher) Verify(ctx context.Context, files []devtuf.ReleaseFile) error {
	byTag := map[string][]devtuf.ReleaseFile{}
	for _, f := range files {
		byTag[f.Tag] = append(byTag[f.Tag], f)
	}
	var bad []string
	for _, tag := range keysOf(byTag) {
		have := map[string]ghAsset{}
		rel, err := p.findRelease(ctx, tag)
		if err != nil {
			return err
		}
		if rel != nil {
			assets, err := p.assets(ctx, rel.ID)
			if err != nil {
				return err
			}
			for _, a := range assets {
				have[a.Name] = a
			}
		}
		for _, f := range byTag[tag] {
			if a, ok := have[f.Name]; !ok || !a.whole(f) {
				bad = append(bad, tag+"/"+f.Name)
			}
		}
	}
	if len(bad) > 0 {
		if len(bad) > 5 {
			bad = append(bad[:5], fmt.Sprintf("and %d more", len(bad)-5))
		}
		return fmt.Errorf("ghpublish: GitHub doesn't have these files whole: %s", strings.Join(bad, ", "))
	}
	p.cfg.Log("verified %d file(s) on GitHub", len(files))
	return nil
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (p *Publisher) assets(ctx context.Context, id int64) ([]ghAsset, error) {
	var all []ghAsset
	for page := 1; ; page++ {
		var batch []ghAsset
		if _, err := p.api(ctx, http.MethodGet, p.repoURL(fmt.Sprintf("releases/%d/assets?per_page=100&page=%d", id, page)), nil, "", 0, &batch); err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
	}
}

func (p *Publisher) upload(ctx context.Context, rel *ghRelease, f devtuf.ReleaseFile) error {
	base, _, _ := strings.Cut(rel.UploadURL, "{")
	u := base + "?name=" + url.QueryEscape(f.Name)
	var a ghAsset
	if _, err := p.api(ctx, http.MethodPost, u, f.Local, "application/octet-stream", f.Length, &a); err != nil {
		return err
	}
	if a.Name != f.Name || a.Size != f.Length {
		return fmt.Errorf("ghpublish: GitHub stored %s (%d bytes) for %s (%d bytes)", a.Name, a.Size, f.Name, f.Length)
	}
	return nil
}

func (p *Publisher) deleteAsset(ctx context.Context, id int64) error {
	_, err := p.api(ctx, http.MethodDelete, p.repoURL(fmt.Sprintf("releases/assets/%d", id)), nil, "", 0, nil)
	return err
}

// git runs git in the repository directory. The token, when the remote is https, goes in an environment variable
// that git reads as an extra header: never on a command line.
func (p *Publisher) git(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, p.cfg.Git, args...)
	cmd.Dir = p.cfg.Dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if remote, err := exec.CommandContext(ctx, p.cfg.Git, "-C", p.cfg.Dir, "remote", "get-url", p.cfg.Remote).Output(); err == nil &&
		strings.HasPrefix(strings.TrimSpace(string(remote)), "https://") {
		auth := "Authorization: Basic " + basicAuth("x-access-token", p.cfg.Token)
		cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.extraHeader", "GIT_CONFIG_VALUE_0="+auth)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ghpublish: git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// pull brings the clone up to date with the remote (the workflow's commits).
func (p *Publisher) pull(ctx context.Context) error {
	if _, err := os.Stat(filepath.Join(p.cfg.Dir, ".git")); err != nil {
		return fmt.Errorf("ghpublish: %s is not a clone of the releases repository", p.cfg.Dir)
	}
	if _, err := p.git(ctx, "pull", "--rebase", "--autostash", "-q", p.cfg.Remote, p.cfg.Branch); err != nil {
		return err
	}
	return nil
}

// commitPush commits exactly the given metadata files, when each still has the content signed for it (path → sha256),
// and pushes every commit the remote lacks: also one an earlier run committed and couldn't push. When the workflow
// pushed in between, it rebases and tries again. It returns the pushed head ("" when there was nothing to push) only
// once the remote's branch has it.
func (p *Publisher) commitPush(ctx context.Context, msg string, files map[string]string) (string, error) {
	unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
	if err != nil {
		return "", err
	}
	defer unlockRepo()
	if len(files) > 0 {
		now, err := p.unpushedHashes(ctx)
		if err != nil {
			return "", err
		}
		var commit []string
		for _, f := range keys(files) {
			h, dirty := now[f]
			switch {
			case !dirty:
				continue // committed already (an earlier run)
			case h != files[f]:
				return "", fmt.Errorf("ghpublish: %s changed after it was signed for this publish; nothing is pushed", f)
			}
			commit = append(commit, f)
		}
		if len(commit) > 0 {
			if _, err := p.git(ctx, append([]string{"add", "--"}, commit...)...); err != nil {
				return "", err
			}
			if _, err := p.git(ctx, append([]string{"-c", "user.name=" + CommitName, "-c", "user.email=" + CommitEmail,
				"commit", "-q", "-m", "publish " + msg, "--"}, commit...)...); err != nil {
				return "", err
			}
		}
	}
	ahead, err := p.ahead(ctx)
	if err != nil {
		return "", err
	}
	if !ahead {
		p.cfg.Log("metadata: nothing to push")
		return "", nil
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err = p.git(ctx, "push", "-q", p.cfg.Remote, "HEAD:"+p.cfg.Branch); err == nil {
			break
		}
		p.cfg.Log("push refused, rebasing on the remote: %v", err)
		if _, perr := p.git(ctx, "pull", "--rebase", "--autostash", "-q", p.cfg.Remote, p.cfg.Branch); perr != nil {
			return "", perr
		}
	}
	if err != nil {
		return "", err
	}
	if ahead, err := p.ahead(ctx); err != nil || ahead {
		if err == nil {
			err = errors.New("ghpublish: the remote's branch doesn't have the pushed metadata")
		}
		return "", err
	}
	head, err := p.git(ctx, "rev-parse", "HEAD")
	p.cfg.Log("metadata pushed: %s", head)
	return head, err
}

func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

// PublishRelease publishes a release directory (release/build's) into a channel (development; production is reached
// by promotion): verified and signed into the channel's role like tufrepo publish-release, then uploaded and pushed.
func (p *Publisher) PublishRelease(ctx context.Context, channel, releaseDir string, allowDowngradeFrom []string) (*Result, *devtuf.PublishResult, error) {
	m, err := devtuf.ReadReleaseManifest(releaseDir)
	if err != nil {
		return nil, nil, err
	}
	var pr *devtuf.PublishResult
	res, err := p.Publish(ctx, channel, m.ReleaseID, func(r *devtuf.Repo) error {
		if err := r.InChannel(channel); err != nil {
			return err
		}
		pr, err = r.PublishRelease(releaseDir, devtuf.PublishOptions{AllowDowngradeFrom: allowDowngradeFrom})
		return err
	})
	return res, pr, err
}

// Promote lists a release of development in production (the offline production key signs), checks that its files
// are on GitHub (they are the development release's: the same names) and pushes the metadata.
func (p *Publisher) Promote(ctx context.Context, id string, productionKey ed25519.PrivateKey) (*Result, error) {
	return p.Publish(ctx, trust.ChannelProduction, id, func(r *devtuf.Repo) error {
		_, err := r.Promote(id, trust.ChannelDevelopment, trust.ChannelProduction, productionKey)
		return err
	})
}

// PauseChannel signs the pause marker into channel's role metadata and pushes it (nothing is uploaded).
func (p *Publisher) PauseChannel(ctx context.Context, channel string, key ed25519.PrivateKey) (*Result, *devtuf.ChannelPauseResult, error) {
	if !trust.ValidChannel(channel) {
		return nil, nil, fmt.Errorf("ghpublish: unknown channel %q", channel)
	}
	var pr *devtuf.ChannelPauseResult
	res, err := p.publish(ctx, channel, "", "pause", channel+": pause", func(r *devtuf.Repo) error {
		var err error
		pr, err = r.PauseChannel(channel, key)
		return err
	})
	return res, pr, err
}

// ResumeChannel clears the pause marker from channel's role metadata and pushes it (nothing is uploaded).
func (p *Publisher) ResumeChannel(ctx context.Context, channel string, key ed25519.PrivateKey) (*Result, *devtuf.ChannelPauseResult, error) {
	if !trust.ValidChannel(channel) {
		return nil, nil, fmt.Errorf("ghpublish: unknown channel %q", channel)
	}
	var pr *devtuf.ChannelPauseResult
	res, err := p.publish(ctx, channel, "", "resume", channel+": resume", func(r *devtuf.Repo) error {
		var err error
		pr, err = r.ResumeChannel(channel, key)
		return err
	})
	return res, pr, err
}

// UploadClients sends the clients role's targets (the AI client channel and bundles) to the `clients` release, then
// pushes the clients role the channel publisher signed in the clone: its files first, its metadata after, as a release's.
func (p *Publisher) UploadClients(ctx context.Context) (*Result, error) {
	unlock, err := p.lock(10 * time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if err := p.pull(ctx); err != nil {
		return nil, err
	}
	pend, err := p.readPending()
	if err != nil {
		return nil, err
	}
	if pend != nil {
		gone, err := p.abandoned(ctx, pend)
		if err != nil {
			return nil, err
		}
		if !gone {
			return nil, fmt.Errorf("ghpublish: the publish of %s didn't finish: run it again first", pend.what())
		}
	}
	// The role and its file list are read under the devtuf lock; the channel publisher may sign a newer role during
	// the upload, which stays for the next gh-clients: only the files read here are committed.
	var dirty map[string]string
	var files []devtuf.ReleaseFile
	if err := func() error {
		unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
		if err != nil {
			return err
		}
		defer unlockRepo()
		if dirty, err = p.unpushedHashes(ctx); err != nil {
			return err
		}
		for _, f := range keys(dirty) {
			// The clients role, and the snapshot and timestamp over it where the clone holds their keys (tests, a local repository).
			base := filepath.Base(f)
			if !strings.HasSuffix(base, "."+trust.ClientsRole+".json") && !strings.HasSuffix(base, "snapshot.json") && base != "timestamp.json" {
				return fmt.Errorf("ghpublish: the metadata folder has signed changes that aren't the clients role's (%s)", strings.Join(keys(dirty), ", "))
			}
		}
		r, err := devtuf.Load(p.cfg.Dir, devtuf.Options{})
		if err != nil {
			return err
		}
		files = r.ClientFiles()
		return nil
	}(); err != nil {
		return nil, err
	}
	res := &Result{Uploaded: []string{}}
	if err := p.Upload(ctx, files, res); err != nil {
		return res, err
	}
	if err := p.Verify(ctx, files); err != nil {
		return res, err
	}
	commit, err := p.commitPush(ctx, "clients", dirty)
	if err != nil {
		return res, err
	}
	res.MetadataPushed, res.Commit = commit != "", commit
	return res, nil
}

// GitIgnore keeps the publisher's local state out of the releases repository: the files (they go up as release
// assets), the devtuf state and locks. Keys live outside the clone (devtuf's keysDir).
const GitIgnore = "/targets/\n/keys/\n/state.json\n/.lock\n/.publish.lock\n/.publish-pending.json\n/.publish-pending.json.*\n/.rotation-pending.json\n/continue.json\n"

// BootstrapFiles lists every file the repository's metadata names on GitHub: each release every channel lists (the
// carried ones after gh-continue) and the clients role's targets.
func (p *Publisher) BootstrapFiles() ([]devtuf.ReleaseFile, error) {
	unlockRepo, err := devtuf.Lock(p.cfg.Dir, time.Minute)
	if err != nil {
		return nil, err
	}
	defer unlockRepo()
	r, err := devtuf.Load(p.cfg.Dir, devtuf.Options{})
	if err != nil {
		return nil, err
	}
	if !r.GitHub() {
		return nil, errors.New("ghpublish: the repository is not of the GitHub layout")
	}
	var out []devtuf.ReleaseFile
	seen := map[string]bool{}
	add := func(files []devtuf.ReleaseFile) {
		for _, f := range files {
			if k := f.Tag + "/" + f.Name; !seen[k] {
				seen[k] = true
				out = append(out, f)
			}
		}
	}
	for _, channel := range []string{trust.ChannelDevelopment, trust.ChannelProduction} {
		if !r.HasChannel(channel) {
			continue
		}
		releases, err := r.ChannelReleases(channel)
		if err != nil {
			return nil, err
		}
		for _, rel := range releases {
			files, err := r.ReleaseFiles(channel, rel.ID)
			if err != nil {
				return nil, fmt.Errorf("ghpublish: %s in %s: %w", rel.ID, channel, err)
			}
			add(files)
		}
	}
	add(r.ClientFiles())
	return out, nil
}

// InitClone turns a GitHub-layout repository (tufrepo gh-continue's output) into the clone the publisher works in:
// every file its metadata names uploaded and verified on GitHub first (the carried releases, the clients role's
// targets), then git init, the remote, a .gitignore, the metadata committed and pushed to the branch. Once, before the
// first publish; the workflow files are added to the same branch by hand (release/github/whombat-releases). A failed
// upload stops it before git: run it again.
func (p *Publisher) InitClone(ctx context.Context, remoteURL string) (string, error) {
	if _, err := os.Stat(filepath.Join(p.cfg.Dir, ".git")); err == nil {
		return "", fmt.Errorf("ghpublish: %s is a git repository already", p.cfg.Dir)
	}
	files, err := p.BootstrapFiles()
	if err != nil {
		return "", err
	}
	res := &Result{Uploaded: []string{}}
	if err := p.Upload(ctx, files, res); err != nil {
		return "", err
	}
	if err := p.Verify(ctx, files); err != nil {
		return "", err
	}
	p.cfg.Log("the metadata's %d file(s) are on GitHub (%d uploaded, %d there already)", len(files), len(res.Uploaded), res.Present)
	if err := os.WriteFile(filepath.Join(p.cfg.Dir, ".gitignore"), []byte(GitIgnore), 0o644); err != nil {
		return "", err
	}
	for _, args := range [][]string{{"init", "-q", "-b", p.cfg.Branch}, {"remote", "add", p.cfg.Remote, remoteURL}} {
		if _, err := p.git(ctx, args...); err != nil {
			return "", err
		}
	}
	// A repository with commits already (its README, the workflow): build on them, keeping this tree's files.
	if _, err := p.git(ctx, "fetch", "-q", p.cfg.Remote, p.cfg.Branch); err == nil {
		if _, err := p.git(ctx, "reset", "-q", "FETCH_HEAD"); err != nil {
			return "", err
		}
	}
	if _, err := p.git(ctx, "add", "--", ".gitignore", "metadata"); err != nil {
		return "", err
	}
	if _, err := p.git(ctx, "-c", "user.name="+CommitName, "-c", "user.email="+CommitEmail,
		"commit", "-q", "-m", "metadata: the repository continued from DEV's"); err != nil {
		return "", err
	}
	if _, err := p.git(ctx, "push", "-q", "-u", p.cfg.Remote, "HEAD:"+p.cfg.Branch); err != nil {
		return "", err
	}
	return p.git(ctx, "rev-parse", "HEAD")
}
