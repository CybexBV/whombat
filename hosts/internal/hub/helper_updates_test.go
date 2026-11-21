package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent/screen"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

const (
	helperOld = "1.0.0"
	helperNew = "1.1.0"
	helperTm  = "AB12CD34EF"
)

func TestHelperReasons(t *testing.T) {
	m := &agentManifest{Version: updBuild, Key: "k1", Files: map[string]manifestFile{
		helperZip: {OS: "darwin", Arch: proto.HelperArch, Version: helperNew},
	}}
	mac := func(f func(*model.ServerState, *proto.Report)) *model.ServerState {
		r := &proto.Report{}
		r.Agent.Version, r.Agent.UpdateKey, r.Agent.OS, r.Agent.Caps = updBuild, "k1", "darwin", []string{proto.CapHelperUpdate}
		r.Policy.Update, r.Policy.HostShell = true, true
		r.MacOS = &proto.MacOS{Helper: proto.MacHelper{Installed: true, Version: helperOld}}
		st := &model.ServerState{ID: "s", Connected: true, RCHostShell: true, Report: r}
		if f != nil {
			f(st, r)
		}
		return st
	}
	cases := []struct {
		name string
		st   *model.ServerState
		m    *agentManifest
		code string
	}{
		{"older helper", mac(nil), m, ""},
		{"no helper yet", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper = proto.MacHelper{} }), m, ""},
		{"unreadable version", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper.Version = "" }), m, ""},
		{"no manifest", mac(nil), nil, updNoBuild},
		{"no helper in it", mac(nil), &agentManifest{Version: updBuild, Key: "k1"}, updNoBuild},
		{"helper of another shape", mac(nil), &agentManifest{Version: updBuild, Key: "k1",
			Files: map[string]manifestFile{helperZip: {OS: "darwin", Arch: "arm64", Version: helperNew}}}, updNoBuild},
		{"offline", mac(func(st *model.ServerState, _ *proto.Report) { st.Connected = false }), m, updNotConnected},
		{"no Mac facts yet", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS = nil }), m, updNotConnected},
		{"same", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper.Version = helperNew }), m, updUpToDate},
		{"same, old agent", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper.Version, r.Agent.Caps = helperNew, nil }), m, updUpToDate},
		{"old agent", mac(func(_ *model.ServerState, r *proto.Report) { r.Agent.Caps = nil }), m, updUnsupported},
		{"no key", mac(func(_ *model.ServerState, r *proto.Report) { r.Agent.UpdateKey = "" }), m, updNoKey},
		{"other key", mac(func(_ *model.ServerState, r *proto.Report) { r.Agent.UpdateKey = "k2" }), m, updOtherKey},
		{"updates off", mac(func(_ *model.ServerState, r *proto.Report) { r.Policy.Update = false }), m, updTurnedOff},
		{"host shell off on the hub", mac(func(st *model.ServerState, _ *proto.Report) { st.RCHostShell = false }), m, updHostShellOff},
		{"host shell off on the Mac", mac(func(_ *model.ServerState, r *proto.Report) { r.Policy.HostShell = false }), m, updHostShellOff},
		{"newer", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper.Version = "2.0.0" }), m, updNewer},
		{"unknown order", mac(func(_ *model.ServerState, r *proto.Report) { r.MacOS.Helper.Version = "dev" }), m, updNewer},
	}
	for _, c := range cases {
		if code, reason := helperReason(c.st, c.m); code != c.code || (code != "" && reason == "") {
			t.Errorf("%s: %q %q, want %q", c.name, code, reason, c.code)
		}
	}
}

// withHelper puts the helper's zip and its description (with the team) in
// the fixture's --agent-dist, and a manifest with the Linux and Mac agents
// and the helper.
func (f *updFixture) withHelper(version string) {
	dist := f.e.h.cfg.AgentDist
	zip := []byte("PK helper " + version)
	sum := sha256.Sum256(zip)
	os.WriteFile(filepath.Join(dist, helperZip), zip, 0o644)
	os.WriteFile(filepath.Join(dist, helperJSON), []byte(fmt.Sprintf(`{"version":%q,"sha256":%q,"size":%d,"team":%q}`,
		version, hex.EncodeToString(sum[:]), len(zip), helperTm)), 0o644)
	mac := []byte("mac agent")
	os.WriteFile(filepath.Join(dist, "whombat-agent-darwin-arm64"), mac, 0o644)
	man := fmt.Sprintf(`{"version":%q,"key":"k1","files":{
		"whombat-agent-linux-amd64":{"arch":"amd64","size":12,"sha256":"%s","sig":"c2ln"},
		"whombat-agent-darwin-arm64":{"os":"darwin","arch":"arm64","size":%d,"sha256":"%s","sig":"c2ln"},
		%q:{"os":"darwin","arch":"universal","version":%q,"size":%d,"sha256":"%s","sig":"c2ln"}}}`,
		updBuild, strings.Repeat("ab", 32), len(mac), strings.Repeat("cd", 32), helperZip, version, len(zip), hex.EncodeToString(sum[:]))
	os.WriteFile(filepath.Join(dist, "manifest.json"), []byte(man), 0o644)
}

