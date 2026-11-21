package hub

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/store"
)

// API tokens: "Authorization: Bearer rk_…" authenticates scripts and
// monitoring (Prometheus) with a role at most the creator's. A token also
// opens a kiosk link (/kiosk#rk_…): a read-only viewer browser session
// without settings, ended when the token is deleted. Kiosk-kind tokens
// (created as kiosk links) only open kiosk sessions; they are refused as
// bearer tokens.

const tokenPrefix = "rk_"

// tokenUse remembers when a token's last use was written (one write per
// token per 5 minutes).
var tokenUse = struct {
	sync.Mutex
	m map[string]time.Time
}{m: map[string]time.Time{}}

// authenticateToken resolves a bearer token (nil when absent or invalid).
func (h *Hub) authenticateToken(r *http.Request) *principal {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	secret := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if !strings.HasPrefix(secret, tokenPrefix) || len(secret) > 128 {
		return nil
	}
	t, err := h.store.TokenByHash(r.Context(), sha(secret))
	now := h.now()
	if err != nil || subtle.ConstantTimeCompare(t.Hash, sha(secret)) != 1 || (!t.ExpiresAt.IsZero() && !now.Before(t.ExpiresAt)) ||
		t.Kind == store.TokenKiosk {
		return nil
	}
	u, err := h.store.GetUser(r.Context(), t.UserID)
	if err != nil {
		return nil
	}
	if store.RoleRank(t.Role) < store.RoleRank(u.Role) {
		u.Role = t.Role
	}
	tokenUse.Lock()
	last := tokenUse.m[t.ID]
	if now.Sub(last) >= 5*time.Minute {
		tokenUse.m[t.ID] = now
	}
	tokenUse.Unlock()
	if now.Sub(last) >= 5*time.Minute {
		if err := h.store.TouchToken(r.Context(), t.ID, now); err != nil {
			h.log.Debug("token use not recorded", "err", err)
		}
	}
	return &principal{user: u, token: &t}
}

type tokenJSON struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Role       string  `json:"role"`
	User       string  `json:"user"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
	ExpiresAt  *string `json:"expires_at"`
	Kind       string  `json:"kind"`
}

func toTokenJSON(t store.APIToken) tokenJSON {
	return tokenJSON{ID: t.ID, Name: t.Name, Role: t.Role, User: t.Username, CreatedAt: t.CreatedAt.UTC().Format(time.RFC3339),
		LastUsedAt: tsp(t.LastUsedAt), ExpiresAt: tsp(t.ExpiresAt), Kind: t.Kind}
}

// apiTokens is GET /tokens: the caller's tokens (admins: ?all=1 for everyone's).
func (h *Hub) apiTokens(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.session.Kiosk {
		return errForbidden // a wall display has no business with its owner's tokens
	}
	uid := p.user.ID
	if r.URL.Query().Get("all") == "1" {
		if p.rank() < store.RoleRank(admin) {
			return errForbidden
		}
		uid = 0
	}
	list, err := h.store.ListTokens(r.Context(), uid)
	if err != nil {
		return err
	}
	out := []tokenJSON{}
	for _, t := range list {
		out = append(out, toTokenJSON(t))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiCreateToken is POST /tokens {name, role, expires_days, kind}: the
// secret is returned once. kind "kiosk" makes a kiosk link (role viewer).
func (h *Hub) apiCreateToken(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.token != nil || p.session.Kiosk {
		return errForbidden // tokens do not mint tokens
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var req struct {
		Name        string `json:"name"`
		Role        string `json:"role"`
		ExpiresDays int    `json:"expires_days"`
		Kind        string `json:"kind"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	name := cleanText(req.Name, 64)
	if name == "" {
		return apiErr(http.StatusBadRequest, "invalid_name", "Give the token a name.")
	}
	switch req.Kind {
	case "", store.TokenAPI:
		req.Kind = store.TokenAPI
	case store.TokenKiosk:
		if req.Role != "" && req.Role != store.RoleViewer {
			return apiErr(http.StatusBadRequest, "invalid_role", "Kiosk links are read-only (role viewer).")
		}
	default:
		return apiErr(http.StatusBadRequest, "invalid_kind", "kind must be api or kiosk.")
	}
	if req.Role == "" {
		req.Role = store.RoleViewer
	}
	if store.RoleRank(req.Role) < 0 {
		return apiErr(http.StatusBadRequest, "invalid_role", "role must be viewer, operator or admin.")
	}
	if store.RoleRank(req.Role) > p.rank() {
		return apiErr(http.StatusForbidden, "invalid_role", "A token cannot have more rights than its owner.")
	}
	if req.ExpiresDays < 0 || req.ExpiresDays > 3650 {
		return apiErr(http.StatusBadRequest, "invalid_expiry", "expires_days must be 0 (never) to 3650.")
	}
	now := h.now()
	secret := tokenPrefix + randToken(32)
	t := store.APIToken{ID: newID("tk_"), UserID: p.user.ID, Name: name, Hash: sha(secret), Role: req.Role, CreatedAt: now,
		Username: p.user.Username, Kind: req.Kind}
	if req.ExpiresDays > 0 {
		t.ExpiresAt = now.Add(time.Duration(req.ExpiresDays) * 24 * time.Hour)
	}
	if err := h.store.CreateToken(r.Context(), t); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "token.created", Outcome: "ok",
		Details: map[string]string{"token_id": t.ID, "name": name, "role": req.Role, "kind": req.Kind}})
	out := map[string]any{"token": secret}
	for k, v := range map[string]any{"id": t.ID, "name": t.Name, "role": t.Role, "user": t.Username,
		"created_at": now.UTC().Format(time.RFC3339), "last_used_at": nil, "expires_at": tsp(t.ExpiresAt), "kind": t.Kind} {
		out[k] = v
	}
	writeJSON(w, r, http.StatusCreated, out)
	return nil
}

