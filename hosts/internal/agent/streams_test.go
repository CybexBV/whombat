package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func (b *fakeBroker) Manage(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	return proto.ManageResponse{OK: true}
}

// fakeDiagnostics answers the assistant's streams and counts the calls.
type fakeDiagnostics struct {
	runs, execs atomic.Int32
}

func (f *fakeDiagnostics) Run(ctx context.Context, req proto.DiagnoseRequest) proto.DiagnoseResponse {
	f.runs.Add(1)
	return proto.DiagnoseResponse{Commands: []string{"uname -a"}, Output: "Linux " + req.Check}
}

func (f *fakeDiagnostics) Exec(ctx context.Context, req proto.ExecRequest) proto.ExecResponse {
	f.execs.Add(1)
	return proto.ExecResponse{ExitCode: 3, Output: "ran " + req.Command, DurationMs: 5}
}

// PackageReport: an install runs (the runtime puts it in the report).
func (b *fakeBroker) PackageReport() (*proto.PackageTask, *proto.PackageLast) {
	return &proto.PackageTask{ID: "pkg:00000000000000aa", Op: "install", Started: time.Unix(1700000000, 0).UTC()},
		&proto.PackageLast{Op: "check", Status: "ok", Finished: time.Unix(1699990000, 0).UTC()}
}

func (b *fakeBroker) Inspect(ctx context.Context, req proto.InspectRequest) proto.InspectResponse {
	return proto.InspectResponse{Processes: []proto.Process{{PID: 1, Name: "init"}}}
}

// setTOML sets keys ("console", "host_shell", "allow", ...) in agent.toml and
// reloads it.
func setTOML(t *testing.T, rt *Runtime, kv map[string]string) {
	t.Helper()
	path := filepath.Join(rt.Config().Dir, ConfigFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for k, v := range kv {
		re := regexp.MustCompile(`(?m)^#? ?` + regexp.QuoteMeta(k) + ` = .*$`)
		if !re.MatchString(s) {
			t.Fatalf("agent.toml has no %s", k)
		}
		s = re.ReplaceAllString(s, k+" = "+v)
	}
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
}

func TestHostAccessPolicy(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	console := func(platform, guest, protocol string) proto.ConsoleResponse {
		return rpc[proto.ConsoleRequest, proto.ConsoleResponse](t, side, proto.StreamConsole,
			proto.ConsoleRequest{SessionID: "cs_h", Platform: platform, GuestID: guest, Protocol: protocol})
	}
	action := func(platform, guest, act string) proto.ActionResponse {
		return rpc[proto.ActionRequest, proto.ActionResponse](t, side, proto.StreamAction,
			proto.ActionRequest{Platform: platform, GuestID: guest, Action: act})
	}
	inspect := func() proto.InspectResponse {
		return rpc[proto.InspectRequest, proto.InspectResponse](t, side, proto.StreamInspect,
			proto.InspectRequest{Kind: proto.InspectProcesses, Platform: proto.PlatformHost, GuestID: "host"})
	}

	// Defaults: nothing.
	if r := inspect(); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("inspect: %+v", r)
	}
	// console + power do not open the host.
	setTOML(t, tr.rt, map[string]string{"console": "true", "power": "true"})
	if r := console(proto.PlatformHost, "host", proto.ProtoShell); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_shell") {
		t.Fatalf("host shell with console only: %+v", r)
	}
	for _, a := range []string{proto.ActionHostReboot, proto.ActionHostShutdown} {
		if r := action(proto.PlatformHost, "host", a); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_power") {
			t.Fatalf("%s with power only: %+v", a, r)
		}
		// Not even disguised as a guest action.
		if r := action("incus", "web", a); r.Code != CodeRemoteControlDisabled {
			t.Fatalf("%s on a guest platform: %+v", a, r)
		}
	}
	if n := tr.broker.actions.Load(); n != 0 {
		t.Fatalf("broker called %d times", n)
	}
	if r := inspect(); r.Code != "" || len(r.Processes) != 1 {
		t.Fatalf("inspect with console: %+v", r)
	}
	// Host logs need console only (the fake broker refuses guests but "web").
	if r := console(proto.PlatformHost, "host", proto.ProtoLogs); r.Code == CodeRemoteControlDisabled {
		t.Fatalf("host logs with console: %+v", r)
	}
	// Snapshots and pause are power actions.
	setTOML(t, tr.rt, map[string]string{"power": "false"})
	for _, a := range []string{proto.ActionSnapshotCreate, proto.ActionPause} {
		if r := action("incus", "web", a); r.Code != CodeRemoteControlDisabled {
			t.Fatalf("%s without power: %+v", a, r)
		}
	}

	setTOML(t, tr.rt, map[string]string{"console": "false", "host_shell": "true", "host_power": "true"})
	if r := action(proto.PlatformHost, "host", proto.ActionHostReboot); !r.OK {
		t.Fatalf("host reboot with host_power: %+v", r)
	}
	if r := console(proto.PlatformHost, "host", proto.ProtoLogs); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("host logs without console: %+v", r)
	}
	if r := inspect(); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("inspect without console: %+v", r)
	}
	// The policy is reported.
	deadline := time.After(5 * time.Second)
	for {
		r := recv(t, h.reports, "report")
		if r.Policy.HostShell && r.Policy.HostPower && !r.Policy.Console {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("policy not reported: %+v", r.Policy)
		default:
		}
	}
}

