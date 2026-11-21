package devtuf

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// The GitHub repository (Whombat LNK-24…LNK-26): its metadata directory is the `metadata/` folder of the
// whombat-releases repository, which GitHub Pages serves at releases.whombat.com; the publisher on the machine that runs the candidate signs the
// online roles (development, clients) and pushes them, the repository's workflow signs snapshot and timestamp
// (ResignOnline) on each push and every 6 hours. Root, top-level targets and production are signed offline.

var versionedName = regexp.MustCompile(`^([0-9]+)\.([a-z][a-z0-9-]*)\.json$`)

// NewestOnDisk is the highest N of the files N.<role>.json in a metadata directory (0 if none).
func NewestOnDisk(metaDir, role string) int64 {
	entries, err := os.ReadDir(metaDir)
	if err != nil {
		return 0
	}
	var best int64
	for _, e := range entries {
		m := versionedName.FindStringSubmatch(e.Name())
		if m == nil || m[2] != role {
			continue
		}
		if v, err := strconv.ParseInt(m[1], 10, 64); err == nil && v > best {
			best = v
		}
	}
	return best
}

// loadNewest reads the newest version on disk of the targets and delegated roles (GitHub layout): the workflow's
// snapshot may not list a version the publisher pushed yet, and a role version is never signed twice.
func (r *Repo) loadNewest() error {
	md := r.metaDir()
	if v := NewestOnDisk(md, metadata.TARGETS); v > r.targets.Signed.Version {
		t, err := metadata.Targets().FromFile(filepath.Join(md, fmt.Sprintf("%d.targets.json", v)))
		if err != nil {
			return err
		}
		r.targets = t
	}
	if r.targets.Signed.Delegations == nil {
		return nil
	}
	for _, dr := range r.targets.Signed.Delegations.Roles {
		cur := int64(0)
		switch {
		case dr.Name == trust.ClientsRole && r.clients != nil:
			cur = r.clients.Signed.Version
		case r.channels[dr.Name] != nil:
			cur = r.channels[dr.Name].Signed.Version
		}
		v := NewestOnDisk(md, dr.Name)
		if v <= cur {
			continue
		}
		t, err := metadata.Targets().FromFile(filepath.Join(md, fmt.Sprintf("%d.%s.json", v, dr.Name)))
		if err != nil {
			return err
		}
		if dr.Name == trust.ClientsRole {
			r.clients = t
		} else if trust.ValidChannel(dr.Name) {
			r.channels[dr.Name] = t
		}
	}
	return nil
}

