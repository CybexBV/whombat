package hub

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// On-request disk usage breakdown (proto.StreamDiskUsage):
//
//	GET  /api/v1/servers/{id}/disk-usage  recent stored breakdowns (viewer)
//	POST /api/v1/servers/{id}/disk-usage  measure one mount now {mount?, max_depth?, timeout_s?} (operator, diagnose switch)

func (h *Hub) apiDiskUsageList(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	items := model.BuildRecentDiskUsage(st.DiskUsage, h.now())
	if items == nil {
		items = []model.DiskUsage{}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"server": st.ID, "items": items})
	return nil
}

func (h *Hub) apiDiskUsage(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID := r.PathValue("id")
	var req struct {
		Mount    string `json:"mount"`
		MaxDepth int    `json:"max_depth"`
		TimeoutS int    `json:"timeout_s"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
	}
	mount := strings.TrimSpace(req.Mount)
	if mount != "" {
		if len(mount) > 512 || !strings.HasPrefix(mount, "/") || strings.ContainsAny(mount, "\x00\r\n") {
			return invalidFields(map[string]string{"mount": "Give an absolute mount point path."})
		}
		for _, seg := range strings.Split(mount, "/") {
			if seg == ".." {
				return invalidFields(map[string]string{"mount": "Mount path must not contain .."})
			}
		}
		mount = filepath.Clean(mount)
	}
	if req.MaxDepth < 0 || req.MaxDepth > 12 {
		return invalidFields(map[string]string{"max_depth": "Depth limit is 1 to 12."})
	}
	if req.TimeoutS < 0 || req.TimeoutS > 45 {
		return invalidFields(map[string]string{"timeout_s": "Timeout is 1 to 45 seconds."})
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}

	t, e := h.remotePrecheck(p, serverID, model.HostGuestID, needDiagnose)
	if e != nil {
		return h.deny(r, p, "disk_usage.denied", serverID, model.HostGuestID, "", e, map[string]string{"mount": mount})
	}
	if mount == "" {
		mount = defaultDiskUsageMount(t.st.Report)
	}
	details := map[string]string{"mount": mount}

	start := time.Now()
	resp, err := t.conn.DiskUsage(r.Context(), proto.DiskUsageRequest{
		Mount:    mount,
		MaxDepth: req.MaxDepth,
		TimeoutS: req.TimeoutS,
	})
	dur := float64(int64(time.Since(start).Seconds()*10)) / 10
	rec := store.AuditRecord{Event: "disk_usage.ran", Outcome: "ok", Server: serverID, DurationS: &dur, Details: details}

	if err != nil {
		rec.Outcome = "error"
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			rec.Code = "unsupported"
			h.auditReq(r, p, rec)
			return apiErr(http.StatusNotImplemented, "unsupported", "This server's agent does not support disk usage checks yet; update the agent first.")
		}
		rec.Code = "agent_error"
		h.auditReq(r, p, rec)
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}

	if resp.MeasuredAt.IsZero() {
		resp.MeasuredAt = h.now().UTC()
	}
	if resp.Mount == "" {
		resp.Mount = mount
	}

	switch resp.Code {
	case "":
		// Measured cleanly (may be Partial). Store and broadcast so server pages update.
		if resp.Partial {
			details["partial"] = "true"
		}
		h.auditReq(r, p, rec)
		if blob, merr := wire.Marshal(resp); merr == nil {
			if serr := h.store.SaveDiskUsage(r.Context(), serverID, resp.Mount, resp.MeasuredAt, blob); serr != nil {
				h.log.Warn("persist disk usage failed", "server", serverID, "mount", resp.Mount, "err", serr)
			}
		}
		h.mu.Lock()
		if ss, ok := h.servers[serverID]; ok {
			if ss.diskUsage == nil {
				ss.diskUsage = map[string]proto.DiskUsageResponse{}
			}
			ss.diskUsage[resp.Mount] = resp
		}
		h.mu.Unlock()
		h.bus.Publish("server.disk_usage", map[string]any{"id": serverID, "mount": resp.Mount})

		out := model.BuildDiskUsage(resp)
		writeJSON(w, r, http.StatusOK, struct {
			Server string `json:"server"`
			OK     bool   `json:"ok"`
			model.DiskUsage
		}{Server: serverID, OK: true, DiskUsage: out})
		return nil

	case "spun_down":
		// Spun-down disks are intentionally not woken; report cleanly without
		// overwriting any previously stored measurement for this mount.
		rec.Code = resp.Code
		details["spun_down"] = cleanText(strings.Join(resp.SkippedSpunDown, ","), 200)
		h.auditReq(r, p, rec)
		out := model.BuildDiskUsage(resp)
		writeJSON(w, r, http.StatusOK, struct {
			Server  string `json:"server"`
			OK      bool   `json:"ok"`
			Code    string `json:"code"`
			Message string `json:"message"`
			model.DiskUsage
		}{Server: serverID, OK: false, Code: resp.Code, Message: resp.Message, DiskUsage: out})
		return nil

	case "busy":
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		msg := resp.Message
		if msg == "" {
			msg = "A disk usage check is already running on this server."
		}
		return apiErr(http.StatusConflict, "busy", msg)

	case "invalid_request":
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		msg := resp.Message
		if msg == "" {
			msg = "That mount point cannot be scanned."
		}
		return apiErr(http.StatusBadRequest, "invalid_request", msg)

	case "remote_control_disabled":
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		return apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonAgentDiag+".")

	case "unsupported":
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		msg := resp.Message
		if msg == "" {
			msg = "This server does not support disk usage checks."
		}
		return apiErr(http.StatusNotImplemented, "unsupported", msg)

	default:
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		msg := resp.Message
		if msg == "" {
			msg = fmt.Sprintf("Could not measure disk usage on %s.", mount)
		}
		return apiErr(http.StatusBadGateway, "agent_error", msg)
	}
}

// defaultDiskUsageMount chooses the fullest writable local filesystem reported
// by the server, falling back to "/".
func defaultDiskUsageMount(r *proto.Report) string {
	if r == nil {
		return "/"
	}
	bestMount := ""
	bestPct := -1.0
	for _, fs := range r.Filesystems {
		if fs.Mount == "" || fs.Remote || fs.ReadOnly || fs.SizeBytes == 0 {
			continue
		}
		pct := float64(fs.UsedBytes) / float64(fs.SizeBytes)
		if pct > bestPct {
			bestPct = pct
			bestMount = fs.Mount
		}
	}
	if bestMount == "" {
		return "/"
	}
	return bestMount
}
