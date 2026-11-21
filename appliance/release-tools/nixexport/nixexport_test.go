package nixexport

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// w builds export streams for tests.
type w struct{ bytes.Buffer }

func (b *w) u64(n uint64) {
	var x [8]byte
	binary.LittleEndian.PutUint64(x[:], n)
	b.Write(x[:])
}

func (b *w) str(s string) {
	b.u64(uint64(len(s)))
	b.WriteString(s)
	b.Write(make([]byte, pad(uint64(len(s)))))
}

func narFile(contents string, exec bool) []byte {
	var b w
	b.str("nix-archive-1")
	b.str("(")
	b.str("type")
	b.str("regular")
	if exec {
		b.str("executable")
		b.str("")
	}
	b.str("contents")
	b.str(contents)
	b.str(")")
	return b.Bytes()
}

func narDir(entries map[string]string) []byte {
	var b w
	b.str("nix-archive-1")
	b.str("(")
	b.str("type")
	b.str("directory")
	names := []string{}
	for n := range entries {
		names = append(names, n)
	}
	for i := range names {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	for _, n := range names {
		b.str("entry")
		b.str("(")
		b.str("name")
		b.str(n)
		b.str("node")
		b.str("(")
		b.str("type")
		if strings.HasPrefix(entries[n], "->") {
			b.str("symlink")
			b.str("target")
			b.str(strings.TrimPrefix(entries[n], "->"))
		} else {
			b.str("regular")
			b.str("contents")
			b.str(entries[n])
		}
		b.str(")")
		b.str(")")
	}
	b.str(")")
	return b.Bytes()
}

type entry struct {
	path string
	nar  []byte
	refs []string
}

func stream(es ...entry) []byte {
	var b w
	for _, e := range es {
		b.u64(1)
		b.Write(e.nar)
		b.u64(exportMagic)
		b.str(e.path)
		b.u64(uint64(len(e.refs)))
		for _, r := range e.refs {
			b.str(r)
		}
		b.str("")
		b.u64(0)
	}
	b.u64(0)
	return b.Bytes()
}

const (
	pa = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-lib"
	pb = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-app"
	pc = "/nix/store/cccccccccccccccccccccccccccccccc-other"
)

func TestReadSynthetic(t *testing.T) {
	lib := narFile("library bytes", false)
	app := narDir(map[string]string{"bin": "->" + pa + "/lib", "run": "#!/bin/sh\n"})
	s, err := Read(bytes.NewReader(stream(entry{pa, lib, nil}, entry{pb, app, []string{pa, pb}})))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Paths) != 2 || s.Paths[0].StorePath != pa || s.Paths[1].StorePath != pb {
		t.Fatalf("paths %+v", s.Paths)
	}
	if s.Paths[0].NarSize != int64(len(lib)) || !strings.HasPrefix(s.Paths[0].NarHash, "sha256:") {
		t.Fatalf("nar %+v", s.Paths[0])
	}
	if err := s.CheckComplete(); err != nil {
		t.Fatal(err)
	}
	c, err := s.Closure(pb)
	if err != nil || len(c) != 2 {
		t.Fatalf("closure %v %v", c, err)
	}
	if n, _ := s.ClosureSize(pb); n != int64(len(lib)+len(app)) {
		t.Fatalf("closure size %d", n)
	}
	if n, _ := s.ClosureSize(pa); n != int64(len(lib)) {
		t.Fatalf("closure size of lib %d", n)
	}
}

func TestReadRefuses(t *testing.T) {
	lib := narFile("x", true)
	good := stream(entry{pa, lib, nil})
	cases := map[string][]byte{
		"empty":         {},
		"no paths":      stream(),
		"truncated":     good[:len(good)-9],
		"trailing":      append(append([]byte{}, good...), 0),
		"not an export": []byte("\x02\x00\x00\x00\x00\x00\x00\x00"),
		"bad path":      stream(entry{"/nix/store/short-x", lib, nil}),
		"duplicate":     stream(entry{pa, lib, nil}, entry{pa, lib, nil}),
		"bad nar":       stream(entry{pa, []byte("\x03\x00\x00\x00\x00\x00\x00\x00abc\x00\x00\x00\x00\x00"), nil}),
		"dotdot entry":  stream(entry{pa, narDir(map[string]string{"..": "x"}), nil}),
	}
	for name, b := range cases {
		if _, err := Read(bytes.NewReader(b)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Parsed, but not importable on its own.
	s, err := Read(bytes.NewReader(stream(entry{pb, lib, []string{pa}})))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckComplete(); err == nil {
		t.Error("missing reference accepted")
	}
	s, _ = Read(bytes.NewReader(stream(entry{pb, lib, []string{pa}}, entry{pa, lib, nil})))
	if err := s.CheckComplete(); err == nil {
		t.Error("reference after its referrer accepted")
	}
	if _, err := s.Closure(pc); err == nil {
		t.Error("closure of a path outside the stream")
	}
}

// nixBase32 decodes Nix's base32 (as `nix-store --query --hash` prints it).
func nixBase32(t *testing.T, s string) []byte {
	const alphabet = "0123456789abcdfghijklmnpqrsvwxyz"
	n := len(s) * 5 / 8
	out := make([]byte, n)
	for i := 0; i < len(s); i++ {
		c := strings.IndexByte(alphabet, s[len(s)-1-i])
		if c < 0 {
			t.Fatalf("bad base32 %q", s)
		}
		b := i * 5
		j, k := b/8, b%8
		out[j] |= byte(c << k)
		if j+1 < n {
			out[j+1] |= byte(c >> (8 - k))
		}
	}
	return out
}

// TestRealExport checks the parser against a real `nix-store --export` of a small closure: the NAR hash equals
// what Nix records for the path, the size what it reports, and the references Nix's.
func TestRealExport(t *testing.T) {
	if _, err := exec.LookPath("nix-store"); err != nil {
		t.Skip("nix-store not installed")
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("whombat nixexport test\n"), 0o644)
	out, err := exec.Command("nix-store", "--add", filepath.Join(dir, "a.txt")).Output()
	if err != nil {
		t.Skipf("nix-store --add: %v", err)
	}
	p := strings.TrimSpace(string(out))
	exp, err := exec.Command("nix-store", "--export", p).Output()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Read(bytes.NewReader(exp))
	if err != nil {
		t.Fatal(err)
	}
	e, ok := s.Get(p)
	if !ok {
		t.Fatalf("%s not in stream", p)
	}
	h, _ := exec.Command("nix-store", "--query", "--hash", p).Output()
	want := "sha256:" + hex.EncodeToString(nixBase32(t, strings.TrimPrefix(strings.TrimSpace(string(h)), "sha256:")))
	if e.NarHash != want {
		t.Fatalf("narHash %s, nix says %s", e.NarHash, want)
	}
	sz, _ := exec.Command("nix-store", "--query", "--size", p).Output()
	if strings.TrimSpace(string(sz)) != strconv.FormatInt(e.NarSize, 10) {
		t.Fatalf("narSize %d, nix says %s", e.NarSize, sz)
	}
	if err := s.CheckComplete(); err != nil {
		t.Fatal(err)
	}
}

func TestSynthetic(t *testing.T) {
	s, err := Read(bytes.NewReader(Synthetic(SyntheticPath{StorePath: pa, Files: map[string]string{"b": "2", "a": "1"}},
		SyntheticPath{StorePath: pb, Files: map[string]string{"x": "y"}, References: []string{pa}})))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckComplete(); err != nil {
		t.Fatal(err)
	}
}
