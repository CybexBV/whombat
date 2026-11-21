package screen

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

// helperState is what the fake helper says about the session.
type helperState struct {
	ax, locked bool
}

func fakeHelperAnswers(st *helperState) func(map[string]any) map[string]any {
	return func(req map[string]any) map[string]any {
		switch req["op"] {
		case "status":
			return map[string]any{"ok": true, "version": "1.2", "ax": st.ax, "locked": st.locked, "user": "alex",
				"front_app": "Finder", "displays": []map[string]any{
					{"id": 2, "x": -1600, "y": 0, "w": 1600, "h": 900, "scale": 1, "main": false},
					{"id": 1, "x": 0, "y": 0, "w": 32, "h": 24, "scale": 2, "main": true},
				}}
		case "apps":
			return map[string]any{"ok": true, "apps": []map[string]any{
				{"name": "Finder", "bundle_id": "com.apple.finder", "pid": 400, "active": true, "windows": []string{"Downloads"}}}}
		case "list":
			return map[string]any{"ok": true, "truncated": false, "elements": []map[string]any{
				{"id": "w0.1", "role": "AXButton", "title": "OK", "enabled": true, "x": 10, "y": 5.25, "w": 4, "h": 2,
					"actions": []string{"AXPress"}, "app": "Finder", "window": "Downloads"},
				{"id": "w0.2", "role": "AXTextField", "value": "abc", "x": 1, "y": 1, "w": 1, "h": 1},
				{"id": "w1.1", "role": "AXButton", "title": "Far", "x": -800, "y": 100, "w": 10, "h": 10},
			}}
		case "press", "set", "menu":
			if req["name"] == "Nothing" || (req["op"] == "menu" && len(req["path"].([]any)) == 3) {
				return map[string]any{"ok": false, "code": "not_found", "message": "No match. Close names: OK, Cancel"}
			}
			a := map[string]any{"ok": true, "element": map[string]any{"id": "w0.1", "role": "AXButton", "title": "OK", "x": 10, "y": 5, "w": 4, "h": 2}}
			if req["name"] == "Busy" {
				a["message"] = "Pressed; the app is still busy."
			}
			return a
		case "focus", "open", "type":
			return map[string]any{"ok": true}
		}
		return map[string]any{"ok": false, "code": "invalid_request", "message": "unknown op"}
	}
}

