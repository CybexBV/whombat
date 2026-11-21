package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent/diagnose"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

const (
	updOld   = "0.0.0-20261018094703.5394c53"
	updBuild = "0.0.0-20261020101500.abc1234"
)

func TestUpdateReasons(t *testing.T) {
	m := &agentManifest{Version: updBuild, Key: "k1"}
	st := func(version, key string, allow bool) *model.ServerState {
		r := &proto.Report{}
		r.Agent.Version, r.Agent.UpdateKey, r.Policy.Update = version, key, allow
		return &model.ServerState{ID: "s", Connected: true, Report: r}
	}
	cases := []struct {
		name string
		st   *model.ServerState
		m    *agentManifest
		code string
	}{
		{"older", st(updOld, "k1", true), m, ""},
		{"no build", st(updOld, "k1", true), nil, updNoBuild},
		{"offline", &model.ServerState{ID: "s", Report: st(updOld, "k1", true).Report}, m, updNotConnected},
		{"no report", &model.ServerState{ID: "s", Connected: true}, m, updNotConnected},
		{"same", st(updBuild, "k1", true), m, updUpToDate},
		{"no key", st(updOld, "", true), m, updNoKey},
		{"no key, same version", st(updBuild, "", false), m, updNoKey},
		{"other key", st(updOld, "k2", true), m, updOtherKey},
		{"turned off", st(updOld, "k1", false), m, updTurnedOff},
		{"newer", st("0.0.0-20261021000000.fff0000", "k1", true), m, updNewer},
		{"unknown order", st("dev", "k1", true), m, updNewer},
	}
	for _, c := range cases {
		if code, reason := updateReason(c.st, c.m); code != c.code || (code != "" && reason == "") {
			t.Errorf("%s: %q %q, want %q", c.name, code, reason, c.code)
		}
	}
}

func TestLastInstallCommand(t *testing.T) {
	fetch := fetchCommand("sha256//abc=")
	sys := lastInstallCommand("systemd", fetch, "https://10.100.0.7:8443", "", updBuild, 1760950000)
	for _, want := range []string{"systemd-run --quiet --collect --unit=whombat-agent-reinstall-1760950000 ",
		"/bin/sh /var/lib/whombat-agent/last-install.sh", "--pinnedpubkey", "https://10.100.0.7:8443/install.sh >", lastInstallLog, lastInstallOK, updBuild} {
		if !strings.Contains(sys, want) {
			t.Errorf("systemd: no %q in %s", want, sys)
		}
	}
	for _, kind := range []string{"openrc", "sysv", "unraid"} {
		cmd := lastInstallCommand(kind, fetch, "https://10.100.0.7:8443", "", updBuild, 1)
		for _, want := range []string{"setsid /bin/sh /var/lib/whombat-agent/last-install.sh ", "/install.sh >", "last-install.pid", lastInstallOK} {
			if !strings.Contains(cmd, want) {
				t.Errorf("%s: no %q in %s", kind, want, cmd)
			}
		}
		if strings.Contains(cmd, "systemd-run") {
			t.Errorf("%s uses systemd-run", kind)
		}
	}
	// HS-162: an agent behind a forwarded port fetches from, and stays on,
	// the address it dials.
	fwd := lastInstallCommand("systemd", fetch, "https://127.0.0.1:18443", "wss://127.0.0.1:18443", updBuild, 1)
	for _, want := range []string{"https://127.0.0.1:18443/install.sh >", "--hub 'wss://127.0.0.1:18443'"} {
		if !strings.Contains(fwd, want) {
			t.Errorf("forwarded: no %q in %s", want, fwd)
		}
	}
	for _, cmd := range []string{sys, fwd, lastInstallCommand("unraid", fetch, "https://h:8443", "", updBuild, 1)} {
		// No enrollment and nothing that changes the agent's policy: what the
		// server's owner switched off on the server stays off.
		for _, flag := range []string{"sudo", "--token", "--enroll", "--control", "--force", "policy set", "| sh"} {
			if strings.Contains(cmd, flag) {
				t.Errorf("not the plain update command (%s): %s", flag, cmd)
			}
		}
		if out, err := exec.Command("/bin/sh", "-n", "-c", cmd).CombinedOutput(); err != nil {
			t.Errorf("not shell: %v %s", err, out)
		}
	}
	if strings.Contains(sys, "--hub") {
		t.Errorf("--hub without a dialed address: %s", sys)
	}
}

