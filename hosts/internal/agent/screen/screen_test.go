package screen

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image/jpeg"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func run(t *testing.T, s *Screen, req proto.ScreenRequest) proto.ScreenResponse {
	t.Helper()
	return s.Screen(context.Background(), req)
}

func setAccount(t *testing.T, s *Screen, user, pw string) {
	t.Helper()
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: user, Password: pw}})
	if !r.OK {
		t.Fatalf("account.set: %+v", r)
	}
}

func TestAccountSet(t *testing.T) {
	f := newFakeSharing(t, "alex", "right horse")
	s := newTestScreen(t, f.addr())

	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: "alex", Password: "wrong"}})
	if r.OK || r.Code != proto.ScreenCodeSignInFailed {
		t.Fatalf("wrong password: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(s.dir, AccountFileName)); !os.IsNotExist(err) {
		t.Fatal("a refused account must not be stored")
	}
	if strings.Contains(r.Message, "wrong") {
		t.Fatal("the answer must not carry the password")
	}

	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: " alex ", Password: "right horse"}})
	if !r.OK || r.Status == nil || r.Status.Account != "alex" || r.Status.SignIn != "ok" || r.Status.Width != 64 || r.ScreenW != 64 || r.ScreenH != 48 {
		t.Fatalf("account.set: %+v %+v", r, r.Status)
	}
	fi, err := os.Stat(filepath.Join(s.dir, AccountFileName))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("screen.toml: %v %v", fi, err)
	}
	a, err := ReadAccount(s.dir)
	if err != nil || a.User != "alex" || a.Password != "right horse" {
		t.Fatalf("ReadAccount: %+v %v", a, err)
	}

	for _, bad := range []proto.ScreenAccount{{User: "", Password: "x"}, {User: "alex", Password: ""},
		{User: "alex", Password: strings.Repeat("x", 64)}, {User: "al\nex", Password: "x"}} {
		r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &bad})
		if r.Code != "invalid_request" {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet}); r.Code != "invalid_request" {
		t.Fatalf("no account: %+v", r)
	}
}

func TestAccountCheckAndClear(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw1")
	s := newTestScreen(t, f.addr())
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountCheck}); r.Code != proto.ScreenCodeNoAccount {
		t.Fatalf("check without account: %+v", r)
	}
	setAccount(t, s, "alex", "pw1")
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountCheck}); !r.OK || r.Status.SignIn != "ok" {
		t.Fatalf("check: %+v", r)
	}
	f.setPassword("pw2") // the Mac's password changed
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountCheck})
	if r.Code != proto.ScreenCodeSignInFailed || r.Status == nil || r.Status.SignIn != "failed" || r.Status.SignInAt.IsZero() {
		t.Fatalf("check after change: %+v %+v", r, r.Status)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); r.Code != proto.ScreenCodeSignInFailed {
		t.Fatalf("look with a refused account: %+v", r)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountClear})
	if !r.OK || r.Status.Account != "" || r.Status.SignIn != "" {
		t.Fatalf("clear: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(s.dir, AccountFileName)); !os.IsNotExist(err) {
		t.Fatal("clear must remove screen.toml")
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); r.Code != proto.ScreenCodeNoAccount {
		t.Fatalf("look without account: %+v", r)
	}
}

