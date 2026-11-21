package hub

// Single sign-on with an OpenID Connect provider (off unless --oidc-issuer
// is set): the authorization code flow with PKCE (S256), a state bound to
// the browser by a short-lived cookie, and a nonce checked in the ID token.
//
// Accounts: a user is found by the provider's subject (issuer + sub). At the
// first sign-in an account an admin created for single sign-on is linked by
// its name (the --oidc-username-claim, preferred_username by default);
// local password accounts are never linked automatically. With
// --oidc-auto-create unknown users get an account. With --oidc-role-claim
// the role follows the provider at every sign-in.
//
// Re-authentication ("Confirm it's you") for these accounts is a fresh round
// trip with prompt=login and max_age=0; the ID token's auth_time must be at
// most 5 minutes old. The browser comes back to the page it left with
// ?reauth=ok (the change is then made again by the user).

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"rackoon/internal/hub/store"
)

const (
	oidcCookie       = "rackoon_oidc"
	oidcCookiePath   = "/api/v1/auth/oidc"
	oidcCallbackPath = "/api/v1/auth/oidc/callback"
	oidcRequestTTL   = 10 * time.Minute
	oidcReauthMaxAge = 5 * time.Minute
	maxOIDCRequests  = 1000
)

type oidcAuth struct {
	cfg    OIDCConfig
	secret string
	client *http.Client

	mu       sync.Mutex
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	failedAt time.Time // last failed discovery (retried after 10 s)
	pending  map[string]*oidcRequest
}

// oidcRequest is a sign-in waiting for the provider's answer (by state).
type oidcRequest struct {
	nonce, verifier, redirect, next string
	reauthUser                      int64  // 0: a sign-in
	reauthSession                   []byte // the session a re-authentication confirms
	expires                         time.Time
}

func newOIDC(cfg OIDCConfig) (*oidcAuth, error) {
	o := &oidcAuth{cfg: cfg, client: &http.Client{Timeout: 15 * time.Second}, pending: map[string]*oidcRequest{}}
	if cfg.ClientSecretFile != "" {
		// $CREDENTIALS_DIRECTORY (systemd LoadCredential=) may be in the path.
		b, err := os.ReadFile(os.ExpandEnv(cfg.ClientSecretFile))
		if err != nil {
			return nil, fmt.Errorf("--oidc-client-secret-file: %w", err)
		}
		o.secret = strings.TrimSpace(string(b))
		if o.secret == "" {
			return nil, errors.New("--oidc-client-secret-file is empty")
		}
	}
	return o, nil
}

// discover fetches the provider's configuration once (lazily, so the hub
// starts while the provider is down).
func (o *oidcAuth) discover(ctx context.Context) (*oidc.Provider, *oidc.IDTokenVerifier, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.provider != nil {
		return o.provider, o.verifier, nil
	}
	if !o.failedAt.IsZero() && time.Since(o.failedAt) < 10*time.Second {
		return nil, nil, errors.New("the provider was unreachable moments ago")
	}
	ctx, cancel := context.WithTimeout(oidc.ClientContext(ctx, o.client), 15*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, o.cfg.Issuer)
	if err != nil {
		o.failedAt = time.Now()
		return nil, nil, err
	}
	o.provider = p
	o.verifier = p.Verifier(&oidc.Config{ClientID: o.cfg.ClientID})
	return o.provider, o.verifier, nil
}

func (o *oidcAuth) oauth(p *oidc.Provider, redirect string) *oauth2.Config {
	scopes := []string{oidc.ScopeOpenID}
	for _, s := range o.cfg.Scopes {
		if s != "" && s != oidc.ScopeOpenID {
			scopes = append(scopes, s)
		}
	}
	return &oauth2.Config{ClientID: o.cfg.ClientID, ClientSecret: o.secret, Endpoint: p.Endpoint(), RedirectURL: redirect,
		Scopes: scopes}
}

func (o *oidcAuth) put(state string, req *oidcRequest, now time.Time) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.pending) >= maxOIDCRequests {
		for k, v := range o.pending {
			if now.After(v.expires) {
				delete(o.pending, k)
			}
		}
		if len(o.pending) >= maxOIDCRequests {
			return false
		}
	}
	o.pending[state] = req
	return true
}

// take returns and forgets a pending request (single use).
func (o *oidcAuth) take(state string, now time.Time) *oidcRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	req := o.pending[state]
	delete(o.pending, state)
	if req == nil || now.After(req.expires) {
		return nil
	}
	return req
}

// role maps the role claim's values to the highest matching role ("" when
// none matches).
func (o *oidcAuth) role(v any) string {
	var vals []string
	switch x := v.(type) {
	case string:
		vals = []string{x}
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				vals = append(vals, s)
			}
		}
	}
	best := ""
	for _, m := range o.cfg.RoleMap {
		match := m.Value == "*"
		for _, s := range vals {
			if s == m.Value {
				match = true
			}
		}
		if match && store.RoleRank(m.Role) > store.RoleRank(best) {
			best = m.Role
		}
	}
	return best
}

