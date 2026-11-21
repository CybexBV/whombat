package hub

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Console WebSocket subprotocols (CONTRACT.md 4).
const (
	ConsoleSubprotocol = "rackoon.console.v1"
	TokenSubprotoPfx   = "rackoon.token."
)

// Close reasons sent to the browser in {"type":"closed","reason":...}.
const (
	reasonIdle         = "idle_timeout"
	reasonMaxAge       = "max_age"
	reasonRevoked      = "revoked"
	reasonRCDisabled   = "remote_control_disabled"
	reasonAgentGone    = "agent_disconnected"
	reasonGuestStopped = "guest_stopped"
	reasonSwitched     = "switched"
	reasonEnded        = "ended"         // the agent closed the stream (shell exited, ...)
	reasonClient       = "client_closed" // the browser closed the socket
)

// consoleSession is one console session: a single-use token until the
// WebSocket upgrade, then a live relay.
type consoleSession struct {
	id          string
	tokenHash   []byte
	userID      int64
	username    string
	role        string
	sessionHash string // browser session that created it (service: the service token's hash)
	service     bool   // created with the service token for an actor (userID is the actor's)
	server      string
	platform    string
	guestID     string // platform-local id
	guest       string // "platform:id"
	protocol    string
	clientIP    string
	userAgent   string
	created     time.Time
	expires     time.Time // token expiry

	// guarded by consoleRegistry.mu
	used bool
	live bool

	opened       atomic.Int64 // unix ns when the relay started
	agent        atomic.Pointer[AgentConn]
	bytesIn      atomic.Int64
	bytesOut     atomic.Int64
	lastActivity atomic.Int64
	closeOnce    sync.Once
	closeCh      chan struct{}
	reasonMu     sync.Mutex
	reason       string
	closedBy     string // another user (an admin) who ended the session
}

func (cs *consoleSession) setClosedBy(user string) {
	cs.reasonMu.Lock()
	cs.closedBy = user
	cs.reasonMu.Unlock()
}

// need is the capability the session depends on.
func (cs *consoleSession) need() string {
	if cs.guest == model.HostGuestID && (cs.protocol == proto.ProtoShell || cs.protocol == proto.ProtoVNC) {
		return needHostShell // a root shell, or a Mac's signed-in screen
	}
	return needConsole
}

func (cs *consoleSession) close(reason string) {
	cs.closeOnce.Do(func() {
		cs.reasonMu.Lock()
		cs.reason = reason
		cs.reasonMu.Unlock()
		close(cs.closeCh)
	})
}

func (cs *consoleSession) closeReason() string {
	cs.reasonMu.Lock()
	defer cs.reasonMu.Unlock()
	return cs.reason
}

type consoleRegistry struct {
	mu sync.Mutex
	m  map[string]*consoleSession
}

func newConsoleRegistry() *consoleRegistry { return &consoleRegistry{m: map[string]*consoleSession{}} }

// active reports whether a session counts toward the limits (live, or a
// token that can still be used).
func (cs *consoleSession) activeLocked(now time.Time) bool {
	return cs.live || (!cs.used && now.Before(cs.expires))
}

func (c *consoleRegistry) count(now time.Time, pred func(*consoleSession) bool) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, cs := range c.m {
		if cs.activeLocked(now) && pred(cs) {
			n++
		}
	}
	return n
}

func (c *consoleRegistry) add(cs *consoleSession) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[cs.id] = cs
}

func (c *consoleRegistry) get(id string) *consoleSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.m[id]
}

func (c *consoleRegistry) remove(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, id)
}

// Token errors.
var (
	errTokenInvalid = apiErr(http.StatusForbidden, "invalid_token", "The console token is not valid for this session.")
	errTokenExpired = apiErr(http.StatusForbidden, "token_expired", "The console token expired. Open the console again.")
	errTokenUsed    = apiErr(http.StatusForbidden, "token_used", "The console token was already used. Open the console again.")
)

// claim validates and consumes a token: single use, unexpired, bound to the
// console session id (URL), the user and the browser session.
func (c *consoleRegistry) claim(id string, token string, userID int64, sessionHash []byte, now time.Time) (*consoleSession, *apiError) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cs := c.m[id]
	if cs == nil || token == "" || subtle.ConstantTimeCompare(sha(token), cs.tokenHash) != 1 {
		return nil, errTokenInvalid
	}
	// Bound to the user and to the browser session that requested it.
	if cs.userID != userID || subtle.ConstantTimeCompare([]byte(cs.sessionHash), sessionHash) != 1 {
		return nil, errTokenInvalid
	}
	if cs.used {
		return nil, errTokenUsed
	}
	if !now.Before(cs.expires) {
		return nil, errTokenExpired
	}
	cs.used = true
	cs.live = true
	return cs, nil
}

