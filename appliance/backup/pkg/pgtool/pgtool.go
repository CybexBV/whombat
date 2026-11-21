// Package pgtool holds the PostgreSQL side of checkpoints, restores and exports: an exported snapshot
// held open for pg_dump, row counts and schema version read in the same snapshot, pg_restore into an
// empty database, and a private throwaway cluster for quarantine restores.
package pgtool

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

// Bins locates PostgreSQL client binaries (a directory, or PATH when empty).
type Bins struct{ Dir string }

// Path returns the binary path.
func (b Bins) Path(name string) string {
	if b.Dir == "" {
		return name
	}
	return filepath.Join(b.Dir, name)
}

// Env turns a connection string into libpq environment variables, so no password is ever on a command
// line (process arguments are world-readable).
func Env(dsn string) ([]string, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	e := []string{
		"PGHOST=" + cfg.Host,
		"PGPORT=" + strconv.Itoa(int(cfg.Port)),
		"PGDATABASE=" + cfg.Database,
		"PGUSER=" + cfg.User,
		"PGCONNECT_TIMEOUT=10",
		"PGAPPNAME=whombat-backup",
	}
	if cfg.Password != "" {
		e = append(e, "PGPASSWORD="+cfg.Password)
	}
	if cfg.TLSConfig == nil {
		e = append(e, "PGSSLMODE=disable")
	}
	return e, nil
}

// WithDatabase returns dsn pointing at another database.
func WithDatabase(dsn, db string) (string, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return "", err
	}
	host := cfg.Host
	u := fmt.Sprintf("host=%s port=%d user=%s dbname=%s", quote(host), cfg.Port, quote(cfg.User), quote(db))
	if cfg.Password != "" {
		u += " password=" + quote(cfg.Password)
	}
	if cfg.TLSConfig == nil {
		u += " sslmode=disable"
	}
	return u, nil
}

func quote(s string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `'`, `\'`) + "'"
}

func run(ctx context.Context, bin string, env []string, args ...string) ([]byte, error) {
	return runAs(ctx, nil, bin, env, args...)
}

// runAs runs bin with the given credentials (nil: the caller's).
func runAs(ctx context.Context, cred *syscall.Credential, bin string, env []string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	if cred != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	}
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}, env...)
	cmd.WaitDelay = 10 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 800 {
			msg = msg[len(msg)-800:]
		}
		return out.Bytes(), fmt.Errorf("%s: %w: %s", filepath.Base(bin), err, msg)
	}
	return out.Bytes(), nil
}

// Snapshot is an exported database snapshot held open by its exporting transaction.
type Snapshot struct {
	conn     *pgx.Conn
	tx       pgx.Tx
	ID       string
	Time     string
	Version  string
	Database string
}

// Export opens a REPEATABLE READ READ ONLY transaction and exports its snapshot. It must be called inside
// the quiesce; the snapshot stays importable until Close.
func Export(ctx context.Context, dsn string) (*Snapshot, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		conn.Close(ctx)
		return nil, err
	}
	s := &Snapshot{conn: conn, tx: tx}
	err = tx.QueryRow(ctx, `select pg_export_snapshot(), now()::text, current_setting('server_version'), current_database()`).
		Scan(&s.ID, &s.Time, &s.Version, &s.Database)
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("export snapshot: %w", err)
	}
	return s, nil
}

// DatabaseSize is pg_database_size of the current database (an upper bound for the dump's size).
func (s *Snapshot) DatabaseSize(ctx context.Context) (int64, error) {
	var n int64
	err := s.tx.QueryRow(ctx, `select pg_database_size(current_database())`).Scan(&n)
	return n, err
}

// Close ends the exporting transaction.
func (s *Snapshot) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if s.tx != nil {
		_ = s.tx.Rollback(ctx)
	}
	if s.conn != nil {
		_ = s.conn.Close(ctx)
	}
}

