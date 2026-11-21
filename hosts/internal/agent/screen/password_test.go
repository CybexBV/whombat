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

// promptState is a macOS password prompt as the fake helper shows it.
type promptState struct {
	mu        sync.Mutex
	up        bool // SecurityAgent shows its prompt
	clickable bool // a click into the field gives it the keyboard focus
	accepts   bool // Return with the password closes it
	ax        bool
	version   string // the helper's ("1.0.5" when empty)
	// notSecure: the focused element isn't a password field; outside: it is
	// one, but outside the prompt's window.
	notSecure, outside bool
	// noToken: helper 1.0.5 names the focused field without its token.
	noToken bool
	// otherAfter: once Screen Sharing got this key event, another password
	// field of the prompt's process in its window has the focus (another
	// place, another token); newAfter: a new field in the same place (only
	// its token tells); windowAfter: the prompt's window is a new one.
	otherAfter, newAfter, windowAfter string
	// moveAfter: once Screen Sharing got this key event, another app (an
	// editor) takes the keyboard.
	moveAfter string
	// lock: the lock screen is up (loginwindow's windows in front).
	lock bool
}

// state updates the prompt from the events Screen Sharing got and says
// whether its field has the keyboard. Called with p.mu held.
func (p *promptState) state(f *fakeSharing) (focused bool) {
	// The field is at (10, 8) points, 8×2: (20, 16) 16×4 pixels on the
	// 64×48 framebuffer, its middle (28, 18).
	focused = p.up && p.clickable && f.seen("ptr 1 28 18") > 0
	if p.up && p.accepts && f.seen("key ff0d 0") > 0 {
		p.up = false
		focused = false
	}
	if p.moveAfter != "" && f.seen(p.moveAfter) > 0 {
		focused = false
	}
	return focused
}

// promptSessions is the session list with alex at the screen and Secure
// Event Input on for SecurityAgent while its field has the keyboard.
func promptSessions(f *fakeSharing, p *promptState) func(context.Context) ([]consoleSession, error) {
	return func(context.Context) ([]consoleSession, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		pid := 0
		if p.state(f) {
			pid = 77
		}
		return []consoleSession{{User: "alex", UID: 501, OnConsole: true, LoggedIn: true, SecureInputPID: pid}}, nil
	}
}

const securityAgentPath = "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent"

