package hub

import (
	"bytes"
	"cmp"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type env struct {
	t        *testing.T
	h        *Hub
	ui       *httptest.Server
	agent    *httptest.Server
	logs     *syncBuffer
	setupOut string
	cancel   context.CancelFunc
	stopOnce sync.Once
}

func newEnv(t *testing.T, tweak func(*Config)) *env {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), Listen: "127.0.0.1:0", AgentListen: "127.0.0.1:0",
		StartupAlertGrace: time.Millisecond, ReauthorizeInterval: 200 * time.Millisecond}
	if tweak != nil {
		tweak(&cfg)
	}
	logs := &syncBuffer{}
	var setup bytes.Buffer
	h, err := New(cfg, NewLogger(logs, slog.LevelDebug, false), &setup)
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, h: h, logs: logs, setupOut: setup.String()}
	e.ui = httptest.NewServer(h.UIHandler())
	e.agent = httptest.NewUnstartedServer(h.AgentHandler())
	e.agent.TLS = h.AgentTLSConfig()
	e.agent.StartTLS()
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	h.StartJobs(ctx)
	t.Cleanup(func() {
		if t.Failed() {
			t.Log(logs.String())
		}
		e.stop()
	})
	return e
}

// stop shuts the hub down and releases its data directory (also at the
// test's end).
func (e *env) stop() {
	e.stopOnce.Do(func() {
		e.cancel()
		e.h.consoles.closeAll("revoked")
		e.h.disconnectAll()
		e.ui.Close()
		e.agent.Close()
		e.h.bg.Wait()
		e.h.Close()
	})
}

// addUser creates an account directly in the store.
func (e *env) addUser(name, role, pw string) {
	e.t.Helper()
	hash, err := HashPassword(pw)
	if err != nil {
		e.t.Fatal(err)
	}
	wid := make([]byte, 32)
	rand.Read(wid)
	if _, err := e.h.store.CreateUser(context.Background(), store.User{Username: name, Role: role, PasswordHash: hash,
		WebAuthnID: wid, CreatedAt: time.Now()}, false); err != nil {
		e.t.Fatal(err)
	}
}

// client is a browser-like API client.
type client struct {
	t    *testing.T
	e    *env
	c    *http.Client
	csrf string
}

func (e *env) client() *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: e.t, e: e, c: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

func (c *client) req(method, path string, body any, hdr map[string]string) (int, []byte, http.Header) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, c.e.ui.URL+path, rd)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if c.csrf != "" && method != http.MethodGet {
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	resp, err := c.c.Do(r)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, resp.Header
}

func (c *client) json(method, path string, body any, want int, out any) {
	c.t.Helper()
	code, b, _ := c.req(method, path, body, nil)
	if code != want {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, code, want, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			c.t.Fatalf("%s %s: %v: %s", method, path, err, b)
		}
	}
}

func (c *client) state() map[string]any {
	var st map[string]any
	c.json(http.MethodGet, "/api/v1/auth/state", nil, 200, &st)
	if tok, _ := st["csrf_token"].(string); tok != "" {
		c.csrf = tok
	}
	return st
}

// staleSignIn ages the client's last sign-in past any re-authentication
// window, as time passing would, so the test needs neither a sleep nor a
// window short enough to lapse on a busy machine between two requests.
func (c *client) staleSignIn() {
	c.t.Helper()
	u, err := url.Parse(c.e.ui.URL)
	if err != nil {
		c.t.Fatal(err)
	}
	for _, ck := range c.c.Jar.Cookies(u) {
		if ck.Name == SessionCookie {
			if err := c.e.h.store.SetReauth(context.Background(), sha(ck.Value), c.e.h.now().Add(-24*time.Hour)); err != nil {
				c.t.Fatal(err)
			}
			return
		}
	}
	c.t.Fatal("no session cookie")
}