// macAgent is a fake Mac's agent: it takes agent and helper updates and
// reports them (an agent update brings the helper capability with it).
type macAgent struct {
	fa           *fakeAgent
	mu           sync.Mutex
	rep          *proto.Report
	helperAnswer *proto.UpdateResponse // nil: install and report it
}

func (m *macAgent) answer(req proto.UpdateRequest) proto.UpdateResponse {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := *m.rep
	mac := *m.rep.MacOS
	next.MacOS = &mac
	msg := ""
	switch req.Component {
	case proto.UpdateComponentHelper:
		if m.helperAnswer != nil {
			return *m.helperAnswer
		}
		mac.Helper.Installed, mac.Helper.Version = true, req.Version
		msg = "Whombat Helper " + req.Version + " is running."
	case "":
		next.Agent.Version, next.Agent.Caps = req.Version, []string{proto.CapHelperUpdate}
	}
	m.rep = &next
	m.fa.send(proto.MsgReport, &next)
	return proto.UpdateResponse{OK: true, Message: msg}
}

func (m *macAgent) sent() []proto.UpdateRequest {
	m.fa.mu.Lock()
	defer m.fa.mu.Unlock()
	return append([]proto.UpdateRequest(nil), m.fa.updates...)
}

// addMac enrolls a fake Mac with its agent version, helper version ("" =
// none) and, with caps, the helper capability; the host shell is on in its
// agent and on the hub.
func (f *updFixture) addMac(name, version, helper string, caps bool) *macAgent {
	f.t.Helper()
	fa := f.e.enroll(f.c, name, "Lab")
	fa.policy = proto.Policy{Update: true, Console: true, HostShell: true}
	fa.version = version
	if _, err := fa.dial(proto.Hello{}); err != nil {
		f.t.Fatal(err)
	}
	rep := fa.report(name)
	rep.Agent.Version, rep.Agent.UpdateKey, rep.Agent.Arch, rep.Agent.Install, rep.Agent.OS = version, "k1", "arm64", "launchd", "darwin"
	if caps {
		rep.Agent.Caps = []string{proto.CapHelperUpdate}
	}
	rep.MacOS = &proto.MacOS{Version: "27.2.1", ConsoleUser: "alex",
		Helper: proto.MacHelper{Installed: helper != "", Version: helper, Running: helper != ""}}
	m := &macAgent{fa: fa, rep: rep}
	fa.mu.Lock()
	fa.updateAnswer = m.answer
	fa.mu.Unlock()
	fa.send(proto.MsgReport, rep)
	waitFor(f.t, name+" reported", 3*time.Second, func() bool {
		st, _ := f.e.h.snapshotOne(name)
		return st != nil && st.Report != nil && st.Report.MacOS != nil && st.Report.Agent.Version == version
	})
	f.c.json(http.MethodPatch, "/api/v1/servers/"+name, map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	f.agents[name] = fa
	return m
}

// helper is GET /agents' helper object of a server (nil: none).
func (f *updFixture) helper(name string) *model.MacHelperUpdate {
	f.t.Helper()
	var agents []struct {
		ID     string                 `json:"server_id"`
		Helper *model.MacHelperUpdate `json:"helper"`
	}
	f.c.json(http.MethodGet, "/api/v1/agents", nil, 200, &agents)
	for _, a := range agents {
		if a.ID == name {
			return a.Helper
		}
	}
	f.t.Fatalf("no agent %s", name)
	return nil
}

// helperEvents collects agent.helper_update events.
type helperEvents struct {
	mu  sync.Mutex
	evs []map[string]string
}

func (f *updFixture) helperEvents() *helperEvents {
	he := &helperEvents{}
	sub, _, _ := f.e.h.bus.Subscribe(0, store.RoleRank(store.RoleAdmin), 0)
	go func() {
		for ev := range sub.C {
			if ev.Name != "agent.helper_update" {
				continue
			}
			var m map[string]string
			json.Unmarshal(ev.Data, &m)
			he.mu.Lock()
			he.evs = append(he.evs, m)
			he.mu.Unlock()
		}
	}()
	f.t.Cleanup(func() { f.e.h.bus.Unsubscribe(sub) })
	return he
}

func (he *helperEvents) find(server, state string) map[string]string {
	he.mu.Lock()
	defer he.mu.Unlock()
	for _, ev := range he.evs {
		if ev["server"] == server && ev["state"] == state {
			return ev
		}
	}
	return nil
}

func components(reqs []proto.UpdateRequest) string {
	var s []string
	for _, r := range reqs {
		s = append(s, cmpOr(r.Component, "agent")+"@"+r.Version)
	}
	return strings.Join(s, " ")
}

func TestHelperUpdateRound(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	evs := f.helperEvents()
	studio := f.addMac("basalt", updBuild, helperOld, true)
	oldAgent := f.addMac("granite", updBuild, helperOld, false)
	current := f.addMac("shale", updBuild, helperNew, true)
	f.add("quartz", updBuild, "k1", nil)

	if u := f.helper("basalt"); u == nil || !u.Available || !u.Auto || u.Version != helperNew || u.Installed != helperOld || u.State != "" {
		t.Fatalf("basalt before: %+v", u)
	}
	if u := f.helper("granite"); u == nil || u.Available || u.ReasonCode != updUnsupported {
		t.Fatalf("granite: %+v", u)
	}
	if u := f.helper("shale"); u == nil || u.ReasonCode != updUpToDate {
		t.Fatalf("shale: %+v", u)
	}
	if u := f.helper("quartz"); u != nil {
		t.Fatalf("a Linux server has a helper: %+v", u)
	}
	var set map[string]any
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["helper_version"] != helperNew || set["helper_halted_version"] != nil {
		t.Fatalf("settings %v", set)
	}

	f.round()
	got := studio.sent()
	if len(got) != 1 || got[0].Component != proto.UpdateComponentHelper || got[0].Arch != proto.HelperArch ||
		got[0].Version != helperNew || got[0].Team != helperTm || got[0].Size != int64(len("PK helper "+helperNew)) {
		t.Fatalf("basalt got %+v", got)
	}
	if n := len(oldAgent.sent()) + len(current.sent()) + f.updates("quartz"); n != 0 {
		t.Fatalf("%d updates elsewhere", n)
	}
	if u := f.helper("basalt"); u.ReasonCode != updUpToDate || u.State != "" || u.UpdatedAt == "" || u.Installed != helperNew {
		t.Fatalf("basalt after: %+v", u)
	}
	recs := f.e.audit("agent.helper_updated")
	if len(recs) != 1 || recs[0].Outcome != "ok" || recs[0].Server != "basalt" || recs[0].Details["by"] != "auto" ||
		recs[0].Details["from"] != helperOld || recs[0].Details["version"] != helperNew || !strings.Contains(recs[0].Details["message"], "running") {
		t.Fatalf("audit %+v", recs)
	}
	if len(f.e.audit("agent.updated")) != 0 {
		t.Fatal("a helper update audited as the agent's")
	}
	waitFor(t, "events", 3*time.Second, func() bool {
		ev := evs.find("basalt", updStateUpdated)
		return ev != nil && ev["from"] == helperOld && ev["to"] == helperNew && ev["by"] == "auto"
	})
	if evs.find("basalt", updStateUpdating) == nil {
		t.Error("no updating event")
	}
	if f.event("basalt", updStateUpdating) != nil {
		t.Error("the helper's update shows as the agent's")
	}

	// The server detail says the hub's helper and how this Mac's follows it.
	var d struct {
		MacOS struct {
			Helper struct {
				Version *string                `json:"version"`
				Latest  *string                `json:"latest"`
				Update  *model.MacHelperUpdate `json:"update"`
			} `json:"helper"`
		} `json:"macos"`
	}
	f.c.json(http.MethodGet, "/api/v1/servers/basalt", nil, 200, &d)
	if h := d.MacOS.Helper; h.Version == nil || *h.Version != helperNew || h.Latest == nil || *h.Latest != helperNew ||
		h.Update == nil || h.Update.ReasonCode != updUpToDate {
		t.Fatalf("detail %+v", d.MacOS.Helper)
	}

	// Nothing more to do.
	f.round()
	if len(studio.sent()) != 1 {
		t.Fatal("sent again")
	}
}

// The agent's own update first, then the helper, in one round; a Mac whose
// old agent couldn't take the helper gets it once its agent is updated.
func TestHelperAfterAgent(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	withCaps := f.addMac("basalt", updOld, helperOld, true)
	withoutCaps := f.addMac("shale", updOld, helperOld, false)
	if u := f.helper("basalt"); !u.Auto || u.State != updStateWaiting || u.WaitingFor != waitAgent {
		t.Fatalf("basalt before: %+v", u)
	}
	if u := f.helper("shale"); u.ReasonCode != updUnsupported {
		t.Fatalf("shale before: %+v", u)
	}
	f.round()
	for name, m := range map[string]*macAgent{"basalt": withCaps, "shale": withoutCaps} {
		if c := components(m.sent()); c != "agent@"+updBuild+" helper@"+helperNew {
			t.Errorf("%s got %s", name, c)
		}
		if u := f.helper(name); u.ReasonCode != updUpToDate {
			t.Errorf("%s after: %+v", name, u)
		}
	}
	if len(f.e.audit("agent.updated")) != 2 || len(f.e.audit("agent.helper_updated")) != 2 {
		t.Fatalf("audits %s", fmtRecs(append(f.e.audit("agent.updated"), f.e.audit("agent.helper_updated")...)))
	}
}

func TestHelperFailsAndHalts(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	evs := f.helperEvents()
	basalt := f.addMac("basalt", updBuild, helperOld, true)
	shale := f.addMac("shale", updBuild, helperOld, true)
	basalt.mu.Lock()
	basalt.helperAnswer = &proto.UpdateResponse{Code: helperNoAnswerCode, Message: "the new Whombat Helper didn't answer; the previous one is back"}
	basalt.mu.Unlock()

	f.round() // basalt's helper doesn't answer: the helper updates stop before shale
	if len(basalt.sent()) != 1 || len(shale.sent()) != 0 {
		t.Fatalf("sent %d %d", len(basalt.sent()), len(shale.sent()))
	}
	if u := f.helper("basalt"); u.State != updStateFailed || u.FailedVersion != helperNew || u.Auto || !strings.Contains(u.Message, "previous one is back") {
		t.Fatalf("basalt: %+v", u)
	}
	if u := f.helper("shale"); u.State != updStateHalted || u.Auto {
		t.Fatalf("shale: %+v", u)
	}
	var set map[string]any
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["helper_halted_version"] != helperNew || set["halted_version"] != nil {
		t.Fatalf("settings %v", set)
	}
	if len(f.e.audit("agent.helper_update_halted")) != 1 {
		t.Error("halt not audited")
	}
	if r := f.e.audit("agent.helper_updated"); len(r) != 1 || r[0].Outcome != "error" || r[0].Code != "update_failed" {
		t.Fatalf("audit %s", fmtRecs(r))
	}
	waitFor(t, "events", 3*time.Second, func() bool {
		return evs.find("basalt", updStateFailed) != nil && evs.find("shale", updStateHalted) != nil
	})
	// Kept across a restart of the hub's state.
	if v, ok, _ := f.e.h.store.GetMeta(context.Background(), metaHelperMarks); !ok || !strings.Contains(v, helperNew) {
		t.Fatalf("marks %q", v)
	}
	f.round()
	if len(basalt.sent()) != 1 || len(shale.sent()) != 0 {
		t.Fatal("tried again by the round")
	}

	// Try again on basalt: its mark and the halt go, and it updates.
	basalt.mu.Lock()
	basalt.helperAnswer = nil
	basalt.mu.Unlock()
	var acc map[string]any
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, 202, &acc)
	if fmt.Sprint(acc["servers"]) != "[]" || fmt.Sprint(acc["helpers"]) != "[basalt]" || acc["helper_version"] != helperNew {
		t.Fatalf("accepted %v", acc)
	}
	waitFor(t, "basalt updated", 3*time.Second, func() bool { return f.helper("basalt").ReasonCode == updUpToDate })
	waitFor(t, "audited", 3*time.Second, func() bool { return len(f.e.audit("agent.helper_updated")) == 2 })
	if r := f.e.audit("agent.helper_updated")[0]; r.Outcome != "ok" || r.Details["by"] != "john" {
		t.Fatalf("manual audit %+v", r)
	}
	if u := f.helper("shale"); !u.Auto || u.State != "" {
		t.Fatalf("shale after the halt: %+v", u)
	}

	// Another failure is shale's alone: no halt.
	shale.mu.Lock()
	shale.helperAnswer = &proto.UpdateResponse{Code: "install_failed", Message: "the new Whombat Helper's signature doesn't verify"}
	shale.mu.Unlock()
	f.round()
	if u := f.helper("shale"); u.State != updStateFailed {
		t.Fatalf("shale: %+v", u)
	}
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["helper_halted_version"] != nil {
		t.Fatalf("halted by an install failure: %v", set)
	}
}

