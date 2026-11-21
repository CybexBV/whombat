package trust_test

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newRepo(t *testing.T, c *clock) *devtuf.Repo {
	t.Helper()
	r, err := devtuf.New(filepath.Join(t.TempDir(), "repo"), devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease("rt-1", "26.05.1", "1.0.0")); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	return r
}

func cfg(r *devtuf.Repo, cache string, now time.Time) trust.Config {
	return trust.Config{PinnedRoot: r.InitialRoot(), MetadataDir: cache, MetadataURL: "mirror://m",
		Fetcher: trust.DirFetcher{BaseURL: "mirror://m", Dir: r.MetadataDir()}, Now: now}
}

var t0 = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

func TestRefreshAndRelease(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	cache := t.TempDir()
	repo, err := trust.Refresh(cfg(r, cache, c.t))
	if err != nil {
		t.Fatal(err)
	}
	if ids := repo.ReleaseIDs(); len(ids) != 1 || ids[0] != "rt-1" {
		t.Fatalf("ids %v", ids)
	}
	rel, err := repo.Release("rt-1")
	if err != nil {
		t.Fatal(err)
	}
	if rel.RuntimeIndex.Meta.Version != "1.0.0" || rel.Tuple.Runtime.Version != "1.0.0" || len(rel.ProviderIndexes) != 1 || rel.Digest == "" {
		t.Fatalf("release %+v", rel)
	}
	p, _ := r.TargetFilePath(rel.RuntimeIndex.Target)
	if err := trust.VerifyFile(p, *rel.RuntimeIndex); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "copy")
	if err := trust.CopyVerified(p, dst, *rel.RuntimeIndex); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Release("nope"); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("unapproved: %v", err)
	}
}

func TestCorruptAndWrongLengthArtifact(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	rel, _ := repo.Release("rt-1")
	p, _ := r.TargetFilePath(rel.RuntimeIndex.Target)
	good, _ := os.ReadFile(p)
	bad := append([]byte{}, good...)
	bad[len(bad)/2] ^= 1
	f := filepath.Join(t.TempDir(), "a")
	os.WriteFile(f, bad, 0o600)
	if err := trust.VerifyFile(f, *rel.RuntimeIndex); !errors.Is(err, trust.ErrArtifact) {
		t.Fatalf("corrupt: %v", err)
	}
	os.WriteFile(f, append(good, 'x'), 0o600)
	if err := trust.VerifyFile(f, *rel.RuntimeIndex); !errors.Is(err, trust.ErrArtifact) {
		t.Fatalf("long: %v", err)
	}
	os.WriteFile(f, good[:len(good)-1], 0o600)
	dst := filepath.Join(t.TempDir(), "copy")
	if err := trust.CopyVerified(f, dst, *rel.RuntimeIndex); !errors.Is(err, trust.ErrArtifact) {
		t.Fatalf("short: %v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("failed copy left behind")
	}
}

func TestExpiredTimestampAndStaleClock(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	// Device clock one week ahead: timestamp (1 day) looks expired -> refused.
	if _, err := trust.Refresh(cfg(r, t.TempDir(), t0.Add(7*24*time.Hour))); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("clock ahead: %v", err)
	}
	// Explicitly expired timestamp.
	if err := r.SetTimestampExpiry(t0.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Refresh(cfg(r, t.TempDir(), t0)); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("expired: %v", err)
	}
	// Clock far behind: the expired timestamp would look fresh; callers must pass a trusted time
	// floor (manager journal) as Now. With the floor it is refused again.
	if _, err := trust.Refresh(cfg(r, t.TempDir(), t0.Add(-48*time.Hour))); err != nil {
		t.Fatalf("clock behind without floor accepts (documented TUF limitation): %v", err)
	}
}

func TestReplayedOldMetadata(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	cache := t.TempDir()
	oldTS, _ := os.ReadFile(filepath.Join(r.MetadataDir(), "timestamp.json"))
	if _, err := trust.Refresh(cfg(r, cache, c.t)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease("rt-2", "26.05.1", "1.1.0")); err != nil {
		t.Fatal(err)
	}
	r.Publish()
	if _, err := trust.Refresh(cfg(r, cache, c.t)); err != nil {
		t.Fatal(err)
	}
	// Attacker replays the old (still unexpired) timestamp -> rollback refused.
	os.WriteFile(filepath.Join(r.MetadataDir(), "timestamp.json"), oldTS, 0o644)
	if _, err := trust.Refresh(cfg(r, cache, c.t)); !errors.Is(err, trust.ErrRollback) {
		t.Fatalf("replay: %v", err)
	}
}

