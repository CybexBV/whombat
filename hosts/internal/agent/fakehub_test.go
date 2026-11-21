package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// fakeHub is an in-process hub: TLS listener with its own CA, the
// enrollment endpoints and the agent connection (WebSocket + yamux server).
type fakeHub struct {
	t      *testing.T
	srv    *httptest.Server
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate
	caPEM  []byte
	pin    string

	mu          sync.Mutex
	token       string
	enrollments map[string]*fakeEnrollment
	certLife    time.Duration
	refuse      atomic.Bool // answer /connect with 503
	revoked     atomic.Bool // answer /connect with 403 (a removed server)
	preApprove  bool        // enrollments are approved when asked (Whombat SI-07)
	rejected    string      // HelloAck.Rejected
	ackAddrs    []string    // HelloAck.Addrs
	connects    atomic.Int32
	also        []*httptest.Server // listenAlso
	srvCert     tls.Certificate

	hellos    chan proto.Hello
	reports   chan *proto.Report
	backfills chan proto.Backfill
	events    chan proto.Event
	pongs     chan []byte
	sessions  chan *yamux.Session
	cur       atomic.Pointer[hubSide]
}

type fakeEnrollment struct {
	req      EnrollRequest
	secret   string
	state    string
	polls    int
	approveN int // approve on this poll
}

// hubSide is one connected agent.
type hubSide struct {
	sess *yamux.Session
	ctrl *yamux.Stream
	wmu  sync.Mutex
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{
		t:           t,
		token:       "tok-123",
		enrollments: map[string]*fakeEnrollment{},
		certLife:    30 * 24 * time.Hour,
		hellos:      make(chan proto.Hello, 16),
		reports:     make(chan *proto.Report, 256),
		backfills:   make(chan proto.Backfill, 64),
		events:      make(chan proto.Event, 64),
		pongs:       make(chan []byte, 16),
		sessions:    make(chan *yamux.Session, 16),
	}
	var err error
	h.caKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Rackoon test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &h.caKey.PublicKey, h.caKey)
	if err != nil {
		t.Fatal(err)
	}
	h.caCert, _ = x509.ParseCertificate(der)
	h.caPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	h.pin = CertPin(h.caCert)

	srvKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	srvTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "hub"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTmpl, h.caCert, &srvKey.PublicKey, h.caKey)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/enroll", h.handleEnroll)
	mux.HandleFunc("GET /agent/v1/enroll/{id}", h.handlePoll)
	mux.HandleFunc("GET /agent/v1/connect", h.handleConnect)
	h.srvCert = tls.Certificate{Certificate: [][]byte{srvDER, der}, PrivateKey: srvKey}
	h.srv = httptest.NewUnstartedServer(mux)
	h.srv.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{h.srvCert},
		ClientAuth:   tls.RequestClientCert,
	}
	h.srv.StartTLS()
	t.Cleanup(h.close)
	return h
}

// listenAlso serves the hub on another address too ("127.0.0.2:0"); it
// returns the wss URL.
func (h *fakeHub) listenAlso(t *testing.T, addr string) string {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("cannot listen on %s: %v", addr, err)
	}
	s := httptest.NewUnstartedServer(h.srv.Config.Handler)
	s.Listener.Close()
	s.Listener = ln
	s.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{h.srvCert}, ClientAuth: tls.RequestClientCert}
	s.StartTLS()
	h.also = append(h.also, s)
	return "wss://" + ln.Addr().String()
}

func (h *fakeHub) close() {
	if s := h.cur.Load(); s != nil {
		s.sess.Close()
	}
	h.srv.CloseClientConnections()
	h.srv.Close()
	for _, s := range h.also {
		s.CloseClientConnections()
		s.Close()
	}
}

// wsURL is the hub URL as written into agent.toml.
func (h *fakeHub) wsURL() string {
	u, _ := url.Parse(h.srv.URL)
	return "wss://" + u.Host
}

func (h *fakeHub) signCSR(csrPEM []byte, serverID string, life time.Duration) []byte {
	blk, _ := pem.Decode(csrPEM)
	if blk == nil {
		h.t.Fatal("bad CSR PEM")
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		h.t.Fatalf("bad CSR: %v", err)
	}
	u, _ := url.Parse("rackoon:server:" + serverID)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: serverID},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(life),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		URIs:         []*url.URL{u},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, h.caCert, csr.PublicKey, h.caKey)
	if err != nil {
		h.t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (h *fakeHub) handleEnroll(w http.ResponseWriter, r *http.Request) {
	var req EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"code": "bad_request"})
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if req.Token != h.token {
		writeJSON(w, 401, map[string]string{"code": "invalid_token"})
		return
	}
	h.token = "" // single use
	id := "en_1"
	if h.preApprove {
		h.enrollments[id] = &fakeEnrollment{req: req, secret: "poll-secret", state: "approved", approveN: 1}
		writeJSON(w, 202, EnrollAccepted{EnrollmentID: id, PollSecret: "poll-secret", State: "approved", ServerID: "testhost"})
		return
	}
	h.enrollments[id] = &fakeEnrollment{req: req, secret: "poll-secret", state: "pending", approveN: 2}
	writeJSON(w, 202, EnrollAccepted{EnrollmentID: id, PollSecret: "poll-secret", State: "pending"})
}

