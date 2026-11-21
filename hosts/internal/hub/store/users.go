package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Roles.
const (
	RoleViewer   = "viewer"
	RoleOperator = "operator"
	RoleAdmin    = "admin"
)

// RoleRank orders roles (viewer < operator < admin); unknown roles rank -1.
func RoleRank(role string) int {
	switch role {
	case RoleViewer:
		return 0
	case RoleOperator:
		return 1
	case RoleAdmin:
		return 2
	}
	return -1
}

// User is a web UI account.
type User struct {
	ID                int64
	Username          string
	Role              string
	PasswordHash      string // "" for accounts that sign in with OIDC only
	WebAuthnID        []byte
	CreatedAt         time.Time
	PasswordChangedAt time.Time
	Source            string // local | oidc
	OIDCSubject       string // issuer-scoped subject of an OIDC account
	LastLoginAt       time.Time
	// MustChangePassword: the password is a temporary one set by an admin;
	// the user must choose a new one before doing anything else.
	MustChangePassword bool
}

// Account sources.
const (
	SourceLocal = "local"
	SourceOIDC  = "oidc"
)

// ErrLastAdmin refuses to delete or demote the last admin account.
var ErrLastAdmin = errors.New("last admin")

const userCols = `id, username, role, password_hash, webauthn_id, created_at, password_changed_at, source, oidc_subject,
	last_login_at, must_change_password`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var ca, pa, la int64
	err := row.Scan(&u.ID, &u.Username, &u.Role, &u.PasswordHash, &u.WebAuthnID, &ca, &pa, &u.Source, &u.OIDCSubject, &la,
		&u.MustChangePassword)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	u.CreatedAt, u.PasswordChangedAt, u.LastLoginAt = fromMS(ca), fromMS(pa), fromMS(la)
	return u, err
}

// CountUsers returns the number of accounts.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser adds an account. With onlyIfNone, it fails with ErrConflict
// when any account exists (first-run setup).
func (s *Store) CreateUser(ctx context.Context, u User, onlyIfNone bool) (int64, error) {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var n int
	q := `SELECT COUNT(*) FROM users WHERE username = ?`
	args := []any{u.Username}
	if onlyIfNone {
		q, args = `SELECT COUNT(*) FROM users`, nil
	}
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0, err
	}
	if n > 0 {
		return 0, ErrConflict
	}
	if u.Source == "" {
		u.Source = SourceLocal
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO users(username, role, password_hash, webauthn_id, created_at, password_changed_at,
		source, oidc_subject, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, u.Username, u.Role, u.PasswordHash,
		u.WebAuthnID, ms(u.CreatedAt), ms(u.CreatedAt), u.Source, u.OIDCSubject, b2i(u.MustChangePassword))
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

// GetUser returns an account by id.
func (s *Store) GetUser(ctx context.Context, id int64) (User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// GetUserByName returns an account by user name (case-insensitive).
func (s *Store) GetUserByName(ctx context.Context, name string) (User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = ?`, name))
}

// GetUserByWebAuthnID returns the account with the given WebAuthn user handle.
func (s *Store) GetUserByWebAuthnID(ctx context.Context, wid []byte) (User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE webauthn_id = ?`, wid))
}

// ListUsers returns all accounts.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetPassword replaces an account's password hash (a password the user
// chose: it ends "must change the password").
func (s *Store) SetPassword(ctx context.Context, id int64, hash string, now time.Time) error {
	res, err := s.w.ExecContext(ctx, `UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0
		WHERE id = ?`, hash, ms(now), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ResetPassword sets a temporary password that must be changed at the next
// sign-in and signs the account out everywhere, in one transaction.
func (s *Store) ResetPassword(ctx context.Context, id int64, hash string, now time.Time) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 1
		WHERE id = ?`, hash, ms(now), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// TouchLogin records a sign-in.
func (s *Store) TouchLogin(ctx context.Context, id int64, at time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE users SET last_login_at = ? WHERE id = ?`, ms(at), id)
	return err
}

// lastAdminGuard fails with ErrLastAdmin when the account is the only admin
// (call inside the transaction that demotes or deletes it).
func lastAdminGuard(ctx context.Context, tx *sql.Tx, id int64) error {
	var role string
	err := tx.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ?`, id).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil || role != RoleAdmin {
		return err
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = ?`, RoleAdmin).Scan(&n); err != nil {
		return err
	}
	if n <= 1 {
		return ErrLastAdmin
	}
	return nil
}

