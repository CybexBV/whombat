package hub

import (
	"net/http"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- inspect: on-demand views, never stored --------------------------------------------

var inspectKinds = map[string]bool{proto.InspectProcesses: true, proto.InspectPorts: true, proto.InspectServices: true,
	proto.InspectUpdates: true}

// apiInspect is GET /servers/{id}/inspect/{kind}: the host's processes,
// listening ports, services or pending package updates, asked from the
// agent now. Needs the console permission (it shows the host's internals);
// the updates also the diagnose one (SWU-11).
func (h *Hub) apiInspect(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, kind := r.PathValue("id"), r.PathValue("kind")
	if !inspectKinds[kind] {
		return apiErr(http.StatusNotFound, "unknown_view", "Unknown view.")
	}
	return h.inspect(w, r, p, serverID, model.HostGuestID, proto.InspectRequest{Kind: kind, Platform: proto.PlatformHost, GuestID: "host"})
}

// apiSnapshots is GET /servers/{id}/guests/{guestId}/snapshots. It needs
// power or manage (snapshots are taken under power), not the console.
func (h *Hub) apiSnapshots(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, gid := r.PathValue("id"), r.PathValue("guestId")
	platform, id, ok := model.SplitGuestID(gid)
	if !ok {
		return errGuestNotFound
	}
	return h.inspect(w, r, p, serverID, gid, proto.InspectRequest{Kind: proto.InspectSnapshots, Platform: platform, GuestID: id})
}

func (h *Hub) inspect(w http.ResponseWriter, r *http.Request, p *principal, serverID, gid string, req proto.InspectRequest) error {
	need := needConsole
	switch req.Kind {
	case proto.InspectSnapshots:
		need = needSnapshots
	case proto.InspectUpdates:
		need = needUpdates
	}
	t, e := h.remotePrecheck(p, serverID, gid, need)
	if e != nil {
		return h.deny(r, p, "inspect.denied", serverID, gid, "", e, map[string]string{"view": req.Kind})
	}
	// Viewing the host's internals is audited once per user, host and view
	// every 10 minutes (the UI refreshes them).
	if h.limits.screens.take(p.key() + "|" + serverID + "|" + req.Kind + "|" + gid) {
		h.auditReq(r, p, store.AuditRecord{Event: "inspect.viewed", Outcome: "ok", Server: serverID, Guest: guestOrEmpty(gid),
			Details: map[string]string{"view": req.Kind}})
	}
	resp, err := t.conn.Inspect(r.Context(), req)
	if err != nil {
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}
	if resp.Code != "" {
		status := http.StatusBadGateway
		switch resp.Code {
		case "unsupported", "unsupported_action":
			status = http.StatusNotImplemented
		case "remote_control_disabled":
			status = http.StatusForbidden
		case "unknown_guest":
			status = http.StatusNotFound
		}
		msg := resp.Message
		if msg == "" {
			msg = "The agent could not produce this view."
		}
		return apiErr(status, resp.Code, msg)
	}
	out := map[string]any{"kind": req.Kind, "as_of": h.now().UTC().Format(time.RFC3339), "truncated": resp.Truncated}
	switch req.Kind {
	case proto.InspectProcesses:
		out["items"] = nonNil(resp.Processes)
	case proto.InspectPorts:
		out["items"] = nonNil(resp.Ports)
	case proto.InspectServices:
		out["items"] = nonNil(resp.Services)
	case proto.InspectUpdates:
		out["items"] = nonNil(resp.Updates)
	case proto.InspectSnapshots:
		out["items"] = nonNil(resp.Snapshots)
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func guestOrEmpty(gid string) string {
	if gid == model.HostGuestID {
		return ""
	}
	return gid
}