// Dump runs pg_dump from the exported snapshot into out (custom format, uncompressed: restic compresses
// and deduplicates across checkpoints, which a compressed dump would defeat) and returns the file's sha256 and
// size, hashed as it is written: the dump isn't read a second time to hash it. pg_dump writes to a pipe, so the
// archive's table of contents holds no data offsets: pg_restore reads it in order, which is how it is restored
// (one transaction, never in parallel).
func Dump(ctx context.Context, bins Bins, dsn, snapshotID, out string) (sha string, size int64, err error) {
	env, err := Env(dsn)
	if err != nil {
		return "", 0, err
	}
	f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	cw := &countWriter{w: io.MultiWriter(f, h)}
	cmd := exec.CommandContext(ctx, bins.Path("pg_dump"), "--snapshot="+snapshotID, "--format=custom", "--compress=0", "--no-password")
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}, env...)
	cmd.WaitDelay = 10 * time.Second
	var errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = cw, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 800 {
			msg = msg[len(msg)-800:]
		}
		if cw.err != nil {
			return "", 0, fmt.Errorf("pg_dump: %w", cw.err) // ENOSPC and the like, as the file write saw it
		}
		return "", 0, fmt.Errorf("pg_dump: %w: %s", err, msg)
	}
	if err := f.Sync(); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), cw.n, f.Close()
}

type countWriter struct {
	w   io.Writer
	n   int64
	err error
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	if err != nil && c.err == nil {
		c.err = err
	}
	return n, err
}

// Table is a row count.
type Table struct {
	Schema string
	Name   string
	Rows   int64
}

// Facts are what a checkpoint records about the database, read in the exported snapshot.
type Facts struct {
	Tables            []Table
	SchemaVersion     int
	SchemaTag         string
	DrizzleMigrations int
	Referenced        []string // blob keys of ready attachments, sorted
}