func (c *client) login(user, pw string) {
	c.t.Helper()
	c.state()
	c.json(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": user, "password": pw}, 204, nil)
	c.state()
}

// ---- fake agent ------------------------------------------------------------------------

type fakeAgent struct {
	t           *testing.T
	e           *env
	id          string
	cert        tls.Certificate
	certPEM     []byte
	key         *ecdsa.PrivateKey
	policy      proto.Policy
	subprotocol string // default AgentSubprotocol
	version     string // in the hello (default 0.1.0)

	sess *yamux.Session
	wmu  sync.Mutex
	ctrl *yamux.Stream
	ack  proto.HelloAck

	mu        sync.Mutex
	controls  []wire.ConsoleControl // control frames received on console streams
	consoleIn chan string           // data received on console streams
	actions   []proto.ActionRequest
	inspects  []proto.InspectRequest
	updates   []proto.UpdateRequest
	checks    []proto.CheckSpecs // MsgChecks received
	hubAddrs  [][]string         // MsgHubAddrs received
	hubMoves  []string           // MsgHubMove URLs received
	manages   []proto.ManageRequest
	// manage answers manage requests (nil: fakeManage).
	manage    func(proto.ManageRequest) proto.ManageResponse
	diagnoses []proto.DiagnoseRequest
	execs     []proto.ExecRequest
	// updateAnswer and execAnswer answer those streams (nil: OK, and a
	// SMART line).
	updateAnswer func(proto.UpdateRequest) proto.UpdateResponse
	execAnswer   func(proto.ExecRequest) proto.ExecResponse
	// screens: screen steps received; screenAnswer answers them (nil:
	// fakeScreen).
	screens      []proto.ScreenRequest
	screenAnswer func(proto.ScreenRequest) proto.ScreenResponse
}

// csrKeys remembers the key of every CSR made by newKey (renewal tests).
var csrKeys = map[string]*ecdsa.PrivateKey{}
var csrMu sync.Mutex

func newKey(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "x"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	csr := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
	csrMu.Lock()
	csrKeys[string(csr)] = key
	csrMu.Unlock()
	return key, csr
}

func (e *env) agentHTTP(cert *tls.Certificate) *http.Client {
	pool := e.h.ca.Pool()
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs: pool, ServerName: "127.0.0.1",
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			if cert == nil {
				return &tls.Certificate{}, nil
			}
			return cert, nil
		},
	}}}
}

// enroll runs the enrollment flow (admin creates the token and approves).
func (e *env) enroll(admin *client, name, group string) *fakeAgent {
	e.t.Helper()
	var en struct {
		ID, Token string
	}
	admin.json(http.MethodPost, "/api/v1/enrollments", map[string]any{}, 201, &en)
	key, csr := newKey(e.t)
	hc := e.agentHTTP(nil)
	body, _ := json.Marshal(map[string]string{"token": en.Token, "csr": string(csr), "hostname": name, "machine_id": "m-" + name,
		"os": "Debian GNU/Linux 13 (trixie)", "address": "10.99.0.1", "agent_version": "0.1.0"})
	resp, err := hc.Post(e.agent.URL+"/agent/v1/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	var er struct {
		ID     string `json:"enrollment_id"`
		Secret string `json:"poll_secret"`
	}
	json.NewDecoder(resp.Body).Decode(&er)
	resp.Body.Close()
	if resp.StatusCode != 202 || er.ID != en.ID {
		e.t.Fatalf("enroll: %d %+v", resp.StatusCode, er)
	}
	var ap struct {
		ServerID string `json:"server_id"`
	}
	admin.json(http.MethodPost, "/api/v1/enrollments/"+er.ID+"/approve", map[string]string{"group": group, "name": name}, 200, &ap)
	req, _ := http.NewRequest(http.MethodGet, e.agent.URL+"/agent/v1/enroll/"+er.ID, nil)
	req.Header.Set("Authorization", "Bearer "+er.Secret)
	resp, err = hc.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	var pr struct {
		State, Certificate, CA, ServerID string
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	json.Unmarshal(b, &pr)
	if resp.StatusCode != 200 || pr.Certificate == "" {
		e.t.Fatalf("poll: %d %s", resp.StatusCode, b)
	}
	kb, _ := x509.MarshalPKCS8PrivateKey(key)
	cert, err := tls.X509KeyPair([]byte(pr.Certificate), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &fakeAgent{t: e.t, e: e, id: ap.ServerID, cert: cert, certPEM: []byte(pr.Certificate), key: key,
		policy: proto.Policy{Console: true, Power: true}, consoleIn: make(chan string, 64)}
}

// dial opens the agent connection; it returns the HTTP status on refusal.
func (a *fakeAgent) dial(hello proto.Hello) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, strings.Replace(a.e.agent.URL, "https://", "wss://", 1)+"/agent/v1/connect",
		&websocket.DialOptions{HTTPClient: a.e.agentHTTP(&a.cert), Subprotocols: []string{cmp.Or(a.subprotocol, AgentSubprotocol)}})
	if err != nil {
		if resp != nil {
			return resp.StatusCode, err
		}
		return 0, err
	}
	nc := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
	sess, err := yamux.Client(nc, wire.YamuxConfig())
	if err != nil {
		return 0, err
	}
	a.sess = sess
	st, err := sess.OpenStream()
	if err != nil {
		return 0, err
	}
	a.ctrl = st
	if err := wire.WriteMsg(st, proto.StreamHeader{Kind: proto.StreamControl}); err != nil {
		return 0, err
	}
	if hello.ProtocolVersion == 0 {
		hello.ProtocolVersion = proto.Version
	}
	hello.AgentVersion, hello.Hostname, hello.Clock = cmp.Or(a.version, "0.1.0"), a.id, time.Now()
	if err := wire.SendEnvelope(st, proto.MsgHello, hello); err != nil {
		return 0, err
	}
	var env proto.Envelope
	if err := wire.ReadMsg(st, &env); err != nil {
		return 0, err
	}
	if err := wire.Unmarshal(env.Body, &a.ack); err != nil {
		return 0, err
	}
	if a.ack.Rejected != "" {
		return 0, errors.New(a.ack.Rejected)
	}
	go a.serveStreams(sess)
	go func() { // read control messages (pings are not answered)
		for {
			var env proto.Envelope
			if wire.ReadMsg(st, &env) != nil {
				return
			}
			if env.Type == proto.MsgChecks {
				var cs proto.CheckSpecs
				if wire.Unmarshal(env.Body, &cs) == nil {
					a.mu.Lock()
					a.checks = append(a.checks, cs)
					a.mu.Unlock()
				}
			}
			if env.Type == proto.MsgHubMove {
				var hm proto.HubMove
				if wire.Unmarshal(env.Body, &hm) == nil {
					a.mu.Lock()
					a.hubMoves = append(a.hubMoves, hm.URL)
					a.mu.Unlock()
				}
			}
			if env.Type == proto.MsgHubAddrs {
				var ha proto.HubAddrs
				if wire.Unmarshal(env.Body, &ha) == nil {
					a.mu.Lock()
					a.hubAddrs = append(a.hubAddrs, ha.Addrs)
					a.mu.Unlock()
				}
			}
		}
	}()
	return 101, nil
}

