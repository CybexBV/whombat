package clientbundle_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
)

type member struct {
	name     string
	typ      byte
	mode     int64
	body     string
	linkname string
}

func archive(t *testing.T, ms ...member) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, m := range ms {
		h := &tar.Header{Name: m.name, Typeflag: m.typ, Mode: m.mode, Size: int64(len(m.body)), Linkname: m.linkname}
		if m.typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if m.typ == tar.TypeReg {
			tw.Write([]byte(m.body))
		}
	}
	tw.Close()
	gz.Close()
	p := filepath.Join(t.TempDir(), "a.tar.gz")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestUnpackPackageLayout(t *testing.T) {
	a := archive(t,
		member{name: "bin/", typ: tar.TypeDir, mode: 0o755},
		member{name: "bin/codex", typ: tar.TypeReg, mode: 0o755, body: "codex"},
		member{name: "./codex-resources/bwrap", typ: tar.TypeReg, mode: 0o755, body: "bwrap"},
		member{name: "codex-package.json", typ: tar.TypeReg, mode: 0o644, body: "{}"},
	)
	dest := filepath.Join(t.TempDir(), "v")
	if err := clientbundle.Unpack(context.Background(), a, dest, clientbundle.Limits{}, nil); err != nil {
		t.Fatal(err)
	}
	if err := clientbundle.ReadOnly(dest); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { clientbundle.ForceRemove(dest) })
	if err := clientbundle.CheckExecutable(dest, "bin/codex", 5, sum("codex")); err != nil {
		t.Fatal(err)
	}
	if err := clientbundle.CheckExecutable(dest, "bin/codex", 5, sum("other")); !errors.Is(err, clientbundle.ErrExecutable) {
		t.Fatalf("wrong digest: %v", err)
	}
	if err := clientbundle.CheckExecutable(dest, "codex-package.json", 2, sum("{}")); !errors.Is(err, clientbundle.ErrExecutable) {
		t.Fatalf("not executable: %v", err)
	}
	for p, want := range map[string]os.FileMode{"bin": 0o555, "bin/codex": 0o555, "codex-package.json": 0o444} {
		st, _ := os.Stat(filepath.Join(dest, p))
		if st.Mode().Perm() != want {
			t.Fatalf("%s: %v", p, st.Mode())
		}
	}
	if err := clientbundle.ForceRemove(dest); err != nil {
		t.Fatal(err)
	}
}

func TestUnpackRefusesHostileArchives(t *testing.T) {
	cases := map[string][]member{
		"traversal":     {{name: "../x", typ: tar.TypeReg, body: "x"}},
		"absolute":      {{name: "/etc/x", typ: tar.TypeReg, body: "x"}},
		"dotdot inside": {{name: "a/../../x", typ: tar.TypeReg, body: "x"}},
		"symlink":       {{name: "a", typ: tar.TypeSymlink, linkname: "/etc"}, {name: "a/passwd", typ: tar.TypeReg, body: "x"}},
		"hardlink":      {{name: "a", typ: tar.TypeLink, linkname: "/etc/passwd"}},
		"device":        {{name: "a", typ: tar.TypeChar}},
		"duplicate":     {{name: "a", typ: tar.TypeReg, body: "x"}, {name: "a", typ: tar.TypeReg, body: "y"}},
		"file as dir":   {{name: "a", typ: tar.TypeReg, body: "x"}, {name: "a/b", typ: tar.TypeReg, body: "y"}},
	}
	for name, ms := range cases {
		t.Run(name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "v")
			err := clientbundle.Unpack(context.Background(), archive(t, ms...), dest, clientbundle.Limits{}, nil)
			if err == nil {
				t.Fatal("accepted")
			}
			if _, err := os.Stat(dest); !os.IsNotExist(err) {
				t.Fatal("left the destination behind")
			}
		})
	}
	dest := filepath.Join(t.TempDir(), "v")
	big := archive(t, member{name: "a", typ: tar.TypeReg, body: "0123456789"})
	if err := clientbundle.Unpack(context.Background(), big, dest, clientbundle.Limits{MaxBytes: 5}, nil); !errors.Is(err, clientbundle.ErrBadArchive) {
		t.Fatalf("size limit: %v", err)
	}
}

func TestWriteTarGzIsReproducible(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "claude")
	os.WriteFile(exe, []byte("binary bytes"), 0o700)
	var a, b bytes.Buffer
	if err := clientbundle.WriteTarGz(&a, []clientbundle.Entry{{Name: "claude", Exec: true, Path: exe}}); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(exe, time.Unix(1, 0), time.Unix(1, 0))
	clientbundle.WriteTarGz(&b, []clientbundle.Entry{{Name: "claude", Exec: true, Path: exe}})
	if !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("not reproducible")
	}
}