func promptHelper(f *fakeSharing, p *promptState) func(map[string]any) map[string]any {
	return func(req map[string]any) map[string]any {
		p.mu.Lock()
		defer p.mu.Unlock()
		focused := p.state(f)
		field := map[string]any{"id": "w0.0.4", "role": "AXTextField", "subrole": "AXSecureTextField", "enabled": true,
			"focused": focused, "x": 10, "y": 8, "w": 8, "h": 2, "app": "SecurityAgent", "window": "Untitled"}
		version := p.version
		if version == "" {
			version = "1.0.5"
		}
		after := func(ev string) bool { return ev != "" && f.seen(ev) > 0 }
		// SecurityAgent's window holds the field; an editor's comes in front
		// when it takes the keyboard.
		prompt := map[string]any{"number": 492, "layer": 1000, "alpha": 1, "x": 2, "y": 2, "w": 26, "h": 20, "pid": 77,
			"owner": "SecurityAgent", "bundle_id": "com.apple.SecurityAgent"}
		if after(p.windowAfter) {
			prompt = maps.Clone(prompt)
			prompt["number"] = 493
		}
		editor := map[string]any{"number": 900, "layer": 0, "alpha": 1, "x": 0, "y": 0, "w": 30, "h": 22, "pid": 500,
			"owner": "TextEdit", "bundle_id": "com.apple.TextEdit"}
		switch req["op"] {
		case "status":
			return map[string]any{"ok": true, "version": version, "ax": p.ax, "locked": false, "user": "alex",
				"displays": []map[string]any{{"id": 1, "x": 0, "y": 0, "w": 32, "h": 24, "scale": 2, "main": true}}}
		case "focused":
			if version < "1.0.3" {
				break
			}
			if !focused {
				return map[string]any{"ok": true, "pid": 400, "bundle_id": "com.apple.finder",
					"element": map[string]any{"id": "focused", "role": "AXTextField", "enabled": true, "focused": true}}
			}
			el := maps.Clone(field)
			el["id"] = "focused"
			if version >= "1.0.5" && !p.noToken {
				el["token"] = "5f3a"
				if after(p.newAfter) {
					el["token"] = "77c1"
				}
			}
			if after(p.otherAfter) {
				el["y"], el["token"] = 12, "9b20"
			}
			if p.notSecure {
				el = map[string]any{"id": "focused", "role": "AXTextField", "enabled": true, "focused": true}
			}
			if p.outside {
				el = map[string]any{"id": "focused", "role": "AXTextField", "subrole": "AXSecureTextField", "enabled": true,
					"focused": true, "x": 40, "y": 8, "w": 8, "h": 2}
			}
			return map[string]any{"ok": true, "pid": 77, "bundle_id": "com.apple.SecurityAgent", "element": el}
		case "windows":
			if version < "1.0.2" {
				break
			}
			if p.lock {
				return map[string]any{"ok": true, "windows": lockWindows()}
			}
			var wins []map[string]any
			if p.moveAfter != "" && f.seen(p.moveAfter) > 0 {
				wins = append(wins, editor)
			}
			if p.up {
				wins = append(wins, prompt)
			}
			return map[string]any{"ok": true, "windows": append(wins, map[string]any{"number": 48, "layer": 0, "alpha": 1,
				"x": 0, "y": 0, "w": 32, "h": 24, "pid": 400, "owner": "Finder", "bundle_id": "com.apple.finder"})}
		case "apps":
			front := map[string]any{"name": "Finder", "bundle_id": "com.apple.finder", "pid": 400, "active": true}
			if focused {
				front = map[string]any{"name": "SecurityAgent", "bundle_id": "com.apple.SecurityAgent", "pid": 77, "active": true}
			}
			return map[string]any{"ok": true, "apps": []map[string]any{front}}
		case "list":
			if req["role"] != "AXSecureTextField" {
				break
			}
			switch req["app"] {
			case nil: // the app with the keyboard focus
				if focused {
					return map[string]any{"ok": true, "elements": []map[string]any{field}}
				}
				return map[string]any{"ok": true, "elements": []map[string]any{}}
			case "com.apple.SecurityAgent":
				if p.up {
					return map[string]any{"ok": true, "elements": []map[string]any{field}}
				}
				return map[string]any{"ok": true, "elements": []map[string]any{}}
			}
			return map[string]any{"ok": false, "code": "not_found", "message": "No open app is called that."}
		}
		return map[string]any{"ok": false, "code": "invalid_request", "message": "unexpected"}
	}
}

