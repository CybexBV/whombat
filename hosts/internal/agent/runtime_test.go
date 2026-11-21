package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/netaddrs"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestEnroll(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	if cfg.Hub != h.wsURL() || cfg.CASHA256 != h.pin {
		t.Fatalf("config hub/pin = %q %q", cfg.Hub, cfg.CASHA256)
	}
	if cfg.RemoteControl.Console || cfg.RemoteControl.Power {
		t.Fatal("remote control must be off after enrollment")
	}
	for _, p := range []string{cfg.KeyPath(), cfg.CertPath(), cfg.CAPath(), filepath.Join(cfg.Dir, ConfigFileName)} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("missing %s: %v", p, err)
		}
	}
	if st, _ := os.Stat(cfg.KeyPath()); st.Mode().Perm() != 0o600 {
		t.Fatalf("agent.key mode %v", st.Mode().Perm())
	}
	if st, _ := os.Stat(filepath.Join(cfg.Dir, ConfigFileName)); st.Mode().Perm() != 0o600 {
		t.Fatalf("agent.toml mode %v", st.Mode().Perm())
	}
	id, err := LoadIdentity(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if id.Cert.Subject.CommonName != "testhost" {
		t.Fatalf("cert CN %q", id.Cert.Subject.CommonName)
	}
	h.mu.Lock()
	req := h.enrollments["en_1"].req
	h.mu.Unlock()
	if req.Hostname == "" || req.AgentVersion != "test" || !strings.Contains(req.CSR, "CERTIFICATE REQUEST") {
		t.Fatalf("enroll request: %+v", req)
	}

	// Enrolling again needs --force; the token is single use.
	_, err = Enroll(context.Background(), EnrollOptions{Hub: h.wsURL(), CASHA256: h.pin, Token: "tok-123", ConfigDir: cfg.Dir})
	if !errors.Is(err, ErrAlreadyEnrolled) {
		t.Fatalf("second enroll: %v", err)
	}
	_, err = Enroll(context.Background(), EnrollOptions{Hub: h.wsURL(), CASHA256: h.pin, Token: "tok-123", ConfigDir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "invalid_token") {
		t.Fatalf("reused token: %v", err)
	}
}

func TestEnrollPinMismatch(t *testing.T) {
	h := newFakeHub(t)
	bad := strings.Repeat("ab", 32)
	_, err := Enroll(context.Background(), EnrollOptions{Hub: h.wsURL(), CASHA256: bad, Token: "tok-123", ConfigDir: t.TempDir(), Timeout: 5 * time.Second})
	if err == nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("expected pin error, got %v", err)
	}
	h.mu.Lock()
	n := len(h.enrollments)
	h.mu.Unlock()
	if n != 0 {
		t.Fatal("the token must not reach a hub with the wrong CA")
	}
	if _, err := Enroll(context.Background(), EnrollOptions{Hub: "ws://example:1", CASHA256: h.pin, Token: "x", ConfigDir: t.TempDir()}); err == nil {
		t.Fatal("plain ws:// must be refused")
	}
}

type testRT struct {
	rt     *Runtime
	col    *fakeCollector
	broker *fakeBroker
	cancel context.CancelFunc
	done   chan struct{} // closed when Run returns
	err    error
}

// stop cancels the runtime and waits for Run to return.
func (tr *testRT) stop(t *testing.T) error {
	tr.cancel()
	select {
	case <-tr.done:
	case <-time.After(10 * time.Second):
		t.Fatal("runtime did not stop")
	}
	return tr.err
}

func startRuntime(t *testing.T, cfg *Config, setup func(*Runtime)) *testRT {
	t.Helper()
	col := &fakeCollector{events: make(chan proto.Event, 8)}
	br := &fakeBroker{}
	rt := NewRuntime(cfg, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	rt.Collector = col
	rt.Broker = br
	rt.ReportInterval = 50 * time.Millisecond
	rt.EventDebounce = 20 * time.Millisecond
	rt.BackoffMin = 20 * time.Millisecond
	rt.BackoffMax = 100 * time.Millisecond
	rt.PersistEvery = 50 * time.Millisecond
	// Never the machine's own networks in a test (the hub search).
	rt.Interfaces = func() ([]netaddrs.Interface, error) { return nil, nil }
	if setup != nil {
		setup(rt)
	}
	ctx, cancel := context.WithCancel(context.Background())
	tr := &testRT{rt: rt, col: col, broker: br, cancel: cancel, done: make(chan struct{})}
	go func() { tr.err = rt.Run(ctx); close(tr.done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-tr.done:
		case <-time.After(10 * time.Second):
			t.Error("runtime did not stop")
		}
	})
	return tr
}

