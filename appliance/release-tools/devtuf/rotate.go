package devtuf

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// The key ceremony of the GitHub repository (Whombat ONE-05, LNK-25): the root and the top-level targets get keys that
// live offline. One new root version, signed by the current root keys (so every box that trusts the current root
// walks to it) and by the new ones, names three new root keys of which two must sign the next root, one new top-level
// targets key, and snapshot and timestamp unchanged (the workflow's, in the Actions secrets). The top-level targets are
// signed again, unchanged, with the new targets key; the delegations (clients, development, production) keep their
// keys, so no role below them changes. The new private keys, and a copy of the production key, go into a new folder
// for the person who keeps them offline; the repository's own keys folder keeps development, clients and production
// (the publisher promotes with it, ONE-05) and nothing of root or targets any more.

// The ceremony's root (ONE-05: John's “beide”).
const (
	CeremonyRootKeys      = 3
	CeremonyRootThreshold = 2
)

// RotateOptions are RotateTopLevel's.
type RotateOptions struct {
	// OfflineDir receives the new root and targets keys and the production key's copy: absolute, outside the
	// repository and its keys folder, missing or empty; made 0700, every file 0600.
	OfflineDir string
	// RootKeys and RootThreshold are the new root role's (default CeremonyRootKeys and CeremonyRootThreshold).
	RootKeys, RootThreshold int
	// ProductionKey is the production role's key when the repository doesn't hold it (gh-continue put it offline): it
	// must be the key production is delegated to. It stays online with the repository's keys from now on.
	ProductionKey ed25519.PrivateKey
}

// RotateResult says what the ceremony signed and where the keys went.
type RotateResult struct {
	RootFrom      int64    `json:"rootFrom"`
	RootTo        int64    `json:"rootTo"`
	RootThreshold int      `json:"rootThreshold"`
	RootKeys      []string `json:"rootKeys"`
	TargetsFrom   int64    `json:"targetsFrom"`
	TargetsTo     int64    `json:"targetsTo"`
	TargetsKey    string   `json:"targetsKey"`
	ProductionKey string   `json:"productionKey"`
	// RootExpires and TargetsExpires are the new versions' expiries (a new ceremony before then, LNK-25).
	RootExpires    time.Time `json:"rootExpires"`
	TargetsExpires time.Time `json:"targetsExpires"`
	OfflineDir     string    `json:"offlineDir"`
	// OfflineFiles are the key files written there; OnlineRoles the roles whose keys stay with the repository.
	OfflineFiles []string `json:"offlineFiles"`
	OnlineRoles  []string `json:"onlineRoles"`
	// Metadata are the files signed, relative to the metadata folder.
	Metadata []string `json:"metadata"`
}

// ErrCeremony refuses a ceremony that can't be done as asked.
var ErrCeremony = errors.New("devtuf: the key ceremony")

func keyID(k ed25519.PrivateKey) string {
	key, _ := metadata.KeyFromPublicKey(k.Public())
	id, _ := key.ID()
	return id
}

// holds counts the given keys that are among ids.
func holds(keys []ed25519.PrivateKey, ids []string) int {
	n := 0
	for _, k := range keys {
		if containsString(ids, keyID(k)) {
			n++
		}
	}
	return n
}

// rotationFile is the ceremony's record in the repository folder (beside the metadata, never committed): written once
// the new keys are offline and before anything is signed with them, removed by FinishRotation once GitHub has the new
// root and the old online keys are retired. While it is there a ceremony carries on rather than starting again.
const rotationFile = ".rotation-pending.json"

type rotationRecord struct {
	OfflineDir    string   `json:"offlineDir"`
	RootFrom      int64    `json:"rootFrom"`
	RootTo        int64    `json:"rootTo"`
	TargetsFrom   int64    `json:"targetsFrom"`
	RootThreshold int      `json:"rootThreshold"`
	RootKeys      []string `json:"rootKeys"`
	TargetsKey    string   `json:"targetsKey"`
	ProductionKey string   `json:"productionKey"`
}

// rotateHook, when set (tests), runs after each signing step ("root", "targets"): an error stops the ceremony there,
// as an interruption would.
var rotateHook func(stage string) error

