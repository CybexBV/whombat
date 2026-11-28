package hub

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/ca"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// AgentSubprotocol is the WebSocket subprotocol of /agent/v1/connect;
// Rackoon agents offer LegacyAgentSubprotocol, which is accepted too.
const (
	AgentSubprotocol       = "whombat.agent.v1"
	LegacyAgentSubprotocol = "rackoon.agent.v1"
)

// AgentHandler serves the agent listener: enrollment (no client
// certificate) and /agent/v1/connect (client certificate required).
func (h *Hub) AgentHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/enroll", h.handleEnroll)
	mux.HandleFunc("GET /agent/v1/enroll/{id}", h.handleEnrollPoll)
	mux.HandleFunc("GET /agent/v1/connect", h.handleConnect)
	mux.HandleFunc("GET /healthz", h.serveHealth)
	// The installer and the agent builds, with this listener's key pinned
	// (the command from POST /enrollments), and heartbeat pings from the
	// hosts' network.
	mux.HandleFunc("GET /install.sh", h.installScript(true))
	mux.HandleFunc("GET /install.ps1", h.serveInstallPS1)
	mux.HandleFunc("GET /download/{name}", h.serveDownload)
	mux.HandleFunc("/ping/{token}", h.servePing)
	mux.HandleFunc("/ping/{token}/{what}", h.servePing)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), agentListenerKey{}, true)))
	})
}

func agentJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// cleanText keeps printable characters of an agent-supplied string.
func cleanText(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return -1
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

type enrollRequest struct {
	Token        string `json:"token"`
	CSR          string `json:"csr"`
	Hostname     string `json:"hostname"`
	MachineID    string `json:"machine_id"`
	OS           string `json:"os"`
	Address      string `json:"address"`
	AgentVersion string `json:"agent_version"`
}

func (h *Hub) handleEnroll(w http.ResponseWriter, r *http.Request) {
	ip := remoteIP(r)
	if !h.limits.enroll.allow(ip) {
		agentJSON(w, http.StatusTooManyRequests, map[string]string{"code": "rate_limited"})
		return
	}
	var req enrollRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		agentJSON(w, http.StatusBadRequest, map[string]string{"code": "bad_request"})
		return
	}
	if req.Token == "" {
		agentJSON(w, http.StatusUnauthorized, map[string]string{"code": "invalid_token"})
		return
	}
	if _, err := ca.ParseCSR([]byte(req.CSR)); err != nil {
		agentJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_csr", "message": err.Error()})
		return
	}
	poll := randToken(32)
	now := h.now()
	er := store.EnrollRequest{
		CSR: []byte(req.CSR), Hostname: cleanText(req.Hostname, 128), MachineID: cleanText(req.MachineID, 64),
		OS: cleanText(req.OS, 128), Address: cleanText(req.Address, 64), RemoteAddr: ip,
		AgentVersion: cleanText(req.AgentVersion, 32),
	}
	e, err := h.store.ClaimEnrollment(r.Context(), sha(req.Token), now, er, sha(poll))
	if errors.Is(err, store.ErrNotFound) {
		h.limits.enroll.fail(ip)
		h.log.Warn("enrollment with an invalid token", "client_ip", ip)
		agentJSON(w, http.StatusUnauthorized, map[string]string{"code": "invalid_token"})
		return
	}
	if err != nil {
		h.log.Error("enrollment", "err", err)
		agentJSON(w, http.StatusInternalServerError, map[string]string{"code": "internal"})
		return
	}
	h.log.Info("enrollment requested", "enrollment", e.ID, "hostname", e.Hostname, "client_ip", ip)
	h.auditSystem(r.Context(), store.AuditRecord{Event: "enrollment.requested", Outcome: "ok", ClientIP: ip,
		User: "agent", Details: map[string]string{"enrollment_id": e.ID, "hostname": e.Hostname}})
	out := map[string]string{"enrollment_id": e.ID, "poll_secret": poll}
	if e.Approve {
		// Pre-approved (SI-07): the server exists before this answer, so
		// the agent's first poll gets its certificate.
		id, err := h.autoApprove(r.Context(), e, ip)
		if err == nil {
			out["state"], out["server_id"] = store.EnrollApproved, id
			agentJSON(w, http.StatusAccepted, out)
			return
		}
		h.log.Error("pre-approved enrollment left for an admin", "enrollment", e.ID, "err", err)
	}
	h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "enrollment.pending", map[string]string{"id": e.ID, "hostname": e.Hostname})
	out["state"] = store.EnrollPending
	agentJSON(w, http.StatusAccepted, out)
}