// SetRole changes an account's role. Demoting the last admin fails with
// ErrLastAdmin.
func (s *Store) SetRole(ctx context.Context, id int64, role string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if role != RoleAdmin {
		if err := lastAdminGuard(ctx, tx, id); err != nil {
			return err
		}
	}
	res, err := tx.ExecContext(ctx, `UPDATE users SET role = ? WHERE id = ?`, role, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// Session is a browser session (the cookie value is never stored, only its
// SHA-256).
type Session struct {
	IDHash     []byte
	UserID     int64
	CSRF       string
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time // sliding
	// AbsoluteExpiresAt ends the session however active it is (zero: none,
	// sessions from before the column existed).
	AbsoluteExpiresAt time.Time
	// ReauthAt is when the user last proved their credentials in this
	// session (sign-in or a re-authentication); sensitive actions need it
	// to be recent.
	ReauthAt  time.Time
	RoleCap   string // the session's role is at most this ("" = the user's role)
	Kiosk     bool   // created from a kiosk link
	TokenID   string // the API token a kiosk session was made from
	IP        string
	UserAgent string
}

const sessionCols = `id_hash, user_id, csrf, created_at, last_seen_at, expires_at, absolute_expires_at, reauth_at,
	role_cap, kiosk, token_id, ip, user_agent`

// CreateSession stores a session.
func (s *Store) CreateSession(ctx context.Context, se Session) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO sessions(`+sessionCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		se.IDHash, se.UserID, se.CSRF, ms(se.CreatedAt), ms(se.LastSeenAt), ms(se.ExpiresAt), ms(se.AbsoluteExpiresAt),
		ms(se.ReauthAt), se.RoleCap, b2i(se.Kiosk), se.TokenID, se.IP, se.UserAgent)
	return err
}

// GetSession returns a session by the hash of its cookie value.
func (s *Store) GetSession(ctx context.Context, idHash []byte) (Session, error) {
	var se Session
	var ca, la, ea, aa, ra int64
	err := s.r.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE id_hash = ?`, idHash).Scan(
		&se.IDHash, &se.UserID, &se.CSRF, &ca, &la, &ea, &aa, &ra, &se.RoleCap, &se.Kiosk, &se.TokenID, &se.IP, &se.UserAgent)
	if errors.Is(err, sql.ErrNoRows) {
		return se, ErrNotFound
	}
	se.CreatedAt, se.LastSeenAt, se.ExpiresAt = fromMS(ca), fromMS(la), fromMS(ea)
	se.AbsoluteExpiresAt, se.ReauthAt = fromMS(aa), fromMS(ra)
	return se, err
}

// Live reports whether a session is valid at now.
func (se Session) Live(now time.Time) bool {
	return now.Before(se.ExpiresAt) && (se.AbsoluteExpiresAt.IsZero() || now.Before(se.AbsoluteExpiresAt))
}

// SetReauth records a re-authentication.
func (s *Store) SetReauth(ctx context.Context, idHash []byte, at time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE sessions SET reauth_at = ? WHERE id_hash = ?`, ms(at), idHash)
	return err
}

// ListUserSessions returns a user's sessions, newest first.
func (s *Store) ListUserSessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var se Session
		var ca, la, ea, aa, ra int64
		if err := rows.Scan(&se.IDHash, &se.UserID, &se.CSRF, &ca, &la, &ea, &aa, &ra, &se.RoleCap, &se.Kiosk, &se.TokenID, &se.IP, &se.UserAgent); err != nil {
			return nil, err
		}
		se.CreatedAt, se.LastSeenAt, se.ExpiresAt = fromMS(ca), fromMS(la), fromMS(ea)
		se.AbsoluteExpiresAt, se.ReauthAt = fromMS(aa), fromMS(ra)
		out = append(out, se)
	}
	return out, rows.Err()
}

// TouchSession extends a session (sliding lifetime).
func (s *Store) TouchSession(ctx context.Context, idHash []byte, lastSeen, expires time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?`, ms(lastSeen), ms(expires), idHash)
	return err
}

