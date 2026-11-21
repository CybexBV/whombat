// Package listing is the list of backups the person sees (BK-38, Whombat backup-options.md BKO-06): every snapshot
// tagged as a checkpoint whose signed manifest verifies with this box's key, the adopted one or an earlier Whombat's
// its kit carried (each within its bound), newest first, with why it was made, its size, what it added and its last
// restore check. Verified manifests are cached by their sha256 (the snapshot's mf: tag) with the key that verified
// them, so a list costs one `restic snapshots` once each manifest was read.
package listing

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Check is a backup's last restore check.
type Check struct {
	At time.Time `json:"at"`
	OK bool      `json:"ok"`
}

// Entry is one backup (@whombat/protocol BackupCheckpoint).
type Entry struct {
	ID            string    `json:"id"`
	Seq           int64     `json:"seq"`
	SnapshotID    string    `json:"snapshotId"`
	CreatedAt     time.Time `json:"createdAt"`
	Reason        string    `json:"reason"`
	ReleaseID     string    `json:"releaseId,omitempty"`
	Version       string    `json:"version,omitempty"`
	SchemaVersion int       `json:"schemaVersion"`
	Bytes         int64     `json:"bytes"`
	BytesAdded    *int64    `json:"bytesAdded"`
	ApplianceID   string    `json:"applianceId"`
	Own           bool      `json:"own"`
	Check         *Check    `json:"check"`
	// Incomplete is set for a backup made with a gap (uploaded anyway): what it lacks.
	Incomplete *Incomplete `json:"incomplete,omitempty"`
	// Covered is what it holds, from its signed manifest: the ids of the coverage classes it covers (BackupScope ids,
	// for the app's “What’s in it”). Absent for a manifest from before coverage was recorded.
	Covered []string `json:"covered,omitempty"`
	// The key that signed it (this box's, the adopted Whombat's or an earlier one's), the verified manifest and its
	// sha256, for a restore's checks before it starts.
	Signer         ed25519.PublicKey  `json:"-"`
	Manifest       *manifest.Manifest `json:"-"`
	ManifestSHA256 string             `json:"-"`
}

// Incomplete is what a backup lacks: attachments that weren't on the box, the servers.
type Incomplete struct {
	Attachments int  `json:"attachments,omitempty"`
	Servers     bool `json:"servers,omitempty"`
}

// Local is what is left in the box's own repository while the destination is elsewhere (BKO-08).
type Local struct {
	Count  int        `json:"count"`
	Bytes  int64      `json:"bytes"`
	Oldest *time.Time `json:"oldest"`
	Newest *time.Time `json:"newest"`
}

// Result is the list (@whombat/protocol BackupCheckpointList).
type Result struct {
	Checkpoints []Entry `json:"checkpoints"`
	Unauthentic int     `json:"unauthentic"`
	Local       *Local  `json:"local"`
}

// Keys are the manifest keys a list trusts: this box's own and, after a restore or while one is being prepared, the
// earlier box's (the adopted one), and the Whombats before that one its kit carried (Earlier).
type Keys struct {
	Own     ed25519.PublicKey
	Adopted ed25519.PublicKey
	// Until bounds the adopted key once one of its checkpoints was restored here (nil: not bounded).
	Until *Bound
	// Earlier are the keys of the Whombats the adopted one was brought back from (its kit's `adopted`, BK-79): each is
	// trusted only up to its own bound.
	Earlier []Earlier
}

// Earlier is an earlier Whombat's key and its bound.
type Earlier struct {
	Key   ed25519.PublicKey
	Bound Bound
}

// Bound is <stateDir>/keys/adopted-until.json. Once a checkpoint signed by an earlier Whombat's key is back on this
// box, that Whombat is retired: its key is trusted only for the checkpoints it had made by then (Known), so whoever
// still holds the old box (stolen, or not wiped) can't add backups this box would list or bring back. The bounds of
// the Whombats before it are in <stateDir>/keys/adopted-earlier.json.
type Bound struct {
	Key            string    `json:"key"` // the adopted manifest key it bounds (manifest.EncodeKey)
	ApplianceID    string    `json:"applianceId,omitempty"`
	CheckpointID   string    `json:"checkpointId"`
	Seq            int64     `json:"seq"`
	ManifestSHA256 string    `json:"manifestSha256"`
	Known          []string  `json:"known"` // manifest sha256s of the key's checkpoints up to the restored one, newest first
	SetAside       string    `json:"setAside,omitempty"`
	At             time.Time `json:"at"`
}

