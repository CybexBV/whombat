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

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// secretsAbsent fails when any secret appears in the state files the runtime and the owner can see.
func secretsAbsent(t *testing.T, w *World, secrets ...string) {
	t.Helper()
	for _, f := range []string{w.Cfg.StatusPath(), w.Cfg.DestinationPath(), w.Cfg.ChainPath()} {
		b, _ := os.ReadFile(f)
		for _, s := range secrets {
			if s != "" && strings.Contains(string(b), s) {
				t.Fatalf("a secret is in %s", f)
			}
		}
	}
	st, _ := state.CurrentStatus(w.Cfg)
	b, _ := json.Marshal(st)
	for _, s := range secrets {
		if s != "" && strings.Contains(string(b), s) {
			t.Fatal("a secret is in the status document")
		}
	}
}

// failedWith runs a checkpoint that must fail at stage with the owner-facing reason.
func failedWith(t *testing.T, w *World, stage, reason string) {
	t.Helper()
	_, err := w.Runner().Run(context.Background(), checkpoint.Options{Reason: "test"})
	var se *checkpoint.StageError
	if !errors.As(err, &se) || se.Stage != stage || !strings.HasPrefix(se.Reason, reason) {
		t.Fatalf("want %s %q, got %v", stage, reason, err)
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if !FailedTry(st) || st.LastFailure == nil || !strings.HasPrefix(st.LastFailure.Reason, state.ASCII(reason, 500)) {
		t.Fatalf("status %+v %+v", st.State, st.LastFailure)
	}
}

// drillAndRecover proves the checkpoint restores: a drill on the appliance, and the recovery kit alone
// (credentials, key, host key) authenticating it from "another machine".
func drillAndRecover(t *testing.T, w *World, want string) {
	t.Helper()
	rep, err := drill.Run(context.Background(), w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN,
		DBPrefix: "whombat_bk_test_d", CheckData: "all", Log: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.OK {
		t.Fatalf("drill failed: %v", rep.Failed())
	}
	m, err := w.Material()
	if err != nil {
		t.Fatal(err)
	}
	k := &kit.Kit{Kind: kit.KitKind, ApplianceID: w.Cfg.ApplianceID, CreatedAt: time.Now().UTC(), Backup: m}
	k.Seal()
	path := filepath.Join(t.TempDir(), "kit.json")
	WriteFile(t, path, string(mustJSON(t, k)))
	back, err := kit.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	repo, err := back.Repo(t.TempDir(), w.Tools.Restic, w.Cfg.SSH, "")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := manifest.ParseKey(back.ManifestKey)
	cps, chain, err := restore.List(context.Background(), repo, key, time.Now())
	if err != nil || len(cps) == 0 || cps[len(cps)-1].Manifest.ID != want || len(chain.Unauthentic) > 0 {
		t.Fatalf("from the kit: %d checkpoints, %+v, %v", len(cps), chain, err)
	}
}

// SFTP (BK-19) against a real OpenSSH server: the box's own key, the host key pinned on first use, a
// checkpoint, a drill and a recovery from the kit alone; then a changed host key and a removed key are
// refused with the owner's reasons, and nothing of the private key leaks into state.
func TestSFTPDestination(t *testing.T) {
	w := NewWorld(t)
	w.Cfg.SSH = filepath.Join(filepath.Dir(NeedSSHD(t)), "ssh")
	if _, err := os.Stat(w.Cfg.SSH); err != nil {
		w.Cfg.SSH = "ssh"
	}
	pub, err := dest.PublicKey(w.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := StartSSHD(t, pub.PublicKey)
	root := filepath.Join(t.TempDir(), "nas")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	res, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: srv.Repo(root + "/box"), SFTPUser: srv.User, AllowInit: true})
	if err != nil {
		t.Fatalf("%v\n%s", err, srv.Log())
	}
	if res.HostKeyFingerprint != srv.HostKey.Fingerprint() || res.Kind != state.KindSFTP || res.AppendOnly != "not-enforced" {
		t.Fatalf("%+v", res)
	}
	ck := w.Checkpoint()
	st, _ := state.CurrentStatus(w.Cfg)
	if st.State != state.StateProtected || st.Destination.Kind != "sftp" || st.Destination.AppendOnly != "not-enforced" ||
		!strings.HasPrefix(st.Destination.Display, srv.User+"@127.0.0.1:") {
		t.Fatalf("%+v", st.Destination)
	}
	drillAndRecover(t, w, ck.Manifest.ID)
	priv, _ := w.Cfg.ReadSecret(state.SecretSSHKey)
	secretsAbsent(t, w, strings.Split(priv, "\n")[1], "PRIVATE KEY")

	// The server comes back with another host key: refused, the owner is told to compare fingerprints.
	srv.NewHostKey(t)
	srv.Start(t)
	failedWith(t, w, "preflight", dest.ReasonSFTPHostKey)
	// Re-pinning is an explicit act: the owner configures it again with the new fingerprint.
	if _, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: srv.Repo(root + "/box"), SFTPUser: srv.User,
		SFTPHostKey: srv.HostKey.Fingerprint()}); err != nil {
		t.Fatal(err)
	}
	w.Checkpoint()
	// The box's key is removed from the server.
	srv.Authorize(t)
	failedWith(t, w, "preflight", dest.ReasonSFTPAuth)
}