func TestPassword(t *testing.T) {
	f := newFakeSharing(t, "alex", "Pw!")
	s := newTestScreen(t, f.addr())
	s.settle = 300 * time.Millisecond
	setAccount(t, s, "alex", "Pw!")
	paths := map[int]string{77: securityAgentPath, 619: loginWindowPath}
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	// A Shift tap readies the session first, then the click into the field.
	click := []string{"key ffe1 1", "key ffe1 0", "ptr 0 28 18", "ptr 1 28 18", "ptr 0 28 18"}
	// A letter for macOS to drop, Command-A and Delete, the password, Return.
	typed := []string{"key 78 1", "key 78 0", "key ffeb 1", "key 61 1", "key 61 0", "key ffeb 0", "key ff08 1", "key ff08 0",
		"key ffe1 1", "key 50 1", "key 50 0", "key ffe1 0", "key 77 1", "key 77 0",
		"key ffe1 1", "key 21 1", "key 21 0", "key ffe1 0", "key ff0d 1", "key ff0d 0"}

	// Without the helper the prompt can't be found safely.
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != proto.ScreenCodeNoHelper {
		t.Fatalf("no helper: %+v", r)
	}
	p := &promptState{up: true, clickable: true, accepts: true, ax: true}
	s.sessions = promptSessions(f, p)
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), promptHelper(f, p))
	f.takeEvents()
	clear := []string{"key ffeb 1", "key 61 1", "key 61 0", "key ffeb 0", "key ff08 1", "key ff08 0"}

	// The prompt takes it: a click into its field, the password, Return.
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if !r.OK || r.Element == nil || r.Element.App != "SecurityAgent" || r.Element.X != 20 || r.Element.Subrole != "AXSecureTextField" {
		t.Fatalf("password: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(click, typed); !slices.Equal(ev, want) {
		t.Fatalf("password sent\n%q\nwant\n%q", ev, want)
	}

	// No prompt: nothing clicked, nothing typed.
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.OK || r.Code != proto.ScreenCodeNoPrompt {
		t.Fatalf("no prompt: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("without a prompt: %q", ev)
	}

	// The prompt stays (a refused password): typed once, the field emptied
	// while it still has the keyboard, failed.
	p.mu.Lock()
	p.up, p.accepts = true, false
	p.mu.Unlock()
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "still there") || !strings.Contains(r.Message, "emptied") {
		t.Fatalf("refused: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(click, typed, clear); !slices.Equal(ev, want) {
		t.Fatalf("refused sent\n%q\nwant\n%q", ev, want)
	}

	// The field is pinned when the prompt is found (one look at what has
	// the focus), and each key needs that very field to have it, in the
	// prompt's window, still in front.
	p.mu.Lock()
	p.accepts = true
	p.mu.Unlock()
	before, wbefore := h.count("focused"), h.count("windows")
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK {
		t.Fatalf("pinned: %+v", r)
	}
	if ev, want := f.takeEvents(), slices.Concat(click, typed); !slices.Equal(ev, want) {
		t.Fatalf("pinned sent\n%q\nwant\n%q", ev, want)
	}
	// Once to pin it, then before the letter, Command-A, Delete, each of 3
	// characters and Return.
	if n := h.count("focused") - before; n != 8 {
		t.Fatalf("asked for the focused element %d times, want 8", n)
	}
	if n := h.count("windows") - wbefore; n < 8 {
		t.Fatalf("asked for the windows %d times, want the prompt's checked before each key", n)
	}
	// A password field of the prompt's process, but outside its window.
	p.mu.Lock()
	p.up, p.outside = true, true
	p.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("outside the window: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, click) {
		t.Fatalf("outside the window: sent %q", ev)
	}
	p.mu.Lock()
	p.outside = false
	p.mu.Unlock()
	// Helper 1.0.5 must name the field by its token.
	p.mu.Lock()
	p.up, p.noToken = true, true
	p.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("no token: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, click) {
		t.Fatalf("no token: sent %q", ev)
	}
	p.mu.Lock()
	p.noToken = false
	p.mu.Unlock()
	// After the first character the keyboard goes elsewhere: another app,
	// another password field of the prompt's process in its window, a new
	// field in the same place, the prompt's window a new one. Nothing more
	// goes, not even the keys that would empty the field.
	for _, c := range []struct {
		name, version string
		set           func(ev string)
	}{
		{"another app", "1.0.5", func(ev string) { p.moveAfter = ev }},
		{"another app, 1.0.4", "1.0.4", func(ev string) { p.moveAfter = ev }},
		{"another field", "1.0.5", func(ev string) { p.otherAfter = ev }},
		{"another field, 1.0.4", "1.0.4", func(ev string) { p.otherAfter = ev }},
		{"a new field in its place", "1.0.5", func(ev string) { p.newAfter = ev }},
		{"another window", "1.0.5", func(ev string) { p.windowAfter = ev }},
	} {
		p.mu.Lock()
		p.up, p.version = true, c.version
		c.set("key 50 0")
		p.mu.Unlock()
		r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
		if r.Code != "failed" || !strings.Contains(r.Message, "lost the keyboard") {
			t.Fatalf("%s: %+v", c.name, r)
		}
		if ev, want := f.takeEvents(), slices.Concat(click, typed[:12]); !slices.Equal(ev, want) {
			t.Fatalf("%s sent\n%q\nwant\n%q", c.name, ev, want)
		}
		p.mu.Lock()
		p.moveAfter, p.otherAfter, p.newAfter, p.windowAfter = "", "", "", ""
		p.mu.Unlock()
	}
	p.mu.Lock()
	p.version = ""
	p.mu.Unlock()
	p.mu.Lock()
	p.up, p.notSecure = true, true
	p.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("not a password field: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, click) {
		t.Fatalf("not a password field: sent %q", ev)
	}
	// With Accessibility, a helper before 1.0.4 isn't relied on for the
	// checks before each key: the way without Accessibility (the window
	// list), never asked what has the focus. This prompt's window is too
	// small to be one that way, so nothing is typed.
	s.isAdmin = func(context.Context, string) (bool, error) { return true, nil }
	for _, version := range []string{"1.0.3", "dev"} {
		p.mu.Lock()
		p.up, p.notSecure, p.version = true, false, version
		p.mu.Unlock()
		before := h.count("focused")
		if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoPrompt {
			t.Fatalf("%s: %+v", version, r)
		}
		if h.count("focused") != before {
			t.Fatalf("%s: asked what has the focus", version)
		}
		if ev := f.takeEvents(); slices.Contains(ev, "ptr 1 28 18") || slices.Contains(ev, "key 50 1") {
			t.Fatalf("%s: clicked or typed %q", version, ev)
		}
	}
	// A helper before 1.0.2 can't say which window the prompt is.
	p.mu.Lock()
	p.up, p.version = true, "1.0.1"
	p.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != "failed" || !strings.Contains(r.Message, "too old") {
		t.Fatalf("1.0.1: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) != 0 {
		t.Fatalf("1.0.1: sent %q", ev)
	}
	p.mu.Lock()
	p.up, p.accepts, p.version = true, false, ""
	p.mu.Unlock()

	// The click doesn't give the field the focus: nothing typed.
	p.mu.Lock()
	p.clickable = false
	p.mu.Unlock()
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("no focus: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, click) {
		t.Fatalf("typed without the focus: %q", ev)
	}

	// An app posing as SecurityAgent (its executable isn't macOS's own).
	p.mu.Lock()
	p.clickable = true
	p.mu.Unlock()
	paths[77] = "/Applications/Lookalike.app/Contents/MacOS/SecurityAgent"
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.OK || r.Code != "failed" || !strings.Contains(r.Message, "nothing was typed") {
		t.Fatalf("lookalike: %+v", r)
	}
	if ev := f.takeEvents(); !slices.Equal(ev, click) {
		t.Fatalf("typed into a lookalike: %q", ev)
	}
	paths[77] = securityAgentPath

	// Without Accessibility a helper before 1.0.2 can't find the prompt.
	p.mu.Lock()
	p.ax, p.version = false, "1.0.1"
	p.mu.Unlock()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); r.Code != proto.ScreenCodeNoAccess {
		t.Fatalf("no access: %+v", r)
	}
	p.mu.Lock()
	p.ax, p.version = true, ""
	p.mu.Unlock()

	// A request never carries a password.
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword, Text: "Pw!"}); r.Code != "invalid_request" {
		t.Fatalf("with a text: %+v", r)
	}
	if n := h.count("list"); n == 0 {
		t.Fatal("the helper was never asked for the prompt")
	}

	// The lock screen is macOS's own prompt too: unlock types it there.
	s.sessions = func(context.Context) ([]consoleSession, error) {
		return []consoleSession{{User: "alex", OnConsole: true, LoggedIn: true, Locked: f.seen("key ff0d 0") == 0, SecureInputPID: 619}}, nil
	}
	p.mu.Lock()
	p.lock = true
	p.mu.Unlock()
	f.takeEvents()
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK || r.Status == nil || *r.Status.Locked {
		t.Fatalf("lock screen: %+v", r)
	}
	if ev := f.takeEvents(); len(ev) == 0 || ev[0] != "key ffe1 1" || ev[len(ev)-1] != "key ff0d 0" {
		t.Fatalf("lock screen sent %q", ev)
	}
}

