package snap

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

func TestHelperServesOnlyTheBackupUserAndTypedOps(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "persist", "whombat", "home")
	_ = os.MkdirAll(filepath.Join(src, "files"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "files", "a"), []byte("a"), 0o600)
	_ = os.Symlink("files/a", filepath.Join(src, "link"))
	local := &Local{Driver: Copy{}, Sources: []coverage.Source{{Name: "home", Path: src},
		{Name: "secrets", Path: filepath.Join(dir, "missing")}}, FilesDir: filepath.Join(dir, "staging", "files")}
	serve := func(uid int) string {
		sock := filepath.Join(dir, "s"+string(rune('a'+uid%20))+".sock")
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		srv := &Server{Local: local, AllowedUID: uid}
		go srv.Serve(l)
		t.Cleanup(func() { srv.Close() })
		return sock
	}
	good := &Remote{Socket: serve(os.Getuid())}
	taken, err := good.Take(context.Background(), "ck-1")
	if err != nil || len(taken) != 2 || !taken[1].Missing || good.Method() != "quiesced-copy" {
		t.Fatalf("take: %v %+v", err, taken)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "staging", "files", "home", "files", "a")); string(b) != "a" {
		t.Fatal("copy content")
	}
	if l, _ := os.Readlink(filepath.Join(dir, "staging", "files", "home", "link")); l != "files/a" {
		t.Fatal("symlink not preserved")
	}
	if _, err := good.Take(context.Background(), "../../etc"); err == nil {
		t.Fatal("path-like id accepted")
	}
	if err := good.Release(context.Background(), "ck-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "staging", "files", "home")); err == nil {
		t.Fatal("not released")
	}
	// Another uid is refused.
	other := serve(os.Getuid() + 1)
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", other)
	}}}
	resp, err := hc.Post("http://snapd/v1/take", "application/json", bytes.NewReader([]byte(`{"id":"ck-2"}`)))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign uid: HTTP %d", resp.StatusCode)
	}
}

// A staged copy of a tree with read-only directories (a skill pack's) is removed again when the backup isn't root.
func TestCopyReleaseRemovesReadOnlyDirectories(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root removes read-only directories anyway")
	}
	src := filepath.Join(t.TempDir(), "src")
	pack := filepath.Join(src, "packs", "craft", "1.1.1")
	if err := os.MkdirAll(pack, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pack, "SOURCES.md"), []byte("x"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(pack, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(pack, 0o755) })
	dst := filepath.Join(t.TempDir(), "staged")
	c := Copy{NoClone: true}
	if err := c.Create(context.Background(), src, dst); err != nil {
		t.Fatal(err)
	}
	if err := c.Release(context.Background(), dst); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := os.Lstat(dst); !os.IsNotExist(err) {
		t.Fatalf("staged copy still there: %v", err)
	}
}
