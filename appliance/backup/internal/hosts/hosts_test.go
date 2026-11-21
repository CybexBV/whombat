package hosts

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

// serve answers every connection on a unix socket with answer (after wait), like the NixOS socket's instance.
func serve(t *testing.T, answer string, wait time.Duration) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "hosts.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				time.Sleep(wait)
				_, _ = c.Write([]byte(answer))
			}()
		}
	}()
	return sock
}

func TestExport(t *testing.T) {
	ctx := context.Background()
	if err := Export(ctx, serve(t, "ok\n", 0)); err != nil {
		t.Fatalf("ok: %v", err)
	}
	err := Export(ctx, serve(t, "failed: database disk image is malformed\n", 0))
	if err == nil || !strings.Contains(err.Error(), "database disk image is malformed") || strings.Contains(err.Error(), "failed:") {
		t.Fatalf("failed: %v", err)
	}
	if err := Export(ctx, serve(t, "", 0)); err == nil || !strings.Contains(err.Error(), "without an answer") {
		t.Fatalf("silent: %v", err)
	}
	if err := Export(ctx, filepath.Join(t.TempDir(), "absent.sock")); err == nil || !strings.Contains(err.Error(), "can't be reached") {
		t.Fatalf("unreachable: %v", err)
	}
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := Export(short, serve(t, "ok\n", 5*time.Second)); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("slow: %v", err)
	}
}

func layout(t *testing.T) coverage.Layout {
	t.Helper()
	l := coverage.Layout{Persist: filepath.Join(t.TempDir(), "persist"), Hosts: true}
	if err := os.MkdirAll(l.HostsData(), 0o710); err != nil {
		t.Fatal(err)
	}
	return l
}

