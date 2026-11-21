package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Error codes the runtime returns on hub-opened streams.
const (
	CodeRemoteControlDisabled = "remote_control_disabled"
	CodeTooManySessions       = "too_many_sessions"
	CodeUnsupported           = "unsupported"
	CodeTimeout               = "timeout"
	CodeOpenFailed            = "open_failed"
)

const (
	actionTimeout    = 100 * time.Second // broker waits up to 60 s for the state
	thumbnailTimeout = 30 * time.Second
	inspectTimeout   = 60 * time.Second // package lists can be slow
	manageTimeout    = 90 * time.Second // long operations answer with a task id
	diagnoseTimeout  = 60 * time.Second // the checks bound themselves to less
	diskUsageTimeout = 55 * time.Second // disk usage bounds itself to at most 45 s
	screenGrace      = 5 * time.Second  // past the step's own limit (proto.ScreenStepLimit)
	rpcWriteTimeout  = 30 * time.Second
	consoleWriteMax  = 60 * time.Second // a hub that stops reading ends the session
)

// handleStream serves one hub-opened stream.
func (rt *Runtime) handleStream(ctx context.Context, st streamConn) {
	defer st.Close()
	st.SetReadDeadline(time.Now().Add(15 * time.Second))
	var h proto.StreamHeader
	if err := wire.ReadMsg(st, &h); err != nil {
		return
	}
	switch h.Kind {
	case proto.StreamAction:
		rt.serveAction(ctx, st)
	case proto.StreamThumbnail:
		rt.serveThumbnail(ctx, st)
	case proto.StreamConsole:
		rt.serveConsole(ctx, st)
	case proto.StreamInspect:
		rt.serveInspect(ctx, st)
	case proto.StreamUpdate:
		rt.serveUpdate(ctx, st)
	case proto.StreamManage:
		rt.serveManage(ctx, st)
	case proto.StreamDiagnose:
		rt.serveDiagnose(ctx, st)
	case proto.StreamExec:
		rt.serveExec(ctx, st)
	case proto.StreamScreen:
		rt.serveScreen(ctx, st)
	case proto.StreamDiskUsage:
		rt.serveDiskUsage(ctx, st)
	default:
		rt.Log.Warn("hub opened a stream of unknown kind", "kind", h.Kind)
	}
}

