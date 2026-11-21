package hub

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/netaddrs"
	"rackoon/internal/proto"
)

// The hub's addresses (HS-170…HS-172): every agent learns where else it may
// reach the agent listener (HelloAck.Addrs, then hub_addrs when the list
// changes), and the hub remembers the agents' address it had before a
// change (GET /hub agent_url_previous) so Whombat can tell when servers
// haven't followed it (BF-16).

// Meta keys.
const (
	metaAgentURL          = "agent_url"
	metaAgentURLPrevious  = "agent_url_previous"
	metaAgentURLChangedAt = "agent_url_changed_at"
)

// maxHubAddrs bounds the list an agent is told.
const maxHubAddrs = 16

// addrInterval is how often the hub looks at its addresses.
const addrInterval = 30 * time.Second

// addrState is the hub's address list and its recorded agents' address.
type addrState struct {
	mu        sync.Mutex
	list      []string
	agentURL  string // meta agent_url
	previous  string
	changedAt time.Time
}

// loadAddrState reads the recorded agents' address from meta.
func (h *Hub) loadAddrState(ctx context.Context) error {
	cur, _, err := h.store.GetMeta(ctx, metaAgentURL)
	if err != nil {
		return err
	}
	prev, _, _ := h.store.GetMeta(ctx, metaAgentURLPrevious)
	at, _, _ := h.store.GetMeta(ctx, metaAgentURLChangedAt)
	h.addrs.mu.Lock()
	defer h.addrs.mu.Unlock()
	h.addrs.agentURL, h.addrs.previous = cur, prev
	h.addrs.changedAt, _ = time.Parse(time.RFC3339, at)
	return nil
}

// noteAgentURL records the agents' address. One that differs from the
// recorded address makes that one the previous address (HS-172); "" (not
// known yet) changes nothing.
func (h *Hub) noteAgentURL(ctx context.Context, cur string) {
	if cur == "" {
		return
	}
	h.addrs.mu.Lock()
	old := h.addrs.agentURL
	if cur == old {
		h.addrs.mu.Unlock()
		return
	}
	now := h.now().UTC()
	h.addrs.agentURL = cur
	if old != "" {
		h.addrs.previous, h.addrs.changedAt = old, now
	}
	h.addrs.mu.Unlock()
	if err := h.store.SetMeta(ctx, metaAgentURL, cur); err != nil {
		h.log.Error("recording the agents' address", "err", err)
		return
	}
	if old == "" {
		return
	}
	_ = h.store.SetMeta(ctx, metaAgentURLPrevious, old)
	_ = h.store.SetMeta(ctx, metaAgentURLChangedAt, now.Format(time.RFC3339))
	h.log.Warn("the agents' address changed", "from", old, "to", cur)
	h.auditSystem(ctx, store.AuditRecord{Event: "hub.address_changed", Outcome: "ok", User: "system",
		Details: map[string]string{"from": old, "to": cur}})
}

// currentAgentURL is the agents' address now (recorded when it changed),
// else the recorded one.
func (h *Hub) currentAgentURL(ctx context.Context) string {
	cur, _ := h.agentURL(nil)
	h.noteAgentURL(ctx, cur)
	if cur != "" {
		return cur
	}
	h.addrs.mu.Lock()
	defer h.addrs.mu.Unlock()
	return h.addrs.agentURL
}

// agentURLState is GET /hub's agent_url_previous and agent_url_changed_at.
func (h *Hub) agentURLState() (previous string, changedAt time.Time) {
	h.addrs.mu.Lock()
	defer h.addrs.mu.Unlock()
	return h.addrs.previous, h.addrs.changedAt
}

// computeHubAddrs lists the addresses agents may reach the listener on: the
// agents' URL first, then the addresses of the machine's own interfaces on
// the listener's port (IPv4, then global IPv6; not loopback, link-local,
// or container, VM and VPN interfaces, netaddrs.Virtual). A listener bound
// to one address has only that one.
func (h *Hub) computeHubAddrs(first string) []string {
	var out []string
	if first != "" {
		out = append(out, first)
	}
	port := h.agentPort()
	if host, _, err := net.SplitHostPort(h.cfg.AgentListen); err == nil && host != "" && host != "0.0.0.0" && host != "::" {
		if a, err := netip.ParseAddr(host); err == nil && a.IsLoopback() {
			return dedupe(out) // only this machine can reach it
		}
		return dedupe(append(out, "wss://"+net.JoinHostPort(host, port)))
	}
	ifs, err := h.interfaces()
	if err != nil {
		h.log.Debug("listing the network interfaces", "err", err)
		return dedupe(out)
	}
	var v4, v6 []string
	for _, ifc := range ifs {
		if !ifc.Physical() {
			continue
		}
		for _, p := range ifc.Prefixes {
			a := p.Addr()
			if !a.IsGlobalUnicast() || a.IsLinkLocalUnicast() || a.IsLoopback() {
				continue
			}
			u := "wss://" + net.JoinHostPort(a.String(), port)
			if a.Is4() {
				v4 = append(v4, u)
			} else {
				v6 = append(v6, u)
			}
		}
	}
	out = dedupe(append(append(out, v4...), v6...))
	if len(out) > maxHubAddrs {
		out = out[:maxHubAddrs]
	}
	return out
}

// interfaces lists the machine's interfaces (Config.Interfaces in tests).
func (h *Hub) interfaces() ([]netaddrs.Interface, error) {
	if h.cfg.Interfaces != nil {
		return h.cfg.Interfaces()
	}
	return netaddrs.System()
}

// hubAddrs is the current list (computed when there is none yet).
func (h *Hub) hubAddrs(ctx context.Context) []string {
	h.addrs.mu.Lock()
	list := h.addrs.list
	h.addrs.mu.Unlock()
	if list != nil {
		return list
	}
	list = h.computeHubAddrs(h.currentAgentURL(ctx))
	h.addrs.mu.Lock()
	if h.addrs.list == nil {
		h.addrs.list = list
	}
	h.addrs.mu.Unlock()
	return list
}

// refreshAddrs (every addrInterval) records an address change and sends
// the list to every connected agent that was told another one.
func (h *Hub) refreshAddrs(ctx context.Context) {
	list := h.computeHubAddrs(h.currentAgentURL(ctx))
	h.addrs.mu.Lock()
	old := h.addrs.list
	h.addrs.list = list
	h.addrs.mu.Unlock()
	h.addrsChanged(ctx, old, list)
	if len(list) == 0 {
		return
	}
	key := addrsKey(list)
	h.mu.RLock()
	var conns []*AgentConn
	for _, s := range h.servers {
		if s.conn != nil {
			conns = append(conns, s.conn)
		}
	}
	h.mu.RUnlock()
	for _, c := range conns {
		sent := c.addrsSent.Load()
		if sent != nil && *sent == key {
			continue
		}
		// Marked before sending, so the next round doesn't send it again;
		// one slow agent doesn't hold up the others (a send may wait for
		// its write deadline). A failed send is tried again next round.
		if !c.addrsSent.CompareAndSwap(sent, &key) {
			continue
		}
		go func() {
			if c.send(proto.MsgHubAddrs, proto.HubAddrs{Addrs: list}) != nil {
				c.addrsSent.CompareAndSwap(&key, sent)
			}
		}()
	}
}

func addrsKey(list []string) string { return strings.Join(list, "\n") }
