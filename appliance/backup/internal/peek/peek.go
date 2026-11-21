// Package peek opens one backup for reading (“get back one thing”, Whombat restore-one): the checkpoint's database
// dump restored into a temporary database on the box's own PostgreSQL that the runtime's role may only read, and its
// runtime sources restored into a directory the runtime's group may only read. Nothing of the running Whombat is
// touched; the runtime copies what the person wants back itself.
//
// One peek at a time. Before anything is restored the room is checked against the checkpoint's own sizes. A peek
// closes itself TTL after it is ready (2 hours), when it is asked to, and at boot (Sweep; any peek of an earlier boot
// is closed).
//
// The layout (docs/runbooks/backup.md “Opening a backup for reading”):
//
//	database   <DBPrefix><12 hex> (whombat_peek_…) on the box's PostgreSQL: every schema of the checkpoint
//	           (public, whombat_meta, drizzle, …) as pg_restore --no-owner --no-acl made it, owned by the backup
//	           role; the runtime's role has CONNECT, USAGE on each schema and SELECT on its tables, views and
//	           sequences, nothing else (no TEMP, no CREATE, no SECURITY DEFINER function); every session is read-only
//	           by default and one idle 5 minutes is ended
//	root       <Dir>/<id>/root, 0750 backup user : the peek group, every directory 0750 and file 0640 (0750 when
//	           executable), nothing writable by the group; the checkpoint's runtime sources under their names:
//	             home/        WHOMBAT_HOME (files/sha256/aa/bb/<sha256> attachments, skills/<sha256>/…, the rest)
//	             workspaces/  the workspaces and their repositories
//	             hermes/      WHOMBAT_HERMES_ROOT (memories/, state.db with its -wal, sessions/, skills/, profiles/…)
//	             agent/       WHOMBAT_AGENT_HOME, the agent's home
//	           only those the checkpoint has (an older one may lack hermes/ and agent/); never credentials, secrets or
//	           the servers. Symlinks are kept as the backup had them: never follow one (it may point anywhere);
//	           FIFOs, sockets and devices are left out.
package peek

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/fsutil"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// States.
const (
	Opening = "opening"
	Ready   = "ready"
	Failed  = "failed"
	Closed  = "closed"
)

// Sources are the checkpoint's runtime sources a peek's root holds, by their source names.
var Sources = []string{"home", "workspaces", "hermes", "agent"}

// IdleSessionTimeout ends a session on the peek's database that sat idle this long, so closing it never waits on
// a connection someone forgot.
const IdleSessionTimeout = "5min"

// Errors the API maps to its answers.
var (
	ErrUnavailable = errors.New("opening a backup for reading isn't set up on this Whombat")
	ErrBusy        = errors.New("another backup is open for reading: close it first")
	ErrRunning     = errors.New("a backup or a check is running: try again in a few minutes")
	ErrNotFound    = errors.New("no such backup")
	ErrInUse       = errors.New("the backup is still being read: it closes itself a few minutes after the last read")
)

// NoSpaceError: the backup doesn't fit next to everything else.
type NoSpaceError struct {
	Need, Free int64
}

func (e *NoSpaceError) Error() string {
	return fmt.Sprintf("There isn't room on this Whombat to open this backup: it needs about %s and %s is free.", gb(e.Need), gb(e.Free))
}

func gb(n int64) string {
	if n < 1_000_000_000 {
		return fmt.Sprintf("%d MB", (n+999_999)/1_000_000)
	}
	return fmt.Sprintf("%.1f GB", float64(n)/1e9)
}

// Peek is one backup opened for reading (the API's answer and <Dir>/peek.json).
type Peek struct {
	ID           string     `json:"id"`
	CheckpointID string     `json:"checkpointId"`
	State        string     `json:"state"`
	Database     *string    `json:"database"` // set while ready
	Root         *string    `json:"root"`     // set while ready
	ExpiresAt    *time.Time `json:"expiresAt"`
	Error        *string    `json:"error"`
	// Bookkeeping, not answered: what to remove, and whose it is.
	DB        string    `json:"-"`
	Dir       string    `json:"-"`
	BootID    string    `json:"-"`
	PID       int       `json:"-"`
	CreatedAt time.Time `json:"-"`
}