func (h *Hub) handleEnrollPoll(w http.ResponseWriter, r *http.Request) {
	e, err := h.store.GetEnrollment(r.Context(), r.PathValue("id"))
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err != nil || auth == "" || len(e.PollSecretHash) == 0 || subtle.ConstantTimeCompare(sha(auth), e.PollSecretHash) != 1 {
		agentJSON(w, http.StatusNotFound, map[string]string{"code": "not_found"})
		return
	}
	switch e.State {
	case store.EnrollPending:
		agentJSON(w, http.StatusAccepted, map[string]string{"state": "pending"})
	case store.EnrollApproved:
		agentJSON(w, http.StatusOK, map[string]string{"state": "approved", "server_id": e.ServerID,
			"certificate": string(e.Certificate), "ca": string(h.ca.CertPEM)})
	case store.EnrollRejected:
		agentJSON(w, http.StatusForbidden, map[string]string{"state": "rejected"})
	default:
		agentJSON(w, http.StatusGone, map[string]string{"state": "expired"})
	}
}

func (h *Hub) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "client certificate required", http.StatusUnauthorized)
		return
	}
	leaf := r.TLS.PeerCertificates[0]
	id := ca.ClientIdentity(leaf)
	serial := ca.SerialHex(leaf.SerialNumber)
	adopt := false
	if !h.serialValid(id, serial) {
		// After a restore, a certificate the CA issued later than the
		// backup's may be adopted (its machine id is checked in hello).
		if adopt = h.adoptable(id, leaf); !adopt {
			h.log.Warn("agent refused: unknown server or revoked certificate", "server", id, "serial", serial, "client_ip", remoteIP(r))
			http.Error(w, "certificate revoked", http.StatusForbidden)
			return
		}
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{AgentSubprotocol, LegacyAgentSubprotocol}})
	if err != nil {
		return
	}
	if c.Subprotocol() != AgentSubprotocol && c.Subprotocol() != LegacyAgentSubprotocol {
		c.Close(websocket.StatusPolicyViolation, "subprotocol "+AgentSubprotocol+" required")
		return
	}
	ctx := r.Context()
	nc := websocket.NetConn(ctx, c, websocket.MessageBinary)
	sess, err := yamux.Server(nc, wire.YamuxConfig())
	if err != nil {
		nc.Close()
		return
	}
	ac := &AgentConn{h: h, ServerID: id, serial: serial, sess: sess, remote: remoteIP(r), dialed: r.Host, via: viaAddr(r),
		closed: make(chan struct{}), consoleSem: make(chan struct{}, h.cfg.ConsolePerAgent), connectedAt: h.now(),
		adopt: adopt, certNotAfter: leaf.NotAfter}
	ac.serve(ctx)
}

// viaAddr is the hub-side address of the agent's connection. A connection
// that a local proxy forwarded (loopback here, another machine at the
// other end) says nothing about which of the hub's addresses the agent
// used, so it has none.
func viaAddr(r *http.Request) netip.AddrPort {
	la, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok {
		return netip.AddrPort{}
	}
	ap, err := netip.ParseAddrPort(la.String())
	if err != nil {
		return netip.AddrPort{}
	}
	ap = netip.AddrPortFrom(ap.Addr().Unmap().WithZone(""), ap.Port())
	if ap.Addr().IsLoopback() {
		if rip, err := netip.ParseAddr(remoteIP(r)); err == nil && !rip.Unmap().IsLoopback() {
			return netip.AddrPort{}
		}
	}
	return ap
}

// Via is the hub's address the agent came in on, as text ("" when not
// known).
func (c *AgentConn) Via() string {
	if c == nil || !c.via.IsValid() {
		return ""
	}
	return c.via.Addr().String()
}

