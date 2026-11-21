package hub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// fakeScreen is a Mac's screen as the fake agent answers it.
func fakeScreen(req proto.ScreenRequest) proto.ScreenResponse {
	locked := false
	ax := true
	switch req.Op {
	case proto.ScreenLook:
		var buf bytes.Buffer
		png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 32, 18)))
		return proto.ScreenResponse{OK: true, Image: buf.Bytes(), Format: "png", W: 32, H: 18, ScreenW: 1920, ScreenH: 1080}
	case proto.ScreenStatus:
		return proto.ScreenResponse{OK: true, ScreenW: 1920, ScreenH: 1080,
			Status: &proto.MacScreen{Sharing: true, Account: "alice", SignIn: "ok", SignInAt: time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC), Locked: &locked, Width: 1920, Height: 1080},
			Helper: &proto.MacHelper{Installed: true, Version: "1.0", Running: true, Accessibility: &ax, User: "alice"}}
	case proto.ScreenUIList:
		return proto.ScreenResponse{OK: true, Elements: []proto.UIElement{{ID: "w0.1", Role: "AXButton", Title: "Allow\x07", Enabled: true, X: 10, Y: 20, W: 80, H: 24, Actions: []string{"AXPress"}}}, Truncated: true}
	case proto.ScreenUIPress:
		if req.Name == "Nothing" {
			return proto.ScreenResponse{Code: proto.ScreenCodeNotFound, Message: "No match. Close names: Allow, Don't Allow"}
		}
		return proto.ScreenResponse{OK: true, Element: &proto.UIElement{ID: "w0.1", Role: "AXButton", Title: "Allow"}}
	case proto.ScreenKeys:
		if req.Keys == "fn+q" {
			return proto.ScreenResponse{Code: "invalid_request", Message: "fn can't be pressed through Screen Sharing"}
		}
	case proto.ScreenAccountSet:
		return proto.ScreenResponse{OK: true, Status: &proto.MacScreen{Sharing: true, Account: req.Account.User, SignIn: "ok"}}
	case proto.ScreenPassword:
		return proto.ScreenResponse{OK: true, Element: &proto.UIElement{ID: "w0.0.4", Role: "AXTextField", Subrole: "AXSecureTextField", App: "SecurityAgent", Window: "Untitled"}}
	}
	return proto.ScreenResponse{OK: true, ScreenW: 1920, ScreenH: 1080}
}

// macReport is the fake host's report as a Mac's agent sends it.
func macReport(fa *fakeAgent, host string, sharing bool, account string) *proto.Report {
	r := fa.report(host)
	r.MacOS = &proto.MacOS{Version: "27.2.1", Model: "Mac14,14", Screen: proto.MacScreen{Sharing: sharing, Account: account}}
	return r
}

