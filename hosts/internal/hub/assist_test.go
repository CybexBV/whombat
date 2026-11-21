package hub

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/assist"
	"rackoon/internal/proto"
)

// fakeRunner stands in for rackoon-assist: it reports Claude Code as
// installed and signed in, and plays a script for every session it starts.
type fakeRunner struct {
	t      *testing.T
	peer   *assist.Peer
	mu     sync.Mutex
	starts []assist.SessionStart
	sends  []assist.SessionSend
	closed []string
	// script runs a session: tool calls through call, output through emit.
	script func(s assist.SessionStart, call func(name string, args any) assist.ToolResult, emit func(assist.SessionEvent))
}

func (f *fakeRunner) dial(ctx context.Context) (io.ReadWriteCloser, error) {
	hubSide, runnerSide := net.Pipe()
	f.peer = assist.NewPeer(runnerSide, f.handle, nil)
	f.peer.Start()
	return hubSide, nil
}

func (f *fakeRunner) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case assist.MStatus:
		return assist.Status{Version: "test", Sandboxed: true, Providers: map[string]assist.ProviderStatus{
			assist.Claude: {Installed: true, Version: "2.1.292", SignedIn: true, Account: "Claude subscription"},
			assist.Codex:  {}}}, nil
	case assist.MSessionStart:
		var s assist.SessionStart
		json.Unmarshal(raw, &s)
		f.mu.Lock()
		f.starts = append(f.starts, s)
		script := f.script
		f.mu.Unlock()
		emit := func(ev assist.SessionEvent) {
			ev.Session = s.Session
			f.peer.Notify(assist.NEvent, ev)
		}
		call := func(name string, args any) assist.ToolResult {
			b, _ := json.Marshal(args)
			var res assist.ToolResult
			if err := f.peer.Call(context.Background(), assist.MToolCall, assist.ToolCall{Session: s.Session, Name: name, Args: b}, &res); err != nil {
				f.t.Errorf("tool %s: %v", name, err)
			}
			return res
		}
		go func() {
			emit(assist.SessionEvent{Kind: assist.EvStarted, ProviderSession: "cli-" + s.Session})
			if script != nil {
				script(s, call, emit)
			}
			emit(assist.SessionEvent{Kind: assist.EvTurnEnd})
		}()
		return struct{}{}, nil
	case assist.MSessionSend:
		var s assist.SessionSend
		json.Unmarshal(raw, &s)
		f.mu.Lock()
		f.sends = append(f.sends, s)
		f.mu.Unlock()
		return struct{}{}, nil
	case assist.MSessionClose, assist.MSessionInterrupt:
		var s assist.SessionRef
		json.Unmarshal(raw, &s)
		f.mu.Lock()
		f.closed = append(f.closed, s.Session)
		f.mu.Unlock()
		return struct{}{}, nil
	}
	return nil, &assist.RPCError{Code: assist.ErrMethodNotFound, Message: method}
}

type invDetail struct {
	Investigation investigationJSON `json:"investigation"`
	Events        []map[string]any  `json:"events"`
}

func kinds(evs []map[string]any) string {
	var out []string
	for _, e := range evs {
		out = append(out, e["kind"].(string))
	}
	return strings.Join(out, ",")
}

func assistEnv(t *testing.T) (*env, *client, *fakeAgent, *fakeRunner) {
	e, admin := adminEnv(t, nil)
	fr := &fakeRunner{t: t}
	e.h.assist.dial = fr.dial
	fa := e.enroll(admin, "shale", "Production")
	fa.policy = proto.Policy{Console: true, Power: true, HostShell: true, Diagnose: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("shale"))
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("shale"); return st != nil && st.Report != nil })
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"power": true, "host_shell": true}}, 200, nil)
	return e, admin, fa, fr
}