// AgentConn is the hub side of a connected agent. It opens action,
// thumbnail and console streams to the agent.
type AgentConn struct {
	h        *Hub
	ServerID string
	serial   string // client certificate serial of this connection
	sess     *yamux.Session
	remote   string
	// dialed is the host:port the agent dialed (its agent.toml hub), which
	// may not be the agents' address the hub names (a forwarded port).
	dialed string
	// via is the hub's own address the connection arrived at (invalid
	// when unknown: a port forwarded through the proxy protocol).
	via netip.AddrPort
	// connectedAt is when the agent connected (certificate renewal nudge).
	connectedAt time.Time
	// adopt: the certificate is not the stored one but may be adopted
	// after a restore (HS-180); certNotAfter is its expiry.
	adopt        bool
	certNotAfter time.Time
	// addrsSent is the hub address list the agent was told last (addrs.go).
	addrsSent atomic.Pointer[string]

	ctrlMu sync.Mutex
	ctrl   net.Conn

	closed         chan struct{}
	closeOnce      sync.Once
	consoleSem     chan struct{}
	lastFrame      atomic.Int64
	reportBucket   bucket
	eventBucket    bucket
	backfillBucket bucket
}

// bucket is a small token bucket (default burst 5, one token per 2 s);
// used by the control-stream reader only.
type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) allow(now time.Time, burstPerSec ...float64) bool {
	burst, perSec := 5.0, 0.5
	if len(burstPerSec) == 2 {
		burst, perSec = burstPerSec[0], burstPerSec[1]
	}
	if b.last.IsZero() {
		b.tokens = burst
	} else {
		b.tokens = min(burst, b.tokens+now.Sub(b.last).Seconds()*perSec)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// ErrAgentClosed is returned when the agent connection is gone.
var ErrAgentClosed = errors.New("agent disconnected")

// Close tears down the connection.
func (c *AgentConn) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
		c.sess.Close()
	})
}

// Done is closed when the connection is gone.
func (c *AgentConn) Done() <-chan struct{} { return c.closed }

func (c *AgentConn) send(typ string, body any) error {
	c.ctrlMu.Lock()
	defer c.ctrlMu.Unlock()
	if c.ctrl == nil {
		return ErrAgentClosed
	}
	_ = c.ctrl.SetWriteDeadline(time.Now().Add(20 * time.Second))
	return wire.SendEnvelope(c.ctrl, typ, body)
}

func (c *AgentConn) serve(ctx context.Context) {
	defer c.Close()
	h := c.h
	actx, cancel := context.WithTimeout(ctx, 30*time.Second)
	st, err := c.sess.AcceptStreamWithContext(actx)
	cancel()
	if err != nil {
		h.log.Warn("agent did not open its control stream", "server", c.ServerID, "err", err)
		return
	}
	_ = st.SetReadDeadline(time.Now().Add(30 * time.Second))
	var hdr proto.StreamHeader
	if err := wire.ReadMsg(st, &hdr); err != nil || hdr.Kind != proto.StreamControl {
		h.log.Warn("agent: first stream is not a control stream", "server", c.ServerID, "err", err)
		return
	}
	var env proto.Envelope
	var hello proto.Hello
	if err := wire.ReadMsg(st, &env); err != nil || env.Type != proto.MsgHello || wire.Unmarshal(env.Body, &hello) != nil {
		h.log.Warn("agent: bad hello", "server", c.ServerID, "err", err)
		return
	}
	c.ctrl = st
	ack := h.handleHello(ctx, c, hello)
	if err := c.send(proto.MsgHelloAck, ack); err != nil || ack.Rejected != "" {
		if ack.Rejected != "" {
			h.log.Warn("agent rejected", "server", c.ServerID, "reason", ack.Rejected)
			time.Sleep(200 * time.Millisecond)
		}
		return
	}
	h.attach(c, hello)
	defer h.detach(c)
	h.sendChecks(c)

	// The agent opens no other streams.
	go func() {
		for {
			s, err := c.sess.AcceptStream()
			if err != nil {
				return
			}
			s.Close()
		}
	}()
	// Hub pings (the agent's reports are the heartbeat; pings keep idle
	// NAT mappings alive and detect dead peers).
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-c.closed:
				return
			case <-t.C:
				_ = c.send(proto.MsgPing, time.Now().UnixNano())
			}
		}
	}()

	for {
		_ = st.SetReadDeadline(time.Now().Add(h.cfg.HeartbeatTimeout + 15*time.Second))
		env = proto.Envelope{}
		if err := wire.ReadMsg(st, &env); err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, yamux.ErrSessionShutdown) {
				h.log.Info("agent connection ended", "server", c.ServerID, "err", err)
			}
			return
		}
		h.touch(c)
		switch env.Type {
		case proto.MsgReport:
			var rep proto.Report
			if err := wire.Unmarshal(env.Body, &rep); err != nil {
				h.log.Warn("agent: bad report", "server", c.ServerID, "err", err)
				continue
			}
			// Reports are rate limited (burst 5, then one per 2 s); extra
			// reports still count as heartbeats.
			if !c.reportBucket.allow(time.Now()) {
				continue
			}
			h.ingestReport(ctx, c.ServerID, &rep)
		case proto.MsgBackfill:
			var bf proto.Backfill
			if err := wire.Unmarshal(env.Body, &bf); err != nil {
				h.log.Warn("agent: bad backfill", "server", c.ServerID, "err", err)
				continue
			}
			// 24 h of buffered samples arrive as ~18 batches of 500; more
			// than that in a burst is not a reconnecting agent.
			if !c.backfillBucket.allow(time.Now(), 40, 1) {
				h.log.Warn("agent: backfill rate exceeded, batch dropped", "server", c.ServerID)
				continue
			}
			h.ingestBackfill(ctx, c.ServerID, bf.Samples)
		case proto.MsgEvent:
			var ev proto.Event
			if err := wire.Unmarshal(env.Body, &ev); err != nil {
				continue
			}
			if !c.eventBucket.allow(time.Now()) {
				continue
			}
			h.ingestEvent(c.ServerID, ev)
		case proto.MsgPing:
			c.ctrlMu.Lock()
			_ = st.SetWriteDeadline(time.Now().Add(20 * time.Second))
			err := wire.WriteMsg(st, proto.Envelope{Type: proto.MsgPong, Body: env.Body})
			c.ctrlMu.Unlock()
			if err != nil {
				return
			}
		case proto.MsgPong:
		default:
			h.log.Debug("agent: unknown message", "server", c.ServerID, "type", cleanText(env.Type, 32))
		}
	}
}

