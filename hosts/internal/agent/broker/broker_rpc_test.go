package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// fakeSnapDriver is a fakeDriver with snapshots.
type fakeSnapDriver struct {
	fakeDriver
	mu    sync.Mutex
	snaps []proto.Snapshot
	ops   []string
	block chan struct{} // create waits for it when set
}

func (d *fakeSnapDriver) snapshots(ctx context.Context, g *proto.Guest) ([]proto.Snapshot, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]proto.Snapshot(nil), d.snaps...), nil
}

func (d *fakeSnapDriver) snapshotCreate(ctx context.Context, g *proto.Guest, name, desc string, memory bool) error {
	if d.block != nil {
		<-d.block
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ops = append(d.ops, "create:"+name+":"+desc+":"+map[bool]string{true: "mem", false: "disk"}[memory])
	d.snaps = append(d.snaps, proto.Snapshot{Name: name, Description: desc})
	return nil
}

func (d *fakeSnapDriver) snapshotRestore(ctx context.Context, g *proto.Guest, name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ops = append(d.ops, "restore:"+name)
	return nil
}

func (d *fakeSnapDriver) snapshotDelete(ctx context.Context, g *proto.Guest, name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ops = append(d.ops, "delete:"+name)
	return nil
}

func TestPauseResume(t *testing.T) {
	inv := &proto.Report{Incus: &proto.Platform{Guests: []proto.Guest{{ID: "vm1", Kind: "vm"}}}}
	ctx := context.Background()
	d := &fakeDriver{st: "running"}
	b := testBroker(inv, d)
	act := func(a string) proto.ActionResponse {
		return b.Action(ctx, proto.ActionRequest{Platform: "incus", GuestID: "vm1", Action: a})
	}
	d.states = []string{"running", "paused"}
	if r := act(proto.ActionPause); !r.OK || r.State != "paused" {
		t.Fatalf("pause: %+v", r)
	}
	d.st, d.states = "paused", nil
	if r := act(proto.ActionPause); !r.OK || !r.Noop {
		t.Fatalf("pause paused: %+v", r)
	}
	d.states = []string{"paused", "running"}
	if r := act(proto.ActionStart); !r.OK || r.State != "running" {
		t.Fatalf("start paused: %+v", r)
	}
	if got := strings.Join(d.calls, ","); got != "pause,resume" {
		t.Fatalf("calls %s (start on a paused guest must resume it)", got)
	}
	d.st, d.states = "stopped", nil
	if r := act(proto.ActionResume); r.Code != CodeGuestNotPaused {
		t.Fatalf("resume stopped: %+v", r)
	}
	if r := act(proto.ActionPause); r.Code != CodeGuestNotRunning {
		t.Fatalf("pause stopped: %+v", r)
	}
}

func TestSnapshotActions(t *testing.T) {
	inv := &proto.Report{
		Incus: &proto.Platform{Guests: []proto.Guest{{ID: "web", Kind: "container"}}},
		PVE:   &proto.PVE{Guests: []proto.Guest{{ID: "100", Kind: "vm"}}},
	}
	ctx := context.Background()
	d := &fakeSnapDriver{fakeDriver: fakeDriver{st: "running"}, snaps: []proto.Snapshot{{Name: "base"}}}
	b := testBroker(inv, d)
	b.drivers[proto.PlatformPVE] = d
	act := func(platform, guest, action string, args map[string]string) proto.ActionResponse {
		return b.Action(ctx, proto.ActionRequest{Platform: platform, GuestID: guest, Action: action, Args: args})
	}
	r := act("incus", "web", proto.ActionSnapshotCreate, map[string]string{"description": "before\nupgrade\x00", "memory": "true"})
	if !r.OK || r.State != "running" {
		t.Fatalf("create: %+v", r)
	}
	if len(d.ops) != 1 || !strings.HasPrefix(d.ops[0], "create:whombat-") || !strings.HasSuffix(d.ops[0], ":before upgrade:mem") {
		t.Fatalf("ops %v", d.ops)
	}
	name := strings.Split(d.ops[0], ":")[1]
	if len(name) != len("whombat-20261013-120000") {
		t.Fatalf("default name %q", name)
	}
	for _, bad := range []string{"-x", "a/b", "a b", "$(rm)", strings.Repeat("a", 41)} {
		if r := act("incus", "web", proto.ActionSnapshotCreate, map[string]string{"snapshot": bad}); r.Code != CodeInvalid {
			t.Errorf("name %q: %+v", bad, r)
		}
	}
	if r := act("incus", "web", proto.ActionSnapshotCreate, map[string]string{"snapshot": "base"}); r.Code != CodeInvalid {
		t.Fatalf("duplicate: %+v", r)
	}
	if r := act("pve", "100", proto.ActionSnapshotCreate, map[string]string{"snapshot": "1.dots"}); r.Code != CodeInvalid {
		t.Fatalf("pve name rules: %+v", r)
	}
	if r := act("incus", "web", proto.ActionSnapshotRestore, map[string]string{"snapshot": "nope"}); r.Code != CodeUnknownSnapshot {
		t.Fatalf("restore unknown: %+v", r)
	}
	if r := act("incus", "web", proto.ActionSnapshotRestore, map[string]string{"snapshot": "base"}); !r.OK {
		t.Fatalf("restore: %+v", r)
	}
	if r := act("incus", "web", proto.ActionSnapshotDelete, map[string]string{"snapshot": "base"}); !r.OK {
		t.Fatalf("delete: %+v", r)
	}
	if got := strings.Join(d.ops[1:], ","); got != "restore:base,delete:base" {
		t.Fatalf("ops %s", got)
	}

	// A slow snapshot answers "timeout" when the RPC deadline nears and
	// keeps the guest locked until the platform finishes.
	d.block = make(chan struct{})
	tctx, cancel := context.WithTimeout(ctx, 5500*time.Millisecond)
	defer cancel()
	start := time.Now()
	r = b.Action(tctx, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: proto.ActionSnapshotCreate, Args: map[string]string{"snapshot": "slow"}})
	if r.Code != CodeTimeout || time.Since(start) > 3*time.Second {
		t.Fatalf("slow create: %+v after %v", r, time.Since(start))
	}
	bctx, bcancel := context.WithTimeout(ctx, 200*time.Millisecond)
	if r := b.Action(bctx, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: proto.ActionPause}); r.Code != CodeBusy {
		t.Fatalf("guest not locked during a snapshot: %+v", r)
	}
	bcancel()
	close(d.block)
	deadline := time.Now().Add(5 * time.Second)
	for {
		d.mu.Lock()
		n := len(d.snaps)
		d.mu.Unlock()
		if n == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background snapshot did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Inspect lists them, oldest first.
	d.snaps = []proto.Snapshot{{Name: "b", Created: time.Unix(200, 0)}, {Name: "a", Created: time.Unix(100, 0)}}
	ir := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectSnapshots, Platform: "incus", GuestID: "web"})
	if ir.Code != "" || len(ir.Snapshots) != 2 || ir.Snapshots[0].Name != "a" {
		t.Fatalf("inspect: %+v", ir)
	}
	if ir := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectSnapshots, Platform: "incus", GuestID: "nope"}); ir.Code != CodeUnknownGuest {
		t.Fatalf("unknown guest: %+v", ir)
	}
	// Docker has no snapshots.
	b.inv = func() *proto.Report {
		return &proto.Report{Docker: &proto.Platform{Guests: []proto.Guest{{ID: "web", Kind: "container"}}}}
	}
	if ir := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectSnapshots, Platform: "docker", GuestID: "web"}); ir.Code != CodeUnsupported {
		t.Fatalf("docker snapshots: %+v", ir)
	}
}