// ReferencedDigest hashes the sorted referenced keys (one per line).
func (f Facts) ReferencedDigest() string {
	h := sha256.New()
	for _, k := range f.Referenced {
		h.Write([]byte(k + "\n"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ReadFacts reads row counts, schema version and referenced blobs. With a snapshot id it imports that
// snapshot (a second connection, so the exporting transaction stays untouched); without, it reads the
// database as it is (restores).
func ReadFacts(ctx context.Context, dsn, snapshotID string) (*Facts, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	if snapshotID != "" {
		if _, err := tx.Exec(ctx, "SET TRANSACTION SNAPSHOT '"+strings.ReplaceAll(snapshotID, "'", "")+"'"); err != nil {
			return nil, fmt.Errorf("import snapshot: %w", err)
		}
	}
	f := &Facts{}
	rows, err := tx.Query(ctx, `
		select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('r','p') and not c.relispartition
		  and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg\_%'
		order by 1, 2`)
	if err != nil {
		return nil, err
	}
	var names []Table
	for rows.Next() {
		var t Table
		if err := rows.Scan(&t.Schema, &t.Name); err != nil {
			rows.Close()
			return nil, err
		}
		names = append(names, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, t := range names {
		q := fmt.Sprintf("select count(*) from %s.%s", pgx.Identifier{t.Schema}.Sanitize(), pgx.Identifier{t.Name}.Sanitize())
		if err := tx.QueryRow(ctx, q).Scan(&t.Rows); err != nil {
			return nil, fmt.Errorf("count %s.%s: %w", t.Schema, t.Name, err)
		}
		f.Tables = append(f.Tables, t)
	}
	var reg *string
	if err := tx.QueryRow(ctx, `select to_regclass('whombat_meta.schema_versions')::text`).Scan(&reg); err == nil && reg != nil {
		_ = tx.QueryRow(ctx, `select version, tag from whombat_meta.schema_versions order by version desc limit 1`).Scan(&f.SchemaVersion, &f.SchemaTag)
	}
	reg = nil
	if err := tx.QueryRow(ctx, `select to_regclass('drizzle.__drizzle_migrations')::text`).Scan(&reg); err == nil && reg != nil {
		_ = tx.QueryRow(ctx, `select count(*) from drizzle.__drizzle_migrations`).Scan(&f.DrizzleMigrations)
	}
	var cols int
	_ = tx.QueryRow(ctx, `select count(*) from information_schema.columns
		where table_schema = 'public' and table_name = 'attachments' and column_name in ('sha256','blob_key','state')`).Scan(&cols)
	if cols == 3 {
		rows, err := tx.Query(ctx, `select distinct blob_key from attachments
			where state = 'ready' and sha256 is not null and blob_key is not null order by 1`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				rows.Close()
				return nil, err
			}
			f.Referenced = append(f.Referenced, k)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	sort.Strings(f.Referenced)
	return f, nil
}

// Admin is a connection to a maintenance database (e.g. "postgres") for creating and dropping databases.
type Admin struct{ DSN string }

// CreateDB creates an empty database.
func (a Admin) CreateDB(ctx context.Context, name string) error {
	return a.exec(ctx, "create database "+pgx.Identifier{name}.Sanitize()+" template template0 encoding 'UTF8'")
}

// CreateDBOwned creates an empty database owned by owner (the runtime's role on the appliance).
func (a Admin) CreateDBOwned(ctx context.Context, name, owner string) error {
	return a.exec(ctx, "create database "+pgx.Identifier{name}.Sanitize()+" owner "+pgx.Identifier{owner}.Sanitize()+
		" template template0 encoding 'UTF8'")
}

// SetAside renames a database (every session on it ended first): nothing is dropped.
func (a Admin) SetAside(ctx context.Context, name, newName string) error {
	if _, err := a.TerminateOthers(ctx, name); err != nil {
		return err
	}
	return a.exec(ctx, "alter database "+pgx.Identifier{name}.Sanitize()+" rename to "+pgx.Identifier{newName}.Sanitize())
}

// Exists says whether a database exists.
func (a Admin) Exists(ctx context.Context, name string) (bool, error) {
	conn, err := pgx.Connect(ctx, a.DSN)
	if err != nil {
		return false, err
	}
	defer conn.Close(context.Background())
	var n int
	err = conn.QueryRow(ctx, "select count(*) from pg_database where datname = $1", name).Scan(&n)
	return n > 0, err
}

// DropDB drops a database (FORCE: terminates quarantine connections).
func (a Admin) DropDB(ctx context.Context, name string) error {
	return a.exec(ctx, "drop database if exists "+pgx.Identifier{name}.Sanitize()+" with (force)")
}

// ReadOnly makes every new session in the database read-only (quarantine: nothing writes to it).
func (a Admin) ReadOnly(ctx context.Context, name string) error {
	return a.exec(ctx, "alter database "+pgx.Identifier{name}.Sanitize()+" set default_transaction_read_only = on")
}

// TerminateOthers ends every other session connected to the database: ReadOnly only applies to new
// sessions, so the runtime's existing pool would otherwise keep writing (M-1). Clients reconnect
// read-only.
func (a Admin) TerminateOthers(ctx context.Context, name string) (int, error) {
	conn, err := pgx.Connect(ctx, a.DSN)
	if err != nil {
		return 0, err
	}
	defer conn.Close(context.Background())
	var n int
	err = conn.QueryRow(ctx, "select count(*) from (select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()) t", name).Scan(&n)
	return n, err
}

// Writable lifts ReadOnly (end of quarantine).
func (a Admin) Writable(ctx context.Context, name string) error {
	return a.exec(ctx, "alter database "+pgx.Identifier{name}.Sanitize()+" reset default_transaction_read_only")
}

func (a Admin) exec(ctx context.Context, sql string) error {
	conn, err := pgx.Connect(ctx, a.DSN)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	_, err = conn.Exec(ctx, sql)
	return err
}

// Restore loads a custom-format dump into an empty database in one transaction; any error aborts. It
// writes even when the database is already read-only by default (quarantine: read-only is set first).
// role ("" = the connecting user) is the role that owns what is restored (pg_restore --role: a superuser
// connection restores the appliance's database as the runtime's role, BK-24).
func Restore(ctx context.Context, bins Bins, dsn, dump, role string) error {
	env, err := Env(dsn)
	if err != nil {
		return err
	}
	env = append(env, "PGOPTIONS=-c default_transaction_read_only=off")
	args := []string{"--no-owner", "--no-acl", "--single-transaction", "--exit-on-error", "--no-password"}
	if role != "" {
		args = append(args, "--role="+role)
	}
	_, err = run(ctx, bins.Path("pg_restore"), env, append(args, "--dbname="+dsnDB(dsn), dump)...)
	return err
}

func dsnDB(dsn string) string {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return ""
	}
	return cfg.Database
}

// ListDump lists a dump's table of contents (proves it parses; no server needed).
func ListDump(ctx context.Context, bins Bins, dump string) (int, error) {
	out, err := run(ctx, bins.Path("pg_restore"), nil, "--list", dump)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, l := range strings.Split(string(out), "\n") {
		if l != "" && !strings.HasPrefix(l, ";") {
			n++
		}
	}
	return n, nil
}

// ToSQL converts a custom-format dump into a plain SQL script (an open format; no server needed).
func ToSQL(ctx context.Context, bins Bins, dump, out string) error {
	_, err := run(ctx, bins.Path("pg_restore"), nil, "--no-owner", "--no-acl", "--file="+out, dump)
	return err
}

// Cluster is a private throwaway PostgreSQL cluster (quarantine restores on the appliance, exports in the
// recovery environment): its own data directory, a unix socket only, trust auth for the owning user.
type Cluster struct {
	Bins Bins
	Dir  string
	Port int
	User string
	// Cred runs initdb/pg_ctl as another OS user (PostgreSQL refuses to run as root; the recovery
	// environment's export runs as root and passes an unprivileged user owning Dir).
	Cred *syscall.Credential
}

// DSN for a database in the cluster.
func (c *Cluster) DSN(db string) string {
	return fmt.Sprintf("host=%s port=%d user=%s dbname=%s sslmode=disable", c.socketDir(), c.Port, c.User, db)
}

func (c *Cluster) socketDir() string { return filepath.Join(c.Dir, "sock") }
func (c *Cluster) dataDir() string   { return filepath.Join(c.Dir, "data") }

// Init creates the cluster (fresh directory) and starts it.
func (c *Cluster) Init(ctx context.Context) error {
	if c.User == "" {
		c.User = "whombat_quarantine"
	}
	if err := os.MkdirAll(c.socketDir(), 0o700); err != nil {
		return err
	}
	if _, err := runAs(ctx, c.Cred, c.Bins.Path("initdb"), nil, "-D", c.dataDir(), "-U", c.User, "--auth=trust",
		"--encoding=UTF8", "--no-instructions", "-N"); err != nil {
		return err
	}
	return c.Start(ctx)
}

// Start starts an existing data directory (listen on the unix socket only).
func (c *Cluster) Start(ctx context.Context) error {
	opts := fmt.Sprintf("-c listen_addresses='' -c unix_socket_directories='%s' -p %d -c fsync=off -c max_connections=20",
		c.socketDir(), c.Port)
	_, err := runAs(ctx, c.Cred, c.Bins.Path("pg_ctl"), nil, "-D", c.dataDir(), "-o", opts, "-l", filepath.Join(c.Dir, "log"), "-w", "-t", "60", "start")
	return err
}

// Stop stops the cluster.
func (c *Cluster) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err := runAs(ctx, c.Cred, c.Bins.Path("pg_ctl"), nil, "-D", c.dataDir(), "-m", "fast", "-w", "stop")
	if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return err
	}
	return err
}