// closeWhere ends live sessions matching pred and invalidates matching
// unused tokens.
func (c *consoleRegistry) closeWhere(pred func(*consoleSession) bool, reason string) {
	c.mu.Lock()
	var live []*consoleSession
	for id, cs := range c.m {
		if !pred(cs) {
			continue
		}
		if cs.live {
			live = append(live, cs)
		} else {
			delete(c.m, id)
		}
	}
	c.mu.Unlock()
	for _, cs := range live {
		cs.close(reason)
	}
}

func (c *consoleRegistry) closeAll(reason string) {
	c.closeWhere(func(*consoleSession) bool { return true }, reason)
}

func (c *consoleRegistry) snapshot() []*consoleSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]*consoleSession, 0, len(c.m))
	for _, cs := range c.m {
		out = append(out, cs)
	}
	return out
}

// pruneExpired drops tokens that were never used.
func (c *consoleRegistry) pruneExpired(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, cs := range c.m {
		if !cs.used && !now.Before(cs.expires) {
			delete(c.m, id)
		}
	}
}

// ---- permission checks --------------------------------------------------------

// remoteTarget is a validated console / power target.
type remoteTarget struct {
	st   *model.ServerState
	g    proto.PlatformGuest
	gid  string
	conn *AgentConn
}

// Capabilities checked by remotePrecheck.
const (
	needConsole   = "console"
	needPower     = "power"
	needHostShell = "host_shell"
	needHostPower = "host_power"
	needManage    = "manage"    // operator; the admin-only operations check the role themselves
	needUpdates   = "updates"   // the waiting package updates: diagnose or console
	needSnapshots = "snapshots" // listing a guest's snapshots: power or manage
	// A Mac's screen: the host shell switches (driving the signed-in
	// desktop is as powerful as a root shell); the routes check the role
	// per step. Its status also with the diagnose switches.
	needScreen       = "screen"
	needScreenStatus = "screen_status"
)

// remotePrecheck checks role, the hub toggle, the agent's local flag, the
// agent connection and the guest (gid model.HostGuestID: the host itself).
// need is one of the need* capabilities.
func (h *Hub) remotePrecheck(p *principal, serverID, gid, need string) (remoteTarget, *apiError) {
	var t remoteTarget
	t.gid = gid
	if p.rank() < store.RoleRank(operator) {
		return t, apiErr(http.StatusForbidden, "insufficient_role", model.ReasonRole+".")
	}
	if (need == needHostShell || need == needHostPower) && p.rank() < store.RoleRank(admin) {
		return t, apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+".")
	}
	st, ok := h.snapshotOne(serverID)
	if !ok {
		return t, apiErr(http.StatusNotFound, "server_not_found", "No such server.")
	}
	t.st = st
	var pol proto.Policy
	if st.Report != nil {
		pol = st.Report.Policy
	}
	switch need {
	case needPower:
		if !st.RCPower {
			return t, apiErr(http.StatusForbidden, "power_disabled", model.ReasonHubPower+".")
		}
		if !pol.Power {
			return t, apiErr(http.StatusForbidden, "power_disabled", model.ReasonAgentPower+".")
		}
	case needHostShell:
		if !st.RCHostShell {
			return t, apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonHubShell+".")
		}
		if !pol.HostShell {
			return t, apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonAgentShell+".")
		}
	case needHostPower:
		if !st.RCHostPower {
			return t, apiErr(http.StatusForbidden, "host_power_disabled", model.ReasonHubHostPow+".")
		}
		if !pol.HostPower {
			return t, apiErr(http.StatusForbidden, "host_power_disabled", model.ReasonAgentHPow+".")
		}
	case needScreen, needScreenStatus:
		if need == needScreenStatus && st.RCDiagnose && pol.Diagnose {
			break
		}
		if !st.RCHostShell {
			return t, apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonHubShell+".")
		}
		if !pol.HostShell {
			return t, apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonAgentShell+".")
		}
	case needDiagnose:
		if !st.RCDiagnose {
			return t, apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonHubDiag+".")
		}
		if !pol.Diagnose {
			return t, apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonAgentDiag+".")
		}
	case needSnapshots:
		// Snapshots are taken and restored under power; managing guests
		// lists them too.
		if !(st.RCPower && pol.Power) && !(st.RCManage && pol.Manage) {
			if !st.RCPower && !st.RCManage {
				return t, apiErr(http.StatusForbidden, "power_disabled", model.ReasonHubSnaps+".")
			}
			return t, apiErr(http.StatusForbidden, "power_disabled", model.ReasonAgentSnaps+".")
		}
	case needUpdates:
		// The waiting updates: a read-only check's answer, so diagnose or
		// console (SWU-11).
		if !(st.RCDiagnose && pol.Diagnose) && !(st.RCConsole && pol.Console) {
			if !st.RCDiagnose && !st.RCConsole {
				return t, apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonHubDiag+".")
			}
			return t, apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonAgentDiag+".")
		}
	case needManage:
		if !st.RCManage {
			return t, apiErr(http.StatusForbidden, "manage_disabled", model.ReasonHubManage+".")
		}
		if !pol.Manage {
			return t, apiErr(http.StatusForbidden, "manage_disabled", model.ReasonAgentMgmt+".")
		}
	default:
		if !st.RCConsole {
			return t, apiErr(http.StatusForbidden, "console_disabled", model.ReasonHubConsole+".")
		}
		if !pol.Console {
			return t, apiErr(http.StatusForbidden, "console_disabled", model.ReasonAgent+".")
		}
	}
	t.conn = h.conn(serverID)
	if t.conn == nil || !st.Online(h.now()) {
		return t, apiErr(http.StatusConflict, "agent_offline", "The agent of this server is not connected.")
	}
	if gid == model.HostGuestID {
		t.g = hostGuest(st)
		return t, nil
	}
	g, ok := findGuest(st, gid)
	if !ok && need == needManage {
		// Proxmox templates are not in the guest list but can be cloned,
		// changed and deleted.
		g, ok = findTemplate(st, gid)
	}
	if !ok {
		return t, errGuestNotFound
	}
	t.g = g
	return t, nil
}

