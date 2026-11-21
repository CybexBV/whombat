package hub

import (
	"context"
	"crypto/x509"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Adoption after a restore (HS-180): a backup holds each server's client
// certificate serial as it was when the backup was made; an agent that
// renewed its certificate since (every 20 days) presents a newer one the
// restored database doesn't know. For adoptWindow after the restore, such
// a certificate is accepted when the CA signed it (the TLS handshake
// checked that and its validity), it expires later than the stored one
// (it was issued after it) and the agent's machine id is the server's; it
// becomes the server's certificate, audited. Afterwards the normal rule.

const adoptWindow = 14 * 24 * time.Hour

// adoptable reports whether a client certificate whose serial is not the
// server's may be adopted (the machine id is checked in hello).
func (h *Hub) adoptable(id string, leaf *x509.Certificate) bool {
	at := h.restoredSince()
	now := h.now()
	if at == nil || now.Sub(*at) > adoptWindow || now.After(leaf.NotAfter) || now.Before(leaf.NotBefore) {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	s, ok := h.servers[id]
	return ok && s.meta.MachineID != "" && leaf.NotAfter.After(s.meta.CertNotAfter)
}

// adoptCert makes the connection's certificate the server's when the
// agent's machine id is the server's (false: refused, audited).
func (h *Hub) adoptCert(ctx context.Context, c *AgentConn, hello proto.Hello) bool {
	mid := cleanText(hello.MachineID, 64)
	h.mu.Lock()
	s, ok := h.servers[c.ServerID]
	if !ok {
		h.mu.Unlock()
		return false
	}
	if s.meta.CertSerial == c.serial {
		h.mu.Unlock()
		return true // adopted by a connection a moment ago
	}
	if mid == "" || s.meta.MachineID != mid || !c.certNotAfter.After(s.meta.CertNotAfter) {
		h.mu.Unlock()
		h.log.Warn("agent refused: a newer certificate after the restore, but another machine", "server", c.ServerID,
			"serial", c.serial, "client_ip", c.remote)
		h.auditSystem(ctx, store.AuditRecord{Event: "agent.certificate_adopted", Outcome: "denied", User: "agent",
			Server: c.ServerID, ClientIP: c.remote, Code: "machine_id_mismatch",
			Details: map[string]string{"serial": c.serial, "hostname": cleanText(hello.Hostname, 128)}})
		return false
	}
	prev := s.meta.CertSerial
	h.mu.Unlock()
	if err := h.store.UpdateServerCert(ctx, c.ServerID, c.serial, c.certNotAfter, ""); err != nil {
		h.log.Error("adopting a certificate", "server", c.ServerID, "err", err)
		return false
	}
	h.mu.Lock()
	if s, ok := h.servers[c.ServerID]; ok {
		s.meta.CertSerial, s.meta.CertNotAfter, s.meta.PrevCertSerial = c.serial, c.certNotAfter.UTC(), ""
	}
	h.mu.Unlock()
	at := ""
	if t := h.restoredSince(); t != nil {
		at = t.UTC().Format(time.RFC3339)
	}
	h.log.Info("adopted the agent's newer certificate after the restore", "server", c.ServerID, "serial", c.serial)
	h.auditSystem(ctx, store.AuditRecord{Event: "agent.certificate_adopted", Outcome: "ok", User: "agent", Server: c.ServerID,
		ClientIP: c.remote, Details: map[string]string{"serial": c.serial, "previous_serial": prev,
			"not_after": c.certNotAfter.UTC().Format(time.RFC3339), "restored_at": at}})
	return true
}