func TestInstallEnded(t *testing.T) {
	for log, want := range map[string]string{
		"whombat-agent: last install of x\n":                                                 "",
		"whombat-agent: last install of x\ncurl: (7) no\nwhombat-agent: install ended (7)\n": "7",
		"whombat-agent: install ended (0)\n":                                                 "0",
	} {
		if got := installEnded(log); got != want {
			t.Errorf("%q: %q, want %q", log, got, want)
		}
	}
}

// TestLastInstallOutlivesExec runs the command the way an agent without
// systemd runs exec (the agent's own Exec, unchanged since 5394c53): in a
// process group that is killed once the shell exits. The install must go
// on after that.
func TestLastInstallOutlivesExec(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid")
	}
	if _, err := os.Stat("/usr/bin/curl"); err != nil {
		t.Skip("no curl in the exec PATH")
	}
	t.Setenv("INVOCATION_ID", "") // not under systemd: the process group path
	dir := t.TempDir()
	served := filepath.Join(dir, "served")
	os.Mkdir(served, 0o755)
	gate := filepath.Join(dir, "gate")
	done := filepath.Join(dir, "done")
	// The "installer" waits until the exec has ended, then writes done.
	os.WriteFile(filepath.Join(served, "install.sh"), []byte(fmt.Sprintf(
		"i=0; while [ ! -e %s ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; echo installed > %s\n", gate, done)), 0o644)
	cmd := lastInstallCommandIn(filepath.Join(dir, "state"), "unraid", "cat", served, "", updBuild, 1)
	d := diagnose.New(nil, nil)
	resp := d.Exec(context.Background(), proto.ExecRequest{Command: cmd, TimeoutS: 30})
	if resp.ExitCode != 0 || !strings.Contains(resp.Output, lastInstallOK) {
		t.Fatalf("exec: %+v", resp)
	}
	os.WriteFile(gate, nil, 0o644) // the exec's process group is gone by now
	waitFor(t, "the detached install", 10*time.Second, func() bool {
		b, _ := os.ReadFile(done)
		return string(b) == "installed\n"
	})
	waitFor(t, "its log", 5*time.Second, func() bool {
		b, _ := os.ReadFile(filepath.Join(dir, "state", "last-install.log"))
		return strings.Contains(string(b), "install ended (0)") && strings.Contains(string(b), updBuild)
	})
}

// ---- the round and the routes, with fake agents ---------------------------------------

type updFixture struct {
	t      *testing.T
	e      *env
	c      *client
	agents map[string]*fakeAgent
	sub    *Sub
	mu     sync.Mutex
	events []map[string]string
}

func newUpdFixture(t *testing.T, headless bool, tweak func(*Config)) *updFixture {
	dist := t.TempDir()
	bin := []byte("agent-binary")
	os.WriteFile(filepath.Join(dist, "whombat-agent-linux-amd64"), bin, 0o644)
	man := fmt.Sprintf(`{"version":%q,"key":"k1","files":{"whombat-agent-linux-amd64":{"arch":"amd64","size":%d,"sha256":"%s","sig":"c2ln"}}}`,
		updBuild, len(bin), strings.Repeat("ab", 32))
	os.WriteFile(filepath.Join(dist, "manifest.json"), []byte(man), 0o644)
	cfgTweak := func(c *Config) {
		c.AgentDist = dist
		c.AgentURL = "wss://10.100.0.7:8443"
		c.AgentUpdateGrace = time.Hour // rounds run when the test says
		c.AgentUpdateTick = 10 * time.Millisecond
		c.AgentUpdateWait = 400 * time.Millisecond
		c.AgentInstallWait = 2 * time.Second
		c.AgentUpdatePoll = 10 * time.Millisecond
		if tweak != nil {
			tweak(c)
		}
	}
	f := &updFixture{t: t, agents: map[string]*fakeAgent{}}
	if headless {
		f.e = headlessEnv(t, cfgTweak)
		f.c = f.e.service("pe_1|John")
	} else {
		f.e, f.c = adminEnv(t, cfgTweak)
	}
	f.sub, _, _ = f.e.h.bus.Subscribe(0, store.RoleRank(store.RoleAdmin), 0)
	go func() {
		for ev := range f.sub.C {
			if ev.Name != "agent.update" {
				continue
			}
			var m map[string]string
			json.Unmarshal(ev.Data, &m)
			f.mu.Lock()
			f.events = append(f.events, m)
			f.mu.Unlock()
		}
	}()
	t.Cleanup(func() { f.e.h.bus.Unsubscribe(f.sub) })
	return f
}