func TestHelperSwitchesAndWaits(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	mac := f.addMac("basalt", updBuild, helperOld, true)

	// The hub's host shell switch off.
	f.c.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": false}}, 200, nil)
	if u := f.helper("basalt"); u.Available || u.ReasonCode != updHostShellOff {
		t.Fatalf("host shell off: %+v", u)
	}
	f.round()
	if code, b, _ := f.c.req(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, nil); code != 409 {
		t.Fatalf("nothing to update: %d %s", code, b)
	}
	f.c.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)

	// A console open on the Mac: the helper waits.
	mac.mu.Lock()
	busy := *mac.rep
	busy.Agent.ConsolesOpen = 1
	mac.rep = &busy
	mac.fa.send(proto.MsgReport, &busy)
	mac.mu.Unlock()
	waitFor(t, "console", 3*time.Second, func() bool { return f.helper("basalt").WaitingFor == waitConsole })
	f.round()
	if len(mac.sent()) != 0 {
		t.Fatal("sent during a console")
	}
	mac.mu.Lock()
	free := *mac.rep
	free.Agent.ConsolesOpen = 0
	mac.rep = &free
	mac.fa.send(proto.MsgReport, &free)
	mac.mu.Unlock()
	waitFor(t, "free", 3*time.Second, func() bool { return f.helper("basalt").State == "" })

	// Keep agents up to date off: the round leaves it, Update now doesn't.
	f.c.json(http.MethodPatch, "/api/v1/agents/settings", map[string]any{"auto_update": false}, 200, nil)
	if u := f.helper("basalt"); !u.Available || u.Auto {
		t.Fatalf("setting off: %+v", u)
	}
	f.round()
	if len(mac.sent()) != 0 {
		t.Fatal("the round ran with the setting off")
	}
	var acc map[string]any
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{}, 202, &acc)
	if fmt.Sprint(acc["helpers"]) != "[basalt]" {
		t.Fatalf("accepted %v", acc)
	}
	waitFor(t, "updated", 3*time.Second, func() bool { return f.helper("basalt").ReasonCode == updUpToDate })
	if c := components(mac.sent()); c != "helper@"+helperNew {
		t.Fatalf("sent %s", c)
	}
}