// serialValid reports whether a client certificate serial may connect as
// the server: the current one, or the one before a renewal whose new
// certificate the agent has not used yet.
func (h *Hub) serialValid(id, serial string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s, ok := h.servers[id]
	if !ok || serial == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(s.meta.CertSerial), []byte(serial)) == 1 ||
		(s.meta.PrevCertSerial != "" && subtle.ConstantTimeCompare([]byte(s.meta.PrevCertSerial), []byte(serial)) == 1)
}

// handleHello validates the hello, measures clock skew and renews the
// client certificate when the agent sent a CSR.
func (h *Hub) handleHello(ctx context.Context, c *AgentConn, hello proto.Hello) proto.HelloAck {
	now := h.now()
	ack := proto.HelloAck{ServerID: c.ServerID, HubVersion: Version, HubClock: now.UTC()}
	if hello.ProtocolVersion != proto.Version {
		ack.Rejected = fmt.Sprintf("unsupported protocol version %d (hub speaks %d)", hello.ProtocolVersion, proto.Version)
		return ack
	}
	// The server may have been deleted (and the id reused) while connecting.
	if c.adopt {
		if !h.adoptCert(ctx, c, hello) {
			ack.Rejected = "certificate revoked"
			return ack
		}
	} else if !h.serialValid(c.ServerID, c.serial) {
		ack.Rejected = "certificate revoked"
		return ack
	}
	if len(hello.CSR) > 0 {
		iss, err := h.ca.SignClient(hello.CSR, c.ServerID, now)
		if err != nil {
			h.log.Warn("certificate renewal refused", "server", c.ServerID, "err", err)
		} else if err := h.store.UpdateServerCert(ctx, c.ServerID, iss.Serial, iss.NotAfter, c.serial); err != nil {
			h.log.Error("certificate renewal", "server", c.ServerID, "err", err)
		} else {
			h.mu.Lock()
			if s, ok := h.servers[c.ServerID]; ok {
				s.meta.CertSerial, s.meta.CertNotAfter, s.meta.PrevCertSerial = iss.Serial, iss.NotAfter, c.serial
			}
			h.mu.Unlock()
			ack.Certificate = iss.PEM
			h.log.Info("client certificate renewed", "server", c.ServerID, "not_after", iss.NotAfter)
			h.auditSystem(ctx, store.AuditRecord{Event: "agent.certificate_renewed", Outcome: "ok", User: "agent", Server: c.ServerID,
				ClientIP: c.remote, Details: map[string]string{"serial": iss.Serial, "previous_serial": c.serial,
					"not_after": iss.NotAfter.UTC().Format(time.RFC3339)}})
		}
	}
	// Where else the agent may find the hub (HS-170).
	if ack.Addrs = h.hubAddrs(ctx); len(ack.Addrs) > 0 {
		key := addrsKey(ack.Addrs)
		c.addrsSent.Store(&key)
	}
	return ack
}