// add enrolls a fake agent reporting version and key (install systemd,
// amd64); it comes back on the new version when it takes an update.
func (f *updFixture) add(name, version, key string, mod func(*proto.Report)) *fakeAgent {
	fa := f.e.enroll(f.c, name, "Lab")
	fa.policy = proto.Policy{Update: key != "", Console: true}
	fa.version = version
	if _, err := fa.dial(proto.Hello{}); err != nil {
		f.t.Fatal(err)
	}
	rep := fa.report(name)
	rep.Agent.Version, rep.Agent.UpdateKey, rep.Agent.Arch, rep.Agent.Install = version, key, "amd64", "systemd"
	if mod != nil {
		mod(rep)
	}
	fa.updateAnswer = func(req proto.UpdateRequest) proto.UpdateResponse {
		next := *rep
		next.Agent.Version = req.Version
		fa.send(proto.MsgReport, &next)
		return proto.UpdateResponse{OK: true}
	}
	fa.send(proto.MsgReport, rep)
	waitFor(f.t, name+" reported", 3*time.Second, func() bool {
		st, _ := f.e.h.snapshotOne(name)
		return st != nil && st.Report != nil && st.Report.Agent.Version == version
	})
	f.agents[name] = fa
	return fa
}

func (f *updFixture) info(name string) updateInfo {
	var agents []struct {
		ID     string     `json:"server_id"`
		Update updateInfo `json:"update"`
	}
	f.c.json(http.MethodGet, "/api/v1/agents", nil, 200, &agents)
	for _, a := range agents {
		if a.ID == name {
			return a.Update
		}
	}
	f.t.Fatalf("no agent %s", name)
	return updateInfo{}
}

func (f *updFixture) updates(name string) int {
	fa := f.agents[name]
	fa.mu.Lock()
	defer fa.mu.Unlock()
	return len(fa.updates)
}

func (f *updFixture) event(server, state string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ev := range f.events {
		if ev["server"] == server && ev["state"] == state {
			return ev
		}
	}
	return nil
}

func (f *updFixture) round() {
	f.t.Helper()
	if !f.e.h.autoRound(context.Background()) {
		f.t.Fatal("the round found a rollout running")
	}
}