// A Mac whose agent has no capability is never sent a helper, whatever is
// asked.
func TestHelperNeverToOldAgents(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	old := f.addMac("basalt", updBuild, helperOld, false)
	f.round()
	if code, _, _ := f.c.req(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, nil); code != 409 {
		t.Fatalf("Update now: %d", code)
	}
	if _, err := f.e.h.helperOne(context.Background(), "basalt", mustManifest(t, f.e.h)); err == nil {
		t.Fatal("helperOne sent to an old agent")
	}
	if len(old.sent()) != 0 {
		t.Fatalf("sent %s", components(old.sent()))
	}
}

func mustManifest(t *testing.T, h *Hub) *agentManifest {
	t.Helper()
	m, err := h.manifest()
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The team comes from the description beside the zip, only when it
// describes that zip.
func TestHelperTeam(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.withHelper(helperNew)
	m := mustManifest(t, f.e.h)
	hf, ok := m.helper()
	if !ok || f.e.h.helperTeam(hf) != helperTm {
		t.Fatalf("team %q", f.e.h.helperTeam(hf))
	}
	hf.SHA256 = strings.Repeat("00", 32)
	if team := f.e.h.helperTeam(hf); team != "" {
		t.Fatalf("a description of another zip gave team %q", team)
	}
}

// install.sh writes the LaunchAgent the agent writes when it is missing.
func TestHelperLaunchAgentMatchesInstaller(t *testing.T) {
	const start, end = "cat > \"$HELPER_PLIST\" <<'PLIST'\n", "PLIST\n"
	var b strings.Builder
	if err := installTmpl.Execute(&b, map[string]string{"HelperSum": "ab", "HelperVersion": helperNew}); err != nil {
		t.Fatal(err)
	}
	script := b.String()
	i := strings.Index(script, start)
	if i < 0 {
		t.Fatal("install.sh writes no LaunchAgent")
	}
	body := script[i+len(start):]
	body = body[:strings.Index(body, end)]
	if body != screen.HelperLaunchAgent(screen.DefaultHelperApp) {
		t.Fatalf("install.sh's LaunchAgent:\n%s\nthe agent's:\n%s", body, screen.HelperLaunchAgent(screen.DefaultHelperApp))
	}
}