// hostGuest is the host itself as a console / action target: its journal
// (needs console), a root shell (needs host shell) and, on a Mac whose
// Screen Sharing answers and whose screen account is set, its screen
// (needs host shell; then the default).
func hostGuest(st *model.ServerState) proto.PlatformGuest {
	protos := []string{proto.ProtoLogs}
	def := proto.ProtoLogs
	if st.RCHostShell && st.Report != nil && st.Report.Policy.HostShell {
		protos = append(protos, proto.ProtoShell)
		if m := st.Report.MacOS; m != nil && m.Screen.Sharing && m.Screen.Account != "" {
			protos = append(protos, proto.ProtoVNC)
			def = proto.ProtoVNC
		}
	}
	return proto.PlatformGuest{Platform: proto.PlatformHost, Guest: &proto.Guest{ID: "host", Name: st.Hostname, Kind: "host",
		State: proto.StateRunning, Console: proto.ConsoleCaps{Protocols: protos, Default: def}}}
}

// deny audits a refused request (throttled per user/server/event so a
// misbehaving client cannot flood the log) and counts it for throttling.
func (h *Hub) deny(r *http.Request, p *principal, event, server, gid, protocol string, e *apiError, details map[string]string) *apiError {
	platform, _, _ := model.SplitGuestID(gid)
	key := p.key() + "|" + server + "|" + event + "|" + e.Code
	// Polled views (thumbnails, manage reads such as a task's progress)
	// record a refusal once per 10 minutes.
	polled := event == "screens.thumbnail" || event == "manage.denied"
	if !polled || h.limits.auditThr.take(key) {
		ev := event
		if ev == "screens.thumbnail" {
			ev = "screens.viewed"
		}
		h.auditReq(r, p, store.AuditRecord{Event: ev, Outcome: "denied", Code: e.Code, Server: server, Guest: gid,
			Platform: platform, Protocol: protocol, Details: details})
	}
	// Only authorization failures count toward throttling (not an offline
	// agent or a stopped guest, and never the Screens wall's polling).
	switch e.Code {
	case "insufficient_role", "console_disabled", "power_disabled", "manage_disabled", "diagnose_disabled":
		if !polled {
			h.limits.denied.fail(p.key())
		}
	}
	return e
}

// throttled reports whether a user made too many denied requests.
func (h *Hub) throttled(p *principal) bool { return !h.limits.denied.allow(p.key()) }

// ---- POST /servers/{id}/guests/{guestId}/console-sessions ---------------------