func TestAgentAutoRound(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.add("basalt", updOld, "k1", nil)
	f.add("shale", updOld, "k1", func(r *proto.Report) {
		r.System.PackageTask = &proto.PackageTask{ID: "pkg:0123456789abcdef", Op: "install", Started: time.Now()}
	})
	f.add("granite", updBuild, "k1", nil)
	if u := f.info("basalt"); !u.Available || !u.Auto || u.State != "" || u.ReasonCode != "" || u.CanInstall {
		t.Fatalf("basalt before: %+v", u)
	}
	if u := f.info("shale"); !u.Auto || u.State != updStateWaiting || u.WaitingFor != waitPackages {
		t.Fatalf("shale before: %+v", u)
	}
	if u := f.info("granite"); u.Available || u.Auto || u.ReasonCode != updUpToDate {
		t.Fatalf("granite: %+v", u)
	}

	f.round()
	if f.updates("basalt") != 1 || f.updates("shale") != 0 || f.updates("granite") != 0 {
		t.Fatalf("updates: %d %d %d", f.updates("basalt"), f.updates("shale"), f.updates("granite"))
	}
	u := f.info("basalt")
	if u.ReasonCode != updUpToDate || u.State != "" || u.UpdatedAt == "" {
		t.Fatalf("basalt after: %+v", u)
	}
	recs := f.e.audit("agent.updated")
	if len(recs) != 1 || recs[0].Outcome != "ok" || recs[0].Details["by"] != "auto" || recs[0].Details["from"] != updOld ||
		recs[0].Details["version"] != updBuild {
		t.Fatalf("audit %+v", recs)
	}
	waitFor(t, "events", 3*time.Second, func() bool {
		ev := f.event("basalt", updStateUpdated)
		return ev != nil && ev["from"] == updOld && ev["to"] == updBuild && f.event("shale", updStateWaiting) != nil
	})
	if f.event("basalt", updStateUpdating) == nil {
		t.Error("no updating event")
	}

	// A console open on shale once the packages are done: still waiting.
	fa := f.agents["shale"]
	rep := fa.report("shale")
	rep.Agent.Version, rep.Agent.UpdateKey, rep.Agent.Arch, rep.Agent.ConsolesOpen = updOld, "k1", "amd64", 1
	fa.send(proto.MsgReport, rep)
	waitFor(t, "console", 3*time.Second, func() bool { return f.info("shale").WaitingFor == waitConsole })
	f.round()
	if f.updates("shale") != 0 {
		t.Fatal("updated during a console")
	}
	// A libvirt task the agent runs itself.
	rep.Agent.ConsolesOpen = 0
	fa.send(proto.MsgReport, rep)
	f.e.h.tasks.add(&taskWatch{server: "shale", task: "libvirt:0123456789abcdef", started: time.Now(), next: time.Now().Add(time.Hour)})
	waitFor(t, "task", 3*time.Second, func() bool { return f.info("shale").WaitingFor == waitTask })
	f.e.h.tasks.mu.Lock()
	delete(f.e.h.tasks.m, "shale|libvirt:0123456789abcdef")
	f.e.h.tasks.mu.Unlock()
	f.round()
	if f.updates("shale") != 1 || f.info("shale").ReasonCode != updUpToDate {
		t.Fatalf("shale not updated once free: %d %+v", f.updates("shale"), f.info("shale"))
	}
}

