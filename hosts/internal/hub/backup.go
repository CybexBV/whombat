package hub

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "modernc.org/sqlite"

	"rackoon/internal/hub/ca"
	"rackoon/internal/hub/store"
)

// Backups are tar archives with a consistent snapshot of the database
// (hub.db) and the CA (ca.crt, ca.key: without them no agent can connect to a
// restored hub), plus manifest.json. They contain secrets: the CA key and
// session/token hashes. The agent listener's certificate is not in them
// (HS-178): a restored hub makes its own for its own address. Backups made
// before 2026-10-21 carry it; a restore ignores it.
//
// The archive is a plain tar for the box's checkpoints (hub.tar: restic
// finds the database's unchanged parts again only when they aren't
// compressed) and gzipped for a download or a .tar.gz file. A restore takes
// either, by its first bytes.

// backupFiles are the data-directory files a backup carries besides hub.db.
var backupFiles = []string{"ca.crt", "ca.key"}

// listenerFiles are the agent listener's certificate and key: never taken
// from a backup, moved aside by a restore so the hub issues new ones.
var listenerFiles = []string{"agent-listener.crt", "agent-listener.key"}

// BackupManifest describes a backup.
type BackupManifest struct {
	Format     int       `json:"format"`
	HubVersion string    `json:"hub_version"`
	Schema     int       `json:"schema"`
	CreatedAt  time.Time `json:"created_at"`
	// AgentURL is the agents' address of the hub the backup was made on
	// ("" when it did not know one), CASHA256 its CA pin (HS-176). Older
	// backups have neither.
	AgentURL string `json:"agent_url"`
	CASHA256 string `json:"ca_sha256"`
}

// snapshotFunc writes a consistent copy of the database to path.
type snapshotFunc func(ctx context.Context, path string) error

// snapshotOffline snapshots a database file without migrating it (the CLI
// may be a different version than the hub that wrote it).
func snapshotOffline(dbPath string) snapshotFunc {
	return func(ctx context.Context, out string) error {
		db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_pragma=busy_timeout(10000)")
		if err != nil {
			return err
		}
		defer db.Close()
		_, err = db.ExecContext(ctx, `VACUUM INTO ?`, out)
		return err
	}
}

func schemaOf(ctx context.Context, dbPath string) (int, error) {
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var v int
	err = db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&v)
	return v, err
}

// metaOf reads one meta value of a database file without migrating it ("" when
// it is not there).
func metaOf(ctx context.Context, dbPath, key string) string {
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return ""
	}
	defer db.Close()
	var v string
	if err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v); err != nil {
		return ""
	}
	return v
}

// writeBackup writes the archive to w, gzipped when gz. agentURL is the
// agents' address for the manifest ("": the snapshot's recorded one).
func writeBackup(ctx context.Context, dataDir string, snap snapshotFunc, agentURL string, w io.Writer, gz bool) error {
	tmp, err := os.MkdirTemp(dataDir, ".backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	dbCopy := filepath.Join(tmp, "hub.db")
	if err := snap(ctx, dbCopy); err != nil {
		return fmt.Errorf("database snapshot: %w", err)
	}
	schema, err := schemaOf(ctx, dbCopy)
	if err != nil {
		return err
	}
	if agentURL == "" {
		agentURL = metaOf(ctx, dbCopy, metaAgentURL)
	}
	pin := ""
	if b, err := os.ReadFile(filepath.Join(dataDir, "ca.crt")); err == nil {
		pin, _ = ca.PinOf(b)
	}
	var zw *gzip.Writer
	if gz {
		zw = gzip.NewWriter(w)
		w = zw
	}
	tw := tar.NewWriter(w)
	add := func(name string, b []byte, mode int64) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(b)), ModTime: time.Now()}); err != nil {
			return err
		}
		_, err := tw.Write(b)
		return err
	}
	m, _ := json.MarshalIndent(BackupManifest{Format: 1, HubVersion: Version, Schema: schema, CreatedAt: time.Now().UTC(),
		AgentURL: agentURL, CASHA256: pin}, "", "  ")
	if err := add("manifest.json", append(m, '\n'), 0o600); err != nil {
		return err
	}
	f, err := os.Open(dbCopy)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	if err := tw.WriteHeader(&tar.Header{Name: "hub.db", Mode: 0o600, Size: st.Size(), ModTime: time.Now()}); err != nil {
		f.Close()
		return err
	}
	_, err = io.Copy(tw, f)
	f.Close()
	if err != nil {
		return err
	}
	for _, n := range backupFiles {
		b, err := os.ReadFile(filepath.Join(dataDir, n))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err := add(n, b, 0o600); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if zw != nil {
		return zw.Close()
	}
	return nil
}

