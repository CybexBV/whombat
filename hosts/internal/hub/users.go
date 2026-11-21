package hub

// User management (Settings › Users, admins): list, add, change role, reset
// the password, sign out, delete. Changes need a recent sign-in, are made
// from a browser session (not API tokens or kiosk sessions) and are
// audited. The last admin can be neither demoted nor deleted, and admins
// change their own account on the Account page, not here.
//
// Passwords: adding a password account or resetting a password returns a
// generated temporary password once; it must be replaced at the next
// sign-in (every other request answers 403 password_change_required until
// then). A reset also signs the account out everywhere. Single sign-on
// accounts have no password.
//
// Effects on live sessions: deleting an account, a reset and "sign out"
// end its sessions, consoles and event streams at once; a role change
// applies to the next request, ends the event streams (they reconnect with
// the new role) and closes consoles the new role may not hold.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/store"
)

type userJSON struct {
	ID                 int64   `json:"id"`
	Name               string  `json:"name"`
	Role               string  `json:"role"`
	Source             string  `json:"source"`
	CreatedAt          string  `json:"created_at"`
	LastLoginAt        *string `json:"last_login_at"`
	Passkeys           int     `json:"passkeys"`
	Sessions           int     `json:"sessions"`
	HasPassword        bool    `json:"has_password"`
	MustChangePassword bool    `json:"must_change_password"`
	// OIDCLinked: a single sign-on account that has signed in (an admin
	// created it by name; the provider's subject is linked at first use).
	OIDCLinked bool `json:"oidc_linked"`
	// RoleManaged: the role follows the provider (--oidc-role-claim).
	RoleManaged bool `json:"role_managed"`
	Self        bool `json:"self"`
}

func (h *Hub) toUserJSON(u store.User, st store.UserStat, self int64) userJSON {
	return userJSON{ID: u.ID, Name: u.Username, Role: u.Role, Source: u.Source, CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339),
		LastLoginAt: tsp(u.LastLoginAt), Passkeys: st.Passkeys, Sessions: st.Sessions, HasPassword: u.PasswordHash != "",
		MustChangePassword: u.MustChangePassword, OIDCLinked: u.OIDCSubject != "",
		RoleManaged: u.Source == store.SourceOIDC && h.oidc != nil && h.oidc.cfg.RoleClaim != "", Self: u.ID == self}
}

var (
	errUserNotFound = apiErr(http.StatusNotFound, "user_not_found", "No such user.")
	errLastAdmin    = apiErr(http.StatusConflict, "last_admin", "Rackoon needs at least one admin.")
	errSelf         = apiErr(http.StatusConflict, "self", "Change your own account on the Account page; another admin can change your role.")
)

// userTarget resolves {id} for a change by p (browser session, re-authenticated).
func (h *Hub) userTarget(r *http.Request, p *principal) (store.User, error) {
	if err := browserOnly(p); err != nil {
		return store.User{}, err
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return store.User{}, errUserNotFound
	}
	u, err := h.store.GetUser(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		return u, errUserNotFound
	}
	return u, err
}

// endUserSessions closes the live consoles and event streams of a user
// whose sessions were deleted (keep: one session that stays, or nil).
func (h *Hub) endUserSessions(uid int64, keep []byte) {
	k := string(keep)
	h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.userID == uid && (k == "" || cs.sessionHash != k) }, "revoked")
	h.bus.DropUser(uid)
}

// temporaryPassword is a generated password handed to the user out of band.
func temporaryPassword() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	s := hex.EncodeToString(b) // 24 hex digits, 96 bits, easy to read out
	return s[0:6] + "-" + s[6:12] + "-" + s[12:18] + "-" + s[18:24]
}

