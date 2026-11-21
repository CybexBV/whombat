package devtuf

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
	"github.com/klauspost/compress/zstd"
)

// Store paths for closure indexes (UP-X14): what `nix path-info --json --recursive` says about a closure, and the NAR
// of a path (`nix-store --dump`), compressed once per NAR hash into a cache shared by all releases of the machine.

// PathInfo is one store path's facts.
type PathInfo struct {
	StorePath  string
	NarHash    string // sha256:<hex>
	NarSize    int64
	References []string
	Deriver    string
}

// PathSource reads a store.
type PathSource interface {
	// Closure returns every path of root's closure (root included), in any order.
	Closure(ctx context.Context, root string) ([]PathInfo, error)
	// Dump writes the NAR of a store path.
	Dump(ctx context.Context, storePath string, w io.Writer) error
}

// NixPaths is the store of this machine: `nix path-info --json --recursive` and `nix-store --dump`.
type NixPaths struct {
	Nix      string // default "nix"
	NixStore string // default "nix-store"
}

// Closure implements PathSource.
func (n NixPaths) Closure(ctx context.Context, root string) ([]PathInfo, error) {
	nix := n.Nix
	if nix == "" {
		nix = "nix"
	}
	cmd := exec.CommandContext(ctx, nix, "--extra-experimental-features", "nix-command", "path-info", "--json", "--recursive", root)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("nix path-info --json --recursive %s: %w: %s", root, err, strings.TrimSpace(stderr.String()))
	}
	return ParsePathInfoJSON(out)
}

// Dump implements PathSource.
func (n NixPaths) Dump(ctx context.Context, storePath string, w io.Writer) error {
	ns := n.NixStore
	if ns == "" {
		ns = "nix-store"
	}
	cmd := exec.CommandContext(ctx, ns, "--dump", storePath)
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nix-store --dump %s: %w: %s", storePath, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

type pathInfoJSON struct {
	Path       string   `json:"path"`
	NarHash    string   `json:"narHash"`
	NarSize    int64    `json:"narSize"`
	References []string `json:"references"`
	Deriver    *string  `json:"deriver"`
	Valid      *bool    `json:"valid"`
}

// ParsePathInfoJSON reads `nix path-info --json` output: an object keyed by store path (Nix ≥ 2.19) or an array of
// objects with "path" (older), narHash in any of Nix's encodings.
func ParsePathInfoJSON(b []byte) ([]PathInfo, error) {
	var items []pathInfoJSON
	trimmed := bytes.TrimSpace(b)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var m map[string]*pathInfoJSON
		if err := json.Unmarshal(trimmed, &m); err != nil {
			return nil, fmt.Errorf("nix path-info: %w", err)
		}
		for p, it := range m {
			if it == nil {
				return nil, fmt.Errorf("nix path-info: %s is not valid", p)
			}
			it.Path = p
			items = append(items, *it)
		}
	} else if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, fmt.Errorf("nix path-info: %w", err)
	}
	out := make([]PathInfo, 0, len(items))
	for _, it := range items {
		if it.Valid != nil && !*it.Valid {
			return nil, fmt.Errorf("nix path-info: %s is not valid", it.Path)
		}
		h, err := NarHashHex(it.NarHash)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", it.Path, err)
		}
		p := PathInfo{StorePath: it.Path, NarHash: h, NarSize: it.NarSize, References: it.References}
		if p.References == nil {
			p.References = []string{}
		}
		if it.Deriver != nil {
			p.Deriver = *it.Deriver
		}
		if !trust.ValidStorePath(p.StorePath) || p.NarSize <= 0 {
			return nil, fmt.Errorf("nix path-info: bad entry %q", it.Path)
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StorePath < out[j].StorePath })
	return out, nil
}

const nix32Chars = "0123456789abcdfghijklmnpqrsvwxyz"

