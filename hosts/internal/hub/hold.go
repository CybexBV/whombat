package hub

import (
	"context"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"time"

	"rackoon/internal/hub/store"
)

// When the hub itself is the problem (its address changed, most agents
// dropped at once, or a planned move), every server at once looking
// unreachable is one event, not one alert per server. The hub then holds
// the servers' "isn't checking in" alerts for a while ("reconnecting",
// GET /hub) and lets them open afterwards for any server that didn't come
// back.

// Why the hub is reconnecting (GET /hub reconnecting.reason).
const (
	holdAddressChanged = "address_changed"
	holdManyDropped    = "many_dropped"
	holdMove           = "move"
)

// dropWindow is how close together the drops of many_dropped are, and how
// long before a hold a drop still counts as part of it.
const dropWindow = 30 * time.Second

// dropMinConnected is how many agents must have been connected for their
// dropping together to say something about the hub.
const dropMinConnected = 3

// reconnectHold is the hold, if one is open.
type reconnectHold struct {
	mu     sync.Mutex
	open   bool
	since  time.Time // the first start
	until  time.Time
	reason string // the first trigger's
	// covered are the servers whose alerts are held: each counts as back
	// once connected, through a connection made at or after its time
	// (zero: any connection).
	covered map[string]time.Time
	// drops are the servers whose connection dropped in the last
	// dropWindow, with when.
	drops map[string]time.Time
}

// holdConn is what the hold needs to know about a server's connection.
type holdConn struct {
	connected   bool
	connectedAt time.Time
}

// holdView is GET /hub's reconnecting.
type holdView struct {
	Since   time.Time
	Until   time.Time
	Reason  string
	Waiting int
}

func (r *reconnectHold) pruneDrops(now time.Time) {
	for id, at := range r.drops {
		if now.Sub(at) > dropWindow {
			delete(r.drops, id)
		}
	}
}

// activeLocked: a hold is open and not past its end.
func (r *reconnectHold) activeLocked(now time.Time) bool {
	return r.open && now.Before(r.until)
}

// trigger opens a hold, or extends the open one (by holdFor from now, never
// beyond holdMax from its first start). connected are the servers
// connected now, rejoin those that must reconnect to count as back (their
// connection goes through an address that is gone, or they were asked to
// move). It reports whether a hold was opened.
func (r *reconnectHold) trigger(reason string, now time.Time, holdFor, holdMax time.Duration, connected, rejoin []string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneDrops(now)
	opened := false
	if r.activeLocked(now) {
		r.until = minTime(now.Add(holdFor), r.since.Add(holdMax))
	} else {
		r.open, r.since, r.until, r.reason, opened = true, now, now.Add(holdFor), reason, true
		r.covered = map[string]time.Time{}
	}
	for _, id := range connected {
		if _, ok := r.covered[id]; !ok {
			r.covered[id] = time.Time{}
		}
	}
	// Servers that dropped just before are part of it.
	for id := range r.drops {
		if _, ok := r.covered[id]; !ok {
			r.covered[id] = time.Time{}
		}
	}
	for _, id := range rejoin {
		r.covered[id] = now
	}
	return opened
}

// noteDrop records a server whose connection dropped; connected are the
// servers connected after it. A server dropping inside a hold is covered
// by it. It reports whether the drops now say the hub is the problem: at
// least dropMinConnected agents were connected in the last dropWindow and
// two thirds of them dropped.
func (r *reconnectHold) noteDrop(id string, now time.Time, connected []string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.drops == nil {
		r.drops = map[string]time.Time{}
	}
	r.pruneDrops(now)
	r.drops[id] = now
	if r.activeLocked(now) {
		if _, ok := r.covered[id]; !ok {
			r.covered[id] = time.Time{}
		}
	}
	were := len(r.drops)
	for _, c := range connected {
		if _, ok := r.drops[c]; !ok {
			were++
		}
	}
	return were >= dropMinConnected && 3*len(r.drops) >= 2*were
}

// covers reports whether the server's heartbeat alert is held now.
func (r *reconnectHold) covers(id string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.activeLocked(now) {
		return false
	}
	_, ok := r.covered[id]
	return ok
}

// waitingLocked counts the covered servers not back yet.
func (r *reconnectHold) waitingLocked(conns map[string]holdConn) int {
	n := 0
	for id, after := range r.covered {
		c, ok := conns[id]
		if !ok {
			continue // deleted
		}
		if !c.connected || c.connectedAt.Before(after) {
			n++
		}
	}
	return n
}

// settle ends the hold when its time is up or every server it covers is
// back; it reports whether it ended.
func (r *reconnectHold) settle(now time.Time, conns map[string]holdConn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.open {
		return false
	}
	if now.Before(r.until) && r.waitingLocked(conns) > 0 {
		return false
	}
	r.open, r.covered = false, nil
	return true
}