func TestLook(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	f.chatty = true // bells and clipboard text are drained
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw")

	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook})
	if !r.OK || r.Format != "png" || r.W != 64 || r.H != 48 || r.ScreenW != 64 || r.ScreenH != 48 {
		t.Fatalf("look: %+v", r)
	}
	img, err := png.Decode(bytes.NewReader(r.Image))
	if err != nil {
		t.Fatal(err)
	}
	if r8, g8, b8, a8 := img.At(10, 20).RGBA(); r8>>8 != 10 || g8>>8 != 20 || b8>>8 != 7 || a8>>8 != 255 {
		t.Fatalf("pixel (10, 20) = %d %d %d %d", r8>>8, g8>>8, b8>>8, a8>>8)
	}

	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenLook, MaxW: 32, Format: "jpeg"})
	if !r.OK || r.Format != "jpeg" || r.W != 32 || r.H != 24 || r.ScreenW != 64 {
		t.Fatalf("scaled look: %+v", r)
	}
	if _, err := jpeg.Decode(bytes.NewReader(r.Image)); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.counts(); n != 1 {
		t.Fatalf("looks must share the kept connection; %d sign-ins", n)
	}
	// A picture too big for one message to the hub comes smaller.
	maxImageBytes, minImageW = 100, 16
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenLook})
	maxImageBytes, minImageW = 7<<20, 320
	if !r.OK || r.W >= 64 || r.ScreenW != 64 {
		t.Fatalf("capped look: %+v", r)
	}
	for _, bad := range []proto.ScreenRequest{{Op: proto.ScreenLook, Format: "gif"}, {Op: proto.ScreenLook, MaxW: -1}} {
		if r := run(t, s, bad); r.Code != "invalid_request" {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}

	// Screen Sharing restarts: the next step signs in again.
	f.dropAll()
	time.Sleep(50 * time.Millisecond)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); !r.OK {
		t.Fatalf("look after a restart: %+v", r)
	}
	if n, _ := f.counts(); n != 2 {
		t.Fatalf("sign-ins %d", n)
	}
	// An idle connection is closed.
	s.idleClose = 0
	s.closeIdle()
	if s.conn != nil {
		t.Fatal("idle connection kept")
	}
}

func TestNoScreen(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close() // nothing answers there
	s := newTestScreen(t, addr)
	if err := writeAccount(s.dir, Account{User: "alex", Password: "pw"}); err != nil {
		t.Fatal(err)
	}
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook})
	if r.Code != proto.ScreenCodeNoScreen || !strings.Contains(r.Message, "Screen Sharing") {
		t.Fatalf("look: %+v", r)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: "alex", Password: "pw"}})
	if r.Code != proto.ScreenCodeNoScreen {
		t.Fatalf("account.set: %+v", r)
	}
	if st, _ := s.snapshot(); st.Sharing {
		t.Fatal("sharing must be false")
	}
}

func TestInput(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw")
	f.takeEvents()

	check := func(name string, req proto.ScreenRequest, want []string) {
		t.Helper()
		r := run(t, s, req)
		if !r.OK || r.ScreenW != 64 {
			t.Fatalf("%s: %+v", name, r)
		}
		var got []string
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			got = append(got, f.takeEvents()...)
			if len(got) >= len(want) {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("%s:\n got %q\nwant %q", name, got, want)
		}
	}
	check("click", proto.ScreenRequest{Op: proto.ScreenClick, X: 10, Y: 20},
		[]string{"ptr 0 10 20", "ptr 1 10 20", "ptr 0 10 20"})
	check("right double click", proto.ScreenRequest{Op: proto.ScreenClick, X: 3, Y: 4, Button: "right", Clicks: 2},
		[]string{"ptr 0 3 4", "ptr 4 3 4", "ptr 0 3 4", "ptr 4 3 4", "ptr 0 3 4"})
	check("type", proto.ScreenRequest{Op: proto.ScreenType, Text: "Hi!\nä€"},
		[]string{"key ffe1 1", "key 48 1", "key 48 0", "key ffe1 0", "key 69 1", "key 69 0",
			"key ffe1 1", "key 21 1", "key 21 0", "key ffe1 0", "key ff0d 1", "key ff0d 0",
			"key e4 1", "key e4 0", "key 10020ac 1", "key 10020ac 0"})
	check("keys", proto.ScreenRequest{Op: proto.ScreenKeys, Keys: "cmd+shift+4 tab"},
		[]string{"key ffeb 1", "key ffe1 1", "key 34 1", "key 34 0", "key ffe1 0", "key ffeb 0", "key ff09 1", "key ff09 0"})
	wheel := func(n int, mask, x, y string) []string {
		var out []string
		for i := 0; i < n*wheelPerStep; i++ {
			out = append(out, "ptr "+mask+" "+x+" "+y, "ptr 0 "+x+" "+y)
		}
		return out
	}
	check("scroll", proto.ScreenRequest{Op: proto.ScreenScroll, X: 5, Y: 6, DY: 2, DX: -1},
		slices.Concat([]string{"ptr 0 5 6"}, wheel(2, "16", "5", "6"), wheel(1, "32", "5", "6")))
	check("scroll in the middle", proto.ScreenRequest{Op: proto.ScreenScroll, DY: -1},
		slices.Concat([]string{"ptr 0 32 24"}, wheel(1, "8", "32", "24")))
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenDrag, X: 0, Y: 0, ToX: 12, ToY: 24})
	if !r.OK {
		t.Fatalf("drag: %+v", r)
	}
	time.Sleep(50 * time.Millisecond)
	ev := f.takeEvents()
	if len(ev) != 15 || ev[0] != "ptr 0 0 0" || ev[1] != "ptr 1 0 0" || ev[13] != "ptr 1 12 24" || ev[14] != "ptr 0 12 24" {
		t.Fatalf("drag events %q", ev)
	}

	for _, bad := range []proto.ScreenRequest{
		{Op: proto.ScreenClick, X: 64, Y: 0},
		{Op: proto.ScreenClick, X: -1, Y: 0},
		{Op: proto.ScreenClick, Button: "fourth"},
		{Op: proto.ScreenClick, Clicks: 4},
		{Op: proto.ScreenDrag, ToX: 100},
		{Op: proto.ScreenScroll},
		{Op: proto.ScreenScroll, DY: 51},
		{Op: proto.ScreenType},
		{Op: proto.ScreenType, Text: strings.Repeat("a", maxTypeRunes+1)},
		{Op: proto.ScreenKeys, Keys: "fn+q"},
		{Op: proto.ScreenKeys, Keys: "hyper+q"},
		{Op: proto.ScreenKeys, Keys: ""},
		{Op: "paint"},
	} {
		if r := run(t, s, bad); r.Code != "invalid_request" || r.OK {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("refused steps sent %q", ev)
	}
}