// NarHashHex converts a SHA-256 NAR hash in any of Nix's encodings (sha256:<nix32>, sha256:<hex>, sha256-<base64>
// SRI) to sha256:<hex>.
func NarHashHex(h string) (string, error) {
	var raw []byte
	switch {
	case strings.HasPrefix(h, "sha256-"):
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(h, "sha256-"))
		if err != nil {
			return "", fmt.Errorf("narHash %q: %w", h, err)
		}
		raw = b
	case strings.HasPrefix(h, "sha256:"):
		rest := strings.TrimPrefix(h, "sha256:")
		switch len(rest) {
		case 64:
			b, err := hex.DecodeString(rest)
			if err != nil {
				return "", fmt.Errorf("narHash %q: %w", h, err)
			}
			raw = b
		case 52:
			b, err := nix32Decode(rest, 32)
			if err != nil {
				return "", fmt.Errorf("narHash %q: %w", h, err)
			}
			raw = b
		}
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("narHash %q is not a SHA-256 hash Nix prints", h)
	}
	return "sha256:" + hex.EncodeToString(raw), nil
}

// nix32Decode decodes Nix's base-32 (least significant digit last).
func nix32Decode(s string, size int) ([]byte, error) {
	out := make([]byte, size)
	for n := 0; n < len(s); n++ {
		c := s[len(s)-n-1]
		d := strings.IndexByte(nix32Chars, c)
		if d < 0 {
			return nil, fmt.Errorf("bad nix32 digit %q", c)
		}
		b := n * 5
		i, j := b/8, uint(b%8)
		out[i] |= byte(d << j)
		if i < size-1 {
			out[i+1] |= byte(d >> (8 - j))
		} else if d>>(8-j) != 0 {
			return nil, errors.New("nix32 overflow")
		}
	}
	return out, nil
}

// StreamPaths is a PathSource over export streams (tests and fixtures without Nix): the union of the streams' paths.
type StreamPaths struct {
	paths map[string]PathInfo
	nars  map[string][]byte
}

// NewStreamPaths parses export streams.
func NewStreamPaths(streams ...[]byte) (*StreamPaths, error) {
	sp := &StreamPaths{paths: map[string]PathInfo{}, nars: map[string][]byte{}}
	for _, b := range streams {
		s, nars, err := nixexport.ReadNARs(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		for _, p := range s.Paths {
			sp.paths[p.StorePath] = PathInfo{StorePath: p.StorePath, NarHash: p.NarHash, NarSize: p.NarSize,
				References: append([]string{}, p.References...), Deriver: p.Deriver}
			sp.nars[p.StorePath] = nars[p.StorePath]
		}
	}
	return sp, nil
}

// SetNAR replaces a path's NAR without changing its facts (tests: a store that dumps something else).
func (s *StreamPaths) SetNAR(storePath string, nar []byte) { s.nars[storePath] = nar }

// Closure implements PathSource.
func (s *StreamPaths) Closure(_ context.Context, root string) ([]PathInfo, error) {
	seen := map[string]bool{}
	var out []PathInfo
	stack := []string{root}
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[p] {
			continue
		}
		info, ok := s.paths[p]
		if !ok {
			return nil, fmt.Errorf("%s is not in the store", p)
		}
		seen[p] = true
		out = append(out, info)
		stack = append(stack, info.References...)
	}
	return out, nil
}

// Dump implements PathSource.
func (s *StreamPaths) Dump(_ context.Context, storePath string, w io.Writer) error {
	b, ok := s.nars[storePath]
	if !ok {
		return fmt.Errorf("%s is not in the store", storePath)
	}
	_, err := w.Write(b)
	return err
}

// DefaultNarCache is $XDG_CACHE_HOME/whombat-releases/nar (~/.cache/whombat-releases/nar).
func DefaultNarCache() string {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".cache")
	}
	return filepath.Join(base, "whombat-releases", "nar")
}

// NarCacheFile is a cached blob's path: <cache>/<narhex>.nar.zst.
func NarCacheFile(cache, narHash string) string {
	return filepath.Join(cache, strings.TrimPrefix(narHash, "sha256:")+".nar.zst")
}