// S3 (BK-18) against MinIO: the bucket made on first use, a checkpoint, a drill and a recovery from the kit;
// a wrong secret is refused with the owner's reason and leaves the working destination in place; the
// secret never reaches state files, the status or error messages.
func TestS3Destination(t *testing.T) {
	w := NewWorld(t)
	mc := StartMinio(t)
	ctx := context.Background()
	repo := "s3:" + mc.URL + "/whombat-bk-" + Rand(4) + "/box"
	// No bucket and no permission to create: the owner is told there is nothing there yet.
	if _, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: repo, S3AccessKeyID: mc.User, S3SecretAccessKey: mc.Password}); err == nil {
		t.Fatal("configured a missing repository without allowInit")
	}
	res, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: repo, S3AccessKeyID: mc.User, S3SecretAccessKey: mc.Password,
		S3Region: "us-east-1", AllowInit: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != state.KindS3 || res.AppendOnly != "not-enforced" {
		t.Fatalf("%+v", res)
	}
	ck := w.Checkpoint()
	drillAndRecover(t, w, ck.Manifest.ID)
	secretsAbsent(t, w, mc.Password)

	_, err = dest.Configure(ctx, w.Cfg, dest.Request{Repository: repo, S3AccessKeyID: mc.User, S3SecretAccessKey: "wrong-" + mc.Password})
	var de *dest.DestError
	if !errors.As(err, &de) || de.Reason != dest.ReasonS3Auth || strings.Contains(err.Error(), mc.Password) {
		t.Fatalf("%v", err)
	}
	w.Checkpoint() // the working destination still works
	secretsAbsent(t, w, mc.Password)
}

// The backup disk (BK-20): absent → refused; attached → protected; taken away → the status says so at once
// and a checkpoint fails with the owner's reason; back → the next checkpoint succeeds.
func TestDiskDestination(t *testing.T) {
	w := NewWorld(t)
	w.Cfg.DiskMount = filepath.Join(t.TempDir(), "disk")
	ctx := context.Background()
	if _, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: "disk:"}); err == nil {
		t.Fatal("configured a missing disk")
	}
	if err := os.MkdirAll(w.Cfg.DiskMount, 0o755); err != nil { // the owner attached a prepared disk
		t.Fatal(err)
	}
	res, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: "disk:", AllowInit: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != state.KindDisk {
		t.Fatalf("%+v", res)
	}
	ck := w.Checkpoint()
	if _, err := os.Stat(filepath.Join(w.Cfg.DiskMount, "whombat", "repository", "config")); err != nil {
		t.Fatal("repository not on the disk")
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if st.State != state.StateProtected || st.Destination.Display != "Local disk WHOMBAT-BACKUP" {
		t.Fatalf("%+v", st)
	}
	drill := func() {
		rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_d", Log: t.Logf})
		if err != nil || !rep.OK || rep.CheckpointID != ck.Manifest.ID {
			t.Fatalf("drill %v %+v", err, rep)
		}
	}
	drill()
	if err := os.Rename(w.Cfg.DiskMount, w.Cfg.DiskMount+".away"); err != nil {
		t.Fatal(err)
	}
	dest.RefreshPresence(w.Cfg)
	st, _ = state.CurrentStatus(w.Cfg)
	if st.State != state.StateFailing || st.LastFailure.Reason != dest.ReasonDiskAbsent || st.LastSuccess == nil {
		t.Fatalf("absent disk: %+v %+v", st.State, st.LastFailure)
	}
	failedWith(t, w, "preflight", dest.ReasonDiskAbsent)
	if err := os.Rename(w.Cfg.DiskMount+".away", w.Cfg.DiskMount); err != nil {
		t.Fatal(err)
	}
	dest.RefreshPresence(w.Cfg)
	if st, _ = state.CurrentStatus(w.Cfg); st.State != state.StateProtected {
		t.Fatalf("disk back: %s", st.State)
	}
	w.Checkpoint()
	// The kit names disk:, and the recovery tool opens the disk's copy when given its mount point.
	m, err := w.Material()
	if err != nil || m.Repository != "disk:" {
		t.Fatalf("%+v %v", m, err)
	}
	r, err := m.Repo(t.TempDir(), w.Tools.Restic, "", w.Cfg.DiskMount)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := manifest.ParseKey(m.ManifestKey)
	if cps, _, err := restore.List(ctx, r, key, time.Now()); err != nil || len(cps) != 2 {
		t.Fatalf("%d %v", len(cps), err)
	}
}
