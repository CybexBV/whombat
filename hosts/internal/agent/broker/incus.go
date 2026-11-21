package broker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	incus "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// incusDriver talks to the local Incus daemon over its Unix socket with the
// agent's own (root) trust:
//
//	container shell:  POST /1.0/instances/<n>/exec (interactive PTY) + "window-resize"
//	container tty:    POST /1.0/instances/<n>/console type=console
//	VM serial:        POST /1.0/instances/<n>/console type=console
//	VM spice (VGA):   POST /1.0/instances/<n>/console type=vga; every SPICE
//	                  channel is a new connection to the operation's "0" websocket
//	screenshot:       GET /1.0/instances/<n>/console?type=vga (PNG; API
//	                  extension instance_console_screenshot)
//	actions:          PUT /1.0/instances/<n>/state (pause = freeze)
//	snapshots:        /1.0/instances/<n>/snapshots; restore = PUT /1.0/instances/<n> {"restore"}
//	manage:           incus_manage.go
type incusDriver struct {
	socket string // "" = $INCUS_SOCKET, /var/lib/incus/unix.socket or /run/incus/unix.socket

	mu         sync.Mutex
	shotBroken time.Time // when the screenshot API last failed with the 6.0 bug

	tasks incusTasks // operations started by manage (incus_manage.go)
	// inv is the latest inventory (task.list adds the failed operations
	// the collector reports); nil in tests.
	inv agent.InventoryFunc
}

func incusSocketPath() string {
	if p := os.Getenv("INCUS_SOCKET"); p != "" {
		return p
	}
	for _, p := range []string{"/var/lib/incus/unix.socket", "/run/incus/unix.socket"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "/var/lib/incus/unix.socket"
}

// splitIncusID splits "project/name" (non-default projects) into parts.
func splitIncusID(id string) (project, name string) {
	if p, n, ok := strings.Cut(id, "/"); ok {
		return p, n
	}
	return "", id
}

func (d *incusDriver) connect(id string) (incus.InstanceServer, string, error) {
	project, name := splitIncusID(id)
	if name == "" || strings.ContainsAny(name, "/?#") {
		return nil, "", codeErr(CodeInvalid, "invalid instance name")
	}
	c, err := incus.ConnectIncusUnix(d.socket, &incus.ConnectionArgs{UserAgent: "whombat-agent", SkipGetEvents: true})
	if err != nil {
		return nil, "", codeErr(CodePlatformError, "cannot reach Incus: "+err.Error())
	}
	if project != "" {
		c = c.UseProject(project)
	}
	return c, name, nil
}

func (d *incusDriver) state(ctx context.Context, g *proto.Guest) (string, error) {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return "", err
	}
	defer c.Disconnect()
	st, _, err := c.GetInstanceState(name)
	if err != nil {
		return "", codeErr(CodePlatformError, err.Error())
	}
	return normIncusState(st.Status), nil
}

func normIncusState(s string) string {
	switch strings.ToLower(s) {
	case "running":
		return proto.StateRunning
	case "stopped":
		return proto.StateStopped
	case "frozen":
		return proto.StatePaused
	}
	return strings.ToLower(s)
}

func (d *incusDriver) power(ctx context.Context, g *proto.Guest, action string) error {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return err
	}
	defer c.Disconnect()
	run := func(put api.InstanceStatePut) error {
		op, err := c.UpdateInstanceState(name, put, "")
		if err != nil {
			return err
		}
		return op.WaitContext(ctx)
	}
	switch action {
	case proto.ActionStart:
		err = run(api.InstanceStatePut{Action: "start", Timeout: -1})
	case proto.ActionShutdown:
		err = run(api.InstanceStatePut{Action: "stop", Timeout: actionWait})
	case proto.ActionStop:
		// Containers: graceful stop, then force after 30 s (like docker stop).
		err = run(api.InstanceStatePut{Action: "stop", Timeout: 30})
		if err != nil {
			if s, _ := d.stateOf(c, name); s == proto.StateRunning {
				err = run(api.InstanceStatePut{Action: "stop", Timeout: -1, Force: true})
			}
		}
	case proto.ActionForceStop:
		err = run(api.InstanceStatePut{Action: "stop", Timeout: -1, Force: true})
	case proto.ActionReboot, proto.ActionRestart:
		err = run(api.InstanceStatePut{Action: "restart", Timeout: actionWait})
	case proto.ActionPause:
		err = run(api.InstanceStatePut{Action: "freeze", Timeout: -1})
	case proto.ActionResume:
		err = run(api.InstanceStatePut{Action: "unfreeze", Timeout: -1})
	case proto.ActionCtrlAltDel:
		return codeErr(CodeUnsupportedAction, "Incus has no send-key API; Ctrl+Alt+Del is sent through the console")
	default:
		return codeErr(CodeUnsupportedAction, "unsupported action")
	}
	if err != nil {
		return codeErr(CodePlatformError, err.Error())
	}
	return nil
}

