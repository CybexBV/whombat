package hub

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"golang.org/x/crypto/argon2"

	"rackoon/internal/hub/store"
)

// Cookies.
const (
	SessionCookie  = "rackoon_session"
	preCSRFCookie  = "rackoon_csrf"
	ceremonyCookie = "rackoon_webauthn"
)

// ---- passwords (argon2id) -------------------------------------------------------

const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32
)

var hashSem = make(chan struct{}, 2) // bounds concurrent argon2 work (64 MiB each)

// HashPassword returns an argon2id PHC string.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hashSem <- struct{}{}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	<-hashSem
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks a password against an argon2id PHC string.
func VerifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil || m > 1<<21 || t > 20 || p == 0 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	hashSem <- struct{}{}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	<-hashSem
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash equalizes timing for unknown user names.
var dummyHash, _ = HashPassword("rackoon-timing-equalizer")

var usernameRE = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)

// ValidateCredentials checks a new user name / password.
func ValidateCredentials(username, password string) error {
	if !usernameRE.MatchString(username) {
		return apiErr(http.StatusBadRequest, "invalid_username", "User names are 1 to 64 letters, digits, '.', '_', '@' or '-'.")
	}
	if len(password) < 10 || len(password) > 1024 {
		return apiErr(http.StatusBadRequest, "weak_password", "Passwords must be at least 10 characters.")
	}
	return nil
}

// ---- setup / webauthn init --------------------------------------------------------

func (h *Hub) initAuth(ctx context.Context, out io.Writer) error {
	n, err := h.store.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		token := randToken(24)
		h.setupTokenHash = sha(token)
		if out != nil {
			where := "Open the web UI and enter the setup token."
			if h.cfg.PublicURL != "" {
				where = "Open " + h.cfg.PublicURL + "/setup#token=" + token
			}
			fmt.Fprintf(out, "\n"+
				"  ==============================================================\n"+
				"  Rackoon first-run setup: no account exists yet.\n"+
				"  %s\n"+
				"  Setup token (valid until an account is created, new on restart):\n"+
				"      %s\n"+
				"  ==============================================================\n\n", where, token)
		}
	}
	if rp := h.rpID(); rp != "" {
		origins := []string{h.cfg.PublicURL}
		for _, o := range h.cfg.AllowedOrigins {
			if u, err := url.Parse(o); err == nil && (u.Hostname() == rp || strings.HasSuffix(u.Hostname(), "."+rp)) {
				origins = append(origins, o)
			}
		}
		wa, err := webauthn.New(&webauthn.Config{RPID: rp, RPDisplayName: "Rackoon", RPOrigins: origins})
		if err != nil {
			h.log.Warn("passkeys unavailable", "err", err)
		} else {
			h.webauthn = wa
		}
	} else {
		h.log.Info("passkeys unavailable: set --public-url to an https URL with a host name (or http://localhost)")
	}
	if h.cfg.OIDC.Enabled() {
		o, err := newOIDC(h.cfg.OIDC)
		if err != nil {
			return err
		}
		h.oidc = o
		if h.cfg.PublicURL == "" {
			h.log.Warn("single sign-on without --public-url: the redirect URL follows the request's host")
		}
		h.log.Info("single sign-on enabled", "issuer", h.cfg.OIDC.Issuer, "name", h.cfg.OIDC.Name)
	}
	return nil
}

// rpID is the WebAuthn relying party id, "" when passkeys cannot work
// (no public URL, an IP address, or plain http other than localhost).
func (h *Hub) rpID() string {
	if h.cfg.PublicURL == "" {
		return ""
	}
	u, err := url.Parse(h.cfg.PublicURL)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if net.ParseIP(host) != nil {
		return ""
	}
	if u.Scheme != "https" && host != "localhost" {
		return ""
	}
	return host
}

// loginSlots bounds concurrent credential checks (argon2 is expensive);
// requests beyond it are refused instead of queueing.
var loginSlots = make(chan struct{}, 4)