func (r *Repo) readRotation() (*rotationRecord, error) {
	b, err := os.ReadFile(filepath.Join(r.Dir, rotationFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec rotationRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrCeremony, rotationFile, err)
	}
	return &rec, nil
}

// RotationPending reports whether a ceremony signed (or began to) and its old online keys wait for FinishRotation.
func (r *Repo) RotationPending() bool {
	rec, err := r.readRotation()
	return err == nil && rec != nil
}

// RotateTopLevel is the ceremony (see above). It writes the keys into o.OfflineDir and its record beside the metadata
// before it signs anything, then signs the new root and top-level targets into the metadata folder (pushing them is
// the caller's: tufrepo gh-rotate). The old root and targets keys stay in the repository's keys folder until
// FinishRotation, which the caller runs once the push succeeded (R1 #4): a ceremony that stopped (while signing, or at
// its push) is run again and carries on from its record with the same keys, root and targets together; it never
// starts over.
func (r *Repo) RotateTopLevel(o RotateOptions) (*RotateResult, error) {
	if !r.GitHub() {
		return nil, fmt.Errorf("%w is for the GitHub repository (layout github)", ErrCeremony)
	}
	if r.dest != "" {
		return nil, fmt.Errorf("%w: the repository is set to sign into %s", ErrCeremony, r.dest)
	}
	rec, err := r.readRotation()
	if err != nil {
		return nil, err
	}
	if rec != nil {
		return r.resumeRotation(rec, o)
	}
	if o.RootKeys == 0 {
		o.RootKeys = CeremonyRootKeys
	}
	if o.RootThreshold == 0 {
		o.RootThreshold = CeremonyRootThreshold
	}
	if o.RootThreshold < 2 || o.RootKeys < o.RootThreshold {
		return nil, fmt.Errorf("%w: a root of %d keys with threshold %d (the ceremony's root needs two keys to sign)",
			ErrCeremony, o.RootKeys, o.RootThreshold)
	}
	cur := r.root.Signed.Roles[metadata.ROOT]
	if holds(r.keys[metadata.ROOT], cur.KeyIDs) < cur.Threshold {
		return nil, fmt.Errorf("%w needs %d of root %d's keys in the repository's keys folder; it holds %d",
			ErrCeremony, cur.Threshold, r.root.Signed.Version, holds(r.keys[metadata.ROOT], cur.KeyIDs))
	}
	prodRole, ok := r.delegatedRole(trust.ChannelProduction)
	if !ok {
		return nil, fmt.Errorf("%w: the repository has no production role", ErrCeremony)
	}
	prod := o.ProductionKey
	if prod == nil {
		prod = r.ChannelKey(trust.ChannelProduction)
	}
	if prod == nil {
		return nil, fmt.Errorf("%w needs the production key (--production-key-file): it stays online from now on and goes offline as a copy", ErrCeremony)
	}
	if !containsString(prodRole.KeyIDs, keyID(prod)) {
		return nil, fmt.Errorf("%w: the production key given is not the one production is delegated to", ErrCeremony)
	}
	if err := r.checkOfflineDir(o.OfflineDir); err != nil {
		return nil, err
	}
	res := &RotateResult{RootFrom: r.root.Signed.Version, TargetsFrom: r.targets.Signed.Version,
		OfflineDir: filepath.Clean(o.OfflineDir), RootThreshold: o.RootThreshold, ProductionKey: keyID(prod)}

	// The new keys, written offline before anything is signed with them: no signed metadata ever names a key nobody
	// has.
	var rootKeys []ed25519.PrivateKey
	for i := 0; i < o.RootKeys; i++ {
		rootKeys = append(rootKeys, newKey())
	}
	targetsKey := newKey()
	if err := os.MkdirAll(o.OfflineDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(o.OfflineDir, 0o700); err != nil {
		return nil, err
	}
	write := func(name, role string, k ed25519.PrivateKey) error {
		if err := WriteKeyFile(filepath.Join(o.OfflineDir, name), role, k); err != nil {
			return err
		}
		res.OfflineFiles = append(res.OfflineFiles, name)
		return nil
	}
	for i, k := range rootKeys {
		if err := write(fmt.Sprintf("root-%d.json", i), metadata.ROOT, k); err != nil {
			return nil, err
		}
		res.RootKeys = append(res.RootKeys, keyID(k))
	}
	if err := write("targets-0.json", metadata.TARGETS, targetsKey); err != nil {
		return nil, err
	}
	if err := write("production-0.json", trust.ChannelProduction, prod); err != nil {
		return nil, err
	}
	res.TargetsKey = keyID(targetsKey)
	rec = &rotationRecord{OfflineDir: res.OfflineDir, RootFrom: res.RootFrom, RootTo: res.RootFrom + 1,
		TargetsFrom: res.TargetsFrom, RootThreshold: o.RootThreshold, RootKeys: res.RootKeys, TargetsKey: res.TargetsKey,
		ProductionKey: res.ProductionKey}
	if err := writeJSON(filepath.Join(r.Dir, rotationFile), rec); err != nil {
		return nil, err
	}
	return r.signCeremony(rec, rootKeys, targetsKey, prod, res)
}

// resumeRotation carries on with the ceremony its record names: the same offline keys, the root signed unless it is
// already the ceremony's, the targets signed unless the new root already verifies them.
func (r *Repo) resumeRotation(rec *rotationRecord, o RotateOptions) (*RotateResult, error) {
	if o.OfflineDir != "" && filepath.Clean(o.OfflineDir) != rec.OfflineDir {
		return nil, fmt.Errorf("%w: a ceremony is under way with its keys in %s: run it again with that --offline-keys-dir",
			ErrCeremony, rec.OfflineDir)
	}
	read := func(name, role, want string) (ed25519.PrivateKey, error) {
		k, err := ReadKeyFile(filepath.Join(rec.OfflineDir, name), role)
		if err != nil {
			return nil, fmt.Errorf("%w: the ceremony under way needs its key %s in %s: %v", ErrCeremony, name, rec.OfflineDir, err)
		}
		if keyID(k) != want {
			return nil, fmt.Errorf("%w: %s in %s is not the key the ceremony under way made", ErrCeremony, name, rec.OfflineDir)
		}
		return k, nil
	}
	res := &RotateResult{RootFrom: rec.RootFrom, TargetsFrom: rec.TargetsFrom, OfflineDir: rec.OfflineDir,
		RootThreshold: rec.RootThreshold, RootKeys: rec.RootKeys, TargetsKey: rec.TargetsKey,
		ProductionKey: rec.ProductionKey}
	var rootKeys []ed25519.PrivateKey
	for i, id := range rec.RootKeys {
		name := fmt.Sprintf("root-%d.json", i)
		k, err := read(name, metadata.ROOT, id)
		if err != nil {
			return nil, err
		}
		rootKeys = append(rootKeys, k)
		res.OfflineFiles = append(res.OfflineFiles, name)
	}
	targetsKey, err := read("targets-0.json", metadata.TARGETS, rec.TargetsKey)
	if err != nil {
		return nil, err
	}
	prod, err := read("production-0.json", trust.ChannelProduction, rec.ProductionKey)
	if err != nil {
		return nil, err
	}
	res.OfflineFiles = append(res.OfflineFiles, "targets-0.json", "production-0.json")
	return r.signCeremony(rec, rootKeys, targetsKey, prod, res)
}

// signCeremony signs what of the ceremony isn't signed yet: the new root (from rec.RootFrom), then the top-level
// targets with the new key. The old root and targets keys stay online; the production key is online from now on.
func (r *Repo) signCeremony(rec *rotationRecord, rootKeys []ed25519.PrivateKey, targetsKey, prod ed25519.PrivateKey,
	res *RotateResult) (*RotateResult, error) {
	now := r.opts.Now().UTC()
	previousRoot := append([]ed25519.PrivateKey{}, r.keys[metadata.ROOT]...)
	previousTargets := append([]ed25519.PrivateKey{}, r.keys[metadata.TARGETS]...)
	switch r.root.Signed.Version {
	case rec.RootFrom:
		// The new root: root and targets get the new keys, snapshot and timestamp keep theirs.
		for _, role := range []string{metadata.ROOT, metadata.TARGETS} {
			for _, id := range append([]string{}, r.root.Signed.Roles[role].KeyIDs...) {
				if err := r.root.Signed.RevokeKey(id, role); err != nil {
					return nil, err
				}
			}
		}
		for _, k := range rootKeys {
			if err := r.addRootKey(k, metadata.ROOT); err != nil {
				return nil, err
			}
		}
		if err := r.addRootKey(targetsKey, metadata.TARGETS); err != nil {
			return nil, err
		}
		r.root.Signed.Roles[metadata.ROOT].Threshold = rec.RootThreshold
		r.root.Signed.Roles[metadata.TARGETS].Threshold = 1
		for _, k := range previousRoot {
			if containsString(r.root.Signed.Roles[metadata.ROOT].KeyIDs, keyID(k)) {
				return nil, fmt.Errorf("%w: an old root key is still in the new root", ErrCeremony)
			}
		}
		r.root.Signed.Version = rec.RootTo
		r.root.Signed.Expires = now.Add(GitHubRootExpiry)
		r.root.Signed.ConsistentSnapshot = true
		r.keys[metadata.ROOT] = rootKeys
		if err := r.signWriteRoot(previousRoot); err != nil {
			return nil, err
		}
		r.keys[metadata.ROOT] = previousRoot
		if rotateHook != nil {
			if err := rotateHook("root"); err != nil {
				return nil, err
			}
		}
	case rec.RootTo:
		// Signed by the run that stopped: it must be this ceremony's root.
		rr, tr := r.root.Signed.Roles[metadata.ROOT], r.root.Signed.Roles[metadata.TARGETS]
		if !sameIDs(rr.KeyIDs, rec.RootKeys) || rr.Threshold != rec.RootThreshold || !sameIDs(tr.KeyIDs, []string{rec.TargetsKey}) {
			return nil, fmt.Errorf("%w: root %d is not the root of the ceremony under way (%s)", ErrCeremony, rec.RootTo, rotationFile)
		}
	default:
		return nil, fmt.Errorf("%w: the ceremony under way goes from root %d to %d, the repository is at root %d",
			ErrCeremony, rec.RootFrom, rec.RootTo, r.root.Signed.Version)
	}
	res.RootTo, res.RootExpires = r.root.Signed.Version, r.root.Signed.Expires
	res.Metadata = append(res.Metadata, fmt.Sprintf("%d.root.json", res.RootTo), "root.json")

	// The top-level targets, unchanged, signed by the new key with a full lifetime, unless they already are.
	if r.root.VerifyDelegate(metadata.TARGETS, r.targets) != nil {
		r.keys[metadata.TARGETS] = []ed25519.PrivateKey{targetsKey}
		r.targets.Signed.Expires = now.Add(GitHubTargetsExpiry)
		if err := r.Publish(); err != nil {
			return nil, err
		}
		if rotateHook != nil {
			if err := rotateHook("targets"); err != nil {
				return nil, err
			}
		}
	}
	res.TargetsTo, res.TargetsExpires = r.targets.Signed.Version, r.targets.Signed.Expires
	res.Metadata = append(res.Metadata, fmt.Sprintf("%d.targets.json", res.TargetsTo))

	// Online until FinishRotation: the old root and targets keys (a run that stops at its push signs nothing again,
	// and nothing it needs is gone). Online from now on: the production key.
	r.keys[metadata.ROOT] = previousRoot
	r.keys[metadata.TARGETS] = previousTargets
	r.keys[trust.ChannelProduction] = []ed25519.PrivateKey{prod}
	if err := r.saveKeys(); err != nil {
		return nil, err
	}
	for role := range r.keys {
		if role != metadata.ROOT && role != metadata.TARGETS {
			res.OnlineRoles = append(res.OnlineRoles, role)
		}
	}
	sort.Strings(res.OnlineRoles)
	return res, writeOfflineReadme(rec.OfflineDir, res)
}

// FinishRotation retires the old online root and targets keys once GitHub has the ceremony's root and targets (the
// caller pushed them: tufrepo gh-rotate), and drops the ceremony's record. False: no ceremony under way.
func (r *Repo) FinishRotation() (bool, error) {
	rec, err := r.readRotation()
	if err != nil || rec == nil {
		return false, err
	}
	if r.root.Signed.Version != rec.RootTo || r.root.VerifyDelegate(metadata.TARGETS, r.targets) != nil {
		return false, fmt.Errorf("%w: root %d and its targets aren't signed yet: run the ceremony again first", ErrCeremony, rec.RootTo)
	}
	delete(r.keys, metadata.ROOT)
	delete(r.keys, metadata.TARGETS)
	if err := r.saveKeys(); err != nil {
		return false, err
	}
	return true, os.Remove(filepath.Join(r.Dir, rotationFile))
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := append([]string{}, a...), append([]string{}, b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// checkOfflineDir refuses a folder inside the repository or its keys folder, or one that holds anything.
func (r *Repo) checkOfflineDir(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return fmt.Errorf("%w: the offline keys folder must be an absolute path", ErrCeremony)
	}
	dir = filepath.Clean(dir)
	for _, inside := range []string{r.Dir, r.keysDir()} {
		abs, _ := filepath.Abs(inside)
		if rel, err := filepath.Rel(abs, dir); err == nil && !strings.HasPrefix(rel, "..") {
			return fmt.Errorf("%w: %s is inside %s; offline keys stay outside it", ErrCeremony, dir, abs)
		}
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("%w: %s is not empty", ErrCeremony, dir)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// writeOfflineReadme says what the folder holds, for the person who carries it offline.
func writeOfflineReadme(dir string, res *RotateResult) error {
	var b strings.Builder
	fmt.Fprintf(&b, "Whombat releases: the key ceremony's offline keys (ONE-05), root version %d.\n\n", res.RootTo)
	fmt.Fprintf(&b, "root-0.json … root-%d.json  the root keys: any %d of them sign the next root (a new ceremony).\n",
		len(res.RootKeys)-1, res.RootThreshold)
	for i, id := range res.RootKeys {
		fmt.Fprintf(&b, "  root-%d.json  %s\n", i, id)
	}
	fmt.Fprintf(&b, "targets-0.json  the top-level targets key: re-signs targets before %s.\n  %s\n",
		res.TargetsExpires.Format("2 January 2006"), res.TargetsKey)
	fmt.Fprintf(&b, "production-0.json  a copy of the production key; the publisher keeps it online too.\n  %s\n\n",
		res.ProductionKey)
	fmt.Fprintf(&b, "The root expires %s.\n", res.RootExpires.Format("2 January 2006"))
	b.WriteString("Put every file on the offline media, keep the root keys apart, check each copy reads back, then\n")
	b.WriteString("delete this folder from this computer (docs/runbooks/updates.md, “The key ceremony”).\n")
	return os.WriteFile(filepath.Join(dir, "README.txt"), []byte(b.String()), 0o600)
}

// RotationPlan is what a ceremony would do, from the public metadata alone (no key is read): `tufrepo gh-rotate
// --check`.
type RotationPlan struct {
	Root          int64    `json:"root"`
	RootThreshold int      `json:"rootThreshold"`
	RootKeys      []string `json:"rootKeys"`
	Targets       int64    `json:"targets"`
	TargetsKeys   []string `json:"targetsKeys"`
	Production    []string `json:"productionKeys"`
	// Done: the root already needs two keys (a ceremony happened).
	Done bool `json:"done"`
}

// PlanRotation reads the newest verified root and top-level targets of a metadata folder.
func PlanRotation(metaDir string) (*RotationPlan, error) {
	root, err := verifiedChain(metaDir)
	if err != nil {
		return nil, err
	}
	top, _ := newestVerifiedTargets(metaDir, metadata.TARGETS, func(md *metadata.Metadata[metadata.TargetsType]) error {
		return root.VerifyDelegate(metadata.TARGETS, md)
	})
	if top == nil {
		return nil, fmt.Errorf("devtuf: no top-level targets verify against root %d", root.Signed.Version)
	}
	rr := root.Signed.Roles[metadata.ROOT]
	p := &RotationPlan{Root: root.Signed.Version, RootThreshold: rr.Threshold, RootKeys: rr.KeyIDs,
		Targets: top.Signed.Version, TargetsKeys: root.Signed.Roles[metadata.TARGETS].KeyIDs, Done: rr.Threshold >= 2}
	if top.Signed.Delegations != nil {
		for _, dr := range top.Signed.Delegations.Roles {
			if dr.Name == trust.ChannelProduction {
				p.Production = dr.KeyIDs
			}
		}
	}
	return p, nil
}