func TestConnectReportPing(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)

	hello := recv(t, h.hellos, "hello")
	if hello.ProtocolVersion != proto.Version || hello.AgentVersion != "test" || hello.Hostname == "" {
		t.Fatalf("hello: %+v", hello)
	}
	if len(hello.CSR) != 0 {
		t.Fatal("fresh certificate must not request renewal")
	}
	r1 := recv(t, h.reports, "report")
	r2 := recv(t, h.reports, "report")
	if r2.Seq <= r1.Seq {
		t.Fatalf("seq not increasing: %d %d", r1.Seq, r2.Seq)
	}
	if r2.Policy.Console || r2.Policy.Power {
		t.Fatalf("policy must be off: %+v", r2.Policy)
	}
	if r2.Agent.Version != "test" || r2.Agent.RSSBytes == 0 || r2.Agent.StartedAt.IsZero() {
		t.Fatalf("agent info: %+v", r2.Agent)
	}
	if tr.rt.Inventory() == nil {
		t.Fatal("inventory not set")
	}

	// Ping on the control stream is answered with the same body.
	side := h.waitSide(t)
	body, _ := wire.Marshal(map[string]int{"n": 7})
	side.wmu.Lock()
	wire.WriteMsg(side.ctrl, proto.Envelope{Type: proto.MsgPing, Body: body})
	side.wmu.Unlock()
	if got := recv(t, h.pongs, "pong"); string(got) != string(body) {
		t.Fatal("pong body differs")
	}

	// A collector event is forwarded and triggers an early report.
	tr.col.events <- proto.Event{Kind: "guest.state_changed", Platform: "incus", GuestID: "web", State: "stopped"}
	ev := recv(t, h.events, "event")
	if ev.GuestID != "web" || ev.At.IsZero() {
		t.Fatalf("event: %+v", ev)
	}
}