// attach registers a new connection (replacing an older one).
func (h *Hub) attach(c *AgentConn, hello proto.Hello) {
	now := h.now()
	skew := math.Round(hello.Clock.Sub(now).Seconds()*10)/10 + 0 // no negative zero
	c.lastFrame.Store(now.UnixNano())
	var old *AgentConn
	h.mu.Lock()
	s, ok := h.servers[c.ServerID]
	if !ok || (s.meta.CertSerial != c.serial && s.meta.PrevCertSerial != c.serial) {
		h.mu.Unlock()
		c.Close()
		return
	}
	clearPrev := s.meta.CertSerial == c.serial && s.meta.PrevCertSerial != ""
	if clearPrev {
		s.meta.PrevCertSerial = ""
	}
	old = s.conn
	s.conn = c
	s.skew = &skew
	s.lastFrame = now
	s.dirty = true
	if v := cleanText(hello.AgentVersion, 32); v != "" {
		s.meta.AgentVersion = v
	}
	if hn := cleanText(hello.Hostname, 128); hn != "" {
		s.meta.Hostname = hn
	}
	if c.remote != "" && s.meta.Address == "" {
		s.meta.Address = c.remote
	}
	machineMismatch := s.meta.MachineID != "" && hello.MachineID != "" && s.meta.MachineID != hello.MachineID
	wasOffline := s.offline
	s.offline = false
	h.mu.Unlock()
	if old != nil && old != c {
		old.Close()
	}
	if clearPrev {
		if err := h.store.ClearPrevSerial(context.Background(), c.ServerID); err != nil {
			h.log.Error("clear previous certificate", "server", c.ServerID, "err", err)
		}
	}
	if machineMismatch {
		h.log.Warn("agent machine id differs from enrollment", "server", c.ServerID)
		h.auditSystem(context.Background(), store.AuditRecord{Event: "agent.machine_id_mismatch", Outcome: "denied", User: "agent",
			Server: c.ServerID, ClientIP: c.remote, Details: map[string]string{"hostname": cleanText(hello.Hostname, 128)}})
	}
	if math.Abs(skew) > 30 {
		h.log.Warn("agent clock skew", "server", c.ServerID, "skew_s", skew)
	}
	h.log.Info("agent connected", "server", c.ServerID, "version", hello.AgentVersion, "client_ip", c.remote,
		"skew_s", skew, "buffered", hello.BufferedSamples)
	if wasOffline {
		h.bus.Publish("server.online", map[string]any{"id": c.ServerID, "at": now.UTC().Format(time.RFC3339)})
	}
	h.publishServerUpdated(c.ServerID)
	h.agentConnected(hello.AgentVersion)
}

// detach unregisters a connection; the server turns offline once its last
// frame is older than the heartbeat timeout (watchdog).
func (h *Hub) detach(c *AgentConn) {
	h.mu.Lock()
	s, ok := h.servers[c.ServerID]
	dropped := ok && s.conn == c // not replaced by a newer connection
	if dropped {
		s.conn = nil
		s.dirty = true
	}
	h.mu.Unlock()
	if dropped {
		h.noteDrop(c.ServerID)
	}
	if ok {
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == c.ServerID && cs.agent.Load() == c }, "agent_disconnected")
		h.log.Info("agent disconnected", "server", c.ServerID)
		h.publishServerUpdated(c.ServerID)
	}
}

// touch records a heartbeat (any frame on the control stream).
func (h *Hub) touch(c *AgentConn) {
	now := h.now()
	c.lastFrame.Store(now.UnixNano())
	h.mu.Lock()
	s, ok := h.servers[c.ServerID]
	var wasOffline bool
	if ok && s.conn == c {
		s.lastFrame = now
		wasOffline = s.offline
		s.offline = false
	}
	h.mu.Unlock()
	if wasOffline {
		h.bus.Publish("server.online", map[string]any{"id": c.ServerID, "at": now.UTC().Format(time.RFC3339)})
	}
}

// openStream opens a hub-initiated stream of a kind.
func (c *AgentConn) openStream(ctx context.Context, kind string) (*yamux.Stream, error) {
	select {
	case <-c.closed:
		return nil, ErrAgentClosed
	default:
	}
	st, err := c.sess.OpenStream()
	if err != nil {
		return nil, ErrAgentClosed
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = st.SetDeadline(dl)
	}
	if err := wire.WriteMsg(st, proto.StreamHeader{Kind: kind}); err != nil {
		st.Close()
		return nil, err
	}
	return st, nil
}