func TestAssistantInvestigation(t *testing.T) {
	e, admin, fa, fr := assistEnv(t)
	start := map[string]any{"server": "shale", "prompt": "Why is the array degraded?"}
	if p := admin.problem(http.MethodPost, "/api/v1/assistant/investigations", start, 409); p.Code != "assistant_disabled" {
		t.Fatalf("disabled: %+v", p)
	}
	var st assistantStateJSON
	admin.json(http.MethodGet, "/api/v1/assistant", nil, 200, &st)
	if !st.Runner.Connected || !st.Providers["claude"].SignedIn || st.Settings.Access != accessFull || st.Settings.AutoInvestigate != "off" {
		t.Fatalf("state = %+v", st)
	}
	admin.json(http.MethodPut, "/api/v1/assistant/settings", map[string]any{"enabled": true, "access": "ask"}, 200, &st)
	if recs := e.audit("assistant.settings_updated"); len(recs) != 1 || recs[0].Details["changed"] != "enabled, access" {
		t.Errorf("settings audit = %s", fmtRecs(recs))
	}
	// Diagnostics are on by default on a new server.
	if s, _ := e.h.snapshotOne("shale"); !s.RCDiagnose {
		t.Errorf("rc_diagnose off on a new server")
	}

	results := make(chan assist.ToolResult, 8)
	fr.script = func(s assist.SessionStart, call func(string, any) assist.ToolResult, emit func(assist.SessionEvent)) {
		results <- call("list_hosts", map[string]any{})
		results <- call("diagnose", map[string]any{"host": "shale", "check": "unraid"})
		emit(assist.SessionEvent{Kind: assist.EvText, Text: "disk3 is **disabled**."})
		results <- call("run_command", map[string]any{"host": "shale", "command": "smartctl -t short /dev/sdc", "reason": "Confirm the disk fails."})
		results <- call("finish", map[string]any{"summary": "disk3 (sdc) is failing.", "resolved": false})
	}
	var inv investigationJSON
	admin.json(http.MethodPost, "/api/v1/assistant/investigations", start, 201, &inv)
	if inv.Server == nil || *inv.Server != "shale" || inv.Access != accessAsk || inv.Title != "Why is the array degraded?" {
		t.Fatalf("investigation = %+v", inv)
	}
	if r := <-results; r.IsError || !strings.Contains(r.Text, `"run_command": "with approval"`) {
		t.Errorf("list_hosts = %+v", r)
	}
	if r := <-results; r.IsError || !strings.Contains(r.Text, "rdevStatus.3=DISK_DSBL") {
		t.Errorf("diagnose = %+v", r)
	}
	// run_command waits for the admin.
	var d invDetail
	waitFor(t, "approval", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/assistant/investigations/"+inv.ID, nil, 200, &d)
		if d.Investigation.State != invWaiting {
			return false
		}
		for _, ev := range d.Events { // the state may be written before the event
			if ev["kind"] == "approval" {
				return true
			}
		}
		return false
	})
	var aid string
	for _, ev := range d.Events {
		if ev["kind"] == "approval" {
			aid = ev["approval_id"].(string)
			if ev["command"] != "smartctl -t short /dev/sdc" || ev["reason"] != "Confirm the disk fails." {
				t.Errorf("approval = %v", ev)
			}
		}
	}
	if len(fa.execs) != 0 || d.Investigation.PendingApprovals != 1 {
		t.Fatalf("ran before the approval: %v %+v", fa.execs, d.Investigation)
	}
	admin.json(http.MethodPost, "/api/v1/assistant/investigations/"+inv.ID+"/approvals/"+aid, map[string]any{"approve": true}, 200, nil)
	if r := <-results; r.IsError || !strings.Contains(r.Text, "exit code 0") || !strings.Contains(r.Text, "SMART self-test started") {
		t.Errorf("run_command = %+v", r)
	}
	<-results // finish
	waitFor(t, "done", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/assistant/investigations/"+inv.ID, nil, 200, &d)
		return d.Investigation.State == invDone
	})
	if got := kinds(d.Events); got != "user,tool,tool_result,tool,tool_result,assistant,tool,approval,approval_decided,tool_result,tool,summary,tool_result" {
		t.Errorf("events = %s", got)
	}
	if d.Investigation.Summary == nil || *d.Investigation.Summary != "disk3 (sdc) is failing." || d.Investigation.Resolved == nil || *d.Investigation.Resolved {
		t.Errorf("summary = %+v", d.Investigation)
	}
	fa.mu.Lock()
	if len(fa.diagnoses) != 1 || fa.diagnoses[0].Check != "unraid" || len(fa.execs) != 1 || fa.execs[0].Command != "smartctl -t short /dev/sdc" {
		t.Errorf("agent got %v %v", fa.diagnoses, fa.execs)
	}
	fa.mu.Unlock()
	if recs := e.audit("assistant.command"); len(recs) != 1 || recs[0].Server != "shale" || recs[0].Details["command"] != "smartctl -t short /dev/sdc" {
		t.Errorf("command audit = %s", fmtRecs(recs))
	}
	fr.mu.Lock()
	if len(fr.starts) != 1 || !strings.Contains(fr.starts[0].Prompt, "Why is the array degraded?") || !strings.Contains(fr.starts[0].System, "ASK") ||
		len(fr.starts[0].Tools) != 8 {
		t.Errorf("session start = %+v", fr.starts)
	}
	fr.mu.Unlock()

	// A reply resumes the CLI session (it is closed after each turn).
	fr.script = func(s assist.SessionStart, call func(string, any) assist.ToolResult, emit func(assist.SessionEvent)) {
		emit(assist.SessionEvent{Kind: assist.EvText, Text: "Replace it."})
	}
	waitFor(t, "session closed", 3*time.Second, func() bool { fr.mu.Lock(); defer fr.mu.Unlock(); return len(fr.closed) > 0 })
	admin.json(http.MethodPost, "/api/v1/assistant/investigations/"+inv.ID+"/messages", map[string]any{"text": "What now?"}, 202, nil)
	waitFor(t, "resumed", 3*time.Second, func() bool {
		fr.mu.Lock()
		defer fr.mu.Unlock()
		return len(fr.starts) == 2
	})
	fr.mu.Lock()
	if s := fr.starts[1]; s.Resume != "cli-"+inv.ID || s.Prompt != "What now?" {
		t.Errorf("resume = %+v", s)
	}
	fr.mu.Unlock()
	waitFor(t, "idle", 3*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/assistant/investigations/"+inv.ID, nil, 200, &d)
		return d.Investigation.State == invIdle
	})
	var list []investigationJSON
	admin.json(http.MethodGet, "/api/v1/assistant/investigations?server=shale", nil, 200, &list)
	if len(list) != 1 || list[0].ID != inv.ID {
		t.Errorf("list = %+v", list)
	}
	admin.json(http.MethodDelete, "/api/v1/assistant/investigations/"+inv.ID, nil, 204, nil)
	admin.problem(http.MethodGet, "/api/v1/assistant/investigations/"+inv.ID, nil, 404)
}