func TestAgentRoundFailsAndHalts(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	basalt := f.add("basalt", updOld, "k1", nil)
	granite := f.add("granite", updOld, "k1", nil)
	f.add("shale", updOld, "k1", nil)
	basalt.mu.Lock()
	basalt.updateAnswer = func(proto.UpdateRequest) proto.UpdateResponse {
		return proto.UpdateResponse{Code: "install_failed", Message: "cannot install the new executable"}
	}
	basalt.mu.Unlock()
	granite.mu.Lock()
	granite.updateAnswer = func(proto.UpdateRequest) proto.UpdateResponse { return proto.UpdateResponse{OK: true} } // never back
	granite.mu.Unlock()

	f.round() // basalt fails, granite doesn't come back: the round stops before shale
	if f.updates("basalt") != 1 || f.updates("granite") != 1 || f.updates("shale") != 0 {
		t.Fatalf("updates: %d %d %d", f.updates("basalt"), f.updates("granite"), f.updates("shale"))
	}
	if u := f.info("basalt"); u.State != updStateFailed || u.FailedVersion != updBuild || u.Auto || !strings.Contains(u.Message, "cannot install") {
		t.Fatalf("basalt: %+v", u)
	}
	if u := f.info("granite"); u.State != updStateFailed || u.FailedVersion != updBuild {
		t.Fatalf("granite: %+v", u)
	}
	if u := f.info("shale"); u.State != updStateHalted || u.Auto {
		t.Fatalf("shale: %+v", u)
	}
	var set map[string]any
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["auto_update"] != true || set["halted_version"] != updBuild {
		t.Fatalf("settings %v", set)
	}
	waitFor(t, "halted event", 3*time.Second, func() bool {
		return f.event("shale", updStateHalted) != nil && f.event("basalt", updStateFailed) != nil
	})
	if len(f.e.audit("agent.update_halted")) != 1 {
		t.Error("halt not audited")
	}
	// Kept across a restart of the hub's state.
	if v, ok, _ := f.e.h.store.GetMeta(context.Background(), metaAgentMarks); !ok || !strings.Contains(v, updBuild) {
		t.Fatalf("marks %q", v)
	}

	// Not tried again by the round.
	f.round()
	if f.updates("basalt") != 1 || f.updates("shale") != 0 {
		t.Fatal("tried again")
	}

	// Try again on basalt: its mark and the halt go, and it updates.
	rep := basalt.report("basalt")
	rep.Agent.Version, rep.Agent.UpdateKey, rep.Agent.Arch = updOld, "k1", "amd64"
	basalt.mu.Lock()
	basalt.updateAnswer = func(req proto.UpdateRequest) proto.UpdateResponse {
		next := *rep
		next.Agent.Version = req.Version
		basalt.send(proto.MsgReport, &next)
		return proto.UpdateResponse{OK: true}
	}
	basalt.mu.Unlock()
	var acc map[string]any
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, 202, &acc)
	if fmt.Sprint(acc["servers"]) != "[basalt]" || fmt.Sprint(acc["installing"]) != "[]" {
		t.Fatalf("accepted %v", acc)
	}
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["halted_version"] != nil {
		t.Fatalf("halt not cleared: %v", set)
	}
	waitFor(t, "basalt updated", 3*time.Second, func() bool { return f.info("basalt").ReasonCode == updUpToDate })
	// Its new version shows as soon as its report arrives; the hub writes the
	// audit only after that, when the update call returns.
	waitFor(t, "basalt's update audited", 3*time.Second, func() bool { return len(f.e.audit("agent.updated")) == 3 })
	recs := f.e.audit("agent.updated")
	if recs[0].Outcome != "ok" || recs[0].Details["by"] != "john" {
		t.Fatalf("manual audit %+v", recs[0])
	}
	if u := f.info("shale"); !u.Auto || u.State != "" {
		t.Fatalf("shale after the halt: %+v", u)
	}
}

func TestAgentRoundOneAtATime(t *testing.T) {
	f := newUpdFixture(t, false, nil)
	f.add("basalt", updOld, "k1", nil)
	if !f.e.h.rolloutBegin() {
		t.Fatal("rollout taken")
	}
	if f.e.h.autoRound(context.Background()) {
		t.Fatal("the round ran beside a rollout")
	}
	if code, b, _ := f.c.req(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, nil); code != 409 ||
		!strings.Contains(string(b), "update_running") {
		t.Fatalf("second rollout: %d %s", code, b)
	}
	f.e.h.rolloutEnd()
	f.round()
	if f.updates("basalt") != 1 {
		t.Fatal("not updated")
	}
}

func TestAgentUpdateSetting(t *testing.T) {
	f := newUpdFixture(t, true, nil)
	f.add("basalt", updOld, "k1", nil)
	var set map[string]any
	f.c.json(http.MethodGet, "/api/v1/agents/settings", nil, 200, &set)
	if set["auto_update"] != true || set["halted_version"] != nil {
		t.Fatalf("default %v", set)
	}
	f.c.json(http.MethodPatch, "/api/v1/agents/settings", map[string]any{"auto_update": false}, 200, &set)
	if set["auto_update"] != false {
		t.Fatalf("patched %v", set)
	}
	if recs := f.e.audit("agent.settings_changed"); len(recs) != 1 || recs[0].Details["auto_update"] != "false" {
		t.Fatalf("audit %+v", recs)
	}
	if code, _, _ := f.c.req(http.MethodPatch, "/api/v1/agents/settings", map[string]any{}, nil); code != 400 {
		t.Errorf("empty patch: %d", code)
	}
	if code, _, _ := f.c.req(http.MethodPatch, "/api/v1/agents/settings", map[string]any{"auto_update": true, "x": 1}, nil); code != 400 {
		t.Errorf("unknown field: %d", code)
	}
	if u := f.info("basalt"); !u.Available || u.Auto {
		t.Fatalf("off: %+v", u)
	}
	f.round()
	if f.updates("basalt") != 0 {
		t.Fatal("updated while off")
	}
	if v, _, _ := f.e.h.store.GetMeta(context.Background(), metaAgentAutoUpdate); v != "false" {
		t.Fatalf("not kept: %q", v)
	}
	// Update now still works (the service token needs no re-authentication).
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"basalt"}}, 202, nil)
	waitFor(t, "updated", 3*time.Second, func() bool { return f.info("basalt").ReasonCode == updUpToDate })
}