func TestScreenRoute(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("ag_1|Whombat")
	fa := e.enroll(svc, "basalt", "Lab")
	fa.policy = proto.Policy{Console: true, Diagnose: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })
	path := "/api/v1/servers/basalt/screen"
	look := map[string]any{"op": "look", "max_w": 1280}

	// Not a Mac.
	if code, b, _ := svc.req(http.MethodPost, path, look, nil); code != 501 || !strings.Contains(string(b), "unsupported") {
		t.Fatalf("not a Mac: %d %s", code, b)
	}
	if code, b, _ := svc.req(http.MethodGet, "/api/v1/servers/basalt/guests/host:host/thumbnail", nil, nil); code != 404 {
		t.Fatalf("a Linux host's thumbnail: %d %s", code, b)
	}

	fa.send(proto.MsgReport, macReport(fa, "basalt", true, "alice"))
	waitFor(t, "a Mac", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return isMac(st) })
	// Without the host shell switch: only the status (diagnose).
	if code, b, _ := svc.req(http.MethodPost, path, look, nil); code != 403 || !strings.Contains(string(b), "host_shell_disabled") {
		t.Fatalf("look without host shell: %d %s", code, b)
	}
	var out map[string]any
	svc.json(http.MethodPost, path, map[string]any{"op": "status"}, 200, &out)
	st := out["status"].(map[string]any)
	if out["ok"] != true || st["account"] != "alice" || st["sign_in"] != "ok" || st["sign_in_at"] != "2026-11-17T09:00:00Z" || st["locked"] != false ||
		out["helper"].(map[string]any)["ax"] != true || out["screen_w"] != float64(1920) {
		t.Fatalf("status %v", out)
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/servers/basalt/guests/host:host/thumbnail", nil, nil); code != 403 {
		t.Fatalf("a Mac's thumbnail without host shell: %d", code)
	}

	svc.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	fa.policy.HostShell = true
	fa.send(proto.MsgReport, macReport(fa, "basalt", true, "alice"))
	waitFor(t, "policy", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st.Report.Policy.HostShell })

	// An operator may ask for the status only: a look shows what the person
	// has open, ui.list other apps' field values.
	operator := map[string]string{HeaderRole: "operator"}
	for _, op := range []map[string]any{look, {"op": "ui.list", "app": "Finder"}, {"op": "ui.apps"}} {
		if code, b, _ := svc.req(http.MethodPost, path, op, operator); code != 403 || !strings.Contains(string(b), "insufficient_role") {
			t.Fatalf("operator %v: %d %s", op["op"], code, b)
		}
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "status"}, 200, &out)
	if code, _, _ := svc.req(http.MethodPost, path, map[string]any{"op": "status"}, operator); code != 200 {
		t.Fatalf("operator status: %d", code)
	}
	svc.json(http.MethodPost, path, look, 200, &out)
	img, err := base64.StdEncoding.DecodeString(out["image_b64"].(string))
	if err != nil || out["format"] != "png" || out["w"] != float64(32) || out["screen_w"] != float64(1920) || out["audit_id"] == nil {
		t.Fatalf("look %v", out)
	}
	if _, err := png.Decode(bytes.NewReader(img)); err != nil {
		t.Fatal(err)
	}
	fa.mu.Lock()
	got := fa.screens[len(fa.screens)-1]
	fa.mu.Unlock()
	if got.Op != "look" || got.MaxW != 1280 {
		t.Fatalf("agent got %+v", got)
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "ui.list", "app": "Finder"}, 200, &out)
	el := out["elements"].([]any)[0].(map[string]any)
	if el["title"] != "Allow" || el["role"] != "AXButton" || el["x"] != float64(10) || out["truncated"] != true {
		t.Fatalf("ui.list %v", out)
	}
	// Looks are audited with the op and the app only, never what they saw;
	// the status isn't.
	if recs := e.audit("screen.look"); len(recs) != 1 || len(recs[0].Details) != 1 || recs[0].Details["op"] != "look" {
		t.Fatalf("look audit %+v", recs)
	}
	if recs := e.audit("screen.ui.list"); len(recs) != 1 || len(recs[0].Details) != 2 || recs[0].Details["app"] != "Finder" {
		t.Fatalf("ui.list audit %+v", recs)
	}
	if n := len(e.audit("screen.status")); n != 0 {
		t.Fatalf("the status is audited (%d records)", n)
	}
	for _, r := range e.audit("screen.denied") {
		if r.Details["op"] == "ui.list" && len(r.Details) != 2 {
			t.Fatalf("a refused look keeps more than its op and app: %+v", r)
		}
	}

	// What the agent says about a step that worked comes along.
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse {
		return proto.ScreenResponse{OK: true, Message: "Unlocked through Screen Sharing: the screen locks again when Whombat's screen session ends."}
	}
	fa.mu.Unlock()
	svc.json(http.MethodPost, path, map[string]any{"op": "unlock"}, 200, &out)
	fa.mu.Lock()
	fa.screenAnswer = nil
	fa.mu.Unlock()
	if out["ok"] != true || !strings.Contains(out["message"].(string), "locks again") {
		t.Fatalf("unlock's message %v", out)
	}
	var keys map[string]any
	svc.json(http.MethodPost, path, map[string]any{"op": "keys", "keys": "tab"}, 200, &keys)
	if _, ok := keys["message"]; ok || keys["ok"] != true {
		t.Fatalf("an empty message is left out: %v", keys)
	}

	// Acting: admins only.
	click := map[string]any{"op": "click", "x": 100, "y": 200, "button": "right"}
	if code, _, _ := svc.req(http.MethodPost, path, click, operator); code != 403 {
		t.Fatalf("operator click: %d", code)
	}
	svc.json(http.MethodPost, path, click, 200, &out)
	if out["ok"] != true || out["audit_id"] == nil {
		t.Fatalf("click %v", out)
	}
	if recs := e.audit("screen.click"); len(recs) != 1 || recs[0].Details["x"] != "100" || recs[0].Details["y"] != "200" ||
		recs[0].Details["button"] != "right" || recs[0].Outcome != "ok" {
		t.Fatalf("click audit %+v", recs)
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "type", "text": "secret words"}, 200, &out)
	svc.json(http.MethodPost, path, map[string]any{"op": "account.set", "account": map[string]any{"user": "alice", "password": "hunter2!"}}, 200, &out)
	if out["status"].(map[string]any)["account"] != "alice" {
		t.Fatalf("account.set %v", out)
	}
	if recs := e.audit("screen.type"); len(recs) != 1 || recs[0].Details["characters"] != "12" {
		t.Fatalf("type audit %+v", recs)
	}
	recs := e.audit("screen.account.set")
	if len(recs) != 1 || recs[0].Details["user"] != "alice" {
		t.Fatalf("account.set audit %+v", recs)
	}
	for _, r := range e.audit("screen.") {
		for _, v := range r.Details {
			if strings.Contains(v, "hunter2") || strings.Contains(v, "secret words") {
				t.Fatalf("the audit log keeps typed text or the password: %+v", r)
			}
		}
	}

	// The password into macOS's own prompt: admins only, audited with the
	// prompt's app and nothing typed; no prompt is the agent's own answer.
	if code, _, _ := svc.req(http.MethodPost, path, map[string]any{"op": "password"}, operator); code != 403 {
		t.Fatalf("operator password: %d", code)
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "password"}, 200, &out)
	if out["ok"] != true || out["audit_id"] == nil || out["element"].(map[string]any)["app"] != "SecurityAgent" {
		t.Fatalf("password %v", out)
	}
	fa.mu.Lock()
	if got := fa.screens[len(fa.screens)-1]; got.Op != "password" || got.Text != "" || got.Account != nil {
		t.Fatalf("agent got %+v", got)
	}
	fa.mu.Unlock()
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse {
		return proto.ScreenResponse{Code: proto.ScreenCodeNoPrompt, Message: "No macOS password prompt is on the Mac's screen."}
	}
	fa.mu.Unlock()
	svc.json(http.MethodPost, path, map[string]any{"op": "password", "app": "Safari"}, 200, &out)
	fa.mu.Lock()
	fa.screenAnswer = nil
	fa.mu.Unlock()
	if out["ok"] != false || out["code"] != "no_prompt" {
		t.Fatalf("no prompt %v", out)
	}
	// Newest first; a request's own app is not the prompt's and isn't kept.
	if recs := e.audit("screen.password"); len(recs) != 2 || recs[1].Outcome != "ok" || recs[1].Details["app"] != "SecurityAgent" ||
		recs[0].Outcome != "error" || recs[0].Code != "no_prompt" || len(recs[0].Details) != 1 {
		t.Fatalf("password audit %+v", recs)
	}
	if code, b, _ := svc.req(http.MethodPost, path, map[string]any{"op": "password", "text": "hunter2!"}, nil); code != 400 || !strings.Contains(string(b), "takes no text") {
		t.Fatalf("password with a text: %d %s", code, b)
	}

	// The agent's own answers.
	svc.json(http.MethodPost, path, map[string]any{"op": "ui.press", "name": "Nothing"}, 200, &out)
	if out["ok"] != false || out["code"] != "not_found" || !strings.Contains(out["message"].(string), "Allow") {
		t.Fatalf("not found %v", out)
	}
	if recs := e.audit("screen.ui.press"); len(recs) != 1 || recs[0].Outcome != "error" || recs[0].Code != "not_found" {
		t.Fatalf("press audit %+v", recs)
	}
	if code, b, _ := svc.req(http.MethodPost, path, map[string]any{"op": "keys", "keys": "fn+q"}, nil); code != 400 || !strings.Contains(string(b), "fn can") {
		t.Fatalf("agent's invalid_request: %d %s", code, b)
	}
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse { return proto.ScreenResponse{Code: "unsupported"} }
	fa.mu.Unlock()
	if code, _, _ := svc.req(http.MethodPost, path, look, nil); code != 501 {
		t.Fatalf("an older agent: %d", code)
	}
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse {
		return proto.ScreenResponse{Code: "remote_control_disabled"}
	}
	fa.mu.Unlock()
	if code, b, _ := svc.req(http.MethodPost, path, look, nil); code != 403 || !strings.Contains(string(b), "host_shell_disabled") {
		t.Fatalf("agent refuses: %d %s", code, b)
	}
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse {
		return proto.ScreenResponse{OK: true, Image: []byte("not a picture"), W: 10, H: 10}
	}
	fa.mu.Unlock()
	if code, _, _ := svc.req(http.MethodPost, path, look, nil); code != 502 {
		t.Fatalf("a bad picture: %d", code)
	}
	fa.mu.Lock()
	fa.screenAnswer = nil
	fa.mu.Unlock()

	for _, bad := range []map[string]any{
		{"op": "paint"},
		{"op": "type", "text": strings.Repeat("a", 2001)},
		{"op": "ui.set", "text": strings.Repeat("a", 10001)},
		{"op": "click", "x": -1},
		{"op": "click", "clicks": 4},
		{"op": "scroll", "dy": 51},
		{"op": "scroll", "dx": -51},
		{"op": "look", "max_w": 8193},
		{"op": "look", "max_w": -1},
		{"op": "ui.press", "name": "OK", "index": 1001},
		{"op": "ui.list", "limit": 1001},
		{"op": "ui.press", "name": strings.Repeat("n", 201)},
		{"op": "ui.press", "name": "OK", "role": strings.Repeat("r", 65)},
		{"op": "account.set", "account": map[string]any{"user": "alice", "password": "two\nlines"}},
		{"op": "account.set"},
		{"op": "account.set", "account": map[string]any{"user": "alice", "password": strings.Repeat("p", 64)}},
		{"op": "look", "account": map[string]any{"user": "alice", "password": "x"}},
		{"op": "ui.menu", "path": []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}},
	} {
		if code, _, _ := svc.req(http.MethodPost, path, bad, nil); code != 400 {
			t.Errorf("%v: %d", bad, code)
		}
	}

	// The host's still picture.
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/servers/basalt/guests/host:host/thumbnail", nil, nil); code != 200 {
		t.Fatalf("a Mac's thumbnail: %d", code)
	}
	// The screenshot asks the agent (whose fake answers a JPEG where a PNG
	// belongs).
	if code, b, _ := svc.req(http.MethodGet, "/api/v1/servers/basalt/guests/host:host/screenshot", nil, nil); code != 502 || !strings.Contains(string(b), "invalid") {
		t.Fatalf("a Mac's screenshot: %d %s", code, b)
	}
}

