package daemon_test

import (
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func publishChannelRelease(t *testing.T, r *devtuf.Repo, id, hostV, rtV string, promote bool) {
	t.Helper()
	if err := r.InChannel(trust.ChannelDevelopment); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease(id, hostV, rtV)); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	_ = r.InChannel("")
	if promote {
		if _, err := r.Promote(id, trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func resignTestMeta[T metadata.Roles](t *testing.T, md *metadata.Metadata[T], key ed25519.PrivateKey) {
	t.Helper()
	s, err := signature.LoadSigner(key, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	md.ClearSignatures()
	if _, err := md.Sign(s); err != nil {
		t.Fatal(err)
	}
}

// End-to-end daemon test: pausing production stops offers, reports paused status to the runtime and local status API,
// ignores invalid/wrong-key pause metadata, never downgrades, and resuming installs the release.
func TestDaemonChannelPauseAndResume(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil, func(w *testworld.World, _ *fakecontrol.Control, _ *config.Config) {
		w.SetChannel(trust.ChannelProduction)
		publishChannelRelease(t, w.Repo, "whombat-20261121.1", "26.05.1", "1.1.0", true)
	})
	w := h.w
	h.waitFor("whombat-20261121.1 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == "whombat-20261121.1"
	})

	// Promote .2 and pause production before checking: the box stays on .1 and reports paused in facts and status.
	publishChannelRelease(t, w.Repo, "whombat-20261121.2", "26.05.1", "1.2.0", true)
	if _, err := w.Repo.PauseChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if res, err := h.d.CheckNow(ctx); err != nil || res.Result != "none" {
		t.Fatalf("paused CheckNow: %+v %v", res, err)
	}
	h.eventually("runtime receives paused update facts", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Paused != nil && *f.Update.Paused && f.Update.Current == "whombat-20261121.1"
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })
	st := broker.StatusOf(w.State())
	if st.Paused == nil || !*st.Paused || st.Explanation == nil || *st.Explanation != "Updates are paused for now." {
		t.Fatalf("paused status: %+v", st)
	}

	// Resume production: paused clears in runtime facts and .2 is installed.
	if _, err := w.Repo.ResumeChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CheckNow(ctx); err != nil {
		t.Fatalf("resumed CheckNow: %v", err)
	}
	h.waitFor("whombat-20261121.2 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == "whombat-20261121.2" && !st.ChannelPaused
	})
	h.eventually("runtime clears paused update facts", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Paused == nil && f.Update.Current == "whombat-20261121.2"
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })

	// A forged pause signed by the wrong key is rejected by TUF and leaves the box unpaused.
	metaDir := w.Repo.MetadataDir()
	v := w.Repo.RoleVersions()[trust.ChannelProduction]
	prodMD, err := metadata.Targets().FromFile(filepath.Join(metaDir, fmt.Sprintf("%d.production.json", v)))
	if err != nil {
		t.Fatal(err)
	}
	_, wrongKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	prodMD.Signed.Version = v + 1
	trust.SetChannelPaused(prodMD, true)
	resignTestMeta(t, prodMD, wrongKey)
	if err := prodMD.ToFile(filepath.Join(metaDir, fmt.Sprintf("%d.production.json", v+1)), true); err != nil {
		t.Fatal(err)
	}
	snapKey, err := devtuf.ReadKeyFile(filepath.Join(w.Repo.Dir, "keys", "snapshot-0.json"), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	tsKey, err := devtuf.ReadKeyFile(filepath.Join(w.Repo.Dir, "keys", "timestamp-0.json"), "timestamp")
	if err != nil {
		t.Fatal(err)
	}
	ts, err := metadata.Timestamp().FromFile(filepath.Join(metaDir, "timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	sv := ts.Signed.Meta["snapshot.json"].Version
	snap, err := metadata.Snapshot().FromFile(filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", sv)))
	if err != nil {
		t.Fatal(err)
	}
	snap.Signed.Version = sv + 1
	snap.Signed.Meta["production.json"] = metadata.MetaFile(v + 1)
	resignTestMeta(t, snap, snapKey)
	snapPath := filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", sv+1))
	if err := snap.ToFile(snapPath, true); err != nil {
		t.Fatal(err)
	}
	sb, _ := os.ReadFile(snapPath)
	sum := sha256.Sum256(sb)
	mf := metadata.MetaFile(sv + 1)
	mf.Length, mf.Hashes = int64(len(sb)), metadata.Hashes{"sha256": sum[:]}
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = mf
	resignTestMeta(t, ts, tsKey)
	if err := ts.ToFile(filepath.Join(metaDir, "timestamp.json"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CheckNow(ctx); err == nil {
		t.Fatal("daemon accepted a channel pause signed by an unknown key")
	}
	if w.State().ChannelPaused {
		t.Fatal("wrong-key pause changed ChannelPaused state")
	}

	// Expired pause metadata signed by the real production key is also rejected and leaves the box unpaused.
	prodMD.Signed.Version = v + 2
	prodMD.Signed.Expires = time.Now().UTC().Add(-time.Hour)
	trust.SetChannelPaused(prodMD, true)
	resignTestMeta(t, prodMD, w.Repo.ChannelKey(trust.ChannelProduction))
	if err := prodMD.ToFile(filepath.Join(metaDir, fmt.Sprintf("%d.production.json", v+2)), true); err != nil {
		t.Fatal(err)
	}
	snap.Signed.Version = sv + 2
	snap.Signed.Meta["production.json"] = metadata.MetaFile(v + 2)
	resignTestMeta(t, snap, snapKey)
	snapPath = filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", sv+2))
	if err := snap.ToFile(snapPath, true); err != nil {
		t.Fatal(err)
	}
	sb, _ = os.ReadFile(snapPath)
	sum = sha256.Sum256(sb)
	mf = metadata.MetaFile(sv + 2)
	mf.Length, mf.Hashes = int64(len(sb)), metadata.Hashes{"sha256": sum[:]}
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = mf
	resignTestMeta(t, ts, tsKey)
	if err := ts.ToFile(filepath.Join(metaDir, "timestamp.json"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.CheckNow(ctx); err == nil {
		t.Fatal("daemon accepted expired channel pause metadata")
	}
	if w.State().ChannelPaused {
		t.Fatal("expired pause changed ChannelPaused state")
	}
}
