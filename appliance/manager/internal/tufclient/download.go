package tufclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/safeopen"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"golang.org/x/sys/unix"
)

// ErrNoSpace means staging cannot hold the candidate even after garbage collection.
var ErrNoSpace = errors.New("insufficient space for staging")

// Source provides artifact bytes starting at an offset.
type Source interface {
	// Open returns the content from offset; partial=true when the source honoured the offset.
	Open(ctx context.Context, relPath string, offset int64) (rc io.ReadCloser, partial bool, err error)
}

// LayoutGitHub is the targets layout of the GitHub repository (LNK-24): files are release assets, one directory
// deep (<release>/<asset>), so a deeper path keeps its first directory and its file name (GitHubPath).
const LayoutGitHub = "github"

// GitHubPath maps a target's remote path onto a GitHub release asset: <first directory>/<file name>. A channel
// release's index (<release-id>/<sha>.<base>) and a version-2 blob (nar-xx/<file>) are already that; a client
// bundle (clients/<provider>/<version>/<sha>.<os-arch>.tar.gz) becomes clients/<sha>.<os-arch>.tar.gz, the name the
// publisher gives it.
func GitHubPath(rel string) string {
	dir, _, deeper := strings.Cut(rel, "/")
	if !deeper {
		return rel
	}
	return dir + "/" + path.Base(rel)
}

// HTTPSource downloads from a targets base URL with Range resume. It follows redirects (GitHub answers a release
// download with a redirect to its storage, which honours Range too) and never calls an API.
type HTTPSource struct {
	BaseURL string
	Client  *http.Client
	// Layout is "" (the consistent-snapshot paths under the base) or LayoutGitHub.
	Layout string
}

// Open implements Source.
func (h HTTPSource) Open(ctx context.Context, rel string, offset int64) (io.ReadCloser, bool, error) {
	if h.Layout == LayoutGitHub {
		rel = GitHubPath(rel)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(h.BaseURL, "/")+"/"+rel, nil)
	if err != nil {
		return nil, false, err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	c := h.Client
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, false, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return resp.Body, false, nil
	case http.StatusPartialContent:
		// Append only what starts where the partial file ends; any other range starts over.
		if start, ok := contentRangeStart(resp.Header.Get("Content-Range")); !ok || start != offset {
			resp.Body.Close()
			return nil, false, fmt.Errorf("download %s: the server sent the range %q for offset %d", rel, resp.Header.Get("Content-Range"), offset)
		}
		return resp.Body, true, nil
	case http.StatusRequestedRangeNotSatisfiable:
		// The partial file is as long as the file, or the source changed: the caller starts over.
		resp.Body.Close()
		return nil, false, fmt.Errorf("download %s: %w", rel, ErrRangeNotSatisfiable)
	default:
		resp.Body.Close()
		return nil, false, fmt.Errorf("download %s: HTTP %d", rel, resp.StatusCode)
	}
}

// ErrRangeNotSatisfiable: the server refused the resume offset (HTTP 416).
var ErrRangeNotSatisfiable = errors.New("range not satisfiable")

// contentRangeStart reads the first byte position of "bytes <start>-<end>/<size>".
func contentRangeStart(v string) (int64, bool) {
	rest, ok := strings.CutPrefix(v, "bytes ")
	if !ok {
		return 0, false
	}
	first, _, ok := strings.Cut(rest, "-")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(first, 10, 64)
	return n, err == nil && n >= 0
}

// DirSource serves artifacts from a local directory (tests, development).
type DirSource struct{ Dir string }

// Open implements Source.
func (d DirSource) Open(_ context.Context, rel string, offset int64) (io.ReadCloser, bool, error) {
	if path.Clean(rel) != rel || strings.HasPrefix(rel, "../") {
		return nil, false, errors.New("bad path")
	}
	f, err := os.Open(filepath.Join(d.Dir, filepath.FromSlash(rel)))
	if err != nil {
		return nil, false, err
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, false, err
		}
	}
	return f, offset > 0, nil
}

// Space reports free bytes for a directory's filesystem.
type Space interface {
	Free(dir string) (int64, error)
}

// StatfsSpace uses statfs(2).
type StatfsSpace struct{}