func TestHostAction(t *testing.T) {
	b := NewBroker(&agent.Config{}, func() *proto.Report { return nil }, nil)
	ran := make(chan []string, 4)
	b.hostRun = func(argv []string) error { ran <- argv; return nil }
	b.hostDelay = 50 * time.Millisecond
	// The commands a systemd host has, whatever this machine has (a test container has none).
	b.hostCommands = func(action string) [][]string {
		if action == proto.ActionHostShutdown {
			return [][]string{{"/usr/bin/systemctl", "poweroff"}, {"/sbin/poweroff"}}
		}
		return [][]string{{"/usr/bin/systemctl", "reboot"}, {"/sbin/reboot"}}
	}
	if r := b.Action(context.Background(), proto.ActionRequest{Platform: proto.PlatformHost, GuestID: "web", Action: proto.ActionHostReboot}); r.Code != CodeInvalid {
		t.Fatalf("wrong guest: %+v", r)
	}
	if r := b.Action(context.Background(), proto.ActionRequest{Platform: proto.PlatformHost, GuestID: HostID, Action: proto.ActionStart}); r.Code != CodeUnsupportedAction {
		t.Fatalf("start host: %+v", r)
	}
	start := time.Now()
	r := b.Action(context.Background(), proto.ActionRequest{Platform: proto.PlatformHost, GuestID: HostID, Action: proto.ActionHostReboot})
	if !r.OK || r.State != "rebooting" || time.Since(start) > 40*time.Millisecond {
		t.Fatalf("reboot: %+v", r)
	}
	if r := b.Action(context.Background(), proto.ActionRequest{Platform: proto.PlatformHost, GuestID: HostID, Action: proto.ActionHostShutdown}); !r.OK || !r.Noop {
		t.Fatalf("second request while pending: %+v", r)
	}
	select {
	case argv := <-ran:
		if !strings.HasSuffix(argv[0], "systemctl") && !strings.HasSuffix(argv[0], "reboot") {
			t.Fatalf("reboot command %v", argv)
		}
		if strings.HasSuffix(argv[0], "systemctl") && argv[1] != "reboot" {
			t.Fatalf("reboot command %v", argv)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("reboot command not run")
	}
	// Host actions are not guest actions.
	if r := b.Action(context.Background(), proto.ActionRequest{Platform: "incus", GuestID: "x", Action: proto.ActionHostReboot}); r.OK {
		t.Fatalf("host action on a guest: %+v", r)
	}
	// A host without the tools says so, and nothing is left pending.
	bare := NewBroker(&agent.Config{}, func() *proto.Report { return nil }, nil)
	bare.hostCommands = func(string) [][]string { return nil }
	if r := bare.Action(context.Background(), proto.ActionRequest{Platform: proto.PlatformHost, GuestID: HostID, Action: proto.ActionHostReboot}); r.Code != CodeUnsupportedAction || bare.hostPending != "" {
		t.Fatalf("host without reboot tools: %+v", r)
	}
}

func TestHostPowerCommands(t *testing.T) {
	for _, a := range []string{proto.ActionHostReboot, proto.ActionHostShutdown} {
		cmds := hostPowerCommands(a)
		if len(cmds) == 0 {
			t.Skip("no reboot tools here")
		}
		verb := map[string]string{proto.ActionHostReboot: "reboot", proto.ActionHostShutdown: "poweroff"}[a]
		last := cmds[len(cmds)-1]
		if !strings.HasSuffix(last[0], "/"+verb) && !(len(last) == 2 && last[1] == verb) {
			t.Fatalf("%s: %v", a, cmds)
		}
	}
}

// runSession runs a session (its input channel stays open, like a
// connected browser) and gathers its output until it contains until.
func runSession(t *testing.T, s agent.ConsoleSession, input []wire.Frame, until string) (string, chan error, chan wire.Frame, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	in := make(chan wire.Frame, 16)
	for _, f := range input {
		in <- f
	}
	frames := make(chan wire.Frame, 256)
	done := make(chan error, 1)
	go func() {
		done <- s.Run(ctx, in, func(f wire.Frame) error { frames <- f; return nil })
	}()
	var buf bytes.Buffer
	deadline := time.After(10 * time.Second)
	for !strings.Contains(buf.String(), until) {
		select {
		case f := <-frames:
			if f.Kind == wire.FrameData {
				buf.Write(f.Payload)
			}
		case <-deadline:
			cancel()
			t.Fatalf("no %q in %q", until, buf.String())
		}
	}
	return buf.String(), done, frames, cancel
}

func TestLogCommandSession(t *testing.T) {
	s, err := startLogCommand([]string{"/bin/sh", "-c", "printf 'one\\ntwo\\r\\nthree\\n'; echo err >&2"}, "-- ended --")
	if err != nil {
		t.Fatal(err)
	}
	out, done, _, cancel := runSession(t, s, []wire.Frame{{Kind: wire.FrameData, Payload: []byte("typed")}}, "-- ended --")
	if !strings.Contains(out, "one\r\ntwo\r\nthree\r\nerr\r\n") || strings.Contains(out, "typed") {
		t.Fatalf("output %q", out)
	}
	select {
	case err := <-done:
		t.Fatalf("session ended with the command: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not stop")
	}

	// A follow command is stopped with the session.
	s, err = startLogCommand([]string{"/bin/sh", "-c", "echo start; exec sleep 300"}, "")
	if err != nil {
		t.Fatal(err)
	}
	_, done, _, cancel = runSession(t, s, nil, "start")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("follow command not stopped")
	}
}