func TestForgedTargets(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	// Attacker-signed repository with the same layout: signatures don't chain to the pinned root.
	evil, err := devtuf.New(filepath.Join(t.TempDir(), "evil"), devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	evil.AddFakeRelease(devtuf.StandardRelease("rt-1", "26.05.1", "6.6.6"))
	evil.Publish()
	conf := cfg(r, t.TempDir(), c.t)
	conf.Fetcher = trust.DirFetcher{BaseURL: "mirror://m", Dir: evil.MetadataDir()}
	if _, err := trust.Refresh(conf); !errors.Is(err, trust.ErrSignature) {
		t.Fatalf("forged repository: %v", err)
	}
}

func TestRootRotationAndLongOffline(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	cache := t.TempDir()
	if _, err := trust.Refresh(cfg(r, cache, c.t)); err != nil {
		t.Fatal(err)
	}
	// Device offline for 200 days while the repo rotates every role key three times.
	for i := 0; i < 3; i++ {
		c.t = c.t.Add(60 * 24 * time.Hour)
		if err := r.RotateKeys("root", "targets", "snapshot", "timestamp"); err != nil {
			t.Fatal(err)
		}
	}
	c.t = c.t.Add(20 * 24 * time.Hour)
	r.AddFakeRelease(devtuf.StandardRelease("rt-9", "26.05.2", "2.0.0"))
	r.Publish()
	repo, err := trust.Refresh(cfg(r, cache, c.t))
	if err != nil {
		t.Fatalf("long offline refresh: %v", err)
	}
	if repo.RootVersion != 4 {
		t.Fatalf("root version %d", repo.RootVersion)
	}
	if _, err := repo.Release("rt-9"); err != nil {
		t.Fatal(err)
	}
	// A new device provisioned with root v1 also walks the chain.
	if _, err := trust.Refresh(cfg(r, t.TempDir(), c.t)); err != nil {
		t.Fatal(err)
	}
	// If the repository itself stopped publishing, a long-offline device refuses (freeze attack).
	c.t = c.t.Add(30 * 24 * time.Hour)
	if _, err := trust.Refresh(cfg(r, cache, c.t)); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("stale repo: %v", err)
	}
}

func TestCorruptCacheRecovers(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	cache := t.TempDir()
	if _, err := trust.Refresh(cfg(r, cache, c.t)); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(cache, "timestamp.json"), []byte{}, 0o644)
	os.WriteFile(filepath.Join(cache, "root.json"), []byte("{garbage"), 0o644)
	if _, err := trust.Refresh(cfg(r, cache, c.t)); err != nil {
		t.Fatalf("torn cache: %v", err)
	}
}

func TestIncompatibleTuple(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	bad := devtuf.StandardRelease("rbad", "26.05.1", "3.0.0")
	bad.RuntimeHostABI = release.IntRange{Min: 7, Max: 9}
	r.AddFakeRelease(bad)
	r.Publish()
	repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Release("rbad"); !errors.Is(err, trust.ErrIncompatible) {
		t.Fatalf("incompatible: %v", err)
	}
}

