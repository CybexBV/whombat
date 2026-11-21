package devtuf

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// FixtureCase describes one generated fixture and the outcome a correct client must reach.
type FixtureCase struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// MetadataDir is served as the TUF metadata base; TargetsDir as the targets base.
	MetadataDir string `json:"metadataDir"`
	TargetsDir  string `json:"targetsDir"`
	// PrimeWith, if set, is a metadata dir the client must refresh from first (rollback cases).
	PrimeWith string `json:"primeWith,omitempty"`
	// PinnedRoot is the root the device was provisioned with.
	PinnedRoot string `json:"pinnedRoot"`
	// Release and target to fetch/verify when Expect is about an artifact.
	Release string `json:"release,omitempty"`
	// Expect: "ok", "expired", "rollback", "signature", "artifact".
	Expect string `json:"expect"`
}

// FixtureManifest is fixtures.json.
type FixtureManifest struct {
	Development bool          `json:"development"`
	Warning     string        `json:"warning"`
	VerifyAt    time.Time     `json:"verifyAt"`
	DeviceID    string        `json:"deviceId"`
	Env         string        `json:"env"`
	Assignment  string        `json:"assignment"`
	Cases       []FixtureCase `json:"cases"`
}

func copyTree(from, to string) error {
	return filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, info.Mode().Perm())
	})
}