// safeNext keeps a post-sign-in target on this site (a path, not the API).
func safeNext(s string) string {
	if s == "" || !strings.HasPrefix(s, "/") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, "/\\") ||
		strings.ContainsAny(s, "\r\n\\") || strings.HasPrefix(s, "/api/") {
		return "/"
	}
	return s
}

// withQuery sets a query parameter on a site path.
func withQuery(path, key, value string) string {
	u, err := url.Parse(path)
	if err != nil {
		return "/"
	}
	q := u.Query()
	q.Set(key, value)
	u.RawQuery = q.Encode()
	return u.String()
}

// oidcFail ends a failed sign-in on the login page (a re-authentication on
// the page it came from) with a code the UI explains.
func (h *Hub) oidcFail(w http.ResponseWriter, r *http.Request, req *oidcRequest, code string) {
	target := "/login?oidc_error=" + url.QueryEscape(code)
	if req != nil && req.reauthUser != 0 {
		target = withQuery(req.next, "reauth", code)
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target, http.StatusFound)
}

// apiOIDCStart is GET /auth/oidc/start?next=/path[&reauth=1]: sends the
// browser to the provider.
func (h *Hub) apiOIDCStart(w http.ResponseWriter, r *http.Request, p *principal) error {
	o := h.oidc
	if o == nil {
		return errNotFound
	}
	q := r.URL.Query()
	now := h.now()
	req := &oidcRequest{next: safeNext(q.Get("next")), expires: now.Add(oidcRequestTTL)}
	reauth := q.Get("reauth") == "1"
	if reauth {
		if p == nil || p.token != nil || p.session.Kiosk || p.user.OIDCSubject == "" {
			h.oidcFail(w, r, nil, "not_sso")
			return nil
		}
		req.reauthUser, req.reauthSession = p.user.ID, p.tokenHsh
	}
	if !h.limits.passkeyBegin.take(clientIP(r)) {
		h.oidcFail(w, r, req, "rate_limited")
		return nil
	}
	prov, _, err := o.discover(r.Context())
	if err != nil {
		h.log.Warn("oidc: provider discovery failed", "issuer", o.cfg.Issuer, "err", err)
		h.oidcFail(w, r, req, "unavailable")
		return nil
	}
	state, nonce := randToken(24), randToken(24)
	req.nonce, req.verifier = nonce, oauth2.GenerateVerifier()
	req.redirect = h.requestOrigin(r) + oidcCallbackPath
	if !o.put(state, req, now) {
		h.oidcFail(w, r, req, "rate_limited")
		return nil
	}
	h.setCookie(w, oidcCookie, state, int(oidcRequestTTL/time.Second), oidcCookiePath, http.SameSiteLaxMode)
	opts := []oauth2.AuthCodeOption{oidc.Nonce(nonce), oauth2.S256ChallengeOption(req.verifier)}
	if reauth {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"), oauth2.SetAuthURLParam("max_age", "0"))
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, o.oauth(prov, req.redirect).AuthCodeURL(state, opts...), http.StatusFound)
	return nil
}

// apiOIDCCallback is GET /auth/oidc/callback?code=&state= (the provider
// sends the browser back here).
func (h *Hub) apiOIDCCallback(w http.ResponseWriter, r *http.Request, p *principal) error {
	o := h.oidc
	if o == nil {
		return errNotFound
	}
	q := r.URL.Query()
	state := q.Get("state")
	c, cerr := r.Cookie(oidcCookie)
	h.setCookie(w, oidcCookie, "", -1, oidcCookiePath, http.SameSiteLaxMode)
	var req *oidcRequest
	if cerr == nil && state != "" && subtle.ConstantTimeCompare([]byte(c.Value), []byte(state)) == 1 {
		req = o.take(state, h.now())
	}
	sso := map[string]string{"method": "oidc"}
	if req == nil {
		h.auditUser(r, "", "", store.AuditRecord{Event: "auth.login", Outcome: "denied", Code: "invalid_state", Details: sso})
		h.oidcFail(w, r, nil, "expired")
		return nil
	}
	event := "auth.login"
	if req.reauthUser != 0 {
		event = "auth.reauth"
	}
	deny := func(user, code string) error {
		h.auditUser(r, user, "", store.AuditRecord{Event: event, Outcome: "denied", Code: code, Details: sso})
		h.oidcFail(w, r, req, code)
		return nil
	}
	if e := q.Get("error"); e != "" {
		h.log.Info("oidc: the provider refused the sign-in", "error", cleanText(e, 64), "description", cleanText(q.Get("error_description"), 200))
		return deny("", "denied")
	}
	code := q.Get("code")
	if code == "" {
		return deny("", "failed")
	}
	prov, verifier, err := o.discover(r.Context())
	if err != nil {
		h.log.Warn("oidc: provider discovery failed", "issuer", o.cfg.Issuer, "err", err)
		return deny("", "unavailable")
	}
	ctx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), o.client), 20*time.Second)
	defer cancel()
	tok, err := o.oauth(prov, req.redirect).Exchange(ctx, code, oauth2.VerifierOption(req.verifier))
	if err != nil {
		h.log.Warn("oidc: code exchange failed", "err", err)
		return deny("", "failed")
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		h.log.Warn("oidc: the token response has no id_token")
		return deny("", "failed")
	}
	idt, err := verifier.Verify(ctx, raw)
	if err != nil {
		h.log.Warn("oidc: ID token rejected", "err", err)
		return deny("", "invalid_token")
	}
	if subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(req.nonce)) != 1 {
		return deny("", "invalid_nonce")
	}
	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return deny("", "invalid_token")
	}
	subject := idt.Issuer + "|" + idt.Subject
	now := h.now()

	if req.reauthUser != 0 {
		u, err := h.store.GetUser(r.Context(), req.reauthUser)
		if err != nil || u.OIDCSubject != subject {
			return deny(u.Username, "wrong_account")
		}
		at := claimTime(claims["auth_time"])
		if at.IsZero() || now.Sub(at) > oidcReauthMaxAge || at.After(now.Add(2*time.Minute)) {
			return deny(u.Username, "stale")
		}
		if p == nil || p.token != nil || !bytes.Equal(p.tokenHsh, req.reauthSession) {
			return deny(u.Username, "expired")
		}
		if err := h.store.SetReauth(r.Context(), req.reauthSession, now); err != nil {
			return err
		}
		h.auditReq(r, p, store.AuditRecord{Event: "auth.reauth", Outcome: "ok", Details: sso})
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, withQuery(req.next, "reauth", "ok"), http.StatusFound)
		return nil
	}

	u, fail, err := h.oidcAccount(r, claims, subject)
	if err != nil {
		return err
	}
	if fail != "" {
		return deny(claimString(claims[o.cfg.UsernameClaim]), fail)
	}
	if err := h.newSession(w, r, u.ID); err != nil {
		return err
	}
	h.auditUser(r, u.Username, u.Role, store.AuditRecord{Event: "auth.login", Outcome: "ok", Details: sso})
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, req.next, http.StatusFound)
	return nil
}

