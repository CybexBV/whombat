package wall

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeNFT records applied scripts; fail makes the next non-empty transactions fail.
type fakeNFT struct {
	mu      sync.Mutex
	scripts []string
	fail    bool
	applied chan string
}

func (f *fakeNFT) apply(script string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail && strings.Contains(script, "add element") {
		return errors.New("nft: Error: conflicting intervals")
	}
	f.scripts = append(f.scripts, script)
	if f.applied != nil {
		f.applied <- script
	}
	return nil
}

func (f *fakeNFT) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.scripts)
}

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) log(msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, msg)
}

func (l *logs) last() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.lines) == 0 {
		return ""
	}
	return l.lines[len(l.lines)-1]
}

func newWall(t *testing.T) (string, *Wall, *fakeNFT, *logs) {
	d, src := dir(t)
	f := &fakeNFT{}
	l := &logs{}
	return d, &Wall{Source: src, Sets: testSets, Apply: f.apply, Log: l.log}, f, l
}

const empty = "flush set inet whombat-egress vault4\nflush set inet whombat-egress vault6\n"

// replace writes the file the way the runtime does (temp file + rename, VT-59).
func replace(t *testing.T, d, data string) {
	t.Helper()
	tmp := filepath.Join(d, ".networks.json.tmp")
	write(t, tmp, data, 0o644)
	if err := os.Rename(tmp, filepath.Join(d, "networks.json")); err != nil {
		t.Fatal(err)
	}
}

func TestSync(t *testing.T) {
	d, w, f, l := newWall(t)

	// No file yet: empty sets.
	if err := w.Sync(false); err != nil {
		t.Fatal(err)
	}
	if f.scripts[0] != empty || !strings.Contains(l.last(), "no ") {
		t.Fatalf("%q %q", f.scripts, l.lines)
	}

	// A list: its elements. Unchanged: nothing applied, nothing logged. Forced: applied again, not logged.
	replace(t, d, valid)
	if err := w.Sync(false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.scripts[1], "192.168.1.0/24 . 8123") || !strings.Contains(l.last(), "1 Vault networks") {
		t.Fatalf("%q %q", f.scripts, l.lines)
	}
	_ = w.Sync(false)
	if f.count() != 2 || len(l.lines) != 2 {
		t.Fatalf("unchanged file re-applied: %d %q", f.count(), l.lines)
	}
	_ = w.Sync(true)
	if f.count() != 3 || f.scripts[2] != f.scripts[1] || len(l.lines) != 2 {
		t.Fatalf("forced: %d %q", f.count(), l.lines)
	}

	// Invalid in any way: empty sets and the reason in the log.
	for _, tc := range []struct{ data, why string }{
		{`{"version":1,"networks":[{"cidr":"127.0.0.1/32","ports":[80]}]}`, "loopback"},
		{`{"version":1,"networks":[{"cidr":"169.254.169.254/32","ports":[80]}]}`, "link-local"},
		{`{"version":1,"networks":[{"cidr":"10.0.0.0/8","ports":[80]}]}`, "wider than /16"},
		{`{"version":1,"networks":[{"cidr":"8.8.8.8/32","ports":[80]}]}`, "not a private network"},
		{`{"version":1,"networks":[`, "not the expected JSON"},
	} {
		replace(t, d, valid)
		_ = w.Sync(false)
		replace(t, d, tc.data)
		if err := w.Sync(false); err != nil {
			t.Fatal(err)
		}
		if got := f.scripts[len(f.scripts)-1]; got != empty {
			t.Fatalf("%s: applied %q", tc.why, got)
		}
		if !strings.Contains(l.last(), "refused") || !strings.Contains(l.last(), tc.why) {
			t.Fatalf("%s: logged %q", tc.why, l.last())
		}
	}

	// A symlink in place of the file: refused, empty.
	replace(t, d, valid)
	_ = w.Sync(false)
	outside := filepath.Join(t.TempDir(), "x.json")
	write(t, outside, valid, 0o644)
	os.Remove(filepath.Join(d, "networks.json"))
	if err := os.Symlink(outside, filepath.Join(d, "networks.json")); err != nil {
		t.Fatal(err)
	}
	_ = w.Sync(false)
	if f.scripts[len(f.scripts)-1] != empty || !strings.Contains(l.last(), "symbolic link") {
		t.Fatalf("symlink: %q", l.last())
	}

	// Removed: empty.
	replace(t, d, valid)
	_ = w.Sync(false)
	os.Remove(filepath.Join(d, "networks.json"))
	_ = w.Sync(false)
	if f.scripts[len(f.scripts)-1] != empty {
		t.Fatal("removed file left elements")
	}
}

// A transaction that fails leaves nft's old elements; Sync then empties the sets (fail closed) and retries on the
// next sync even when the file did not change.
func TestSyncFailureEmpties(t *testing.T) {
	d, w, f, l := newWall(t)
	replace(t, d, valid)
	f.fail = true
	if err := w.Sync(false); err == nil {
		t.Fatal("no error")
	}
	if f.scripts[len(f.scripts)-1] != empty || !strings.Contains(l.last(), "emptied the sets") {
		t.Fatalf("%q %q", f.scripts, l.lines)
	}
	f.fail = false
	if err := w.Sync(false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.scripts[len(f.scripts)-1], "192.168.1.0/24 . 8123") {
		t.Fatalf("not retried: %q", f.scripts)
	}
}

