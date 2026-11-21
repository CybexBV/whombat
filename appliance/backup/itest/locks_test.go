package itest

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// stall is a proxy in front of rest-server. Once armed, it holds every request but the locks' after a lock was written:
// a restic that has taken its lock then sits inside the repository until it is killed or cancelled, like one stopped by
// a power cut, an OOM kill or a timeout.
type stall struct {
	mu      sync.Mutex
	on      bool // armed
	holding bool // a lock was written since: hold the rest
	release chan struct{}
	locked  chan struct{} // a lock was written while armed
}

func newStall(t *testing.T, target string) (*stall, string) {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	s := &stall{release: make(chan struct{})}
	rp := httputil.NewSingleHostReverseProxy(u)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		on, holding, rel, locked := s.on, s.holding, s.release, s.locked
		s.mu.Unlock()
		isLock := strings.Contains(r.URL.Path, "/locks")
		if holding && !isLock {
			select {
			case <-rel:
			case <-r.Context().Done():
				return
			}
		}
		rp.ServeHTTP(w, r)
		if on && isLock && r.Method == http.MethodPost {
			s.mu.Lock()
			s.holding = s.on
			s.mu.Unlock()
			select {
			case locked <- struct{}{}:
			default:
			}
		}
	}))
	t.Cleanup(func() { s.off(); srv.Close() })
	return s, srv.URL
}

// hold starts holding requests and returns a channel that gets a value once a lock is written.
func (s *stall) hold() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.on, s.holding, s.release, s.locked = true, false, make(chan struct{}), make(chan struct{}, 1)
	return s.locked
}

func (s *stall) off() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.on {
		s.on, s.holding = false, false
		close(s.release)
	}
}

func lockFiles(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Join(dir, "locks"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// killed runs `restic <args>` through the stalling proxy, waits until it holds its lock and kills it with SIGKILL: its
// lock stays behind in the repository.
func killed(t *testing.T, st *stall, r restic.Repo, args ...string) {
	t.Helper()
	locked := st.hold()
	cmd := exec.Command(r.Binary, args...)
	cmd.Env = append(os.Environ(), "RESTIC_REPOSITORY="+r.Repository, "RESTIC_PASSWORD_FILE="+r.PasswordFile,
		"RESTIC_REST_USERNAME="+r.RESTUser, "RESTIC_REST_PASSWORD="+r.RESTPassword, "RESTIC_CACHE_DIR="+t.TempDir())
	cmd.Stdin = strings.NewReader("data")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-locked:
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("restic %s never took its lock", args[0])
	}
	_ = cmd.Process.Signal(syscall.SIGKILL)
	_ = cmd.Wait()
	st.off()
}

// Locks left by a restic that was killed (a power cut, an OOM kill) don't block what comes after: a backup, the box's
// own clearing (forget and prune) and the weekly check all run, and a restic that is cancelled removes its own lock.
func TestStaleLocksAreCleared(t *testing.T) {
	ctx := context.Background()
	tl := NeedTools(t)
	data := filepath.Join(t.TempDir(), "rest-data")
	pass := Rand(12)
	rs := StartRestServer(t, tl, data, false, map[string]string{"box": pass})
	st, proxy := newStall(t, rs.URL)
	pw := filepath.Join(t.TempDir(), "password")
	WriteFile(t, pw, Rand(16))
	r := restic.Repo{Binary: tl.Restic, Repository: "rest:" + proxy + "/box/", PasswordFile: pw, RESTUser: "box",
		RESTPassword: pass, CacheDir: t.TempDir(), RetryLock: 2 * time.Second}
	if _, err := r.Init(ctx); err != nil {
		t.Fatal(err)
	}
	repoDir := filepath.Join(data, "box")
	src := t.TempDir()
	WriteFile(t, filepath.Join(src, "a.txt"), "one")
	backup := func() error {
		_, err := r.Backup(ctx, restic.BackupOptions{Dir: src, Paths: []string{"."}, Tags: []string{"t"}})
		return err
	}
	if err := backup(); err != nil {
		t.Fatal(err)
	}

	// A killed backup leaves a lock; the forget and prune after it run.
	killed(t, st, r, "backup", "--stdin", "--stdin-filename", "x", "--tag", "t")
	if len(lockFiles(t, repoDir)) == 0 {
		t.Fatal("the killed backup left no lock: the test proves nothing")
	}
	if out, err := r.Forget(ctx, "t", []string{"--keep-last", "1"}); err != nil {
		t.Fatalf("forget after a killed backup: %v\n%s", err, out)
	}

	// A killed check leaves an exclusive lock; the backup, the forget and the check after it run.
	killed(t, st, r, "check")
	if len(lockFiles(t, repoDir)) == 0 {
		t.Fatal("the killed check left no lock")
	}
	WriteFile(t, filepath.Join(src, "b.txt"), "two")
	if err := backup(); err != nil {
		t.Fatalf("backup after a killed check: %v", err)
	}
	killed(t, st, r, "check")
	if out, err := r.Forget(ctx, "t", []string{"--keep-last", "1"}); err != nil {
		t.Fatalf("forget after a killed check: %v\n%s", err, out)
	}
	killed(t, st, r, "check")
	if out, err := r.Check(ctx, ""); err != nil {
		t.Fatalf("check after a killed check: %v\n%s", err, out)
	}
	if l := lockFiles(t, repoDir); len(l) != 0 {
		t.Fatalf("locks left: %v", l)
	}

	// A cancelled restic (a timeout, the service stopping) is stopped with SIGTERM and removes its own lock.
	locked := st.hold()
	cctx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { _, err := r.Check(cctx, ""); done <- err }()
	select {
	case <-locked:
	case <-time.After(30 * time.Second):
		t.Fatal("check never took its lock")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled check succeeded")
	}
	st.off()
	if l := lockFiles(t, repoDir); len(l) != 0 {
		t.Fatalf("a cancelled restic left its lock: %v", l)
	}
}