func TestBackfillAfterReconnect(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	h.refuse.Store(true) // hub down
	tr := startRuntime(t, cfg, nil)

	// Collect while offline.
	deadline := time.Now().Add(5 * time.Second)
	for tr.rt.buf.Len() < 12 {
		if time.Now().After(deadline) {
			t.Fatal("samples were not buffered while offline")
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.refuse.Store(false) // hub back

	hello := recv(t, h.hellos, "hello")
	if hello.BufferedSamples < 12 {
		t.Fatalf("hello.BufferedSamples = %d", hello.BufferedSamples)
	}
	var backfilled []proto.Sample
	// Gather the backfill and a few live reports.
	var reports []*proto.Report
	timeout := time.After(10 * time.Second)
	for len(reports) < 3 {
		select {
		case bf := <-h.backfills:
			if len(bf.Samples) > BackfillBatch {
				t.Fatalf("batch of %d samples", len(bf.Samples))
			}
			backfilled = append(backfilled, bf.Samples...)
		case r := <-h.reports:
			reports = append(reports, r)
		case <-timeout:
			t.Fatal("timeout")
		}
	}
	tr.stop(t)
	// Drain anything still queued.
	for {
		select {
		case bf := <-h.backfills:
			backfilled = append(backfilled, bf.Samples...)
			continue
		case r := <-h.reports:
			reports = append(reports, r)
			continue
		default:
		}
		break
	}
	if len(backfilled) < hello.BufferedSamples {
		t.Fatalf("backfilled %d of %d samples", len(backfilled), hello.BufferedSamples)
	}
	// Oldest first, no duplicates.
	seen := map[time.Time]bool{}
	for i, s := range backfilled {
		if i > 0 && !s.At.After(backfilled[i-1].At) {
			t.Fatalf("backfill not oldest first at %d: %v <= %v", i, s.At, backfilled[i-1].At)
		}
		if s.Values[proto.SeriesCPU] == 0 {
			t.Fatalf("sample without values: %+v", s)
		}
		seen[s.At] = true
	}
	for _, r := range reports {
		if seen[r.At] {
			t.Fatalf("sample at %v sent as report and backfill", r.At)
		}
		seen[r.At] = true
	}
	// Every collected sample reached the hub exactly once (allow the last
	// one or two, collected during shutdown, to be still buffered).
	missing := 0
	for _, at := range tr.col.times() {
		if !seen[at] {
			missing++
		}
	}
	if missing > 2 {
		t.Fatalf("%d collected samples never reached the hub", missing)
	}
}

func TestBufferPersistedAcrossRestart(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	h.refuse.Store(true)
	tr := startRuntime(t, cfg, nil)
	// Stop once samples are buffered, however long collecting takes.
	waitUntil(t, "samples buffered while offline", func() bool { return tr.rt.buf.Len() >= 4 })
	if err := tr.stop(t); err != nil {
		t.Fatal(err)
	}
	b := NewBuffer(filepath.Join(cfg.StateDir, BufferFileName))
	if err := b.Load(); err != nil {
		t.Fatal(err)
	}
	if b.Len() < 4 {
		t.Fatalf("persisted buffer has %d samples", b.Len())
	}
	// A new agent process backfills them.
	h.refuse.Store(false)
	tr2 := startRuntime(t, cfg, nil)
	_ = tr2
	hello := recv(t, h.hellos, "hello")
	if hello.BufferedSamples < b.Len() {
		t.Fatalf("restarted agent announces %d buffered samples, want >= %d", hello.BufferedSamples, b.Len())
	}
	bf := recv(t, h.backfills, "backfill")
	if len(bf.Samples) < b.Len() {
		t.Fatalf("backfill has %d samples", len(bf.Samples))
	}
}

// ---- hub-opened streams ---------------------------------------------------------

type fakeBroker struct {
	actions atomic.Int32
	thumbs  atomic.Int32
	mu      sync.Mutex
	sess    []*echoSession
}

func (b *fakeBroker) Action(ctx context.Context, req proto.ActionRequest) proto.ActionResponse {
	b.actions.Add(1)
	return proto.ActionResponse{OK: true, State: "running"}
}

func (b *fakeBroker) Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
	b.thumbs.Add(1)
	return proto.ThumbnailResponse{Image: []byte("jpeg"), Width: 1, Height: 1}
}

func (b *fakeBroker) Console(ctx context.Context, req proto.ConsoleRequest) (ConsoleSession, proto.ConsoleResponse) {
	if req.GuestID != "web" {
		return nil, proto.ConsoleResponse{Code: "unknown_guest"}
	}
	s := &echoSession{done: make(chan struct{})}
	b.mu.Lock()
	b.sess = append(b.sess, s)
	b.mu.Unlock()
	return s, proto.ConsoleResponse{OK: true, Resolution: "80x24"}
}

// echoSession echoes data frames and records control frames it sees.
type echoSession struct {
	mu       sync.Mutex
	controls []string
	done     chan struct{}
}

func (s *echoSession) Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error {
	defer close(s.done)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case f, ok := <-in:
			if !ok {
				return nil
			}
			if f.Kind == wire.FrameControl {
				var cc wire.ConsoleControl
				json.Unmarshal(f.Payload, &cc)
				s.mu.Lock()
				s.controls = append(s.controls, cc.Type)
				s.mu.Unlock()
				continue
			}
			if err := out(f); err != nil {
				return err
			}
		}
	}
}