func TestAssistantAccessAndSwitches(t *testing.T) {
	e, admin, fa, fr := assistEnv(t)
	admin.json(http.MethodPut, "/api/v1/assistant/settings", map[string]any{"enabled": true, "access": "read"}, 200, nil)
	results := make(chan assist.ToolResult, 8)
	fr.script = func(s assist.SessionStart, call func(string, any) assist.ToolResult, emit func(assist.SessionEvent)) {
		results <- call("run_command", map[string]any{"host": "shale", "command": "reboot", "reason": "x"})
		results <- call("guest_action", map[string]any{"host": "shale", "guest": "pve:100", "action": "stop", "reason": "x"})
		results <- call("diagnose", map[string]any{"host": "Shale", "check": "list"})
	}
	var inv investigationJSON
	admin.json(http.MethodPost, "/api/v1/assistant/investigations", map[string]any{"server": "shale"}, 201, &inv)
	if r := <-results; !r.IsError || !strings.Contains(r.Text, "read only") {
		t.Errorf("run_command with read access = %+v", r)
	}
	if r := <-results; !r.IsError || !strings.Contains(r.Text, "read only") {
		t.Errorf("guest_action with read access = %+v", r)
	}
	if r := <-results; r.IsError || !strings.Contains(r.Text, `"name": "unraid"`) {
		t.Errorf("diagnose list = %+v", r)
	}
	if inv.Title != "Health check of shale" {
		t.Errorf("title = %q", inv.Title)
	}
	// Full access acts at once; the hub's Diagnostics switch still applies.
	admin.json(http.MethodPut, "/api/v1/assistant/settings", map[string]any{"access": "full"}, 200, nil)
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"diagnose": false}}, 200, nil)
	fr.script = func(s assist.SessionStart, call func(string, any) assist.ToolResult, emit func(assist.SessionEvent)) {
		results <- call("guest_action", map[string]any{"host": "shale", "guest": "pve:100", "action": "shutdown", "reason": "test"})
		results <- call("diagnose", map[string]any{"host": "shale", "check": "unraid"})
		results <- call("get_host", map[string]any{"host": "nope"})
	}
	waitFor(t, "idle", 3*time.Second, func() bool { return e.h.assist.running() == 0 })
	admin.json(http.MethodPost, "/api/v1/assistant/investigations", map[string]any{"server": "shale"}, 201, &inv)
	if r := <-results; r.IsError || !strings.HasPrefix(r.Text, "Done: shutdown") {
		t.Errorf("guest_action = %+v", r)
	}
	if r := <-results; !r.IsError || !strings.Contains(r.Text, "Diagnostics are turned off") {
		t.Errorf("diagnose with the switch off = %+v", r)
	}
	if r := <-results; !r.IsError || !strings.Contains(r.Text, "No such host") {
		t.Errorf("unknown host = %+v", r)
	}
	fa.mu.Lock()
	if len(fa.actions) != 1 || fa.actions[0].Action != "shutdown" || len(fa.execs) != 0 {
		t.Errorf("agent got %v %v", fa.actions, fa.execs)
	}
	fa.mu.Unlock()
	if recs := e.audit("assistant.action"); len(recs) != 1 || recs[0].Guest != "pve:100" {
		t.Errorf("action audit = %s", fmtRecs(recs))
	}
	// Turning the assistant off stops what runs.
	block := make(chan struct{})
	fr.script = func(s assist.SessionStart, call func(string, any) assist.ToolResult, emit func(assist.SessionEvent)) {
		<-block
	}
	waitFor(t, "idle", 3*time.Second, func() bool { return e.h.assist.running() == 0 })
	admin.json(http.MethodPost, "/api/v1/assistant/investigations", map[string]any{"server": "shale"}, 201, &inv)
	waitFor(t, "running", 3*time.Second, func() bool { return e.h.assist.running() == 1 })
	admin.json(http.MethodPut, "/api/v1/assistant/settings", map[string]any{"enabled": false}, 200, nil)
	var d invDetail
	admin.json(http.MethodGet, "/api/v1/assistant/investigations/"+inv.ID, nil, 200, &d)
	if d.Investigation.State != invStopped {
		t.Errorf("after turning off: %s", d.Investigation.State)
	}
	close(block)
}