// apiDeleteToken is DELETE /tokens/{id} (own tokens; admins: any).
func (h *Hub) apiDeleteToken(w http.ResponseWriter, r *http.Request, p *principal) error {
	t, err := h.store.GetToken(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && t.UserID != p.user.ID && p.rank() < store.RoleRank(admin)) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if err := h.store.DeleteToken(r.Context(), t.ID); err != nil {
		return err
	}
	tokenUse.Lock()
	delete(tokenUse.m, t.ID)
	tokenUse.Unlock()
	h.auditReq(r, p, store.AuditRecord{Event: "token.deleted", Outcome: "ok", Details: map[string]string{"token_id": t.ID, "name": t.Name}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// apiKiosk is POST /auth/kiosk {token}: a read-only kiosk session from a
// token (the session's role is viewer whatever the token's role).
func (h *Hub) apiKiosk(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	done, err := h.credentialAttempt(clientIP(r))
	if err != nil {
		return err
	}
	t, terr := h.store.TokenByHash(r.Context(), sha(req.Token))
	ok := terr == nil && strings.HasPrefix(req.Token, tokenPrefix) && (t.ExpiresAt.IsZero() || h.now().Before(t.ExpiresAt))
	done(ok)
	if !ok {
		h.auditUser(r, "", "", store.AuditRecord{Event: "auth.login", Outcome: "denied", Code: "invalid_token",
			Details: map[string]string{"method": "kiosk"}})
		return apiErr(http.StatusUnauthorized, "invalid_token", "This kiosk link is not valid (the token was deleted or expired).")
	}
	if err := h.newSessionWith(w, r, store.Session{UserID: t.UserID, RoleCap: store.RoleViewer, Kiosk: true, TokenID: t.ID}); err != nil {
		return err
	}
	if err := h.store.TouchToken(r.Context(), t.ID, h.now()); err != nil { // "last opened"
		h.log.Debug("token use not recorded", "err", err)
	}
	h.auditUser(r, t.Username, store.RoleViewer, store.AuditRecord{Event: "auth.login", Outcome: "ok",
		Details: map[string]string{"method": "kiosk", "token_id": t.ID}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