// streamConn is the subset of *yamux.Stream used here (tests use net.Pipe).
type streamConn interface {
	io.ReadWriteCloser
	SetDeadline(time.Time) error
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

func writeReply(st streamConn, v any) error {
	st.SetWriteDeadline(time.Now().Add(rpcWriteTimeout))
	return wire.WriteMsg(st, v)
}

func (rt *Runtime) serveAction(ctx context.Context, st streamConn) {
	var req proto.ActionRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	allowed, what := actionAllowed(rt.Policy(), req)
	var resp proto.ActionResponse
	switch {
	case !allowed:
		resp = proto.ActionResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (" + what + ") is turned off in this host's agent.toml"}
	case rt.Broker == nil:
		resp = proto.ActionResponse{Code: CodeUnsupported, Message: "this agent has no broker"}
	default:
		actx, cancel := context.WithTimeout(ctx, actionTimeout)
		resp = rt.Broker.Action(actx, req)
		cancel()
	}
	rt.Log.Info("action", "platform", req.Platform, "guest", req.GuestID, "action", req.Action,
		"ok", resp.OK, "noop", resp.Noop, "state", resp.State, "code", resp.Code)
	writeReply(st, resp)
}

// actionAllowed applies the local policy: host actions need host_power
// (power alone is not enough), ctrl_alt_del needs console, every other
// guest action (incl. pause and snapshots) needs power.
func actionAllowed(pol proto.Policy, req proto.ActionRequest) (bool, string) {
	switch {
	case req.Platform == proto.PlatformHost || req.Action == proto.ActionHostReboot || req.Action == proto.ActionHostShutdown:
		return pol.HostPower, "host_power"
	case req.Action == proto.ActionCtrlAltDel:
		return pol.Console, "console"
	}
	return pol.Power, "power actions"
}

// consoleAllowed: a root shell on the host and the host's own screen (a
// Mac's, which is signed in as its user) need host_shell (console alone is
// not enough); everything else needs console.
func consoleAllowed(pol proto.Policy, req proto.ConsoleRequest) (bool, string) {
	if req.Platform == proto.PlatformHost && (req.Protocol == proto.ProtoShell || req.Protocol == proto.ProtoVNC) {
		return pol.HostShell, "host_shell"
	}
	return pol.Console, "console"
}

func (rt *Runtime) serveInspect(ctx context.Context, st streamConn) {
	var req proto.InspectRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	var resp proto.InspectResponse
	pol := rt.Policy()
	switch {
	case req.Kind == proto.InspectSnapshots && !pol.Power && !pol.Manage:
		// Snapshots are taken and restored under power; managing guests
		// lists them too.
		resp = proto.InspectResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (power or manage) is turned off in this host's agent.toml"}
	case req.Kind == proto.InspectUpdates && !pol.Console && !pol.Diagnose:
		// The waiting updates are a read-only check's answer too (SWU-11).
		resp = proto.InspectResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (diagnose or console) is turned off in this host's agent.toml"}
	case req.Kind != proto.InspectSnapshots && req.Kind != proto.InspectUpdates && !pol.Console:
		resp = proto.InspectResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (console) is turned off in this host's agent.toml"}
	case rt.Broker == nil:
		resp = proto.InspectResponse{Code: CodeUnsupported, Message: "this agent has no broker"}
	default:
		ictx, cancel := context.WithTimeout(ctx, inspectTimeout)
		resp = rt.Broker.Inspect(ictx, req)
		cancel()
	}
	rt.Log.Debug("inspect", "kind", req.Kind, "platform", req.Platform, "guest", req.GuestID, "code", resp.Code)
	writeReply(st, resp)
}

func (rt *Runtime) serveManage(ctx context.Context, st streamConn) {
	var req proto.ManageRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	var resp proto.ManageResponse
	switch {
	case !rt.Policy().Manage:
		resp = proto.ManageResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (manage) is turned off in this host's agent.toml"}
	case rt.Broker == nil:
		resp = proto.ManageResponse{Code: CodeUnsupported, Message: "this agent has no broker"}
	default:
		budget := manageTimeout
		if b := proto.ManageBudget(req); b > 0 {
			budget = b // backup places: pulling an image, moving backups take a while
		}
		mctx, cancel := context.WithTimeout(ctx, budget)
		resp = rt.Broker.Manage(mctx, req)
		cancel()
	}
	task := ""
	if resp.Task != nil {
		task = resp.Task.ID
	}
	if resp.OK && (req.Op == proto.OpBackupJobCreate || req.Op == proto.OpBackupJobUpdate || req.Op == proto.OpBackupJobDelete) {
		rt.refreshBackupJobs()
	}
	if resp.OK && (req.Platform == proto.PlatformUnraid || req.Op == proto.OpGuestAutostart || req.Op == proto.OpContainerUpdate) &&
		req.Op != proto.OpTaskStatus && req.Op != proto.OpTaskList {
		rt.RefreshUnraid()
	}
	if libvirtChanged(req, resp) {
		rt.refreshLibvirt()
	}
	if resp.OK && proto.LongManageOp(req.Op) {
		rt.refreshBackupPlace()
	}
	rt.Log.Info("manage", "op", req.Op, "platform", req.Platform, "guest", req.GuestID, "ok", resp.OK, "code", resp.Code, "task", task)
	writeReply(st, resp)
}

// refreshBackupPlace reads the backup place and the Docker containers
// again with the next report, which it sends at once: a place was set
// up, changed or removed through the agent.
func (rt *Runtime) refreshBackupPlace() {
	c, ok := rt.Collector.(interface{ RefreshBackupPlace() })
	if !ok {
		return
	}
	c.RefreshBackupPlace()
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
}

// refreshBackupJobs reads the backup jobs again with the next report, so
// the guests' coverage (Guest.BackupJob) follows a changed job within
// seconds instead of at the collector's next slow read (5 minutes).
func (rt *Runtime) refreshBackupJobs() {
	c, ok := rt.Collector.(interface{ RefreshBackupJobs() })
	if !ok {
		return
	}
	c.RefreshBackupJobs()
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
}

// RefreshPackages reports at once when a package task started; when one
// ended (ended) it also reads the waiting updates and the reboot need
// again (Broker.OnPackageChange calls it).
func (rt *Runtime) RefreshPackages(ended bool) {
	if c, ok := rt.Collector.(interface{ RefreshPackages() }); ok && ended {
		c.RefreshPackages()
	}
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
}

// RefreshUnraid reads unRAID's state, the containers and the libvirt
// autostart flags again and reports at once: an unRAID operation started
// or ended, or an autostart changed (Broker.OnUnraidChange calls it when
// an unRAID task ends).
func (rt *Runtime) RefreshUnraid() {
	c, ok := rt.Collector.(interface{ RefreshUnraid() })
	if !ok {
		return
	}
	c.RefreshUnraid()
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
}

func (rt *Runtime) serveDiagnose(ctx context.Context, st streamConn) {
	var req proto.DiagnoseRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	start := time.Now()
	var resp proto.DiagnoseResponse
	switch {
	case !rt.Policy().Diagnose:
		resp = proto.DiagnoseResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (diagnose) is turned off in this host's agent.toml"}
	case rt.Diagnostics == nil:
		resp = proto.DiagnoseResponse{Code: CodeUnsupported, Message: "this agent has no diagnostics"}
	default:
		dctx, cancel := context.WithTimeout(ctx, diagnoseTimeout)
		resp = rt.Diagnostics.Run(dctx, req)
		cancel()
	}
	rt.Log.Info("diagnose", "check", req.Check, "args", req.Args, "code", resp.Code,
		"bytes", len(resp.Output), "truncated", resp.Truncated, "duration", time.Since(start).Round(time.Millisecond))
	writeReply(st, resp)
}

func (rt *Runtime) serveDiskUsage(ctx context.Context, st streamConn) {
	var req proto.DiskUsageRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	start := time.Now()
	var resp proto.DiskUsageResponse
	switch {
	case !rt.Policy().Diagnose:
		resp = proto.DiskUsageResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (diagnose) is turned off in this host's agent.toml"}
	case rt.DiskUsage == nil:
		resp = proto.DiskUsageResponse{Code: CodeUnsupported, Message: "this agent cannot measure disk usage"}
	default:
		dctx, cancel := context.WithTimeout(ctx, diskUsageTimeout)
		resp = rt.DiskUsage.DiskUsage(dctx, req)
		cancel()
	}
	rt.Log.Info("disk_usage", "mount", logCommand(req.Mount), "code", resp.Code, "partial", resp.Partial,
		"categories", len(resp.Categories), "folders", len(resp.Folders),
		"duration", time.Since(start).Round(time.Millisecond))
	writeReply(st, resp)
}

// Exec timeouts (proto.ExecRequest.TimeoutS), as package diagnose applies
// them; the stream allows execMargin more (systemd-run, output).
const (
	execDefault = 120 * time.Second
	execMax     = 1800 * time.Second
	execMargin  = 30 * time.Second
)

func execBudget(timeoutS int) time.Duration {
	d := time.Duration(timeoutS) * time.Second
	switch {
	case timeoutS <= 0:
		d = execDefault
	case d > execMax:
		d = execMax
	}
	return d + execMargin
}

// serveExec runs one of the assistant's shell commands. It is as powerful
// as the host shell, so it needs host_shell; every command is logged. A
// started command runs to its end or its timeout: a dropped hub
// connection does not stop it halfway (under systemd it could not anyway:
// its transient unit outlives systemd-run).
func (rt *Runtime) serveExec(ctx context.Context, st streamConn) {
	var req proto.ExecRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	cmd := logCommand(req.Command)
	var resp proto.ExecResponse
	switch {
	case !rt.Policy().HostShell:
		resp = proto.ExecResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (host_shell) is turned off in this host's agent.toml"}
		rt.Log.Info("assistant command refused", "command", cmd, "code", resp.Code)
	case rt.Diagnostics == nil:
		resp = proto.ExecResponse{Code: CodeUnsupported, Message: "this agent cannot run commands"}
	default:
		budget := execBudget(req.TimeoutS)
		rt.Log.Info("assistant command started", "command", cmd, "timeout", budget-execMargin)
		ectx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
		resp = rt.Diagnostics.Exec(ectx, req)
		cancel()
		rt.Log.Info("assistant command", "command", cmd, "exit", resp.ExitCode, "code", resp.Code,
			"duration", (time.Duration(resp.DurationMs) * time.Millisecond).Round(time.Millisecond),
			"timed_out", resp.TimedOut, "bytes", len(resp.Output))
	}
	writeReply(st, resp)
}

// serveScreen runs one step on a Mac's screen. Driving the signed-in
// person's desktop is as powerful as a root shell, so it needs host_shell;
// reading the state ("status") is a check, so diagnose is enough for it.
// The password of account.set and typed text are never logged.
func (rt *Runtime) serveScreen(ctx context.Context, st streamConn) {
	var req proto.ScreenRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	pol := rt.Policy()
	start := time.Now()
	var resp proto.ScreenResponse
	switch {
	case !pol.HostShell && !(req.Op == proto.ScreenStatus && pol.Diagnose):
		what := "host_shell"
		if req.Op == proto.ScreenStatus {
			what = "host_shell or diagnose"
		}
		resp = proto.ScreenResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (" + what + ") is turned off in this host's agent.toml"}
	case rt.Screen == nil:
		resp = proto.ScreenResponse{Code: CodeUnsupported, Message: "This server has no screen the agent can reach (not a Mac, or an older agent)."}
	default:
		sctx, cancel := context.WithTimeout(ctx, proto.ScreenStepLimit(req.Op)+screenGrace)
		resp = rt.Screen.Screen(sctx, req)
		cancel()
	}
	attrs := []any{"op", logCommand(req.Op), "ok", resp.OK, "code", resp.Code, "duration", time.Since(start).Round(time.Millisecond)}
	switch req.Op {
	case proto.ScreenClick, proto.ScreenDrag, proto.ScreenScroll:
		attrs = append(attrs, "x", req.X, "y", req.Y)
	case proto.ScreenKeys:
		attrs = append(attrs, "keys", logCommand(req.Keys))
	case proto.ScreenType, proto.ScreenUISet:
		attrs = append(attrs, "characters", len([]rune(req.Text)))
	case proto.ScreenAccountSet:
		if req.Account != nil {
			attrs = append(attrs, "user", logCommand(req.Account.User))
		}
	case proto.ScreenUIPress, proto.ScreenUIMenu, proto.ScreenUIFocus, proto.ScreenUIOpen:
		attrs = append(attrs, "app", logCommand(req.App), "name", logCommand(req.Name), "path", logCommand(strings.Join(req.Path, " > ")), "target", logCommand(req.Target))
	}
	if req.Op == proto.ScreenStatus || req.Op == proto.ScreenLook || req.Op == proto.ScreenUIList || req.Op == proto.ScreenUIApps {
		rt.Log.Debug("screen", attrs...)
	} else {
		rt.Log.Info("screen", attrs...)
	}
	writeReply(st, resp)
}

// logCommand is a command line for the log: one line, at most 200
// characters.
func logCommand(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200]) + "…"
	}
	return s
}