func (h *fakeHub) handlePoll(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e := h.enrollments[r.PathValue("id")]
	if e == nil {
		writeJSON(w, 404, map[string]string{"code": "not_found"})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+e.secret {
		writeJSON(w, 401, map[string]string{"code": "unauthenticated"})
		return
	}
	e.polls++
	if e.state == "rejected" {
		writeJSON(w, 403, EnrollStatus{State: "rejected"})
		return
	}
	if e.polls < e.approveN {
		writeJSON(w, 202, EnrollStatus{State: "pending"})
		return
	}
	cert := h.signCSR([]byte(e.req.CSR), "testhost", h.certLife)
	writeJSON(w, 200, EnrollStatus{State: "approved", ServerID: "testhost", Certificate: string(cert), CA: string(h.caPEM)})
}

func (h *fakeHub) handleConnect(w http.ResponseWriter, r *http.Request) {
	h.connects.Add(1)
	if h.refuse.Load() {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "client certificate required", http.StatusUnauthorized)
		return
	}
	if h.revoked.Load() {
		http.Error(w, "certificate revoked", http.StatusForbidden)
		return
	}
	roots := x509.NewCertPool()
	roots.AddCert(h.caCert)
	if _, err := r.TLS.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		http.Error(w, "bad client certificate", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Subprotocol}})
	if err != nil {
		return
	}
	if c.Subprotocol() != Subprotocol {
		c.Close(websocket.StatusPolicyViolation, "subprotocol")
		return
	}
	nc := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
	sess, err := yamux.Server(nc, wire.YamuxConfig())
	if err != nil {
		return
	}
	ctrl, err := sess.AcceptStream()
	if err != nil {
		sess.Close()
		return
	}
	var hdr proto.StreamHeader
	if err := wire.ReadMsg(ctrl, &hdr); err != nil || hdr.Kind != proto.StreamControl {
		sess.Close()
		return
	}
	var env proto.Envelope
	if err := wire.ReadMsg(ctrl, &env); err != nil || env.Type != proto.MsgHello {
		sess.Close()
		return
	}
	var hello proto.Hello
	wire.Unmarshal(env.Body, &hello)
	h.hellos <- hello
	h.mu.Lock()
	ack := proto.HelloAck{ServerID: "testhost", HubVersion: "test", HubClock: time.Now().UTC(), Rejected: h.rejected,
		Addrs: h.ackAddrs}
	h.mu.Unlock()
	if len(hello.CSR) > 0 {
		ack.Certificate = h.signCSR(hello.CSR, "testhost", 30*24*time.Hour)
	}
	side := &hubSide{sess: sess, ctrl: ctrl}
	side.send(proto.MsgHelloAck, ack)
	h.cur.Store(side)
	h.sessions <- sess
	for {
		var env proto.Envelope
		if err := wire.ReadMsg(ctrl, &env); err != nil {
			sess.Close()
			return
		}
		switch env.Type {
		case proto.MsgReport:
			var rep proto.Report
			wire.Unmarshal(env.Body, &rep)
			h.reports <- &rep
		case proto.MsgBackfill:
			var bf proto.Backfill
			wire.Unmarshal(env.Body, &bf)
			h.backfills <- bf
		case proto.MsgEvent:
			var ev proto.Event
			wire.Unmarshal(env.Body, &ev)
			h.events <- ev
		case proto.MsgPong:
			h.pongs <- env.Body
		}
	}
}

func (s *hubSide) send(typ string, body any) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return wire.SendEnvelope(s.ctrl, typ, body)
}

// open opens a hub-initiated stream of the given kind.
func (s *hubSide) open(t *testing.T, kind string) *yamux.Stream {
	t.Helper()
	st, err := s.sess.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	if err := wire.WriteMsg(st, proto.StreamHeader{Kind: kind}); err != nil {
		t.Fatal(err)
	}
	return st
}

// waitSide waits for a connected agent.
func (h *fakeHub) waitSide(t *testing.T) *hubSide {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s := h.cur.Load(); s != nil && !s.sess.IsClosed() {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("agent did not connect")
	return nil
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(10 * time.Second):
		t.Fatalf("timeout waiting for %s", what)
	}
	var zero T
	return zero
}

// enrollAgent runs Enroll against the hub into a temp dir.
func enrollAgent(t *testing.T, h *fakeHub) *Config {
	t.Helper()
	dir := t.TempDir()
	cfg, err := Enroll(context.Background(), EnrollOptions{
		Hub:          h.wsURL(),
		CASHA256:     h.pin,
		Token:        "tok-123",
		ConfigDir:    dir,
		StateDir:     dir + "/state",
		AgentVersion: "test",
		PollInterval: 10 * time.Millisecond,
		Timeout:      10 * time.Second,
	})
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	c, err := LoadConfig(cfg.Dir)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// fakeCollector returns reports with increasing CPU values.
type fakeCollector struct {
	mu        sync.Mutex
	n         int
	ats       []time.Time
	events    chan proto.Event
	refreshes atomic.Int32 // RefreshBackupJobs calls
}

func (c *fakeCollector) RefreshBackupJobs() { c.refreshes.Add(1) }

func (c *fakeCollector) Collect(ctx context.Context) (*proto.Report, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	at := time.Now().UTC().Add(time.Duration(c.n) * time.Microsecond)
	c.ats = append(c.ats, at)
	return &proto.Report{
		At:     at,
		CPU:    proto.CPU{UsagePct: float64(c.n)},
		Memory: proto.Memory{TotalBytes: 100, UsedBytes: 50},
		System: &proto.SystemInfo{PackageManager: "apt"},
		Incus: &proto.Platform{Guests: []proto.Guest{{ID: "web", Kind: "container", State: "running",
			Console: proto.ConsoleCaps{Protocols: []string{"shell"}}}}},
	}, nil
}

func (c *fakeCollector) Events() <-chan proto.Event { return c.events }

func (c *fakeCollector) times() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.ats...)
}

func quietLogger() *testLogger { return &testLogger{} }

type testLogger struct{}

func (testLogger) Write(p []byte) (int, error) { return len(p), nil }

func hasPrefixAny(s string, ps ...string) bool {
	for _, p := range ps {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