// System Settings' password sheet with Accessibility, as macOS 27 shows it:
// the pane's extension has the focus, System Settings owns the sheet's
// window. The field must lie in that window, the frontmost.
func TestPromptHasFocusSettingsSheet(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	const settingsPID, panePID, laPID = 95968, 95972, 4242
	paths := maps.Clone(applePaths)
	maps.Copy(paths, map[int]string{settingsPID: settingsApp, panePID: privacyPane, laPID: laRemoteService, 500: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"})
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	var panes []string
	busy := true
	s.paneSheet = func(_ context.Context, _ int, pane string) (paneSheet, error) {
		panes = append(panes, pane)
		return paneSheet{busy: busy, pids: []int{settingsPID, panePID, laPID}}, nil
	}
	ext := map[string]any{"name": "Privacy & Security (System Settings)", "bundle_id": "com.apple.settings.PrivacySecurity.extension",
		"pid": panePID, "active": true}
	sheet := map[string]any{"number": 1053, "layer": 0, "alpha": 1, "x": 240, "y": 358, "w": 260, "h": 337, "pid": settingsPID,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	main := map[string]any{"number": 1043, "layer": 0, "alpha": 1, "x": 0, "y": 214, "w": 740, "h": 625, "pid": settingsPID,
		"owner": "System Settings", "bundle_id": settingsBundleID}
	editor := map[string]any{"number": 986, "layer": 0, "alpha": 1, "x": 213, "y": 77, "w": 586, "h": 488, "pid": 500,
		"owner": "TextEdit", "bundle_id": "com.apple.TextEdit"}
	var mu sync.Mutex
	front := []map[string]any{sheet, main, editor}
	app := "Privacy & Security (System Settings)"
	newFakeHelper(t, s.uiRoot, os.Getuid(), func(req map[string]any) map[string]any {
		mu.Lock()
		defer mu.Unlock()
		switch req["op"] {
		case "apps":
			return map[string]any{"ok": true, "apps": []map[string]any{ext}}
		case "list":
			return map[string]any{"ok": true, "elements": []map[string]any{
				{"id": "w0.0", "role": "AXSheet", "x": 240, "y": 358, "w": 260, "h": 337, "app": app},
				{"id": "w0.0.1", "role": "AXImage", "ident": "lock.fill", "x": 350, "y": 380, "w": 40, "h": 40, "app": app},
				{"id": "w0.0.4", "role": "AXTextField", "subrole": "AXSecureTextField", "enabled": true, "focused": true,
					"x": 255, "y": 572, "w": 230, "h": 26, "app": app},
			}}
		case "windows":
			return map[string]any{"ok": true, "windows": slices.Concat(furnitureWindows, front)}
		case "focused":
			return map[string]any{"ok": true, "pid": panePID, "bundle_id": "com.apple.settings.PrivacySecurity.extension",
				"element": map[string]any{"id": "focused", "role": "AXTextField", "subrole": "AXSecureTextField", "enabled": true,
					"focused": true, "x": 255, "y": 572, "w": 230, "h": 26, "app": app, "token": "c0de"}}
		}
		return map[string]any{"ok": false, "code": "invalid_request", "message": "unexpected"}
	})
	uid := os.Getuid()
	p := &prompt{bundleID: "com.apple.settings.PrivacySecurity.extension", app: app, settings: true}
	tgt, err := s.promptHasFocus(context.Background(), uid, p, "1.0.5")
	if err != nil || tgt == nil || tgt.window == nil || tgt.window.Number != 1053 {
		t.Fatalf("the sheet: %+v %v", tgt, err)
	}
	for _, pid := range []int{settingsPID, panePID, laPID} {
		if !tgt.allowed(context.Background(), pid) {
			t.Fatalf("process %d not allowed", pid)
		}
	}
	if tgt.allowed(context.Background(), 500) || len(panes) != 1 || panes[0] != privacyPane {
		t.Fatalf("TextEdit allowed, or panes asked %q", panes)
	}
	// The field itself is pinned, and the pane is asked again before each
	// key, with Accessibility too.
	if !tgt.ax || tgt.field == nil || tgt.field.pid != panePID || tgt.field.el.Token != "c0de" || tgt.pane != privacyPane {
		t.Fatalf("pinned: %+v %+v", tgt, tgt.field)
	}
	busy = false
	if err := s.secureField(context.Background(), tgt); !errors.Is(err, errNotSecure) || !strings.Contains(err.Error(), "no longer asks") {
		t.Fatalf("the pane no longer asks: %v", err)
	}
	// LocalAuthentication not busy for the pane: not the Mac's password.
	if tgt, err := s.promptHasFocus(context.Background(), uid, p, "1.0.5"); err != nil || tgt != nil {
		t.Fatalf("not asking: %+v %v", tgt, err)
	}
	busy = true
	// Another app's window in front of the sheet: no target.
	mu.Lock()
	front = []map[string]any{editor, sheet, main}
	mu.Unlock()
	if tgt, err := s.promptHasFocus(context.Background(), uid, p, "1.0.5"); err != nil || tgt != nil {
		t.Fatalf("TextEdit in front: %+v %v", tgt, err)
	}
}

// A password goes one character at a time, each checked first. Its step
// has the time for the longest password at the slowest checks seen on a Mac
// (with Accessibility the window list and the focused field, for System
// Settings' sheet LocalAuthentication too), with what comes before and
// after; a step that still runs out of it empties the field (checked, with
// the time kept for that) and never presses Return.
func TestPasswordTime(t *testing.T) {
	d := New(Options{})
	const (
		check           = 200 * time.Millisecond // the slowest per-key check seen (System Settings' sheet)
		longestPassword = 63                     // Apple's sign-in carries 63 bytes
	)
	keys := time.Duration(len(leadKeys)+len(clearKeys)+longestPassword+1) * (check + d.charGap + 3*d.keyGap)
	need := d.busyWait + d.sharingSettleMax + 3*d.clickGap + d.escGap + d.leadSettle + keys + d.settle + d.clearReserve
	if need > d.secretTimeout {
		t.Fatalf("a %d-character password needs about %s, over password's %s", longestPassword, need, d.secretTimeout)
	}
	t.Logf("a %d-character password needs about %s: password's limit %s, other steps' %s", longestPassword, need, d.secretTimeout, d.stepTimeout)

	long := strings.Repeat("abcdefghij", 6) // 60 characters
	f := newFakeSharing(t, "alex", long)
	s := newTestScreen(t, f.addr())
	s.settle = 300 * time.Millisecond
	setAccount(t, s, "alex", long)
	paths := maps.Clone(applePaths)
	paths[77] = securityAgentPath
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := paths[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	p := &promptState{up: true, clickable: true, accepts: true, ax: true}
	// stall: once the fifth letter went, the next check of the field lasts
	// until the time for typing is over, once. It waits for that time's own
	// end, not for a clock of its own: two clocks set to one moment fire in
	// either order on a busy machine.
	var stallMu sync.Mutex
	stall := false
	sessions := promptSessions(f, p)
	s.sessions = func(ctx context.Context) ([]consoleSession, error) {
		stallMu.Lock()
		wait := stall && f.seen("key 65 0") > 0
		stall = stall && !wait
		stallMu.Unlock()
		if wait {
			<-ctx.Done()
		}
		return sessions(ctx)
	}
	newFakeHelper(t, s.uiRoot, os.Getuid(), promptHelper(f, p))
	f.takeEvents()
	letters := func(ev []string) int {
		n := 0
		for _, e := range ev {
			if len(e) == len("key 61 1") && e >= "key 61 1" && e <= "key 6a 1" && strings.HasSuffix(e, " 1") {
				n++
			}
		}
		return n
	}
	// All of it, then Return.
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword}); !r.OK {
		t.Fatalf("60 characters: %+v", r)
	}
	if ev := f.takeEvents(); letters(ev) != 61 || ev[len(ev)-1] != "key ff0d 0" { // with Command-A's a
		t.Fatalf("60 characters: %d letters, ending %q", letters(ev)-1, ev[len(ev)-1])
	}
	// Out of time part-way (the check after the fifth letter outlasts the
	// time for typing): the field emptied, no Return.
	s.secretTimeout, s.clearReserve = 4*time.Second, 2*time.Second
	p.mu.Lock()
	p.up = true
	p.mu.Unlock()
	stallMu.Lock()
	stall = true
	stallMu.Unlock()
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenPassword})
	if r.Code != "failed" || !strings.Contains(r.Message, "took too long") || !strings.Contains(r.Message, "emptied") {
		t.Fatalf("out of time: %+v", r)
	}
	ev := f.takeEvents()
	clear := []string{"key ffeb 1", "key 61 1", "key 61 0", "key ffeb 0", "key ff08 1", "key ff08 0"}
	if n := letters(ev) - 2; n != 5 || slices.Contains(ev, "key ff0d 1") || !slices.Equal(ev[len(ev)-len(clear):], clear) {
		t.Fatalf("out of time: %d letters typed, then %q", n, ev[max(0, len(ev)-8):])
	}
}