func rpc[Req, Resp any](t *testing.T, side *hubSide, kind string, req Req) Resp {
	t.Helper()
	st := side.open(t, kind)
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		t.Fatal(err)
	}
	st.SetReadDeadline(time.Now().Add(10 * time.Second))
	var resp Resp
	if err := wire.ReadMsg(st, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func setPolicy(t *testing.T, rt *Runtime, console, power bool) {
	t.Helper()
	cfg := rt.Config()
	b, err := os.ReadFile(filepath.Join(cfg.Dir, ConfigFileName))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	s = strings.Replace(s, "console = false", "console = true", 1)
	s = strings.Replace(s, "power = false", "power = true", 1)
	if !console {
		s = strings.Replace(s, "console = true", "console = false", 1)
	}
	if !power {
		s = strings.Replace(s, "power = true", "power = false", 1)
	}
	if err := os.WriteFile(filepath.Join(cfg.Dir, ConfigFileName), []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
}

func TestPolicyDenial(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	side := h.waitSide(t)

	// Fresh enrollment: everything is refused locally.
	ar := rpc[proto.ActionRequest, proto.ActionResponse](t, side, proto.StreamAction, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: "start"})
	if ar.OK || ar.Code != CodeRemoteControlDisabled {
		t.Fatalf("action: %+v", ar)
	}
	th := rpc[proto.ThumbnailRequest, proto.ThumbnailResponse](t, side, proto.StreamThumbnail, proto.ThumbnailRequest{Platform: "incus", GuestID: "web"})
	if th.Code != CodeRemoteControlDisabled {
		t.Fatalf("thumbnail: %+v", th)
	}
	cr := rpc[proto.ConsoleRequest, proto.ConsoleResponse](t, side, proto.StreamConsole, proto.ConsoleRequest{SessionID: "cs_1", Platform: "incus", GuestID: "web", Protocol: "shell"})
	if cr.OK || cr.Code != CodeRemoteControlDisabled {
		t.Fatalf("console: %+v", cr)
	}
	if tr.broker.actions.Load() != 0 || tr.broker.thumbs.Load() != 0 {
		t.Fatal("broker was called despite the policy")
	}

	// console=true, power=false: ctrl_alt_del and thumbnails pass, power does not.
	setPolicy(t, tr.rt, true, false)
	ar = rpc[proto.ActionRequest, proto.ActionResponse](t, side, proto.StreamAction, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: "reboot"})
	if ar.Code != CodeRemoteControlDisabled {
		t.Fatalf("power action with power=false: %+v", ar)
	}
	ar = rpc[proto.ActionRequest, proto.ActionResponse](t, side, proto.StreamAction, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: proto.ActionCtrlAltDel})
	if !ar.OK {
		t.Fatalf("ctrl_alt_del with console=true: %+v", ar)
	}
	th = rpc[proto.ThumbnailRequest, proto.ThumbnailResponse](t, side, proto.StreamThumbnail, proto.ThumbnailRequest{Platform: "incus", GuestID: "web"})
	if th.Code != "" || string(th.Image) != "jpeg" {
		t.Fatalf("thumbnail: %+v", th)
	}
	// The policy is reported to the hub.
	deadline := time.After(5 * time.Second)
	for {
		r := recv(t, h.reports, "report")
		if r.Policy.Console && !r.Policy.Power {
			break
		}
		select {
		case <-deadline:
			t.Fatal("policy change not reported")
		default:
		}
	}
	setPolicy(t, tr.rt, true, true)
	ar = rpc[proto.ActionRequest, proto.ActionResponse](t, side, proto.StreamAction, proto.ActionRequest{Platform: "incus", GuestID: "web", Action: "reboot"})
	if !ar.OK {
		t.Fatalf("power action with power=true: %+v", ar)
	}
}

