package itest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

func trustedKey(t *testing.T, w *World) ed25519.PublicKey {
	k, err := manifest.LoadOrCreateKey(w.Cfg.ManifestKeyPath())
	if err != nil {
		t.Fatal(err)
	}
	return k.Public().(ed25519.PublicKey)
}

func repoOf(t *testing.T, w *World) restic.Repo {
	d, err := stateDest(w)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	return w.Cfg.Repo(d)
}

// uploadCheckpointLike uploads a directory as a checkpoint-tagged snapshot (what an attacker holding the
// appliance credential and the repository password — a compromised appliance or a leaked kit — can do).
func uploadCheckpointLike(t *testing.T, repo restic.Repo, dir, id, mf string, at time.Time) string {
	sum, err := repo.Backup(context.Background(), restic.BackupOptions{Dir: dir, Paths: []string{"db", "manifest"},
		Tags: []string{manifest.TagProduct, manifest.TagIDPrefix + id, manifest.TagMFPrefix + mf}, Host: "apl-test", Time: at})
	if err != nil {
		t.Fatal(err)
	}
	return sum.SnapshotID
}

func TestForgedSnapshotMetadataIsDetected(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	genuine := w.Checkpoint()
	repo := repoOf(t, w)
	key := trustedKey(t, w)
	ctx := context.Background()

	// (a) A newer "checkpoint" signed by another key.
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	forged := *genuine.Manifest
	forged.ID, forged.Seq, forged.CreatedAt = "ck-forged", 99, time.Now().UTC().Add(time.Minute)
	mb, _ := manifest.Encode(&forged)
	sig, _ := manifest.Sign(mb, otherKey)
	dir := t.TempDir()
	WriteFile(t, filepath.Join(dir, "db", "whombat.pgdump"), "not a dump")
	WriteFile(t, filepath.Join(dir, manifest.ManifestPath), string(mb))
	WriteFile(t, filepath.Join(dir, manifest.SigPath), string(sig))
	forgedSnap := uploadCheckpointLike(t, repo, dir, forged.ID, manifest.SHA256(mb), forged.CreatedAt)

	// (b) The genuine manifest and signature replayed with other data (same tags).
	realMB, _ := repo.DumpBytes(ctx, genuine.Summary.SnapshotID, manifest.ManifestPath)
	realSig, _ := repo.DumpBytes(ctx, genuine.Summary.SnapshotID, manifest.SigPath)
	dir2 := t.TempDir()
	WriteFile(t, filepath.Join(dir2, "db", "whombat.pgdump"), "tampered data")
	WriteFile(t, filepath.Join(dir2, manifest.ManifestPath), string(realMB))
	WriteFile(t, filepath.Join(dir2, manifest.SigPath), string(realSig))
	replaySnap := uploadCheckpointLike(t, repo, dir2, genuine.Manifest.ID, genuine.ManifestSHA256, time.Now().Add(2*time.Minute))

	// (c) Tags pointing at a manifest hash that isn't the content.
	dir3 := t.TempDir()
	WriteFile(t, filepath.Join(dir3, "db", "whombat.pgdump"), "x")
	WriteFile(t, filepath.Join(dir3, manifest.ManifestPath), string(realMB))
	WriteFile(t, filepath.Join(dir3, manifest.SigPath), string(realSig))
	badTag := uploadCheckpointLike(t, repo, dir3, genuine.Manifest.ID, strings.Repeat("0", 64), time.Now().Add(3*time.Minute))

	cps, chain, err := restore.List(ctx, repo, key, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("chain: %+v", chain)
	if len(chain.Unauthentic) != 2 || !contains(chain.Unauthentic, forgedSnap[:8]) || !contains(chain.Unauthentic, badTag[:8]) {
		t.Fatalf("unauthentic %v", chain.Unauthentic)
	}
	if len(chain.Duplicates) != 1 || len(cps) != 2 {
		t.Fatalf("duplicates %v, authentic %d", chain.Duplicates, len(cps))
	}
	// The forged snapshot can't be restored as a checkpoint.
	_, err = restore.Run(ctx, restore.Options{Repo: repo, Snapshot: forgedSnap, ManifestKey: key, Root: t.TempDir(), SkipCheck: true,
		Bins: pgtool.Bins{Dir: w.Cfg.PGBin}, Git: gitinv.Runner{}})
	if !errors.Is(err, restore.ErrUnauthentic) {
		t.Fatalf("forged snapshot: %v", err)
	}
	// The replay passes the manifest check but its data doesn't match the manifest.
	rep, err := restore.Run(ctx, restore.Options{Repo: repo, Snapshot: replaySnap, ManifestKey: key, Root: t.TempDir(), SkipCheck: true,
		Bins: pgtool.Bins{Dir: w.Cfg.PGBin}, Git: gitinv.Runner{}})
	if err != nil {
		t.Fatal(err)
	}
	if rep.OK || !contains(rep.Failed(), "dump-hash") {
		t.Fatalf("replay not detected: failed %v", rep.Failed())
	}
	// A key that isn't the kit's (e.g. an attacker's) is refused even for the genuine snapshot.
	_, err = restore.Run(ctx, restore.Options{Repo: repo, Snapshot: genuine.Summary.SnapshotID, ManifestKey: otherKey.Public().(ed25519.PublicKey),
		Root: t.TempDir(), SkipCheck: true, Bins: pgtool.Bins{Dir: w.Cfg.PGBin}})
	if !errors.Is(err, restore.ErrUnauthentic) {
		t.Fatalf("wrong trusted key: %v", err)
	}

	// (d) A malicious destination edits a snapshot file on disk (it has no password).
	snapFile := filepath.Join(w.Rest.DataDir, w.RepoPath, "snapshots", genuine.Summary.SnapshotID)
	flipByte(t, snapFile, 100)
	if _, err := repo.Check(ctx, ""); err == nil {
		t.Fatal("check passed with a tampered snapshot file")
	} else {
		t.Logf("check after snapshot tamper: %v", firstLine(err.Error()))
	}
	fresh := repo
	fresh.NoCache, fresh.CacheDir = true, ""
	cps, _, err = restore.List(ctx, fresh, key, time.Now())
	for _, c := range cps {
		if c.Snapshot.ID == genuine.Summary.SnapshotID {
			t.Fatal("tampered snapshot still listed as authentic")
		}
	}
	t.Logf("list after tamper: err=%v authentic=%d", err, len(cps))
}

func contains(s []string, x string) bool {
	for _, v := range s {
		if v == x || strings.HasPrefix(v, x) {
			return true
		}
	}
	return false
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func flipByte(t *testing.T, path string, off int64) {
	t.Helper()
	_ = os.Chmod(path, 0o600)
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b := make([]byte, 1)
	if _, err := f.ReadAt(b, off); err != nil {
		t.Fatal(err)
	}
	b[0] ^= 0xff
	if _, err := f.WriteAt(b, off); err != nil {
		t.Fatal(err)
	}
}

func TestWrongPassword(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint()
	repo := repoOf(t, w)
	ctx := context.Background()
	bad := filepath.Join(t.TempDir(), "pw")
	_ = os.WriteFile(bad, []byte("not-the-password"), 0o600)
	wrong := repo
	wrong.PasswordFile = bad
	if _, err := wrong.Config(ctx); !errors.Is(err, restic.ErrWrongPassword) {
		t.Fatalf("wrong password: %v", err)
	}
	// A checkpoint with a wrong password fails in preflight, before anything is paused.
	drainsBefore, _ := w.Runtime.Counts()
	w.Cfg.PasswordFile = bad
	_, err := w.Runner().Run(ctx, checkpoint.Options{Reason: "test"})
	var se *checkpoint.StageError
	if !errors.As(err, &se) || se.Stage != "preflight" || !errors.Is(err, restic.ErrWrongPassword) {
		t.Fatalf("checkpoint with wrong password: %v", err)
	}
	if n, _ := w.Runtime.Counts(); n != drainsBefore {
		t.Fatal("runtime was drained although preflight failed")
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if !FailedTry(st) || st.LastFailure == nil || st.LastFailure.Stage != "preflight" || st.LastSuccess == nil {
		t.Fatalf("status %+v", st)
	}
	// Another appliance (fresh state) pointing at this repository can't take it over by re-initializing.
	other := *w.Cfg
	other.PasswordFile = ""
	other.StateDir = filepath.Join(t.TempDir(), "other-backup")
	_, err = dest.Configure(ctx, &other, dest.Request{Repository: w.Rest.Repo(w.RepoPath), RESTUser: w.RestUser, RESTPassword: w.RestPass, AllowInit: true})
	if !errors.Is(err, dest.ErrForeignRepository) {
		t.Fatalf("foreign repository: %v", err)
	}
}

func TestCorruptedPackIsDetected(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint()
	repo := repoOf(t, w)
	ctx := context.Background()
	// Corrupt the largest data pack (it holds file contents).
	var biggest string
	var size int64
	_ = filepath.WalkDir(filepath.Join(w.Rest.DataDir, w.RepoPath, "data"), func(p string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if fi, _ := d.Info(); fi.Size() > size {
				biggest, size = p, fi.Size()
			}
		}
		return nil
	})
	flipByte(t, biggest, size/2)
	structural, errS := repo.Check(ctx, "")
	t.Logf("structure-only check after pack corruption: err=%v", errS)
	_ = structural
	if _, err := repo.Check(ctx, "all"); err == nil {
		t.Fatal("check --read-data passed with a corrupted pack")
	} else {
		t.Logf("check --read-data: %v", firstLine(err.Error()))
	}
	// A drill reports it (and doesn't claim recoverability).
	rep, err := restore.Run(ctx, restore.Options{Repo: repo, ManifestKey: trustedKey(t, w), Root: t.TempDir(), CheckData: "all",
		Bins: pgtool.Bins{Dir: w.Cfg.PGBin}, Git: gitinv.Runner{}})
	if rep == nil || rep.OK || !contains(rep.Failed(), "restic-check") {
		t.Fatalf("drill after corruption: err=%v failed=%v", err, rep.Failed())
	}
	t.Logf("drill after corruption: failed %v", rep.Failed())
}