// record is the file form (the bookkeeping included).
type record struct {
	Peek
	DB        string    `json:"db"`
	Dir       string    `json:"dir"`
	BootID    string    `json:"bootId"`
	PID       int       `json:"pid"`
	CreatedAt time.Time `json:"createdAt"`
}

func (p *Peek) toRecord() record {
	return record{Peek: *p, DB: p.DB, Dir: p.Dir, BootID: p.BootID, PID: p.PID, CreatedAt: p.CreatedAt}
}

func (r record) toPeek() *Peek {
	p := r.Peek
	p.DB, p.Dir, p.BootID, p.PID, p.CreatedAt = r.DB, r.Dir, r.BootID, r.PID, r.CreatedAt
	return &p
}

// Manager opens and closes peeks for one process (the API); other processes only Sweep.
type Manager struct {
	Cfg *state.Config
	Log func(format string, a ...any)

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	timer  *time.Timer
}

func (m *Manager) logf(format string, a ...any) {
	if m.Log != nil {
		m.Log(format, a...)
	}
}

func cfgOf(c *state.Config) (*state.PeekConfig, error) {
	if c.Peek == nil {
		return nil, ErrUnavailable
	}
	return c.Peek, nil
}

func statePath(pc *state.PeekConfig) string { return filepath.Join(pc.Dir, "peek.json") }

// withState runs fn on the peek record under the peek lock (shared by the API and the sweeps of other processes) and
// writes back what it returns (nothing when it returns nil or an error).
func withState(pc *state.PeekConfig, fn func(p *Peek) (*Peek, error)) (*Peek, error) {
	return locked(pc, true, fn)
}

// load reads the peek record under the lock.
func load(pc *state.PeekConfig) *Peek {
	p, _ := locked(pc, false, func(p *Peek) (*Peek, error) { return p, nil })
	return p
}

