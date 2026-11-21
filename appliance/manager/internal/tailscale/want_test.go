package tailscale

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// newWantManager is newManager with a want file in the test's folder.
func newWantManager(t *testing.T, sock, wantFile string) *Manager {
	return New(Config{Socket: sock, Settle: 200 * time.Millisecond, Poll: 20 * time.Millisecond, WantFile: wantFile})
}

func readWant(t *testing.T, path string) (wanted, bool) {
	t.Helper()
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return wanted{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	var w wanted
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatal(err)
	}
	return w, true
}

// restarted is tailscaled after a restart of a box that never signed in: no profile was saved, so its prefs are the
// defaults (not running, Tailscale's own server) and nobody has asked for a link.
func (f *fakeTailscaled) restarted() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.st = rawStatus{BackendState: "NeedsLogin"}
	f.prefs = rawPrefs{}
	f.calls = nil
}

func (f *fakeTailscaled) prefsNow() rawPrefs {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.prefs
}

// The installer's Expert choice with the owner's own login server, then a restart before the sign-in: the manager turns
// Tailscale on again on that server, so the screen gets a sign-in link again. Signed in, tailscaled keeps it, and the
// owner's off stays off.
func TestRestartBeforeTheFirstSignIn(t *testing.T) {
	want := filepath.Join(t.TempDir(), "tailscale.json")
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, login: "https://hs.example.com/register/a1"}
	sock := startFake(t, f)
	ctx := context.Background()
	m := newWantManager(t, sock, want)
	if s, err := m.On(ctx, "https://hs.example.com"); err != nil || s.State != protocol.TailscaleStateNeedsSignIn {
		t.Fatalf("%+v %v", s, err)
	}
	if w, ok := readWant(t, want); !ok || !w.On || w.LoginServer != "https://hs.example.com" {
		t.Fatalf("%+v %v", w, ok)
	}

	// The box restarts: tailscaled forgot everything, a new manager starts.
	f.restarted()
	f.login = "https://hs.example.com/register/b2"
	m = newWantManager(t, sock, want)
	m.resumedAt = time.Now() // State's own resume waits: Resume at start does it here
	if s := m.State(ctx); s.State == protocol.TailscaleStateNeedsSignIn {
		t.Fatalf("the fake didn't forget: %+v", s)
	}
	on, err := m.Resume(ctx, nil)
	if err != nil || !on {
		t.Fatalf("%v %v", on, err)
	}
	p := f.prefsNow()
	if !p.WantRunning || p.ControlURL != "https://hs.example.com" {
		t.Fatalf("%+v", p)
	}
	s := m.State(ctx)
	if s.State != protocol.TailscaleStateNeedsSignIn || *s.LoginURL != "https://hs.example.com/register/b2" {
		t.Fatalf("%+v", s)
	}
	valid(t, s)

	// Signed in: running a moment before tailscaled saved the profile, so the want stays until it has.
	f.mu.Lock()
	f.st = runningAs("whombat-r7m4.hs.example.com.")
	f.st.HaveNodeKey = true
	f.mu.Unlock()
	if s := m.State(ctx); s.State != protocol.TailscaleStateOn {
		t.Fatalf("%+v", s)
	}
	if w, ok := readWant(t, want); !ok || !w.On {
		t.Fatalf("the want ended before tailscaled saved the profile: %+v %v", w, ok)
	}
	f.mu.Lock()
	f.profileID = "a1b2"
	f.mu.Unlock()
	m.State(ctx)
	if w, ok := readWant(t, want); !ok || w.On {
		t.Fatalf("still wanted after the sign-in: %+v %v", w, ok)
	}
	// The owner turns it off; a restart leaves it off.
	if _, err := m.Off(ctx, false); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.calls = nil
	f.mu.Unlock()
	if on, err := newWantManager(t, sock, want).Resume(ctx, str("https://hs.example.com")); err != nil || on {
		t.Fatalf("%v %v", on, err)
	}
	if got := strings.Join(f.callsSoFar(), "|"); strings.Contains(got, "PATCH") || strings.Contains(got, "start") {
		t.Fatal(got)
	}
}

