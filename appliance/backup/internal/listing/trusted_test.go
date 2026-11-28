package listing

import (
	"crypto/ed25519"
	"errors"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// signedSnapshot is a checkpoint signed by key whose manifest is in the box's cache (no restic read needed).
func signedSnapshot(t *testing.T, c *state.Config, id string, key ed25519.PrivateKey) restic.Snapshot {
	t.Helper()
	raw, err := manifest.Encode(&manifest.Manifest{Kind: manifest.Kind, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	sig, err := manifest.Sign(raw, key)
	if err != nil {
		t.Fatal(err)
	}
	sha := manifest.SHA256(raw)
	ManifestCache(c).Put(sha, raw, sig)
	return restic.Snapshot{ID: "sn-" + id, ShortID: id, Hostname: "box",
		Tags: []string{manifest.TagProduct, manifest.TagIDPrefix + id, manifest.TagMFPrefix + sha}}
}

// The main place's snapshots this box copies and clears are its own and its trusted earlier Whombats', never another
// box's that shares the place (whatever host name it gave); one whose manifest can't be read now fails the call.
func TestTrustedIsThisBoxs(t *testing.T) {
	c := &state.Config{StateDir: t.TempDir()}
	keys, err := LoadKeys(c)
	if err != nil {
		t.Fatal(err)
	}
	own, err := manifest.LoadOrCreateKey(c.ManifestKeyPath())
	if err != nil {
		t.Fatal(err)
	}
	_, other, _ := ed25519.GenerateKey(nil)
	_, earlier, _ := ed25519.GenerateKey(nil)
	before := signedSnapshot(t, c, "earlier-1", earlier)
	after := signedSnapshot(t, c, "earlier-2", earlier)
	keys.Adopted = earlier.Public().(ed25519.PublicKey)
	keys.Until = &Bound{Key: manifest.EncodeKey(keys.Adopted), ManifestSHA256: before.Tag(manifest.TagMFPrefix)}
	snaps := []restic.Snapshot{signedSnapshot(t, c, "mine", own), signedSnapshot(t, c, "theirs", other), before, after}
	repo := restic.Repo{Binary: filepath.Join(t.TempDir(), "no-restic")}
	got, err := Trusted(t.Context(), c, repo, snaps, keys)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, s := range got {
		ids = append(ids, s.Tag(manifest.TagIDPrefix))
	}
	if len(ids) != 2 || ids[0] != "mine" || ids[1] != "earlier-1" {
		t.Fatalf("trusted: %v", ids)
	}
	unread := restic.Snapshot{ID: "sn-x", ShortID: "x", Tags: []string{manifest.TagProduct, manifest.TagIDPrefix + "x",
		manifest.TagMFPrefix + "0000000000000000000000000000000000000000000000000000000000000000"}}
	if _, err := Trusted(t.Context(), c, repo, append(snaps, unread), keys); !errors.Is(err, restore.ErrUnreadable) {
		t.Fatalf("a manifest that couldn't be read was dropped: %v", err)
	}
}
