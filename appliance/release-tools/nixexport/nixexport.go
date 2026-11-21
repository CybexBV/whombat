// Package nixexport reads `nix-store --export` streams, the format of Whombat's release artifacts (MG-09,
// format `nix-export`): for every store path it computes the NAR hash (`sha256:<hex>`, the form release tuples and
// artifact metadata use), the NAR size and the references, without Nix and without unpacking anything.
//
// Stream format (Nix `exportPaths`): for each path `u64 1`, the NAR, `u64 0x4558494e` ("NIXE"), the store path, the
// references, the deriver, `u64 0` (no signature); after the last path `u64 0`. Integers are little-endian u64;
// strings are a u64 length, the bytes, zero padding to a multiple of 8.
package nixexport

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
)

const exportMagic = 0x4558494e

// maxName bounds strings that are not file contents (names, targets, paths, tokens).
const maxName = 4096

var storePathRe = regexp.MustCompile(`^/nix/store/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]{1,180}$`)

// Path is one store path of a stream.
type Path struct {
	StorePath  string   `json:"storePath"`
	NarHash    string   `json:"narHash"` // sha256:<hex> of the NAR
	NarSize    int64    `json:"narSize"`
	References []string `json:"references"`
	Deriver    string   `json:"deriver,omitempty"`
}

// Stream is a parsed export stream.
type Stream struct {
	// Paths in stream order (nix-store --import adds them in this order).
	Paths  []Path
	byPath map[string]int
}

// Get returns the entry of a store path.
func (s *Stream) Get(storePath string) (Path, bool) {
	i, ok := s.byPath[storePath]
	if !ok {
		return Path{}, false
	}
	return s.Paths[i], true
}

// Closure returns the store paths reachable from root through references (root included), sorted.
func (s *Stream) Closure(root string) ([]string, error) {
	seen := map[string]bool{}
	stack := []string{root}
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[p] {
			continue
		}
		e, ok := s.Get(p)
		if !ok {
			return nil, fmt.Errorf("nixexport: %s is not in the stream", p)
		}
		seen[p] = true
		stack = append(stack, e.References...)
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, nil
}

// ClosureSize is the sum of the NAR sizes of root's closure: what `nix path-info -S` reports as closureSize (the
// unpacked size, used by the manager for capacity, MG-19).
func (s *Stream) ClosureSize(root string) (int64, error) {
	paths, err := s.Closure(root)
	if err != nil {
		return 0, err
	}
	var n int64
	for _, p := range paths {
		e, _ := s.Get(p)
		n += e.NarSize
	}
	return n, nil
}

// CheckComplete verifies that the stream imports on a store that has none of its paths: every reference of every
// path is the path itself or a path earlier in the stream, and no path appears twice.
func (s *Stream) CheckComplete() error {
	for i, p := range s.Paths {
		for _, r := range p.References {
			if r == p.StorePath {
				continue
			}
			j, ok := s.byPath[r]
			if !ok {
				return fmt.Errorf("nixexport: %s references %s, which the stream does not contain (export the whole closure: nix-store --export $(nix-store -qR …))", p.StorePath, r)
			}
			if j > i {
				return fmt.Errorf("nixexport: %s comes before its reference %s", p.StorePath, r)
			}
		}
	}
	return nil
}

type reader struct {
	r   *bufio.Reader
	n   int64
	nar io.Writer // while a NAR is read: its hash and size
}

func (r *reader) read(p []byte) error {
	if _, err := io.ReadFull(r.r, p); err != nil {
		if errors.Is(err, io.EOF) {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	r.n += int64(len(p))
	if r.nar != nil {
		r.nar.Write(p)
	}
	return nil
}

func (r *reader) u64() (uint64, error) {
	var b [8]byte
	if err := r.read(b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b[:]), nil
}

func pad(n uint64) int { return int((8 - n%8) % 8) }

func (r *reader) padding(n uint64) error {
	var b [8]byte
	k := pad(n)
	if err := r.read(b[:k]); err != nil {
		return err
	}
	for _, c := range b[:k] {
		if c != 0 {
			return errors.New("nixexport: non-zero padding")
		}
	}
	return nil
}

func (r *reader) str(max uint64) (string, error) {
	n, err := r.u64()
	if err != nil {
		return "", err
	}
	if n > max {
		return "", fmt.Errorf("nixexport: string of %d bytes (max %d)", n, max)
	}
	b := make([]byte, n)
	if err := r.read(b); err != nil {
		return "", err
	}
	return string(b), r.padding(n)
}

func (r *reader) expect(tok string) error {
	s, err := r.str(maxName)
	if err != nil {
		return err
	}
	if s != tok {
		return fmt.Errorf("nixexport: expected %q, got %q", tok, s)
	}
	return nil
}

// skip reads n content bytes (and padding) without keeping them.
func (r *reader) skip(n uint64) error {
	buf := make([]byte, 64*1024)
	for left := n; left > 0; {
		k := uint64(len(buf))
		if left < k {
			k = left
		}
		if err := r.read(buf[:k]); err != nil {
			return err
		}
		left -= k
	}
	return r.padding(n)
}

func validName(n string) bool {
	return n != "" && n != "." && n != ".." && len(n) <= 255 && !containsByte(n, '/') && !containsByte(n, 0)
}

func containsByte(s string, c byte) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return true
		}
	}
	return false
}