// oidcAccount finds, links or creates the account of a verified ID token
// and applies the provider's role. fail is a refusal code for the UI.
func (h *Hub) oidcAccount(r *http.Request, claims map[string]any, subject string) (u store.User, fail string, err error) {
	o, ctx := h.oidc, r.Context()
	name := claimString(claims[o.cfg.UsernameClaim])
	if o.cfg.UsernameClaim == "email" {
		if v, ok := claims["email_verified"].(bool); ok && !v {
			return u, "unverified_email", nil
		}
	}
	role := ""
	if o.cfg.RoleClaim != "" {
		if role = o.role(claims[o.cfg.RoleClaim]); role == "" {
			return u, "no_role", nil
		}
	}
	u, err = h.store.GetUserByOIDC(ctx, subject)
	if errors.Is(err, store.ErrNotFound) && name != "" {
		// An account an admin created for single sign-on: link it.
		u, err = h.store.GetUnlinkedOIDCUser(ctx, name)
		if err == nil {
			if err := h.store.LinkOIDC(ctx, u.ID, subject); err != nil {
				return u, "", err
			}
			u.OIDCSubject = subject
			h.auditUser(r, u.Username, u.Role, store.AuditRecord{Event: "user.oidc_linked", Outcome: "ok",
				Details: map[string]string{"username": u.Username}})
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		if !o.cfg.AutoCreate {
			return u, "not_registered", nil
		}
		if !usernameRE.MatchString(name) {
			return u, "invalid_username", nil
		}
		if role == "" {
			role = store.RoleViewer
		}
		wid := make([]byte, 32)
		_, _ = rand.Read(wid)
		u = store.User{Username: name, Role: role, WebAuthnID: wid, CreatedAt: h.now(), Source: store.SourceOIDC, OIDCSubject: subject}
		u.ID, err = h.store.CreateUser(ctx, u, false)
		if errors.Is(err, store.ErrConflict) {
			return u, "username_taken", nil
		}
		if err != nil {
			return u, "", err
		}
		h.auditUser(r, name, role, store.AuditRecord{Event: "user.created", Outcome: "ok",
			Details: map[string]string{"username": name, "role": role, "source": store.SourceOIDC, "via": "oidc"}})
		return u, "", nil
	}
	if err != nil {
		return u, "", err
	}
	if role != "" && role != u.Role {
		if err := h.store.SetRole(ctx, u.ID, role); errors.Is(err, store.ErrLastAdmin) {
			// The provider took away the only admin's role: refuse rather
			// than keep stale rights or leave the hub without an admin.
			return u, "last_admin", nil
		} else if err != nil {
			return u, "", err
		}
		h.auditUser(r, u.Username, role, store.AuditRecord{Event: "user.role_changed", Outcome: "ok",
			Details: map[string]string{"username": u.Username, "from": u.Role, "to": role, "via": "oidc"}})
		h.bus.DropUser(u.ID)
		u.Role = role
	}
	return u, "", nil
}

func claimString(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func claimTime(v any) time.Time {
	if f, ok := v.(float64); ok && f > 0 {
		return time.Unix(int64(f), 0)
	}
	return time.Time{}
}