func openConsole(t *testing.T, side *hubSide, guest string) (*consoleClient, proto.ConsoleResponse) {
	t.Helper()
	st := side.open(t, proto.StreamConsole)
	if err := wire.WriteMsg(st, proto.ConsoleRequest{SessionID: "cs_x", Platform: "incus", GuestID: guest, Protocol: "shell", Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	st.SetReadDeadline(time.Now().Add(10 * time.Second))
	var resp proto.ConsoleResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		t.Fatal(err)
	}
	st.SetReadDeadline(time.Time{})
	return &consoleClient{st: st, fw: wire.NewFrameWriter(st), fr: wire.NewFrameReader(st)}, resp
}

type consoleClient struct {
	st interface {
		io.ReadWriteCloser
		SetReadDeadline(time.Time) error
	}
	fw *wire.FrameWriter
	fr *wire.FrameReader
}

func (c *consoleClient) control(t *testing.T, cc wire.ConsoleControl) {
	b, _ := json.Marshal(cc)
	if err := c.fw.Write(wire.Frame{Kind: wire.FrameControl, Payload: b}); err != nil {
		t.Fatal(err)
	}
}

func (c *consoleClient) read(t *testing.T) wire.Frame {
	t.Helper()
	c.st.SetReadDeadline(time.Now().Add(5 * time.Second))
	f, err := c.fr.Read()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return f
}

func TestConsoleRelay(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	setPolicy(t, tr.rt, true, false)
	side := h.waitSide(t)

	// Unknown guests are refused by the broker.
	if _, resp := openConsole(t, side, "nope"); resp.OK || resp.Code != "unknown_guest" {
		t.Fatalf("unknown guest: %+v", resp)
	}

	c, resp := openConsole(t, side, "web")
	if !resp.OK || resp.Resolution != "80x24" {
		t.Fatalf("console: %+v", resp)
	}
	// Data is relayed both ways.
	if err := c.fw.Write(wire.Frame{Kind: wire.FrameData, Payload: []byte("hello")}); err != nil {
		t.Fatal(err)
	}
	if f := c.read(t); f.Kind != wire.FrameData || string(f.Payload) != "hello" {
		t.Fatalf("echo: %+v", f)
	}
	// Ping is answered by the runtime and never reaches the session.
	c.control(t, wire.ConsoleControl{Type: "ping", ID: 42})
	f := c.read(t)
	var cc wire.ConsoleControl
	json.Unmarshal(f.Payload, &cc)
	if f.Kind != wire.FrameControl || cc.Type != "pong" || cc.ID != 42 {
		t.Fatalf("pong: %+v %s", f, f.Payload)
	}
	c.control(t, wire.ConsoleControl{Type: "resize", Cols: 100, Rows: 30})
	if err := c.fw.Write(wire.Frame{Kind: wire.FrameData, Payload: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	c.read(t) // echo of "x": resize was delivered before it
	tr.broker.mu.Lock()
	sess := tr.broker.sess[0]
	tr.broker.mu.Unlock()
	sess.mu.Lock()
	ctrls := strings.Join(sess.controls, ",")
	sess.mu.Unlock()
	if ctrls != "resize" {
		t.Fatalf("session saw controls %q, want only resize", ctrls)
	}
	if n := tr.rt.ConsoleCount(); n != 1 {
		t.Fatalf("console count %d", n)
	}
	// Closing the stream ends the session and frees the slot.
	c.st.Close()
	select {
	case <-sess.done:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end after the hub closed the stream")
	}
	deadline := time.Now().Add(5 * time.Second)
	for tr.rt.ConsoleCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("console slot not released")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestConsoleLimit(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, func(rt *Runtime) { rt.MaxConsoles = 2 })
	setPolicy(t, tr.rt, true, false)
	side := h.waitSide(t)
	c1, r1 := openConsole(t, side, "web")
	_, r2 := openConsole(t, side, "web")
	_, r3 := openConsole(t, side, "web")
	if !r1.OK || !r2.OK || r3.OK || r3.Code != CodeTooManySessions {
		t.Fatalf("limit: %+v %+v %+v", r1, r2, r3)
	}
	c1.st.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, r4 := openConsole(t, side, "web")
		if r4.OK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot not freed: %+v", r4)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestConsoleEndsOnDisconnect(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	tr := startRuntime(t, cfg, nil)
	setPolicy(t, tr.rt, true, false)
	side := h.waitSide(t)
	_, resp := openConsole(t, side, "web")
	if !resp.OK {
		t.Fatal(resp)
	}
	side.sess.Close() // hub connection lost
	tr.broker.mu.Lock()
	sess := tr.broker.sess[0]
	tr.broker.mu.Unlock()
	select {
	case <-sess.done:
	case <-time.After(5 * time.Second):
		t.Fatal("session survived the connection loss")
	}
	// The agent reconnects.
	recv(t, h.hellos, "first hello")
	recv(t, h.hellos, "hello after reconnect")
}

func TestCertificateRenewal(t *testing.T) {
	h := newFakeHub(t)
	h.certLife = 5 * 24 * time.Hour // expires within RenewBefore
	cfg := enrollAgent(t, h)
	old, _ := LoadCertFile(cfg.CertPath())
	startRuntime(t, cfg, nil)
	hello := recv(t, h.hellos, "hello")
	if len(hello.CSR) == 0 {
		t.Fatal("expected a CSR in hello")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		c, err := LoadCertFile(cfg.CertPath())
		if err == nil && c.NotAfter.After(old.NotAfter.Add(24*time.Hour)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("renewed certificate not written")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A connection that outlives the start of the renewal window reconnects so
// the handshake renews the certificate.
func TestRenewalOnLongConnection(t *testing.T) {
	h := newFakeHub(t)
	h.certLife = RenewBefore + 3*time.Second // X.509 times have one-second precision
	cfg := enrollAgent(t, h)
	startRuntime(t, cfg, func(rt *Runtime) { rt.RenewJitter = 0 })
	if hello := recv(t, h.hellos, "hello"); len(hello.CSR) != 0 {
		t.Fatal("certificate outside the renewal window must not be renewed yet")
	}
	if hello := recv(t, h.hellos, "hello after the renewal window opened"); len(hello.CSR) == 0 {
		t.Fatal("expected a CSR after reconnecting for renewal")
	}
}

func TestRejectedAgentBacksOff(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	h.rejected = "revoked"
	startRuntime(t, cfg, func(rt *Runtime) { rt.BackoffMax = 300 * time.Millisecond })
	recv(t, h.hellos, "hello")
	start := time.Now()
	recv(t, h.hellos, "hello after rejection")
	if d := time.Since(start); d < 100*time.Millisecond {
		t.Fatalf("rejected agent retried after %v (expected max backoff)", d)
	}
}

func TestBuffer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "buffer.cbor")
	b := NewBuffer(path)
	now := time.Now().UTC()
	b.nowFunc = func() time.Time { return now }
	b.maxLen = 5
	for i := 0; i < 8; i++ {
		b.Add(proto.Sample{At: now.Add(time.Duration(i) * time.Second), Values: map[string]float64{"cpu_pct": float64(i)}})
	}
	if b.Len() != 5 {
		t.Fatalf("len %d", b.Len())
	}
	got, tok := b.Peek(2)
	if got[0].Values["cpu_pct"] != 3 || got[1].Values["cpu_pct"] != 4 {
		t.Fatalf("peek: %+v", got)
	}
	b.Add(proto.Sample{At: now.Add(9 * time.Second), Values: map[string]float64{"cpu_pct": 9}}) // trims one more
	b.Ack(tok)
	rest, _ := b.Peek(10)
	var vals []float64
	for _, s := range rest {
		vals = append(vals, s.Values["cpu_pct"])
	}
	if !sort.Float64sAreSorted(vals) || vals[0] != 5 || len(vals) != 4 {
		t.Fatalf("after ack: %v", vals)
	}
	if err := b.Save(); err != nil {
		t.Fatal(err)
	}
	b2 := NewBuffer(path)
	b2.nowFunc = func() time.Time { return now }
	if err := b2.Load(); err != nil || b2.Len() != 4 {
		t.Fatalf("reload: %v len %d", err, b2.Len())
	}
	// Samples older than a day are dropped on load.
	b3 := NewBuffer(path)
	b3.nowFunc = func() time.Time { return now.Add(25 * time.Hour) }
	if err := b3.Load(); err != nil || b3.Len() != 0 {
		t.Fatalf("stale reload: %v len %d", err, b3.Len())
	}
}

func TestSelfStats(t *testing.T) {
	var s selfStats
	rss, _ := s.sample()
	if rss == 0 {
		t.Fatal("rss is 0")
	}
	x := 0
	for end := time.Now().Add(150 * time.Millisecond); time.Now().Before(end); {
		x++
	}
	_ = x
	_, cpu := s.sample()
	if cpu <= 0 {
		t.Fatalf("cpu %v", cpu)
	}
}

func TestHubURLs(t *testing.T) {
	for in, want := range map[string]string{
		"wss://10.0.0.1:8443":    "https://10.0.0.1:8443",
		"wss://hub.example/":     "https://hub.example",
		"https://hub:8443/x?y=1": "https://hub:8443/x",
	} {
		if got, err := HubHTTPBase(in); err != nil || got != want {
			t.Errorf("HubHTTPBase(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"ws://x:1", "http://x", "x:1", ""} {
		if _, err := HubHTTPBase(bad); err == nil {
			t.Errorf("HubHTTPBase(%q) accepted", bad)
		}
	}
	if NormalizePin("AB:cd") != "abcd" || !ValidPin(strings.Repeat("A", 64)) || ValidPin("xyz") {
		t.Error("pin helpers")
	}
}