// Backup writes a backup of the running hub to w (gzipped: a download).
func (h *Hub) Backup(ctx context.Context, w io.Writer) error {
	return writeBackup(ctx, h.cfg.DataDir, h.store.Snapshot, h.currentAgentURL(ctx), w, true)
}

// BackupOffline writes a backup of a data directory (hub stopped or
// running: the database snapshot is consistent either way) to w, a plain
// tar unless gz.
func BackupOffline(ctx context.Context, dataDir string, w io.Writer, gz bool) error {
	db := filepath.Join(dataDir, "hub.db")
	if _, err := os.Stat(db); err != nil {
		return err
	}
	return writeBackup(ctx, dataDir, snapshotOffline(db), "", w, gz)
}

// isGzip reports whether a stream starts like gzip (its magic bytes).
func isGzip(head []byte) bool { return len(head) >= 2 && head[0] == 0x1f && head[1] == 0x8b }

// lockDataDir takes an exclusive lock on DataDir/hub.lock, held while the
// hub serves, so a second hub or a restore cannot use the same directory.
func lockDataDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, "hub.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another hub is running with %s (hub.lock is held)", dir)
	}
	return f, nil
}

// backupError is a backup that can't be restored: code bad_backup or
// newer_schema (the API's codes, HS-177).
type backupError struct {
	code string
	msg  string
}

func (e *backupError) Error() string { return e.msg }

func badBackup(format string, a ...any) error {
	return &backupError{code: "bad_backup", msg: fmt.Sprintf(format, a...)}
}

// extractedBackup is a checked backup unpacked into a temporary directory.
type extractedBackup struct {
	dir      string
	Manifest BackupManifest
	// CAPin is the backup's CA pin, Servers its servers, AgentURL its
	// agents' address (the manifest's, else its database's; "" unknown).
	CAPin    string
	Servers  int
	AgentURL string
}

func (x *extractedBackup) close() {
	if x != nil {
		os.RemoveAll(x.dir)
	}
}