func (rt *Runtime) serveThumbnail(ctx context.Context, st streamConn) {
	var req proto.ThumbnailRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	var resp proto.ThumbnailResponse
	switch {
	case req.Platform == proto.PlatformHost && !rt.Policy().HostShell:
		// The host's screen (a Mac's) is the signed-in person's desktop.
		resp = proto.ThumbnailResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (host_shell) is turned off in this host's agent.toml"}
	case req.Platform != proto.PlatformHost && !rt.Policy().Console:
		resp = proto.ThumbnailResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (console) is turned off in this host's agent.toml"}
	case rt.Broker == nil:
		resp = proto.ThumbnailResponse{Code: CodeUnsupported, Message: "this agent has no broker"}
	default:
		tctx, cancel := context.WithTimeout(ctx, thumbnailTimeout)
		resp = rt.Broker.Thumbnail(tctx, req)
		cancel()
	}
	if resp.Code != "" {
		rt.Log.Debug("thumbnail failed", "platform", req.Platform, "guest", req.GuestID, "code", resp.Code)
	}
	writeReply(st, resp)
}

func (rt *Runtime) acquireConsole() bool {
	rt.consoleMu.Lock()
	defer rt.consoleMu.Unlock()
	if rt.consoleN >= rt.MaxConsoles {
		return false
	}
	rt.consoleN++
	return true
}