func (d *incusDriver) stateOf(c incus.InstanceServer, name string) (string, error) {
	st, _, err := c.GetInstanceState(name)
	if err != nil {
		return "", err
	}
	return normIncusState(st.Status), nil
}

// screenshot asks Incus for a VGA screendump (PNG). Incus 6.0 LTS cannot
// take screenshots (QEMU runs unprivileged and cannot write the file Incus
// asks for); then the agent renders the screen through a short SPICE
// connection, unless a SPICE client is connected (it would be kicked off).
func (d *incusDriver) screenshot(ctx context.Context, g *proto.Guest) ([]byte, error) {
	d.mu.Lock()
	skipAPI := time.Since(d.shotBroken) < 10*time.Minute
	d.mu.Unlock()
	if !skipAPI {
		raw, err := d.screenshotAPI(ctx, g)
		if err == nil {
			return raw, nil
		}
		var ce *codeError
		if !errors.As(err, &ce) || !strings.Contains(ce.msg, "Incus 6.0") {
			return nil, err
		}
		d.mu.Lock()
		d.shotBroken = time.Now()
		d.mu.Unlock()
	}
	return d.screenshotSPICE(ctx, g)
}

// incusRunDir is the instance's runtime directory (/run/incus/<dir>).
func incusRunDir(project, name string) string {
	if project != "" && project != "default" {
		return "/run/incus/" + project + "_" + name
	}
	return "/run/incus/" + name
}

func (d *incusDriver) screenshotSPICE(ctx context.Context, g *proto.Guest) ([]byte, error) {
	project, name := splitIncusID(g.ID)
	if n, err := unixPeers(incusRunDir(project, name) + "/qemu.spice"); err == nil && n > 0 {
		return nil, codeErr(CodeBusy, "a SPICE console is open for this VM; the thumbnail resumes when it closes")
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return nil, err
	}
	defer c.Disconnect()
	o, err := startIncusOp(c, "/instances/"+url.PathEscape(name)+"/console", api.InstanceConsolePost{Type: "vga"})
	if err != nil {
		return nil, codeErr(CodeCaptureFailed, "vga console: "+err.Error())
	}
	ctrl, err := o.ws("control")
	if err != nil {
		o.op.Cancel()
		return nil, codeErr(CodeCaptureFailed, err.Error())
	}
	go drainWS(ctrl)
	defer func() {
		closeWS(ctrl)
		waitOp(o.op, 2*time.Second)
	}()
	img, err := SpiceCapture(ctx, func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
		conn, err := o.ws("0")
		if err != nil {
			return nil, "", false, err
		}
		return newWSConn(conn), "", false, nil
	})
	if err != nil {
		return nil, codeErr(CodeCaptureFailed, "screen capture over SPICE: "+err.Error())
	}
	return EncodeImage(img, "png")
}

// screenshotAPI is GET /1.0/instances/<n>/console?type=vga.
func (d *incusDriver) screenshotAPI(ctx context.Context, g *proto.Guest) ([]byte, error) {
	project, name := splitIncusID(g.ID)
	sock := d.socket
	if sock == "" {
		sock = incusSocketPath()
	}
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dl net.Dialer
			return dl.DialContext(ctx, "unix", sock)
		},
	}}
	q := url.Values{"type": {"vga"}}
	if project != "" {
		q.Set("project", project)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://incus/1.0/instances/"+url.PathEscape(name)+"/console?"+q.Encode(), nil)
	resp, err := hc.Do(req)
	if err != nil {
		return nil, codeErr(CodePlatformError, "cannot reach Incus: "+err.Error())
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, codeErr(CodeCaptureFailed, err.Error())
	}
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		msg := e.Error
		if msg == "" {
			msg = "HTTP " + strconv.Itoa(resp.StatusCode)
		}
		if strings.Contains(msg, "Permission denied") {
			// Incus 6.0.x LTS writes the screendump into the instance
			// directory, which QEMU (running unprivileged) cannot write.
			msg = "Incus cannot take screenshots of this VM (known issue in Incus 6.0 LTS: " + msg + ")"
		}
		return nil, codeErr(CodeCaptureFailed, msg)
	}
	return body, nil
}

