package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func macReport() *proto.Report {
	yes, no := true, false
	r := &proto.Report{At: time.Now()}
	r.Host.OSName, r.Host.OSVersion = "macOS", "27.2.1"
	r.Agent.OS = "darwin"
	r.MacOS = &proto.MacOS{Version: "27.2.1", Build: "26B131", Model: "Mac14,14", ModelName: "Mac Studio", Chip: "Apple M2 Ultra",
		SIP: &yes, FileVault: &no, AutoLogin: "alice", ConsoleUser: "alice",
		Screen: proto.MacScreen{Sharing: true, Account: "alice", SignIn: "ok", SignInAt: time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC), Locked: &no, Width: 5120, Height: 2880},
		Helper: proto.MacHelper{Installed: true, Version: "1.0.0", Running: true, Accessibility: &yes, User: "alice"}}
	return r
}

func TestMacDetail(t *testing.T) {
	r := macReport()
	if DetailView(r) != "macos" || OSFamily(r) != OSFamilyMacOS || OSFamily(&proto.Report{}) != OSFamilyLinux || OSFamily(nil) != "" {
		t.Fatal("view / family")
	}
	b, err := json.Marshal(BuildMacOS(r))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":"27.2.1","build":"26B131","model":"Mac14,14","model_name":"Mac Studio","chip":"Apple M2 Ultra","sip":true,"filevault":false,` +
		`"auto_login":"alice","console_user":"alice","screen":{"sharing":true,"account":"alice","sign_in":"ok","sign_in_at":"2026-11-17T09:00:00Z",` +
		`"locked":false,"w":5120,"h":2880},"helper":{"installed":true,"version":"1.0.0","running":true,"ax":true,"user":"alice",` +
		`"latest":null,"update":null}}` // the hub fills latest and update in GET /servers/{id}
	if string(b) != want {
		t.Errorf("macos block:\n%s\nwant\n%s", b, want)
	}
	// Not set: nulls, never zero values that look like answers.
	r.MacOS.Screen = proto.MacScreen{}
	r.MacOS.Helper = proto.MacHelper{}
	b, _ = json.Marshal(BuildMacOS(r))
	if !strings.Contains(string(b), `"screen":{"sharing":false,"account":null,"sign_in":null,"sign_in_at":null,"locked":null,"w":null,"h":null}`) {
		t.Errorf("empty screen: %s", b)
	}
	if BuildMacOS(&proto.Report{}) != nil {
		t.Error("a Linux server has no macos block")
	}
	now := time.Now()
	st := &ServerState{ID: "mac", Hostname: "studio", Report: macReport(), ReportAt: now, LastSeen: now, Connected: true}
	fs := BuildFleetServer(st, now)
	if fs.OS == nil || *fs.OS != "macOS 27.2.1" || fs.OSFamily != "macos" || fs.DetailView != "macos" {
		t.Errorf("card: %+v", fs)
	}
	d := BuildDetail(st, now, DetailInput{})
	if d.MacOS == nil || d.Server.OSFamily != "macos" || d.Server.DetailView != "macos" {
		t.Errorf("detail: %+v", d.Server)
	}
}

func TestMacHints(t *testing.T) {
	now := time.Now()
	kinds := func(s *ServerState) []string {
		var out []string
		for _, h := range macHints(s, now) {
			out = append(out, h.Kind)
		}
		return out
	}
	st := &ServerState{ID: "mac", Report: macReport()}
	if k := kinds(st); len(k) != 0 {
		t.Fatalf("a healthy Mac: %v", k)
	}
	m := st.Report.MacOS
	m.Screen.Sharing, m.Screen.SignIn = false, "failed"
	no := false
	m.Helper.Accessibility = &no
	if k := kinds(st); strings.Join(k, ",") != "macos.screen_sharing_off,macos.screen_sign_in,macos.helper_no_access" {
		t.Errorf("%v", k)
	}
	// The agent in a folder others can change: a hint naming it.
	m.AgentFolder = "/usr/local/bin"
	hs := macHints(st, now)
	if len(hs) != 4 || hs[2].Kind != "macos.agent_folder" || hs[2].Severity != "info" || hs[2].Link != "#agent" ||
		!strings.Contains(hs[2].Detail, "/usr/local/bin") {
		t.Errorf("agent folder: %+v", hs)
	}
	m.AgentFolder = ""
	// The helper not answering counts after five minutes.
	m.Helper.Running = false
	st.MacHelperOffSince = HelperOffSince(time.Time{}, st.Report, now)
	if st.MacHelperOffSince != now || strings.Contains(strings.Join(kinds(st), ","), "helper_off") {
		t.Errorf("at once: %v", kinds(st))
	}
	st.MacHelperOffSince = HelperOffSince(now.Add(-6*time.Minute), st.Report, now)
	if !strings.Contains(strings.Join(kinds(st), ","), "macos.helper_off") {
		t.Errorf("after 6 min: %v", kinds(st))
	}
	// Nobody at the screen, or the helper back: the clock stops.
	m.ConsoleUser = ""
	if !HelperOffSince(now.Add(-time.Hour), st.Report, now).IsZero() {
		t.Error("login window: no helper expected")
	}
	if !HelperOffSince(now, &proto.Report{}, now).IsZero() {
		t.Error("not a Mac")
	}
}