func TestBusy(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw")
	s.steps <- struct{}{} // another step runs
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenClick, X: 1, Y: 1})
	<-s.steps
	if r.Code != "busy" {
		t.Fatalf("%+v", r)
	}
}

// The account steps and unlock wait for a running step too: none of them
// may drop or replace the kept connection under it.
func TestAccountStepsWait(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw")
	s.steps <- struct{}{} // a step holds the screen
	for _, req := range []proto.ScreenRequest{
		{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: "alex", Password: "pw"}},
		{Op: proto.ScreenAccountCheck}, {Op: proto.ScreenAccountClear}, {Op: proto.ScreenUnlock},
	} {
		if r := run(t, s, req); r.Code != "busy" {
			t.Fatalf("%s: %+v", req.Op, r)
		}
	}
	<-s.steps
	if _, err := ReadAccount(s.dir); err != nil {
		t.Fatalf("the account went while a step ran: %v", err)
	}
}

// lockWindows is the window list while the screen is locked, as seen on a
// Mac (macOS 27): loginwindow's (619) windows over everything, the menu bar,
// the apps behind; others are put in front.
func lockWindows(front ...map[string]any) []map[string]any {
	return append(front,
		map[string]any{"number": 929, "layer": 2001, "alpha": 1, "x": -15000, "y": -15000, "w": 30000, "h": 30000, "pid": 619,
			"owner": "loginwindow", "bundle_id": "com.apple.loginwindow"},
		map[string]any{"number": 930, "layer": 2000, "alpha": 1, "x": 0, "y": 0, "w": 64, "h": 48, "pid": 619,
			"owner": "loginwindow", "bundle_id": "com.apple.loginwindow"},
		map[string]any{"number": 5, "layer": 24, "alpha": 1, "x": 0, "y": 0, "w": 64, "h": 2, "pid": 614, "owner": "Window Server"},
		map[string]any{"number": 51, "layer": 0, "alpha": 1, "x": 2, "y": 4, "w": 40, "h": 30, "pid": 2889, "owner": "Terminal",
			"bundle_id": "com.apple.Terminal"})
}

// lockHelper is the helper of the user at a locked screen, without
// Accessibility (so unlock goes through Screen Sharing): it lists the
// windows, with front in front of the lock screen, or none when gone.
type lockHelper struct {
	mu    sync.Mutex
	front []map[string]any
	gone  bool
}

func (h *lockHelper) answer(req map[string]any) map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case h.gone:
		return map[string]any{"ok": false, "code": "failed", "message": "gone"}
	case req["op"] == "status":
		return map[string]any{"ok": true, "version": "1.0.4", "ax": false, "locked": true, "user": "alex"}
	case req["op"] == "windows":
		return map[string]any{"ok": true, "windows": lockWindows(h.front...)}
	}
	return map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op"}
}