// TestAgentRoundSchedule: the first round after the start grace, a
// minute (here: a moment) after an older agent connected, then every
// interval.
func TestAgentRoundSchedule(t *testing.T) {
	f := newUpdFixture(t, false, func(c *Config) { c.AgentUpdateKick = 300 * time.Millisecond })
	next := func() time.Duration {
		s := f.e.h.agentUpdates()
		s.mu.Lock()
		defer s.mu.Unlock()
		return time.Until(s.next)
	}
	waitFor(t, "the loop", 3*time.Second, func() bool { d := next(); return d > 59*time.Minute && d <= time.Hour })
	f.add("basalt", updOld, "k1", nil)
	if d := next(); d > 300*time.Millisecond {
		t.Fatalf("not brought forward: %s", d)
	}
	waitFor(t, "the round after basalt connected", 5*time.Second, func() bool { return f.updates("basalt") == 1 })
	if d := next(); d < 14*time.Minute || d > 15*time.Minute {
		t.Fatalf("next round in %s", d)
	}
	// An agent on the build's version doesn't bring it forward.
	f.add("granite", updBuild, "k1", nil)
	if d := next(); d < 14*time.Minute {
		t.Fatalf("brought forward by an up-to-date agent: %s", d)
	}
}

func TestAgentLastInstall(t *testing.T) {
	f := newUpdFixture(t, true, nil)
	fa := f.add("quartz", updOld, "", func(r *proto.Report) {
		r.Agent.Install = "unraid"
		r.Policy.HostShell = true
	})
	fa.policy.HostShell = true
	if u := f.info("quartz"); u.Available || u.ReasonCode != updNoKey || u.CanInstall || u.Auto {
		t.Fatalf("hub switch off: %+v", u)
	}
	if code, b, _ := f.c.req(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"quartz"}}, nil); code != 409 ||
		!strings.Contains(string(b), "needs_install") {
		t.Fatalf("without the host shell: %d %s", code, b)
	}
	f.c.json(http.MethodPatch, "/api/v1/servers/quartz", map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	if u := f.info("quartz"); !u.CanInstall || u.ReasonCode != updNoKey {
		t.Fatalf("can install: %+v", u)
	}
	// The round never does the last install.
	f.round()
	fa.mu.Lock()
	n := len(fa.execs)
	fa.mu.Unlock()
	if n != 0 {
		t.Fatal("the round ran the install")
	}
	rep := fa.report("quartz")
	rep.Agent.Arch, rep.Agent.Install, rep.Policy.HostShell = "amd64", "unraid", true
	fa.mu.Lock()
	fa.execAnswer = func(req proto.ExecRequest) proto.ExecResponse {
		if !strings.Contains(req.Command, "setsid") {
			return proto.ExecResponse{ExitCode: 1, Output: "wrong command"}
		}
		// The new agent connects with the key.
		next := *rep
		next.Agent.Version, next.Agent.UpdateKey = updBuild, "k1"
		go fa.send(proto.MsgReport, &next)
		return proto.ExecResponse{Output: lastInstallOK + "\n"}
	}
	fa.mu.Unlock()
	var acc map[string]any
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"quartz"}}, 202, &acc)
	if fmt.Sprint(acc["installing"]) != "[quartz]" {
		t.Fatalf("accepted %v", acc)
	}
	waitFor(t, "installed", 5*time.Second, func() bool { return len(f.e.audit("agent.updated")) == 1 })
	rec := f.e.audit("agent.updated")[0]
	if rec.Outcome != "ok" || rec.Details["by"] != "John (pe_1)" || rec.Details["from"] != updOld {
		t.Fatalf("audit %+v", rec)
	}
	fa.mu.Lock()
	cmd := fa.execs[0].Command
	fa.mu.Unlock()
	dialed := f.e.h.conn("quartz").dialed // the address the agent dials, not the agents' address (HS-162)
	if dialed == "" || !strings.Contains(cmd, "https://"+dialed+"/install.sh >") || !strings.Contains(cmd, "--hub 'wss://"+dialed+"'") || strings.Contains(cmd, "sudo") {
		t.Fatalf("command %s", cmd)
	}
	if recs := f.e.audit("exec.requested"); len(recs) != 1 || recs[0].Details["purpose"] != "agent_install" {
		t.Fatalf("exec audit %+v", recs)
	}
	if u := f.info("quartz"); u.ReasonCode != updUpToDate || u.CanInstall || u.UpdatedAt == "" {
		t.Fatalf("after: %+v", u)
	}
}

