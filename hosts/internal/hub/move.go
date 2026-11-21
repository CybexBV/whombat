package hub

import (
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// apiMoveAgents is POST /hub/agents/move {url} (admin): every connected
// agent not already connected through url is asked to move there
// (hub_move), and the hub holds their alerts while they do. url must be
// one of the hub's own addresses now, so nobody can send the fleet
// elsewhere.
func (h *Hub) apiMoveAgents(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		URL string `json:"url"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(req.URL))
	if err != nil || u.Scheme != "wss" || u.Hostname() == "" || u.Port() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return apiErr(http.StatusBadRequest, "bad_request", "url must be a wss URL with a port, like wss://10.100.1.97:8443.")
	}
	target := "wss://" + u.Host
	if !slices.ContainsFunc(h.computeHubAddrs(h.currentAgentURL(r.Context())), func(a string) bool {
		return strings.EqualFold(a, target)
	}) {
		return apiErr(http.StatusBadRequest, "bad_request", "url is not one of the hub's own addresses now.")
	}
	ap, isIP := urlAddr(target)
	_, conns := h.connectedServers()
	var ask []*AgentConn
	var ids []string
	already := 0
	for _, c := range conns {
		if strings.EqualFold(c.dialed, u.Host) || (isIP && c.via.IsValid() && c.via == ap) {
			already++
			continue
		}
		ask = append(ask, c)
		ids = append(ids, c.ServerID)
	}
	// The hold first, so an agent that drops while it moves is covered.
	h.startHold(r.Context(), holdMove, ids)
	for _, c := range ask {
		// One slow agent doesn't hold up the others or the answer (a send
		// may wait for its write deadline).
		go func() {
			if err := c.send(proto.MsgHubMove, proto.HubMove{URL: target}); err != nil {
				h.log.Warn("asking an agent to move", "server", c.ServerID, "err", err)
			}
		}()
	}
	h.log.Info("asked the agents to move", "url", target, "asked", len(ask), "already", already)
	_, _ = h.auditReq(r, p, store.AuditRecord{Event: "hub.agents_moved", Outcome: "ok",
		Details: map[string]string{"url": target, "asked": strconv.Itoa(len(ask))}})
	writeJSON(w, r, http.StatusOK, map[string]int{"asked": len(ask), "already": already})
	return nil
}