func TestAssistantAutoInvestigate(t *testing.T) {
	e, admin, fa, fr := assistEnv(t)
	e.h.assist.autoAfter = 0
	admin.json(http.MethodPut, "/api/v1/assistant/settings", map[string]any{"enabled": true, "auto_investigate": "critical"}, 200, nil)
	rep := fa.report("shale")
	rep.RAID = []proto.RAIDArray{{Name: "md0", Level: "raid1", State: "degraded", Devices: 2, Active: 1, Failed: []string{"sdb"}}}
	fa.send(proto.MsgReport, rep)
	waitFor(t, "alert", 3*time.Second, func() bool {
		for _, a := range e.h.alerts.Open("shale") {
			if a.Rule == "raid.degraded" {
				return true
			}
		}
		return false
	})
	now := time.Now()
	e.h.assist.autoInvestigate(now)
	e.h.assist.autoInvestigate(now.Add(time.Second))
	var list []investigationJSON
	admin.json(http.MethodGet, "/api/v1/assistant/investigations", nil, 200, &list)
	if len(list) != 1 || !list[0].Auto || list[0].AlertID == nil || list[0].CreatedBy != "auto" {
		t.Fatalf("automatic investigations = %+v", list)
	}
	// The runner hears of the investigation a moment after it is listed.
	waitFor(t, "the runner's session", 3*time.Second, func() bool {
		fr.mu.Lock()
		defer fr.mu.Unlock()
		return len(fr.starts) > 0
	})
	fr.mu.Lock()
	if len(fr.starts) != 1 || !strings.Contains(fr.starts[0].Prompt, "md0’s disks") {
		t.Errorf("prompt = %+v", fr.starts)
	}
	fr.mu.Unlock()
	// Not again for the same alert.
	waitFor(t, "idle", 3*time.Second, func() bool { return e.h.assist.running() == 0 })
	e.h.assist.autoInvestigate(now.Add(2 * time.Minute))
	admin.json(http.MethodGet, "/api/v1/assistant/investigations", nil, 200, &list)
	if len(list) != 1 {
		t.Errorf("investigated twice: %d", len(list))
	}
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"2.1.302", "2.1.292", true}, {"2.1.292", "2.1.292", false}, {"0.163.0", "0.99.1", true}, {"1.0.0", "1.0.0-rc1", false}, {"", "1.0", false}} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}