// incusOp starts an exec or console operation and returns its websocket
// secrets.
type incusOp struct {
	c   incus.InstanceServer
	op  incus.Operation
	fds map[string]string
}

func (o *incusOp) ws(fd string) (*websocket.Conn, error) {
	secret := o.fds[fd]
	if secret == "" {
		return nil, fmt.Errorf("incus operation has no %q websocket", fd)
	}
	return o.c.GetOperationWebsocket(o.op.Get().ID, secret)
}

func startIncusOp(c incus.InstanceServer, path string, body any) (*incusOp, error) {
	op, _, err := c.RawOperation("POST", path, body, "")
	if err != nil {
		return nil, err
	}
	fds := map[string]string{}
	if m, ok := op.Get().Metadata["fds"].(map[string]any); ok {
		for k, v := range m {
			if s, ok := v.(string); ok {
				fds[k] = s
			}
		}
	}
	return &incusOp{c: c, op: op, fds: fds}, nil
}

// incusShellCommand runs bash when present, else sh, as a login shell.
var incusShellCommand = []string{"/bin/sh", "-c", "if [ -x /bin/bash ]; then exec /bin/bash -l; fi; exec /bin/sh -l"}

func (d *incusDriver) console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return nil, "", err
	}
	ok := false
	defer func() {
		if !ok {
			c.Disconnect()
		}
	}()
	cols, rows := req.Cols, req.Rows
	if cols <= 0 || rows <= 0 {
		cols, rows = 80, 24
	}
	cols, rows = clampTerm(cols, rows)
	path := "/instances/" + url.PathEscape(name)

	switch {
	case req.Protocol == proto.ProtoShell && g.Kind == "container":
		o, err := startIncusOp(c, path+"/exec", api.InstanceExecPost{
			Command:     incusShellCommand,
			WaitForWS:   true,
			Interactive: true,
			Width:       cols,
			Height:      rows,
			Environment: map[string]string{
				"TERM": "xterm-256color", "HOME": "/root", "USER": "root", "LOGNAME": "root",
			},
		})
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "exec: "+err.Error())
		}
		s, err := newIncusTermSession(c, o, proto.ProtoShell, true)
		if err != nil {
			o.op.Cancel()
			return nil, "", codeErr(CodeOpenFailed, err.Error())
		}
		ok = true
		return s, "", nil

	case (req.Protocol == proto.ProtoTTY && g.Kind == "container") || (req.Protocol == proto.ProtoSerial && g.Kind == "vm"):
		o, err := startIncusOp(c, path+"/console", api.InstanceConsolePost{Type: "console", Width: cols, Height: rows})
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "console: "+err.Error())
		}
		s, err := newIncusTermSession(c, o, req.Protocol, false)
		if err != nil {
			o.op.Cancel()
			return nil, "", codeErr(CodeOpenFailed, err.Error())
		}
		ok = true
		return s, "", nil

	case req.Protocol == proto.ProtoSPICE && g.Kind == "vm":
		o, err := startIncusOp(c, path+"/console", api.InstanceConsolePost{Type: "vga"})
		if err != nil {
			return nil, "", codeErr(CodeOpenFailed, "vga console: "+err.Error())
		}
		ctrl, err := o.ws("control")
		if err != nil {
			o.op.Cancel()
			return nil, "", codeErr(CodeOpenFailed, err.Error())
		}
		go drainWS(ctrl)
		dial := func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
			conn, err := o.ws("0")
			if err != nil {
				return nil, "", false, err
			}
			return newWSConn(conn), "", false, nil
		}
		first, _, _, err := dial(ctx)
		if err != nil {
			closeWS(ctrl)
			o.op.Cancel()
			return nil, "", codeErr(CodeOpenFailed, "vga console: "+err.Error())
		}
		ok = true
		return &spiceSession{
			dial:  dial,
			first: first,
			cleanup: func() {
				closeWS(ctrl)
				c.Disconnect()
			},
		}, "", nil
	}
	return nil, "", codeErr(CodeUnsupportedProtocol, "protocol not supported for this instance")
}

