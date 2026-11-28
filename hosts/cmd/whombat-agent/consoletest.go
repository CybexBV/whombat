//go:build !windows

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/term"

	"rackoon/internal/agent"
	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// cmdConsoleTest opens a broker session locally, without a hub, for manual
// verification over ssh: terminals are attached to this terminal; VNC and
// SPICE run the browser side of the handshake and report the resolution.
func cmdConsoleTest(args []string) error {
	fs := flag.NewFlagSet("console-test", flag.ExitOnError)
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	platform := fs.String("platform", "incus", "docker | incus | libvirt | pve | host")
	guest := fs.String("guest", "", "guest id (container name, Incus instance, libvirt domain, PVE vmid; \"host\" for the host)")
	protocol := fs.String("proto", "", "shell | tty | serial | vnc | spice | logs (default: the guest's default)")
	shot := fs.String("screenshot", "", "write a screenshot to FILE (.png or .jpg) instead of opening a console")
	maxW := fs.Int("max-width", 0, "screenshot width limit (0 = full size)")
	action := fs.String("action", "", "run an action instead: start, shutdown, reboot, force_stop, stop, restart, ctrl_alt_del, pause, resume, snapshot_create|restore|delete (host: host_reboot, host_shutdown)")
	var actionArgs argList
	fs.Var(&actionArgs, "arg", "action argument key=value (snapshot=NAME, description=TEXT, memory=true); repeatable")
	inspectKind := fs.String("inspect", "", "print an inspect view as JSON: processes | ports | services | updates (host) | snapshots (guest)")
	limit := fs.Int("limit", 0, "inspect row limit")
	list := fs.Bool("list", false, "list the platform's guests and their console capabilities")
	manageOp := fs.String("manage", "", "run a manage operation instead and print its answer as JSON (host: packages.check, packages.install, task.status, task.stop, task.list)")
	task := fs.String("task", "", "manage: the task (task.status, task.stop)")
	packages := fs.String("packages", "", "manage: packages.install's packages, comma separated")
	logStart := fs.Int("log-start", 0, "manage: task.status's first log line (-1: none)")
	follow := fs.Bool("follow", false, "manage: follow the task until it ends, printing its log")
	packageReport := fs.Bool("package-report", false, "print the report's running package task and the last one that ended")
	level := fs.String("log-level", "warn", "log level")
	fs.Parse(args)

	log := newLogger(*level)
	cfg, err := loadOrDefaultConfig(*dir)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()

	var inv *proto.Report
	if *platform == proto.PlatformHost {
		*guest = broker.HostID
		inv = &proto.Report{At: time.Now().UTC()}
		if *protocol == "" {
			*protocol = proto.ProtoShell
		}
	} else {
		invCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		inv, err = broker.LocalInventory(invCtx, cfg, *platform)
		cancel()
		if err != nil {
			return fmt.Errorf("inventory: %w", err)
		}
	}
	if *list {
		for _, g := range inv.AllGuests() {
			b, _ := json.Marshal(g.Console)
			fmt.Printf("%-24s %-9s %-8s %s\n", g.ID, g.Kind, g.State, b)
		}
		return nil
	}
	if *guest == "" {
		return errors.New("--guest is required")
	}
	g := inv.FindGuest(*platform, *guest)
	if *platform == proto.PlatformHost {
		g = &proto.Guest{ID: broker.HostID, Kind: "host", State: proto.StateRunning}
	}
	if g == nil {
		return fmt.Errorf("guest %q not found on %s", *guest, *platform)
	}
	var b testBroker = broker.NewBroker(cfg, func() *proto.Report { return inv }, log)
	if runtime.GOOS == "darwin" {
		if *platform != proto.PlatformHost {
			return errors.New("a Mac has only --platform host")
		}
		b = broker.NewMacBroker(cfg, log, nil)
	}

	switch {
	case *manageOp != "" || *packageReport:
		return consoleTestManage(ctx, b, manageTest{op: *manageOp, platform: *platform, task: *task, packages: *packages,
			logStart: *logStart, follow: *follow, report: *packageReport})

	case *inspectKind != "":
		start := time.Now()
		ictx, cancel := context.WithTimeout(ctx, 60*time.Second)
		resp := b.Inspect(ictx, proto.InspectRequest{Kind: *inspectKind, Platform: *platform, GuestID: *guest, Limit: *limit})
		cancel()
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(resp)
		fmt.Fprintf(os.Stderr, "(%.1f s)\n", time.Since(start).Seconds())
		if resp.Code != "" {
			return fmt.Errorf("inspect: %s: %s", resp.Code, resp.Message)
		}
		return nil

	case *action != "":
		start := time.Now()
		fmt.Fprintf(os.Stderr, "%s %s (state %s) ...\n", *action, g.ID, g.State)
		resp := b.Action(ctx, proto.ActionRequest{Platform: *platform, GuestID: *guest, Action: *action, Args: actionArgs.m})
		out, _ := json.Marshal(resp)
		fmt.Printf("%s  (%.1f s)\n", out, time.Since(start).Seconds())
		if !resp.OK {
			return errors.New("action failed")
		}
		return nil

	case *shot != "":
		format := "png"
		if ext := strings.ToLower(filepath.Ext(*shot)); ext == ".jpg" || ext == ".jpeg" {
			format = "jpeg"
		}
		start := time.Now()
		resp := b.Thumbnail(ctx, proto.ThumbnailRequest{Platform: *platform, GuestID: *guest, MaxWidth: *maxW, Format: format})
		if resp.Code != "" {
			return fmt.Errorf("screenshot: %s: %s", resp.Code, resp.Message)
		}
		if err := os.WriteFile(*shot, resp.Image, 0o600); err != nil {
			return err
		}
		fmt.Printf("wrote %s: %dx%d %s, %d bytes (%.1f s)\n", *shot, resp.Width, resp.Height, format, len(resp.Image), time.Since(start).Seconds())
		return nil
	}

	if *protocol == "" {
		*protocol = g.Console.Default
	}
	cols, rows := 80, 24
	if w, h, err := term.GetSize(int(os.Stdin.Fd())); err == nil {
		cols, rows = w, h
	}
	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	sess, resp := b.Console(sctx, proto.ConsoleRequest{
		SessionID: "cs_local", Platform: *platform, GuestID: *guest, Protocol: *protocol, Cols: cols, Rows: rows,
	})
	if !resp.OK {
		return fmt.Errorf("console: %s: %s", resp.Code, resp.Message)
	}
	fmt.Fprintf(os.Stderr, "console opened: %s %s %s resolution=%q\n", *platform, g.ID, *protocol, resp.Resolution)

	lc := newLocalConsole()
	runErr := make(chan error, 1)
	go func() { runErr <- sess.Run(sctx, lc.in, lc.out) }()

	var err2 error
	switch *protocol {
	case proto.ProtoShell, proto.ProtoTTY, proto.ProtoSerial, proto.ProtoLogs:
		err2 = lc.terminal(sctx, runErr)
	case proto.ProtoVNC:
		err2 = lc.vncCheck(sctx)
	case proto.ProtoSPICE:
		err2 = lc.spiceCheck(sctx)
	default:
		err2 = fmt.Errorf("unknown protocol %q", *protocol)
	}
	scancel()
	select {
	case err := <-runErr:
		if err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "session ended: %v\n", err)
		}
	case <-time.After(10 * time.Second):
		fmt.Fprintln(os.Stderr, "session did not stop within 10 s")
	}
	if st := lc.lastStatus(); st != "" {
		fmt.Fprintf(os.Stderr, "last status: %s\n", st)
	}
	return err2
}

