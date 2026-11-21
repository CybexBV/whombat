package quarantine

import (
	"context"
	"crypto/ed25519"
	"math"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// TrustUntil records that a checkpoint signed by an earlier Whombat's key (key) is back on this box: from now on that
// key is trusted only for the checkpoints in known (and the restored one), never for one it makes later. A bound
// already recorded for the key stays.
func TrustUntil(c *state.Config, key ed25519.PublicKey, m *Marker, known []string) error {
	return listing.SaveBound(c, listing.Bound{Key: manifest.EncodeKey(key), ApplianceID: m.OldAppliance.ApplianceID,
		CheckpointID: m.Restored.CheckpointID, Seq: m.Restored.Seq, ManifestSHA256: m.Restored.ManifestSHA256, Known: known,
		SetAside: m.SetAside, At: time.Now().UTC()})
}

// trustAfterRestore bounds the Whombat whose backup came back (o.ManifestKey). When that is one of the earlier
// Whombats the adopted kit carried, its own bound stays as the kit said, and it is the adopted Whombat, whose kit
// this is and which this box replaces, that is bounded: at the backups it had made (BK-79).
func trustAfterRestore(ctx context.Context, c *state.Config, o ApplyOptions, m *Marker, mf *manifest.Manifest) error {
	keys, err := listing.LoadKeys(c)
	if err != nil {
		return err
	}
	if !keys.IsEarlier(o.ManifestKey) {
		known := o.Trusted
		if known == nil {
			known = knownUpTo(ctx, c, o.Repo, o.ManifestKey, mf.Seq)
		}
		return TrustUntil(c, o.ManifestKey, m, known)
	}
	if keys.Adopted == nil {
		return nil
	}
	known := o.AdoptedKnown
	if known == nil {
		known = knownUpTo(ctx, c, o.Repo, keys.Adopted, math.MaxInt64)
	}
	b := listing.Bound{Key: manifest.EncodeKey(keys.Adopted), CheckpointID: m.Restored.CheckpointID, Seq: m.Restored.Seq,
		ManifestSHA256: m.Restored.ManifestSHA256, Known: known, SetAside: m.SetAside, At: time.Now().UTC()}
	return listing.SaveBound(c, b)
}

// dropBound removes the bound a restore recorded when that restore is undone.
func dropBound(c *state.Config, stamp string) { listing.DropBound(c, stamp) }

// knownUpTo lists the manifest sha256s of key's checkpoints up to seq in repo (the console's restore, which doesn't
// list them before).
func knownUpTo(ctx context.Context, c *state.Config, repo restic.Repo, key ed25519.PublicKey, seq int64) []string {
	res, err := listing.List(ctx, c, repo, listing.Keys{Adopted: key})
	known := []string{}
	if err != nil {
		return known
	}
	for _, e := range res.Checkpoints {
		if !e.Own && e.Seq <= seq && e.ManifestSHA256 != "" {
			known = append(known, e.ManifestSHA256)
		}
	}
	return known
}