func (a *fakeAgent) send(typ string, body any) {
	a.t.Helper()
	a.wmu.Lock()
	defer a.wmu.Unlock()
	if err := wire.SendEnvelope(a.ctrl, typ, body); err != nil {
		a.t.Fatalf("send %s: %v", typ, err)
	}
}

func (a *fakeAgent) serveStreams(sess *yamux.Session) {
	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go a.handle(st)
	}
}

func (a *fakeAgent) handle(st *yamux.Stream) {
	defer st.Close()
	var hdr proto.StreamHeader
	if wire.ReadMsg(st, &hdr) != nil {
		return
	}
	switch hdr.Kind {
	case proto.StreamAction:
		var req proto.ActionRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.actions = append(a.actions, req)
		a.mu.Unlock()
		wire.WriteMsg(st, proto.ActionResponse{OK: true, State: "stopped"})
	case proto.StreamInspect:
		var req proto.InspectRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.inspects = append(a.inspects, req)
		a.mu.Unlock()
		switch req.Kind {
		case proto.InspectProcesses:
			wire.WriteMsg(st, proto.InspectResponse{Processes: []proto.Process{{PID: 1, User: "root", Name: "init", CPUPct: 0.1}}})
		case proto.InspectSnapshots:
			wire.WriteMsg(st, proto.InspectResponse{Snapshots: []proto.Snapshot{{Name: "before-upgrade"}}})
		case proto.InspectUpdates:
			wire.WriteMsg(st, proto.InspectResponse{Updates: []proto.PackageUpdate{{Name: "openssl", Current: "3.0.20-1~deb12u2", New: "3.0.22-1~deb12u1", Security: true}}})
		default:
			wire.WriteMsg(st, proto.InspectResponse{Code: "unsupported", Message: "not here"})
		}
	case proto.StreamUpdate:
		var req proto.UpdateRequest
		wire.ReadMsg(st, &req)
		var got int64
		for got < req.Size {
			var c proto.UpdateChunk
			if wire.ReadMsg(st, &c) != nil {
				return
			}
			got += int64(len(c.Data))
		}
		a.mu.Lock()
		a.updates = append(a.updates, req)
		answer := a.updateAnswer
		a.mu.Unlock()
		resp := proto.UpdateResponse{OK: true}
		if answer != nil {
			resp = answer(req)
		}
		wire.WriteMsg(st, resp)
	case proto.StreamManage:
		var req proto.ManageRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.manages = append(a.manages, req)
		answer := a.manage
		a.mu.Unlock()
		if answer == nil {
			answer = fakeManage
		}
		wire.WriteMsg(st, answer(req))
	case proto.StreamDiagnose:
		var req proto.DiagnoseRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.diagnoses = append(a.diagnoses, req)
		a.mu.Unlock()
		if req.Check == proto.DiagnoseList {
			wire.WriteMsg(st, proto.DiagnoseResponse{Checks: []proto.DiagnoseCheck{{Name: "unraid", Description: "the array"}}})
			return
		}
		wire.WriteMsg(st, proto.DiagnoseResponse{Commands: []string{"cat /proc/mdstat"}, Output: "mdState=STARTED\nrdevStatus.3=DISK_DSBL\n"})
	case proto.StreamExec:
		var req proto.ExecRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.execs = append(a.execs, req)
		answer := a.execAnswer
		a.mu.Unlock()
		resp := proto.ExecResponse{ExitCode: 0, Output: "SMART self-test started\n", DurationMs: 12}
		if answer != nil {
			resp = answer(req)
		}
		wire.WriteMsg(st, resp)
	case proto.StreamScreen:
		var req proto.ScreenRequest
		wire.ReadMsg(st, &req)
		a.mu.Lock()
		a.screens = append(a.screens, req)
		answer := a.screenAnswer
		a.mu.Unlock()
		if answer == nil {
			answer = fakeScreen
		}
		wire.WriteMsg(st, answer(req))
	case proto.StreamThumbnail:
		var req proto.ThumbnailRequest
		wire.ReadMsg(st, &req)
		img := image.NewRGBA(image.Rect(0, 0, 640, 400))
		for x := 0; x < 640; x++ {
			img.Set(x, x%400, color.RGBA{200, 10, 10, 255})
		}
		var buf bytes.Buffer
		jpeg.Encode(&buf, img, nil)
		wire.WriteMsg(st, proto.ThumbnailResponse{Image: buf.Bytes(), Width: 640, Height: 400})
	case proto.StreamConsole:
		var req proto.ConsoleRequest
		wire.ReadMsg(st, &req)
		if !a.policy.Console {
			wire.WriteMsg(st, proto.ConsoleResponse{Code: "remote_control_disabled"})
			return
		}
		wire.WriteMsg(st, proto.ConsoleResponse{OK: true, Resolution: "80x24"})
		fw := wire.NewFrameWriter(st)
		fr := wire.NewFrameReader(st)
		for {
			f, err := fr.Read()
			if err != nil {
				return
			}
			if f.Kind == wire.FrameControl {
				var cc wire.ConsoleControl
				json.Unmarshal(f.Payload, &cc)
				a.mu.Lock()
				a.controls = append(a.controls, cc)
				a.mu.Unlock()
				if cc.Type == "ping" {
					b, _ := json.Marshal(wire.ConsoleControl{Type: "pong", ID: cc.ID})
					fw.Write(wire.Frame{Kind: wire.FrameControl, Payload: b})
				}
				continue
			}
			a.consoleIn <- string(f.Payload)
			fw.Write(wire.Frame{Kind: wire.FrameData, Payload: append([]byte("echo:"), f.Payload...)})
		}
	}
}