// localConsole plays the hub + browser side of a session in-process.
type localConsole struct {
	in chan wire.Frame

	mu     sync.Mutex
	chans  map[uint16]*io.PipeWriter
	opened map[uint16]chan error
	status string
}

func newLocalConsole() *localConsole {
	return &localConsole{
		in:     make(chan wire.Frame, 64),
		chans:  map[uint16]*io.PipeWriter{},
		opened: map[uint16]chan error{},
	}
}

func (l *localConsole) lastStatus() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status
}

// out receives frames from the session.
func (l *localConsole) out(f wire.Frame) error {
	switch f.Kind {
	case wire.FrameData:
		l.mu.Lock()
		pw := l.chans[f.Channel]
		l.mu.Unlock()
		if pw != nil {
			pw.Write(f.Payload)
		}
	case wire.FrameControl:
		var cc wire.ConsoleControl
		if json.Unmarshal(f.Payload, &cc) != nil {
			return nil
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		switch cc.Type {
		case "status":
			l.status = string(f.Payload)
			fmt.Fprintf(os.Stderr, "\r[control] %s\r\n", f.Payload)
		case "opened", "closed":
			if ch := l.opened[cc.Channel]; ch != nil {
				if cc.Type == "opened" {
					ch <- nil
				} else {
					ch <- errors.New("channel closed")
				}
				delete(l.opened, cc.Channel)
			}
			if cc.Type == "closed" {
				if pw := l.chans[cc.Channel]; pw != nil {
					pw.Close()
				}
			}
		default:
			fmt.Fprintf(os.Stderr, "\r[control] %s\r\n", f.Payload)
		}
	}
	return nil
}

// channel returns a ReadWriteCloser for one session channel.
func (l *localConsole) channel(id uint16) *chanRW {
	pr, pw := io.Pipe()
	l.mu.Lock()
	l.chans[id] = pw
	l.mu.Unlock()
	return &chanRW{l: l, id: id, r: pr}
}

func (l *localConsole) control(cc wire.ConsoleControl) {
	b, _ := json.Marshal(cc)
	l.in <- wire.Frame{Kind: wire.FrameControl, Payload: b}
}

type chanRW struct {
	l  *localConsole
	id uint16
	r  *io.PipeReader
}

func (c *chanRW) Read(p []byte) (int, error) { return c.r.Read(p) }
func (c *chanRW) Write(p []byte) (int, error) {
	b := make([]byte, len(p))
	copy(b, p)
	c.l.in <- wire.Frame{Kind: wire.FrameData, Channel: c.id, Payload: b}
	return len(p), nil
}
func (c *chanRW) Close() error {
	if c.id != 0 {
		c.l.control(wire.ConsoleControl{Type: "close", Channel: c.id})
	}
	return c.r.Close()
}

// terminal attaches the session to this terminal until Ctrl+] or the
// session ends.
func (l *localConsole) terminal(ctx context.Context, runErr chan error) error {
	ch := l.channel(0)
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		old, err := term.MakeRaw(fd)
		if err != nil {
			return err
		}
		defer term.Restore(fd, old)
		fmt.Fprint(os.Stderr, "connected; press Ctrl+] to quit\r\n")
		winch := make(chan os.Signal, 1)
		signal.Notify(winch, syscall.SIGWINCH)
		defer signal.Stop(winch)
		go func() {
			for range winch {
				if w, h, err := term.GetSize(fd); err == nil {
					l.control(wire.ConsoleControl{Type: "resize", Cols: w, Rows: h})
				}
			}
		}()
		if w, h, err := term.GetSize(fd); err == nil {
			l.control(wire.ConsoleControl{Type: "resize", Cols: w, Rows: h})
		}
	}
	go io.Copy(os.Stdout, ch)
	quit := make(chan struct{})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if i := strings.IndexByte(string(buf[:n]), 0x1d); i >= 0 { // Ctrl+]
					if i > 0 {
						ch.Write(buf[:i])
					}
					close(quit)
					return
				}
				ch.Write(buf[:n])
			}
			if err != nil {
				close(quit)
				return
			}
		}
	}()
	select {
	case <-quit:
	case err := <-runErr:
		runErr <- err
	case <-ctx.Done():
	}
	fmt.Fprint(os.Stderr, "\r\ndisconnected\r\n")
	return nil
}