// extractBackup reads a backup (a tar, or a gzipped one) into a new
// temporary directory under parent and checks it: a manifest of format 1,
// a schema this hub can read, the database with that schema and a usable
// CA. The stream is read to its end (gzip's checksum; after a plain tar's
// end only zeros may follow). Errors about the file are *backupError.
func extractBackup(ctx context.Context, r io.Reader, parent string) (*extractedBackup, error) {
	tmp, err := os.MkdirTemp(parent, ".restore-")
	if err != nil {
		return nil, err
	}
	x := &extractedBackup{dir: tmp}
	ok := false
	defer func() {
		if !ok {
			x.close()
		}
	}()
	br := bufio.NewReader(r)
	head, _ := br.Peek(2)
	var in io.Reader = br
	if isGzip(head) {
		gz, err := gzip.NewReader(br)
		if err != nil {
			return nil, badBackup("not a hosts backup (gzip): %v", err)
		}
		in = gz
	}
	tr := tar.NewReader(in)
	allowed := map[string]bool{"manifest.json": true, "hub.db": true}
	for _, n := range append(append([]string{}, backupFiles...), listenerFiles...) {
		allowed[n] = true
	}
	seen := map[string]bool{}
	for {
		hd, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, badBackup("reading the backup: %v", err)
		}
		if !allowed[hd.Name] || seen[hd.Name] || hd.Typeflag != tar.TypeReg || hd.Size < 0 || hd.Size > 64<<30 {
			return nil, badBackup("unexpected entry %q in the backup", hd.Name)
		}
		seen[hd.Name] = true
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		f, err := os.OpenFile(filepath.Join(tmp, hd.Name), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			return nil, err
		}
		n, err := io.Copy(f, io.LimitReader(tr, hd.Size))
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			var pe *os.PathError
			if errors.As(err, &pe) {
				return nil, err // the disk, not the file
			}
			return nil, badBackup("reading the backup: %v", err)
		}
		if n != hd.Size {
			return nil, badBackup("the backup is cut short")
		}
	}
	// The rest of the stream: gzip's checksum, and anything a writer put
	// after the tar's end (a plain tar's padding is zeros).
	if err := readToEnd(in, !isGzip(head)); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(tmp, "manifest.json"))
	if err != nil {
		return nil, badBackup("the backup has no manifest.json")
	}
	if err := json.Unmarshal(b, &x.Manifest); err != nil || x.Manifest.Format != 1 {
		return nil, badBackup("unsupported backup format")
	}
	if x.Manifest.Schema > store.SchemaVersion() {
		return nil, &backupError{code: "newer_schema", msg: fmt.Sprintf(
			"the backup is from a newer hub (schema v%d, this hub v%d): restore it with that version", x.Manifest.Schema, store.SchemaVersion())}
	}
	dbPath := filepath.Join(tmp, "hub.db")
	if !seen["hub.db"] {
		return nil, badBackup("the backup has no hub.db")
	}
	if v, err := schemaOf(ctx, dbPath); err != nil || v != x.Manifest.Schema {
		return nil, badBackup("the database in the backup does not match its manifest (%v)", err)
	}
	if !seen["ca.crt"] || !seen["ca.key"] {
		return nil, badBackup("the backup has no certificate authority")
	}
	auth, err := ca.LoadOrCreate(tmp)
	if err != nil {
		return nil, badBackup("the backup's certificate authority is unusable: %v", err)
	}
	x.CAPin = auth.Pin
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return nil, err
	}
	err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers`).Scan(&x.Servers)
	db.Close()
	if err != nil {
		return nil, badBackup("the database in the backup is unreadable: %v", err)
	}
	x.AgentURL = x.Manifest.AgentURL
	if x.AgentURL == "" {
		x.AgentURL = metaOf(ctx, dbPath, metaAgentURL)
	}
	for _, n := range listenerFiles {
		os.Remove(filepath.Join(tmp, n))
	}
	ok = true
	return x, nil
}

// readToEnd reads what follows a backup's tar end; zeros: only zero bytes
// may follow (a plain tar's padding).
func readToEnd(r io.Reader, zeros bool) error {
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if zeros && bytes.ContainsFunc(buf[:n], func(r rune) bool { return r != 0 }) {
			return badBackup("something follows the end of the backup's archive")
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return badBackup("reading the backup: %v", err)
		}
	}
}

// restoredSuffix names what a restore moved aside: <name>.pre-restore-<time>.bak.
func restoredSuffix(stamp string) string { return ".pre-restore-" + stamp + ".bak" }

// replacedFiles are what a restore moves aside: the database (with its
// journal), the CA and the listener.
func replacedFiles() []string {
	return append(append([]string{"hub.db", "hub.db-wal", "hub.db-shm"}, backupFiles...), listenerFiles...)
}

// installBackup moves the data directory's database, CA and listener aside
// (<name>.pre-restore-<stamp>.bak) and the extracted backup's files in. On a
// failure the directory is put back as it was; undo does the same after a
// success. The caller holds the lock.
func installBackup(ctx context.Context, dataDir string, x *extractedBackup, now time.Time) (undo func(), err error) {
	stamp := now.UTC().Format("20060102-150405")
	for i := 2; ; i++ { // two restores in one second keep both
		taken := false
		for _, n := range replacedFiles() {
			if _, err := os.Lstat(filepath.Join(dataDir, n+restoredSuffix(stamp))); err == nil {
				taken = true
			}
		}
		if !taken {
			break
		}
		stamp = now.UTC().Format("20060102-150405") + "-" + strconv.Itoa(i)
	}
	var moved, installed []string
	undo = func() {
		if len(installed) > 0 {
			// Every old file was moved aside: a journal now is the
			// restored database's.
			installed = append(installed, "hub.db-wal", "hub.db-shm")
		}
		for _, n := range installed {
			os.Remove(filepath.Join(dataDir, n))
		}
		for _, n := range moved {
			p := filepath.Join(dataDir, n)
			_ = os.Rename(p+restoredSuffix(stamp), p)
		}
	}
	for _, n := range replacedFiles() {
		p := filepath.Join(dataDir, n)
		if _, err := os.Lstat(p); err != nil {
			continue
		}
		if err := os.Rename(p, p+restoredSuffix(stamp)); err != nil {
			undo()
			return nil, err
		}
		moved = append(moved, n)
	}
	// Restored files belong to the data directory's owner (a root restore
	// for a hub that runs as its own user).
	uid, gid := -1, -1
	if st, err := os.Stat(dataDir); err == nil {
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			uid, gid = int(sys.Uid), int(sys.Gid)
		}
	}
	for _, n := range append([]string{"hub.db"}, backupFiles...) {
		dst := filepath.Join(dataDir, n)
		if err := os.Rename(filepath.Join(x.dir, n), dst); err != nil {
			undo()
			return nil, err
		}
		installed = append(installed, n)
		if os.Geteuid() == 0 && uid >= 0 {
			_ = os.Chown(dst, uid, gid)
		}
	}
	if err := markRestored(ctx, filepath.Join(dataDir, "hub.db"), now, x); err != nil {
		undo()
		return nil, fmt.Errorf("recording the restore: %w", err)
	}
	return undo, nil
}

// markRestored writes into a restored database (before the hub migrates
// it): when it was restored (the 14-day adoption, HS-180), the backup's
// agents' address when the database had none, and no restore error of the
// box it came from.
func markRestored(ctx context.Context, dbPath string, now time.Time, x *extractedBackup) error {
	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=busy_timeout(10000)")
	if err != nil {
		return err
	}
	defer db.Close()
	set := func(k, v string) error {
		_, err := db.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, k, v)
		return err
	}
	if err := set(metaRestoredAt, now.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	if x.AgentURL != "" && metaOf(ctx, dbPath, metaAgentURL) == "" {
		if err := set(metaAgentURL, x.AgentURL); err != nil {
			return err
		}
	}
	_, err = db.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, metaRestoreError)
	return err
}

// Restore replaces the database and CA of dataDir with a backup (the CLI;
// the hub must be stopped). What was there is kept as
// <name>.pre-restore-<time>.bak; the agent listener is made again at the
// next start. force allows replacing an existing database.
func Restore(ctx context.Context, dataDir string, r io.Reader, force bool) (BackupManifest, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return BackupManifest{}, err
	}
	lock, err := lockDataDir(dataDir)
	if err != nil {
		return BackupManifest{}, err
	}
	defer lock.Close()
	if _, err := os.Stat(filepath.Join(dataDir, "hub.db")); err == nil && !force {
		return BackupManifest{}, errors.New("the data directory already has a database: pass --force to replace it (it is kept as hub.db.pre-restore-*.bak)")
	}
	x, err := extractBackup(ctx, r, dataDir)
	if err != nil {
		return BackupManifest{}, err
	}
	defer x.close()
	if _, err := installBackup(ctx, dataDir, x, time.Now()); err != nil {
		return BackupManifest{}, err
	}
	return x.Manifest, nil
}

// backupName is the download file name of a (gzipped) backup.
func backupName(now time.Time) string {
	return "rackoon-backup-" + strings.ReplaceAll(now.UTC().Format("20060102-150405"), ":", "") + ".tar.gz"
}