func TestAssignments(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	ks, err := repo.AssignmentKeys("dev", c.t)
	if err != nil {
		t.Fatal(err)
	}
	rel, _ := repo.Release("rt-1")
	raw, _ := r.Assign("dev-1", "rt-1", 5, time.Hour)
	p := trust.VerifyParams{DeviceID: "dev-1", Env: "dev", Now: c.t, LastSequence: 4}
	sa, err := trust.VerifyAssignment(raw, ks, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := trust.CheckAgainst(&sa.Payload, rel); err != nil {
		t.Fatal(err)
	}
	// Wrong device, replay (sequence must be strictly greater), expired, tampered, foreign key.
	if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-2", Env: "dev", Now: c.t}); !errors.Is(err, trust.ErrAssignmentScope) {
		t.Fatalf("scope: %v", err)
	}
	if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-1", Env: "dev", Now: c.t, LastSequence: 5}); !errors.Is(err, trust.ErrAssignmentReplay) {
		t.Fatalf("replay: %v", err)
	}
	if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-1", Env: "dev", Now: c.t.Add(2 * time.Hour)}); !errors.Is(err, trust.ErrAssignmentTime) {
		t.Fatalf("expired: %v", err)
	}
	if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-1", Env: "prod", Now: c.t}); !errors.Is(err, trust.ErrAssignmentSignature) && !errors.Is(err, trust.ErrAssignmentScope) {
		t.Fatalf("other env: %v", err)
	}
	tampered := strings.Replace(string(raw), `"sequence":5`, `"sequence":6`, 1)
	if _, err := trust.VerifyAssignment([]byte(tampered), ks, p); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("tampered: %v", err)
	}
	other, _ := devtuf.New(filepath.Join(t.TempDir(), "o"), devtuf.Options{Now: c.now})
	forged, _ := other.Assign("dev-1", "rt-1", 9, time.Hour)
	if _, err := trust.VerifyAssignment(forged, ks, p); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("foreign key: %v", err)
	}
	un, _ := r.Assign("dev-1", "unapproved", 7, time.Hour)
	sa2, err := trust.VerifyAssignment(un, ks, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Release(*sa2.Payload.ReleaseID); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("unapproved release: %v", err)
	}
	hold, _ := r.Hold("dev-1", 8, time.Hour)
	sa3, err := trust.VerifyAssignment(hold, ks, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := trust.CheckAgainst(&sa3.Payload, rel); !errors.Is(err, trust.ErrAssignmentHold) {
		t.Fatalf("hold: %v", err)
	}
	// Assignment key rotation through TUF without grace: the old key is gone.
	r.RotateAssignmentKey(0)
	r.Publish()
	repo2, _ := trust.Refresh(cfg(r, t.TempDir(), c.t))
	ks2, _ := repo2.AssignmentKeys("dev", c.t)
	if _, err := trust.VerifyAssignment(raw, ks2, p); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("rotated key: %v", err)
	}
}