func TestHostShellPTY(t *testing.T) {
	t.Setenv("INVOCATION_ID", "") // no systemd-run in tests
	if argv := hostShellArgv("/bin/bash", true); argv[0] != "/usr/bin/systemd-run" || argv[len(argv)-2] != "/bin/bash" || argv[len(argv)-1] != "-l" {
		t.Fatalf("systemd argv %v", argv)
	}
	if argv := hostShellArgv("/bin/sh", false); strings.Join(argv, " ") != "/bin/sh -l" {
		t.Fatalf("argv %v", argv)
	}
	b := NewBroker(&agent.Config{}, func() *proto.Report { return nil }, nil)
	s, r := b.Console(context.Background(), proto.ConsoleRequest{Platform: proto.PlatformHost, GuestID: HostID, Protocol: proto.ProtoShell, Cols: 90, Rows: 20})
	if !r.OK {
		t.Fatalf("host shell: %+v", r)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in := make(chan wire.Frame, 4)
	frames := make(chan wire.Frame, 256)
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, in, func(f wire.Frame) error { frames <- f; return nil }) }()
	in <- wire.Frame{Kind: wire.FrameData, Payload: []byte("stty size; echo pwd=$(pwd) term=$TERM; exit\n")}
	var buf bytes.Buffer
	for {
		select {
		case f := <-frames:
			if f.Kind == wire.FrameData {
				buf.Write(f.Payload)
			}
			continue
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("shell did not exit: %q", buf.String())
		}
		break
	}
	for len(frames) > 0 {
		if f := <-frames; f.Kind == wire.FrameData {
			buf.Write(f.Payload)
		}
	}
	out := buf.String()
	if !strings.Contains(out, "20 90") || !strings.Contains(out, "term=xterm-256color") || (!strings.Contains(out, "pwd=/root ") && !strings.Contains(out, "pwd=/ ")) {
		t.Fatalf("shell output %q", out)
	}
}