// Action runs a power action on the agent (the agent waits up to 60 s for
// the guest to reach the expected state).
func (c *AgentConn) Action(ctx context.Context, req proto.ActionRequest) (proto.ActionResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	st, err := c.openStream(ctx, proto.StreamAction)
	if err != nil {
		return proto.ActionResponse{}, err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return proto.ActionResponse{}, err
	}
	var resp proto.ActionResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		return proto.ActionResponse{}, err
	}
	resp.Code, resp.Message, resp.State = cleanText(resp.Code, 64), cleanText(resp.Message, 512), cleanText(resp.State, 32)
	return resp, nil
}

// Thumbnail asks the agent for a still image of a guest's screen.
func (c *AgentConn) Thumbnail(ctx context.Context, req proto.ThumbnailRequest) (proto.ThumbnailResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	st, err := c.openStream(ctx, proto.StreamThumbnail)
	if err != nil {
		return proto.ThumbnailResponse{}, err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return proto.ThumbnailResponse{}, err
	}
	var resp proto.ThumbnailResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		return proto.ThumbnailResponse{}, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 512)
	return resp, nil
}

// ErrConsoleLimit is returned when the agent has too many console streams.
var ErrConsoleLimit = errors.New("too many console sessions on this agent")

// OpenConsole opens a console stream. On success the returned stream
// carries console frames (wire.FrameWriter / FrameReader); release must be
// called when the session ends.
func (c *AgentConn) OpenConsole(ctx context.Context, req proto.ConsoleRequest) (st *yamux.Stream, resp proto.ConsoleResponse, release func(), err error) {
	select {
	case c.consoleSem <- struct{}{}:
	default:
		return nil, resp, nil, ErrConsoleLimit
	}
	release = func() { <-c.consoleSem }
	octx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	st, err = c.openStream(octx, proto.StreamConsole)
	if err != nil {
		release()
		return nil, resp, nil, err
	}
	if err := wire.WriteMsg(st, req); err != nil {
		st.Close()
		release()
		return nil, resp, nil, err
	}
	if err := wire.ReadMsg(st, &resp); err != nil {
		st.Close()
		release()
		return nil, resp, nil, err
	}
	resp.Code, resp.Message, resp.Resolution = cleanText(resp.Code, 64), cleanText(resp.Message, 512), cleanText(resp.Resolution, 32)
	if !resp.OK {
		st.Close()
		release()
		return nil, resp, nil, nil
	}
	_ = st.SetDeadline(time.Time{})
	return st, resp, release, nil
}

// Inspect asks the agent for an on-demand view (processes, ports,
// services, updates, a guest's snapshots).
func (c *AgentConn) Inspect(ctx context.Context, req proto.InspectRequest) (proto.InspectResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	st, err := c.openStream(ctx, proto.StreamInspect)
	if err != nil {
		return proto.InspectResponse{}, err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return proto.InspectResponse{}, err
	}
	var resp proto.InspectResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		return proto.InspectResponse{}, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 512)
	return resp, nil
}

// Manage runs one guest configuration / lifecycle operation
// (proto.StreamManage). Long operations answer with a task id at once, so
// the timeout covers the agent's own 90 s budget.
func (c *AgentConn) Manage(ctx context.Context, req proto.ManageRequest) (proto.ManageResponse, error) {
	return c.ManageWithin(ctx, req, 0)
}

// ManageWithin is Manage waiting up to wait (0 = the operation's usual
// wait): a backup place ensure that moves backups waits up to an hour.
func (c *AgentConn) ManageWithin(ctx context.Context, req proto.ManageRequest, wait time.Duration) (proto.ManageResponse, error) {
	if wait == 0 {
		wait = 100 * time.Second
		if proto.LongManageOp(req.Op) {
			wait = proto.LongManageWait + 15*time.Second // backup places answer when done
		}
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	st, err := c.openStream(ctx, proto.StreamManage)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return proto.ManageResponse{}, err
	}
	var resp proto.ManageResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		return proto.ManageResponse{}, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 2048)
	return resp, nil
}