func (r *reader) node(depth int) error {
	if depth > 256 {
		return errors.New("nixexport: NAR nested too deeply")
	}
	if err := r.expect("("); err != nil {
		return err
	}
	if err := r.expect("type"); err != nil {
		return err
	}
	t, err := r.str(maxName)
	if err != nil {
		return err
	}
	switch t {
	case "regular":
		tok, err := r.str(maxName)
		if err != nil {
			return err
		}
		if tok == "executable" {
			if err := r.expect(""); err != nil {
				return err
			}
			if tok, err = r.str(maxName); err != nil {
				return err
			}
		}
		if tok != "contents" {
			return fmt.Errorf("nixexport: expected contents, got %q", tok)
		}
		n, err := r.u64()
		if err != nil {
			return err
		}
		if err := r.skip(n); err != nil {
			return err
		}
		return r.expect(")")
	case "symlink":
		if err := r.expect("target"); err != nil {
			return err
		}
		if _, err := r.str(maxName); err != nil {
			return err
		}
		return r.expect(")")
	case "directory":
		prev := ""
		for {
			tok, err := r.str(maxName)
			if err != nil {
				return err
			}
			if tok == ")" {
				return nil
			}
			if tok != "entry" {
				return fmt.Errorf("nixexport: expected entry, got %q", tok)
			}
			if err := r.expect("("); err != nil {
				return err
			}
			if err := r.expect("name"); err != nil {
				return err
			}
			name, err := r.str(maxName)
			if err != nil {
				return err
			}
			if !validName(name) || (prev != "" && name <= prev) {
				return fmt.Errorf("nixexport: bad or unsorted entry name %q", name)
			}
			prev = name
			if err := r.expect("node"); err != nil {
				return err
			}
			if err := r.node(depth + 1); err != nil {
				return err
			}
			if err := r.expect(")"); err != nil {
				return err
			}
		}
	}
	return fmt.Errorf("nixexport: unknown node type %q", t)
}

// Read parses a whole export stream. Trailing bytes after the end marker are an error.
func Read(in io.Reader) (*Stream, error) {
	s, _, err := read(in, false)
	return s, err
}

// ReadNARs parses a whole export stream and also returns each path's NAR (tests and fixtures: everything is held in
// memory).
func ReadNARs(in io.Reader) (*Stream, map[string][]byte, error) { return read(in, true) }

func read(in io.Reader, keep bool) (*Stream, map[string][]byte, error) {
	nars := map[string][]byte{}
	r := &reader{r: bufio.NewReaderSize(in, 256*1024)}
	s := &Stream{byPath: map[string]int{}}
	for {
		more, err := r.u64()
		if err != nil {
			return nil, nil, fmt.Errorf("nixexport: at byte %d: %w", r.n, err)
		}
		if more == 0 {
			break
		}
		if more != 1 {
			return nil, nil, fmt.Errorf("nixexport: at byte %d: bad path marker %d (not a nix-store --export stream?)", r.n-8, more)
		}
		h := sha256.New()
		var narBuf bytes.Buffer
		start := r.n
		r.nar = h
		if keep {
			r.nar = io.MultiWriter(h, &narBuf)
		}
		if err := r.expect("nix-archive-1"); err != nil {
			return nil, nil, err
		}
		if err := r.node(0); err != nil {
			return nil, nil, err
		}
		r.nar = nil
		size := r.n - start
		magic, err := r.u64()
		if err != nil {
			return nil, nil, err
		}
		if magic != exportMagic {
			return nil, nil, fmt.Errorf("nixexport: bad export magic %#x", magic)
		}
		p := Path{NarHash: "sha256:" + hex.EncodeToString(h.Sum(nil)), NarSize: size, References: []string{}}
		if p.StorePath, err = r.str(maxName); err != nil {
			return nil, nil, err
		}
		if !storePathRe.MatchString(p.StorePath) {
			return nil, nil, fmt.Errorf("nixexport: bad store path %q", p.StorePath)
		}
		n, err := r.u64()
		if err != nil {
			return nil, nil, err
		}
		if n > 100000 {
			return nil, nil, fmt.Errorf("nixexport: %d references", n)
		}
		for i := uint64(0); i < n; i++ {
			ref, err := r.str(maxName)
			if err != nil {
				return nil, nil, err
			}
			if !storePathRe.MatchString(ref) {
				return nil, nil, fmt.Errorf("nixexport: bad reference %q", ref)
			}
			p.References = append(p.References, ref)
		}
		if p.Deriver, err = r.str(maxName); err != nil {
			return nil, nil, err
		}
		sig, err := r.u64()
		if err != nil {
			return nil, nil, err
		}
		if sig != 0 {
			return nil, nil, errors.New("nixexport: signed export streams are not supported")
		}
		if _, dup := s.byPath[p.StorePath]; dup {
			return nil, nil, fmt.Errorf("nixexport: %s appears twice", p.StorePath)
		}
		s.byPath[p.StorePath] = len(s.Paths)
		s.Paths = append(s.Paths, p)
		if keep {
			nars[p.StorePath] = narBuf.Bytes()
		}
	}
	if _, err := r.r.ReadByte(); err != io.EOF {
		return nil, nil, errors.New("nixexport: trailing bytes after the end of the stream")
	}
	if len(s.Paths) == 0 {
		return nil, nil, errors.New("nixexport: empty stream")
	}
	return s, nars, nil
}