func TestRun(t *testing.T) {
	d, w, f, _ := newWall(t)
	f.applied = make(chan string, 16)
	ctx, cancel := context.WithCancel(context.Background())
	reload := make(chan struct{}, 1)
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx, time.Hour, reload, func() { close(ready) }) }()

	next := func(what string) string {
		t.Helper()
		select {
		case s := <-f.applied:
			return s
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: nothing applied", what)
			return ""
		}
	}
	if s := next("start"); s != empty {
		t.Fatalf("start: %q", s)
	}
	<-ready

	// Each change of the file is applied at once (inotify), a temp file alone is not a change.
	write(t, filepath.Join(d, ".networks.json.tmp"), valid, 0o644)
	os.Rename(filepath.Join(d, ".networks.json.tmp"), filepath.Join(d, "networks.json"))
	if s := next("rename"); !strings.Contains(s, "192.168.1.0/24 . 8123") {
		t.Fatalf("rename: %q", s)
	}
	replace(t, d, `{"version":1,"networks":[{"cidr":"fd12:3456:789a::/48","ports":[8123]}]}`)
	if s := next("second rename"); !strings.Contains(s, "fd12:3456:789a::/48 . 8123") || strings.Contains(s, "192.168") {
		t.Fatalf("second rename: %q", s)
	}
	os.Chmod(filepath.Join(d, "networks.json"), 0o666)
	if s := next("chmod"); s != empty {
		t.Fatalf("chmod 0666: %q", s)
	}
	os.Chmod(filepath.Join(d, "networks.json"), 0o644)
	if s := next("chmod back"); !strings.Contains(s, "fd12") {
		t.Fatalf("chmod back: %q", s)
	}
	// Written in place (not atomically) is also seen.
	write(t, filepath.Join(d, "networks.json"), valid, 0o644)
	if s := next("in place"); !strings.Contains(s, "192.168.1.0/24 . 8123") {
		t.Fatalf("in place: %q", s)
	}
	os.Remove(filepath.Join(d, "networks.json"))
	if s := next("remove"); s != empty {
		t.Fatalf("remove: %q", s)
	}

	// A reload re-applies even without a change.
	reload <- struct{}{}
	if s := next("reload"); s != empty {
		t.Fatalf("reload: %q", s)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
	}
}

// The watch notices the file, ignores other names, and is armed again after its directory was replaced.
func TestWatcherRearms(t *testing.T) {
	d, _ := dir(t)
	w, err := newWatcher(d, "networks.json")
	if err != nil {
		t.Fatal(err)
	}
	defer w.close()
	if err := w.ensure(); err != nil {
		t.Fatal(err)
	}
	signalled := func(want bool, what string) {
		t.Helper()
		select {
		case <-w.c:
			if !want {
				t.Fatalf("%s: signalled", what)
			}
		case <-time.After(300 * time.Millisecond):
			if want {
				t.Fatalf("%s: not signalled", what)
			}
		}
	}
	write(t, filepath.Join(d, "other.json"), valid, 0o644)
	signalled(false, "another file")
	replace(t, d, valid)
	signalled(true, "the file")

	os.RemoveAll(d)
	signalled(true, "directory removed")
	deadline := time.Now().Add(2 * time.Second)
	for {
		w.mu.Lock()
		wd := w.wd
		w.mu.Unlock()
		if wd < 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the lost watch was not noticed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := w.ensure(); err == nil {
		t.Fatal("watching a missing directory")
	}
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := w.ensure(); err != nil {
		t.Fatal(err)
	}
	for len(w.c) > 0 {
		<-w.c
	}
	replace(t, d, valid)
	signalled(true, "the file in the new directory")
}

// The first sync must work: a daemon that cannot apply anything does not report ready.
func TestRunFailsWhenNothingApplies(t *testing.T) {
	_, w, _, _ := newWall(t)
	w.Apply = func(string) error { return errors.New("nft: no such table") }
	err := w.Run(context.Background(), time.Hour, nil, func() { t.Error("ready") })
	if err == nil {
		t.Fatal("no error")
	}
}

// When only the list fails and emptying works, the sets are in a known (closed) state: the daemon keeps running and
// retries, rather than restarting until systemd gives up.
func TestRunKeepsGoingWhenOnlyTheListFails(t *testing.T) {
	d, w, f, _ := newWall(t)
	replace(t, d, valid)
	f.fail = true
	f.applied = make(chan string, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	reload := make(chan struct{}, 1)
	go func() { _ = w.Run(ctx, time.Hour, reload, func() { close(ready) }) }()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("not ready")
	}
	if s := <-f.applied; s != empty {
		t.Fatalf("applied %q", s)
	}
	f.mu.Lock()
	f.fail = false
	f.mu.Unlock()
	reload <- struct{}{}
	if s := <-f.applied; !strings.Contains(s, "192.168.1.0/24 . 8123") {
		t.Fatalf("not retried: %q", s)
	}
}
