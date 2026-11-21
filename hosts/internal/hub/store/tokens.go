package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// APIToken is a bearer token for scripts and monitoring (and kiosk links).
// Only the SHA-256 of the secret is stored.
type APIToken struct {
	ID         string
	UserID     int64
	Username   string // joined from users
	Name       string
	Hash       []byte
	Role       string // at most the user's role at use time
	CreatedAt  time.Time
	LastUsedAt time.Time
	ExpiresAt  time.Time // zero: never
	Kind       string    // TokenAPI or TokenKiosk
}

// Token kinds: a bearer token for scripts, or a kiosk link (opens a
// read-only browser session only; refused as a bearer token).
const (
	TokenAPI   = "api"
	TokenKiosk = "kiosk"
)

const tokenCols = `t.id, t.user_id, u.username, t.name, t.token_hash, t.role, t.created_at, COALESCE(t.last_used_at, 0),
	COALESCE(t.expires_at, 0), t.kind`

func scanToken(row interface{ Scan(...any) error }) (APIToken, error) {
	var t APIToken
	var ca, la, ea int64
	err := row.Scan(&t.ID, &t.UserID, &t.Username, &t.Name, &t.Hash, &t.Role, &ca, &la, &ea, &t.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	t.CreatedAt, t.LastUsedAt, t.ExpiresAt = fromMS(ca), fromMS(la), fromMS(ea)
	return t, err
}

// CreateToken stores a token.
func (s *Store) CreateToken(ctx context.Context, t APIToken) error {
	if t.Kind == "" {
		t.Kind = TokenAPI
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO api_tokens(id, user_id, name, token_hash, role, created_at, expires_at, kind)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, t.ID, t.UserID, t.Name, t.Hash, t.Role, ms(t.CreatedAt), nullMS(t.ExpiresAt), t.Kind)
	return err
}

// TokenByHash returns the token with the given secret hash.
func (s *Store) TokenByHash(ctx context.Context, hash []byte) (APIToken, error) {
	return scanToken(s.r.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = ?`, hash))
}

// ListTokens returns the tokens of a user (userID 0: everyone's), newest first.
func (s *Store) ListTokens(ctx context.Context, userID int64) ([]APIToken, error) {
	q := `SELECT ` + tokenCols + ` FROM api_tokens t JOIN users u ON u.id = t.user_id`
	var args []any
	if userID != 0 {
		q += ` WHERE t.user_id = ?`
		args = append(args, userID)
	}
	rows, err := s.r.QueryContext(ctx, q+` ORDER BY t.created_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIToken
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetToken returns a token by id.
func (s *Store) GetToken(ctx context.Context, id string) (APIToken, error) {
	return scanToken(s.r.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.id = ?`, id))
}

// DeleteToken removes a token and the kiosk sessions made from it.
func (s *Store) DeleteToken(ctx context.Context, id string) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// TouchToken records a token use.
func (s *Store) TouchToken(ctx context.Context, id string, at time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, ms(at), id)
	return err
}

// DeleteExpiredTokens removes tokens past their expiry.
func (s *Store) DeleteExpiredTokens(ctx context.Context, now time.Time) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`, ms(now))
	return err
}
