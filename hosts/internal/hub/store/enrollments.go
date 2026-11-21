package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Enrollment states.
const (
	EnrollIssued   = "issued"   // token created, not used yet
	EnrollPending  = "pending"  // agent sent its CSR, waiting for approval
	EnrollApproved = "approved" // certificate issued
	EnrollRejected = "rejected"
	EnrollExpired  = "expired"
)

// Enrollment is one enrollment token and the agent request made with it.
type Enrollment struct {
	ID             string
	State          string
	CreatedBy      string
	CreatedAt      time.Time
	ExpiresAt      time.Time
	PollSecretHash []byte
	CSR            []byte
	Hostname       string
	MachineID      string
	OS             string
	Address        string
	RemoteAddr     string
	AgentVersion   string
	RequestedAt    time.Time
	ServerID       string
	Certificate    []byte
	DecidedAt      time.Time
	DecidedBy      string
	EnrollSettings
}

// EnrollSettings are what the token's creator chose (Whombat's Add a
// server): approve when the agent asks, the control level applied at
// approval, and the server's name and group. Zero values: an enrollment
// that waits for an admin, switches as before.
type EnrollSettings struct {
	Approve bool
	Control string // "", watch, operate or full
	Name    string
	Group   string
}

const enrollCols = `id, state, created_by, created_at, expires_at, poll_secret_hash, csr, hostname, machine_id, os,
	address, remote_addr, agent_version, COALESCE(requested_at, 0), COALESCE(server_id, ''), certificate,
	COALESCE(decided_at, 0), COALESCE(decided_by, ''), approve, control, name, grp`

func scanEnrollment(row interface{ Scan(...any) error }) (Enrollment, error) {
	var e Enrollment
	var ca, ea, ra, da int64
	err := row.Scan(&e.ID, &e.State, &e.CreatedBy, &ca, &ea, &e.PollSecretHash, &e.CSR, &e.Hostname, &e.MachineID,
		&e.OS, &e.Address, &e.RemoteAddr, &e.AgentVersion, &ra, &e.ServerID, &e.Certificate, &da, &e.DecidedBy,
		&e.Approve, &e.Control, &e.Name, &e.Group)
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	e.CreatedAt, e.ExpiresAt, e.RequestedAt, e.DecidedAt = fromMS(ca), fromMS(ea), fromMS(ra), fromMS(da)
	return e, err
}

// CreateEnrollment stores a new enrollment token (hashed).
func (s *Store) CreateEnrollment(ctx context.Context, id string, tokenHash []byte, createdBy string, createdAt, expiresAt time.Time,
	set EnrollSettings) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO enrollments(id, token_hash, state, created_by, created_at, expires_at,
		approve, control, name, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, tokenHash, EnrollIssued, createdBy,
		ms(createdAt), ms(expiresAt), b2i(set.Approve), set.Control, set.Name, set.Group)
	return err
}

// EnrollRequest is what an agent sends with its token.
type EnrollRequest struct {
	CSR          []byte
	Hostname     string
	MachineID    string
	OS           string
	Address      string
	RemoteAddr   string
	AgentVersion string
}

// PendingTTL is how long a claimed enrollment waits for approval (the agent
// polls for the token lifetime after sending its request).
const PendingTTL = time.Hour

// ClaimEnrollment consumes an issued, unexpired token: the enrollment moves
// to pending with the agent's request. ErrNotFound when the token is
// unknown, used or expired.
func (s *Store) ClaimEnrollment(ctx context.Context, tokenHash []byte, now time.Time, req EnrollRequest, pollSecretHash []byte) (Enrollment, error) {
	var id string
	err := s.w.QueryRowContext(ctx, `UPDATE enrollments SET state = ?, csr = ?, hostname = ?, machine_id = ?, os = ?,
		address = ?, remote_addr = ?, agent_version = ?, requested_at = ?, poll_secret_hash = ?, expires_at = ?
		WHERE token_hash = ? AND state = ? AND expires_at > ? RETURNING id`,
		EnrollPending, req.CSR, req.Hostname, req.MachineID, req.OS, req.Address, req.RemoteAddr, req.AgentVersion,
		ms(now), pollSecretHash, ms(now.Add(PendingTTL)), tokenHash, EnrollIssued, ms(now)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Enrollment{}, ErrNotFound
	}
	if err != nil {
		return Enrollment{}, err
	}
	return s.getEnrollment(ctx, s.w, id)
}

