package screen

import (
	"context"
	"errors"
	"maps"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// The window server's furniture as seen on a Mac (macOS 27): Screen Sharing's
// indicators at the pointer's level, the menu bar, Notification Centre's and
// the Dock's full-screen windows.
var furnitureWindows = []map[string]any{
	{"number": 475, "layer": 2147483630, "alpha": 1, "x": 180, "y": 0, "w": 14, "h": 14, "pid": 614, "owner": "Window Server"},
	{"number": 5, "layer": 24, "alpha": 1, "x": 0, "y": 0, "w": 200, "h": 12, "pid": 614, "owner": "Window Server"},
	{"number": 14, "layer": 23, "alpha": 1, "x": 0, "y": 0, "w": 200, "h": 150, "pid": 1124, "owner": "Notification Centre",
		"bundle_id": "com.apple.notificationcenterui"},
	{"number": 25, "layer": 20, "alpha": 1, "x": 0, "y": 0, "w": 200, "h": 150, "pid": 1386, "owner": "Dock", "bundle_id": "com.apple.dock"},
}

// applePaths are the executables of furnitureWindows' processes as the
// kernel names them.
var applePaths = map[int]string{
	614:  "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer",
	1124: "/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter",
	1386: "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock",
}

// blindPrompt is a macOS prompt as a helper without Accessibility shows it:
// only in the window list.
type blindPrompt struct {
	mu        sync.Mutex
	old       bool           // a helper before 1.0.2: no windows op
	up        bool           // the prompt is on the screen
	window    map[string]any // the prompt's window
	app       map[string]any // its app as `apps` says it
	front     bool           // its app is the frontmost
	focusable bool           // the helper's focus makes it the frontmost
	focused   int            // how often focus was asked
	accepts   bool           // Return with the password closes it
	// coverAfterReturn: another app comes in front after Return.
	coverAfterReturn bool
	above            []map[string]any
	behind           []map[string]any
	// secure is the process with Secure Event Input on while the prompt
	// has the keyboard (0: the prompt's own); once Screen Sharing got the
	// key event loseAfter, no field has it.
	secure    int
	loseAfter string
	// moveAfter: once Screen Sharing got this key event, the prompt's
	// window is somewhere else (another window in its place).
	moveAfter string
}

// keyboard updates the prompt from the keys Screen Sharing got and says
// whether it is up, has the keyboard, and whether another app covers it.
// Called with p.mu held.
func (p *blindPrompt) keyboard(f *fakeSharing) (up, front, covering bool) {
	returned := f.seen("key ff0d 0") > 0
	if p.up && p.accepts && returned {
		p.up = false
	}
	covering = p.coverAfterReturn && returned
	return p.up, p.up && p.front && !covering, covering
}

// blindSessions is the Mac's session list with alex at the screen: Secure
// Event Input is on for the prompt while it has the keyboard.
func blindSessions(f *fakeSharing, p *blindPrompt) func(context.Context) ([]consoleSession, error) {
	return func(context.Context) ([]consoleSession, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		_, front, _ := p.keyboard(f)
		pid := 0
		if front {
			pid = p.secure
			if pid == 0 {
				pid = toInt(p.window["pid"])
			}
		}
		if p.loseAfter != "" && f.seen(p.loseAfter) > 0 {
			pid = 0
		}
		return []consoleSession{{User: "alex", UID: 501, OnConsole: true, LoggedIn: true, SecureInputPID: pid}}, nil
	}
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	}
	return 0
}