func locked(pc *state.PeekConfig, write bool, fn func(p *Peek) (*Peek, error)) (*Peek, error) {
	if err := os.MkdirAll(pc.Dir, 0o750); err != nil {
		return nil, err
	}
	lf, err := os.OpenFile(filepath.Join(pc.Dir, "peek.lock"), os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	defer lf.Close()
	if err := unix.Flock(int(lf.Fd()), unix.LOCK_EX); err != nil {
		return nil, err
	}
	defer func() { _ = unix.Flock(int(lf.Fd()), unix.LOCK_UN) }()
	var cur *Peek
	var rec record
	if b, err := state.ReadStateFile(statePath(pc)); err == nil && json.Unmarshal(b, &rec) == nil && rec.ID != "" {
		cur = rec.toPeek()
	}
	next, err := fn(cur)
	if err != nil || !write || next == nil {
		return next, err
	}
	return next, state.WriteJSON(statePath(pc), next.toRecord(), 0o600)
}

// Get answers the peek id names.
func (m *Manager) Get(id string) (*Peek, error) {
	pc, err := cfgOf(m.Cfg)
	if err != nil {
		return nil, err
	}
	m.expire(context.Background(), pc)
	if p := load(pc); p != nil && p.ID == id {
		return p, nil
	}
	return nil, ErrNotFound
}

var checkpointID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// Open checks the backup and the room, then opens it in the background (state opening, then ready or failed). own
// says which key the backup must be signed with: this box's (true), the earlier Whombat's it was brought back from
// (false), or either (nil).
func (m *Manager) Open(ctx context.Context, checkpoint string, own *bool) (*Peek, error) {
	pc, err := cfgOf(m.Cfg)
	if err != nil {
		return nil, err
	}
	if !checkpointID.MatchString(checkpoint) {
		return nil, ErrNotFound
	}
	c := m.Cfg
	m.sweep(ctx, pc)
	m.mu.Lock()
	defer m.mu.Unlock()
	if p := load(pc); p != nil && (p.State == Opening || p.State == Ready) {
		return nil, ErrBusy
	}
	d, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, fmt.Errorf("%w: no destination configured", ErrNotFound)
	}
	repo := c.Repo(d)
	snaps, err := repo.Snapshots(ctx, manifest.TagIDPrefix+checkpoint)
	if err != nil {
		return nil, fmt.Errorf("the backups can't be read: %w", err)
	}
	keys, err := listing.LoadKeys(c)
	if err != nil {
		return nil, err
	}
	var mf *manifest.Manifest
	var snapID string
	for _, s := range snaps {
		got, isOwn, err := listing.Authenticate(ctx, c, repo, s, keys)
		if err != nil || got.ID != checkpoint || (own != nil && *own != isOwn) {
			continue
		}
		mf, snapID = got, s.ID
		break
	}
	if mf == nil {
		return nil, ErrNotFound
	}
	need, include := needs(mf, c.ReserveBytes)
	if err := os.MkdirAll(pc.Dir, 0o750); err != nil {
		return nil, err
	}
	if have, err := snap.Free(pc.Dir); err == nil && need > have {
		return nil, &NoSpaceError{Need: need, Free: have}
	}
	// The run lock while restoring: no backup, prune or check changes the repository under it, and two big
	// restores never share the disk. It is let go once the peek is ready.
	lock, err := state.TryLock(c)
	if err != nil {
		if errors.Is(err, state.ErrBusy) {
			return nil, ErrRunning
		}
		return nil, err
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	suffix := hex.EncodeToString(b)
	now := time.Now().UTC()
	exp := now.Add(time.Duration(pc.TTLMs) * time.Millisecond)
	p := &Peek{ID: "pk-" + suffix, CheckpointID: checkpoint, State: Opening, ExpiresAt: &exp,
		DB: pc.DBPrefix + suffix, Dir: filepath.Join(pc.Dir, "pk-"+suffix), BootID: bootID(), PID: os.Getpid(), CreatedAt: now}
	if _, err := withState(pc, func(*Peek) (*Peek, error) { return p, nil }); err != nil {
		lock.Unlock()
		return nil, err
	}
	octx, cancel := context.WithDeadline(context.Background(), exp)
	m.cancel, m.done = cancel, make(chan struct{})
	go m.open(octx, cancel, lock, p, snapID, mf, include)
	return p, nil
}

// needs is the room a peek takes: the dump twice (the file while it loads, and the database it becomes, which with
// its indexes is about the dump's size again), the sources it restores, and the box's reserve.
func needs(m *manifest.Manifest, reserve int64) (int64, []string) {
	need := 2*m.Database.Dump.Size + reserve
	include := []string{"/" + manifest.DumpPath}
	for _, name := range Sources {
		for _, s := range m.Sources {
			if s.Name == name && !s.Missing {
				need += s.Bytes
				include = append(include, "/"+s.SnapshotPath)
			}
		}
	}
	return need, include
}

func (m *Manager) open(ctx context.Context, cancel context.CancelFunc, lock *state.Lock, p *Peek, snapID string, mf *manifest.Manifest, include []string) {
	c, pc := m.Cfg, m.Cfg.Peek
	done := m.done
	defer close(done)
	defer cancel()
	err := m.restore(ctx, p, snapID, mf, include)
	lock.Unlock()
	if err != nil {
		m.logf("peek %s of %s: %v", p.ID, p.CheckpointID, err)
		cleanup(context.Background(), c, p)
		msg := "The backup couldn't be opened: " + state.ASCII(err.Error(), 300)
		closedFirst := errors.Is(ctx.Err(), context.Canceled)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			msg = "The backup couldn't be opened in time."
		}
		_, _ = withState(pc, func(cur *Peek) (*Peek, error) {
			if cur == nil || cur.ID != p.ID {
				return cur, nil
			}
			cur.State, cur.Error, cur.Database, cur.Root, cur.ExpiresAt = Failed, &msg, nil, nil, nil
			if closedFirst { // closed while it opened: nothing failed
				cur.State, cur.Error = Closed, nil
			}
			return cur, nil
		})
		return
	}
	exp := time.Now().UTC().Add(time.Duration(pc.TTLMs) * time.Millisecond)
	db, root := p.DB, filepath.Join(p.Dir, "root")
	_, _ = withState(pc, func(cur *Peek) (*Peek, error) {
		if cur == nil || cur.ID != p.ID {
			return cur, nil
		}
		cur.State, cur.Database, cur.Root, cur.ExpiresAt = Ready, &db, &root, &exp
		return cur, nil
	})
	m.logf("peek %s: %s is open for reading until %s (database %s, %s)", p.ID, p.CheckpointID, exp.Format(time.RFC3339), db, root)
	m.mu.Lock()
	m.armTimer(p.ID, exp)
	m.mu.Unlock()
}