func (rt *Runtime) releaseConsole() {
	rt.consoleMu.Lock()
	rt.consoleN--
	rt.consoleMu.Unlock()
}

// ConsoleCount returns the number of open console sessions.
func (rt *Runtime) ConsoleCount() int {
	rt.consoleMu.Lock()
	defer rt.consoleMu.Unlock()
	return rt.consoleN
}

func (rt *Runtime) serveConsole(ctx context.Context, st streamConn) {
	var req proto.ConsoleRequest
	if err := wire.ReadMsg(st, &req); err != nil {
		return
	}
	st.SetReadDeadline(time.Time{})
	log := rt.Log.With("session", req.SessionID, "platform", req.Platform, "guest", req.GuestID, "protocol", req.Protocol)
	hostShell := req.Platform == proto.PlatformHost && req.Protocol == proto.ProtoShell

	if ok, what := consoleAllowed(rt.Policy(), req); !ok {
		log.Info("console refused", "code", CodeRemoteControlDisabled)
		writeReply(st, proto.ConsoleResponse{Code: CodeRemoteControlDisabled, Message: "Remote control (" + what + ") is turned off in this host's agent.toml"})
		return
	}
	if rt.Broker == nil {
		writeReply(st, proto.ConsoleResponse{Code: CodeUnsupported, Message: "this agent has no broker"})
		return
	}
	if !rt.acquireConsole() {
		log.Info("console refused", "code", CodeTooManySessions)
		writeReply(st, proto.ConsoleResponse{Code: CodeTooManySessions, Message: "Too many open consoles on this host. Close one and try again."})
		return
	}
	defer rt.releaseConsole()

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type opened struct {
		s    ConsoleSession
		resp proto.ConsoleResponse
	}
	ch := make(chan opened, 1)
	go func() {
		s, r := rt.Broker.Console(sctx, req)
		ch <- opened{s, r}
	}()
	var sess ConsoleSession
	var resp proto.ConsoleResponse
	select {
	case o := <-ch:
		sess, resp = o.s, o.resp
	case <-time.After(rt.ConsoleOpenMax):
		cancel()
		resp = proto.ConsoleResponse{Code: CodeTimeout, Message: "Opening the console timed out"}
		go func() { discardSession((<-ch).s) }()
	case <-ctx.Done():
		go func() { discardSession((<-ch).s) }()
		return
	}
	if resp.OK && sess == nil {
		resp = proto.ConsoleResponse{Code: CodeOpenFailed, Message: "console could not be opened"}
	}
	if !resp.OK {
		discardSession(sess)
		log.Info("console open failed", "code", resp.Code, "msg", resp.Message)
		writeReply(st, resp)
		return
	}
	if err := writeReply(st, resp); err != nil {
		discardSession(sess)
		return
	}
	st.SetWriteDeadline(time.Time{})
	start := time.Now()
	if hostShell {
		log.Warn("root shell on the host opened through the hub")
		defer func() { log.Warn("root shell on the host closed", "duration", time.Since(start).Round(time.Second)) }()
	}
	log.Info("console opened", "resolution", resp.Resolution)

	var wmu sync.Mutex
	fw := wire.NewFrameWriter(st)
	closed := false
	out := func(f wire.Frame) error {
		wmu.Lock()
		defer wmu.Unlock()
		if closed {
			return io.ErrClosedPipe
		}
		st.SetWriteDeadline(time.Now().Add(consoleWriteMax))
		return fw.Write(f)
	}

	in := make(chan wire.Frame, 32)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(in)
		defer cancel()
		fr := wire.NewFrameReader(st)
		for {
			f, err := fr.Read()
			if err != nil {
				return
			}
			if f.Kind == wire.FrameControl {
				var cc wire.ConsoleControl
				if json.Unmarshal(f.Payload, &cc) == nil && cc.Type == "ping" {
					b, _ := json.Marshal(wire.ConsoleControl{Type: "pong", ID: cc.ID})
					if out(wire.Frame{Kind: wire.FrameControl, Payload: b}) != nil {
						return
					}
					continue
				}
			}
			select {
			case in <- f:
			case <-sctx.Done():
				return
			}
		}
	}()

	err := sess.Run(sctx, in, out)
	cancel()
	wmu.Lock()
	closed = true
	wmu.Unlock()
	st.SetReadDeadline(time.Now()) // unblock the reader
	<-readerDone
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
		log.Info("console closed", "duration", time.Since(start).Round(time.Second), "err", err)
	} else {
		log.Info("console closed", "duration", time.Since(start).Round(time.Second))
	}
}

// discardSession releases a session that will not be run.
func discardSession(s ConsoleSession) {
	if s == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	in := make(chan wire.Frame)
	close(in)
	_ = s.Run(ctx, in, func(wire.Frame) error { return io.ErrClosedPipe })
}