// view is the open hold (ok false: none).
func (r *reconnectHold) view(now time.Time, conns map[string]holdConn) (holdView, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.activeLocked(now) {
		return holdView{}, false
	}
	return holdView{Since: r.since, Until: r.until, Reason: r.reason, Waiting: r.waitingLocked(conns)}, true
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// ---- the hub's side ---------------------------------------------------------------

// holdConns is every server's connection as the hold sees it.
func (h *Hub) holdConns() map[string]holdConn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[string]holdConn, len(h.servers))
	for id, s := range h.servers {
		c := holdConn{connected: s.conn != nil}
		if s.conn != nil {
			c.connectedAt = s.conn.connectedAt
		}
		out[id] = c
	}
	return out
}

// connectedServers lists the servers with a connection, and the
// connections.
func (h *Hub) connectedServers() ([]string, []*AgentConn) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var ids []string
	var conns []*AgentConn
	for id, s := range h.servers {
		if s.conn != nil {
			ids = append(ids, id)
			conns = append(conns, s.conn)
		}
	}
	return ids, conns
}

// startHold opens (or extends) the hold; rejoin must reconnect to count as
// back. A new hold is logged and audited once.
func (h *Hub) startHold(ctx context.Context, reason string, rejoin []string) {
	if h.closing.Load() {
		return
	}
	now := h.now()
	ids, _ := h.connectedServers()
	if !h.hold.trigger(reason, now, h.cfg.ReconnectHold, h.cfg.ReconnectHoldMax, ids, rejoin) {
		return
	}
	h.log.Warn("the hub is reconnecting to its servers; their alerts wait", "reason", reason,
		"until", now.Add(h.cfg.ReconnectHold).UTC().Format(time.RFC3339))
	h.auditSystem(ctx, store.AuditRecord{Event: "hub.reconnecting", Outcome: "ok", User: "system",
		Details: map[string]string{"reason": reason}})
}

// noteDrop is called when an agent's live connection ended.
func (h *Hub) noteDrop(id string) {
	if h.closing.Load() {
		return
	}
	ids, _ := h.connectedServers()
	if h.hold.noteDrop(id, h.now(), ids) {
		h.startHold(context.Background(), holdManyDropped, nil)
	}
}

// settleHold ends a hold that is over (the watchdog).
func (h *Hub) settleHold() {
	if h.hold.settle(h.now(), h.holdConns()) {
		h.log.Info("the hub is done reconnecting to its servers")
	}
}

// heartbeatHeld: the server's heartbeat alert waits for the hold.
func (h *Hub) heartbeatHeld(id string) bool { return h.hold.covers(id, h.now()) }

// reconnectingJSON is GET /hub's reconnecting (nil: no hold).
func (h *Hub) reconnectingJSON() any {
	v, ok := h.hold.view(h.now(), h.holdConns())
	if !ok {
		return nil
	}
	return map[string]any{"since": v.Since.UTC().Format(time.RFC3339), "until": v.Until.UTC().Format(time.RFC3339),
		"reason": v.Reason, "waiting": v.Waiting}
}

// addrsChanged opens a hold when the hub's address list lost an address or
// its first one (the agents' URL) changed. An address that only appeared
// can't have cut anyone off. Servers connected through an address that is
// gone must reconnect to count as back.
func (h *Hub) addrsChanged(ctx context.Context, old, cur []string) {
	if len(old) == 0 {
		return
	}
	var gone []string
	for _, u := range old {
		if !slices.Contains(cur, u) {
			gone = append(gone, u)
		}
	}
	if len(gone) == 0 && (len(cur) == 0 || cur[0] == old[0]) {
		return
	}
	goneIPs := map[netip.Addr]bool{}
	for _, u := range gone {
		if a, ok := urlAddr(u); ok {
			goneIPs[a.Addr()] = true
		}
	}
	_, conns := h.connectedServers()
	var rejoin []string
	for _, c := range conns {
		if c.via.IsValid() && goneIPs[c.via.Addr()] {
			rejoin = append(rejoin, c.ServerID)
		}
	}
	h.startHold(ctx, holdAddressChanged, rejoin)
}

// urlAddr is the IP address and port of a wss URL whose host is an IP.
func urlAddr(s string) (netip.AddrPort, bool) {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "wss" {
		return netip.AddrPort{}, false
	}
	a, err := netip.ParseAddr(u.Hostname())
	if err != nil {
		return netip.AddrPort{}, false
	}
	port := 443
	if p := u.Port(); p != "" {
		if port, err = strconv.Atoi(p); err != nil || port < 1 || port > 65535 {
			return netip.AddrPort{}, false
		}
	}
	return netip.AddrPortFrom(a.Unmap().WithZone(""), uint16(port)), true
}