// DeleteSession removes a session.
func (s *Store) DeleteSession(ctx context.Context, idHash []byte) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM sessions WHERE id_hash = ?`, idHash)
	return err
}

// DeleteUserSessions removes all sessions of a user except one (nil: all).
func (s *Store) DeleteUserSessions(ctx context.Context, userID int64, except []byte) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND id_hash != ?`, userID, append([]byte{}, except...))
	return err
}

// DeleteExpiredSessions removes expired sessions.
func (s *Store) DeleteExpiredSessions(ctx context.Context, now time.Time) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ? OR (absolute_expires_at > 0 AND absolute_expires_at <= ?)`,
		ms(now), ms(now))
	return err
}

// Passkey is a registered WebAuthn credential.
type Passkey struct {
	ID         []byte
	UserID     int64
	Name       string
	Credential []byte // JSON of webauthn.Credential
	CreatedAt  time.Time
	LastUsedAt time.Time
}

// AddPasskey stores a credential.
func (s *Store) AddPasskey(ctx context.Context, p Passkey) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO passkeys(id, user_id, name, credential, created_at) VALUES (?, ?, ?, ?, ?)`,
		p.ID, p.UserID, p.Name, p.Credential, ms(p.CreatedAt))
	return err
}

// ListPasskeys returns a user's credentials.
func (s *Store) ListPasskeys(ctx context.Context, userID int64) ([]Passkey, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, user_id, name, credential, created_at, COALESCE(last_used_at, 0)
		FROM passkeys WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Passkey
	for rows.Next() {
		var p Passkey
		var ca, la int64
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.Credential, &ca, &la); err != nil {
			return nil, err
		}
		p.CreatedAt, p.LastUsedAt = fromMS(ca), fromMS(la)
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdatePasskeyUse stores the updated credential (sign count) after a login.
func (s *Store) UpdatePasskeyUse(ctx context.Context, id, credential []byte, now time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE passkeys SET credential = ?, last_used_at = ? WHERE id = ?`, credential, ms(now), id)
	return err
}

// DeletePasskey removes a credential of a user.
func (s *Store) DeletePasskey(ctx context.Context, userID int64, id []byte) error {
	res, err := s.w.ExecContext(ctx, `DELETE FROM passkeys WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetUserByOIDC returns the account linked to an OIDC subject.
func (s *Store) GetUserByOIDC(ctx context.Context, subject string) (User, error) {
	if subject == "" {
		return User{}, ErrNotFound
	}
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE oidc_subject = ?`, subject))
}

// LinkOIDC links an account to an OIDC subject.
func (s *Store) LinkOIDC(ctx context.Context, id int64, subject string) error {
	_, err := s.w.ExecContext(ctx, `UPDATE users SET oidc_subject = ? WHERE id = ?`, subject, id)
	return err
}

// DeleteUser removes an account with its sessions, passkeys and API tokens.
// Deleting the last admin fails with ErrLastAdmin.
func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := lastAdminGuard(ctx, tx, id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// GetUnlinkedOIDCUser returns an OIDC account an admin created by name that
// has not signed in yet (no subject linked).
func (s *Store) GetUnlinkedOIDCUser(ctx context.Context, name string) (User, error) {
	return scanUser(s.r.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = ? AND source = ? AND oidc_subject = ''`,
		name, SourceOIDC))
}

// UserStat counts what an account has.
type UserStat struct {
	Passkeys int
	Sessions int // live browser sessions (kiosk included)
}

// UserStats returns the passkey and live session counts per account.
func (s *Store) UserStats(ctx context.Context, now time.Time) (map[int64]UserStat, error) {
	out := map[int64]UserStat{}
	rows, err := s.r.QueryContext(ctx, `SELECT user_id, COUNT(*) FROM passkeys GROUP BY user_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			rows.Close()
			return nil, err
		}
		st := out[id]
		st.Passkeys = n
		out[id] = st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.r.QueryContext(ctx, `SELECT user_id, COUNT(*) FROM sessions WHERE expires_at > ?
		AND (absolute_expires_at = 0 OR absolute_expires_at > ?) GROUP BY user_id`, ms(now), ms(now))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		st := out[id]
		st.Sessions = n
		out[id] = st
	}
	return out, rows.Err()
}

// CountAdmins returns the number of admin accounts.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = ?`, RoleAdmin).Scan(&n)
	return n, err
}