// vncCheck runs the browser side of RFB (security None) through the
// session and reads one framebuffer update.
func (l *localConsole) vncCheck(ctx context.Context) error {
	c := l.channel(0)
	done := make(chan error, 1)
	go func() { done <- rfbBrowser(c) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(20 * time.Second):
		return errors.New("vnc: timeout")
	}
}

func rfbBrowser(c io.ReadWriter) error {
	var ver [12]byte
	if _, err := io.ReadFull(c, ver[:]); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "rfb: server version %q\n", strings.TrimSpace(string(ver[:])))
	io.WriteString(c, "RFB 003.008\n")
	var n [1]byte
	io.ReadFull(c, n[:])
	types := make([]byte, n[0])
	io.ReadFull(c, types)
	fmt.Fprintf(os.Stderr, "rfb: security types offered to the browser: %v (1 = None)\n", types)
	if len(types) != 1 || types[0] != 1 {
		return errors.New("rfb: expected only security type None")
	}
	c.Write([]byte{1})
	var res uint32
	binary.Read(c, binary.BigEndian, &res)
	if res != 0 {
		return fmt.Errorf("rfb: security result %d", res)
	}
	c.Write([]byte{1}) // ClientInit shared
	var si [24]byte
	if _, err := io.ReadFull(c, si[:]); err != nil {
		return err
	}
	name := make([]byte, binary.BigEndian.Uint32(si[20:24]))
	io.ReadFull(c, name)
	w, h := binary.BigEndian.Uint16(si[0:2]), binary.BigEndian.Uint16(si[2:4])
	fmt.Fprintf(os.Stderr, "rfb: ServerInit %dx%d bpp=%d name=%q\n", w, h, si[4], name)
	// SetEncodings: Raw only; FramebufferUpdateRequest for a 64x64 corner.
	c.Write([]byte{2, 0, 0, 1, 0, 0, 0, 0})
	req := []byte{3, 0, 0, 0, 0, 0, 0, 64, 0, 64}
	c.Write(req)
	var hdr [4]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return err
	}
	if hdr[0] != 0 {
		return fmt.Errorf("rfb: expected FramebufferUpdate, got message type %d", hdr[0])
	}
	nr := binary.BigEndian.Uint16(hdr[2:4])
	var rect [12]byte
	io.ReadFull(c, rect[:])
	rw, rh := binary.BigEndian.Uint16(rect[4:6]), binary.BigEndian.Uint16(rect[6:8])
	enc := int32(binary.BigEndian.Uint32(rect[8:12]))
	if enc == 0 {
		px := make([]byte, int(rw)*int(rh)*int(si[4]/8))
		if _, err := io.ReadFull(c, px); err != nil {
			return err
		}
	}
	fmt.Fprintf(os.Stderr, "rfb: FramebufferUpdate with %d rectangle(s), first %dx%d encoding %d: pixels flow\n", nr, rw, rh, enc)
	fmt.Printf("vnc OK resolution=%dx%d\n", w, h)
	return nil
}