func TestCRLF(t *testing.T) {
	var c crlf
	got := string(c.convert([]byte("a\nb\r\nc\r"))) + string(c.convert([]byte("\nd\n")))
	if got != "a\r\nb\r\nc\r\nd\r\n" {
		t.Fatalf("%q", got)
	}
}

func TestDockerDemux(t *testing.T) {
	var raw bytes.Buffer
	frame := func(stream byte, s string) {
		var h [8]byte
		h[0] = stream
		binary.BigEndian.PutUint32(h[4:], uint32(len(s)))
		raw.Write(h[:])
		raw.WriteString(s)
	}
	frame(1, "out line\n")
	frame(2, "err line\n")
	frame(1, "")
	frame(1, strings.Repeat("x", 70000))
	out, err := io.ReadAll(&dockerDemux{r: bufio.NewReader(&raw)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "out line\nerr line\nxxx") || len(out) != 18+70000 {
		t.Fatalf("demux %d %q", len(out), out[:20])
	}
	if _, err := io.ReadAll(&dockerDemux{r: bufio.NewReader(strings.NewReader("plain text log"))}); err == nil {
		t.Fatal("non-multiplexed stream accepted")
	}
}

func TestSnapshotParsers(t *testing.T) {
	// PVE: the "current" pseudo entry marks its parent current.
	var entries []pveSnapshotEntry
	json.Unmarshal([]byte(`[
		{"name":"before-upgrade","snaptime":1760000000,"description":"pre apt\n","vmstate":1},
		{"name":"weekly","snaptime":1760100000,"parent":"before-upgrade","description":""},
		{"name":"current","parent":"weekly","running":1,"description":"You are here!","digest":"x"}]`), &entries)
	ps := parsePVESnapshots(entries)
	if len(ps) != 2 || ps[0].Name != "before-upgrade" || !ps[0].WithMemory || ps[0].Current || ps[0].Description != "pre apt" ||
		!ps[1].Current || ps[1].Parent != "before-upgrade" || ps[1].WithMemory || !ps[0].Created.Equal(time.Unix(1760000000, 0)) {
		t.Fatalf("pve: %+v", ps)
	}
	// libvirt snapshot XML.
	s, err := parseSnapshotXML(`<domainsnapshot><name>s2</name><description>nightly</description><state>running</state>
		<parent><name>s1</name></parent><creationTime>1760000000</creationTime><memory snapshot='internal'/></domainsnapshot>`, true)
	if err != nil || s.Name != "s2" || s.Parent != "s1" || !s.WithMemory || !s.Current || s.Description != "nightly" || s.Created.Unix() != 1760000000 {
		t.Fatalf("libvirt: %+v %v", s, err)
	}
	s, _ = parseSnapshotXML(`<domainsnapshot><name>off</name><state>shutoff</state><memory snapshot='no'/></domainsnapshot>`, false)
	if s.WithMemory || s.Current {
		t.Fatalf("libvirt shutoff: %+v", s)
	}
	// Incus (fields as in `incus query /1.0/instances/<n>/snapshots?recursion=1`).
	var is []api.InstanceSnapshot
	json.Unmarshal([]byte(`[{"name":"pre-dashboard","created_at":"2026-08-29T10:00:38.551762327Z","expires_at":"0001-01-01T00:00:00Z",
		"size":846532608,"stateful":false},{"name":"live","created_at":"2026-09-01T00:00:00Z","stateful":true,"size":0}]`), &is)
	ps = incusSnapshots(is)
	if len(ps) != 2 || ps[0].SizeBytes == nil || *ps[0].SizeBytes != 846532608 || ps[0].WithMemory || !ps[1].WithMemory || ps[1].SizeBytes != nil {
		t.Fatalf("incus: %+v", ps)
	}
	if DefaultSnapshotName(time.Date(2026, 10, 13, 8, 5, 9, 0, time.UTC)) != "whombat-20261013-080509" {
		t.Fatal("default name")
	}
	if !pveSnapshotRe.MatchString(DefaultSnapshotName(time.Now())) || !newSnapshotRe.MatchString(DefaultSnapshotName(time.Now())) {
		t.Fatal("default name must be valid everywhere")
	}
}

func TestInspectDispatch(t *testing.T) {
	b := NewBroker(&agent.Config{}, func() *proto.Report { return nil }, nil)
	ctx := context.Background()
	if r := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectProcesses, Platform: "incus", GuestID: "web"}); r.Code != CodeInvalid {
		t.Fatalf("host view for a guest: %+v", r)
	}
	if r := b.Inspect(ctx, proto.InspectRequest{Kind: "files", Platform: proto.PlatformHost, GuestID: HostID}); r.Code != CodeUnsupported {
		t.Fatalf("unknown kind: %+v", r)
	}
	r := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectPorts, Platform: proto.PlatformHost, GuestID: HostID, Limit: 3})
	if r.Code != "" || len(r.Ports) > 3 {
		t.Fatalf("ports: %+v", r)
	}
	r = b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectProcesses, Platform: proto.PlatformHost, GuestID: HostID, Limit: 5})
	if r.Code != "" || len(r.Processes) != 5 || !r.Truncated {
		t.Fatalf("processes: %+v", r)
	}
	if rows, trunc := capRows([]int{1, 2, 3}, 0, 2, 10); len(rows) != 2 || !trunc {
		t.Fatal("capRows default")
	}
}