// Assignment keys are trusted only from the TUF-verified AssignmentKeys document (MG-21), with the
// contract state machine (release.AssignmentKeyMap, CT-41): active keys always, next keys from
// notBefore, retired keys until notAfter, unknown kids never; an invalid document refuses everything.
func TestAssignmentKeyTrust(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	refresh := func() *trust.Repo {
		t.Helper()
		repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
		if err != nil {
			t.Fatal(err)
		}
		return repo
	}
	seq := int64(0)
	payload := func() release.AssignmentPayload {
		seq++
		id := "rt-1"
		rel, _ := refresh().Release(id)
		digest := rel.Digest
		return r.Payload("dev-1", "install", &id, &digest, seq, time.Hour)
	}
	verify := func(raw []byte) error {
		ks, err := refresh().AssignmentKeys("dev", c.t)
		if err != nil {
			return err
		}
		_, err = trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-1", Env: "dev", Now: c.t})
		return err
	}
	at := func(d time.Duration) *int64 { v := c.t.Add(d).Unix(); return &v }
	// Control generates and holds its own key; release custody publishes the public half.
	cpub, cpriv, _ := ed25519.GenerateKey(nil)
	chex := hex.EncodeToString(cpub)
	signed, _ := devtuf.SignAssignmentWith(payload(), "control-dev-1", cpriv)
	if err := verify(signed); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("unknown kid must be refused: %v", err)
	}
	// Staged as `next` from one hour on: refused before notBefore, accepted after.
	if err := r.SetAssignmentKey("control-dev-1", chex, "next", at(time.Hour), nil); err != nil {
		t.Fatal(err)
	}
	r.Publish()
	if err := verify(signed); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("next key before notBefore: %v", err)
	}
	c.t = c.t.Add(2 * time.Hour)
	r.PublishTimestamp()
	signed2, _ := devtuf.SignAssignmentWith(payload(), "control-dev-1", cpriv)
	if err := verify(signed2); err != nil {
		t.Fatalf("next key after notBefore: %v", err)
	}
	// Promoted to active, then retired with notAfter in one hour: accepted until then, refused after.
	if err := r.SetAssignmentKey("control-dev-1", chex, "active", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := r.SetAssignmentKey("control-dev-1", chex, "retired", nil, at(time.Hour)); err != nil {
		t.Fatal(err)
	}
	r.Publish()
	if err := verify(signed2); err != nil {
		t.Fatalf("retired key before notAfter: %v", err)
	}
	c.t = c.t.Add(2 * time.Hour)
	r.PublishTimestamp()
	signed3, _ := devtuf.SignAssignmentWith(payload(), "control-dev-1", cpriv)
	if err := verify(signed3); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("retired key past notAfter must be refused: %v", err)
	}
	// Removal revokes immediately; a wrong key under a trusted kid never verifies.
	r.RemoveAssignmentKey("control-dev-1")
	r.Publish()
	impostor, _ := devtuf.SignAssignmentWith(payload(), r.AssignmentKeyID(), cpriv)
	if err := verify(impostor); !errors.Is(err, trust.ErrAssignmentSignature) {
		t.Fatalf("wrong key under a trusted kid: %v", err)
	}
	// Invalid documents are refused by the tooling and, if published anyway, by the device: nothing
	// verifies (fail closed; the installed release keeps running).
	good, _ := r.Assign("dev-1", "rt-1", 50, time.Hour)
	for name, bad := range map[string]release.AssignmentKeysKeysItem{
		"retired_without_not_after": {Kid: "k-bad", PublicKey: chex, State: "retired"},
		"active_with_window":        {Kid: "k-bad", PublicKey: chex, State: "active", NotAfter: at(time.Hour)},
		"next_with_not_after":       {Kid: "k-bad", PublicKey: chex, State: "next", NotBefore: at(0), NotAfter: at(time.Hour)},
		"retired_with_not_before":   {Kid: "k-bad", PublicKey: chex, State: "retired", NotBefore: at(0), NotAfter: at(time.Hour)},
	} {
		doc := r.AssignmentKeysDoc()
		doc.Keys = append(doc.Keys, bad)
		var ake *release.AssignmentKeysError
		if err := r.SetAssignmentKeysDoc(doc); !errors.As(err, &ake) || ake.Code != name {
			t.Fatalf("%s: tooling accepted: %v", name, err)
		}
		saved := r.AssignmentKeysDoc()
		r.SetAssignmentKeysDocUnchecked(doc)
		r.Publish()
		if err := verify(good); !errors.As(err, &ake) || ake.Code != name || !errors.Is(err, trust.ErrInvalidMetadata) {
			t.Fatalf("%s: device accepted an invalid document: %v", name, err)
		}
		r.SetAssignmentKeysDoc(saved)
		r.Publish()
	}
	if err := verify(good); err != nil {
		t.Fatalf("valid document restored: %v", err)
	}
	var ake *release.AssignmentKeysError
	if err := r.SetAssignmentKey("control-dev-2", chex, "next", at(time.Hour), nil); err != nil {
		t.Fatal(err)
	}
	if err := r.RemoveAssignmentKey(r.AssignmentKeyID()); !errors.As(err, &ake) || ake.Code != "no_active_key" {
		t.Fatalf("removing the only active key: %v", err)
	}
	// The document is environment-bound: a dev document does not authorize prod assignments.
	if _, err := refresh().AssignmentKeys("prod", c.t); !errors.As(err, &ake) || ake.Code != "wrong_env" {
		t.Fatalf("env mismatch: %v", err)
	}
	// Rotation with grace: the old development key keeps working as retired until notAfter.
	old, _ := r.Assign("dev-1", "rt-1", 60, time.Hour)
	if err := r.RotateAssignmentKey(30 * time.Minute); err != nil {
		t.Fatal(err)
	}
	r.Publish()
	if err := verify(old); err != nil {
		t.Fatalf("old key within grace: %v", err)
	}
	c.t = c.t.Add(40 * time.Minute)
	r.PublishTimestamp()
	if err := verify(old); !errors.Is(err, trust.ErrAssignmentSignature) && !errors.Is(err, trust.ErrAssignmentTime) {
		t.Fatalf("old key after grace: %v", err)
	}
}