// Unlock through Screen Sharing out of time part-way: Escape empties the
// lock screen's field while it still has the keyboard, no Return.
func TestUnlockTime(t *testing.T) {
	long := strings.Repeat("abcdefghij", 6)
	f := newFakeSharing(t, "alex", long)
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", long)
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if pid == 619 {
			return loginWindowPath, nil
		}
		return "", errors.New("no such process")
	}
	// Once the fifth letter went, the next check of the lock screen lasts
	// until the time for typing is over: it waits for that time's own end
	// (see TestPasswordTime).
	var mu sync.Mutex
	stalled := false
	s.sessions = func(ctx context.Context) ([]consoleSession, error) {
		mu.Lock()
		stall := f.seen("key 65 0") > 0 && !stalled
		stalled = stalled || stall
		mu.Unlock()
		if stall {
			<-ctx.Done()
		}
		return []consoleSession{{User: "alex", UID: 501, OnConsole: true, LoggedIn: true, Locked: true, SecureInputPID: 619}}, nil
	}
	lh := &lockHelper{}
	newFakeHelper(t, s.uiRoot, os.Getuid(), lh.answer)
	s.secretTimeout, s.clearReserve = 4*time.Second, 2*time.Second
	f.takeEvents()
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUnlock})
	if r.Code != "failed" || !strings.Contains(r.Message, "stopped part-way") || !strings.Contains(r.Message, "emptied") {
		t.Fatalf("out of time: %+v", r)
	}
	ev := f.takeEvents()
	escape := []string{"key ff1b 1", "key ff1b 0"}
	letters := 0
	for _, e := range ev {
		if len(e) == len("key 61 1") && e >= "key 61 1" && e <= "key 6a 1" && strings.HasSuffix(e, " 1") {
			letters++
		}
	}
	if slices.Contains(ev, "key ff0d 1") || !slices.Equal(ev[len(ev)-2:], escape) || letters != 5 {
		t.Fatalf("out of time: %d letters, sent %q", letters, ev)
	}
}

func TestHelperAtLeast(t *testing.T) {
	for v, want := range map[string]bool{"1.0.4": true, "1.0.5": true, "1.1.0": true, "2.0.0": true, "1.0.10": true,
		"1.0.3": false, "0.9.9": false, "dev": false, "": false, "1.0": false, "1.0.4.1": false, "1.0.x": false, "1.-1.9": false} {
		if got := helperAtLeast(v, helperGuardedKeys); got != want {
			t.Errorf("%q: %v", v, got)
		}
	}
}