// credentialAttempt counts a credential check for the client IP, and for
// the user name when one is given, before any work is done (parallel
// requests cannot slip past the limit) and reserves a verification slot.
// done(ok) releases the slot and refunds the attempts on success. The
// per-name limit stops slow guessing of one account from many addresses.
func (h *Hub) credentialAttempt(ip string, username ...string) (done func(ok bool), err error) {
	if !h.limits.login.take(ip) {
		return nil, rateLimited(5 * time.Minute)
	}
	name := ""
	if len(username) > 0 && username[0] != "" {
		name = "user:" + strings.ToLower(cleanText(username[0], 64))
		if !h.limits.loginUser.take(name) {
			h.limits.login.refund(ip)
			return nil, rateLimited(15 * time.Minute)
		}
	}
	select {
	case loginSlots <- struct{}{}:
	default:
		h.limits.login.refund(ip)
		if name != "" {
			h.limits.loginUser.refund(name)
		}
		return nil, rateLimited(5 * time.Second)
	}
	return func(ok bool) {
		<-loginSlots
		if ok {
			h.limits.login.refund(ip)
			if name != "" {
				h.limits.loginUser.refund(name)
			}
		}
	}, nil
}

func (h *Hub) setupRequired(ctx context.Context) bool {
	h.setupMu.Lock()
	defer h.setupMu.Unlock()
	if h.setupTokenHash == nil {
		return false
	}
	// An account created with `whombat-hosts user add` while the hub runs ends setup too.
	if n, err := h.store.CountUsers(ctx); err == nil && n > 0 {
		h.setupTokenHash = nil
		return false
	}
	return true
}

// ---- sessions ---------------------------------------------------------------------

func (h *Hub) setCookie(w http.ResponseWriter, name, value string, maxAge int, path string, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: path, MaxAge: maxAge, HttpOnly: true,
		Secure: h.cfg.secureCookies(), SameSite: sameSite})
}

// newSession creates a session for a user and sets the cookie. A sign-in
// counts as a re-authentication.
func (h *Hub) newSession(w http.ResponseWriter, r *http.Request, userID int64) error {
	return h.newSessionWith(w, r, store.Session{UserID: userID})
}

// newSessionWith creates a session from a template (user, role cap, kiosk).
func (h *Hub) newSessionWith(w http.ResponseWriter, r *http.Request, se store.Session) error {
	token := randToken(32)
	now := h.now()
	se.IDHash, se.CSRF, se.CreatedAt, se.LastSeenAt = sha(token), randToken(24), now, now
	se.ExpiresAt = now.Add(h.cfg.SessionLifetime)
	se.AbsoluteExpiresAt = now.Add(h.cfg.SessionMaxLifetime)
	if se.ExpiresAt.After(se.AbsoluteExpiresAt) {
		se.ExpiresAt = se.AbsoluteExpiresAt
	}
	if !se.Kiosk {
		se.ReauthAt = now
	}
	se.IP, se.UserAgent = clientIP(r), cleanText(r.UserAgent(), 256)
	if err := h.store.CreateSession(r.Context(), se); err != nil {
		return err
	}
	if !se.Kiosk {
		if err := h.store.TouchLogin(r.Context(), se.UserID, now); err != nil {
			h.log.Debug("last sign-in not recorded", "err", err)
		}
	}
	h.setCookie(w, SessionCookie, token, int(se.ExpiresAt.Sub(now)/time.Second), "/", http.SameSiteLaxMode)
	return nil
}

// authenticate resolves the session cookie (nil when anonymous). It slides
// the session lifetime at most every 5 minutes.
func (h *Hub) authenticate(w http.ResponseWriter, r *http.Request) *principal {
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" || len(c.Value) > 128 {
		return nil
	}
	hsh := sha(c.Value)
	se, err := h.store.GetSession(r.Context(), hsh)
	now := h.now()
	if err != nil || !se.Live(now) {
		return nil
	}
	u, err := h.store.GetUser(r.Context(), se.UserID)
	if err != nil {
		return nil
	}
	if se.RoleCap != "" && store.RoleRank(se.RoleCap) < store.RoleRank(u.Role) {
		u.Role = se.RoleCap
	}
	if now.Sub(se.LastSeenAt) > 5*time.Minute {
		exp := now.Add(h.cfg.SessionLifetime)
		if !se.AbsoluteExpiresAt.IsZero() && exp.After(se.AbsoluteExpiresAt) {
			exp = se.AbsoluteExpiresAt
		}
		if err := h.store.TouchSession(r.Context(), hsh, now, exp); err == nil && w != nil {
			h.setCookie(w, SessionCookie, c.Value, int(exp.Sub(now)/time.Second), "/", http.SameSiteLaxMode)
		}
	}
	return &principal{user: u, session: se, tokenHsh: hsh}
}