// spiceCheck runs a minimal SPICE client (main + display channel) through
// the session's channel multiplexing.
func (l *localConsole) spiceCheck(ctx context.Context) error {
	var mu sync.Mutex
	next := uint16(0)
	dial := func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
		mu.Lock()
		id := next
		next++
		mu.Unlock()
		c := l.channel(id)
		if id == 0 {
			return c, "", false, nil
		}
		wait := make(chan error, 1)
		l.mu.Lock()
		l.opened[id] = wait
		l.mu.Unlock()
		l.control(wire.ConsoleControl{Type: "open", Channel: id})
		select {
		case err := <-wait:
			if err != nil {
				return nil, "", false, err
			}
		case <-time.After(15 * time.Second):
			return nil, "", false, errors.New("open timeout")
		}
		fmt.Fprintf(os.Stderr, "spice: channel %d opened\n", id)
		return c, "", false, nil
	}
	res, err := broker.SpiceProbe(ctx, dial)
	if res != nil {
		fmt.Fprintf(os.Stderr, "spice: server channels %v\n", res.Channels)
	}
	if err != nil {
		return err
	}
	time.Sleep(300 * time.Millisecond) // let the passive scanner report
	fmt.Printf("spice OK resolution=%s\n", res.Resolution())
	return nil
}

// argList collects repeated --arg key=value flags.
type argList struct{ m map[string]string }

func (a *argList) String() string { return fmt.Sprint(a.m) }

func (a *argList) Set(v string) error {
	k, val, ok := strings.Cut(v, "=")
	if !ok || k == "" {
		return errors.New("want key=value")
	}
	if a.m == nil {
		a.m = map[string]string{}
	}
	a.m[k] = val
	return nil
}

// manageTest is console-test's --manage.
type manageTest struct {
	op, platform, task, packages string
	logStart                     int
	follow, report               bool
}

// consoleTestManage runs one manage operation through the broker, as the
// hub's manage stream would, and prints the answer; --follow then asks
// task.status every two seconds until the task ended, printing its log as
// it grows (an install keeps running when this process is killed).
// testBroker is the broker console-test drives (Linux's or a Mac's).
type testBroker interface {
	agent.Broker
	PackageReport() (*proto.PackageTask, *proto.PackageLast)
}

func consoleTestManage(ctx context.Context, b testBroker, m manageTest) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if m.report {
		task, last := b.PackageReport()
		return enc.Encode(map[string]any{"package_task": task, "package_last": last})
	}
	req := proto.ManageRequest{Op: m.op, Platform: m.platform, Task: m.task, LogStart: m.logStart}
	if m.packages != "" {
		req.Packages = strings.Split(m.packages, ",")
	}
	resp := b.Manage(ctx, req)
	enc.Encode(resp)
	if !resp.OK {
		return fmt.Errorf("%s: %s: %s", m.op, resp.Code, resp.Message)
	}
	if !m.follow {
		return nil
	}
	id := m.task
	if resp.Task != nil {
		id = resp.Task.ID
	}
	next := 0
	for {
		st := b.Manage(ctx, proto.ManageRequest{Op: proto.OpTaskStatus, Platform: m.platform, Task: id, LogStart: next})
		if !st.OK || st.TaskStatus == nil {
			return fmt.Errorf("task.status: %s: %s", st.Code, st.Message)
		}
		for _, l := range st.TaskStatus.Log {
			fmt.Fprintln(os.Stderr, "| "+l)
		}
		next = st.TaskStatus.LogNext
		if st.TaskStatus.Status != "running" {
			st.TaskStatus.Log = nil
			return enc.Encode(st.TaskStatus)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