func blindHelper(f *fakeSharing, p *blindPrompt) func(map[string]any) map[string]any {
	return func(req map[string]any) map[string]any {
		p.mu.Lock()
		defer p.mu.Unlock()
		_, _, covering := p.keyboard(f)
		finder := map[string]any{"number": 800, "layer": 0, "alpha": 1, "x": 0, "y": 15, "w": 190, "h": 130, "pid": 400,
			"owner": "Finder", "bundle_id": "com.apple.finder"}
		switch req["op"] {
		case "status":
			version := "1.0.2"
			if p.old {
				version = "1.0.1"
			}
			return map[string]any{"ok": true, "version": version, "ax": false, "locked": false, "user": "alex",
				"displays": []map[string]any{{"id": 1, "x": 0, "y": 0, "w": 200, "h": 150, "scale": 2, "main": true}}}
		case "windows":
			if p.old {
				return map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op windows"}
			}
			wins := slices.Concat(p.above, furnitureWindows)
			if covering {
				wins = append([]map[string]any{finder}, wins...)
			}
			if p.up {
				w := p.window
				if p.moveAfter != "" && f.seen(p.moveAfter) > 0 {
					w = maps.Clone(w)
					w["x"] = toInt(w["x"]) + 30
				}
				wins = append(wins, w)
			}
			wins = append(wins, p.behind...)
			wins = append(wins, map[string]any{"number": 48, "layer": 0, "alpha": 1, "x": 0, "y": 15, "w": 150, "h": 100,
				"pid": 400, "owner": "Finder", "bundle_id": "com.apple.finder"})
			return map[string]any{"ok": true, "windows": wins, "truncated": false}
		case "apps":
			front := map[string]any{"name": "Finder", "bundle_id": "com.apple.finder", "pid": 400, "active": true}
			if p.up && p.front && !covering {
				front = p.app
			}
			return map[string]any{"ok": true, "apps": []map[string]any{front}}
		case "focus":
			p.focused++
			if req["app"] == p.window["bundle_id"] && p.focusable {
				p.front = true
			}
			return map[string]any{"ok": true}
		}
		return map[string]any{"ok": false, "code": "invalid_request", "message": "unexpected"}
	}
}

func securityAgentPrompt() (map[string]any, map[string]any) {
	return map[string]any{"number": 492, "layer": 1000, "alpha": 1, "x": 50, "y": 20, "w": 120, "h": 110, "pid": 77,
			"owner": "SecurityAgent", "bundle_id": "com.apple.SecurityAgent", "path": securityAgentPath},
		map[string]any{"name": "SecurityAgent", "bundle_id": "com.apple.SecurityAgent", "pid": 77, "active": true}
}