// newIncusTermSession connects the data and control websockets of an exec
// or console operation.
func newIncusTermSession(c incus.InstanceServer, o *incusOp, protocol string, exec bool) (*termSession, error) {
	ctrl, err := o.ws("control")
	if err != nil {
		return nil, err
	}
	data, err := o.ws("0")
	if err != nil {
		closeWS(ctrl)
		return nil, err
	}
	go drainWS(ctrl)
	var cmu sync.Mutex
	sendCtrl := func(v any) error {
		cmu.Lock()
		defer cmu.Unlock()
		ctrl.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return ctrl.WriteJSON(v)
	}
	resize := func(cols, rows int) error {
		args := map[string]string{"width": strconv.Itoa(cols), "height": strconv.Itoa(rows)}
		if exec {
			return sendCtrl(api.InstanceExecControl{Command: "window-resize", Args: args})
		}
		return sendCtrl(api.InstanceConsoleControl{Command: "window-resize", Args: args})
	}
	rw := newWSConn(data)
	// Incus keeps the data websocket open after the process exits (exec) or
	// the console detaches: end the session when the operation finishes.
	stop := make(chan struct{})
	go func() {
		if watchOp(c, o.op.Get().ID, stop) {
			time.Sleep(300 * time.Millisecond) // let the last output through
			rw.Close()
		}
	}()
	return &termSession{
		protocol: protocol,
		rw:       rw,
		resize:   resize,
		cleanup: func() {
			close(stop)
			if exec {
				// Hang up the shell if it is still running.
				_ = sendCtrl(api.InstanceExecControl{Command: "signal", Signal: 1})
			}
			cmu.Lock()
			closeWS(ctrl)
			cmu.Unlock()
			waitOp(o.op, 3*time.Second)
			c.Disconnect()
		},
	}, nil
}

// watchOp polls an operation until it reaches a final state (true) or stop
// is closed (false).
func watchOp(c incus.InstanceServer, id string, stop <-chan struct{}) bool {
	for {
		select {
		case <-stop:
			return false
		default:
		}
		op, _, err := c.GetOperationWait(id, 5)
		if err != nil {
			select {
			case <-stop:
				return false
			case <-time.After(5 * time.Second):
			}
			// A vanished operation is finished.
			if _, _, err2 := c.GetOperation(id); err2 != nil {
				return true
			}
			continue
		}
		if op.StatusCode.IsFinal() {
			return true
		}
	}
}

func waitOp(op incus.Operation, d time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	if op.WaitContext(ctx) != nil {
		_ = op.Cancel()
	}
}

func drainWS(c *websocket.Conn) {
	for {
		if _, _, err := c.NextReader(); err != nil {
			return
		}
	}
}

func closeWS(c *websocket.Conn) {
	_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	_ = c.Close()
}

// wsConn adapts a gorilla websocket to io.ReadWriteCloser (binary messages).
type wsConn struct {
	c   *websocket.Conn
	r   io.Reader
	wmu sync.Mutex
	cl  sync.Once
}

func newWSConn(c *websocket.Conn) *wsConn { return &wsConn{c: c} }