// Free implements Space.
func (StatfsSpace) Free(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// Downloader stages artifacts as <StagingDir>/<sha256>.
type Downloader struct {
	StagingDir string
	Source     Source
	Space      Space
	// ReserveBytes is kept free for the running installation, logs and the database.
	ReserveBytes int64
}

// RemotePath is where an artifact lives under the targets base: its signed Remote when it has one (a channel
// release's index, a version-2 blob; LNK-24), else the consistent-snapshot target file name <dir>/<sha256>.<base>.
func RemotePath(a trust.Artifact) string {
	if a.Remote != "" {
		return a.Remote
	}
	dir, base := path.Split(a.Target)
	return path.Join(dir, a.SHA256()+"."+base)
}

func (d *Downloader) final(a trust.Artifact) string { return filepath.Join(d.StagingDir, a.SHA256()) }

// Present reports whether a verified copy is staged.
func (d *Downloader) Present(a trust.Artifact) bool {
	return trust.VerifyFile(d.final(a), a) == nil
}

// Required returns bytes needed to stage and import the artifacts that are not staged yet:
// the download itself, the helper's private verified copy, and the unpacked closure.
func (d *Downloader) Required(arts []trust.Artifact) int64 {
	var need, maxLen int64
	for _, a := range arts {
		if d.Present(a) {
			continue
		}
		need += a.Length + a.Meta.ClosureSize
		if a.Length > maxLen {
			maxLen = a.Length
		}
	}
	if need == 0 {
		return 0
	}
	return need + maxLen + d.ReserveBytes
}

// EnsureSpace garbage-collects staged files not in keep (sha256 set) until the candidate fits.
// It never removes files in keep (current, known-good and candidate artifacts).
func (d *Downloader) EnsureSpace(arts []trust.Artifact, keep map[string]bool) error {
	if err := os.MkdirAll(d.StagingDir, 0o755); err != nil {
		return err
	}
	need := d.Required(arts)
	if need == 0 {
		return nil
	}
	for _, a := range arts {
		keep[a.SHA256()] = true
	}
	free, err := d.Space.Free(d.StagingDir)
	if err != nil {
		return err
	}
	if free >= need {
		return nil
	}
	entries, _ := os.ReadDir(d.StagingDir)
	for _, e := range entries {
		name := strings.TrimSuffix(e.Name(), ".part")
		if keep[name] {
			continue
		}
		info, err := e.Info()
		if err == nil && os.Remove(filepath.Join(d.StagingDir, e.Name())) == nil {
			free += info.Size()
		}
		if free >= need {
			return nil
		}
	}
	if free, err = d.Space.Free(d.StagingDir); err == nil && free >= need {
		return nil
	}
	return fmt.Errorf("%w: need %d bytes, %d free", ErrNoSpace, need, free)
}

// Prune removes every staged file (and partial download) not in keep (sha256 set), once an update has finished:
// the blobs of a closure index are imported by then and nothing reads them again (MG-60). It reports what it freed.
func (d *Downloader) Prune(keep map[string]bool) (files int, bytes int64) {
	entries, err := os.ReadDir(d.StagingDir)
	if err != nil {
		return 0, 0
	}
	for _, e := range entries {
		if keep[strings.TrimSuffix(e.Name(), ".part")] || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err == nil && os.Remove(filepath.Join(d.StagingDir, e.Name())) == nil {
			files++
			bytes += info.Size()
		}
	}
	return files, bytes
}

// Download fetches one artifact (resuming a partial download), verifies length and hashes against
// the TUF target, and moves it into place. Nothing is executed from staging before this succeeds.
func (d *Downloader) Download(ctx context.Context, a trust.Artifact) error {
	if d.Present(a) {
		return nil
	}
	if err := os.MkdirAll(d.StagingDir, 0o755); err != nil {
		return err
	}
	part := d.final(a) + ".part"
	var offset int64
	if st, err := os.Stat(part); err == nil {
		offset = st.Size()
		if offset >= a.Length {
			_ = os.Remove(part)
			offset = 0
		}
	}
	rc, partial, err := d.Source.Open(ctx, RemotePath(a), offset)
	if errors.Is(err, ErrRangeNotSatisfiable) && offset > 0 {
		_ = os.Remove(part)
		offset = 0
		rc, partial, err = d.Source.Open(ctx, RemotePath(a), 0)
	}
	if err != nil {
		return err
	}
	defer rc.Close()
	flags := os.O_WRONLY | os.O_CREATE
	if partial && offset > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
		offset = 0
	}
	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return err
	}
	// Never write past the TUF length (endless-data attack).
	_, cerr := io.Copy(f, io.LimitReader(rc, a.Length-offset+1))
	serr := f.Sync()
	f.Close()
	if cerr != nil {
		if errors.Is(cerr, syscall.ENOSPC) {
			return fmt.Errorf("%w: %v", ErrNoSpace, cerr)
		}
		return cerr
	}
	if serr != nil {
		return serr
	}
	if err := trust.VerifyFile(part, a); err != nil {
		_ = os.Remove(part)
		return err
	}
	if err := os.Rename(part, d.final(a)); err != nil {
		return err
	}
	return nil
}

// StatfsTotal returns the size of a directory's filesystem.
func StatfsTotal(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Blocks) * int64(st.Bsize), nil
}

// ReadStaged returns a staged file, read up to the artifact's length + 1 (closure indexes, at most
// trust.MaxIndexBytes; the caller verifies the bytes, trust.ParseClosureIndex).
func (d *Downloader) ReadStaged(a trust.Artifact) ([]byte, error) {
	if a.Length > trust.MaxIndexBytes {
		return nil, fmt.Errorf("%s: %d bytes is too large to read", a.Target, a.Length)
	}
	f, err := safeopen.OpenRegular(d.final(a))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, a.Length+1))
	if err != nil {
		return nil, err
	}
	return b, nil
}