// tailscaled restarted alone (an update, a crash) before the first sign-in: the next state read turns it on again, at
// most once a minute.
func TestTailscaledRestartedAlone(t *testing.T) {
	want := filepath.Join(t.TempDir(), "tailscale.json")
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, login: "https://login.tailscale.com/a/f00d"}
	sock := startFake(t, f)
	ctx := context.Background()
	m := newWantManager(t, sock, want)
	if _, err := m.On(ctx, ""); err != nil {
		t.Fatal(err)
	}
	f.restarted()
	m.State(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for !f.prefsNow().WantRunning {
		if time.Now().After(deadline) {
			t.Fatalf("not on again: %v", f.callsSoFar())
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitFor(t, func() bool { return m.State(ctx).State == protocol.TailscaleStateNeedsSignIn })
	// Forgotten again within the minute: not again yet.
	f.restarted()
	m.State(ctx)
	time.Sleep(100 * time.Millisecond)
	if f.prefsNow().WantRunning {
		t.Fatal("turned on again within a minute")
	}
}

// A box from before the want file: its reach choice stands while tailscaled never signed in, and only then.
func TestResumeFromTheReachChoice(t *testing.T) {
	ctx := context.Background()
	t.Run("never signed in", func(t *testing.T) {
		want := filepath.Join(t.TempDir(), "tailscale.json")
		f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, login: "https://login.tailscale.com/a/f00d"}
		m := newWantManager(t, startFake(t, f), want)
		if on, err := m.Resume(ctx, str("")); err != nil || !on {
			t.Fatalf("%v %v", on, err)
		}
		if w, ok := readWant(t, want); !ok || !w.On || w.LoginServer != "" {
			t.Fatalf("%+v %v", w, ok)
		}
		if s := m.State(ctx); s.State != protocol.TailscaleStateNeedsSignIn {
			t.Fatalf("%+v", s)
		}
	})
	t.Run("signed in before, turned off since", func(t *testing.T) {
		want := filepath.Join(t.TempDir(), "tailscale.json")
		f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "Stopped", HaveNodeKey: true}}
		m := newWantManager(t, startFake(t, f), want)
		if on, err := m.Resume(ctx, str("")); err != nil || on {
			t.Fatalf("%v %v", on, err)
		}
		if w, ok := readWant(t, want); !ok || w.On {
			t.Fatalf("%+v %v", w, ok)
		}
		if got := strings.Join(f.callsSoFar(), "|"); strings.Contains(got, "PATCH") {
			t.Fatal(got)
		}
	})
	t.Run("not chosen", func(t *testing.T) {
		want := filepath.Join(t.TempDir(), "tailscale.json")
		f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}}
		m := newWantManager(t, startFake(t, f), want)
		if on, err := m.Resume(ctx, nil); err != nil || on {
			t.Fatalf("%v %v", on, err)
		}
		if _, ok := readWant(t, want); ok || len(f.callsSoFar()) != 0 {
			t.Fatalf("%v %v", ok, f.callsSoFar())
		}
	})
	t.Run("tailscaled not answering yet", func(t *testing.T) {
		m := newWantManager(t, filepath.Join(t.TempDir(), "none.sock"), filepath.Join(t.TempDir(), "tailscale.json"))
		if _, err := m.Resume(ctx, str("")); err == nil {
			t.Fatal("no error: the start wouldn't try again")
		}
	})
}

// Sign-in remembers the server the box is set to; off forgets the want.
func TestSignInAndOffKeepTheWant(t *testing.T) {
	want := filepath.Join(t.TempDir(), "tailscale.json")
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, prefs: rawPrefs{ControlURL: "https://hs.example.com"},
		login: "https://hs.example.com/register/c3"}
	m := newWantManager(t, startFake(t, f), want)
	ctx := context.Background()
	if _, err := m.SignIn(ctx); err != nil {
		t.Fatal(err)
	}
	if w, ok := readWant(t, want); !ok || !w.On || w.LoginServer != "https://hs.example.com" {
		t.Fatalf("%+v %v", w, ok)
	}
	if _, err := m.Off(ctx, false); err != nil {
		t.Fatal(err)
	}
	if w, ok := readWant(t, want); !ok || w.On {
		t.Fatalf("%+v %v", w, ok)
	}
	if on, err := m.Resume(ctx, str("https://hs.example.com")); err != nil || on {
		t.Fatalf("%v %v", on, err)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Right after a sign-in tailscaled wants a sign-in with no link for a moment (registered, no map yet): a link asked for
// then would start a new sign-in. State asks only once that has lasted linkGrace.
func TestNoLinkRightAfterASignIn(t *testing.T) {
	f := &fakeTailscaled{t: t, st: rawStatus{BackendState: "NeedsLogin"}, prefs: rawPrefs{WantRunning: true},
		login: "https://login.tailscale.com/a/c0ffee"}
	m := newManager(t, startFake(t, f), nil)
	m.linkGrace = 200 * time.Millisecond
	ctx := context.Background()
	asked := func() int { return strings.Count(strings.Join(f.callsSoFar(), "|"), "login-interactive") }
	m.State(ctx)
	m.State(ctx)
	if asked() != 0 {
		t.Fatal("asked for a link at once")
	}
	// The sign-in completes: running, and the wait starts again from nothing.
	f.mu.Lock()
	f.st = runningAs("whombat-r7m4.tail1234.ts.net.")
	f.mu.Unlock()
	m.State(ctx)
	time.Sleep(250 * time.Millisecond)
	f.mu.Lock()
	f.st = rawStatus{BackendState: "NeedsLogin"}
	f.mu.Unlock()
	m.State(ctx)
	if asked() != 0 {
		t.Fatal("the wait didn't start again")
	}
	// Still without a link after the grace: signed out by the tailnet, a link is asked for.
	time.Sleep(250 * time.Millisecond)
	if s := m.State(ctx); s.State != protocol.TailscaleStateStarting || asked() != 1 {
		t.Fatalf("%+v asked %d", s, asked())
	}
}