// apiUsers is GET /users: every account with its passkey and session counts.
func (h *Hub) apiUsers(w http.ResponseWriter, r *http.Request, p *principal) error {
	users, err := h.store.ListUsers(r.Context())
	if err != nil {
		return err
	}
	stats, err := h.store.UserStats(r.Context(), h.now())
	if err != nil {
		return err
	}
	out := make([]userJSON, 0, len(users))
	for _, u := range users {
		out = append(out, h.toUserJSON(u, stats[u.ID], p.user.ID))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiCreateUser is POST /users {name, role, source}: source "local" (the
// default) returns a temporary password once; "oidc" creates an account
// that signs in with single sign-on (linked by name at the first sign-in).
func (h *Hub) apiCreateUser(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := browserOnly(p); err != nil {
		return err
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var req struct {
		Name   string `json:"name"`
		Role   string `json:"role"`
		Source string `json:"source"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	if !usernameRE.MatchString(req.Name) {
		return apiErr(http.StatusBadRequest, "invalid_username", "User names are 1 to 64 letters, digits, '.', '_', '@' or '-'.")
	}
	if store.RoleRank(req.Role) < 0 {
		return apiErr(http.StatusBadRequest, "invalid_role", "role must be viewer, operator or admin.")
	}
	switch req.Source {
	case "", store.SourceLocal:
		req.Source = store.SourceLocal
	case store.SourceOIDC:
		if h.oidc == nil {
			return apiErr(http.StatusBadRequest, "oidc_disabled", "Single sign-on is not configured on this hub.")
		}
	default:
		return apiErr(http.StatusBadRequest, "invalid_source", "source must be local or oidc.")
	}
	wid := make([]byte, 32)
	_, _ = rand.Read(wid)
	u := store.User{Username: req.Name, Role: req.Role, WebAuthnID: wid, CreatedAt: h.now(), Source: req.Source}
	temp := ""
	if req.Source == store.SourceLocal {
		temp = temporaryPassword()
		hash, err := HashPassword(temp)
		if err != nil {
			return err
		}
		u.PasswordHash, u.MustChangePassword = hash, true
	}
	id, err := h.store.CreateUser(r.Context(), u, false)
	if errors.Is(err, store.ErrConflict) {
		return apiErr(http.StatusConflict, "user_exists", "A user with this name exists.")
	}
	if err != nil {
		return err
	}
	u.ID = id
	h.auditReq(r, p, store.AuditRecord{Event: "user.created", Outcome: "ok",
		Details: map[string]string{"username": u.Username, "role": u.Role, "source": u.Source}})
	out := map[string]any{"user": h.toUserJSON(u, store.UserStat{}, p.user.ID)}
	if temp != "" {
		out["temporary_password"] = temp
	}
	writeJSON(w, r, http.StatusCreated, out)
	return nil
}

// apiPatchUser is PATCH /users/{id} {role?, reset_password?}: a reset
// returns a temporary password once and signs the user out everywhere.
func (h *Hub) apiPatchUser(w http.ResponseWriter, r *http.Request, p *principal) error {
	u, err := h.userTarget(r, p)
	if err != nil {
		return err
	}
	var req struct {
		Role          *string `json:"role"`
		ResetPassword bool    `json:"reset_password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Role == nil && !req.ResetPassword {
		return apiErr(http.StatusBadRequest, "bad_request", "Give a role or reset_password.")
	}
	if u.ID == p.user.ID {
		return errSelf
	}
	if req.Role != nil {
		if store.RoleRank(*req.Role) < 0 {
			return apiErr(http.StatusBadRequest, "invalid_role", "role must be viewer, operator or admin.")
		}
		if *req.Role != u.Role && u.Source == store.SourceOIDC && h.oidc != nil && h.oidc.cfg.RoleClaim != "" {
			return apiErr(http.StatusConflict, "role_managed", "This user's role comes from the single sign-on provider.")
		}
	}
	if req.ResetPassword && u.Source != store.SourceLocal {
		return apiErr(http.StatusConflict, "no_password", "This user signs in with single sign-on and has no password.")
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	ctx := r.Context()
	if req.Role != nil && *req.Role != u.Role {
		if err := h.store.SetRole(ctx, u.ID, *req.Role); errors.Is(err, store.ErrLastAdmin) {
			return errLastAdmin
		} else if errors.Is(err, store.ErrNotFound) {
			return errUserNotFound
		} else if err != nil {
			return err
		}
		h.auditReq(r, p, store.AuditRecord{Event: "user.role_changed", Outcome: "ok",
			Details: map[string]string{"username": u.Username, "from": u.Role, "to": *req.Role}})
		u.Role = *req.Role
		// Streams carry the role they were opened with; consoles need operator.
		h.bus.DropUser(u.ID)
		h.reauthorizeConsoles(ctx)
	}
	temp := ""
	if req.ResetPassword {
		temp = temporaryPassword()
		hash, err := HashPassword(temp)
		if err != nil {
			return err
		}
		if err := h.store.ResetPassword(ctx, u.ID, hash, h.now()); errors.Is(err, store.ErrNotFound) {
			return errUserNotFound
		} else if err != nil {
			return err
		}
		h.endUserSessions(u.ID, nil)
		u.MustChangePassword = true
		h.auditReq(r, p, store.AuditRecord{Event: "user.password_reset", Outcome: "ok",
			Details: map[string]string{"username": u.Username}})
	}
	stats, err := h.store.UserStats(ctx, h.now())
	if err != nil {
		return err
	}
	out := map[string]any{"user": h.toUserJSON(u, stats[u.ID], p.user.ID)}
	if temp != "" {
		out["temporary_password"] = temp
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiDeleteUser is DELETE /users/{id}: the account with its sessions,
// passkeys and API tokens.
func (h *Hub) apiDeleteUser(w http.ResponseWriter, r *http.Request, p *principal) error {
	u, err := h.userTarget(r, p)
	if err != nil {
		return err
	}
	if u.ID == p.user.ID {
		return errSelf
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	if err := h.store.DeleteUser(r.Context(), u.ID); errors.Is(err, store.ErrLastAdmin) {
		return errLastAdmin
	} else if errors.Is(err, store.ErrNotFound) {
		return errUserNotFound
	} else if err != nil {
		return err
	}
	h.endUserSessions(u.ID, nil)
	h.auditReq(r, p, store.AuditRecord{Event: "user.deleted", Outcome: "ok",
		Details: map[string]string{"username": u.Username, "role": u.Role}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// sessionID is the public id of a session: the start of its hash.
func sessionID(hash []byte) string {
	if len(hash) < 8 {
		return hex.EncodeToString(hash)
	}
	return hex.EncodeToString(hash[:8])
}

// apiUserSessions is GET /users/{id}/sessions: the user's live browser
// sessions (kiosk sessions included).
func (h *Hub) apiUserSessions(w http.ResponseWriter, r *http.Request, p *principal) error {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return errUserNotFound
	}
	if _, err := h.store.GetUser(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		return errUserNotFound
	} else if err != nil {
		return err
	}
	list, err := h.store.ListUserSessions(r.Context(), id)
	if err != nil {
		return err
	}
	now := h.now()
	out := []map[string]any{}
	for _, se := range list {
		if !se.Live(now) {
			continue
		}
		out = append(out, map[string]any{"id": sessionID(se.IDHash), "created_at": tsp(se.CreatedAt),
			"last_seen_at": tsp(se.LastSeenAt), "expires_at": tsp(se.ExpiresAt), "ip": se.IP, "user_agent": se.UserAgent,
			"kiosk": se.Kiosk, "current": p.token == nil && string(se.IDHash) == string(p.tokenHsh)})
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiRevokeUserSessions is DELETE /users/{id}/sessions[/{sid}]: signs the
// user out everywhere, or of one session. Your own current session stays.
func (h *Hub) apiRevokeUserSessions(w http.ResponseWriter, r *http.Request, p *principal) error {
	u, err := h.userTarget(r, p)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var keep []byte
	if u.ID == p.user.ID {
		keep = p.tokenHsh
	}
	n := 0
	if sid := r.PathValue("sid"); sid != "" {
		list, err := h.store.ListUserSessions(ctx, u.ID)
		if err != nil {
			return err
		}
		var hash []byte
		for _, se := range list {
			if sessionID(se.IDHash) == sid {
				hash = se.IDHash
			}
		}
		if hash == nil {
			return apiErr(http.StatusNotFound, "session_not_found", "No such session.")
		}
		if keep != nil && string(hash) == string(keep) {
			return apiErr(http.StatusConflict, "current_session", "This is your current session; sign out instead.")
		}
		if err := h.store.DeleteSession(ctx, hash); err != nil {
			return err
		}
		hs := string(hash)
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.sessionHash == hs }, "revoked")
		h.bus.DropUser(u.ID)
		n = 1
	} else {
		if list, err := h.store.ListUserSessions(ctx, u.ID); err == nil {
			n = len(list)
			if keep != nil && n > 0 {
				n--
			}
		}
		if err := h.store.DeleteUserSessions(ctx, u.ID, keep); err != nil {
			return err
		}
		h.endUserSessions(u.ID, keep)
	}
	h.auditReq(r, p, store.AuditRecord{Event: "user.signed_out", Outcome: "ok",
		Details: map[string]string{"username": u.Username, "sessions": strconv.Itoa(n)}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
