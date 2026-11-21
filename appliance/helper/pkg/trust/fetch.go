package trust

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/safeopen"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// DirFetcher serves TUF metadata from a local directory. URLs must start with BaseURL; the
// remainder must be a single clean file name (metadata) or a clean relative path (targets).
// Missing files report HTTP 404 so go-tuf's root-rotation loop terminates normally.
type DirFetcher struct {
	BaseURL string
	Dir     string
}

// DownloadFile implements fetcher.Fetcher.
func (f DirFetcher) DownloadFile(urlPath string, maxLength int64, _ time.Duration) ([]byte, error) {
	base := strings.TrimSuffix(f.BaseURL, "/") + "/"
	rel, ok := strings.CutPrefix(urlPath, base)
	if !ok || rel == "" || strings.Contains(rel, "\\") || path.Clean(rel) != rel || strings.HasPrefix(rel, "../") || strings.HasPrefix(rel, "/") {
		return nil, &metadata.ErrDownloadHTTP{StatusCode: http.StatusBadRequest, URL: urlPath}
	}
	file, err := openNoFollow(filepath.Join(f.Dir, filepath.FromSlash(rel)))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, &metadata.ErrDownloadHTTP{StatusCode: http.StatusNotFound, URL: urlPath}
		}
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxLength+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxLength {
		return nil, &metadata.ErrDownloadLengthMismatch{Msg: fmt.Sprintf("%s longer than %d", urlPath, maxLength)}
	}
	return data, nil
}

// openNoFollow opens a file in a directory the manager controls (mirror, staging): no symlink in any
// component, never blocking on a FIFO, regular files only (safeopen, L-6).
func openNoFollow(p string) (*os.File, error) { return safeopen.OpenRegular(p) }

type verifier struct {
	hs   map[string]hash.Hash
	n    int64
	want Artifact
}

func newVerifier(a Artifact) *verifier {
	v := &verifier{hs: map[string]hash.Hash{}, want: a}
	for alg := range a.Hashes {
		switch alg {
		case "sha256":
			v.hs[alg] = sha256.New()
		case "sha512":
			v.hs[alg] = sha512.New()
		}
	}
	return v
}

func (v *verifier) Write(p []byte) (int, error) {
	v.n += int64(len(p))
	if v.n > v.want.Length {
		return 0, fmt.Errorf("%w: %s longer than %d bytes", ErrArtifact, v.want.Target, v.want.Length)
	}
	for _, h := range v.hs {
		h.Write(p)
	}
	return len(p), nil
}

func (v *verifier) check() error {
	if v.n != v.want.Length {
		return fmt.Errorf("%w: %s is %d bytes, want %d", ErrArtifact, v.want.Target, v.n, v.want.Length)
	}
	if len(v.hs) == 0 || len(v.hs) != len(v.want.Hashes) {
		return fmt.Errorf("%w: %s: unsupported hash set", ErrArtifact, v.want.Target)
	}
	for alg, h := range v.hs {
		if hex.EncodeToString(h.Sum(nil)) != v.want.Hashes[alg] {
			return fmt.Errorf("%w: %s %s mismatch", ErrArtifact, v.want.Target, alg)
		}
	}
	return nil
}

// VerifyFile streams a local file and checks it against the artifact's TUF length and hashes.
func VerifyFile(p string, a Artifact) error {
	f, err := openNoFollow(p)
	if err != nil {
		return err
	}
	defer f.Close()
	v := newVerifier(a)
	if _, err := io.Copy(v, f); err != nil {
		return err
	}
	return v.check()
}

// CopyVerified copies src to dst (created exclusively, 0600) while hashing and succeeds only if the
// copy matches the artifact's TUF length and hashes. The helper uses it so that the file it imports
// is one the manager can no longer modify (no TOCTOU between verification and use).
func CopyVerified(src, dst string, a Artifact) (err error) {
	in, err := openNoFollow(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		out.Close()
		if err != nil {
			_ = os.Remove(dst)
		}
	}()
	v := newVerifier(a)
	if _, err = io.Copy(io.MultiWriter(out, v), io.LimitReader(in, a.Length+1)); err != nil {
		return err
	}
	if err = v.check(); err != nil {
		return err
	}
	return out.Sync()
}