func TestMacHostConsole(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("ag_1|Whombat")
	fa := e.enroll(svc, "basalt", "Lab")
	fa.policy = proto.Policy{Console: true, HostShell: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	svc.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": true, "console": true}}, 200, nil)
	fa.send(proto.MsgReport, macReport(fa, "basalt", true, ""))
	waitFor(t, "a Mac", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return isMac(st) })
	open := func(protocol string, hdr map[string]string) (int, map[string]any) {
		body := map[string]any{}
		if protocol != "" {
			body["protocol"] = protocol
		}
		var out map[string]any
		code, b, _ := svc.req(http.MethodPost, "/api/v1/servers/basalt/console-sessions", body, hdr)
		if code == 201 {
			if err := json.Unmarshal(b, &out); err != nil {
				t.Fatal(err)
			}
		}
		return code, out
	}
	// No screen account yet: the journal by default, no vnc.
	if code, out := open("", nil); code != 201 || out["protocol"] != "logs" {
		t.Fatalf("default without an account: %d %v", code, out)
	}
	if code, _ := open("vnc", nil); code != 409 {
		t.Fatalf("vnc without an account: %d", code)
	}
	fa.send(proto.MsgReport, macReport(fa, "basalt", true, "alice"))
	waitFor(t, "account", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return st.Report.MacOS.Screen.Account != ""
	})
	if code, out := open("", nil); code != 201 || out["protocol"] != "vnc" {
		t.Fatalf("default with an account: %d %v", code, out)
	}
	if code, _ := open("", map[string]string{HeaderRole: "operator"}); code != 403 {
		t.Fatalf("an operator opening the Mac's screen: %d", code)
	}
	if code, out := open("logs", map[string]string{HeaderRole: "operator"}); code != 201 || out["protocol"] != "logs" {
		t.Fatalf("an operator's logs: %d %v", code, out)
	}
	// Screen Sharing off: no vnc.
	fa.send(proto.MsgReport, macReport(fa, "basalt", false, "alice"))
	waitFor(t, "sharing off", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return !st.Report.MacOS.Screen.Sharing
	})
	if code, _ := open("vnc", nil); code != 409 {
		t.Fatalf("vnc with Screen Sharing off: %d", code)
	}
}
