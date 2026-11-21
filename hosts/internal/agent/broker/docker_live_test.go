package broker

// Live test against a real Docker (or Podman) engine. It creates throwaway
// containers named rackoon-test-* and removes them afterwards:
//
//	RACKOON_DOCKER_TEST=1 [RACKOON_DOCKER_SOCKET=/run/user/1000/podman/podman.sock] \
//	RACKOON_DOCKER_CLI=podman go test -run TestDockerLive -v ./internal/agent/broker/

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// liveSession runs a console session in the background, collecting output.
type liveSession struct {
	in   chan wire.Frame
	out  chan wire.Frame
	done chan error
	buf  bytes.Buffer
}

func startLive(t *testing.T, ctx context.Context, s agent.ConsoleSession) *liveSession {
	ls := &liveSession{in: make(chan wire.Frame, 16), out: make(chan wire.Frame, 1024), done: make(chan error, 1)}
	go func() {
		ls.done <- s.Run(ctx, ls.in, func(f wire.Frame) error {
			select {
			case ls.out <- f:
			default:
			}
			return nil
		})
	}()
	return ls
}

// waitText reads frames until the data contains want.
func (ls *liveSession) waitText(t *testing.T, want string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for !strings.Contains(ls.buf.String(), want) {
		select {
		case f := <-ls.out:
			if f.Kind == wire.FrameData {
				ls.buf.Write(f.Payload)
			}
		case <-deadline:
			t.Fatalf("no %q in output:\n%q", want, ls.buf.String())
		}
	}
}

func (ls *liveSession) send(s string) { ls.in <- wire.Frame{Kind: wire.FrameData, Payload: []byte(s)} }

func (ls *liveSession) control(cc wire.ConsoleControl) {
	b, _ := json.Marshal(cc)
	ls.in <- wire.Frame{Kind: wire.FrameControl, Payload: b}
}

