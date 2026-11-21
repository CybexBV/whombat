package hub

import (
	"net/http"
	"runtime"
	"time"

	"rackoon/internal/hub/store"
)

// apiHubInfo is GET /hub: version, uptime and database size (Settings › Hub).
func (h *Hub) apiHubInfo(w http.ResponseWriter, r *http.Request, p *principal) error {
	total, free, err := h.store.Size(r.Context())
	if err != nil {
		return err
	}
	h.mu.RLock()
	servers, connected := len(h.servers), 0
	for _, s := range h.servers {
		if s.conn != nil {
			connected++
		}
	}
	h.mu.RUnlock()
	agentURL := h.currentAgentURL(r.Context())
	prev, changedAt := h.agentURLState()
	var restoreErr any
	if f := h.restoreErr.Load(); f != nil {
		restoreErr = map[string]any{"at": f.At.UTC().Format(time.RFC3339), "code": f.Code, "message": f.Message}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"version": Version, "schema": store.SchemaVersion(), "started_at": h.startedAt.UTC().Format(time.RFC3339),
		"uptime_s": int64(time.Since(h.startedAt) / time.Second), "go": runtime.Version(),
		"database_bytes": total, "database_free_bytes": free,
		"servers": servers, "agents_connected": connected, "consoles_open": h.consolesLive.Load(),
		"public_url": h.cfg.PublicURL, "agent_url": agentURL,
		"agent_url_previous": nullStr(prev), "agent_url_changed_at": nullTime(changedAt),
		"restored_at": nullTimeP(h.restoredSince()), "restore_error": restoreErr,
		"headless": h.cfg.Headless, "ca_sha256": h.ca.Pin, "tls_pin": h.listenerPin(), "agents_url": agentsURL(h, r),
		"reconnecting": h.reconnectingJSON(),
	})
	return nil
}

// nullStr is s, or JSON null when empty.
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nullTime is t in RFC 3339, or JSON null when zero.
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func nullTimeP(t *time.Time) any {
	if t == nil {
		return nil
	}
	return nullTime(*t)
}

// agentsURL is the agents' URL as the hub resolves it now (--agent-url
// auto: the LAN address), "" when unknown.
func agentsURL(h *Hub, r *http.Request) string {
	u, err := h.agentURL(r)
	if err != nil {
		return ""
	}
	return u
}

// apiHubBackup is GET /hub/backup: a backup download (admin; it carries the
// CA key, so it is audited).
func (h *Hub) apiHubBackup(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := h.requireReauth(p); err != nil {
		return err
	}
	if _, err := h.auditReq(r, p, store.AuditRecord{Event: "hub.backup_downloaded", Outcome: "ok"}); err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; backups are disabled.")
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+backupName(h.now())+`"`)
	w.Header().Set("Cache-Control", "no-store")
	if err := h.Backup(r.Context(), w); err != nil {
		h.log.Error("backup download", "err", err)
		// Headers may be sent; a broken archive fails to extract.
	}
	return nil
}
