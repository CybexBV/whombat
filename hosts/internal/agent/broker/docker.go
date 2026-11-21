package broker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// dockerDriver talks to the Docker Engine API (or Podman's compatible API)
// over its Unix socket, like the collector:
//
//	actions: POST /containers/<n>/{start,stop?t=30,restart?t=30,kill,pause,unpause}
//	shell:   POST /containers/<n>/exec (TTY), POST /exec/<id>/start with a
//	         connection upgrade, POST /exec/<id>/resize
//	logs:    GET /containers/<n>/logs?follow=1&tail=500 (demultiplexed when
//	         the container has no TTY), read-only
type dockerDriver struct {
	socket string // "" = the first existing of dockerSockets
}

var dockerSockets = []string{"/var/run/docker.sock", "/run/docker.sock"}

// dockerNameRe is Docker's container name syntax.
var dockerNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$`)

func (d *dockerDriver) socketPath() (string, error) {
	if d.socket != "" {
		return d.socket, nil
	}
	for _, p := range dockerSockets {
		if fi, err := os.Stat(p); err == nil && fi.Mode()&os.ModeSocket != 0 {
			return p, nil
		}
	}
	return "", codeErr(CodePlatformError, "the Docker socket was not found")
}

func (d *dockerDriver) dial(ctx context.Context) (net.Conn, error) {
	sock, err := d.socketPath()
	if err != nil {
		return nil, err
	}
	var dl net.Dialer
	return dl.DialContext(ctx, "unix", sock)
}

// httpClient returns a client for the socket; requests are bounded by
// their context (streams have none other).
func (d *dockerDriver) httpClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return d.dial(ctx) },
		DisableKeepAlives: true,
	}}
}

func dockerRef(g *proto.Guest) (string, error) {
	if !dockerNameRe.MatchString(g.ID) {
		return "", codeErr(CodeInvalid, "invalid container name")
	}
	return url.PathEscape(g.ID), nil
}

// dockerError extracts {"message": ...} from an error response.
func dockerError(status int, body []byte) string {
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && e.Message != "" {
		return e.Message
	}
	if s := strings.TrimSpace(string(body)); s != "" && len(s) < 300 {
		return s
	}
	return "HTTP " + strconv.Itoa(status)
}

// call sends a request and decodes a JSON answer into out (when not nil).
// It returns the HTTP status; 4xx/5xx are errors with Docker's message.
func (d *dockerDriver) call(ctx context.Context, method, path string, in, out any) (int, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, body)
	if err != nil {
		return 0, err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.httpClient().Do(req)
	if err != nil {
		var ce *codeError
		if errors.As(err, &ce) {
			return 0, err
		}
		return 0, codeErr(CodePlatformError, "cannot reach Docker: "+err.Error())
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return resp.StatusCode, codeErr(CodePlatformError, err.Error())
	}
	if resp.StatusCode >= 400 {
		msg := dockerError(resp.StatusCode, b)
		if resp.StatusCode == http.StatusNotFound && strings.HasPrefix(path, "/containers/") {
			return resp.StatusCode, codeErr(CodeUnknownGuest, msg)
		}
		return resp.StatusCode, codeErr(CodePlatformError, msg)
	}
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			return resp.StatusCode, codeErr(CodePlatformError, "unexpected Docker answer: "+err.Error())
		}
	}
	return resp.StatusCode, nil
}

type dockerContainer struct {
	ID    string `json:"Id"`
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
	} `json:"State"`
	Config struct {
		Tty bool `json:"Tty"`
	} `json:"Config"`
}

func (d *dockerDriver) inspect(ctx context.Context, g *proto.Guest) (*dockerContainer, error) {
	ref, err := dockerRef(g)
	if err != nil {
		return nil, err
	}
	var c dockerContainer
	if _, err := d.call(ctx, http.MethodGet, "/containers/"+ref+"/json", nil, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// normDockerState maps Docker's status to the broker's states.
func normDockerState(c *dockerContainer) string {
	switch {
	case c.State.Paused || c.State.Status == "paused":
		return proto.StatePaused
	case c.State.Restarting || c.State.Status == "restarting":
		return "restarting"
	case c.State.Running || c.State.Status == "running":
		return proto.StateRunning
	case c.State.Status == "removing":
		return "removing"
	}
	return proto.StateStopped // created, exited, dead
}

func (d *dockerDriver) state(ctx context.Context, g *proto.Guest) (string, error) {
	c, err := d.inspect(ctx, g)
	if err != nil {
		return "", err
	}
	return normDockerState(c), nil
}

func (d *dockerDriver) power(ctx context.Context, g *proto.Guest, action string) error {
	ref, err := dockerRef(g)
	if err != nil {
		return err
	}
	var path string
	switch action {
	case proto.ActionStart:
		path = "/start"
		if st, _ := d.state(ctx, g); st == proto.StatePaused {
			path = "/unpause" // a paused container cannot be started
		}
	case proto.ActionStop:
		path = "/stop?t=30" // SIGTERM, SIGKILL after 30 s
	case proto.ActionRestart:
		path = "/restart?t=30"
	case proto.ActionForceStop:
		path = "/kill"
	case proto.ActionPause:
		path = "/pause"
	case proto.ActionResume:
		path = "/unpause"
	default:
		return codeErr(CodeUnsupportedAction, "unsupported action for a Docker container")
	}
	_, err = d.call(ctx, http.MethodPost, "/containers/"+ref+path, nil, nil)
	return err
}

func (d *dockerDriver) screenshot(ctx context.Context, g *proto.Guest) ([]byte, error) {
	return nil, codeErr(CodeNoScreen, "containers have no screen")
}

func (d *dockerDriver) console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	switch req.Protocol {
	case proto.ProtoShell:
		return d.shell(ctx, g, req)
	case proto.ProtoLogs:
		return d.logs(ctx, g)
	}
	return nil, "", codeErr(CodeUnsupportedProtocol, "Docker containers have shell and logs")
}

// dockerShellCommand runs bash when present, else sh, as a login shell.
var dockerShellCommand = []string{"/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash -l; fi; exec sh -l"}

func (d *dockerDriver) shell(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error) {
	ref, err := dockerRef(g)
	if err != nil {
		return nil, "", err
	}
	cols, rows := req.Cols, req.Rows
	if cols <= 0 || rows <= 0 {
		cols, rows = 80, 24
	}
	cols, rows = clampTerm(cols, rows)
	octx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var created struct {
		ID string `json:"Id"`
	}
	_, err = d.call(octx, http.MethodPost, "/containers/"+ref+"/exec", map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
		"Cmd":          dockerShellCommand,
		"Env":          []string{"TERM=xterm-256color"},
		"ConsoleSize":  []int{rows, cols},
	}, &created)
	if err != nil {
		code, msg := errCode(err, CodeOpenFailed)
		if code == CodePlatformError {
			code = CodeOpenFailed
		}
		return nil, "", codeErr(code, "exec: "+msg)
	}
	if created.ID == "" || strings.ContainsAny(created.ID, "/?#") {
		return nil, "", codeErr(CodeOpenFailed, "exec: Docker returned no exec id")
	}
	execID := url.PathEscape(created.ID)
	conn, rd, err := d.hijack(octx, "/exec/"+execID+"/start", `{"Detach":false,"Tty":true}`)
	if err != nil {
		return nil, "", codeErr(CodeOpenFailed, "exec start: "+err.Error())
	}
	resize := func(cols, rows int) error {
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := d.call(rctx, http.MethodPost, fmt.Sprintf("/exec/%s/resize?h=%d&w=%d", execID, rows, cols), nil, nil)
		return err
	}
	_ = resize(cols, rows)
	return &termSession{
		protocol: proto.ProtoShell,
		rw:       &hijackedConn{Conn: conn, r: rd},
		resize:   resize,
		cleanup:  func() { d.endExec(execID) },
	}, "", nil
}

// endExec hangs up an exec'd shell that is still running after the
// session closed (Docker keeps exec processes alive when the client
// detaches).
func (d *dockerDriver) endExec(execID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var st struct {
		Running bool `json:"Running"`
		Pid     int  `json:"Pid"`
	}
	if _, err := d.call(ctx, http.MethodGet, "/exec/"+execID+"/json", nil, &st); err != nil || !st.Running || st.Pid <= 1 {
		return
	}
	_ = syscall.Kill(st.Pid, syscall.SIGHUP)
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		if _, err := d.call(ctx, http.MethodGet, "/exec/"+execID+"/json", nil, &st); err != nil || !st.Running {
			return
		}
	}
	if st.Pid > 1 {
		_ = syscall.Kill(st.Pid, syscall.SIGKILL)
	}
}

// hijack sends a POST that upgrades the connection to a raw stream
// (Docker answers 101 UPGRADED; older engines 200 with the stream as body).
func (d *dockerDriver) hijack(ctx context.Context, path, body string) (net.Conn, *bufio.Reader, error) {
	conn, err := d.dial(ctx)
	if err != nil {
		return nil, nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	req := "POST " + path + " HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n" +
		"Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + body
	if _, err := io.WriteString(conn, req); err != nil {
		conn.Close()
		return nil, nil, err
	}
	br := bufio.NewReaderSize(conn, 32<<10)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		conn.Close()
		return nil, nil, errors.New(dockerError(resp.StatusCode, b))
	}
	conn.SetDeadline(time.Time{})
	return conn, br, nil
}

// hijackedConn reads through the buffered reader that parsed the HTTP
// answer and writes to the connection.
type hijackedConn struct {
	net.Conn
	r    *bufio.Reader
	once sync.Once
}

func (c *hijackedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (c *hijackedConn) Close() error {
	var err error
	c.once.Do(func() {
		if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite() // stdin EOF first
		}
		err = c.Conn.Close()
	})
	return err
}

// logs streams the container's log, read-only: the last 500 lines, then
// new lines while the container runs.
func (d *dockerDriver) logs(ctx context.Context, g *proto.Guest) (agent.ConsoleSession, string, error) {
	ref, err := dockerRef(g)
	if err != nil {
		return nil, "", err
	}
	octx, cancel := context.WithTimeout(ctx, 20*time.Second)
	c, err := d.inspect(octx, g)
	cancel()
	if err != nil {
		return nil, "", err
	}
	// The stream lives as long as the session; ctx is the session's.
	sctx, scancel := context.WithCancel(ctx)
	req, err := http.NewRequestWithContext(sctx, http.MethodGet,
		"http://docker/containers/"+ref+"/logs?follow=1&stdout=1&stderr=1&tail=500&timestamps=0", nil)
	if err != nil {
		scancel()
		return nil, "", err
	}
	resp, err := d.httpClient().Do(req)
	if err != nil {
		scancel()
		return nil, "", codeErr(CodeOpenFailed, "logs: "+err.Error())
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		scancel()
		return nil, "", codeErr(CodeOpenFailed, "logs: "+dockerError(resp.StatusCode, b))
	}
	// Without a TTY the stream is multiplexed (stdout / stderr frames);
	// engines that say so in the Content-Type are believed.
	mux := !c.Config.Tty
	switch ct := resp.Header.Get("Content-Type"); {
	case strings.Contains(ct, "multiplexed-stream"):
		mux = true
	case strings.Contains(ct, "raw-stream"):
		mux = false
	}
	var src io.Reader = resp.Body
	if mux {
		src = &dockerDemux{r: bufio.NewReaderSize(resp.Body, 32<<10)}
	}
	return &logSession{
		protocol: proto.ProtoLogs,
		src:      src,
		closeSrc: func() { scancel(); resp.Body.Close() },
		endNote:  "-- end of log: the container is not running --",
	}, "", nil
}

// dockerDemux strips the 8-byte frame headers of a multiplexed log stream
// ([stream, 0, 0, 0, size uint32 big-endian], then size bytes).
type dockerDemux struct {
	r    *bufio.Reader
	left uint32
}

func (m *dockerDemux) Read(p []byte) (int, error) {
	for m.left == 0 {
		var hdr [8]byte
		if _, err := io.ReadFull(m.r, hdr[:]); err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return 0, io.EOF
			}
			return 0, err
		}
		if hdr[0] > 3 || hdr[1] != 0 || hdr[2] != 0 || hdr[3] != 0 {
			return 0, errors.New("logs: not a multiplexed stream")
		}
		m.left = binary.BigEndian.Uint32(hdr[4:])
	}
	if uint32(len(p)) > m.left {
		p = p[:m.left]
	}
	n, err := m.r.Read(p)
	m.left -= uint32(n)
	if errors.Is(err, io.EOF) && m.left > 0 {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

// containers lists all containers (id -> name), for console-test and the
// process view.
func (d *dockerDriver) containers(ctx context.Context) ([]dockerListEntry, error) {
	var list []dockerListEntry
	if _, err := d.call(ctx, http.MethodGet, "/containers/json?all=1", nil, &list); err != nil {
		return nil, err
	}
	return list, nil
}

type dockerListEntry struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	State string   `json:"State"`
}

func (e *dockerListEntry) name() string {
	if len(e.Names) > 0 {
		return strings.TrimPrefix(e.Names[0], "/")
	}
	if len(e.ID) >= 12 {
		return e.ID[:12]
	}
	return e.ID
}

func (d *dockerDriver) list(ctx context.Context) ([]proto.Guest, error) {
	list, err := d.containers(ctx)
	if err != nil {
		return nil, err
	}
	var out []proto.Guest
	for _, e := range list {
		st := proto.StateStopped
		switch e.State {
		case "running":
			st = proto.StateRunning
		case "paused":
			st = proto.StatePaused
		}
		out = append(out, proto.Guest{
			ID: e.name(), Name: e.name(), Kind: "container", State: st,
			Console: Caps(proto.PlatformDocker, GuestDisplay{Kind: "container", Running: st == proto.StateRunning}),
		})
	}
	return out, nil
}