func (h *Hub) apiCreateConsole(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, gid := r.PathValue("id"), r.PathValue("guestId")
	var req struct {
		Protocol   string `json:"protocol"`
		SwitchFrom string `json:"switch_from"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
	}
	// Consoles belong to a browser session, or to an actor of the service
	// token (they are re-authorized against it every few seconds): API
	// tokens and kiosk sessions get none.
	if p.token != nil || p.session.Kiosk {
		return apiErr(http.StatusForbidden, "browser_only", "Consoles need a signed-in browser session; API tokens and kiosk links cannot open them.")
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	if gid == "" {
		gid = model.HostGuestID // POST /servers/{id}/console-sessions: the host itself
	}
	deny := func(e *apiError) error { return h.deny(r, p, "console.denied", serverID, gid, req.Protocol, e, nil) }
	if e := h.consoleTransport(r); e != nil {
		return deny(e)
	}
	if gid == model.HostGuestID && req.Protocol == "" {
		if st, ok := h.snapshotOne(serverID); ok {
			req.Protocol = hostGuest(st).Console.Default // a Mac's screen when it has one
		}
	}
	need := needConsole
	if gid == model.HostGuestID && (req.Protocol == proto.ProtoShell || req.Protocol == proto.ProtoVNC) {
		// A root shell on the host, or a Mac's signed-in screen: the host
		// shell switches, admins only, and a recent sign-in.
		need = needHostShell
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	t, e := h.remotePrecheck(p, serverID, gid, need)
	if e != nil {
		return deny(e)
	}
	g := t.g
	if len(g.Console.Protocols) == 0 {
		return deny(apiErr(http.StatusConflict, "console_unavailable", "This guest has no console."))
	}
	protocol := req.Protocol
	if protocol == "" {
		protocol = g.Console.Default
		if protocol == "" || !slices.Contains(g.Console.Protocols, protocol) {
			protocol = g.Console.Protocols[0]
		}
	}
	if !slices.Contains(g.Console.Protocols, protocol) {
		msg := "This guest does not offer " + protocol + "."
		if why, ok := g.Console.Unavailable[protocol]; ok && why != "" {
			msg = why
		}
		return deny(apiErr(http.StatusConflict, "protocol_unavailable", msg))
	}
	req.Protocol = protocol
	if g.State == proto.StateStopped && protocol != proto.ProtoLogs { // logs of a stopped container are readable
		return deny(apiErr(http.StatusConflict, "guest_not_running", "The guest is powered off."))
	}
	// Limit check and registration are atomic.
	h.consoleCreateMu.Lock()
	defer h.consoleCreateMu.Unlock()
	now := h.now()
	// The session being switched away from (side list) does not count; only
	// the caller's own session can be named.
	var old *consoleSession
	if req.SwitchFrom != "" {
		if o := h.consoles.get(req.SwitchFrom); o != nil && o.userID == p.user.ID {
			old = o
		}
	}
	notOld := func(cs *consoleSession) bool { return cs != old }
	limitErr := apiErr(http.StatusTooManyRequests, "session_limit", "Too many open consoles. Close one and try again.")
	if h.consoles.count(now, func(cs *consoleSession) bool { return notOld(cs) && cs.userID == p.user.ID }) >= h.cfg.ConsolePerUser ||
		h.consoles.count(now, func(cs *consoleSession) bool { return notOld(cs) && cs.server == serverID }) >= h.cfg.ConsolePerServer ||
		h.consoles.count(now, func(cs *consoleSession) bool {
			return notOld(cs) && (cs.agent.Load() == t.conn || (!cs.used && cs.server == serverID))
		}) >= h.cfg.ConsolePerAgent {
		return deny(limitErr)
	}
	// Fail closed: no audit store, no console.
	if err := h.store.Ping(r.Context()); err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; consoles are disabled.")
	}
	token := randToken(32) // 256 bits
	cs := &consoleSession{
		id: newID("cs_"), tokenHash: sha(token), userID: p.user.ID, username: p.user.Username, role: p.user.Role,
		sessionHash: string(p.tokenHsh), service: p.service != nil, server: serverID, platform: g.Platform, guestID: g.ID, guest: gid,
		protocol: protocol, clientIP: clientIP(r), userAgent: cleanText(r.UserAgent(), 256), created: now,
		expires: now.Add(h.cfg.ConsoleTokenTTL), closeCh: make(chan struct{}),
	}
	if _, err := h.auditReq(r, p, store.AuditRecord{Event: "console.requested", Outcome: "ok", Server: serverID, Guest: gid,
		Platform: g.Platform, Protocol: protocol, Details: map[string]string{"session_id": cs.id}}); err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; consoles are disabled.")
	}
	if old != nil {
		h.auditReq(r, p, store.AuditRecord{Event: "console.switched", Outcome: "ok", Server: serverID, Guest: gid,
			Platform: g.Platform, Protocol: protocol,
			Details: map[string]string{"from_session_id": old.id, "from_guest": old.guest, "session_id": cs.id}})
		h.consoles.closeWhere(func(x *consoleSession) bool { return x == old }, reasonSwitched)
	}
	h.consoles.add(cs)
	writeJSON(w, r, http.StatusCreated, map[string]any{
		"session_id": cs.id, "url": "/api/v1/console/" + cs.id, "token": token, "protocol": protocol,
		"expires_at": cs.expires.UTC().Format(time.RFC3339), "idle_timeout_s": int(h.cfg.ConsoleIdleTimeout / time.Second),
		"requires_confirmation": false,
	})
	return nil
}

// subprotocolToken extracts the token from Sec-WebSocket-Protocol and
// checks that the console subprotocol is offered.
func subprotocolToken(r *http.Request) (token string, ok bool) {
	var hasConsole bool
	for _, hv := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(hv, ",") {
			p = strings.TrimSpace(p)
			switch {
			case p == ConsoleSubprotocol:
				hasConsole = true
			case strings.HasPrefix(p, TokenSubprotoPfx):
				token = strings.TrimPrefix(p, TokenSubprotoPfx)
			}
		}
	}
	return token, hasConsole && token != ""
}

// ---- GET /console/{sid} (WebSocket) ----------------------------------------------

// errInsecureConsole refuses consoles over plain HTTP: they carry
// keystrokes (passwords typed into guests) and screens.
var errInsecureConsole = apiErr(http.StatusForbidden, "insecure_transport",
	"Consoles need HTTPS. Serve the hub over HTTPS (--tls-cert or a TLS proxy such as tailscale serve) or start it with --insecure-consoles.")

// consoleTransport refuses a console request that did not arrive over
// HTTPS (unless --insecure-consoles, or on localhost).
func (h *Hub) consoleTransport(r *http.Request) *apiError {
	if h.cfg.InsecureConsoles || h.secureTransport(r) {
		return nil
	}
	return errInsecureConsole
}

func (h *Hub) apiConsoleWS(w http.ResponseWriter, r *http.Request, p *principal) error {
	sid := r.PathValue("sid")
	if e := h.consoleTransport(r); e != nil {
		return e
	}
	// Browsers must send an allowed Origin (cross-site WebSocket hijacking);
	// the Whombat server checks its browsers' origins itself and proxies.
	if p.service == nil && !h.originAllowed(r, r.Header.Get("Origin")) {
		h.auditReq(r, p, store.AuditRecord{Event: "console.denied", Outcome: "denied", Code: "bad_origin",
			Details: map[string]string{"session_id": cleanText(sid, 64)}})
		return apiErr(http.StatusForbidden, "bad_origin", "Cross-origin WebSocket refused.")
	}
	token, ok := subprotocolToken(r)
	if !ok {
		return apiErr(http.StatusBadRequest, "subprotocol", "Use the subprotocols "+ConsoleSubprotocol+" and "+TokenSubprotoPfx+"<token>.")
	}
	now := h.now()
	cs, e := h.consoles.claim(sid, token, p.user.ID, p.tokenHsh, now)
	if e != nil {
		h.auditReq(r, p, store.AuditRecord{Event: "console.denied", Outcome: "denied", Code: e.Code,
			Details: map[string]string{"session_id": cleanText(sid, 64)}})
		return e
	}
	// Re-authorize at upgrade time.
	t, pe := h.remotePrecheck(p, cs.server, cs.guest, cs.need())
	if pe != nil {
		h.consoles.remove(cs.id)
		return h.deny(r, p, "console.denied", cs.server, cs.guest, cs.protocol, pe, map[string]string{"session_id": cs.id})
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{ConsoleSubprotocol},
		InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		h.consoles.remove(cs.id)
		return nil
	}
	h.runConsole(r, p, cs, t, c)
	return nil
}

func sendControl(ctx context.Context, c *websocket.Conn, cc wire.ConsoleControl) error {
	b, _ := json.Marshal(cc)
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageBinary, wire.EncodeWS(wire.Frame{Kind: wire.FrameControl, Payload: b}))
}

// byteLimiter is a token bucket (bytes per second); single goroutine use.
type byteLimiter struct {
	rate, burst, tokens float64
	last                time.Time
}

func newByteLimiter(rate, burst float64) *byteLimiter {
	return &byteLimiter{rate: rate, burst: burst, tokens: burst, last: time.Now()}
}

func (l *byteLimiter) wait(ctx context.Context, n int) error {
	now := time.Now()
	l.tokens = min(l.burst, l.tokens+now.Sub(l.last).Seconds()*l.rate)
	l.last = now
	l.tokens -= float64(n)
	if l.tokens >= 0 {
		return nil
	}
	d := time.Duration(-l.tokens / l.rate * float64(time.Second))
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// Per-session bandwidth caps.
const (
	consoleInRate   = 4 << 20 // browser -> agent, bytes/s
	consoleInBurst  = 2 << 20
	consoleOutRate  = 32 << 20 // agent -> browser, bytes/s
	consoleOutBurst = 8 << 20
)

// runConsole relays one session until either side closes or the hub ends it.
func (h *Hub) runConsole(r *http.Request, p *principal, cs *consoleSession, t remoteTarget, c *websocket.Conn) {
	h.consolesLive.Add(1)
	defer h.consolesLive.Add(-1)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c.SetReadLimit(wire.MaxFramePayload + 64)
	cs.agent.Store(t.conn)
	cs.lastActivity.Store(time.Now().UnixNano())

	// end records why the session ends and wakes the main loop, which does
	// the orderly shutdown (ctx is cancelled only afterwards: cancelling a
	// pending WebSocket Read closes the socket without the "closed" frame).
	var reasonOnce sync.Once
	var reason string
	done := make(chan struct{})
	end := func(why string) {
		reasonOnce.Do(func() {
			reason = why
			close(done)
		})
	}

	st, resp, release, err := t.conn.OpenConsole(ctx, proto.ConsoleRequest{SessionID: cs.id, Platform: cs.platform,
		GuestID: cs.guestID, Protocol: cs.protocol})
	auditBase := store.AuditRecord{Server: cs.server, Guest: cs.guest, Platform: cs.platform, Protocol: cs.protocol}
	fail := func(code, msg string) {
		rec := auditBase
		rec.Event, rec.Outcome, rec.Code = "console.opened", "error", code
		rec.Details = map[string]string{"session_id": cs.id}
		h.auditReq(r, p, rec)
		_ = sendControl(ctx, c, wire.ConsoleControl{Type: "error", Code: code, Message: msg})
		c.Close(websocket.StatusNormalClosure, code)
		h.consoles.remove(cs.id)
	}
	if err != nil {
		code := "agent_error"
		if errors.Is(err, ErrConsoleLimit) {
			code = "session_limit"
		}
		fail(code, "The agent could not open the console.")
		return
	}
	if !resp.OK {
		code := resp.Code
		if code == "" {
			code = "agent_error"
		}
		fail(code, resp.Message)
		return
	}
	defer release()
	opened := time.Now()
	cs.opened.Store(opened.UnixNano())
	rec := auditBase
	rec.Event, rec.Outcome = "console.opened", "ok"
	rec.Details = map[string]string{"session_id": cs.id}
	if resp.Resolution != "" {
		rec.Details["resolution"] = resp.Resolution
	}
	if _, err := h.auditReq(r, p, rec); err != nil {
		st.Close()
		fail("audit_unavailable", "The audit log is unavailable.")
		return
	}
	h.log.Info("console opened", "session", cs.id, "server", cs.server, "guest", cs.guest, "protocol", cs.protocol, "user", p.user.Username)
	_ = sendControl(ctx, c, wire.ConsoleControl{Type: "status", State: "connected", Protocol: cs.protocol, Resolution: resp.Resolution})

	var wg sync.WaitGroup
	// Browser -> agent.
	wg.Add(1)
	go func() {
		defer wg.Done()
		fw := wire.NewFrameWriter(st)
		lim := newByteLimiter(consoleInRate, consoleInBurst)
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				end(reasonClient)
				return
			}
			if typ != websocket.MessageBinary {
				continue
			}
			f, err := wire.DecodeWS(data)
			if err != nil {
				continue
			}
			switch f.Kind {
			case wire.FrameControl:
				var cc wire.ConsoleControl
				if json.Unmarshal(f.Payload, &cc) != nil {
					continue
				}
				switch cc.Type {
				case "activity":
					cs.lastActivity.Store(time.Now().UnixNano())
					continue
				case "resize":
					cc = wire.ConsoleControl{Type: "resize", Cols: clampInt(cc.Cols, 1, 1000), Rows: clampInt(cc.Rows, 1, 1000)}
				case "open", "close":
					cc = wire.ConsoleControl{Type: cc.Type, Channel: cc.Channel}
				case "ping":
					cc = wire.ConsoleControl{Type: "ping", ID: cc.ID}
				default:
					continue
				}
				b, _ := json.Marshal(cc)
				f = wire.Frame{Kind: wire.FrameControl, Payload: b}
			case wire.FrameData:
				if err := lim.wait(ctx, len(f.Payload)); err != nil {
					return
				}
				cs.bytesIn.Add(int64(len(f.Payload)))
			default:
				continue
			}
			_ = st.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if err := fw.Write(f); err != nil {
				end(reasonAgentGone)
				return
			}
		}
	}()
	// Agent -> browser.
	wg.Add(1)
	go func() {
		defer wg.Done()
		fr := wire.NewFrameReader(st)
		lim := newByteLimiter(consoleOutRate, consoleOutBurst)
		for {
			f, err := fr.Read()
			if err != nil {
				if errors.Is(err, yamux.ErrSessionShutdown) || errors.Is(err, yamux.ErrConnectionReset) {
					end(reasonAgentGone)
				} else {
					end(reasonEnded)
				}
				return
			}
			switch f.Kind {
			case wire.FrameControl:
				var cc wire.ConsoleControl
				if json.Unmarshal(f.Payload, &cc) != nil {
					continue
				}
				switch cc.Type {
				case "status", "opened", "closed", "pong", "error":
				default:
					continue
				}
				cc.Code, cc.Message, cc.State = cleanText(cc.Code, 64), cleanText(cc.Message, 512), cleanText(cc.State, 32)
				cc.Protocol, cc.Resolution, cc.Reason = cleanText(cc.Protocol, 16), cleanText(cc.Resolution, 32), cleanText(cc.Reason, 64)
				b, _ := json.Marshal(cc)
				f.Payload, f.Channel = b, 0
			case wire.FrameData:
				if err := lim.wait(ctx, len(f.Payload)); err != nil {
					return
				}
				cs.bytesOut.Add(int64(len(f.Payload)))
			default:
				continue
			}
			wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
			err = c.Write(wctx, websocket.MessageBinary, wire.EncodeWS(f))
			wcancel()
			if err != nil {
				end(reasonClient)
				return
			}
		}
	}()
	// Timers and hub-initiated closes.
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	maxAge := time.NewTimer(h.cfg.ConsoleMaxAge)
	defer maxAge.Stop()
loop:
	for {
		select {
		case <-done:
			break loop
		case <-ctx.Done():
			end(reasonClient)
			break loop
		case <-cs.closeCh:
			end(cs.closeReason())
			break loop
		case <-maxAge.C:
			end(reasonMaxAge)
			break loop
		case <-tick.C:
			if time.Since(time.Unix(0, cs.lastActivity.Load())) >= h.cfg.ConsoleIdleTimeout {
				end(reasonIdle)
				break loop
			}
		}
	}
	// Tell the browser why (before cancelling ctx: cancelling a pending
	// Read closes the WebSocket), then tear everything down.
	st.Close()
	_ = st.SetReadDeadline(time.Now()) // Close is a half-close: wake the reader now
	closeMsg := ""
	if reason != reasonClient {
		_ = sendControl(context.Background(), c, wire.ConsoleControl{Type: "closed", Reason: reason})
		closeMsg = reason
	}
	// Close handshake (waits at most 5 s for an unresponsive browser).
	c.Close(websocket.StatusNormalClosure, closeMsg)
	cancel()
	wg.Wait()
	h.consoles.remove(cs.id)
	dur := time.Since(opened).Seconds()
	dur = float64(int64(dur*10)) / 10
	bi, bo := cs.bytesIn.Load(), cs.bytesOut.Load()
	crec := auditBase
	crec.Event, crec.Outcome, crec.Code = "console.closed", "ok", reason
	crec.DurationS, crec.BytesIn, crec.BytesOut = &dur, &bi, &bo
	crec.Details = map[string]string{"session_id": cs.id}
	cs.reasonMu.Lock()
	if cs.closedBy != "" {
		crec.Details["closed_by"] = cs.closedBy
	}
	cs.reasonMu.Unlock()
	crec.User, crec.Role, crec.ClientIP, crec.UserAgent = cs.username, cs.role, cs.clientIP, cs.userAgent
	_, _ = h.audit(context.Background(), crec)
	h.log.Info("console closed", "session", cs.id, "server", cs.server, "guest", cs.guest, "reason", reason,
		"duration_s", dur, "bytes_in", bi, "bytes_out", bo)
	h.bus.PublishTo(cs.userID, "console.closed", map[string]string{"session_id": cs.id, "reason": reason})
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// reauthorizeConsoles re-checks every live session (role, toggles, agent
// policy, agent connection, browser session) and drops expired tokens.
func (h *Hub) reauthorizeConsoles(ctx context.Context) {
	if h.svc != nil {
		h.svc.refresh() // a rotated service token ends the consoles opened with the old one
	}
	now := h.now()
	h.consoles.pruneExpired(now)
	for _, cs := range h.consoles.snapshot() {
		h.consoles.mu.Lock()
		live := cs.live
		h.consoles.mu.Unlock()
		if !live {
			continue
		}
		reason := ""
		h.mu.RLock()
		s, ok := h.servers[cs.server]
		switch {
		case !ok:
			reason = reasonRevoked
		case cs.need() == needHostShell && (!s.meta.RCHostShell || s.report == nil || !s.report.Policy.HostShell):
			reason = reasonRCDisabled
		case cs.need() == needConsole && (!s.meta.RCConsole || s.report == nil || !s.report.Policy.Console):
			reason = reasonRCDisabled
		case cs.agent.Load() != nil && s.conn != cs.agent.Load():
			reason = reasonAgentGone
		}
		h.mu.RUnlock()
		minRole := operator
		if cs.need() == needHostShell {
			minRole = admin
		}
		switch {
		case reason != "":
		case cs.service:
			// The service token must still be the one in the file; the
			// actor's role came with the request that created the console.
			if h.svc == nil || !h.svc.current([]byte(cs.sessionHash)) || store.RoleRank(cs.role) < store.RoleRank(minRole) {
				reason = reasonRevoked
			}
		default:
			se, err := h.store.GetSession(ctx, []byte(cs.sessionHash))
			if errors.Is(err, store.ErrNotFound) || (err == nil && !now.Before(se.ExpiresAt)) {
				reason = reasonRevoked
			} else if err == nil {
				if u, err := h.store.GetUser(ctx, se.UserID); err != nil || store.RoleRank(u.Role) < store.RoleRank(minRole) {
					reason = reasonRevoked
				}
			}
		}
		if reason != "" {
			cs.close(reason)
		}
	}
}

// ---- admin listing / closing ----------------------------------------------------------

func (h *Hub) apiListConsoles(w http.ResponseWriter, r *http.Request, p *principal) error {
	server := r.URL.Query().Get("server")
	out := []map[string]any{}
	for _, cs := range h.consoles.snapshot() {
		h.consoles.mu.Lock()
		live := cs.live
		h.consoles.mu.Unlock()
		if !live || (server != "" && cs.server != server) {
			continue
		}
		out = append(out, map[string]any{"session_id": cs.id, "server": cs.server, "guest": cs.guest, "protocol": cs.protocol,
			"user": cs.username, "client_ip": cs.clientIP, "opened_at": tsp(time.Unix(0, cs.opened.Load())),
			"bytes_in": cs.bytesIn.Load(), "bytes_out": cs.bytesOut.Load()})
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) apiDeleteConsole(w http.ResponseWriter, r *http.Request, p *principal) error {
	cs := h.consoles.get(r.PathValue("sid"))
	if cs == nil || (cs.userID != p.user.ID && p.rank() < store.RoleRank(admin)) {
		return errNotFound
	}
	h.consoles.mu.Lock()
	unused := !cs.used
	h.consoles.mu.Unlock()
	if cs.userID != p.user.ID {
		cs.setClosedBy(p.user.Username)
	}
	h.consoles.closeWhere(func(x *consoleSession) bool { return x == cs }, reasonRevoked)
	if unused {
		// The token was never redeemed, so no relay will write the closing
		// record: close the console.requested record here.
		h.auditReq(r, p, store.AuditRecord{Event: "console.closed", Outcome: "ok", Code: "cancelled", Server: cs.server,
			Guest: cs.guest, Platform: cs.platform, Protocol: cs.protocol, Details: map[string]string{"session_id": cs.id}})
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