func TestAgentLastInstallFails(t *testing.T) {
	f := newUpdFixture(t, true, func(c *Config) { c.AgentInstallWait = 200 * time.Millisecond })
	fa := f.add("flint", updOld, "", func(r *proto.Report) { r.Policy.HostShell = true })
	f.c.json(http.MethodPatch, "/api/v1/servers/flint", map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	fa.mu.Lock()
	fa.execAnswer = func(req proto.ExecRequest) proto.ExecResponse {
		if strings.HasPrefix(req.Command, "tail ") {
			return proto.ExecResponse{Output: "install.sh: cannot reach https://10.100.0.7:8443/install.sh\nwhombat-agent: install ended (1)\n"}
		}
		if !strings.Contains(req.Command, "systemd-run") {
			return proto.ExecResponse{ExitCode: 1}
		}
		return proto.ExecResponse{Output: lastInstallOK + "\n"}
	}
	fa.mu.Unlock()
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"flint"}}, 202, nil)
	waitFor(t, "failed", 5*time.Second, func() bool { return f.info("flint").State == updStateFailed })
	if u := f.info("flint"); !strings.Contains(u.Message, "cannot reach") || !u.CanInstall {
		t.Fatalf("failed: %+v", u)
	}
	if f.e.h.agentSettingsJSON()["halted_version"] != (*string)(nil) {
		t.Fatal("a failed last install halted the updates")
	}
}

// TestAgentLastInstallStopsEarly: an install that ended without restarting
// the agent (here: install.sh could not be fetched) fails the update as
// soon as its log says so, not after AgentInstallWait, so the next server
// isn't told another update is running (HS-162).
func TestAgentLastInstallStopsEarly(t *testing.T) {
	f := newUpdFixture(t, true, func(c *Config) { c.AgentInstallWait = time.Hour })
	fa := f.add("flint", updOld, "", func(r *proto.Report) { r.Policy.HostShell = true })
	f.add("granite", updOld, "", func(r *proto.Report) { r.Policy.HostShell = true })
	for _, id := range []string{"flint", "granite"} {
		f.c.json(http.MethodPatch, "/api/v1/servers/"+id, map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	}
	fa.mu.Lock()
	fa.execAnswer = func(req proto.ExecRequest) proto.ExecResponse {
		if strings.HasPrefix(req.Command, "tail ") {
			return proto.ExecResponse{Output: "whombat-agent: last install of " + updBuild + "\ncurl: (7) Failed to connect to 10.100.1.160 port 8443\nwhombat-agent: install ended (7)\n"}
		}
		return proto.ExecResponse{Output: lastInstallOK + "\n"}
	}
	fa.mu.Unlock()
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"flint"}}, 202, nil)
	waitFor(t, "failed", 10*time.Second, func() bool { return f.info("flint").State == updStateFailed })
	if u := f.info("flint"); !strings.Contains(u.Message, "Failed to connect") {
		t.Fatalf("failed: %+v", u)
	}
	waitFor(t, "the rollout's end", 5*time.Second, func() bool {
		s := f.e.h.agentUpdates()
		s.mu.Lock()
		defer s.mu.Unlock()
		return !s.running
	})
	f.c.json(http.MethodPost, "/api/v1/agents/update", map[string]any{"servers": []string{"granite"}}, 202, nil)
}