// errReauth asks the browser to confirm the user's credentials (the UI shows
// a dialog and retries the request).
var errReauth = apiErr(http.StatusForbidden, "reauth_required", "Confirm it's you to continue.")

// requireReauth refuses sensitive actions unless the session proved its
// credentials within the re-authentication window (sign-in, password or
// passkey). Kiosk sessions never qualify.
func (h *Hub) requireReauth(p *principal) error {
	if p != nil && p.service != nil {
		return nil // the Whombat server confirms with the person itself (approvals)
	}
	if p == nil || p.session.Kiosk || p.token != nil {
		if p != nil && p.token != nil && !p.session.Kiosk {
			return nil // API tokens are credentials themselves
		}
		return errReauth
	}
	if p.session.ReauthAt.IsZero() || h.now().Sub(p.session.ReauthAt) > h.cfg.ReauthWindow {
		return errReauth
	}
	return nil
}

// apiReauth is POST /auth/reauth {password}: confirms the session's user
// (sensitive actions accept the session for ReauthWindow afterwards).
func (h *Hub) apiReauth(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.session.Kiosk || p.token != nil {
		return errForbidden
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	done, err := h.credentialAttempt(clientIP(r), p.user.Username)
	if err != nil {
		return err
	}
	ok := p.user.PasswordHash != "" && VerifyPassword(req.Password, p.user.PasswordHash)
	done(ok)
	if !ok {
		h.auditReq(r, p, store.AuditRecord{Event: "auth.reauth", Outcome: "denied", Code: "invalid_credentials"})
		return apiErr(http.StatusForbidden, "invalid_credentials", "The password is wrong.")
	}
	if err := h.store.SetReauth(r.Context(), p.tokenHsh, h.now()); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "auth.reauth", Outcome: "ok", Details: map[string]string{"method": "password"}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// checkCSRF validates X-CSRF-Token: bound to the session when signed in,
// else equal to the pre-session cookie (double submit) for setup / login.
func (h *Hub) checkCSRF(r *http.Request, p *principal) bool {
	tok := r.Header.Get("X-CSRF-Token")
	if tok == "" {
		return false
	}
	if p != nil {
		return subtle.ConstantTimeCompare([]byte(tok), []byte(p.session.CSRF)) == 1
	}
	c, err := r.Cookie(preCSRFCookie)
	return err == nil && c.Value != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(c.Value)) == 1
}

// ---- endpoints ------------------------------------------------------------------------

type authUser struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

func (h *Hub) apiAuthState(w http.ResponseWriter, r *http.Request, p *principal) error {
	out := map[string]any{
		"setup_required": h.setupRequired(r.Context()), "authenticated": p != nil, "user": nil, "passkeys": 0,
		"passkeys_available": h.webauthn != nil,
	}
	if h.oidc != nil {
		out["oidc"] = map[string]string{"name": h.oidc.cfg.Name}
	}
	if p != nil {
		out["user"] = authUser{Name: p.user.Username, Role: p.user.Role}
		out["csrf_token"] = p.session.CSRF
		out["kiosk"] = p.session.Kiosk
		out["has_password"] = p.user.PasswordHash != ""
		out["source"] = p.user.Source
		out["password_change_required"] = p.user.MustChangePassword && !p.session.Kiosk && p.token == nil
		if pk, err := h.store.ListPasskeys(r.Context(), p.user.ID); err == nil {
			out["passkeys"] = len(pk)
		}
	} else {
		tok := ""
		if c, err := r.Cookie(preCSRFCookie); err == nil && len(c.Value) >= 16 && len(c.Value) <= 64 {
			tok = c.Value
		} else {
			tok = randToken(24)
		}
		h.setCookie(w, preCSRFCookie, tok, 3600, "/api/v1/auth", http.SameSiteStrictMode)
		out["csrf_token"] = tok
	}
	w.Header().Set("Cache-Control", "no-store")
	b, _ := json.Marshal(out)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, err := w.Write(append(b, '\n'))
	return err
}

func (h *Hub) apiSetup(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		SetupToken string `json:"setup_token"`
		Username   string `json:"username"`
		Password   string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	done, err := h.credentialAttempt(clientIP(r))
	if err != nil {
		return err
	}
	ok := false
	defer func() { done(ok) }()
	h.setupMu.Lock()
	want := h.setupTokenHash
	h.setupMu.Unlock()
	if want == nil {
		return apiErr(http.StatusConflict, "setup_done", "The account already exists.")
	}
	if subtle.ConstantTimeCompare(sha(req.SetupToken), want) != 1 {
		h.auditUser(r, cleanText(req.Username, 64), "", store.AuditRecord{Event: "auth.setup", Outcome: "denied", Code: "invalid_setup_token"})
		return apiErr(http.StatusForbidden, "invalid_setup_token", "The setup token is wrong. It is printed in the hub log.")
	}
	ok = true
	if err := ValidateCredentials(req.Username, req.Password); err != nil {
		return err
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		return err
	}
	wid := make([]byte, 32)
	_, _ = rand.Read(wid)
	now := h.now()
	id, err := h.store.CreateUser(r.Context(), store.User{Username: req.Username, Role: store.RoleAdmin, PasswordHash: hash,
		WebAuthnID: wid, CreatedAt: now}, true)
	if errors.Is(err, store.ErrConflict) {
		return apiErr(http.StatusConflict, "setup_done", "The account already exists.")
	}
	if err != nil {
		return err
	}
	h.setupMu.Lock()
	h.setupTokenHash = nil
	h.setupMu.Unlock()
	h.log.Info("admin account created", "user", req.Username)
	h.auditUser(r, req.Username, store.RoleAdmin, store.AuditRecord{Event: "auth.setup", Outcome: "ok"})
	if err := h.newSession(w, r, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h *Hub) apiLogin(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	done, err := h.credentialAttempt(clientIP(r), req.Username)
	if err != nil {
		return err
	}
	u, err := h.store.GetUserByName(r.Context(), req.Username)
	ok := false
	if err == nil && u.PasswordHash != "" {
		ok = VerifyPassword(req.Password, u.PasswordHash)
	} else {
		VerifyPassword(req.Password, dummyHash)
	}
	done(ok)
	if !ok {
		h.auditUser(r, cleanText(req.Username, 64), "", store.AuditRecord{Event: "auth.login", Outcome: "denied",
			Code: "invalid_credentials"})
		return apiErr(http.StatusUnauthorized, "invalid_credentials", "Wrong user name or password.")
	}
	if err := h.newSession(w, r, u.ID); err != nil {
		return err
	}
	h.auditUser(r, u.Username, u.Role, store.AuditRecord{Event: "auth.login", Outcome: "ok", Details: map[string]string{"method": "password"}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h *Hub) apiLogout(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p != nil {
		if err := h.store.DeleteSession(r.Context(), p.tokenHsh); err != nil {
			h.log.Error("logout: session not deleted", "user", p.user.Username, "err", err)
		}
		hsh := string(p.tokenHsh)
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.sessionHash == hsh }, "revoked")
		h.auditReq(r, p, store.AuditRecord{Event: "auth.logout", Outcome: "ok"})
	}
	h.setCookie(w, SessionCookie, "", -1, "/", http.SameSiteLaxMode)
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// browserOnly refuses API tokens and kiosk sessions for account changes.
func browserOnly(p *principal) error {
	if p == nil || p.token != nil || p.session.Kiosk {
		return errForbidden
	}
	return nil
}

func (h *Hub) apiChangePassword(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	var req struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	// Replacing a temporary password: the session proved it at sign-in
	// (recently enough), so the current one is not asked again.
	forced := req.Current == "" && p.user.MustChangePassword
	if forced {
		if err := h.requireReauth(p); err != nil {
			return err
		}
	} else {
		done, err := h.credentialAttempt(clientIP(r), p.user.Username)
		if err != nil {
			return err
		}
		okCurrent := p.user.PasswordHash != "" && VerifyPassword(req.Current, p.user.PasswordHash)
		done(okCurrent)
		if !okCurrent {
			h.auditReq(r, p, store.AuditRecord{Event: "auth.password_changed", Outcome: "denied", Code: "invalid_credentials"})
			return apiErr(http.StatusForbidden, "invalid_credentials", "The current password is wrong.")
		}
	}
	if err := ValidateCredentials(p.user.Username, req.New); err != nil {
		return err
	}
	if forced && VerifyPassword(req.New, p.user.PasswordHash) {
		return apiErr(http.StatusBadRequest, "same_password", "Choose a password different from the temporary one.")
	}
	hash, err := HashPassword(req.New)
	if err != nil {
		return err
	}
	if err := h.store.SetPassword(r.Context(), p.user.ID, hash, h.now()); err != nil {
		return err
	}
	// Sign out every other session of the account. If that fails the
	// request fails: the user must not believe the other sessions are gone.
	if err := h.store.DeleteUserSessions(r.Context(), p.user.ID, p.tokenHsh); err != nil {
		return fmt.Errorf("signing out the other sessions: %w", err)
	}
	uid, keep := p.user.ID, string(p.tokenHsh)
	h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.userID == uid && cs.sessionHash != keep }, "revoked")
	h.auditReq(r, p, store.AuditRecord{Event: "auth.password_changed", Outcome: "ok"})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---- passkeys -----------------------------------------------------------------------

type waUser struct {
	u     store.User
	creds []webauthn.Credential
}

func (u *waUser) WebAuthnID() []byte                         { return u.u.WebAuthnID }
func (u *waUser) WebAuthnName() string                       { return u.u.Username }
func (u *waUser) WebAuthnDisplayName() string                { return u.u.Username }
func (u *waUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func (h *Hub) loadWAUser(ctx context.Context, u store.User) (*waUser, error) {
	pks, err := h.store.ListPasskeys(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	wu := &waUser{u: u}
	for _, pk := range pks {
		var c webauthn.Credential
		if err := json.Unmarshal(pk.Credential, &c); err == nil {
			wu.creds = append(wu.creds, c)
		}
	}
	return wu, nil
}

type ceremony struct {
	data    webauthn.SessionData
	userID  int64 // 0 for login
	name    string
	expires time.Time
}

type ceremonyStore struct {
	mu sync.Mutex
	m  map[string]*ceremony
}

func newCeremonyStore() *ceremonyStore { return &ceremonyStore{m: map[string]*ceremony{}} }

// maxCeremonies bounds pending WebAuthn ceremonies (anonymous login/begin).
const maxCeremonies = 1000

func (c *ceremonyStore) put(cer *ceremony) (string, bool) {
	id := randToken(24)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= maxCeremonies {
		c.pruneLocked()
		if len(c.m) >= maxCeremonies {
			return "", false
		}
	}
	c.m[id] = cer
	return id, true
}

func (c *ceremonyStore) take(id string) *ceremony {
	c.mu.Lock()
	defer c.mu.Unlock()
	cer := c.m[id]
	delete(c.m, id)
	if cer == nil || time.Now().After(cer.expires) {
		return nil
	}
	return cer
}

func (c *ceremonyStore) prune() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked()
}

func (c *ceremonyStore) pruneLocked() {
	for k, v := range c.m {
		if time.Now().After(v.expires) {
			delete(c.m, k)
		}
	}
}

var errNoPasskeys = apiErr(http.StatusConflict, "passkeys_unavailable",
	"Passkeys need an https --public-url with a host name.")

func (h *Hub) apiPasskeyRegisterBegin(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	if h.webauthn == nil {
		return errNoPasskeys
	}
	var req struct {
		Name string `json:"name"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
	}
	wu, err := h.loadWAUser(r.Context(), p.user)
	if err != nil {
		return err
	}
	var excl []protocol.CredentialDescriptor
	for _, c := range wu.creds {
		excl = append(excl, c.Descriptor())
	}
	creation, sd, err := h.webauthn.BeginRegistration(wu,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired), webauthn.WithExclusions(excl))
	if err != nil {
		return apiErr(http.StatusBadRequest, "webauthn", err.Error())
	}
	name := cleanText(req.Name, 64)
	if name == "" {
		name = "Passkey " + h.now().UTC().Format("2006-01-02")
	}
	id, ok := h.ceremonies.put(&ceremony{data: *sd, userID: p.user.ID, name: name, expires: h.now().Add(5 * time.Minute)})
	if !ok {
		return rateLimited(time.Minute)
	}
	h.setCookie(w, ceremonyCookie, id, 300, "/api/v1/auth", http.SameSiteStrictMode)
	writeJSON(w, r, http.StatusOK, creation)
	return nil
}

func (h *Hub) takeCeremony(w http.ResponseWriter, r *http.Request) *ceremony {
	c, err := r.Cookie(ceremonyCookie)
	h.setCookie(w, ceremonyCookie, "", -1, "/api/v1/auth", http.SameSiteStrictMode)
	if err != nil {
		return nil
	}
	return h.ceremonies.take(c.Value)
}

func (h *Hub) apiPasskeyRegisterFinish(w http.ResponseWriter, r *http.Request, p *principal) error {
	if h.webauthn == nil {
		return errNoPasskeys
	}
	cer := h.takeCeremony(w, r)
	if cer == nil || cer.userID != p.user.ID {
		return apiErr(http.StatusBadRequest, "ceremony_expired", "Start the passkey registration again.")
	}
	wu, err := h.loadWAUser(r.Context(), p.user)
	if err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	cred, err := h.webauthn.FinishRegistration(wu, cer.data, r)
	if err != nil {
		return apiErr(http.StatusBadRequest, "webauthn", "Passkey registration failed.")
	}
	b, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := h.store.AddPasskey(r.Context(), store.Passkey{ID: cred.ID, UserID: p.user.ID, Name: cer.name, Credential: b,
		CreatedAt: h.now()}); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "auth.passkey_added", Outcome: "ok", Details: map[string]string{"name": cer.name}})
	writeJSON(w, r, http.StatusCreated, map[string]string{"id": base64.RawURLEncoding.EncodeToString(cred.ID), "name": cer.name})
	return nil
}

func (h *Hub) apiPasskeyLoginBegin(w http.ResponseWriter, r *http.Request, p *principal) error {
	if h.webauthn == nil {
		return errNoPasskeys
	}
	// Anonymous: bound per address so one client cannot fill the store of
	// pending ceremonies and block passkey sign-in for everyone.
	if !h.limits.passkeyBegin.take(clientIP(r)) {
		return rateLimited(time.Minute)
	}
	assertion, sd, err := h.webauthn.BeginDiscoverableLogin()
	if err != nil {
		return apiErr(http.StatusBadRequest, "webauthn", err.Error())
	}
	id, ok := h.ceremonies.put(&ceremony{data: *sd, expires: h.now().Add(5 * time.Minute)})
	if !ok {
		return rateLimited(time.Minute)
	}
	h.setCookie(w, ceremonyCookie, id, 300, "/api/v1/auth", http.SameSiteStrictMode)
	writeJSON(w, r, http.StatusOK, assertion)
	return nil
}

func (h *Hub) apiPasskeyLoginFinish(w http.ResponseWriter, r *http.Request, p *principal) error {
	if h.webauthn == nil {
		return errNoPasskeys
	}
	done, err := h.credentialAttempt(clientIP(r))
	if err != nil {
		return err
	}
	passkeyOK := false
	defer func() { done(passkeyOK) }()
	cer := h.takeCeremony(w, r)
	if cer == nil {
		return apiErr(http.StatusBadRequest, "ceremony_expired", "Start the passkey sign-in again.")
	}
	var found *waUser
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		u, err := h.store.GetUserByWebAuthnID(r.Context(), userHandle)
		if err != nil {
			return nil, err
		}
		wu, err := h.loadWAUser(r.Context(), u)
		if err != nil {
			return nil, err
		}
		found = wu
		return wu, nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	_, cred, err := h.webauthn.FinishPasskeyLogin(handler, cer.data, r)
	if err != nil || found == nil {
		h.auditUser(r, "", "", store.AuditRecord{Event: "auth.login", Outcome: "denied", Code: "invalid_passkey",
			Details: map[string]string{"method": "passkey"}})
		return apiErr(http.StatusUnauthorized, "invalid_credentials", "The passkey was not accepted.")
	}
	if b, err := json.Marshal(cred); err == nil {
		_ = h.store.UpdatePasskeyUse(r.Context(), cred.ID, b, h.now())
	}
	passkeyOK = true
	if err := h.newSession(w, r, found.u.ID); err != nil {
		return err
	}
	h.auditUser(r, found.u.Username, found.u.Role, store.AuditRecord{Event: "auth.login", Outcome: "ok",
		Details: map[string]string{"method": "passkey"}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h *Hub) apiPasskeyList(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.session.Kiosk {
		return errForbidden
	}
	pks, err := h.store.ListPasskeys(r.Context(), p.user.ID)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, pk := range pks {
		item := map[string]any{"id": base64.RawURLEncoding.EncodeToString(pk.ID), "name": pk.Name,
			"created_at": pk.CreatedAt.UTC().Format(time.RFC3339), "last_used_at": nil}
		if !pk.LastUsedAt.IsZero() {
			item["last_used_at"] = pk.LastUsedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, item)
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) apiPasskeyDelete(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	id, err := base64.RawURLEncoding.DecodeString(r.PathValue("id"))
	if err != nil {
		return errNotFound
	}
	if err := h.store.DeletePasskey(r.Context(), p.user.ID, id); errors.Is(err, store.ErrNotFound) {
		return errNotFound
	} else if err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "auth.passkey_removed", Outcome: "ok"})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// apiPasskeyReauthBegin is POST /auth/passkey/reauth/begin: an assertion
// request limited to the signed-in user's passkeys.
func (h *Hub) apiPasskeyReauthBegin(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	if h.webauthn == nil {
		return errNoPasskeys
	}
	wu, err := h.loadWAUser(r.Context(), p.user)
	if err != nil {
		return err
	}
	if len(wu.creds) == 0 {
		return apiErr(http.StatusConflict, "no_passkeys", "This account has no passkey.")
	}
	assertion, sd, err := h.webauthn.BeginLogin(wu)
	if err != nil {
		return apiErr(http.StatusBadRequest, "webauthn", err.Error())
	}
	id, ok := h.ceremonies.put(&ceremony{data: *sd, userID: p.user.ID, expires: h.now().Add(5 * time.Minute)})
	if !ok {
		return rateLimited(time.Minute)
	}
	h.setCookie(w, ceremonyCookie, id, 300, "/api/v1/auth", http.SameSiteStrictMode)
	writeJSON(w, r, http.StatusOK, assertion)
	return nil
}

// apiPasskeyReauthFinish is POST /auth/passkey/reauth/finish.
func (h *Hub) apiPasskeyReauthFinish(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	if h.webauthn == nil {
		return errNoPasskeys
	}
	done, err := h.credentialAttempt(clientIP(r), p.user.Username)
	if err != nil {
		return err
	}
	ok := false
	defer func() { done(ok) }()
	cer := h.takeCeremony(w, r)
	if cer == nil || cer.userID != p.user.ID {
		return apiErr(http.StatusBadRequest, "ceremony_expired", "Start again.")
	}
	wu, err := h.loadWAUser(r.Context(), p.user)
	if err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	cred, err := h.webauthn.FinishLogin(wu, cer.data, r)
	if err != nil {
		h.auditReq(r, p, store.AuditRecord{Event: "auth.reauth", Outcome: "denied", Code: "invalid_passkey",
			Details: map[string]string{"method": "passkey"}})
		return apiErr(http.StatusForbidden, "invalid_credentials", "The passkey was not accepted.")
	}
	if b, err := json.Marshal(cred); err == nil {
		_ = h.store.UpdatePasskeyUse(r.Context(), cred.ID, b, h.now())
	}
	ok = true
	if err := h.store.SetReauth(r.Context(), p.tokenHsh, h.now()); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "auth.reauth", Outcome: "ok", Details: map[string]string{"method": "passkey"}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