// CacheStats reports what FillNarCache did.
type CacheStats struct {
	Paths      int   `json:"paths"`
	Cached     int   `json:"cached"`
	Compressed int   `json:"compressed"`
	NarBytes   int64 `json:"narBytes"`  // NAR bytes compressed now
	FileBytes  int64 `json:"fileBytes"` // their compressed size
}

// FillNarCache compresses the NAR of every path not in the cache yet (one blob per NAR hash), with workers
// encoders in parallel: each dump is hashed while it is compressed and refused when its NAR hash or size differ from
// the path's facts; a blob is written to a temporary file and renamed.
func FillNarCache(ctx context.Context, cache string, paths []PathInfo, src PathSource, workers int) (CacheStats, error) {
	st := CacheStats{}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return st, err
	}
	seen := map[string]bool{}
	var todo []PathInfo
	for _, p := range paths {
		if seen[p.NarHash] {
			continue
		}
		seen[p.NarHash] = true
		st.Paths++
		if fi, err := os.Stat(NarCacheFile(cache, p.NarHash)); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
			st.Cached++
			continue
		}
		todo = append(todo, p)
	}
	// Large NARs first: the longest jobs start early.
	sort.SliceStable(todo, func(i, j int) bool { return todo[i].NarSize > todo[j].NarSize })
	if workers <= 0 {
		workers = min(runtime.NumCPU(), 8)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan PathInfo)
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	for w := 0; w < min(workers, max(len(todo), 1)); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBestCompression), zstd.WithEncoderConcurrency(1))
			if err != nil {
				mu.Lock()
				firstErr = cmp(firstErr, err)
				mu.Unlock()
				cancel()
				return
			}
			defer enc.Close()
			for p := range jobs {
				size, err := compressOne(ctx, cache, p, src, enc)
				mu.Lock()
				if err != nil {
					firstErr = cmp(firstErr, err)
					cancel()
				} else {
					st.Compressed++
					st.NarBytes += p.NarSize
					st.FileBytes += size
				}
				mu.Unlock()
			}
		}()
	}
	for _, p := range todo {
		select {
		case jobs <- p:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	wg.Wait()
	if firstErr == nil && ctx.Err() != nil {
		firstErr = ctx.Err()
	}
	return st, firstErr
}

func cmp(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

func compressOne(ctx context.Context, cache string, p PathInfo, src PathSource, enc *zstd.Encoder) (int64, error) {
	tmp, err := os.CreateTemp(cache, ".tmp-*.nar.zst")
	if err != nil {
		return 0, err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(src.Dump(ctx, p.StorePath, pw)) }()
	h := sha256.New()
	cnt := &countWriter{}
	fileCnt := &countWriter{}
	enc.Reset(io.MultiWriter(tmp, fileCnt))
	_, err = io.Copy(enc, io.TeeReader(pr, io.MultiWriter(h, cnt)))
	pr.CloseWithError(errors.New("compression ended"))
	if err != nil {
		return 0, fmt.Errorf("dump %s: %w", p.StorePath, err)
	}
	if err := enc.Close(); err != nil {
		return 0, err
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != p.NarHash || cnt.n != p.NarSize {
		return 0, fmt.Errorf("%s: the dump is %s (%d bytes), the store says %s (%d bytes)", p.StorePath, got, cnt.n, p.NarHash, p.NarSize)
	}
	if err := tmp.Sync(); err != nil {
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp.Name(), NarCacheFile(cache, p.NarHash)); err != nil {
		return 0, err
	}
	ok = true
	return fileCnt.n, nil
}

// linkOrCopy hard-links src to dst, copying when they are on different filesystems (or links are refused).
func linkOrCopy(src, dst string) error {
	if err := os.Link(src, dst); err == nil {
		return nil
	} else if !errors.Is(err, syscall.EXDEV) && !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.EMLINK) {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}