func TestUnlock(t *testing.T) {
	f := newFakeSharing(t, "alex", "Pw!")
	s := newTestScreen(t, f.addr())
	s.settle = 300 * time.Millisecond
	setAccount(t, s, "alex", "Pw!")
	shift := []string{"key ffe1 1", "key ffe1 0"}
	escape := []string{"key ff1b 1", "key ff1b 0"}
	password := []string{"key ffe1 1", "key 50 1", "key 50 0", "key ffe1 0", "key 77 1", "key 77 0",
		"key ffe1 1", "key 21 1", "key 21 0", "key ffe1 0", "key ff0d 1", "key ff0d 0"}
	try := slices.Concat(escape, password)
	// The lock screen's password field has the keyboard: Secure Event Input
	// is on for loginwindow (pid 619).
	paths := map[int]string{619: loginWindowPath, 400: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"}
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	// The user's helper says what is in front of the lock screen.
	lh := &lockHelper{}
	newFakeHelper(t, s.uiRoot, os.Getuid(), lh.answer)
	// opensAfter: the screen is locked until the password's Return came n times.
	opensAfter := func(n int) {
		s.sessions = func(context.Context) ([]consoleSession, error) {
			locked := n < 0 || f.seen("key ff0d 0") < n
			return []consoleSession{{User: "alex", UID: 501, OnConsole: true, LoggedIn: true, Locked: locked, SecureInputPID: 619}}, nil
		}
	}

	// Locked, and it stays locked: Escape and the password twice, then failed.
	opensAfter(-1)
	f.takeEvents()
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "twice") || r.Status == nil || r.Status.Locked == nil || !*r.Status.Locked {
		t.Fatalf("unlock: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, try, try); !slices.Equal(ev, want) {
		t.Fatalf("unlock typed\n%q\nwant\n%q", ev, want)
	}

	// The first password opens it. Typed through Screen Sharing (the helper
	// has no Accessibility here), it lasts only while the session does,
	// which stays open longer; the answer says so.
	opensAfter(1)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); !r.OK || !strings.Contains(r.Message, "5 minutes") || *r.Status.Locked {
		t.Fatalf("unlock: %+v", r)
	}
	if !s.connHolds {
		t.Fatal("the session that unlocked the screen isn't kept longer")
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, try); !slices.Equal(ev, want) {
		t.Fatalf("unlock typed\n%q\nwant\n%q", ev, want)
	}

	// The second does (the first letter was lost, say).
	opensAfter(2)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); !r.OK || *r.Status.Locked {
		t.Fatalf("unlock: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, try, try); !slices.Equal(ev, want) {
		t.Fatalf("unlock typed\n%q\nwant\n%q", ev, want)
	}

	// Not locked, the account's user at the screen (so the display is on:
	// its sleep sets the lock): nothing sent, never the password.
	opensAfter(0)
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if !r.OK || !strings.Contains(r.Message, "wasn't locked") {
		t.Fatalf("unlock when unlocked: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("typed into an unlocked screen: %q", ev)
	}

	// Woken within macOS's grace period: locked when the display wakes, open
	// a moment later by itself. Nothing is typed.
	checks := 0
	s.wakeWait = time.Second
	s.sessions = func(context.Context) ([]consoleSession, error) {
		checks++
		return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: checks < 4}}, nil
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if !r.OK || !strings.Contains(r.Message, "wasn't locked") || checks != 4 {
		t.Fatalf("grace: %+v after %d checks", r, checks)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("typed into a screen that opened by itself: %q", ev)
	}
	s.wakeWait = 10 * time.Millisecond

	// It opens between Escape and the password: nothing typed.
	s.sessions = func(context.Context) ([]consoleSession, error) {
		return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: f.seen("key ff1b 0") == 0, SecureInputPID: 619}}, nil
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); !r.OK {
		t.Fatalf("unlock: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, escape); !slices.Equal(ev, want) {
		t.Fatalf("typed after the screen opened\n%q\nwant\n%q", ev, want)
	}

	// The login window after a restart: no session at the screen, so
	// nothing says which field has the keyboard (it may ask for a name, or
	// show a list of people). Nothing typed, not even the Escape that
	// empties the field, and the answer says why.
	loginWindow := func(securePID int) {
		s.sessions = func(context.Context) ([]consoleSession, error) {
			return []consoleSession{{OnConsole: true, SecureInputPID: securePID}}, nil
		}
	}
	for _, pid := range []int{0, 619} {
		loginWindow(pid)
		r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
		if r.Code != "failed" || !strings.Contains(r.Message, "login window") || !strings.Contains(r.Message, "typed nothing") {
			t.Fatalf("login window, secure input %d: %+v", pid, r)
		}
		if ev := f.takeEvents(); !slices.Equal(ev, shift) {
			t.Fatalf("login window: sent %q", ev)
		}
	}
	// Another program's password field has the keyboard (a lookalike of the
	// lock screen): nothing typed.
	lockedWith := func(securePID int) {
		s.sessions = func(context.Context) ([]consoleSession, error) {
			return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: true, SecureInputPID: securePID}}, nil
		}
	}
	lockedWith(400)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" {
		t.Fatalf("another field: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("another field: sent %q", ev)
	}
	// Something in front of the lock screen: nothing typed.
	lockedWith(619)
	lh.mu.Lock()
	lh.front = []map[string]any{{"number": 990, "layer": 2500, "alpha": 1, "x": 0, "y": 0, "w": 64, "h": 48, "pid": 400,
		"owner": "Overlay", "bundle_id": "com.example.overlay"}}
	lh.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" || !strings.Contains(r.Message, "in front of the lock screen") {
		t.Fatalf("in front: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("in front: sent %q", ev)
	}
	// No helper to say what is in front: nothing typed.
	lh.mu.Lock()
	lh.front, lh.gone = nil, true
	lh.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" {
		t.Fatalf("no helper: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("no helper: sent %q", ev)
	}
	lh.mu.Lock()
	lh.gone = false
	lh.mu.Unlock()
	// loginwindow's path but not Apple's code: nothing typed.
	lockedWith(619)
	s.appleCode = func(context.Context, int) bool { return false }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" {
		t.Fatalf("not Apple's: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("not Apple's: sent %q", ev)
	}
	s.appleCode = func(context.Context, int) bool { return true }
	// The field loses the keyboard while the password is typed: no Return.
	s.sessions = func(context.Context) ([]consoleSession, error) {
		pid := 619
		if f.seen("key 21 0") > 0 {
			pid = 0
		}
		return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: true, SecureInputPID: pid}}, nil
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("lost: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, escape, password[:len(password)-2]); !slices.Equal(ev, want) {
		t.Fatalf("lost\n%q\nwant\n%q", ev, want)
	}
	// After the first character: nothing more.
	s.sessions = func(context.Context) ([]consoleSession, error) {
		pid := 619
		if f.seen("key 50 0") > 0 {
			pid = 0
		}
		return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: true, SecureInputPID: pid}}, nil
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("lost after one: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, escape, password[:4]); !slices.Equal(ev, want) {
		t.Fatalf("lost after one\n%q\nwant\n%q", ev, want)
	}
	// Another window comes in front of the lock screen while it is typed.
	lockedWith(619)
	lh.mu.Lock()
	lh.gone = false
	lh.mu.Unlock()
	coverAfter := "key 77 0"
	newHelper := func(req map[string]any) map[string]any {
		if req["op"] == "windows" && f.seen(coverAfter) > 0 {
			return map[string]any{"ok": true, "windows": lockWindows(map[string]any{"number": 991, "layer": 3000, "alpha": 1,
				"x": 0, "y": 0, "w": 64, "h": 48, "pid": 400, "owner": "Overlay"})}
		}
		return lh.answer(req)
	}
	s.helper.root = shortTempDir(t)
	newFakeHelper(t, s.helper.root, os.Getuid(), newHelper)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("covered: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(shift, escape, password[:6]); !slices.Equal(ev, want) {
		t.Fatalf("covered\n%q\nwant\n%q", ev, want)
	}

	// Nothing can tell whether it is locked (no session list, no helper):
	// nothing typed, failed.
	s.sessions = func(context.Context) ([]consoleSession, error) { return nil, errors.New("no ioreg") }
	s.helper.root = s.uiRoot
	lh.mu.Lock()
	lh.gone = true
	lh.mu.Unlock()
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "couldn't tell") && !strings.Contains(r.Message, "Couldn't tell") || r.Status.Locked != nil {
		t.Fatalf("unknown: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, shift) {
		t.Fatalf("unknown\n%q", ev)
	}
}