func TestChecksFromHub(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	recv(t, h.reports, "first report")
	specs := proto.CheckSpecs{Checks: []proto.CheckSpec{
		{ID: "ok", Kind: proto.CheckTCP, Target: "127.0.0.1:1", IntervalS: 60, TimeoutS: 5},
		{ID: "bad", Kind: proto.CheckTCP, Target: "no-port", IntervalS: 60, TimeoutS: 5},
	}}
	if err := side.send(proto.MsgChecks, specs); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(10 * time.Second)
	for {
		r := recv(t, h.reports, "report")
		if len(r.Checks) > 0 {
			if r.Checks[0].ID != "bad" || r.Checks[0].OK || !strings.Contains(r.Checks[0].Error, "invalid check") {
				t.Fatalf("checks %+v", r.Checks)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("check results not reported")
		default:
		}
	}
	if n := tr.rt.checkRunner().Len(); n != 2 {
		t.Fatalf("runner has %d checks", n)
	}
	// An empty set clears them.
	side.send(proto.MsgChecks, proto.CheckSpecs{})
	deadline = time.After(10 * time.Second)
	for {
		if r := recv(t, h.reports, "report"); len(r.Checks) == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("checks not cleared")
		default:
		}
	}
}

func TestUpdateStream(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	old := UpdatePublicKey
	UpdatePublicKey = base64.StdEncoding.EncodeToString(pub)
	// Registered before the runtime's cleanup, so it runs after the runtime stopped.
	t.Cleanup(func() { UpdatePublicKey = old })
	t.Setenv("INVOCATION_ID", "")

	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	dir := t.TempDir()
	exe := filepath.Join(dir, "whombat-agent")
	os.WriteFile(exe, fakeAgent("test"), 0o755)
	restarted := make(chan struct{}, 1)
	tr := startRuntime(t, cfg, func(rt *Runtime) {
		rt.Updater = &Updater{Exe: exe, StateDir: cfg.StateDir, Version: "v1", Arch: runtime.GOARCH, Key: pub,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
		rt.Restart = func() { restarted <- struct{}{} }
	})
	side := h.waitSide(t)
	if r := recv(t, h.reports, "report"); !r.Policy.Update || r.Agent.UpdateKey != KeyFingerprint(pub) {
		t.Fatalf("report policy %+v agent %+v", r.Policy, r.Agent)
	}
	payload := append(fakeAgent("v9"), make([]byte, 1500<<10)...)
	sum := sha256Sum(payload)
	req := proto.UpdateRequest{Version: "v9", Arch: runtime.GOARCH, Size: int64(len(payload)), SHA256: sum, Signature: ed25519.Sign(priv, sum)}

	send := func(req proto.UpdateRequest, body []byte) proto.UpdateResponse {
		st := side.open(t, proto.StreamUpdate)
		defer st.Close()
		if err := wire.WriteMsg(st, req); err != nil {
			t.Fatal(err)
		}
		// Chunks are written while the agent may already have answered.
		go func() {
			for len(body) > 0 {
				n := min(len(body), 1<<20)
				if wire.WriteMsg(st, proto.UpdateChunk{Data: body[:n]}) != nil {
					return
				}
				body = body[n:]
			}
		}()
		st.SetReadDeadline(time.Now().Add(20 * time.Second))
		var resp proto.UpdateResponse
		if err := wire.ReadMsg(st, &resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}
	// Refused locally.
	setTOML(t, tr.rt, map[string]string{"allow": "false"})
	if r := send(req, payload); r.Code != CodeUpdateDisabled {
		t.Fatalf("allow = false: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"allow": "true"})
	same := req
	same.Version = "v1"
	if r := send(same, payload); r.Code != CodeSameVersion {
		t.Fatalf("same version: %+v", r)
	}
	older := req
	older.Version = "v0.9"
	if r := send(older, payload); r.Code != CodeOlderVersion {
		t.Fatalf("older version: %+v", r)
	}
	// Installed, then the agent restarts.
	if r := send(req, payload); !r.OK {
		t.Fatalf("update: %+v", r)
	}
	select {
	case <-restarted:
	case <-time.After(10 * time.Second):
		t.Fatal("no restart after the update")
	}
	if b, _ := os.ReadFile(exe); string(b[:len(fakeAgent("v9"))]) != string(fakeAgent("v9")) {
		t.Fatal("executable not replaced")
	}
	m, err := readMarker(cfg.StateDir)
	if err != nil || m.Version != "v9" || m.Previous != "v1" {
		t.Fatalf("marker %+v %v", m, err)
	}
	// A pending update is confirmed by the next connection.
	tr.rt.WatchUpdate(m)
	h.cur.Load().sess.Close()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(markerPath(cfg.StateDir)); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("update not confirmed after reconnecting")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestUpdateDeadlineRollsBack(t *testing.T) {
	t.Setenv("INVOCATION_ID", "")
	cfg := &Config{Dir: t.TempDir(), StateDir: t.TempDir()}
	rt := NewRuntime(cfg, "v2", slog.New(slog.NewTextHandler(io.Discard, nil)))
	restarted := make(chan struct{}, 1)
	rt.Restart = func() { restarted <- struct{}{} }
	dir := t.TempDir()
	exe := filepath.Join(dir, "whombat-agent")
	os.WriteFile(exe, fakeAgent("v2"), 0o755)
	os.WriteFile(exe+".prev", fakeAgent("v1"), 0o755)
	m := &PendingUpdate{Version: "v2", Previous: "v1", Exe: exe, Prev: exe + ".prev", Deadline: time.Now().Add(100 * time.Millisecond)}
	writeMarker(cfg.StateDir, m)
	rt.WatchUpdate(m)
	select {
	case <-restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("no rollback at the deadline")
	}
	if b, _ := os.ReadFile(exe); string(b) != string(fakeAgent("v1")) {
		t.Fatalf("executable after rollback: %q", b)
	}
	if _, err := os.Stat(markerPath(cfg.StateDir)); !os.IsNotExist(err) {
		t.Fatal("marker kept")
	}
}

func TestAssistantPolicy(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	diag := &fakeDiagnostics{}
	tr := startRuntime(t, cfg, func(rt *Runtime) { rt.Diagnostics = diag })
	side := h.waitSide(t)
	diagnose := func() proto.DiagnoseResponse {
		return rpc[proto.DiagnoseRequest, proto.DiagnoseResponse](t, side, proto.StreamDiagnose,
			proto.DiagnoseRequest{Check: "system"})
	}
	exec := func() proto.ExecResponse {
		return rpc[proto.ExecRequest, proto.ExecResponse](t, side, proto.StreamExec,
			proto.ExecRequest{Command: "uptime", TimeoutS: 10})
	}

	// Diagnose is on by default (and reported); exec needs host_shell.
	if r := recv(t, h.reports, "report"); !r.Policy.Diagnose || r.Policy.HostShell {
		t.Fatalf("default policy %+v", r.Policy)
	}
	if r := diagnose(); r.Code != "" || r.Output != "Linux system" {
		t.Fatalf("diagnose by default: %+v", r)
	}
	if r := exec(); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "host_shell") {
		t.Fatalf("exec without host_shell: %+v", r)
	}
	// Console and manage do not open exec either.
	setTOML(t, tr.rt, map[string]string{"console": "true", "manage": "true"})
	if r := exec(); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("exec with console: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"diagnose": "false", "host_shell": "true"})
	if r := diagnose(); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "diagnose") {
		t.Fatalf("diagnose = false: %+v", r)
	}
	if r := exec(); r.Code != "" || r.ExitCode != 3 || r.Output != "ran uptime" {
		t.Fatalf("exec with host_shell: %+v", r)
	}
	if n, m := diag.runs.Load(), diag.execs.Load(); n != 1 || m != 1 {
		t.Fatalf("diagnostics called %d / %d times", n, m)
	}
	deadline := time.After(5 * time.Second)
	for {
		r := recv(t, h.reports, "report")
		if !r.Policy.Diagnose && r.Policy.HostShell {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("policy not reported: %+v", r.Policy)
		default:
		}
	}
	// Without the line in agent.toml it is on again.
	path := filepath.Join(tr.rt.Config().Dir, ConfigFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), "diagnose = false\n", "", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := tr.rt.Reload(); err != nil {
		t.Fatal(err)
	}
	if !tr.rt.Policy().Diagnose {
		t.Fatal("diagnose off without the setting")
	}
}

func TestAssistantWithoutDiagnostics(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	if r := rpc[proto.DiagnoseRequest, proto.DiagnoseResponse](t, side, proto.StreamDiagnose, proto.DiagnoseRequest{Check: "list"}); r.Code != CodeUnsupported {
		t.Fatalf("diagnose: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"host_shell": "true"})
	if r := rpc[proto.ExecRequest, proto.ExecResponse](t, side, proto.StreamExec, proto.ExecRequest{Command: "true"}); r.Code != CodeUnsupported {
		t.Fatalf("exec: %+v", r)
	}
}

func TestExecBudget(t *testing.T) {
	for in, want := range map[int]time.Duration{0: 150 * time.Second, 10: 40 * time.Second, 5000: 1830 * time.Second} {
		if got := execBudget(in); got != want {
			t.Errorf("%d: %v", in, got)
		}
	}
	script := "for i in 1 2; do\n  echo $i\ndone " + strings.Repeat("x", 300)
	if got := logCommand(script); strings.Contains(got, "\n") || len([]rune(got)) != 201 || !strings.HasPrefix(got, "for i in 1 2; do echo $i done x") {
		t.Errorf("log line %q", got)
	}
}

func sha256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

// A snapshot list needs power or manage, not the console switch; the
// other views need the console.
func TestSnapshotsNeedPowerOrManage(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	inspect := func(kind string) proto.InspectResponse {
		return rpc[proto.InspectRequest, proto.InspectResponse](t, side, proto.StreamInspect,
			proto.InspectRequest{Kind: kind, Platform: proto.PlatformPVE, GuestID: "100"})
	}
	setTOML(t, tr.rt, map[string]string{"console": "true"})
	if r := inspect(proto.InspectSnapshots); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "power or manage") {
		t.Fatalf("snapshots with console only: %+v", r)
	}
	for _, sw := range []string{"power", "manage"} {
		setTOML(t, tr.rt, map[string]string{"console": "false", "power": "false", "manage": "false", sw: "true"})
		if r := inspect(proto.InspectSnapshots); r.Code != "" {
			t.Fatalf("snapshots with %s: %+v", sw, r)
		}
		if r := inspect(proto.InspectProcesses); r.Code != CodeRemoteControlDisabled {
			t.Fatalf("processes with %s: %+v", sw, r)
		}
	}
}

// The report carries the broker's running package task and the last one.
func TestReportHasPackageTask(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	startRuntime(t, cfg, nil)
	h.waitSide(t)
	r := recv(t, h.reports, "report")
	if s := r.System; s == nil || s.PackageTask == nil || s.PackageTask.ID != "pkg:00000000000000aa" || s.PackageLast == nil || s.PackageLast.Op != "check" {
		t.Fatalf("system: %+v", r.System)
	}
}

// The waiting updates are a read-only check's answer: diagnose or console
// (SWU-11); the other host views still need the console.
func TestUpdatesNeedDiagnoseOrConsole(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	inspect := func(kind string) proto.InspectResponse {
		return rpc[proto.InspectRequest, proto.InspectResponse](t, side, proto.StreamInspect,
			proto.InspectRequest{Kind: kind, Platform: proto.PlatformHost, GuestID: "host"})
	}
	// Defaults: diagnose on, console off.
	if r := inspect(proto.InspectUpdates); r.Code != "" {
		t.Fatalf("updates with diagnose: %+v", r)
	}
	if r := inspect(proto.InspectProcesses); r.Code != CodeRemoteControlDisabled {
		t.Fatalf("processes with diagnose: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"diagnose": "false", "console": "true"})
	if r := inspect(proto.InspectUpdates); r.Code != "" {
		t.Fatalf("updates with console: %+v", r)
	}
	setTOML(t, tr.rt, map[string]string{"console": "false"})
	if r := inspect(proto.InspectUpdates); r.Code != CodeRemoteControlDisabled || !strings.Contains(r.Message, "diagnose or console") {
		t.Fatalf("updates with neither: %+v", r)
	}
}

// A changed backup job makes the collector read the jobs again at once.
func TestBackupJobChangeRefreshesCoverage(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)
	setTOML(t, tr.rt, map[string]string{"manage": "true"})
	manage := func(op string) proto.ManageResponse {
		return rpc[proto.ManageRequest, proto.ManageResponse](t, side, proto.StreamManage,
			proto.ManageRequest{Op: op, Platform: proto.PlatformPVE, JobID: "backup-1"})
	}
	for _, op := range []string{proto.OpBackupJobList, proto.OpBackupJobRun, proto.OpConfigGet} {
		manage(op)
	}
	if n := tr.col.refreshes.Load(); n != 0 {
		t.Fatalf("reads refreshed the jobs %d times", n)
	}
	for _, op := range []string{proto.OpBackupJobCreate, proto.OpBackupJobUpdate, proto.OpBackupJobDelete} {
		manage(op)
	}
	if n := tr.col.refreshes.Load(); n != 3 {
		t.Fatalf("job changes refreshed %d times, want 3", n)
	}
}