func TestStage(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	l := layout(t)
	src := filepath.Join(t.TempDir(), "hub.tar.gz")
	if err := os.WriteFile(src, []byte("\x1f\x8bthe servers"), 0o644); err != nil { // gzipped, as before
		t.Fatal(err)
	}
	// Whatever the service's user planted at the staged name is replaced, never followed.
	victim := filepath.Join(t.TempDir(), "identity.key")
	if err := os.WriteFile(victim, []byte("root's"), 0o600); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(l.HostsData(), coverage.HostsStagedFile)
	if err := os.Symlink(victim, staged); err != nil {
		t.Fatal(err)
	}
	if err := Stage(src, l, uid, gid); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "root's" {
		t.Fatal("followed the planted symlink")
	}
	fi, err := os.Lstat(staged)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o600 {
		t.Fatalf("staged %v %v", fi, err)
	}
	if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != uid || int(st.Gid) != gid {
		t.Fatalf("staged owned by %d:%d", st.Uid, st.Gid)
	}
	if b, _ := os.ReadFile(staged); string(b) != "\x1f\x8bthe servers" {
		t.Fatalf("staged %q", b)
	}
	ents, _ := os.ReadDir(l.HostsData())
	if len(ents) != 1 {
		t.Fatalf("left behind: %v", ents)
	}
	// A second restore replaces it.
	if err := os.WriteFile(src, []byte("\x1f\x8bnewer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Stage(src, l, uid, gid); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(staged); string(b) != "\x1f\x8bnewer" {
		t.Fatalf("staged %q", b)
	}
}

// A plain tar (hub.tar) is staged as restore-staged.tar, a gzipped one as restore-staged.tar.gz, told apart by their
// first bytes; whatever was staged before under the other name goes, so the service never applies an older one.
func TestStageByFormat(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	l := layout(t)
	tarName := filepath.Join(l.HostsData(), coverage.HostsStagedTarFile)
	gzName := filepath.Join(l.HostsData(), coverage.HostsStagedFile)
	src := filepath.Join(t.TempDir(), "hub.tar")
	write := func(b string) {
		if err := os.WriteFile(src, []byte(b), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("\x1f\x8bgzipped")
	if err := Stage(src, l, uid, gid); err != nil {
		t.Fatal(err)
	}
	if StagedPath(l) != gzName {
		t.Fatalf("a gzipped archive staged at %q", StagedPath(l))
	}
	write("hub.db\x00\x00 a plain tar")
	if err := Stage(src, l, uid, gid); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(tarName); err != nil || string(b) != "hub.db\x00\x00 a plain tar" {
		t.Fatalf("plain tar staged %q %v", b, err)
	}
	if _, err := os.Lstat(gzName); err == nil {
		t.Fatal("the gzipped one staged before is still there")
	}
	if StagedPath(l) != tarName {
		t.Fatalf("staged path %q", StagedPath(l))
	}
	write("x") // shorter than the magic: a plain file, read from its start
	if err := Stage(src, l, uid, gid); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(tarName); string(b) != "x" {
		t.Fatalf("staged %q", b)
	}
}

func TestStageRefuses(t *testing.T) {
	uid, gid := os.Getuid(), os.Getgid()
	src := filepath.Join(t.TempDir(), "hub.tar.gz")
	if err := os.WriteFile(src, []byte("the servers"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The data directory a symlink (to a directory root owns).
	l := coverage.Layout{Persist: filepath.Join(t.TempDir(), "persist"), Hosts: true}
	elsewhere := t.TempDir()
	if err := os.MkdirAll(l.Persist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, l.HostsData()); err != nil {
		t.Fatal(err)
	}
	if err := Stage(src, l, uid, gid); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("symlinked data directory: %v", err)
	}
	if ents, _ := os.ReadDir(elsewhere); len(ents) != 0 {
		t.Fatal("wrote through the symlink")
	}
	// A data directory of another user.
	if os.Getuid() != 0 {
		l = layout(t)
		if err := Stage(src, l, uid+1, gid); err == nil || !strings.Contains(err.Error(), "not the hosts service's") {
			t.Fatalf("another user's directory: %v", err)
		}
	}
	// The source a symlink.
	l = layout(t)
	link := filepath.Join(t.TempDir(), "link.tar.gz")
	_ = os.Symlink(src, link)
	if err := Stage(link, l, uid, gid); err == nil {
		t.Fatal("read the backup through a symlink")
	}
	if StagedPath(l) != "" {
		t.Fatal("staged after a refusal")
	}
}

// What a backup without the servers tells people: why, in their words, never the technical text (the path, the
// service's own name, the error). A box whose hosts service never started (no hub.db yet) says so.
func TestPlainSaysWhyWithoutTheTechnicalText(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	failed := Export(ctx, serve(t, "failed: whombat-hosts: stat /persist/hosts/hub.db: no such file or directory\n", 0))
	slow := Export(ctx, serve(t, "ok\n", time.Second))
	cases := map[string]struct {
		technical string
		says      string
	}{
		"not started":  {failed.Error(), "hadn’t started"},
		"unreachable":  {Export(context.Background(), filepath.Join(t.TempDir(), "none.sock")).Error(), "didn’t answer"},
		"too slow":     {slow.Error(), "too long"},
		"no answer":    {Export(context.Background(), serve(t, "", 0)).Error(), "before its copy was done"},
		"failed":       {WhyFailed + " (database disk image is malformed)", "couldn’t make its copy"},
		"not in it":    {WhyMissing, "couldn’t be read"},
		"unusable":     {WhyUnusable + " (gzip: invalid header)", "couldn’t be read"},
		"unknown text": {"something else entirely", "went wrong"},
	}
	for name, c := range cases {
		got := Plain(c.technical)
		if !strings.Contains(got, c.says) || !strings.Contains(got, "servers’ list") || !strings.Contains(got, "Everything else") {
			t.Errorf("%s: %q says %q", name, c.technical, got)
		}
		for _, tech := range []string{"/persist", "hub.db", "hosts service", "malformed", "gzip", "'"} {
			if strings.Contains(got, tech) {
				t.Errorf("%s: %q has %q", name, got, tech)
			}
		}
	}
}