func TestConsole(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	if _, resp := s.Console(context.Background()); resp.OK || resp.Code != proto.ScreenCodeNoAccount {
		t.Fatalf("console without account: %+v", resp)
	}
	setAccount(t, s, "alex", "pw")
	sess, resp := s.Console(context.Background())
	if !resp.OK || resp.Resolution != "64x48" {
		t.Fatalf("console: %+v", resp)
	}
	in := make(chan wire.Frame, 16)
	outCh := make(chan wire.Frame, 64)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- sess.Run(ctx, in, func(f wire.Frame) error { outCh <- f; return nil }) }()
	var pending []byte
	read := func(n int) []byte {
		for len(pending) < n {
			select {
			case fr := <-outCh:
				if fr.Kind == wire.FrameData {
					pending = append(pending, fr.Payload...)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("timeout")
			}
		}
		b := pending[:n]
		pending = pending[n:]
		return b
	}
	send := func(b []byte) { in <- wire.Frame{Kind: wire.FrameData, Payload: b} }
	read(12)
	send([]byte("RFB 003.008\n"))
	if sec := read(2); sec[1] != 1 {
		t.Fatalf("the browser must see security None, got %v", sec)
	}
	send([]byte{1})
	read(4)
	send([]byte{1})
	si := read(24)
	if binary.BigEndian.Uint16(si[0:]) != 64 {
		t.Fatal("ServerInit not replayed")
	}
	read(int(binary.BigEndian.Uint32(si[20:])))
	// The browser asks for the screen through the relay.
	send([]byte{3, 0, 0, 0, 0, 0, 0, 64, 0, 48})
	hdr := read(16)
	if hdr[0] != 0 || binary.BigEndian.Uint16(hdr[8:]) != 64 {
		t.Fatalf("update %v", hdr)
	}
	read(64 * 48 * 4)
	close(in)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("console did not end")
	}

	f.setPassword("changed")
	if _, resp := s.Console(context.Background()); resp.Code != proto.ScreenCodeSignInFailed {
		t.Fatalf("console with a refused account: %+v", resp)
	}
}

