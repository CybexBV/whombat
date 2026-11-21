// Package drill runs a restore drill on the appliance (BK-12): restore the newest (or a named) checkpoint
// into a quarantine environment — a fresh directory and a fresh database (a private throwaway PostgreSQL
// cluster by default, so the live cluster is never touched), made read-only; nothing is started from it,
// so no schedule or outbound effect can run — verify everything, measure RTO and backup age, record the
// result as the status's recoverability, and clean up.
package drill

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Options for a drill.
type Options struct {
	Snapshot  string
	CheckData string // restic check level ("" structure, "all", "10%")
	// ServerAdminDSN: restore into a new database on this server instead of a private cluster (the
	// database is named <DBPrefix><id> and dropped afterwards).
	ServerAdminDSN string
	DBPrefix       string
	AuditVerify    []string
	Keep           bool // keep the quarantine directory and database (inspection)
	Log            func(format string, a ...any)
	// ManifestKey overrides the trusted key (an earlier Whombat's backup after a restore); nil = this box's own.
	ManifestKey ed25519.PublicKey
	// Record is called with the checkpoint and the result (the list's per-backup checks).
	Record func(checkpointID string, at time.Time, ok bool)
	// Locked: the caller holds the run lock already (it waited for it to take a person's request, WaitLock).
	Locked bool
}

// Run runs one drill.
func Run(ctx context.Context, c *state.Config, o Options) (*restore.Report, error) {
	if !o.Locked {
		lock, err := state.TryLock(c)
		if err != nil {
			return nil, err
		}
		defer lock.Unlock()
	}
	d, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, errors.New("no destination configured: nothing to drill")
	}
	key, err := manifest.LoadOrCreateKey(c.ManifestKeyPath())
	if err != nil {
		return nil, err
	}
	trusted := key.Public().(ed25519.PublicKey)
	var trust func(string) bool
	if o.ManifestKey != nil {
		trusted = o.ManifestKey
		// An earlier Whombat's key is trusted only for the checkpoints it had made up to the one brought back here (the
		// adopted one's once one of its backups is back, one before it always, BK-79).
		keys, err := listing.LoadKeys(c)
		if err != nil {
			return nil, err
		}
		if (keys.Adopted != nil && trusted.Equal(keys.Adopted)) || keys.IsEarlier(trusted) {
			trust = func(sha string) bool { return keys.TrustsKey(trusted, sha) }
		}
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	id := "drill-" + time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
	dir := filepath.Join(c.DrillDir(), id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		s.Running = &state.Running{ID: id, Op: "drill", Stage: "restore", Since: time.Now().UTC()}
	})
	bins := pgtool.Bins{Dir: c.PGBin}
	var dsn, auditURL string
	var admin *pgtool.Admin
	var cleanup []func()
	defer func() {
		if o.Keep {
			return
		}
		for i := len(cleanup) - 1; i >= 0; i-- {
			cleanup[i]()
		}
		_ = os.RemoveAll(dir)
	}()
	if o.ServerAdminDSN != "" {
		prefix := o.DBPrefix
		if prefix == "" {
			prefix = "whombat_quarantine_"
		}
		db := prefix + strings.ReplaceAll(strings.ToLower(id[len("drill-"):]), "-", "_")
		admin = &pgtool.Admin{DSN: o.ServerAdminDSN}
		if err := admin.CreateDB(ctx, db); err != nil {
			return nil, fmt.Errorf("quarantine database: %w", err)
		}
		cleanup = append(cleanup, func() { _ = admin.DropDB(context.Background(), db) })
		dsn, err = pgtool.WithDatabase(o.ServerAdminDSN, db)
		if err != nil {
			return nil, err
		}
	} else {
		port, err := freePort()
		if err != nil {
			return nil, err
		}
		cl := &pgtool.Cluster{Bins: bins, Dir: filepath.Join(dir, "pg"), Port: port}
		if err := cl.Init(ctx); err != nil {
			return nil, fmt.Errorf("quarantine cluster: %w", err)
		}
		cleanup = append(cleanup, func() { _ = cl.Stop() })
		admin = &pgtool.Admin{DSN: cl.DSN("postgres")}
		if err := admin.CreateDB(ctx, "whombat"); err != nil {
			return nil, err
		}
		dsn = cl.DSN("whombat")
	}
	auditURL = urlOf(dsn)
	// A cache for this check only, in its own directory (removed with it): the index and trees are read from the
	// destination once instead of by every step; manifests the box read before come from its own cache, verified
	// again with the trusted key.
	rep, err := restore.Run(ctx, restore.Options{
		Repo: c.Repo(d), Snapshot: o.Snapshot, ManifestKey: trusted, Root: filepath.Join(dir, "root"),
		CheckData: o.CheckData, Bins: bins, DSN: dsn, Admin: admin, Git: gitinv.Runner{Git: c.Git},
		AuditVerify: o.AuditVerify, AuditURL: auditURL, Log: o.Log,
		CacheDir: filepath.Join(dir, "cache"), Manifests: listing.ManifestCache(c), Trusted: trust,
	})
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		s.Running = nil
		if rep == nil {
			return
		}
		s.Recoverability.LastDrill = &state.Drill{At: rep.StartedAt, OK: rep.OK && err == nil, CheckpointID: rep.CheckpointID,
			RTOSeconds: int64(math.Ceil(rep.RTOSeconds)), BackupAgeSeconds: int64(rep.BackupAgeSeconds), Failed: rep.Failed(), Skipped: rep.Skipped()}
	})
	if rep != nil && o.Record != nil {
		o.Record(rep.CheckpointID, rep.StartedAt, rep.OK && err == nil)
	}
	if rep != nil && o.Keep {
		rep.QuarantineDSN = dsn
	}
	if o.Keep && o.Log != nil {
		o.Log("kept quarantine %s (database %s)", dir, redact(dsn))
	}
	return rep, err
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// urlOf turns a key=value DSN into a postgres:// URL (the runtime's DATABASE_URL form).
func urlOf(dsn string) string {
	kv := map[string]string{}
	for _, f := range strings.Fields(dsn) {
		k, v, ok := strings.Cut(f, "=")
		if ok {
			kv[k] = strings.Trim(v, "'")
		}
	}
	u := url.URL{Scheme: "postgres", Path: "/" + kv["dbname"]}
	if kv["password"] != "" {
		u.User = url.UserPassword(kv["user"], kv["password"])
	} else {
		u.User = url.User(kv["user"])
	}
	q := url.Values{"sslmode": {"disable"}}
	if strings.HasPrefix(kv["host"], "/") {
		q.Set("host", kv["host"])
		q.Set("port", kv["port"])
	} else {
		u.Host = kv["host"] + ":" + kv["port"]
	}
	u.RawQuery = q.Encode()
	return u.String()
}

var pwRe = regexp.MustCompile(`password=('[^']*'|\S+)`)

func redact(dsn string) string { return pwRe.ReplaceAllString(dsn, "password=***") }
