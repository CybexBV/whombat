// Package store is the hub's SQLite database: inventory, enrollment,
// accounts, alerts, the append-only audit log and the metrics tiers.
//
// It uses modernc.org/sqlite (pure Go) in WAL mode with one writer
// connection and a small pool of readers.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Errors.
var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

// Store is the hub database.
type Store struct {
	w *sql.DB // single writer connection
	r *sql.DB // readers

	seriesMu sync.Mutex
	seriesID map[seriesKey]int64

	path string // database file
}

type seriesKey struct{ server, name string }

// Open opens (and migrates) the database at path.
func Open(path string) (*Store, error) {
	return open(path, migrations, additiveMigrations)
}

func open(path string, strict []string, additive []additiveMigration) (*Store, error) {
	dsn := func(txlock string) string {
		q := url.Values{}
		q.Add("_pragma", "busy_timeout(10000)")
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Add("_pragma", "foreign_keys(1)")
		q.Add("_pragma", "temp_store(MEMORY)")
		if txlock != "" {
			q.Add("_txlock", txlock)
		}
		return "file:" + path + "?" + q.Encode()
	}
	w, err := sql.Open("sqlite", dsn("immediate"))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxLifetime(0)
	r, err := sql.Open("sqlite", dsn(""))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	r.SetMaxIdleConns(8)
	s := &Store{w: w, r: r, seriesID: map[seriesKey]int64{}, path: path}
	if err := s.migrate(context.Background(), strict, additive); err != nil {
		s.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := s.tune(context.Background()); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// SchemaVersion is the strict schema version this build migrates to.
func SchemaVersion() int { return len(migrations) }

// tune sets the pragmas that keep the file small: a bounded WAL after
// checkpoints and incremental vacuum (freed pages are returned to the file
// system by the hourly upkeep instead of growing the file forever). A
// database created without incremental vacuum is converted once (VACUUM).
func (s *Store) tune(ctx context.Context) error {
	if _, err := s.w.ExecContext(ctx, `PRAGMA journal_size_limit = 67108864`); err != nil {
		return err
	}
	var mode int
	if err := s.w.QueryRowContext(ctx, `PRAGMA auto_vacuum`).Scan(&mode); err != nil {
		return err
	}
	if mode != 2 { // 2 = INCREMENTAL
		if _, err := s.w.ExecContext(ctx, `PRAGMA auto_vacuum = INCREMENTAL`); err != nil {
			return err
		}
		if _, err := s.w.ExecContext(ctx, `VACUUM`); err != nil {
			return fmt.Errorf("enable incremental vacuum: %w", err)
		}
	}
	return nil
}

// Upkeep runs the periodic maintenance: query planner statistics and
// returning up to 4000 free pages (16 MB) to the file system.
func (s *Store) Upkeep(ctx context.Context) error {
	if _, err := s.w.ExecContext(ctx, `PRAGMA optimize`); err != nil {
		return err
	}
	_, err := s.w.ExecContext(ctx, `PRAGMA incremental_vacuum(4000)`)
	return err
}

// Snapshot writes a consistent copy of the database to path (VACUUM INTO;
// safe while the hub runs). path must not exist.
func (s *Store) Snapshot(ctx context.Context, path string) error {
	_, err := s.w.ExecContext(ctx, `VACUUM INTO ?`, path)
	return err
}

// Size returns the database size in bytes (pages in use and free pages).
func (s *Store) Size(ctx context.Context) (total, free int64, err error) {
	var pages, freePages, pageSize int64
	if err = s.r.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pages); err != nil {
		return
	}
	if err = s.r.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&freePages); err != nil {
		return
	}
	if err = s.r.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return
	}
	return pages * pageSize, freePages * pageSize, nil
}

// Close closes the database.
func (s *Store) Close() error {
	err1 := s.r.Close()
	err2 := s.w.Close()
	if err1 != nil {
		return err1
	}
	return err2
}

// Ping checks that the database is writable (used before starting console
// sessions: the audit store must work).
func (s *Store) Ping(ctx context.Context) error { return s.w.PingContext(ctx) }

// Check runs a query on the reader and the writer pool (health check): a
// locked or corrupt database fails it, unlike Ping.
func (s *Store) Check(ctx context.Context) error {
	var n int
	if err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM meta`).Scan(&n); err != nil {
		return fmt.Errorf("read: %w", err)
	}
	if err := s.w.QueryRowContext(ctx, `SELECT COUNT(*) FROM meta`).Scan(&n); err != nil {
		return fmt.Errorf("write connection: %w", err)
	}
	return nil
}

// ErrNewerSchema means the database was written by a newer hub.
var ErrNewerSchema = errors.New("the database schema is newer than this hub")

func (s *Store) migrate(ctx context.Context, strict []string, additive []additiveMigration) error {
	var v int
	if err := s.w.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	if v > len(strict) {
		return fmt.Errorf("%w (database v%d, this hub v%d): run the newer hub or restore a backup", ErrNewerSchema, v, len(strict))
	}
	if v > 0 && v < len(strict) && s.path != "" {
		// Keep a copy of the database as it was before the migration, so a
		// failed or unwanted upgrade can be undone (`whombat-hosts restore`).
		bak := fmt.Sprintf("%s.pre-v%d-%s.bak", s.path, len(strict), time.Now().UTC().Format("20060102-150405.000"))
		if err := s.Snapshot(ctx, bak); err != nil {
			return fmt.Errorf("snapshot before migration: %w", err)
		}
		pruneSnapshots(s.path, 3)
	}
	for i := v; i < len(strict); i++ {
		tx, err := s.w.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, stmt := range splitSQL(strict[i]) {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				tx.Rollback()
				return fmt.Errorf("migration %d: %w\n%s", i+1, err, stmt)
			}
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	if len(additive) == 0 {
		return nil
	}
	return s.migrateAdditive(ctx, additive)
}

func (s *Store) migrateAdditive(ctx context.Context, migrations []additiveMigration) error {
	// The writer takes the lock before reading the ledger. A retry sees
	// both the changes and their records, even if an upgrade was cut short.
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS additive_migrations (
		id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
	) WITHOUT ROWID`); err != nil {
		return err
	}
	for _, m := range migrations {
		var applied bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM additive_migrations WHERE id = ?)`, m.id).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		for _, stmt := range splitSQL(m.sql) {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("additive migration %s: %w\n%s", m.id, err, stmt)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO additive_migrations (id, applied_at) VALUES (?, ?)`, m.id, ms(time.Now())); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// splitSQL splits a migration on lines containing only "--;" (statements
// with triggers contain semicolons).
func splitSQL(s string) []string {
	var out []string
	for _, part := range strings.Split(s, "\n--;\n") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ms converts a time to unix milliseconds (0 for the zero time).
func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// fromMS converts unix milliseconds to UTC time (zero for 0).
func fromMS(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v).UTC()
}

func nullMS(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UnixMilli()
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// pruneSnapshots keeps the newest keep pre-migration snapshots of db.
func pruneSnapshots(db string, keep int) {
	m, _ := filepath.Glob(db + ".pre-v*.bak")
	sort.Strings(m) // the timestamp suffix sorts by age within a version
	sort.SliceStable(m, func(i, j int) bool {
		si, _ := os.Stat(m[i])
		sj, _ := os.Stat(m[j])
		return si != nil && sj != nil && si.ModTime().Before(sj.ModTime())
	})
	for len(m) > keep {
		os.Remove(m[0])
		m = m[1:]
	}
}