// armTimer closes the peek when it expires (this process; a sweep does it for one left behind).
func (m *Manager) armTimer(id string, at time.Time) {
	if m.timer != nil {
		m.timer.Stop()
	}
	m.timer = time.AfterFunc(time.Until(at), func() {
		if _, err := m.Close(context.Background(), id); err != nil {
			m.logf("peek %s: closing at its time: %v", id, err)
		}
	})
}

func (m *Manager) restore(ctx context.Context, p *Peek, snapID string, mf *manifest.Manifest, include []string) error {
	c, pc := m.Cfg, m.Cfg.Peek
	if err := mkdirGroup(p.Dir, pc.GID); err != nil {
		return err
	}
	stage := filepath.Join(p.Dir, "stage")
	if err := os.Mkdir(stage, 0o700); err != nil {
		return err
	}
	d, err := state.LoadDestination(c)
	if err != nil || d == nil {
		return fmt.Errorf("no destination: %v", err)
	}
	if err := c.Repo(d).RestoreOnly(ctx, snapID, stage, include); err != nil {
		return fmt.Errorf("restoring it: %w", err)
	}
	dump := filepath.Join(stage, filepath.FromSlash(manifest.DumpPath))
	sum, size, err := fsutil.SHA256File(dump)
	if err != nil {
		return err
	}
	if sum != mf.Database.Dump.SHA256 || size != mf.Database.Dump.Size {
		return errors.New("its database doesn't match what the backup recorded")
	}
	admin := &pgtool.Admin{DSN: c.PGDSN}
	if err := admin.CreateDB(ctx, p.DB); err != nil {
		return fmt.Errorf("a database for it: %w", err)
	}
	dsn, err := pgtool.WithDatabase(c.PGDSN, p.DB)
	if err != nil {
		return err
	}
	if err := pgtool.Restore(ctx, pgtool.Bins{Dir: c.PGBin}, dsn, dump, ""); err != nil {
		return fmt.Errorf("loading its database: %w", err)
	}
	if err := readOnlyFor(ctx, dsn, p.DB, pc.RuntimeRole); err != nil {
		return fmt.Errorf("making its database readable: %w", err)
	}
	root := filepath.Join(p.Dir, "root")
	files := filepath.Join(stage, manifest.FilesDir)
	if _, err := os.Lstat(files); errors.Is(err, fs.ErrNotExist) {
		err = os.Mkdir(files, 0o700) // a checkpoint without any of the sources
		if err != nil {
			return err
		}
	}
	if err := os.Rename(files, root); err != nil {
		return err
	}
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	return readableBy(root, pc.GID)
}

// readOnlyFor gives role read access to the restored database and nothing more.
func readOnlyFor(ctx context.Context, dsn, db, role string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	dbI, roleI := pgx.Identifier{db}.Sanitize(), pgx.Identifier{role}.Sanitize()
	stmts := []string{
		"revoke all on database " + dbI + " from public",
		"alter database " + dbI + " set default_transaction_read_only = on",
		"alter database " + dbI + " set idle_session_timeout = '" + IdleSessionTimeout + "'",
		"alter database " + dbI + " set idle_in_transaction_session_timeout = '" + IdleSessionTimeout + "'",
	}
	if role != "" {
		stmts = append(stmts, "grant connect on database "+dbI+" to "+roleI)
	}
	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s); err != nil {
			return fmt.Errorf("%s: %w", s, err)
		}
	}
	rows, err := conn.Query(ctx, `select nspname from pg_namespace
		where nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%'`)
	if err != nil {
		return err
	}
	var schemas []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		schemas = append(schemas, n)
	}
	rows.Close()
	// A function that runs with its owner's rights (the backup role, which owns everything here) must not be one the
	// runtime's role can call.
	if _, err := conn.Exec(ctx, `do $$ declare f record; begin
		for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema') loop
			execute format('revoke execute on function %s from public', f.sig);
		end loop; end $$`); err != nil {
		return err
	}
	if role == "" {
		return nil
	}
	for _, s := range schemas {
		si := pgx.Identifier{s}.Sanitize()
		for _, q := range []string{
			"grant usage on schema " + si + " to " + roleI,
			"grant select on all tables in schema " + si + " to " + roleI,
			"grant select on all sequences in schema " + si + " to " + roleI,
		} {
			if _, err := conn.Exec(ctx, q); err != nil {
				return fmt.Errorf("%s: %w", q, err)
			}
		}
	}
	return nil
}

