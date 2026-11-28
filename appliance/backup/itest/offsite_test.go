package itest

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/offsite"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

func copyNow(t *testing.T, w *World, want int) {
	t.Helper()
	if due, why := offsite.Due(w.Cfg, time.Now()); !due {
		t.Fatalf("no copy due: %s", why)
	}
	res, err := offsite.Copy(context.Background(), w.Cfg, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if res.Copied != want {
		t.Fatalf("copied %d backups, want %d", res.Copied, want)
	}
	if due, why := offsite.Due(w.Cfg, time.Now()); due {
		t.Fatalf("a copy is still due after one: %s", why)
	}
}

// The copy somewhere else: after each backup the new ones are copied there (never the run lock held, so a long copy
// holds no backup up), and when the main place is gone a new box brings the old one back from the copy alone with the
// recovery kit: the kit's main place is tried first, then the copy.
func TestOffsiteBringsBackFromTheCopyAlone(t *testing.T) {
	ctx := context.Background()
	a := NewWorld(t)
	a.Configure()
	ck1 := a.Checkpoint()
	copyDir := filepath.Join(t.TempDir(), "copy")
	if _, err := offsite.Set(ctx, a.Cfg, offsite.Request{Provider: "s3", Repository: copyDir, AllowLocal: true}); err != nil {
		t.Fatal(err)
	}
	// A backup running doesn't hold the copy up (and the copy doesn't hold the backup's lock).
	lock, err := state.TryLock(a.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	copyNow(t, a, 1)
	lock.Unlock()
	doc := offsite.Doc(a.Cfg)
	if doc.State != offsite.StateOK || doc.LastCopy == nil || doc.LastCopy.CheckpointID != ck1.Manifest.ID || doc.BackupsInCopy != 1 {
		t.Fatalf("after the first copy: %+v", doc)
	}

	// The next backup asks for a copy by itself; only the new backup is copied.
	home := a.Cfg.Layout().Home()
	WriteFile(t, filepath.Join(home, "only-on-a.txt"), "made on A before its last backup")
	Exec(t, a.DB.DSN, "create table only_on_a (id int); insert into only_on_a values (7)")
	ck2 := a.Checkpoint()
	if _, err := os.Stat(offsite.RequestPath(a.Cfg)); err != nil {
		t.Fatalf("the backup asked for no copy: %v", err)
	}
	copyNow(t, a, 1)
	copyRepo := offsite.Repo(a.Cfg, mustPlace(t, a.Cfg))
	snaps, err := copyRepo.Snapshots(ctx, manifest.TagProduct)
	if err != nil || len(snaps) != 2 {
		t.Fatalf("the copy holds %d backups: %v", len(snaps), err)
	}

	// The kit names the copy, with the newest backup in it; through JSON, as on paper or in a passkey's envelope.
	mat, err := a.Material()
	if err != nil {
		t.Fatal(err)
	}
	if mat.Offsite == nil || mat.Offsite.Repository != copyDir || mat.Offsite.Head == nil || mat.Offsite.Head.Seq != ck2.Manifest.Seq {
		t.Fatalf("the kit's second place: %+v", mat.Offsite)
	}
	b, _ := json.Marshal(mat)
	paper, err := kit.Parse(b)
	if err != nil {
		t.Fatal(err)
	}

	// The fire: the box and the NAS are gone.
	if err := os.RemoveAll(a.Rest.DataDir); err != nil {
		t.Fatal(err)
	}

	// A new box brings it back from the copy.
	nb := NewWorld(t)
	from, _, err := dest.Adopt(ctx, nb.Cfg, paper, "", func(r *dest.Request) { r.AllowLocal = true })
	if err != nil {
		t.Fatal(err)
	}
	if from != dest.FromOffsite || mustDest(t, nb.Cfg).Repository != copyDir {
		t.Fatalf("joined %s at %s", from, mustDest(t, nb.Cfg).Repository)
	}
	cfg := *nb.Cfg
	cfg.RuntimeSocket = ""
	admin := &pgtool.Admin{DSN: nb.Tools.AdminDSN}
	pc, _ := pgx.ParseConfig(nb.Tools.AdminDSN)
	DropSetAside(t, nb.Tools, nb.DB.Name)
	opts := quarantine.AppOptions{CheckpointID: ck2.Manifest.ID, DB: nb.DB.Name, DBOwner: pc.User, DSN: nb.DB.DSN,
		Admin: admin, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, Log: t.Logf,
		StopRuntime: func(context.Context) error { return nil }, StartRuntime: func(context.Context) {}}
	if err := quarantine.AppRestore(ctx, &cfg, opts); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(cfg.Layout().Home(), "only-on-a.txt")); string(b) != "made on A before its last backup" {
		t.Fatalf("A's file isn't back: %q", b)
	}
	conn, err := pgx.Connect(ctx, nb.DB.DSN)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	err = conn.QueryRow(ctx, "select id from only_on_a").Scan(&n)
	conn.Close(ctx)
	if err != nil || n != 7 {
		t.Fatalf("A's database isn't back: %d %v", n, err)
	}
	if err := quarantine.End(ctx, &cfg, admin, ck2.Manifest.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	release(t, &cfg)
}

// A copy that fails is recorded with its step, waits its backoff, and works again once the place answers; a
// restore going stops copies.
func TestOffsiteFailureAndBackoff(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint()
	copyDir := filepath.Join(t.TempDir(), "copy")
	if _, err := offsite.Set(ctx, w.Cfg, offsite.Request{Provider: "s3", Repository: copyDir, AllowLocal: true}); err != nil {
		t.Fatal(err)
	}
	copyNow(t, w, 1)
	// The place goes away (a bucket deleted, a key revoked).
	aside := copyDir + ".aside"
	if err := os.Rename(copyDir, aside); err != nil {
		t.Fatal(err)
	}
	w.Checkpoint()
	_, err := offsite.Copy(ctx, w.Cfg, t.Logf)
	var oe *offsite.Error
	if !errors.As(err, &oe) || oe.Reason == "" {
		t.Fatalf("a failed copy: %v", err)
	}
	doc := offsite.Doc(w.Cfg)
	if doc.State != offsite.StateFailing || doc.FailedAttempts != 1 || doc.LastFailure == nil || doc.NextTryAt == nil {
		t.Fatalf("after a failure: %+v", doc)
	}
	if due, why := offsite.Due(w.Cfg, time.Now()); due {
		t.Fatalf("a copy is due right after a failure: %s", why)
	}
	if due, _ := offsite.Due(w.Cfg, time.Now().Add(offsite.Backoff(1)+time.Second)); !due {
		t.Fatal("no copy due after the backoff")
	}
	if err := os.Rename(aside, copyDir); err != nil {
		t.Fatal(err)
	}
	res, err := offsite.Copy(ctx, w.Cfg, t.Logf)
	if err != nil || res.Copied != 1 {
		t.Fatalf("after the place came back: %+v %v", res, err)
	}
	if doc := offsite.Doc(w.Cfg); doc.State != offsite.StateOK || doc.FailedAttempts != 0 || doc.LastFailure != nil {
		t.Fatalf("after it worked again: %+v", doc)
	}
	// Forgetting the place keeps the copies (the bucket is the person's) and stops copying.
	if err := offsite.Remove(w.Cfg); err != nil {
		t.Fatal(err)
	}
	if doc := offsite.Doc(w.Cfg); doc.Configured {
		t.Fatalf("still set: %+v", doc)
	}
	if _, err := os.Stat(filepath.Join(copyDir, "config")); err != nil {
		t.Fatalf("the copies went with the place: %v", err)
	}
	if due, _ := offsite.Due(w.Cfg, time.Now()); due {
		t.Fatal("a copy is due without a place")
	}
}

// A real S3 storage (MinIO): the place is checked with a signed write, read and delete before it is saved, made with
// the main place's chunker parameters, copied into, and its secret is in no state file, status or kit section but
// the kit's own field.
func TestOffsiteS3(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	mc := StartMinio(t)
	bucket := "whombat-bk-" + Rand(4)
	if _, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: "s3:" + mc.URL + "/" + bucket + "/box",
		S3AccessKeyID: mc.User, S3SecretAccessKey: mc.Password, S3Region: "us-east-1", AllowInit: true}); err != nil {
		t.Fatal(err)
	}
	w.Checkpoint()
	req := offsite.Request{Provider: "s3", Repository: "s3:" + mc.URL + "/" + bucket + "/copy", S3AccessKeyID: mc.User,
		S3SecretAccessKey: "wrong-" + mc.Password}
	_, err := offsite.Set(ctx, w.Cfg, req)
	var oe *offsite.Error
	if !errors.As(err, &oe) || oe.Step != offsite.StepKeys || strings.Contains(err.Error(), mc.Password) {
		t.Fatalf("a wrong secret: %v", err)
	}
	req.Repository = "s3:" + mc.URL + "/no-such-bucket-" + Rand(3) + "/copy"
	req.S3SecretAccessKey = mc.Password
	if _, err := offsite.Set(ctx, w.Cfg, req); !errors.As(err, &oe) || oe.Step != offsite.StepBucket {
		t.Fatalf("no such bucket: %v", err)
	}
	req.Repository = "s3:" + mc.URL + "/" + bucket + "/box"
	if _, err := offsite.Set(ctx, w.Cfg, req); !errors.As(err, &oe) || oe.Step != offsite.StepSame {
		t.Fatalf("the main place again: %v", err)
	}
	req.Repository = "s3:" + mc.URL + "/" + bucket + "/copy"
	place, err := offsite.Set(ctx, w.Cfg, req)
	if err != nil {
		t.Fatal(err)
	}
	copyNow(t, w, 1)
	src, dst := w.Cfg.Repo(mustDest(t, w.Cfg)), offsite.Repo(w.Cfg, place)
	sc, err1 := src.Config(ctx)
	dc, err2 := dst.Config(ctx)
	if err1 != nil || err2 != nil || sc.ChunkerPolynomial == "" || sc.ChunkerPolynomial != dc.ChunkerPolynomial {
		t.Fatalf("the copy's chunker parameters differ: %v %v", err1, err2)
	}
	secretsAbsent(t, w, mc.Password)
	for _, f := range []string{"offsite.json", "offsite-status.json"} {
		if b, _ := os.ReadFile(filepath.Join(w.Cfg.StateDir, f)); strings.Contains(string(b), mc.Password) {
			t.Fatalf("the secret is in %s", f)
		}
	}
	if b, _ := json.Marshal(offsite.Doc(w.Cfg)); strings.Contains(string(b), mc.Password) {
		t.Fatal("the secret is in the second place's status")
	}
	mat, err := w.Material()
	if err != nil || mat.Offsite == nil || mat.Offsite.S3SecretAccessKey != mc.Password {
		t.Fatalf("the kit's second place: %v", err)
	}
}

func mustPlace(t *testing.T, c *state.Config) *offsite.Place {
	t.Helper()
	p, err := offsite.Load(c)
	if err != nil || p == nil {
		t.Fatalf("second place: %v", err)
	}
	return p
}