func TestDockerLive(t *testing.T) {
	if os.Getenv("RACKOON_DOCKER_TEST") != "1" {
		t.Skip("set RACKOON_DOCKER_TEST=1 to run against a real Docker/Podman engine")
	}
	sock := os.Getenv("RACKOON_DOCKER_SOCKET")
	if sock == "" {
		sock = fmt.Sprintf("/run/user/%d/podman/podman.sock", os.Getuid())
		if os.Getuid() == 0 {
			sock = "/var/run/docker.sock"
		}
	}
	cli := os.Getenv("RACKOON_DOCKER_CLI")
	if cli == "" {
		cli = "docker"
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano()%1e9)
	plain := "rackoon-test-plain-" + suffix
	tty := "rackoon-test-tty-" + suffix
	run := func(args ...string) string {
		out, err := exec.Command(cli, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", cli, args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	t.Cleanup(func() {
		exec.Command(cli, "rm", "-f", "-t", "0", plain, tty).Run()
	})
	// A container that logs a line per second and stops quickly on SIGTERM.
	loop := `trap 'echo got-term; exit 0' TERM; i=0; while :; do echo "line $i"; i=$((i+1)); sleep 1 & wait $!; done`
	var logArgs []string
	if v, _ := exec.Command(cli, "--version").Output(); strings.Contains(strings.ToLower(string(v)), "podman") {
		// Podman's default journald log driver returns nothing for
		// rootless containers without a persistent user journal.
		logArgs = []string{"--log-driver", "k8s-file"}
	}
	run(append(append([]string{"run", "-d"}, logArgs...), "--name", plain, "alpine:3.22", "sh", "-c", loop)...)
	run(append(append([]string{"run", "-d", "-t"}, logArgs...), "--name", tty, "alpine:3.22", "sh", "-c", `echo tty-hello; exec sleep 600`)...)

	inv := &proto.Report{Docker: &proto.Platform{Guests: []proto.Guest{
		{ID: plain, Name: plain, Kind: "container", State: "running"},
		{ID: tty, Name: tty, Kind: "container", State: "running"},
	}}}
	b := NewBroker(&agent.Config{}, func() *proto.Report { return inv }, nil)
	d := &dockerDriver{socket: sock}
	b.drivers[proto.PlatformDocker] = d
	ctx := context.Background()
	act := func(name, action string, want string) proto.ActionResponse {
		t.Helper()
		start := time.Now()
		r := b.Action(ctx, proto.ActionRequest{Platform: proto.PlatformDocker, GuestID: name, Action: action})
		if want != "" && (!r.OK || r.State != want) {
			t.Fatalf("%s %s: %+v", action, name, r)
		}
		t.Logf("%-12s -> %+v (%.1f s)", action, r, time.Since(start).Seconds())
		return r
	}

	// Actions.
	act(plain, proto.ActionPause, proto.StatePaused)
	if r := act(plain, proto.ActionPause, proto.StatePaused); !r.Noop {
		t.Fatal("second pause is not a noop")
	}
	act(plain, proto.ActionResume, proto.StateRunning)
	if r := act(plain, proto.ActionResume, ""); !r.Noop {
		t.Fatalf("resume of a running container: %+v", r)
	}
	act(plain, proto.ActionPause, proto.StatePaused)
	act(plain, proto.ActionStart, proto.StateRunning) // start continues a paused container
	act(plain, proto.ActionRestart, proto.StateRunning)
	start := time.Now()
	act(plain, proto.ActionShutdown, proto.StateStopped) // -> stop, graceful
	if time.Since(start) > 20*time.Second {
		t.Fatalf("graceful stop took %v", time.Since(start))
	}
	if r := act(plain, proto.ActionPause, ""); r.Code != CodeGuestNotRunning {
		t.Fatalf("pause of a stopped container: %+v", r)
	}
	act(plain, proto.ActionStart, proto.StateRunning)
	act(tty, proto.ActionForceStop, proto.StateStopped)
	act(tty, proto.ActionStart, proto.StateRunning)
	if r := act(plain, proto.ActionSnapshotCreate, ""); r.Code != CodeUnsupportedAction {
		t.Fatalf("docker snapshot: %+v", r)
	}
	if r := act(plain, proto.ActionCtrlAltDel, ""); r.Code != CodeUnsupportedAction {
		t.Fatalf("docker ctrl_alt_del: %+v", r)
	}

	// Shell.
	sctx, scancel := context.WithCancel(ctx)
	sess, resp := b.Console(sctx, proto.ConsoleRequest{SessionID: "t1", Platform: proto.PlatformDocker, GuestID: plain, Protocol: proto.ProtoShell, Cols: 100, Rows: 30})
	if !resp.OK {
		t.Fatalf("shell: %+v", resp)
	}
	ls := startLive(t, sctx, sess)
	ls.send("stty size; echo hello-$((6*7))\n")
	ls.waitText(t, "hello-42", 10*time.Second)
	ls.waitText(t, "30 100", 2*time.Second)
	ls.control(wire.ConsoleControl{Type: "resize", Cols: 120, Rows: 40})
	time.Sleep(300 * time.Millisecond)
	ls.send("stty size\n")
	ls.waitText(t, "40 120", 5*time.Second)
	ls.send("exit\n")
	select {
	case err := <-ls.done:
		if err != nil {
			t.Fatalf("shell ended with %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shell session did not end after exit")
	}
	scancel()

	// A shell closed by the browser leaves no process behind.
	sctx, scancel = context.WithCancel(ctx)
	sess, resp = b.Console(sctx, proto.ConsoleRequest{SessionID: "t2", Platform: proto.PlatformDocker, GuestID: plain, Protocol: proto.ProtoShell})
	if !resp.OK {
		t.Fatalf("shell 2: %+v", resp)
	}
	ls = startLive(t, sctx, sess)
	ls.send("echo marker-$((1+1)); exec sleep 1234\n")
	ls.waitText(t, "marker-2", 10*time.Second)
	scancel()
	<-ls.done
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, _ := exec.Command(cli, "exec", plain, "ps").CombinedOutput()
		if !strings.Contains(string(out), "sleep 1234") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("exec'd process still running after the session closed:\n%s", out)
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Logs of a running container (multiplexed stream): tail, then follow.
	lctx, lcancel := context.WithCancel(ctx)
	sess, resp = b.Console(lctx, proto.ConsoleRequest{SessionID: "t3", Platform: proto.PlatformDocker, GuestID: plain, Protocol: proto.ProtoLogs})
	if !resp.OK {
		t.Fatalf("logs: %+v", resp)
	}
	ls = startLive(t, lctx, sess)
	ls.waitText(t, "line 0\r\n", 10*time.Second)
	if strings.Contains(ls.buf.String(), "\x01\x00\x00\x00") {
		t.Fatal("stream headers not removed")
	}
	n := strings.Count(ls.buf.String(), "line ")
	ls.waitText(t, fmt.Sprintf("line %d\r\n", n+1), 10*time.Second) // followed
	ls.send("ignored input\n")
	ls.control(wire.ConsoleControl{Type: "resize", Cols: 80, Rows: 20})
	// Stopping the container ends the stream; the session stays open.
	run("stop", "-t", "10", plain)
	ls.waitText(t, "end of log", 15*time.Second)
	select {
	case err := <-ls.done:
		t.Fatalf("logs session ended with the container: %v", err)
	case <-time.After(500 * time.Millisecond):
	}
	ls.control(wire.ConsoleControl{Type: "close"})
	select {
	case <-ls.done:
	case <-time.After(5 * time.Second):
		t.Fatal("logs session did not close")
	}
	lcancel()

	// Logs of a stopped container; shell refused.
	if _, r := b.Console(ctx, proto.ConsoleRequest{Platform: proto.PlatformDocker, GuestID: plain, Protocol: proto.ProtoShell}); r.Code != CodeGuestNotRunning {
		t.Fatalf("shell of a stopped container: %+v", r)
	}
	lctx, lcancel = context.WithCancel(ctx)
	sess, resp = b.Console(lctx, proto.ConsoleRequest{Platform: proto.PlatformDocker, GuestID: plain, Protocol: proto.ProtoLogs})
	if !resp.OK {
		t.Fatalf("logs of a stopped container: %+v", resp)
	}
	ls = startLive(t, lctx, sess)
	ls.waitText(t, "got-term", 10*time.Second)
	ls.waitText(t, "end of log", 5*time.Second)
	lcancel()
	<-ls.done

	// Logs of a TTY container (raw stream).
	lctx, lcancel = context.WithCancel(ctx)
	sess, resp = b.Console(lctx, proto.ConsoleRequest{Platform: proto.PlatformDocker, GuestID: tty, Protocol: proto.ProtoLogs})
	if !resp.OK {
		t.Fatalf("tty logs: %+v", resp)
	}
	ls = startLive(t, lctx, sess)
	ls.waitText(t, "tty-hello", 10*time.Second)
	lcancel()
	<-ls.done

	if _, r := b.Console(ctx, proto.ConsoleRequest{Platform: proto.PlatformDocker, GuestID: tty, Protocol: proto.ProtoVNC}); r.Code != CodeUnsupportedProtocol {
		t.Fatalf("vnc on docker: %+v", r)
	}

	// The process view names the container's processes.
	ir := b.Inspect(ctx, proto.InspectRequest{Kind: proto.InspectProcesses, Platform: proto.PlatformHost, GuestID: HostID, Limit: 500})
	if ir.Code != "" {
		t.Fatalf("processes: %+v", ir)
	}
	found := false
	for _, p := range ir.Processes {
		if p.Container == "docker:"+tty {
			found = true
		}
	}
	if !found {
		var cs []string
		for _, p := range ir.Processes {
			if p.Container != "" {
				cs = append(cs, p.Container)
			}
		}
		t.Fatalf("no process of %s in the view; containers seen: %v", tty, cs)
	}
}