// fakeManage answers manage requests like a Proxmox node: a configuration
// with digest "d1", changes that are done at once, and tasks for the long
// operations, which have ended when asked about (tasks named "…:running:"
// keep running).
func fakeManage(req proto.ManageRequest) proto.ManageResponse {
	upid := func(typ string) *proto.TaskRef {
		return &proto.TaskRef{ID: "UPID:shale:0000A1B2:00C0FFEE:6710A000:" + typ + ":" + req.GuestID + ":whombat-manage@pve!agent-shale:"}
	}
	switch req.Op {
	case proto.OpConfigGet:
		return proto.ManageResponse{OK: true, Config: &proto.GuestConfig{Platform: req.Platform, Kind: "vm", Digest: "d1", Running: true,
			Values: map[string]string{"memory": "4096", "cipassword": "**********", "unused0": "local-zfs:vm-100-disk-1"}}}
	case proto.OpConfigSet:
		if req.Digest != "" && req.Digest != "d1" {
			return proto.ManageResponse{Code: proto.CodeDigestMismatch}
		}
		var changes []proto.ConfigChange
		for k, v := range req.Set {
			old := "4096"
			if k == "cipassword" {
				old, v = "**********", "**********"
			}
			changes = append(changes, proto.ConfigChange{Key: k, Old: old, New: v, Pending: k == "memory"})
		}
		for _, k := range req.Delete {
			changes = append(changes, proto.ConfigChange{Key: k, Old: "local-zfs:vm-100-disk-1"})
		}
		sort.Slice(changes, func(i, j int) bool { return changes[i].Key < changes[j].Key })
		return proto.ManageResponse{OK: true, Changes: changes}
	case proto.OpChoices:
		return proto.ManageResponse{OK: true, Choices: &proto.Choices{Platform: req.Platform, Node: "shale", NextID: 108}}
	case proto.OpBackupList:
		return proto.ManageResponse{OK: true, Backups: []proto.BackupVolume{{Volume: "pbs-01:backup/vm/100/2026-10-17T01:00:00Z",
			Storage: "pbs-01", GuestID: req.GuestID, Kind: "vm", Verified: "ok"}}}
	case proto.OpTaskList:
		return proto.ManageResponse{OK: true}
	case proto.OpTaskStatus:
		st := &proto.TaskStatus{ID: req.Task, Type: "qmresize", Status: "ok", Message: "OK"}
		if strings.Contains(req.Task, ":running:") {
			st.Status, st.Message = "running", ""
		}
		if req.LogStart >= 0 {
			st.Log, st.LogNext = []string{"resizing", "TASK OK"}, 2
		}
		return proto.ManageResponse{OK: true, TaskStatus: st}
	case proto.OpFirewallRuleAdd:
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "Parameter verification failed.",
			FieldErrors: map[string]string{"dport": "invalid port"}}
	case proto.OpDiskResize:
		return proto.ManageResponse{OK: true, Task: upid("qmresize")}
	case proto.OpClone:
		return proto.ManageResponse{OK: true, Task: upid("qmclone"), NewID: "108"}
	case proto.OpCreate:
		return proto.ManageResponse{OK: true, Task: upid("qmcreate"), NewID: "109"}
	case proto.OpDelete, proto.OpBackupRestore:
		return proto.ManageResponse{OK: true, Task: upid("qmdestroy")}
	case proto.OpBackupJobList:
		next := time.Date(2026, 10, 18, 2, 0, 0, 0, time.UTC)
		return proto.ManageResponse{OK: true, BackupJobs: []proto.BackupJob{
			{ID: "backup-dc316015-ac2c", Enabled: true, Schedule: "04:00", Storage: "pbs-01", Selection: "all", Exclude: []string{"100"},
				Mode: "snapshot", Compress: "zstd", Keep: &proto.BackupKeep{Last: 7, Daily: 14}, NotesTemplate: "{{guestname}}",
				NextRun: &next, Digest: "j1"},
			{ID: "backup-0a1b2c3d-0001", Enabled: false, Schedule: "sat 02:30", Storage: "local", Node: "shale", Selection: "guests",
				Guests: []string{"101", "118"}, Mode: "stop", Digest: "j2"},
		}}
	case proto.OpBackupJobCreate:
		return proto.ManageResponse{OK: true, JobID: "backup-feedc0de-0042", Changes: []proto.ConfigChange{{Key: "schedule", New: "04:00"}}}
	case proto.OpBackupJobUpdate:
		if req.Digest != "" && req.Digest != "j1" {
			return proto.ManageResponse{Code: proto.CodeDigestMismatch, Message: "the backup job changed since it was read"}
		}
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "enabled", Old: "true", New: "false"}}}
	case proto.OpBackupJobRun:
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: "UPID:shale:0000A1B2:00C0FFEE:6710A000:vzdump::whombat-manage@pve!agent-shale:"}}
	}
	return proto.ManageResponse{OK: true}
}

// basaltReport is a report of the fixture's basalt with the agent's policy.
func (a *fakeAgent) report(host string) *proto.Report {
	for _, h := range fakefleet.Fleet() {
		if h.ID == host {
			h.Policy = a.policy
			return h.Report(time.Now(), 1, "0.1.0")
		}
	}
	a.t.Fatalf("no fake host %s", host)
	return nil
}

func waitFor(t *testing.T, what string, d time.Duration, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (e *env) audit(event string) []store.AuditRecord {
	recs, _, err := e.h.store.ListAudit(context.Background(), 1000, 0, store.AuditFilter{Event: event})
	if err != nil {
		e.t.Fatal(err)
	}
	return recs
}

func fmtRecs(recs []store.AuditRecord) string {
	var s []string
	for _, r := range recs {
		s = append(s, fmt.Sprintf("%s/%s/%s", r.Event, r.Outcome, r.Code))
	}
	return strings.Join(s, ", ")
}