func mkdirGroup(dir string, gid int) error {
	if err := os.Mkdir(dir, 0o750); err != nil {
		return err
	}
	if gid >= 0 {
		if err := os.Lchown(dir, -1, gid); err != nil {
			return err
		}
	}
	return os.Chmod(dir, 0o750)
}

// readableBy makes the restored tree readable, never writable, by gid: directories 0750, files 0640 (0750 when the
// owner could run them), symlinks kept, anything else (FIFOs, sockets, devices) removed so no reader blocks on one.
func readableBy(root string, gid int) error {
	return filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		t := e.Type()
		switch {
		case t.IsDir(), t.IsRegular(), t&fs.ModeSymlink != 0:
		default:
			return os.Remove(p)
		}
		if gid >= 0 {
			if err := os.Lchown(p, -1, gid); err != nil {
				return err
			}
		}
		switch {
		case t.IsDir():
			return os.Chmod(p, 0o750)
		case t.IsRegular():
			fi, err := e.Info()
			if err != nil {
				return err
			}
			mode := fs.FileMode(0o640)
			if fi.Mode().Perm()&0o100 != 0 {
				mode = 0o750
			}
			return os.Chmod(p, mode)
		}
		return nil
	})
}

// Close closes the peek id names: its database dropped, its files removed. Closing one that is still opening stops it.
func (m *Manager) Close(ctx context.Context, id string) (*Peek, error) {
	pc, err := cfgOf(m.Cfg)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	cur := load(pc)
	if cur == nil || cur.ID != id {
		m.mu.Unlock()
		return nil, ErrNotFound
	}
	if cur.State == Opening && cur.PID == os.Getpid() && m.cancel != nil {
		cancel, done := m.cancel, m.done
		m.mu.Unlock()
		cancel()
		<-done
		m.mu.Lock()
	}
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	m.mu.Unlock()
	return closeIt(ctx, m.Cfg, id)
}

// closeIt removes a peek's database and files and records it closed. A database the runtime still has a session on
// can't be dropped yet: the peek stays as it is and the next sweep tries again (an idle session ends itself after
// IdleSessionTimeout).
func closeIt(ctx context.Context, c *state.Config, id string) (*Peek, error) {
	return endIt(ctx, c, id, "")
}

// endIt is closeIt; with a reason the peek ends failed, saying why (its opening stopped half way).
func endIt(ctx context.Context, c *state.Config, id, reason string) (*Peek, error) {
	pc := c.Peek
	return withState(pc, func(cur *Peek) (*Peek, error) {
		if cur == nil || cur.ID != id {
			return cur, ErrNotFound
		}
		if cur.State == Closed {
			return cur, nil
		}
		if err := cleanup(ctx, c, cur); err != nil {
			return cur, fmt.Errorf("%w (%v)", ErrInUse, err)
		}
		cur.State, cur.Database, cur.Root, cur.ExpiresAt = Closed, nil, nil, nil
		if reason != "" {
			cur.State, cur.Error = Failed, &reason
		}
		return cur, nil
	})
}