func TestUI(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw") // framebuffer 64×48: twice the main display's 32×24 points
	st := &helperState{ax: true}
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), fakeHelperAnswers(st))

	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps})
	if !r.OK || len(r.Apps) != 1 || r.Apps[0].BundleID != "com.apple.finder" || !r.Apps[0].Active || r.Apps[0].Windows[0] != "Downloads" {
		t.Fatalf("ui.apps: %+v", r)
	}

	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIList, App: "Finder", Limit: 2})
	if !r.OK || len(r.Elements) != 2 || !r.Truncated {
		t.Fatalf("ui.list: %+v", r)
	}
	ok := r.Elements[0]
	if ok.X != 20 || ok.Y != 11 || ok.W != 8 || ok.H != 4 || ok.Title != "OK" || !ok.Enabled || ok.Actions[0] != "AXPress" || ok.Window != "Downloads" {
		t.Fatalf("points to pixels: %+v", ok)
	}
	last := h.requests()[len(h.requests())-1]
	if last["op"] != "list" || last["app"] != "Finder" || last["limit"] != float64(2) || last["v"] != float64(1) {
		t.Fatalf("helper request %v", last)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIList})
	if far := r.Elements[2]; far.X != -1600 || far.Y != 200 {
		t.Fatalf("an element on another display lands beyond the framebuffer: %+v", far)
	}

	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIPress, Name: "OK", Role: "button", Index: 1})
	if !r.OK || r.Element == nil || r.Element.X != 20 {
		t.Fatalf("ui.press: %+v", r)
	}
	last = h.requests()[len(h.requests())-1]
	if last["op"] != "press" || last["role"] != "AXButton" || last["index"] != float64(1) || last["name"] != "OK" {
		t.Fatalf("press request %v", last)
	}
	run(t, s, proto.ScreenRequest{Op: proto.ScreenUISet, Role: "text_field", Text: "hello"})
	last = h.requests()[len(h.requests())-1]
	if last["op"] != "set" || last["value"] != "hello" || last["role"] != "AXTextField,AXTextArea,AXSecureTextField,AXSearchField" || last["name"] != nil {
		t.Fatalf("set request %v", last)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIPress, Name: "Nothing"})
	if r.Code != proto.ScreenCodeNotFound || !strings.Contains(r.Message, "Cancel") {
		t.Fatalf("not found: %+v", r)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIMenu, App: "TextEdit", Path: []string{"File", "Save…"}})
	if !r.OK || r.Element == nil {
		t.Fatalf("ui.menu: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIFocus, App: "Finder"}); !r.OK {
		t.Fatalf("ui.focus: %+v", r)
	}
	for _, target := range []string{"accessibility", "TextEdit", "https://example.com/x"} {
		if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIOpen, Target: target}); !r.OK {
			t.Fatalf("ui.open %s: %+v", target, r)
		}
	}

	// Without Accessibility: the reading and pressing steps say so; opening
	// the setting still works.
	st.ax = false
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIPress, Name: "OK"}); r.Code != proto.ScreenCodeNoAccess {
		t.Fatalf("no access: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIOpen, Target: "accessibility"}); !r.OK {
		t.Fatalf("ui.open without access: %+v", r)
	}
	st.ax = true
	st.locked = true
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIList}); r.Code != proto.ScreenCodeLocked {
		t.Fatalf("locked: %+v", r)
	}
	st.locked = false

	n := len(h.requests())
	for _, bad := range []proto.ScreenRequest{
		{Op: proto.ScreenUIPress},
		{Op: proto.ScreenUIPress, Name: "OK", Role: "dial"},
		{Op: proto.ScreenUIPress, Name: "OK", Index: -1},
		{Op: proto.ScreenUIList, Limit: 1001},
		{Op: proto.ScreenUIMenu},
		{Op: proto.ScreenUIMenu, Path: []string{"File", ""}},
		{Op: proto.ScreenUIFocus},
		{Op: proto.ScreenUIOpen},
		{Op: proto.ScreenUIOpen, Target: "file:///etc/passwd"},
		{Op: proto.ScreenUIOpen, Target: "http://example.com"},
		{Op: proto.ScreenUIOpen, Target: "/Applications/Calculator.app"},
	} {
		if r := run(t, s, bad); r.Code != "invalid_request" {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}
	if len(h.requests()) != n {
		t.Fatal("refused requests reached the helper")
	}
}

func TestUINoHelper(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != proto.ScreenCodeNoHelper {
		t.Fatalf("no socket: %+v", r)
	}
	// Something that isn't a socket in the helper's place.
	if err := ensureUIDirs(s.uiRoot, os.Getuid()); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(s.uiRoot, strconv.Itoa(os.Getuid()), helperSocketName), []byte("x"), 0o600)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != proto.ScreenCodeNoHelper {
		t.Fatalf("a file: %+v", r)
	}
	s.consoleUID = func() (int, bool) { return 0, false }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != proto.ScreenCodeNoHelper {
		t.Fatalf("login window: %+v", r)
	}
	// A helper of another user is never asked: the socket's peer must be
	// the console user.
	s.consoleUID = func() (int, bool) { return os.Getuid() + 1, true }
	if err := os.MkdirAll(filepath.Join(s.uiRoot, strconv.Itoa(os.Getuid()+1)), 0o700); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(s.uiRoot, strconv.Itoa(os.Getuid()), helperSocketName))
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), fakeHelperAnswers(&helperState{ax: true}))
	os.Symlink(filepath.Join(s.uiRoot, strconv.Itoa(os.Getuid()), helperSocketName), filepath.Join(s.uiRoot, strconv.Itoa(os.Getuid()+1), helperSocketName))
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != proto.ScreenCodeNoHelper {
		t.Fatalf("another user's socket: %+v", r)
	}
	if len(h.requests()) != 0 {
		t.Fatal("asked a helper that isn't the console user's")
	}
}