// allows says whether the bound trusts the checkpoint whose manifest has this sha256.
func (b *Bound) allows(sha string) bool {
	return sha == b.ManifestSHA256 || slices.Contains(b.Known, sha)
}

// BoundPath is where the bound is kept.
func BoundPath(c *state.Config) string {
	return filepath.Join(c.StateDir, "keys", "adopted-until.json")
}

// EarlierPath is where the earlier Whombats' keys and bounds are kept (a JSON list of Bound).
func EarlierPath(c *state.Config) string {
	return filepath.Join(c.StateDir, "keys", "adopted-earlier.json")
}

// HeadPath is the newest checkpoint the adopted kit knew (quarantine.AdoptedHead reads it).
func HeadPath(c *state.Config) string {
	return filepath.Join(c.StateDir, "keys", "adopted-head.json")
}

// LoadBound reads the bound (nil when there is none).
func LoadBound(c *state.Config) *Bound {
	b, err := state.ReadStateFile(BoundPath(c))
	if err != nil {
		return nil
	}
	var bd Bound
	if json.Unmarshal(b, &bd) != nil || bd.Key == "" {
		return nil
	}
	return &bd
}

// loadEarlier reads the earlier Whombats' bounds (none when there are none or the file is unreadable).
func loadEarlier(c *state.Config) []Bound {
	b, err := state.ReadStateFile(EarlierPath(c))
	if err != nil {
		return nil
	}
	var out []Bound
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

// SaveBound records a bound. One already there for the same key stays (a bound is never loosened).
func SaveBound(c *state.Config, b Bound) error {
	if old := LoadBound(c); old != nil && old.Key == b.Key {
		return nil
	}
	return state.WriteJSON(BoundPath(c), b, 0o600)
}

// DropBound removes the bound a restore recorded (the restore was undone, so nothing was brought back).
func DropBound(c *state.Config, setAside string) {
	if b := LoadBound(c); b != nil && setAside != "" && b.SetAside == setAside {
		_ = state.RemoveStateFile(BoundPath(c))
	}
}

// Adopt records whose backups this box trusts after it joined an earlier Whombat's place with its kit (BK-78): that
// Whombat's key (key), the newest checkpoint its kit knew (head, nil: none), and the Whombats its kit says it was
// brought back from, each with its cut-off. Everything an earlier adopt recorded is replaced, so a second adopt never
// keeps the first one's key. A bound this box itself recorded for one of these keys stays (it is never loosened).
func Adopt(c *state.Config, key ed25519.PublicKey, head *restore.ExpectedHead, earlier []kit.Adopted) error {
	kept := map[string]Bound{}
	for _, b := range loadEarlier(c) {
		kept[b.Key] = b
	}
	if b := LoadBound(c); b != nil {
		kept[b.Key] = *b
	}
	enc := manifest.EncodeKey(key)
	if err := state.WriteFileAtomic(c.AdoptedManifestKeyPath(), []byte(enc+"\n"), 0o600); err != nil {
		return err
	}
	if b, ok := kept[enc]; ok {
		b.SetAside = "" // not this box's restore to undo any more
		if err := state.WriteJSON(BoundPath(c), b, 0o600); err != nil {
			return err
		}
	} else if err := state.RemoveStateFile(BoundPath(c)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if head != nil && head.ManifestSHA256 != "" {
		if err := state.WriteJSON(HeadPath(c), *head, 0o600); err != nil {
			return err
		}
	} else if err := state.RemoveStateFile(HeadPath(c)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	own, _ := ownKey(c)
	list := []Bound{}
	for _, a := range earlier {
		pk, err := manifest.ParseKey(a.ManifestKey)
		if err != nil || pk.Equal(key) || (own != nil && pk.Equal(own)) {
			continue
		}
		b, ok := kept[a.ManifestKey]
		if !ok {
			b = Bound{Key: a.ManifestKey, ApplianceID: a.ApplianceID, CheckpointID: a.Until.CheckpointID, Seq: a.Until.Seq,
				ManifestSHA256: a.Until.ManifestSHA256, Known: a.Until.Known, At: time.Now().UTC()}
		}
		b.SetAside = ""
		list = append(list, b)
	}
	if len(list) == 0 {
		if err := state.RemoveStateFile(EarlierPath(c)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return state.WriteJSON(EarlierPath(c), list, 0o600)
}

// Carried is what this box's kit says about the Whombats it was brought back from (kit.Material.Adopted): the adopted
// key once one of its backups is back here (with that bound), then the earlier ones, at most kit.MaxAdopted, each with
// its newest kit.MaxKnown known backups. An adopted key that isn't bounded yet (nothing brought back) isn't carried.
func (k Keys) Carried() []kit.Adopted {
	var out []kit.Adopted
	add := func(b Bound) {
		if len(out) == kit.MaxAdopted || b.Key == "" || (k.Own != nil && b.Key == manifest.EncodeKey(k.Own)) {
			return
		}
		for _, a := range out {
			if a.ManifestKey == b.Key {
				return
			}
		}
		known := b.Known[:min(len(b.Known), kit.MaxKnown)]
		out = append(out, kit.Adopted{ApplianceID: b.ApplianceID, ManifestKey: b.Key, Until: kit.Until{
			CheckpointID: b.CheckpointID, Seq: b.Seq, ManifestSHA256: b.ManifestSHA256, Known: append([]string{}, known...)}})
	}
	if k.Adopted != nil && k.Until != nil && k.Until.Key == manifest.EncodeKey(k.Adopted) {
		add(*k.Until)
	}
	for _, e := range k.Earlier {
		add(e.Bound)
	}
	return out
}

// Trusts says whether a checkpoint verified with the own key (own) or the adopted one is to be trusted.
func (k Keys) Trusts(own bool, sha string) bool {
	if own {
		return true
	}
	return k.Adopted == nil || k.TrustsKey(k.Adopted, sha)
}

// TrustsKey says whether a checkpoint signed by key, one of k's, is to be trusted: the own key's always, the adopted
// key's up to its bound once one was recorded, an earlier Whombat's only up to its own.
func (k Keys) TrustsKey(key ed25519.PublicKey, sha string) bool {
	switch {
	case key == nil:
		return false
	case k.Own != nil && key.Equal(k.Own):
		return true
	case k.Adopted != nil && key.Equal(k.Adopted):
		return k.Until == nil || k.Until.Key != manifest.EncodeKey(k.Adopted) || k.Until.allows(sha)
	}
	for i := range k.Earlier {
		if key.Equal(k.Earlier[i].Key) {
			return k.Earlier[i].Bound.allows(sha)
		}
	}
	return false
}

// IsEarlier says whether key is one of the earlier Whombats' (not the own or the adopted one).
func (k Keys) IsEarlier(key ed25519.PublicKey) bool {
	for _, e := range k.Earlier {
		if key.Equal(e.Key) {
			return true
		}
	}
	return false
}

// all are the keys in the order a manifest is tried with: the own, the adopted, the earlier ones.
func (k Keys) all() []ed25519.PublicKey {
	var out []ed25519.PublicKey
	if k.Own != nil {
		out = append(out, k.Own)
	}
	if k.Adopted != nil {
		out = append(out, k.Adopted)
	}
	for _, e := range k.Earlier {
		out = append(out, e.Key)
	}
	return out
}

// LoadKeys reads both (Adopted nil when nothing was adopted), the adopted key's bound and the earlier Whombats' keys.
func LoadKeys(c *state.Config) (Keys, error) {
	own, err := ownKey(c)
	if err != nil {
		return Keys{}, err
	}
	keys := Keys{Own: own}
	if b, err := state.ReadStateFile(c.AdoptedManifestKeyPath()); err == nil {
		if pk, err := manifest.ParseKey(strings.TrimSpace(string(b))); err == nil {
			keys.Adopted = pk
			keys.Until = LoadBound(c)
		}
	}
	if keys.Adopted == nil {
		return keys, nil
	}
	for _, b := range loadEarlier(c) {
		pk, err := manifest.ParseKey(b.Key)
		if err != nil || pk.Equal(keys.Adopted) || (own != nil && pk.Equal(own)) || keys.IsEarlier(pk) {
			continue
		}
		keys.Earlier = append(keys.Earlier, Earlier{Key: pk, Bound: b})
	}
	return keys, nil
}

// ownKey is this box's manifest key. A root run (a restore) reads it without following anything and never makes one:
// a box that never signed a backup has none (nil).
func ownKey(c *state.Config) (ed25519.PublicKey, error) {
	if state.InRootMode() {
		seed, err := state.ReadStateFile(c.ManifestKeyPath())
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, nil
		}
		return ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey), nil
	}
	k, err := manifest.LoadOrCreateKey(c.ManifestKeyPath())
	if err != nil {
		return nil, err
	}
	return k.Public().(ed25519.PublicKey), nil
}

// cached is one manifest in <stateDir>/manifests/<sha256>.json: verified by this list (Own says with which key), or,
// Raw, only read (by a check or a list that hasn't verified it yet) and kept with its signature so nobody downloads
// it again. The bytes are kept as they are (base64): kept as embedded JSON they were indented again when written and
// never matched their sha256, so the cache was never used.
//
// Key is the key that verified it: an entry is taken as verified only while that key is still one the list trusts, so a
// manifest an earlier adopt's key verified is never listed under the next adopt's (BK-78). An entry from before Key was
// kept is verified again from its bytes.
type cached struct {
	Own      bool   `json:"own"`
	Key      string `json:"key,omitempty"`
	Manifest []byte `json:"manifestBytes"`
	Sig      []byte `json:"sig,omitempty"`
	Raw      bool   `json:"raw,omitempty"`
}

var shaName = regexp.MustCompile(`^[0-9a-f]{64}$`)

func cacheDir(c *state.Config) string { return filepath.Join(c.StateDir, "manifests") }

func readEntry(c *state.Config, sha string) (*cached, bool) {
	if !shaName.MatchString(sha) {
		return nil, false
	}
	b, err := state.ReadStateFile(filepath.Join(cacheDir(c), sha+".json"))
	if err != nil {
		return nil, false
	}
	var e cached
	if json.Unmarshal(b, &e) != nil || manifest.SHA256(e.Manifest) != sha {
		return nil, false
	}
	return &e, true
}

// readCached is a manifest the cache says one of keys verified, with that key.
func readCached(c *state.Config, sha string, keys Keys) (*manifest.Manifest, ed25519.PublicKey, bool) {
	e, ok := readEntry(c, sha)
	if !ok || e.Raw || e.Key == "" {
		return nil, nil, false
	}
	var signer ed25519.PublicKey
	for _, k := range keys.all() {
		if manifest.EncodeKey(k) == e.Key {
			signer = k
			break
		}
	}
	var m manifest.Manifest
	if signer == nil || json.Unmarshal(e.Manifest, &m) != nil {
		return nil, nil, false
	}
	return &m, signer, true
}

// WarmCache keeps a manifest this box just signed (a checkpoint, with its own key) or verified (a copy), so the list
// needn't read it back.
func WarmCache(c *state.Config, sha string, raw, sig []byte, key ed25519.PublicKey) {
	writeCached(c, sha, raw, sig, key, true)
}

func writeCached(c *state.Config, sha string, raw, sig []byte, key ed25519.PublicKey, own bool) {
	writeEntry(c, sha, cached{Own: own, Key: manifest.EncodeKey(key), Manifest: raw, Sig: sig})
}

func writeEntry(c *state.Config, sha string, e cached) {
	if !shaName.MatchString(sha) || state.InRootMode() {
		return
	}
	_ = os.MkdirAll(cacheDir(c), 0o700)
	_ = state.WriteJSON(filepath.Join(cacheDir(c), sha+".json"), e, 0o600)
}

// ManifestCache is the box's manifest cache for restore.ListCached (drills, restores, lists): what it hands out is
// verified again with the key the caller trusts, so a raw entry is as good as a verified one there.
func ManifestCache(c *state.Config) restore.ManifestCache { return manifestCache{c} }

type manifestCache struct{ c *state.Config }

func (m manifestCache) Get(sha string) ([]byte, []byte, bool) {
	e, ok := readEntry(m.c, sha)
	if !ok || len(e.Sig) == 0 {
		return nil, nil, false
	}
	return e.Manifest, e.Sig, true
}

func (m manifestCache) Put(sha string, raw, sig []byte) {
	if e, ok := readEntry(m.c, sha); ok && !e.Raw && len(e.Sig) > 0 {
		return // verified already
	} else if ok && !e.Raw {
		e.Sig = sig // a verified entry from before signatures were kept
		writeEntry(m.c, sha, *e)
		return
	}
	writeEntry(m.c, sha, cached{Manifest: raw, Sig: sig, Raw: true})
}

// unauthenticPath records snapshots whose manifest was read and didn't verify with the keys of the time
// (<stateDir>/manifests/unauthentic.json: snapshot id → the keys' fingerprint). A snapshot never changes, so it isn't
// read again until the keys do; one that couldn't be read is tried again every time.
func unauthenticPath(c *state.Config) string { return filepath.Join(cacheDir(c), "unauthentic.json") }

// fingerprint covers the adopted key's bound and the earlier Whombats' keys and bounds too: a snapshot refused only for
// being past a bound is listed again once an undone restore drops that bound.
func (k Keys) fingerprint() string {
	h := sha256.New()
	h.Write(k.Own)
	h.Write([]byte{0})
	h.Write(k.Adopted)
	bound := func(b *Bound) {
		h.Write([]byte{0})
		h.Write([]byte(b.Key + "\x00" + b.ManifestSHA256 + "\x00" + strings.Join(b.Known, ",")))
	}
	if k.Until != nil {
		bound(k.Until)
	}
	for i := range k.Earlier {
		h.Write([]byte{1})
		h.Write(k.Earlier[i].Key)
		bound(&k.Earlier[i].Bound)
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func loadUnauthentic(c *state.Config) map[string]string {
	out := map[string]string{}
	if b, err := state.ReadStateFile(unauthenticPath(c)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// Authenticate verifies one snapshot's manifest the way the list does (the keys it trusts, the box's manifest cache)
// and says whether it is one of this box's own.
func Authenticate(ctx context.Context, c *state.Config, repo restic.Repo, s restic.Snapshot, keys Keys) (*manifest.Manifest, bool, error) {
	m, signer, err := authenticate(ctx, c, repo, s, keys)
	return m, err == nil && keys.Own != nil && signer.Equal(keys.Own), err
}

// Signer is the key that signed the checkpoint id among keys (the one a check or a restore of it trusts), with its
// manifest; restore.ErrUnauthentic when none of keys trusts a snapshot of it.
func Signer(ctx context.Context, c *state.Config, repo restic.Repo, keys Keys, id string) (ed25519.PublicKey, *manifest.Manifest, error) {
	snaps, err := repo.Snapshots(ctx, manifest.TagIDPrefix+id)
	if err != nil {
		return nil, nil, err
	}
	for _, s := range snaps {
		if m, signer, err := authenticate(ctx, c, repo, s, keys); err == nil && m.ID == id {
			return signer, m, nil
		}
	}
	return nil, nil, fmt.Errorf("%w: no trusted backup %s", restore.ErrUnauthentic, id)
}

// authenticate verifies a snapshot's manifest with the own key, then the adopted one, then the earlier Whombats', and
// says which verified it. The manifest is read once (the next key's try and the cache take it from the first read).
func authenticate(ctx context.Context, c *state.Config, repo restic.Repo, s restic.Snapshot, keys Keys) (*manifest.Manifest, ed25519.PublicKey, error) {
	m, signer, err := verify(ctx, c, repo, s, keys)
	if err == nil && !keys.TrustsKey(signer, s.Tag(manifest.TagMFPrefix)) {
		return nil, nil, fmt.Errorf("%w: snapshot %s: signed by an earlier Whombat after the backup brought back from it", restore.ErrUnauthentic, s.ShortID)
	}
	return m, signer, err
}

func verify(ctx context.Context, c *state.Config, repo restic.Repo, s restic.Snapshot, keys Keys) (*manifest.Manifest, ed25519.PublicKey, error) {
	sha := s.Tag(manifest.TagMFPrefix)
	if m, signer, ok := readCached(c, sha, keys); ok && s.Tag(manifest.TagIDPrefix) == m.ID {
		return m, signer, nil
	}
	cache := ManifestCache(c)
	err := error(restore.ErrUnauthentic)
	for _, key := range keys.all() {
		var m *manifest.Manifest
		var sum string
		m, sum, err = restore.AuthenticateCached(ctx, repo, s, key, cache)
		if err == nil {
			if raw, sig, ok := cache.Get(sum); ok {
				writeCached(c, sum, raw, sig, key, keys.Own != nil && key.Equal(keys.Own))
			}
			return m, key, nil
		}
		if errors.Is(err, restore.ErrUnreadable) {
			break // the next key would read it again
		}
	}
	return nil, nil, err
}

// List lists the backups in repo, newest first.
func List(ctx context.Context, c *state.Config, repo restic.Repo, keys Keys) (*Result, error) {
	snaps, err := repo.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, err
	}
	checks := Checks(c)
	res := &Result{Checkpoints: []Entry{}}
	seen := map[string]bool{}
	bad, fp, badChanged := loadUnauthentic(c), keys.fingerprint(), false
	for _, s := range snaps {
		if bad[s.ID] == fp {
			res.Unauthentic++
			continue
		}
		m, signer, err := authenticate(ctx, c, repo, s, keys)
		if err != nil {
			if errors.Is(err, restore.ErrUnauthentic) {
				res.Unauthentic++
				if !errors.Is(err, restore.ErrUnreadable) {
					bad[s.ID], badChanged = fp, true
				}
				continue
			}
			return nil, err
		}
		if seen[m.ID] { // the same checkpoint twice (a copy): once
			continue
		}
		seen[m.ID] = true
		own := keys.Own != nil && signer.Equal(keys.Own)
		e := Entry{ID: m.ID, Seq: m.Seq, SnapshotID: s.ID, CreatedAt: m.CreatedAt.UTC(), Reason: reasonOf(m.Reason),
			Version: m.Runtime.Version, SchemaVersion: m.Database.SchemaVersion, Bytes: sizeOf(m), ApplianceID: m.ApplianceID,
			Own: own, Signer: signer, Manifest: m, ManifestSHA256: s.Tag(manifest.TagMFPrefix)}
		if m.Migration != nil {
			e.ReleaseID = m.Migration.ReleaseID
		}
		if s.Summary != nil {
			added := s.Summary.DataAdded
			e.BytesAdded = &added
		}
		if ck, ok := checks[m.ID]; ok {
			e.Check = &ck
		}
		if g := m.Incomplete; g != nil && (g.MissingAttachments > 0 || g.Servers != "") {
			e.Incomplete = &Incomplete{Attachments: g.MissingAttachments, Servers: g.Servers != ""}
		}
		e.Covered = coveredOf(m)
		res.Checkpoints = append(res.Checkpoints, e)
	}
	sort.Slice(res.Checkpoints, func(i, j int) bool {
		return res.Checkpoints[i].CreatedAt.After(res.Checkpoints[j].CreatedAt)
	})
	if badChanged && !state.InRootMode() {
		_ = os.MkdirAll(cacheDir(c), 0o700)
		_ = state.WriteJSON(unauthenticPath(c), bad, 0o600)
	}
	return res, nil
}

// coveredOf lists the coverage classes a backup covers. The servers count only when their archive is in it: a backup
// whose servers export failed still records the class as covered by the layout. At most 32 ids of the server's id
// form, so one odd id from a newer service can't cost the whole list.
func coveredOf(m *manifest.Manifest) []string {
	var out []string
	for _, c := range m.Coverage {
		if !c.Covered || !coverageID.MatchString(c.ID) || (c.ID == "servers" && m.Hosts == nil) || slices.Contains(out, c.ID) {
			continue
		}
		if out = append(out, c.ID); len(out) == 32 {
			break
		}
	}
	return out
}

var coverageID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,32}$`)

func reasonOf(r string) string {
	switch r {
	case "scheduled", "manual", "pre-migration", "test":
		return r
	}
	return "unknown"
}

func sizeOf(m *manifest.Manifest) int64 {
	n := m.Database.Dump.Size
	for _, s := range m.Sources {
		n += s.Bytes
	}
	return n
}

// LocalRepositoryPath is where a box that backed up to its own disk keeps that repository.
func LocalRepositoryPath(c *state.Config) string {
	return filepath.Join(c.StateDir, "local-repository")
}

// LocalLeftover counts what is left in the box's own repository while the destination is elsewhere; nil when
// there is none (or it is the destination).
func LocalLeftover(ctx context.Context, c *state.Config, d *state.Destination) (*Local, error) {
	path := LocalRepositoryPath(c)
	if d != nil && d.Kind == state.KindLocal && filepath.Clean(d.Repository) == path {
		return nil, nil
	}
	if fi, err := os.Stat(filepath.Join(path, "config")); err != nil || !fi.Mode().IsRegular() {
		return nil, nil
	}
	repo := LocalRepo(c)
	snaps, err := repo.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, err
	}
	out := &Local{Count: len(snaps)}
	for i := range snaps {
		t := snaps[i].Time.UTC()
		if out.Oldest == nil || t.Before(*out.Oldest) {
			out.Oldest = &t
		}
		if out.Newest == nil || t.After(*out.Newest) {
			out.Newest = &t
		}
	}
	out.Bytes = dirSize(path)
	return out, nil
}

// LocalRepo is the box's own repository (the same password as every destination of this box).
func LocalRepo(c *state.Config) restic.Repo {
	r := restic.Repo{Binary: c.Restic, Repository: LocalRepositoryPath(c), PasswordFile: c.RepositoryPasswordPath(),
		CacheDir: c.CacheDir()}
	if c.NoCache {
		r.CacheDir, r.NoCache = "", true
	}
	return r
}

func dirSize(root string) int64 {
	var n int64
	_ = filepath.WalkDir(root, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

/* Restore checks per backup ----------------------------------------------------------------------------------- */

// ChecksPath is <stateDir>/drills.jsonl: one line per restore check.
func ChecksPath(c *state.Config) string { return filepath.Join(c.StateDir, "drills.jsonl") }

type checkLine struct {
	CheckpointID string    `json:"checkpointId"`
	At           time.Time `json:"at"`
	OK           bool      `json:"ok"`
}

// RecordCheck appends a restore check's result.
func RecordCheck(c *state.Config, checkpointID string, at time.Time, ok bool) error {
	if checkpointID == "" {
		return nil
	}
	b, _ := json.Marshal(checkLine{CheckpointID: checkpointID, At: at.UTC(), OK: ok})
	return state.AppendLine(ChecksPath(c), b)
}

// Checks is the newest check of each backup.
func Checks(c *state.Config) map[string]Check {
	out := map[string]Check{}
	if state.InRootMode() {
		return out // a restore lists without them, and root never opens a file of the backup user's this way (BK-26)
	}
	f, err := os.Open(ChecksPath(c))
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var l checkLine
		if json.Unmarshal(sc.Bytes(), &l) != nil || l.CheckpointID == "" {
			continue
		}
		if prev, ok := out[l.CheckpointID]; !ok || l.At.After(prev.At) {
			out[l.CheckpointID] = Check{At: l.At, OK: l.OK}
		}
	}
	return out
}