type querier interface {
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
}

func (s *Store) getEnrollment(ctx context.Context, q querier, id string) (Enrollment, error) {
	return scanEnrollment(q.QueryRowContext(ctx, `SELECT `+enrollCols+` FROM enrollments WHERE id = ?`, id))
}

// GetEnrollment returns one enrollment.
func (s *Store) GetEnrollment(ctx context.Context, id string) (Enrollment, error) {
	return s.getEnrollment(ctx, s.r, id)
}

// ListEnrollments returns enrollments in a state ("" = all), newest first.
func (s *Store) ListEnrollments(ctx context.Context, state string) ([]Enrollment, error) {
	q := `SELECT ` + enrollCols + ` FROM enrollments`
	var args []any
	if state != "" {
		q += ` WHERE state = ?`
		args = append(args, state)
	}
	q += ` ORDER BY COALESCE(requested_at, created_at) DESC, id`
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Enrollment
	for rows.Next() {
		e, err := scanEnrollment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountEnrollments counts enrollments in a state.
func (s *Store) CountEnrollments(ctx context.Context, state string) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM enrollments WHERE state = ?`, state).Scan(&n)
	return n, err
}

// ApproveEnrollment atomically creates the server (with srv's switches)
// and marks the enrollment approved with the issued certificate.
// ErrNotFound when the enrollment is not pending; ErrConflict when the
// server id is taken.
func (s *Store) ApproveEnrollment(ctx context.Context, id string, srv Server, certPEM []byte, by string, now time.Time) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var state string
	if err := tx.QueryRowContext(ctx, `SELECT state FROM enrollments WHERE id = ?`, id).Scan(&state); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if state != EnrollPending {
		return ErrNotFound
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers WHERE id = ?`, srv.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO servers(id, hostname, grp, location, rc_console, rc_power, rc_host_shell,
		rc_host_power, rc_manage, rc_diagnose, cert_serial, cert_not_after, machine_id, created_at, agent_version, address)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		srv.ID, srv.Hostname, srv.Group, srv.Location, b2i(srv.RCConsole), b2i(srv.RCPower), b2i(srv.RCHostShell),
		b2i(srv.RCHostPower), b2i(srv.RCManage), b2i(srv.RCDiagnose), srv.CertSerial, ms(srv.CertNotAfter), srv.MachineID,
		ms(srv.CreatedAt), srv.AgentVersion, srv.Address); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE enrollments SET state = ?, server_id = ?, certificate = ?, decided_at = ?,
		decided_by = ? WHERE id = ?`, EnrollApproved, srv.ID, certPEM, ms(now), by, id); err != nil {
		return err
	}
	return tx.Commit()
}

// RejectEnrollment rejects a pending (or revokes an issued) enrollment.
func (s *Store) RejectEnrollment(ctx context.Context, id, by string, now time.Time) error {
	res, err := s.w.ExecContext(ctx, `UPDATE enrollments SET state = ?, decided_at = ?, decided_by = ?
		WHERE id = ? AND state IN (?, ?)`, EnrollRejected, ms(now), by, id, EnrollPending, EnrollIssued)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ExpireEnrollments marks issued and pending enrollments past their expiry.
func (s *Store) ExpireEnrollments(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.w.ExecContext(ctx, `UPDATE enrollments SET state = ? WHERE state IN (?, ?) AND expires_at <= ?`,
		EnrollExpired, EnrollIssued, EnrollPending, ms(now))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