func cleanup(ctx context.Context, c *state.Config, p *Peek) error {
	var errs []error
	if p.DB != "" {
		if err := dropDB(ctx, c, p.DB); err != nil {
			errs = append(errs, err)
		}
	}
	if p.Dir != "" && strings.HasPrefix(p.Dir, c.Peek.Dir+string(filepath.Separator)) {
		if err := removeTree(p.Dir); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// removeTree removes a peek's directory; the directories in it were made read-only to the group, never to their
// owner, so a plain RemoveAll does it.
func removeTree(dir string) error { return os.RemoveAll(dir) }

func dropDB(ctx context.Context, c *state.Config, db string) error {
	conn, err := pgx.Connect(ctx, c.PGDSN)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	var exists bool
	if err := conn.QueryRow(ctx, "select exists (select 1 from pg_database where datname = $1)", db).Scan(&exists); err != nil || !exists {
		return err
	}
	_, _ = conn.Exec(ctx, "alter database "+pgx.Identifier{db}.Sanitize()+" allow_connections false")
	_, err = conn.Exec(ctx, "drop database if exists "+pgx.Identifier{db}.Sanitize()+" with (force)")
	return err
}

// Sweep closes what no peek should still have: a peek of an earlier boot, one past its time, one whose opening
// process is gone; and any directory or database a peek left behind (a crash). The API runs it at start and on every
// call, the 15-minute backup timer and a unit at boot too.
func Sweep(ctx context.Context, c *state.Config) {
	(&Manager{Cfg: c}).Sweep(ctx)
}

// Sweep is the package's Sweep with this manager (its log, and its timer for a ready peek).
func (m *Manager) Sweep(ctx context.Context) {
	if m.Cfg.Peek == nil {
		return
	}
	m.sweep(ctx, m.Cfg.Peek)
}

func (m *Manager) sweep(ctx context.Context, pc *state.PeekConfig) {
	cur := m.expire(ctx, pc)
	keepDir, keepDB := "", ""
	if cur != nil && cur.State != Closed && cur.State != Failed {
		keepDir, keepDB = cur.Dir, cur.DB
	}
	ents, _ := os.ReadDir(pc.Dir)
	for _, e := range ents {
		p := filepath.Join(pc.Dir, e.Name())
		if e.IsDir() && strings.HasPrefix(e.Name(), "pk-") && p != keepDir {
			_ = removeTree(p)
		}
	}
	dbs, err := ownDatabases(ctx, m.Cfg.PGDSN, pc.DBPrefix)
	if err != nil {
		return
	}
	for _, db := range dbs {
		if db != keepDB {
			if err := dropDB(ctx, m.Cfg, db); err != nil {
				m.logf("peek: dropping %s left behind: %v", db, err)
			}
		}
	}
}

// expire closes the peek when it is of an earlier boot, past its time, or its opening process is gone, and returns
// what is left (it also arms this process's timer for a ready peek of its own after a restart).
func (m *Manager) expire(ctx context.Context, pc *state.PeekConfig) *Peek {
	c := m.Cfg
	cur := load(pc)
	if cur != nil && cur.State != Closed && cur.State != Failed {
		earlier := cur.BootID != bootID()
		halfOpen := cur.State == Opening && (earlier || !alive(cur.PID))
		stale := earlier || halfOpen || (cur.State == Ready && cur.ExpiresAt != nil && !time.Now().Before(*cur.ExpiresAt))
		if stale {
			reason := ""
			if halfOpen { // the backup service restarted (or the box) while it opened
				reason = "The backup couldn't be opened: Whombat's backup service restarted meanwhile. Try again."
			}
			if _, err := endIt(ctx, c, cur.ID, reason); err != nil {
				m.logf("peek %s: closing what was left: %v", cur.ID, err)
			}
			cur = load(pc)
		} else if cur.State == Ready && cur.ExpiresAt != nil {
			m.mu.Lock()
			if m.timer == nil {
				m.armTimer(cur.ID, *cur.ExpiresAt)
			}
			m.mu.Unlock()
		}
	}
	return cur
}

// ownDatabases are the databases with prefix this role owns (a peek's).
func ownDatabases(ctx context.Context, dsn, prefix string) ([]string, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	rows, err := conn.Query(ctx, `select datname from pg_database
		where starts_with(datname, $1) and datdba = (select oid from pg_roles where rolname = current_user)`, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// bootIDPath is this boot's id (a peek of an earlier boot is closed).
var bootIDPath = "/proc/sys/kernel/random/boot_id"

func bootID() string {
	b, err := os.ReadFile(bootIDPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