func TestPeerUIDChecked(t *testing.T) {
	root := shortTempDir(t)
	uid := os.Getuid()
	newFakeHelper(t, root, uid, fakeHelperAnswers(&helperState{ax: true}))
	// Without a check nothing is trusted.
	if _, err := (helperClient{root: root}).call(context.Background(), uid, map[string]any{"op": "status"}); !errors.Is(err, errNoHelper) {
		t.Fatalf("no check: %v", err)
	}
	hc := helperClient{root: root, check: uidOnly}
	if a, err := hc.call(context.Background(), uid, map[string]any{"op": "status"}); err != nil || !a.OK || a.Version != "1.2" {
		t.Fatalf("own helper: %+v %v", a, err)
	}
	// The same socket presented as another user's is refused.
	if err := os.MkdirAll(filepath.Join(root, strconv.Itoa(uid+7)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(hc.socket(uid), hc.socket(uid+7)); err != nil {
		t.Skip("hard links to sockets unsupported here:", err)
	}
	if _, err := hc.call(context.Background(), uid+7, map[string]any{"op": "status"}); err == nil {
		t.Fatal("a socket served by another user must be refused")
	}
}

func TestEnsureUIDirs(t *testing.T) {
	root := filepath.Join(shortTempDir(t), "ui")
	uid := os.Getuid()
	if err := ensureUIDirs(root, uid); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(root)
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("root %v", fi.Mode())
	}
	dir := filepath.Join(root, strconv.Itoa(uid))
	fi, _ = os.Stat(dir)
	if !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Fatalf("user's folder %v", fi.Mode())
	}
	// A link in the user's place is replaced by a folder.
	os.RemoveAll(dir)
	other := shortTempDir(t)
	os.Symlink(other, dir)
	if err := ensureUIDirs(root, uid); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Lstat(dir); fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		t.Fatalf("link kept: %v", fi.Mode())
	}
	os.Chmod(dir, 0o777)
	ensureUIDirs(root, uid)
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatal("mode not restored")
	}
}

func TestAXRole(t *testing.T) {
	for word, want := range map[string]string{"button": "AXButton", "Switch": "AXCheckBox,AXSwitch", "any": "", "": "", "AXSlider": "AXSlider",
		// Comma-separated, as the contract promises: words and AX roles, each
		// once, in order; "any" anywhere is any role.
		"AXA,AXB": "AXA,AXB", "button, link": "AXButton,AXLink", "switch,checkbox": "AXCheckBox,AXSwitch",
		"button,any": "", "text_field,AXComboBox": "AXTextField,AXTextArea,AXSecureTextField,AXSearchField,AXComboBox"} {
		if got, ok := axRole(word); !ok || got != want {
			t.Errorf("%q: %q %v", word, got, ok)
		}
	}
	for _, bad := range []string{"dial", "AX Slider", "AX", "button,,link", "button,dial", strings.Repeat("AXButton,", 8) + "AXLink",
		"AX" + strings.Repeat("x", 63)} {
		if _, ok := axRole(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

// One scale for both axes: the framebuffer's width over the main display's
// width in points, also when the heights don't divide the same way.
func TestPointMapOneScale(t *testing.T) {
	pm := newPointMap([]helperDisplay{{X: -100, Y: 0, W: 1000, H: 600, Scale: 2, Main: true},
		{X: 900, Y: 0, W: 800, H: 600}}, 2000)
	e := pm.element(helperElement{X: 0, Y: 100, W: 10, H: 10})
	if e.X != 200 || e.Y != 200 || e.W != 20 || e.H != 20 {
		t.Fatalf("%+v", e)
	}
}

func TestPointMapWithoutFramebuffer(t *testing.T) {
	// No sign-in yet: the main display's scale stands in.
	pm := newPointMap([]helperDisplay{{X: 0, Y: 0, W: 1512, H: 982, Scale: 2, Main: true}}, 0)
	e := pm.element(helperElement{X: 100.4, Y: 50, W: 20, H: 10})
	if e.X != 201 || e.Y != 100 || e.W != 40 || e.H != 20 {
		t.Fatalf("%+v", e)
	}
}

// The helper's note on what happened goes with an answer that worked.
func TestUINote(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	newFakeHelper(t, s.uiRoot, os.Getuid(), fakeHelperAnswers(&helperState{ax: true}))
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIPress, Name: "Busy"})
	if !r.OK || r.Message != "Pressed; the app is still busy." {
		t.Fatalf("%+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIPress, Name: "OK", Role: "button,link"}); !r.OK || r.Message != "" {
		t.Fatalf("%+v", r)
	}
}