// blindScreen is a Screen whose helper has no Accessibility, with "alex" at
// the screen and as the screen account.
func blindScreen(t *testing.T) (*fakeSharing, *Screen, *blindPrompt, map[int]string) {
	t.Helper()
	f := newFakeSharing(t, "alex", "Pw!")
	f.mu.Lock()
	f.w, f.h = 400, 300
	f.mu.Unlock()
	s := newTestScreen(t, f.addr())
	s.promptWait = 300 * time.Millisecond
	setAccount(t, s, "alex", "Pw!")
	paths := maps.Clone(applePaths)
	maps.Copy(paths, map[int]string{77: securityAgentPath, 300: settingsApp, 400: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"})
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	s.isAdmin = func(_ context.Context, user string) (bool, error) { return user == "alex", nil }
	s.paneSheet = func(context.Context, int, string) (paneSheet, error) { return paneSheet{}, nil }
	w, app := securityAgentPrompt()
	p := &blindPrompt{up: true, window: w, app: app, front: true, accepts: true}
	s.sessions = blindSessions(f, p)
	newFakeHelper(t, s.uiRoot, os.Getuid(), blindHelper(f, p))
	f.takeEvents()
	return f, s, p, paths
}

var (
	// Command-A, Delete: the field emptied.
	blindClear = []string{"key ffeb 1", "key 61 1", "key 61 0", "key ffeb 0", "key ff08 1", "key ff08 0"}
	// A Shift tap readying the session.
	blindReady = []string{"key ffe1 1", "key ffe1 0"}
	// Ready, a letter for macOS to drop, the field emptied, "Pw!" and Return.
	blindTyped = slices.Concat(blindReady, []string{"key 78 1", "key 78 0"}, blindClear, []string{"key ffe1 1", "key 50 1",
		"key 50 0", "key ffe1 0", "key 77 1", "key 77 0", "key ffe1 1", "key 21 1", "key 21 0", "key ffe1 0", "key ff0d 1", "key ff0d 0"})
)

func setPrompt(p *blindPrompt, fn func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fn()
}

func TestPasswordWithoutAccessibility(t *testing.T) {
	f, s, p, _ := blindScreen(t)
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if !r.OK || r.Element == nil || r.Element.App != "SecurityAgent" || r.Element.X != 100 || r.Element.W != 240 {
		t.Fatalf("password: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindTyped) {
		t.Fatalf("sent %q", ev)
	}
	p.mu.Lock()
	up := p.up
	p.mu.Unlock()
	if up {
		t.Fatal("the prompt didn't take the password")
	}

	// Nothing up: no click, no keys.
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("no prompt: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("without a prompt: %q", ev)
	}
}

func TestPasswordWithoutAccessibilityOwners(t *testing.T) {
	f, s, p, paths := blindScreen(t)
	for _, c := range []struct{ bundle, path string }{
		{"com.apple.LocalAuthentication.UIAgent", "/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha"},
		{"com.apple.tcc.AuthorizationPromptService", "/System/Library/PrivateFrameworks/TCC.framework/Support/AuthorizationPromptService.app/Contents/MacOS/AuthorizationPromptService"},
	} {
		paths[88] = c.path
		setPrompt(p, func() {
			p.up = true
			p.window = map[string]any{"number": 600, "layer": 8, "alpha": 1, "x": 50, "y": 20, "w": 120, "h": 110, "pid": 88,
				"owner": "Prompt", "bundle_id": c.bundle}
			p.app = map[string]any{"name": "Prompt", "bundle_id": c.bundle, "pid": 88, "active": true}
		})
		if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK || r.Element.App != "Prompt" {
			t.Fatalf("%s: %+v", c.bundle, r)
		}
		if ev := f.takeEvents(); !slices.Equal(ev, blindTyped) {
			t.Fatalf("%s sent %q", c.bundle, ev)
		}
	}

	// A lookalike: SecurityAgent's bundle id, an executable outside /System.
	paths[88] = "/Applications/Lookalike.app/Contents/MacOS/SecurityAgent"
	setPrompt(p, func() {
		p.up = true
		p.window["bundle_id"] = "com.apple.SecurityAgent"
	})
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("lookalike: %+v", r)
	}
	// An ordinary app in front of the prompt.
	w, app := securityAgentPrompt()
	setPrompt(p, func() {
		p.window, p.app = w, app
		p.above = []map[string]any{{"number": 700, "layer": 0, "alpha": 1, "x": 0, "y": 15, "w": 190, "h": 130, "pid": 400,
			"owner": "Finder", "bundle_id": "com.apple.finder"}}
	})
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("behind an app: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("typed into something else: %q", ev)
	}
}

func TestPasswordWithoutAccessibilitySettings(t *testing.T) {
	f, s, p, _ := blindScreen(t)
	busy := false
	s.paneSheet = func(_ context.Context, uid int, pane string) (paneSheet, error) {
		if pane != privacyPane {
			t.Errorf("pane %q", pane)
		}
		return paneSheet{busy: busy, pids: []int{4242}}, nil
	}
	main := map[string]any{"number": 525, "layer": 0, "alpha": 1, "x": 20, "y": 10, "w": 175, "h": 135, "pid": 300,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	sheet := map[string]any{"number": 545, "layer": 0, "alpha": 1, "x": 50, "y": 20, "w": 120, "h": 110, "pid": 300,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	setPrompt(p, func() {
		p.window, p.behind = sheet, []map[string]any{main}
		p.app = map[string]any{"name": "System Settings", "bundle_id": settingsBundleID, "pid": 300, "active": true}
	})
	// A sheet of System Settings' while the Privacy & Security pane isn't
	// asking for a password (a Wi-Fi password's, a new user's): not ours.
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("other sheet: %+v", r)
	}
	busy = true
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK || r.Element.App != "System Settings" {
		t.Fatalf("privacy sheet: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindTyped) {
		t.Fatalf("sent %q", ev)
	}
	// The sheet's field may be held by LocalAuthentication's view service
	// busy for the pane; any other process's secure field isn't the sheet's.
	setPrompt(p, func() { p.up, p.secure = true, 4242 })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK {
		t.Fatalf("held by the view service: %+v", r)
	}
	f.takeEvents()
	setPrompt(p, func() { p.up, p.secure = true, 999 })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("another field: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindReady) {
		t.Fatalf("another field: sent %q", ev)
	}
	setPrompt(p, func() { p.secure = 0 })
	// System Settings' own window in front (no sheet): not a prompt.
	setPrompt(p, func() {
		p.up, p.window, p.behind = true, main, nil
	})
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("no sheet: %+v", r)
	}
}

func TestPasswordWithoutAccessibilityRefusals(t *testing.T) {
	f, s, p, _ := blindScreen(t)

	// Not an administrator: macOS wouldn't fill in the name. Its own code,
	// not no_access: switching Accessibility on needs this very prompt.
	s.isAdmin = func(context.Context, string) (bool, error) { return false, nil }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNotAdmin || !strings.Contains(r.Message, "administrator") {
		t.Fatalf("not an admin: %+v", r)
	}
	s.isAdmin = func(context.Context, string) (bool, error) { return false, errors.New("dsmemberutil: User not found") }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "administrator") {
		t.Fatalf("admin unknown: %+v", r)
	}
	s.isAdmin = func(context.Context, string) (bool, error) { return true, nil }
	// Someone else at the screen: the stored password isn't theirs.
	blind := s.sessions
	s.sessions = func(context.Context) ([]consoleSession, error) {
		return []consoleSession{{User: "sam", UID: 502, OnConsole: true, LoggedIn: true}}, nil
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "alex") {
		t.Fatalf("someone else: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("refused but sent %q", ev)
	}
	s.sessions = func(ctx context.Context) ([]consoleSession, error) {
		l, err := blind(ctx)
		l[0].User = "Alex"
		return l, err
	}

	// Another app has the keyboard and the prompt's can't be brought
	// forward: nothing typed.
	setPrompt(p, func() { p.front = false })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("no keyboard: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindReady) {
		t.Fatalf("typed without the keyboard: %q", ev)
	}
	// It can: the helper brings it forward, then the password goes in.
	setPrompt(p, func() { p.focusable = true })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK {
		t.Fatalf("brought forward: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindTyped) {
		t.Fatalf("brought forward sent %q", ev)
	}
	p.mu.Lock()
	focused := p.focused
	p.mu.Unlock()
	if focused != 2 {
		t.Fatalf("focus asked %d times", focused)
	}

	// The prompt stays (a refused password): typed once, then whatever took
	// the keys is emptied.
	setPrompt(p, func() { p.up, p.accepts = true, false })
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "emptied") {
		t.Fatalf("refused: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, slices.Concat(blindTyped, blindClear)) {
		t.Fatalf("refused sent %q", ev)
	}

	// A helper before 1.0.2 can't list windows: as before, no access.
	setPrompt(p, func() { p.old = true })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoAccess || !strings.Contains(r.Message, "Accessibility") {
		t.Fatalf("old helper: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("old helper sent %q", ev)
	}
}

func TestPasswordWithoutAccessibilityLeftAlone(t *testing.T) {
	// The prompt stays but another app came in front meanwhile: no keys go
	// to it.
	f, s, p, _ := blindScreen(t)
	setPrompt(p, func() { p.accepts, p.coverAfterReturn = false, true })
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != "failed" || !strings.Contains(r.Message, "left it alone") {
		t.Fatalf("left alone: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindTyped) {
		t.Fatalf("sent %q", ev)
	}
}

func TestPromptWindowParts(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	ctx := context.Background()
	// macOS's own furniture (Window Server, Notification Centre, the Dock;
	// executables under /System, Apple's code) and another app's.
	paths := maps.Clone(applePaths)
	paths[2000] = "/Applications/Menu Thing.app/Contents/MacOS/Menu Thing"
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	// Furniture is skipped; the first window someone works in is in front.
	wins := []helperWindow{
		{Number: 1, Layer: cursorLayer, Alpha: 1, W: 28, H: 28, PID: 614},
		{Number: 2, Layer: 25, Alpha: 1, W: 315, H: 93, PID: 614},
		{Number: 3, Layer: 24, Alpha: 1, W: 1920, H: 30, PID: 614},
		{Number: 4, Layer: 23, Alpha: 1, W: 1920, H: 1080, PID: 1124},
		{Number: 5, Layer: 20, Alpha: 1, W: 1920, H: 1080, PID: 1386},
		{Number: 6, Layer: 0, Alpha: 0, W: 500, H: 500, PID: 1386},
		{Number: 7, Layer: 0, Alpha: 1, W: 10, H: 500, PID: 1386},
		{Number: 8, Layer: 0, Alpha: 1, X: 1133, Y: 358, W: 260, H: 337, PID: 9},
		{Number: 9, Layer: 0, Alpha: 1, X: 893, Y: 214, W: 740, H: 625, PID: 9},
		{Number: 10, Layer: 0, Alpha: 1, X: 0, Y: 30, W: 580, H: 385, PID: 10},
	}
	if f := s.frontWindow(ctx, wins); f == nil || f.Number != 8 {
		t.Fatalf("front: %+v", f)
	}
	if !sheetOf(wins[7], wins) || sheetOf(wins[8], wins) || sheetOf(wins[9], wins) {
		t.Fatal("sheets")
	}
	// Another app's menu bar icon (a window at the menu bar's level) that
	// covers nothing of the window in front is passed over.
	icon := helperWindow{Number: 30, Layer: 25, Alpha: 1, X: 1500, Y: 0, W: 24, H: 24, PID: 2000}
	if f := s.frontWindow(ctx, append([]helperWindow{icon}, wins...)); f == nil || f.Number != 8 {
		t.Fatalf("an icon elsewhere: %+v", f)
	}
	// Another app's window at those levels, transparent or a sliver, over
	// the window in front: it is in front.
	for _, w := range []helperWindow{
		{Number: 31, Layer: 25, Alpha: 1, X: 1100, Y: 300, W: 400, H: 400, PID: 2000},
		{Number: 32, Layer: 0, Alpha: 0, X: 1100, Y: 300, W: 400, H: 400, PID: 2000},
		{Number: 33, Layer: 0, Alpha: 1, X: 1140, Y: 360, W: 10, H: 300, PID: 2000},
		{Number: 34, Layer: cursorLayer, Alpha: 1, X: 1140, Y: 360, W: 300, H: 300, PID: 2000},
	} {
		if f := s.frontWindow(ctx, append([]helperWindow{w}, wins...)); f == nil || f.Number != w.Number {
			t.Fatalf("window %d over the prompt: front %+v", w.Number, f)
		}
	}
	// The same from macOS's own process with another signature: in front.
	s.appleCode = func(_ context.Context, pid int) bool { return pid != 1124 }
	if f := s.frontWindow(ctx, wins); f == nil || f.Number != 4 {
		t.Fatalf("not Apple's code: %+v", f)
	}
	s.appleCode = func(context.Context, int) bool { return true }

	// launchctl procinfo of LocalAuthentication's view service, as macOS 27
	// prints it (shortened), with the sheet up and after it went.
	up := `program path = ` + laRemoteService + `
bsd proc info = {
	pid = 4242
	status = stopped
}
responsible pid = 4200
responsible path = ` + privacyPane + `
pressured exit info = {
	dirty state tracked = 1
	dirty = 1
	pressured-exit capable = 1
}
jetsam priority = 40
jetsam state = tracked,idle-exit,dirty`
	if r, d := procinfo(up); r != privacyPane || !d {
		t.Fatalf("up: %q %v", r, d)
	}
	gone := strings.Replace(up, "\tdirty = 1", "\tdirty = 0", 1)
	if _, d := procinfo(gone); d {
		t.Fatal("gone: still dirty")
	}
	ps := "    1     0 /sbin/launchd\n 4242   501 " + laRemoteService + "\n 4243   502 " + laRemoteService +
		"\n 4244   501 /System/Applications/System Settings.app/Contents/MacOS/System Settings\n"
	if got := psProcesses(ps, 501, laRemoteService); !slices.Equal(got, []psProcess{{4242, laRemoteService}}) {
		t.Fatalf("services: %v", got)
	}
	if got := psProcesses(ps, 501, laRemoteService, settingsApp); len(got) != 2 || got[1].pid != 4244 {
		t.Fatalf("services and the app: %v", got)
	}
}

func TestSettleSharing(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	var mu sync.Mutex
	calls, old := 0, false
	// Screen Sharing's bubble fading in and growing, as the window list
	// showed it on a Mac 0.75 s after a new session signed in.
	steps := []map[string]any{
		{"alpha": 0.16, "w": 52, "h": 16}, {"alpha": 0.84, "w": 266, "h": 79}, {"alpha": 1, "w": 319, "h": 96},
		{"alpha": 1, "w": 315, "h": 93}, {"alpha": 1, "w": 315, "h": 93},
	}
	newFakeHelper(t, s.uiRoot, os.Getuid(), func(req map[string]any) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		if old {
			return map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op windows"}
		}
		b := steps[min(calls, len(steps)-1)]
		calls++
		return map[string]any{"ok": true, "windows": []map[string]any{{"number": 650, "layer": 25, "alpha": b["alpha"],
			"x": 1426, "y": 26, "w": b["w"], "h": b["h"], "pid": 900, "owner": "SSMenuAgent", "bundle_id": ssMenuAgent}}}
	})
	uid := os.Getuid()
	s.sharingSettle, s.sharingSettleMax = 0, 5*time.Second
	if err := s.waitSettled(context.Background(), uid, time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	looks := func() int {
		mu.Lock()
		defer mu.Unlock()
		n := calls
		calls = 0
		return n
	}
	if n := looks(); n != len(steps) {
		t.Fatalf("returned after %d looks, want %d (shown in full, twice alike)", n, len(steps))
	}
	// Tapped longer ago than the most it waits: no look at all.
	if err := s.waitSettled(context.Background(), uid, time.Now().Add(-time.Minute), time.Now().Add(-time.Minute)); err != nil || looks() != 0 {
		t.Fatalf("waited long enough: %v", err)
	}
	// A kept session waits for its tap all the same.
	s.inputSettle = 50 * time.Millisecond
	start := time.Now()
	if err := s.waitSettled(context.Background(), uid, start.Add(-time.Minute), start); err != nil || time.Since(start) < s.inputSettle {
		t.Fatalf("kept session: %v after %v", err, time.Since(start))
	}
	looks()
	// A helper without windows: only the session's age counts.
	mu.Lock()
	old = true
	mu.Unlock()
	s.sharingSettle, s.inputSettle = 50*time.Millisecond, 0
	start = time.Now()
	if err := s.waitSettled(context.Background(), uid, start, start); err != nil || time.Since(start) < s.sharingSettle {
		t.Fatalf("old helper: %v after %v", err, time.Since(start))
	}
}

// The keyboard is checked before each part of the password: no secure field
// of the prompt's, nothing typed; lost before Return, nothing more and no
// Return.
func TestPasswordWithoutAccessibilityKeyboard(t *testing.T) {
	f, s, p, _ := blindScreen(t)
	setPrompt(p, func() { p.secure = 400 }) // Finder's field (a lookalike) has it
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("Finder's field: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, blindReady) {
		t.Fatalf("Finder's field: sent %q", ev)
	}
	// Lost after the dropped letter: nothing of the password goes.
	setPrompt(p, func() { p.secure, p.loseAfter = 0, "key 78 0" })
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("lost after the letter: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, slices.Concat(blindReady, []string{"key 78 1", "key 78 0"})) {
		t.Fatalf("lost after the letter: sent %q", ev)
	}
	// Lost while the password was typed: no Return, and nothing to empty
	// it with (the field no longer has the keyboard).
	setPrompt(p, func() { p.loseAfter = "key 21 0" })
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("lost before Return: %+v", r)
	}
	ev := f.takeEvents()
	if want := blindTyped[:len(blindTyped)-2]; !slices.Equal(ev, want) {
		t.Fatalf("lost before Return: sent %q, want %q", ev, want)
	}
}

// Without Accessibility the prompt's window must stay the one in front,
// unchanged, before every key; and System Settings' sheet must still be the
// password sheet (LocalAuthentication busy for the pane).
func TestPasswordWithoutAccessibilityEachKey(t *testing.T) {
	f, s, p, _ := blindScreen(t)
	// Ready, the letter, Command-A, Delete and the first character.
	firstChar := blindTyped[:14]
	setPrompt(p, func() { p.moveAfter = "key 50 0" })
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("moved: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, firstChar) {
		t.Fatalf("moved: sent %q, want %q", ev, firstChar)
	}

	// System Settings' sheet: the pane stops asking after the first
	// character (another sheet took its place).
	f, s, p, _ = blindScreen(t)
	main := map[string]any{"number": 525, "layer": 0, "alpha": 1, "x": 20, "y": 10, "w": 175, "h": 135, "pid": 300,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	sheet := map[string]any{"number": 545, "layer": 0, "alpha": 1, "x": 50, "y": 20, "w": 120, "h": 110, "pid": 300,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	setPrompt(p, func() {
		p.window, p.behind = sheet, []map[string]any{main}
		p.app = map[string]any{"name": "System Settings", "bundle_id": settingsBundleID, "pid": 300, "active": true}
	})
	asked := 0
	s.paneSheet = func(context.Context, int, string) (paneSheet, error) {
		asked++
		return paneSheet{busy: f.seen("key 50 0") == 0}, nil
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
		t.Fatalf("pane stopped asking: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, firstChar) {
		t.Fatalf("pane stopped asking: sent %q, want %q", ev, firstChar)
	}
	// Found once, then before the letter, Command-A, Delete, the first
	// character, the second (which stops it) and the emptying (refused).
	if asked != 7 {
		t.Fatalf("asked about the pane %d times", asked)
	}
}