// Diagnose runs one of the agent's read-only checks (proto.StreamDiagnose;
// the agent bounds it to 60 s).
func (c *AgentConn) Diagnose(ctx context.Context, req proto.DiagnoseRequest) (proto.DiagnoseResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	var resp proto.DiagnoseResponse
	if err := c.rpc(ctx, proto.StreamDiagnose, req, &resp); err != nil {
		return resp, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 2048)
	return resp, nil
}

// DiskUsage asks the agent to measure what fills one mounted filesystem
// (proto.StreamDiskUsage; the agent bounds it to at most 45 s).
func (c *AgentConn) DiskUsage(ctx context.Context, req proto.DiskUsageRequest) (proto.DiskUsageResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var resp proto.DiskUsageResponse
	if err := c.rpc(ctx, proto.StreamDiskUsage, req, &resp); err != nil {
		return resp, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 1024)
	resp.Mount, resp.FSType, resp.Device = cleanText(resp.Mount, 512), cleanText(resp.FSType, 64), cleanText(resp.Device, 256)
	for i := range resp.Categories {
		resp.Categories[i].Key = cleanText(resp.Categories[i].Key, 64)
		resp.Categories[i].Label = cleanText(resp.Categories[i].Label, 120)
		resp.Categories[i].Detail = cleanText(resp.Categories[i].Detail, 200)
	}
	for i := range resp.Folders {
		resp.Folders[i].Path = cleanText(resp.Folders[i].Path, 512)
	}
	for i := range resp.SkippedSpunDown {
		resp.SkippedSpunDown[i] = cleanText(resp.SkippedSpunDown[i], 64)
	}
	return resp, nil
}

// Exec runs a root command on the host (proto.StreamExec) and waits for
// it: its own timeout plus a margin.
func (c *AgentConn) Exec(ctx context.Context, req proto.ExecRequest) (proto.ExecResponse, error) {
	t := req.TimeoutS
	if t <= 0 {
		t = 120
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(t+30)*time.Second)
	defer cancel()
	var resp proto.ExecResponse
	if err := c.rpc(ctx, proto.StreamExec, req, &resp); err != nil {
		return resp, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 2048)
	return resp, nil
}

// Screen runs one step on a Mac's screen (proto.StreamScreen; the agent
// bounds it to proto.ScreenStepLimit).
func (c *AgentConn) Screen(ctx context.Context, req proto.ScreenRequest) (proto.ScreenResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, proto.ScreenStepLimit(req.Op)+5*time.Second)
	defer cancel()
	var resp proto.ScreenResponse
	if err := c.rpc(ctx, proto.StreamScreen, req, &resp); err != nil {
		return resp, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 1000)
	return resp, nil
}

// rpc sends one request on a new stream and reads one answer.
func (c *AgentConn) rpc(ctx context.Context, kind string, req, resp any) error {
	st, err := c.openStream(ctx, kind)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return err
	}
	return wire.ReadMsg(st, resp)
}

// Update streams a signed agent binary. The agent verifies and installs it,
// answers, and restarts once the stream is closed.
func (c *AgentConn) Update(ctx context.Context, req proto.UpdateRequest, body io.Reader) (proto.UpdateResponse, error) {
	limit := 3 * time.Minute
	if req.Component == proto.UpdateComponentHelper {
		// The agent waits up to 2 minutes for the new helper to answer at
		// the screen, after unpacking and checking its signature.
		limit = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	st, err := c.openStream(ctx, proto.StreamUpdate)
	if err != nil {
		return proto.UpdateResponse{}, err
	}
	defer st.Close()
	if err := wire.WriteMsg(st, req); err != nil {
		return proto.UpdateResponse{}, err
	}
	// Chunks go out while the answer is awaited: an agent that refuses
	// early answers without reading them.
	go func() {
		buf := make([]byte, 1<<20)
		var sent int64
		for sent < req.Size {
			n, err := io.ReadFull(body, buf[:min(int64(len(buf)), req.Size-sent)])
			if n > 0 {
				if werr := wire.WriteMsg(st, proto.UpdateChunk{Data: buf[:n]}); werr != nil {
					return
				}
				sent += int64(n)
			}
			if err != nil {
				return
			}
		}
	}()
	var resp proto.UpdateResponse
	if err := wire.ReadMsg(st, &resp); err != nil {
		return proto.UpdateResponse{}, err
	}
	resp.Code, resp.Message = cleanText(resp.Code, 64), cleanText(resp.Message, 512)
	return resp, nil
}