func (w *wsConn) Read(p []byte) (int, error) {
	for {
		if w.r == nil {
			mt, r, err := w.c.NextReader()
			if err != nil {
				var ce *websocket.CloseError
				if errors.As(err, &ce) || errors.Is(err, net.ErrClosed) {
					return 0, io.EOF
				}
				return 0, err
			}
			if mt == websocket.TextMessage {
				// Incus marks the end of a stream with an empty text
				// message (a "barrier").
				return 0, io.EOF
			}
			if mt != websocket.BinaryMessage {
				continue
			}
			w.r = r
		}
		n, err := w.r.Read(p)
		if errors.Is(err, io.EOF) {
			w.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (w *wsConn) Write(p []byte) (int, error) {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	if err := w.c.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w *wsConn) Close() error {
	w.cl.Do(func() {
		w.wmu.Lock()
		// Barrier first so Incus ends its write mirror, then close.
		w.c.SetWriteDeadline(time.Now().Add(time.Second))
		_ = w.c.WriteMessage(websocket.TextMessage, []byte{})
		closeWS(w.c)
		w.wmu.Unlock()
	})
	return nil
}

// list returns the instances for console-test's local inventory.
func (d *incusDriver) list(ctx context.Context) ([]proto.Guest, error) {
	c, err := incus.ConnectIncusUnix(d.socket, &incus.ConnectionArgs{UserAgent: "whombat-agent", SkipGetEvents: true})
	if err != nil {
		return nil, err
	}
	defer c.Disconnect()
	insts, err := c.GetInstancesAllProjects(api.InstanceTypeAny)
	if err != nil {
		return nil, err
	}
	var out []proto.Guest
	for _, in := range insts {
		id := in.Name
		if in.Project != "" && in.Project != "default" {
			id = in.Project + "/" + in.Name
		}
		kind := "container"
		if in.Type == string(api.InstanceTypeVM) {
			kind = "vm"
		}
		st := normIncusState(in.Status)
		out = append(out, proto.Guest{
			ID: id, Name: in.Name, Kind: kind, State: st,
			Console: Caps(proto.PlatformIncus, GuestDisplay{Kind: kind, Running: st == proto.StateRunning}),
		})
	}
	return out, nil
}

// ---- snapshots ---------------------------------------------------------------

func (d *incusDriver) snapshots(ctx context.Context, g *proto.Guest) ([]proto.Snapshot, error) {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return nil, err
	}
	defer c.Disconnect()
	snaps, err := c.GetInstanceSnapshots(name)
	if err != nil {
		return nil, codeErr(CodePlatformError, err.Error())
	}
	return incusSnapshots(snaps), nil
}

// incusSnapshots converts the API list. Incus has no "current" snapshot.
func incusSnapshots(snaps []api.InstanceSnapshot) []proto.Snapshot {
	out := make([]proto.Snapshot, 0, len(snaps))
	for _, s := range snaps {
		ps := proto.Snapshot{Name: s.Name, Description: s.Description, WithMemory: s.Stateful}
		if !s.CreatedAt.IsZero() && s.CreatedAt.Year() > 1 {
			ps.Created = s.CreatedAt.UTC()
		}
		if s.Size > 0 {
			sz := uint64(s.Size)
			ps.SizeBytes = &sz
		}
		out = append(out, ps)
	}
	return out
}

func (d *incusDriver) wait(ctx context.Context, op incus.Operation, err error) error {
	if err == nil {
		err = op.WaitContext(ctx)
	}
	if err != nil {
		return codeErr(CodePlatformError, err.Error())
	}
	return nil
}

func (d *incusDriver) snapshotCreate(ctx context.Context, g *proto.Guest, snap, description string, memory bool) error {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return err
	}
	defer c.Disconnect()
	// Raw POST: the description field is newer than the client's struct
	// (older servers ignore it).
	body := map[string]any{"name": snap, "stateful": memory}
	if description != "" {
		body["description"] = description
	}
	op, _, err := c.RawOperation("POST", "/instances/"+url.PathEscape(name)+"/snapshots", body, "")
	return d.wait(ctx, op, err)
}

func (d *incusDriver) snapshotRestore(ctx context.Context, g *proto.Guest, snap string) error {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return err
	}
	defer c.Disconnect()
	s, _, err := c.GetInstanceSnapshot(name, snap)
	if err != nil {
		return codeErr(CodePlatformError, err.Error())
	}
	// Like `incus restore`: Incus stops a running instance, restores and
	// starts it again.
	op, err := c.UpdateInstance(name, api.InstancePut{Restore: snap, Stateful: s.Stateful}, "")
	return d.wait(ctx, op, err)
}

func (d *incusDriver) snapshotDelete(ctx context.Context, g *proto.Guest, snap string) error {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return err
	}
	defer c.Disconnect()
	op, err := c.DeleteInstanceSnapshot(name, snap)
	return d.wait(ctx, op, err)
}