func TestThumbnailAndDefault(t *testing.T) {
	if r := Thumbnail(context.Background(), proto.ThumbnailRequest{}); r.Code != "unsupported" {
		t.Fatalf("no default screen: %+v", r)
	}
	if _, r := Console(context.Background()); r.Code != "unsupported" {
		t.Fatalf("no default screen: %+v", r)
	}
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw")
	SetDefault(s)
	defer SetDefault(nil)
	r := Thumbnail(context.Background(), proto.ThumbnailRequest{Platform: proto.PlatformHost, GuestID: "host", MaxWidth: 16})
	if len(r.Image) == 0 || r.Width != 16 || r.Height != 12 {
		t.Fatalf("thumbnail: %+v", r.Code)
	}
	if _, err := jpeg.Decode(bytes.NewReader(r.Image)); err != nil {
		t.Fatal("thumbnails are JPEG by default")
	}
	r = Thumbnail(context.Background(), proto.ThumbnailRequest{Format: "png"})
	if _, err := png.Decode(bytes.NewReader(r.Image)); err != nil || r.Width != 64 {
		t.Fatal("screenshot: full size PNG")
	}
}

func TestStatusCachedAndCheap(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	clock := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	// The first status is read before the refresh it starts has anything to
	// show: the helper and the directory answer only once it was returned.
	// (Unheld, the refresh finished first on a busy machine.)
	first := make(chan struct{})
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), func(req map[string]any) map[string]any {
		<-first
		return map[string]any{"ok": true, "version": "1.0", "ax": true, "locked": false, "user": "alex",
			"displays": []map[string]any{{"id": 1, "x": 0, "y": 0, "w": 32, "h": 24, "scale": 2, "main": true}}}
	})
	if err := os.MkdirAll(filepath.Join(s.helperApp, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(s.helperApp, "Contents", "Info.plist"), []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.9</string></dict></plist>`), 0o644)
	if err := writeAccount(s.dir, Account{User: "alex", Password: "pw"}); err != nil {
		t.Fatal(err)
	}
	// The Mac's directory knows the password the fake Screen Sharing takes.
	var verifies int
	s.verify = func(_ context.Context, a Account) (bool, bool) {
		<-first
		verifies++
		f.mu.Lock()
		defer f.mu.Unlock()
		return a.User == f.user && a.Password == f.password, true
	}
	wait := func() {
		t.Helper()
		for end := time.Now().Add(10 * time.Second); s.refreshing.Load(); time.Sleep(5 * time.Millisecond) {
			if time.Now().After(end) {
				t.Fatal("the refresh didn't finish")
			}
		}
	}
	st, hp := s.Status(context.Background())
	close(first)
	if st.Account != "alex" || hp.Running || !hp.Installed || hp.Version != "0.9" {
		t.Fatalf("first status (before the refresh): %+v %+v", st, hp)
	}
	wait()
	st, hp = s.Status(context.Background())
	// The password is checked with the directory, so the screen's size
	// comes with the first step.
	if !st.Sharing || st.SignIn != "ok" || st.Width != 0 || st.Locked == nil || *st.Locked {
		t.Fatalf("status: %+v", st)
	}
	if !hp.Running || hp.Version != "1.0" || hp.Accessibility == nil || !*hp.Accessibility || hp.User != "alex" {
		t.Fatalf("helper: %+v", hp)
	}
	for i := 0; i < 5; i++ {
		s.Status(context.Background())
		wait()
	}
	if n := h.count("status"); n != 1 {
		t.Fatalf("helper asked %d times within 10 s", n)
	}
	if n, refused := f.counts(); n != 0 || refused != 0 || verifies != 1 {
		t.Fatalf("checking the account must not sign in to Screen Sharing: %d sign-ins, %d checks", n, verifies)
	}
	clock = clock.Add(11 * time.Second)
	s.Status(context.Background())
	wait()
	if n := h.count("status"); n != 2 {
		t.Fatalf("helper asked %d times after 11 s", n)
	}
	// Ten minutes on, the sign-in is checked again; a refusal shows.
	f.setPassword("changed")
	clock = clock.Add(10 * time.Minute)
	s.Status(context.Background())
	wait()
	st, _ = s.Status(context.Background())
	if st.SignIn != "failed" || verifies != 2 {
		t.Fatalf("sign-in after the password changed: %+v", st)
	}
	// Steps don't hammer a refused account: a minute's pause.
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); r.Code != proto.ScreenCodeSignInFailed {
		t.Fatalf("look after a refusal: %+v", r)
	}
	if n, refused := f.counts(); n != 0 || refused != 0 {
		t.Fatalf("tried Screen Sharing within the pause: %d %d", n, refused)
	}
	// A right password doesn't undo Screen Sharing's own refusal; a
	// sign-in that works does.
	f.setPassword("pw")
	clock = clock.Add(time.Hour)
	s.Status(context.Background())
	wait()
	if st, _ := s.snapshot(); st.SignIn != "failed" || verifies != 3 {
		t.Fatalf("after a right check: %+v", st)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); !r.OK {
		t.Fatalf("look: %+v", r)
	}
	if st, _ := s.snapshot(); st.SignIn != "ok" || st.Width != 64 {
		t.Fatalf("after a sign-in: %+v", st)
	}
	clock = clock.Add(2 * time.Minute)
	if _, hp := s.snapshot(); hp.Running {
		t.Fatal("a helper silent for a minute isn't running")
	}
	// The status step refreshes at once.
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenStatus})
	if !r.OK || r.Status == nil || r.Helper == nil || !r.Helper.Running {
		t.Fatalf("status step: %+v", r)
	}
}

func TestUnlockByHelper(t *testing.T) {
	f := newFakeSharing(t, "alex", "Pw!")
	s := newTestScreen(t, f.addr())
	s.settle = 300 * time.Millisecond
	setAccount(t, s, "alex", "Pw!")
	var mu sync.Mutex
	locked, ax, atScreen, version := true, true, "alex", "1.0.4"
	answer := map[string]any{"ok": true, "message": "typed"} // the helper's answer to unlock
	var passwords []string
	s.sessions = func(context.Context) ([]consoleSession, error) {
		mu.Lock()
		defer mu.Unlock()
		l := locked && f.seen("key ff0d 0") == 0
		return []consoleSession{{User: atScreen, UID: 501, OnConsole: true, LoggedIn: true, Locked: l, SecureInputPID: 619}}, nil
	}
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if pid == 619 {
			return loginWindowPath, nil
		}
		return "", errors.New("no such process")
	}
	newFakeHelper(t, s.uiRoot, os.Getuid(), func(req map[string]any) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		switch req["op"] {
		case "status":
			return map[string]any{"ok": true, "version": version, "ax": ax, "locked": locked, "user": atScreen}
		case "windows":
			return map[string]any{"ok": true, "windows": lockWindows()}
		case "unlock":
			passwords = append(passwords, req["password"].(string))
			if answer["ok"] == true {
				locked = false
			}
			return answer
		}
		return map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op"}
	})
	reset := func(a bool, user string, ans map[string]any) {
		mu.Lock()
		locked, ax, atScreen, answer, passwords, version = true, a, user, ans, nil, "1.0.4"
		mu.Unlock()
		f.takeEvents()
	}

	// A kept Screen Sharing session: it ends before the helper types (its
	// end would lock the screen again later).
	mu.Lock()
	locked = false
	mu.Unlock()
	run(t, s, proto.ScreenRequest{Op: proto.ScreenClick, X: 1, Y: 1})
	reset(true, "alex", map[string]any{"ok": true, "message": "typed"})
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if !r.OK || r.Message != "" || *r.Status.Locked {
		t.Fatalf("by the helper: %+v", r)
	}
	mu.Lock()
	if !slices.Equal(passwords, []string{"Pw!"}) {
		t.Fatalf("the helper got %q", passwords)
	}
	mu.Unlock()
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("Screen Sharing typed too: %q", ev)
	}
	if s.conn != nil || s.connHolds {
		t.Fatal("a Screen Sharing session stays open across the helper's unlock")
	}

	// It opened by itself (woken within macOS's grace period): nothing typed.
	reset(true, "alex", map[string]any{"ok": true, "message": "opened by itself"})
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock}); !r.OK || !strings.Contains(r.Message, "wasn't locked") {
		t.Fatalf("opened by itself: %+v", r)
	}

	// Screen Sharing types it when the helper can't: a helper that doesn't
	// check each key it sends (before 1.0.4: it never gets the password), one
	// whose unlock fails, one without Accessibility, someone else at the
	// screen (whose session never gets the password).
	for _, c := range []struct {
		name    string
		version string
		ax      bool
		user    string
		answer  map[string]any
		asked   int
	}{
		{"helper 1.0.3", "1.0.3", true, "alex", map[string]any{"ok": true, "message": "typed"}, 0},
		{"helper 1.0.1", "1.0.1", true, "alex", map[string]any{"ok": true, "message": "typed"}, 0},
		{"a helper's own build", "dev", true, "alex", map[string]any{"ok": true, "message": "typed"}, 0},
		{"unlock refused", "1.0.4", true, "alex", map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op unlock"}, 1},
		{"helper failed", "1.0.5", true, "alex", map[string]any{"ok": false, "code": "failed", "message": "no focus"}, 1},
		{"no Accessibility", "1.0.5", false, "alex", map[string]any{"ok": true, "message": "typed"}, 0},
		{"someone else", "1.0.5", true, "mara", map[string]any{"ok": true, "message": "typed"}, 0},
	} {
		reset(c.ax, c.user, c.answer)
		mu.Lock()
		version = c.version
		mu.Unlock()
		r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
		if !r.OK || !strings.Contains(r.Message, "Screen Sharing") {
			t.Fatalf("%s: %+v", c.name, r)
		}
		mu.Lock()
		if len(passwords) != c.asked {
			t.Fatalf("%s: the helper got %d passwords", c.name, len(passwords))
		}
		mu.Unlock()
		if ev := f.takeEvents(); len(ev) == 0 || ev[0] != "key ffe1 1" {
			t.Fatalf("%s: Screen Sharing sent %q", c.name, ev)
		}
	}
}