// GenerateFixtures writes the development fixture set under out (see FixtureManifest). Metadata is
// valid for `validity` from `now` (except where a case expires it on purpose); clients verify at
// VerifyAt = now.
func GenerateFixtures(out string, now time.Time, validity time.Duration) (*FixtureManifest, error) {
	clock := now
	// The private keys go next to the fixture tree, never into it: the tree is served over HTTP in the
	// VM tests (release-tools/fixtures/dev-keys, L-4).
	keysDir := filepath.Join("..", "..", filepath.Base(out)+"-keys")
	opts := Options{Now: func() time.Time { return clock }, RootExpiry: validity, TargetsExp: validity, SnapshotExp: validity, TimestampEx: validity,
		KeysDir: keysDir}
	repoDir := filepath.Join(out, "repo")
	r, err := New(repoDir, opts)
	if err != nil {
		return nil, err
	}
	if _, err := r.AddFakeRelease(StandardRelease("rt-fixture-1", "26.05.1", "1.0.0")); err != nil {
		return nil, err
	}
	if err := r.Publish(); err != nil {
		return nil, err
	}
	m := &FixtureManifest{Development: true, Warning: DevWarning, VerifyAt: now.UTC(), DeviceID: "dev-fixture", Env: r.Env}
	snap := func(name string) (string, error) {
		d := filepath.Join(out, name, "metadata")
		if err := os.MkdirAll(d, 0o755); err != nil {
			return "", err
		}
		return d, copyTree(r.MetadataDir(), d)
	}
	rel := func(p string) string { s, _ := filepath.Rel(out, p); return s }
	pinned := filepath.Join(out, "pinned-root.json")
	if err := os.WriteFile(pinned, r.InitialRoot(), 0o644); err != nil {
		return nil, err
	}
	targets := filepath.Join(out, "valid", "targets")
	add := func(c FixtureCase, meta, tdir string) {
		c.MetadataDir, c.TargetsDir, c.PinnedRoot = rel(meta), rel(tdir), rel(pinned)
		m.Cases = append(m.Cases, c)
	}

	// valid
	v1, err := snap("valid")
	if err != nil {
		return nil, err
	}
	if err := copyTree(r.TargetsDir(), targets); err != nil {
		return nil, err
	}
	add(FixtureCase{Name: "valid", Description: "consistent, unexpired metadata; release and artifacts verify", Release: "rt-fixture-1", Expect: "ok"}, v1, targets)
	sa, err := r.Assign(m.DeviceID, "rt-fixture-1", 1, 7*24*time.Hour)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(out, "assignment.json"), sa, 0o644); err != nil {
		return nil, err
	}
	m.Assignment = "assignment.json"

	// replayed old snapshot: prime with v2, then serve the older (still validly signed) v1 again.
	clock = clock.Add(time.Minute)
	if err := r.Publish(); err != nil {
		return nil, err
	}
	v2, err := snap("replayed-old-snapshot/newer")
	if err != nil {
		return nil, err
	}
	old, err := snap("replayed-old-snapshot/older")
	if err != nil {
		return nil, err
	}
	if err := copyTree(v1, old); err != nil {
		return nil, err
	}
	add(FixtureCase{Name: "replayed-old-snapshot", Description: "client saw the newer timestamp/snapshot; an attacker replays the older signed set", PrimeWith: rel(v2), Expect: "rollback"}, old, targets)

	// expired timestamp (re-signed with an expiry before VerifyAt).
	if err := r.SetTimestampExpiry(now.Add(-time.Hour)); err != nil {
		return nil, err
	}
	exp, err := snap("expired-timestamp")
	if err != nil {
		return nil, err
	}
	add(FixtureCase{Name: "expired-timestamp", Description: "timestamp.json expired before verifyAt (freeze attack or stale repository)", Expect: "expired"}, exp, targets)
	if err := r.PublishTimestamp(); err != nil {
		return nil, err
	}

	// forged target hash: targets metadata edited after signing.
	forged, err := snap("forged-target-hash")
	if err != nil {
		return nil, err
	}
	tv := r.Versions()["targets"]
	tp := filepath.Join(forged, fmt.Sprintf("%d.targets.json", tv))
	var doc map[string]any
	b, _ := os.ReadFile(tp)
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	for _, t := range doc["signed"].(map[string]any)["targets"].(map[string]any) {
		hs := t.(map[string]any)["hashes"].(map[string]any)
		hs["sha256"] = "0000000000000000000000000000000000000000000000000000000000000000"
		break
	}
	b, _ = json.MarshalIndent(doc, "", " ")
	if err := os.WriteFile(tp, b, 0o644); err != nil {
		return nil, err
	}
	// The snapshot pins targets by version only (no hashes), so the signature check catches it.
	add(FixtureCase{Name: "forged-target-hash", Description: "a target hash was changed after signing: targets signature no longer verifies", Expect: "signature"}, forged, targets)

	// corrupt download / wrong length: metadata valid, the runtime's closure index bytes wrong.
	cur, err := snap("artifact-cases")
	if err != nil {
		return nil, err
	}
	for _, c := range []struct{ name, desc string }{
		{"corrupt-download", "artifact bytes flipped: length matches, hash does not"},
		{"wrong-length", "artifact has extra trailing bytes (endless-data style)"},
	} {
		td := filepath.Join(out, c.name, "targets")
		if err := copyTree(r.TargetsDir(), td); err != nil {
			return nil, err
		}
		rt, _ := r.TargetFilePath(RuntimeIndexTarget("1.0.0"))
		relp, _ := filepath.Rel(r.TargetsDir(), rt)
		p := filepath.Join(td, relp)
		b, _ := os.ReadFile(p)
		if c.name == "corrupt-download" {
			b[len(b)/2] ^= 0x01
		} else {
			b = append(b, []byte("trailing-bytes")...)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return nil, err
		}
		add(FixtureCase{Name: c.name, Description: c.desc, Release: "rt-fixture-1", Expect: "artifact"}, cur, td)
	}

	// rotated root: every role key rotated; the device pinned root v1 walks the chain.
	clock = clock.Add(time.Minute)
	if err := r.RotateKeys("root", "targets", "snapshot", "timestamp"); err != nil {
		return nil, err
	}
	rot, err := snap("rotated-root")
	if err != nil {
		return nil, err
	}
	add(FixtureCase{Name: "rotated-root", Description: "root v2 signed by old and new root keys; all role keys rotated", Release: "rt-fixture-1", Expect: "ok"}, rot, targets)

	b, _ = json.MarshalIndent(m, "", " ")
	return m, os.WriteFile(filepath.Join(out, "fixtures.json"), b, 0o644)
}