// OnlineKey reads a key file's content (the devtuf key-file JSON) given in an environment variable: the workflow's
// snapshot and timestamp keys come from Actions secrets that way, never from a file in the repository.
func OnlineKey(envName string) (ed25519.PrivateKey, error) {
	raw := os.Getenv(envName)
	if raw == "" {
		return nil, fmt.Errorf("devtuf: %s is empty", envName)
	}
	_, seed, err := parseKeyFile([]byte(raw), envName)
	if err != nil {
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// ReadKeyFile reads a development key file and checks its role.
func ReadKeyFile(path, role string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	got, seed, err := parseKeyFile(b, filepath.Base(path))
	if err != nil {
		return nil, err
	}
	if role != "" && got != role {
		return nil, fmt.Errorf("devtuf: %s is a %s key, not a %s key", path, got, role)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// verifiedChain reads the root chain 1…N from a metadata directory, each version signed by its predecessor's root
// role and by itself, and returns the newest.
func verifiedChain(metaDir string) (*metadata.Metadata[metadata.RootType], error) {
	first, err := metadata.Root().FromFile(filepath.Join(metaDir, "1.root.json"))
	if err != nil {
		return nil, fmt.Errorf("devtuf: 1.root.json: %w", err)
	}
	if err := first.VerifyDelegate(metadata.ROOT, first); err != nil {
		return nil, fmt.Errorf("devtuf: 1.root.json is not self-signed: %w", err)
	}
	cur := first
	for v := int64(2); ; v++ {
		next, err := metadata.Root().FromFile(filepath.Join(metaDir, fmt.Sprintf("%d.root.json", v)))
		if errors.Is(err, os.ErrNotExist) {
			return cur, nil
		}
		if err != nil {
			return nil, err
		}
		if next.Signed.Version != v {
			return nil, fmt.Errorf("devtuf: %d.root.json says version %d", v, next.Signed.Version)
		}
		if err := cur.VerifyDelegate(metadata.ROOT, next); err != nil {
			return nil, fmt.Errorf("devtuf: %d.root.json is not signed by root %d: %w", v, v-1, err)
		}
		if err := next.VerifyDelegate(metadata.ROOT, next); err != nil {
			return nil, fmt.Errorf("devtuf: %d.root.json is not self-signed: %w", v, err)
		}
		cur = next
	}
}

// newestVerifiedTargets is the newest N.<role>.json that verifies against its delegator (the root for targets, the
// top-level targets for a delegated role); versions that don't verify are skipped (and reported).
func newestVerifiedTargets(metaDir, role string, verify func(*metadata.Metadata[metadata.TargetsType]) error) (*metadata.Metadata[metadata.TargetsType], []string) {
	var skipped []string
	for v := NewestOnDisk(metaDir, role); v > 0; v-- {
		p := filepath.Join(metaDir, fmt.Sprintf("%d.%s.json", v, role))
		md, err := metadata.Targets().FromFile(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err == nil && md.Signed.Version == v {
			if err = verify(md); err == nil {
				return md, skipped
			}
		}
		skipped = append(skipped, fmt.Sprintf("%d.%s.json: %v", v, role, err))
	}
	return nil, skipped
}

// ResignOptions are ResignOnline's.
type ResignOptions struct {
	Now time.Time
	// SnapshotExpiry and TimestampExpiry default to LNK-25's 3 days.
	SnapshotExpiry, TimestampExpiry time.Duration
	// SnapshotWithin re-signs an unchanged snapshot when it expires within this (default 2 days); a changed role
	// always makes a new snapshot.
	SnapshotWithin time.Duration
	// KeepSnapshots keeps that many snapshot files (default 20); older ones go (git keeps them).
	KeepSnapshots int
}

// ResignResult says what ResignOnline signed.
type ResignResult struct {
	Snapshot      int64            `json:"snapshot"`
	SnapshotNew   bool             `json:"snapshotNew"`
	Timestamp     int64            `json:"timestamp"`
	Expires       time.Time        `json:"expires"`
	Roles         map[string]int64 `json:"roles"`
	Skipped       []string         `json:"skipped,omitempty"`
	PrunedSnaps   int              `json:"prunedSnapshots,omitempty"`
	RootVersion   int64            `json:"root"`
	TargetsExpiry time.Time        `json:"targetsExpires"`
}

// ResignOnline signs a new timestamp (and, when a role changed or the snapshot nears its expiry, a new snapshot) over
// the newest verified role files of a metadata directory: the root chain from 1.root.json, the top-level targets
// signed by the root's targets keys, every delegated role signed by its delegation. The keys must be the root's
// snapshot and timestamp keys. It never signs a role it could not verify, so a broken push can't reach a box, and it
// signs nothing when a role the top-level targets delegate has no version that verifies (a snapshot without it would
// drop that channel for every box).
func ResignOnline(metaDir string, snapshotKey, timestampKey ed25519.PrivateKey, o ResignOptions) (*ResignResult, error) {
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	o.Now = o.Now.UTC()
	if o.SnapshotExpiry == 0 {
		o.SnapshotExpiry = GitHubSnapshotExpiry
	}
	if o.TimestampExpiry == 0 {
		o.TimestampExpiry = GitHubTimestampExpiry
	}
	if o.SnapshotWithin == 0 {
		o.SnapshotWithin = 2 * 24 * time.Hour
	}
	if o.KeepSnapshots == 0 {
		o.KeepSnapshots = 20
	}
	root, err := verifiedChain(metaDir)
	if err != nil {
		return nil, err
	}
	for role, k := range map[string]ed25519.PrivateKey{metadata.SNAPSHOT: snapshotKey, metadata.TIMESTAMP: timestampKey} {
		key, _ := metadata.KeyFromPublicKey(k.Public())
		id, _ := key.ID()
		if !containsString(root.Signed.Roles[role].KeyIDs, id) {
			return nil, fmt.Errorf("devtuf: the %s key given is not root %d's %s key", role, root.Signed.Version, role)
		}
	}
	res := &ResignResult{Roles: map[string]int64{}, RootVersion: root.Signed.Version}
	top, skipped := newestVerifiedTargets(metaDir, metadata.TARGETS, func(md *metadata.Metadata[metadata.TargetsType]) error {
		return root.VerifyDelegate(metadata.TARGETS, md)
	})
	res.Skipped = append(res.Skipped, skipped...)
	if top == nil {
		return nil, fmt.Errorf("devtuf: no top-level targets verify against root %d", root.Signed.Version)
	}
	res.Roles[metadata.TARGETS] = top.Signed.Version
	res.TargetsExpiry = top.Signed.Expires
	if top.Signed.Delegations != nil {
		for _, dr := range top.Signed.Delegations.Roles {
			md, skipped := newestVerifiedTargets(metaDir, dr.Name, func(md *metadata.Metadata[metadata.TargetsType]) error {
				return top.VerifyDelegate(dr.Name, md)
			})
			res.Skipped = append(res.Skipped, skipped...)
			if md == nil {
				// A snapshot without the role would take the channel away from every box that follows it; signing
				// nothing keeps the last snapshot and timestamp serving the last good role until a person fixes it.
				return nil, fmt.Errorf("devtuf: no version of the %s role verifies against targets %d (%s): nothing signed",
					dr.Name, top.Signed.Version, strings.Join(skipped, "; "))
			}
			res.Roles[dr.Name] = md.Signed.Version
		}
	}
	// The current snapshot: the one the timestamp names, else the newest on disk.
	var snap *metadata.Metadata[metadata.SnapshotType]
	var ts *metadata.Metadata[metadata.TimestampType]
	if t, err := metadata.Timestamp().FromFile(filepath.Join(metaDir, "timestamp.json")); err == nil {
		ts = t
		if sm := t.Signed.Meta["snapshot.json"]; sm != nil {
			snap, _ = metadata.Snapshot().FromFile(filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", sm.Version)))
		}
	}
	snapVersion := NewestOnDisk(metaDir, metadata.SNAPSHOT)
	if snap != nil && snap.Signed.Version > snapVersion {
		snapVersion = snap.Signed.Version
	}
	changed := snap == nil || len(snap.Signed.Meta) != len(res.Roles) || snap.Signed.Expires.Before(o.Now.Add(o.SnapshotWithin))
	if snap != nil {
		for role, v := range res.Roles {
			m := snap.Signed.Meta[role+".json"]
			if m != nil && m.Version > v {
				return nil, fmt.Errorf("devtuf: the snapshot lists %s version %d, newer than any that verifies (%d)", role, m.Version, v)
			}
			if m == nil || m.Version != v {
				changed = true
			}
		}
	}
	if changed {
		snapVersion++
		ns := metadata.Snapshot(o.Now.Add(o.SnapshotExpiry))
		ns.Signed.Version = snapVersion
		ns.Signed.Meta = map[string]*metadata.MetaFiles{}
		for role, v := range res.Roles {
			ns.Signed.Meta[role+".json"] = metadata.MetaFile(v)
		}
		if _, err := ns.Sign(signer(snapshotKey)); err != nil {
			return nil, err
		}
		if err := writeJSON(filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", snapVersion)), ns); err != nil {
			return nil, err
		}
		res.SnapshotNew = true
	}
	res.Snapshot = snapVersion
	snapBytes, err := os.ReadFile(filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", snapVersion)))
	if err != nil {
		return nil, err
	}
	tsVersion := int64(0)
	if ts != nil {
		tsVersion = ts.Signed.Version
	}
	nt := metadata.Timestamp(o.Now.Add(o.TimestampExpiry))
	nt.Signed.Version = tsVersion + 1
	mf := metadata.MetaFile(snapVersion)
	sum := sha256.Sum256(snapBytes)
	mf.Length, mf.Hashes = int64(len(snapBytes)), metadata.Hashes{"sha256": sum[:]}
	nt.Signed.Meta = map[string]*metadata.MetaFiles{"snapshot.json": mf}
	if _, err := nt.Sign(signer(timestampKey)); err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(metaDir, "timestamp.json"), nt); err != nil {
		return nil, err
	}
	res.Timestamp, res.Expires = nt.Signed.Version, nt.Signed.Expires
	// root.json is the newest root, for people reading the site (boxes walk N.root.json).
	if b, err := os.ReadFile(filepath.Join(metaDir, fmt.Sprintf("%d.root.json", root.Signed.Version))); err == nil {
		_ = os.WriteFile(filepath.Join(metaDir, "root.json"), b, 0o644)
	}
	res.PrunedSnaps = pruneSnapshots(metaDir, snapVersion, o.KeepSnapshots)
	return res, nil
}

func pruneSnapshots(metaDir string, current int64, keep int) int {
	entries, err := os.ReadDir(metaDir)
	if err != nil {
		return 0
	}
	var vs []int64
	for _, e := range entries {
		if m := versionedName.FindStringSubmatch(e.Name()); m != nil && m[2] == metadata.SNAPSHOT {
			if v, err := strconv.ParseInt(m[1], 10, 64); err == nil && v != current {
				vs = append(vs, v)
			}
		}
	}
	sort.Slice(vs, func(i, j int) bool { return vs[i] > vs[j] })
	n := 0
	for i, v := range vs {
		if i >= keep-1 && os.Remove(filepath.Join(metaDir, fmt.Sprintf("%d.snapshot.json", v))) == nil {
			n++
		}
	}
	return n
}

// Expiry is a role's expiry for the workflow's warnings.
type Expiry struct {
	Role     string    `json:"role"`
	Version  int64     `json:"version"`
	Expires  time.Time `json:"expires"`
	DaysLeft int       `json:"daysLeft"`
}

// Expiries lists the expiry of the newest root, top-level targets and every delegated role (snapshot and timestamp are
// the workflow's own, re-signed every 6 hours), soonest first.
func Expiries(metaDir string, now time.Time) ([]Expiry, error) {
	root, err := verifiedChain(metaDir)
	if err != nil {
		return nil, err
	}
	days := func(t time.Time) int { return int(t.Sub(now).Hours() / 24) }
	out := []Expiry{{Role: metadata.ROOT, Version: root.Signed.Version, Expires: root.Signed.Expires, DaysLeft: days(root.Signed.Expires)}}
	top, _ := newestVerifiedTargets(metaDir, metadata.TARGETS, func(md *metadata.Metadata[metadata.TargetsType]) error {
		return root.VerifyDelegate(metadata.TARGETS, md)
	})
	if top == nil {
		return nil, errors.New("devtuf: no top-level targets verify")
	}
	out = append(out, Expiry{Role: metadata.TARGETS, Version: top.Signed.Version, Expires: top.Signed.Expires, DaysLeft: days(top.Signed.Expires)})
	if top.Signed.Delegations != nil {
		for _, dr := range top.Signed.Delegations.Roles {
			md, _ := newestVerifiedTargets(metaDir, dr.Name, func(md *metadata.Metadata[metadata.TargetsType]) error {
				return top.VerifyDelegate(dr.Name, md)
			})
			if md != nil {
				out = append(out, Expiry{Role: dr.Name, Version: md.Signed.Version, Expires: md.Signed.Expires, DaysLeft: days(md.Signed.Expires)})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Expires.Before(out[j].Expires) })
	return out, nil
}

// ContinueOptions are Continue's.
type ContinueOptions struct {
	// SourceKeysDir holds the DEV repository's keys (whombat-ops), when not in the source's keys/.
	SourceKeysDir string
	// KeysDir is where the continued repository keeps its online keys (root and top-level targets, interim for DEV;
	// development; clients): absolute, outside out. OfflineKeysDir receives the keys that must leave the build server: the
	// snapshot and timestamp keys (Actions secrets) and the production key (offline).
	KeysDir, OfflineKeysDir string
	// VersionGap is added to the source's targets, snapshot and timestamp versions (default 10000), so the new
	// repository's versions stay above anything the old address signs while both serve (its refresher re-signs the
	// timestamp every 6 hours).
	VersionGap int64
	// Carry lists releases of the source's top-level targets in the development role: the tuple unchanged (same bytes,
	// the digest the boxes recorded) and the closure indexes it resolves to, a version-1 index as version 2 with its
	// blobs linked beside it (carryIndex): the release every DEV box runs before the bridge, so a bridge that fails its
	// checks can roll back to it, and the bridge itself, so the bridge's own checks after its reboot find it as
	// development's newest. tufrepo gh-init uploads their files (tuples, indexes, blobs) before the first metadata push, so
	// a box that doesn't have one (a rollback after its store was cleaned, a new box) finds every file development names.
	Carry []string
	Now   func() time.Time
}

// ContinueResult says what Continue made, and what the bridge release must carry (LNK-26, LNK-50).
type ContinueResult struct {
	Out             string            `json:"out"`
	From            map[string]int64  `json:"from"`
	Versions        map[string]int64  `json:"versions"`
	Keys            map[string]string `json:"keys"` // role -> key id
	CarriedTargets  []string          `json:"carriedTargets"`
	DroppedReleases int               `json:"droppedReleases"`
	// CarriedReleases are the releases Carry listed in development.
	CarriedReleases []string `json:"carriedReleases,omitempty"`
	Bridge          []string `json:"bridge"`
}

// Continue makes the GitHub repository from a copy of the DEV repository (LNK-26): the same root chain plus a new root
// version signed by the current root (its threshold) and by the new root keys, in which every role has new keys (root
// and top-level targets rotated, so DEV's old root and targets keys sign nothing a box accepts after it; snapshot and
// timestamp for the workflow), the top-level targets signed by the new targets key, the targets, snapshot
// and timestamp versions carried on (plus VersionGap), the top-level targets delegating clients (the same key, its
// current role file carried as it is), development and production (new keys), and empty channel roles. Releases of
// the top-level targets are not carried: boxes on the GitHub repository resolve releases only through their channel.
// It writes into out (new, empty) and never into the source.
func Continue(src, out string, o ContinueOptions) (*ContinueResult, error) {
	if o.VersionGap == 0 {
		o.VersionGap = 10000
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if !filepath.IsAbs(o.KeysDir) || !filepath.IsAbs(o.OfflineKeysDir) {
		return nil, errors.New("devtuf: continue needs absolute --keys-dir and --offline-keys-dir")
	}
	absOut, _ := filepath.Abs(out)
	for _, k := range []string{o.KeysDir, o.OfflineKeysDir} {
		if rel, err := filepath.Rel(absOut, k); err == nil && !strings.HasPrefix(rel, "..") {
			return nil, fmt.Errorf("devtuf: %s is inside the repository directory; keys stay outside it", k)
		}
	}
	for _, d := range []string{out, o.KeysDir, o.OfflineKeysDir} {
		if entries, err := os.ReadDir(d); err == nil && len(entries) > 0 {
			return nil, fmt.Errorf("devtuf: %s is not empty", d)
		}
	}
	// Load takes the keys from the source's own keys directory unless one is given (whombat-ops keeps DEV's).
	old, err := Load(src, Options{KeysDir: o.SourceKeysDir})
	if err != nil {
		return nil, fmt.Errorf("devtuf: the source repository: %w", err)
	}
	if len(old.keys[metadata.ROOT]) == 0 || len(old.keys[metadata.TARGETS]) == 0 {
		return nil, errors.New("devtuf: continuing needs the source's root and targets keys")
	}
	res := &ContinueResult{Out: out, From: old.RoleVersions(), Keys: map[string]string{}}
	for _, d := range []string{filepath.Join(out, "metadata"), filepath.Join(out, "targets"), o.KeysDir, o.OfflineKeysDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	_ = os.Chmod(filepath.Join(out, "metadata"), 0o755)
	_ = os.Chmod(filepath.Join(out, "targets"), 0o755)
	opts := Options{Env: old.Env, Now: o.Now, KeysDir: o.KeysDir, Layout: LayoutGitHub}
	opts.defaults()
	r := &Repo{Dir: out, Env: old.Env, opts: opts, keys: map[string][]ed25519.PrivateKey{},
		channels: map[string]*metadata.Metadata[metadata.TargetsType]{}}
	now := o.Now().UTC()
	// The root chain, as it is.
	for v := int64(1); v <= old.root.Signed.Version; v++ {
		name := fmt.Sprintf("%d.root.json", v)
		if err := linkOrCopy(filepath.Join(old.metaDir(), name), filepath.Join(r.metaDir(), name)); err != nil {
			return nil, fmt.Errorf("devtuf: the root chain: %w", err)
		}
	}
	// The next root: every top-level role gets new keys, as many as its threshold (root and targets: the interim online
	// keys for DEV, kept in KeysDir; snapshot and timestamp: the workflow's). The old root keys sign this version once,
	// to its own threshold, and appear in no role of it.
	rootBytes, err := os.ReadFile(filepath.Join(old.metaDir(), "root.json"))
	if err != nil {
		return nil, err
	}
	if r.root, err = metadata.Root().FromBytes(rootBytes); err != nil {
		return nil, err
	}
	if th := r.root.Signed.Roles[metadata.ROOT].Threshold; len(old.keys[metadata.ROOT]) < th {
		return nil, fmt.Errorf("devtuf: the source's root needs %d keys to sign the next root, %d given", th, len(old.keys[metadata.ROOT]))
	}
	oldIDs := map[string]bool{}
	for _, role := range []string{metadata.ROOT, metadata.TARGETS} {
		for _, k := range old.keys[role] {
			key, _ := metadata.KeyFromPublicKey(k.Public())
			id, _ := key.ID()
			oldIDs[id] = true
		}
		for _, id := range r.root.Signed.Roles[role].KeyIDs {
			oldIDs[id] = true
		}
	}
	for _, role := range topRoles {
		for _, id := range append([]string{}, r.root.Signed.Roles[role].KeyIDs...) {
			if err := r.root.Signed.RevokeKey(id, role); err != nil {
				return nil, err
			}
		}
		n := max(r.root.Signed.Roles[role].Threshold, 1)
		r.keys[role] = nil
		for i := 0; i < n; i++ {
			k := newKey()
			r.keys[role] = append(r.keys[role], k)
			if err := r.addRootKey(k, role); err != nil {
				return nil, err
			}
		}
	}
	for id := range r.root.Signed.Keys {
		if oldIDs[id] {
			return nil, fmt.Errorf("devtuf: the old root or targets key %s is still in the new root", id)
		}
	}
	r.root.Signed.Version++
	r.root.Signed.Expires = now.Add(GitHubRootExpiry)
	r.root.Signed.ConsistentSnapshot = true
	if err := r.signWriteRoot(old.keys[metadata.ROOT]); err != nil {
		return nil, err
	}
	// Top-level targets: the assignment keys document (older managers read it) and the clients delegation carried.
	r.targets = metadata.Targets(now.Add(GitHubTargetsExpiry))
	r.targets.Signed.Version = old.targets.Signed.Version + o.VersionGap - 1 // Publish adds one
	for p, tf := range old.targets.Signed.Targets {
		if p != trust.AssignmentKeysTarget {
			if strings.HasPrefix(p, trust.ReleaseTargetPrefix) {
				res.DroppedReleases++
			}
			continue
		}
		cp := *tf
		r.targets.Signed.Targets[p] = &cp
		if err := r.copyTargetFile(old, p, tf); err != nil {
			return nil, err
		}
		res.CarriedTargets = append(res.CarriedTargets, p)
	}
	if old.clients != nil {
		dr, ok := old.delegatedRole(trust.ClientsRole)
		if !ok {
			return nil, errors.New("devtuf: the source has a clients role file but no delegation")
		}
		for _, id := range dr.KeyIDs {
			r.delegate(old.targets.Signed.Delegations.Keys[id], id, dr)
		}
		r.clients = old.clients
		name := fmt.Sprintf("%d.%s.json", old.clients.Signed.Version, trust.ClientsRole)
		if err := linkOrCopy(filepath.Join(old.metaDir(), name), filepath.Join(r.metaDir(), name)); err != nil {
			return nil, err
		}
		if k := old.ClientsKey(); k != nil {
			r.keys[trust.ClientsRole] = []ed25519.PrivateKey{k}
		}
		for p, tf := range old.clients.Signed.Targets {
			if err := r.copyTargetFile(old, p, tf); err != nil {
				return nil, err
			}
			res.CarriedTargets = append(res.CarriedTargets, p)
		}
	}
	sort.Strings(res.CarriedTargets)
	// Snapshot and timestamp versions carried on; Publish (inside AddChannelRoles) signs targets, snapshot, timestamp.
	r.snapshot = metadata.Snapshot(now.Add(GitHubSnapshotExpiry))
	r.snapshot.Signed.Version = old.snapshot.Signed.Version + o.VersionGap - 1
	r.timestamp = metadata.Timestamp(now.Add(GitHubTimestampExpiry))
	r.timestamp.Signed.Version = old.timestamp.Signed.Version + o.VersionGap - 1
	prod := newKey()
	if err := r.AddChannelRoles(map[string]ed25519.PrivateKey{trust.ChannelProduction: prod},
		map[string]bool{trust.ChannelDevelopment: true, trust.ChannelProduction: false}); err != nil {
		return nil, err
	}
	if len(o.Carry) > 0 {
		if err := r.carry(old, trust.ChannelDevelopment, o.Carry); err != nil {
			return nil, err
		}
		res.CarriedReleases = append([]string{}, o.Carry...)
	}
	// Keys that leave the build server: snapshot and timestamp (Actions secrets), production (offline).
	for role, k := range map[string]ed25519.PrivateKey{metadata.SNAPSHOT: r.keys[metadata.SNAPSHOT][0],
		metadata.TIMESTAMP: r.keys[metadata.TIMESTAMP][0], trust.ChannelProduction: prod} {
		if err := WriteKeyFile(filepath.Join(o.OfflineKeysDir, role+".json"), role, k); err != nil {
			return nil, err
		}
	}
	delete(r.keys, metadata.SNAPSHOT)
	delete(r.keys, metadata.TIMESTAMP)
	if err := r.saveKeys(); err != nil {
		return nil, err
	}
	res.Versions = r.RoleVersions()
	for role, ks := range map[string][]ed25519.PrivateKey{metadata.ROOT: r.keys[metadata.ROOT], metadata.TARGETS: r.keys[metadata.TARGETS],
		trust.ChannelDevelopment: r.keys[trust.ChannelDevelopment], trust.ChannelProduction: {prod}} {
		if len(ks) > 0 {
			key, _ := metadata.KeyFromPublicKey(ks[0].Public())
			res.Keys[role], _ = key.ID()
		}
	}
	res.Bridge = bridgeList(res)
	b, _ := json.MarshalIndent(res, "", " ")
	if err := os.WriteFile(filepath.Join(out, "continue.json"), b, 0o644); err != nil {
		return nil, err
	}
	return res, nil
}

// carry lists releases of old's top-level targets in a channel role (ContinueOptions.Carry): each tuple target and the
// closure index each of its components resolves to, copied unchanged under the channel's prefix, then the role signed.
func (r *Repo) carry(old *Repo, channel string, ids []string) error {
	md, ok := r.channels[channel]
	if !ok {
		return fmt.Errorf("devtuf: no %s role", channel)
	}
	dest := old.dest
	defer func() { old.dest = dest }()
	old.dest = ""
	for _, id := range ids {
		tupleTarget := trust.ReleaseTarget(id)
		tf, ok := old.targets.Signed.Targets[tupleTarget]
		if !ok {
			return fmt.Errorf("devtuf: carry: the source lists no release %s", id)
		}
		t, err := tupleOf(tf)
		if err != nil {
			return fmt.Errorf("devtuf: carry %s: %w", id, err)
		}
		paths := []string{tupleTarget}
		for _, c := range tupleComponents(t) {
			ip, ok := old.findIndex(c)
			if !ok {
				return fmt.Errorf("devtuf: carry %s: the source lists no index for %s %s", id, c.kind, c.version)
			}
			paths = append(paths, ip)
		}
		for i, p := range paths {
			src := old.targets.Signed.Targets[p]
			if i > 0 {
				converted, err := r.carryIndex(old, channel, p, src)
				if err != nil {
					return fmt.Errorf("devtuf: carry %s: %w", id, err)
				}
				if converted {
					continue
				}
			}
			np := trust.ChannelTarget(channel, p)
			cp := *src
			cp.Path = np
			md.Signed.Targets[np] = &cp
			if err := r.copyTargetFileAs(old, p, np, src); err != nil {
				return err
			}
		}
	}
	return r.publishChannel(channel)
}

// carryIndex lists a version-1 closure index of old in a channel of r as version 2 (the same paths, NAR hashes and
// blobs; only where the blobs are differs) and links its blobs into r's blob folder. The next release that reuses the
// component (a runtime-only release on the bridge's host) resolves to this index, and the GitHub publisher uploads it
// and its blobs with that release; a version-1 index there would stop every such publish. The carried tuple target is
// copied unchanged, so its digest stays the one the boxes recorded; a rollback needs only its store paths. False: no
// file in old, or already version 2 (copied as it is).
func (r *Repo) carryIndex(old *Repo, channel, p string, src *metadata.TargetFiles) (bool, error) {
	b, err := os.ReadFile(filepath.Join(old.targetsDir(), filepath.FromSlash(consistentName(p, hex.EncodeToString(src.Hashes["sha256"])))))
	if err != nil {
		return false, nil
	}
	ci, err := trust.DecodeClosureIndex(b)
	if err != nil {
		return false, fmt.Errorf("%s: %w", p, err)
	}
	if ci.V != trust.IndexV1 {
		return false, nil
	}
	meta, ok := indexMetaOf(src)
	if !ok {
		return false, fmt.Errorf("%s has no index metadata", p)
	}
	dest := r.dest
	defer func() { r.dest = dest }()
	r.dest = channel
	if _, err := r.putIndex(p, ci, meta); err != nil {
		return false, err
	}
	if err := os.MkdirAll(r.blobsDir(), 0o755); err != nil {
		return false, err
	}
	for i := range ci.Paths {
		blob := ci.Blob(i)
		name := trust.BlobFileName(blob.SHA256(), blob.Meta.NarHash)
		from, to := filepath.Join(old.blobsDir(), name), filepath.Join(r.blobsDir(), name)
		if _, err := os.Stat(to); err == nil {
			continue
		}
		if _, err := os.Stat(from); err != nil {
			continue // a placeholder path (no blob anywhere): the box has it already
		}
		if err := linkOrCopy(from, to); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (r *Repo) copyTargetFile(old *Repo, p string, tf *metadata.TargetFiles) error {
	return r.copyTargetFileAs(old, p, p, tf)
}

// copyTargetFileAs carries old's file of target p as target np of r (same bytes).
func (r *Repo) copyTargetFileAs(old *Repo, p, np string, tf *metadata.TargetFiles) error {
	sha := hex.EncodeToString(tf.Hashes["sha256"])
	src := filepath.Join(old.targetsDir(), filepath.FromSlash(consistentName(p, sha)))
	dst := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(np, sha)))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(src); err != nil {
		return nil // listed but not served by the source: nothing to carry
	}
	if _, err := os.Stat(dst); err == nil {
		return nil // the same file (its hash is in the name), carried for another release
	}
	return linkOrCopy(src, dst)
}

// bridgeList is what the bridge release and the move must carry (LNK-26, LNK-50).
func bridgeList(res *ContinueResult) []string {
	return []string{
		fmt.Sprintf("root %d → %d, signed by root %d's keys and the new ones; every role has new keys (root and targets rotated): boxes walk the chain from the root they pin, and DEV's old root and targets keys sign nothing they accept after it", res.From[metadata.ROOT], res.Versions[metadata.ROOT], res.From[metadata.ROOT]),
		"the new root and top-level targets keys are the interim online keys in --keys-dir: keep that folder where it is for good (state.json names its absolute path; every publish loads it there), back it up, never into a repository; they go offline with the production key ceremony",
		fmt.Sprintf("targets %d → %d, snapshot %d → %d, timestamp %d → %d: the old address must not sign past these while both serve",
			res.From[metadata.TARGETS], res.Versions[metadata.TARGETS], res.From[metadata.SNAPSHOT], res.Versions[metadata.SNAPSHOT],
			res.From[metadata.TIMESTAMP], res.Versions[metadata.TIMESTAMP]),
		"the bridge release (published through the old address and DEV control's assignment) is the DEV image (nix/profiles/dev-instance.nix): the helper with channel development, the manager on https://releases.whombat.com/ and the GitHub targets base, its layout in the units' environment",
		carriedLine(res),
		"before DEV control assigns the bridge, the workflow must have signed a snapshot with both releases in development: after its reboot the bridge's helper checks the bridge against development's newest, and a bridge that fails its health checks rolls back only to a release some channel still lists",
		"keep both listed in development until every DEV box is past the bridge and blessed; a box that missed the bridge keeps the old address",
		"the clients role: its current file is carried; gh-init uploads its targets to the `clients` release with the carried releases' files, before the metadata; then the client job mirrors the channel here too (WB_CLIENTS_GITHUB, docs/runbooks/client-latest-tested.md)",
		"the snapshot and timestamp keys (offline keys directory) go to the whombat-releases Actions secrets TUF_SNAPSHOT_KEY and TUF_TIMESTAMP_KEY; the production key stays offline",
	}
}

// carriedLine says which releases development lists for the bridge (ContinueOptions.Carry).
func carriedLine(res *ContinueResult) string {
	if len(res.CarriedReleases) == 0 {
		return "NOT DONE: development lists no release yet; run gh-continue again with --carry <the release every DEV box runs now>,<the bridge> (both published through the old address first)"
	}
	return "development lists " + strings.Join(res.CarriedReleases, " and ") + " (--carry; tuples unchanged, indexes as version 2): the release the boxes run before the bridge and the bridge"
}

// ReleaseFile is a file a channel release needs on GitHub (LNK-24): its GitHub release (Tag) and asset name, and the
// local file the publisher uploads.
type ReleaseFile struct {
	Tag    string `json:"tag"`
	Name   string `json:"name"`
	Local  string `json:"local"`
	Length int64  `json:"length"`
	SHA256 string `json:"sha256"`
	// Kind is "tuple", "index" or "blob".
	Kind string `json:"kind"`
}

// ReleaseFiles lists what a channel release needs on GitHub: its tuple and every index its components resolve to in
// the release's own GitHub release, every blob of those (version-2) indexes in its bucket release.
func (r *Repo) ReleaseFiles(channel, id string) ([]ReleaseFile, error) {
	targets, err := r.releaseTargets(channel, id)
	if err != nil {
		return nil, err
	}
	md := r.channels[channel]
	var out []ReleaseFile
	seen := map[string]bool{}
	for i, target := range targets {
		tf := md.Signed.Targets[target]
		sha := hex.EncodeToString(tf.Hashes["sha256"])
		local := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(target, sha)))
		kind := "index"
		if i == 0 {
			kind = "tuple"
		}
		out = append(out, ReleaseFile{Tag: id, Name: trust.RemoteName(target, sha), Local: local, Length: tf.Length, SHA256: sha, Kind: kind})
		if kind == "tuple" {
			continue
		}
		b, err := os.ReadFile(local)
		if err != nil {
			return nil, fmt.Errorf("devtuf: the index file of %s: %w", target, err)
		}
		ci, err := trust.DecodeClosureIndex(b)
		if err != nil {
			return nil, fmt.Errorf("devtuf: %s: %w", target, err)
		}
		if ci.V != trust.IndexV2 {
			return nil, fmt.Errorf("devtuf: %s is a version-%d index; GitHub needs version 2 (its blobs in nar-xx releases)", target, ci.V)
		}
		for i := range ci.Paths {
			blob := ci.Blob(i)
			fileHex := blob.SHA256()
			if seen[fileHex] {
				continue
			}
			seen[fileHex] = true
			out = append(out, ReleaseFile{Tag: trust.BlobBucket(fileHex), Name: trust.BlobFileName(fileHex, blob.Meta.NarHash),
				Local: filepath.Join(r.blobsDir(), trust.BlobFileName(fileHex, blob.Meta.NarHash)), Length: blob.Length, SHA256: fileHex, Kind: "blob"})
		}
	}
	return out, nil
}

// releaseTargets lists a channel release's TUF targets: its tuple first, then the index each component resolves to.
func (r *Repo) releaseTargets(channel, id string) ([]string, error) {
	md, ok := r.channels[channel]
	if !ok {
		return nil, fmt.Errorf("devtuf: no %s role", channel)
	}
	dest := r.dest
	defer func() { r.dest = dest }()
	r.dest = channel
	tupleTarget := trust.ChannelTarget(channel, trust.ReleaseTarget(id))
	tf, ok := md.Signed.Targets[tupleTarget]
	if !ok {
		return nil, fmt.Errorf("devtuf: %s lists no release %s", channel, id)
	}
	t, err := tupleOf(tf)
	if err != nil {
		return nil, err
	}
	out := []string{tupleTarget}
	for _, c := range tupleComponents(t) {
		ip, ok := r.findIndex(c)
		if !ok {
			return nil, fmt.Errorf("devtuf: %s lists no index for %s %s", channel, c.kind, c.version)
		}
		out = append(out, trust.ChannelTarget(channel, ip))
	}
	return out, nil
}

// linkReleaseFiles serves every release of a channel the way GitHub does (LNK-24): its tuple and indexes also at
// targets/<release-id>/<sha256>.<base> (hard links), where a box looks for them (trust's Artifact.Remote), so one
// static server can stand in for GitHub (the dev stack, tests).
func (r *Repo) linkReleaseFiles(channel string) error {
	md := r.channels[channel]
	for p := range md.Signed.Targets {
		rest, ok := strings.CutPrefix(p, trust.ChannelTarget(channel, trust.ReleaseTargetPrefix))
		if !ok {
			continue
		}
		id, ok := strings.CutSuffix(rest, ".json")
		if !ok {
			continue
		}
		targets, err := r.releaseTargets(channel, id)
		if err != nil {
			return err
		}
		for _, target := range targets {
			sha := hex.EncodeToString(md.Signed.Targets[target].Hashes["sha256"])
			src := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(target, sha)))
			dst := filepath.Join(r.targetsDir(), id, trust.RemoteName(target, sha))
			if _, err := os.Stat(dst); err == nil {
				continue
			}
			if _, err := os.Stat(src); err != nil {
				continue // not here (a promotion of files another directory holds)
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if err := linkOrCopy(src, dst); err != nil {
				return err
			}
		}
	}
	return nil
}

// ClientFiles lists the clients role's targets as assets of the `clients` release (clients/<sha>.<base>; the
// manager's tufclient.GitHubPath reads them there).
func (r *Repo) ClientFiles() []ReleaseFile {
	if r.clients == nil {
		return nil
	}
	var out []ReleaseFile
	for p, tf := range r.clients.Signed.Targets {
		sha := hex.EncodeToString(tf.Hashes["sha256"])
		out = append(out, ReleaseFile{Tag: "clients", Name: trust.RemoteName(p, sha), Length: tf.Length, SHA256: sha, Kind: "client",
			Local: filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(p, sha)))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
