// Package devtuf generates DEVELOPMENT TUF repositories for Whombat appliance updates: dev root,
// targets, snapshot and timestamp keys, release artifacts and approved release tuples as targets with
// custom metadata, key rotation, expiry manipulation and signed development update assignments.
//
// By default every key this package creates is a development key, written with `"development": true`,
// and the prod environment is refused. The one exception is the explicit production pilot mode (PI-05,
// MG-40, prod.go): Options{Env: "prod", Custody: CustodyOnlinePilot, KeysDir: <absolute dir>} creates and
// uses production keys kept online on the update host. The two never mix (MA-14): a development
// repository refuses production keys and options, a production repository refuses development keys and
// options. The target custody design stays the maintainers' release-signing runbook.
package devtuf

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// DevWarning is embedded in every generated key file.
const DevWarning = "DEVELOPMENT KEY - NEVER USE FOR PRODUCTION RELEASES OR ASSIGNMENTS"

var topRoles = []string{metadata.ROOT, metadata.TARGETS, metadata.SNAPSHOT, metadata.TIMESTAMP}

// Options configure a new repository.
type Options struct {
	Env         string           // assignment key environment, default "dev"
	Now         func() time.Time // clock for expiry, default time.Now
	RootExpiry  time.Duration    // default 365 days
	TargetsExp  time.Duration    // default 90 days
	SnapshotExp time.Duration    // default 7 days
	TimestampEx time.Duration    // default 1 day
	// KeysDir holds the development private keys (default <dir>/keys). The committed fixtures keep them
	// outside the served fixture tree (release-tools/fixtures/dev-keys, L-4). Relative to dir. In the
	// production pilot mode it is required, absolute, outside dir and 0700 (prod.go).
	KeysDir string
	// Custody is empty for development keys, or CustodyOnlinePilot for the production pilot (PI-05);
	// it requires Env "prod".
	Custody string
	// Edition is "" (commercial) or EditionCommunity: the community edition's own repository (Whombat HE-58, UP-X27).
	// It holds no assignment key (a community box has no control; its manager takes the newest release) and signs
	// whombat-community-YYYYMMDD.N ids only. Development keys only: no community production custody exists yet (HE-62).
	Edition string
	// Layout is "" (one server holds metadata and targets) or LayoutGitHub (LNK-24): the metadata goes to GitHub
	// Pages, the targets to GitHub release assets (ghpublish); snapshot and timestamp are signed by the repository's
	// workflow, not here, unless their keys are present; the lifetimes are LNK-25's (channels.go).
	Layout string
}

// EditionCommunity is the community edition's repository (Options.Edition).
const EditionCommunity = "community"

// Repo is an on-disk development TUF repository. Layout:
//
//	<dir>/metadata/{N.root.json,root.json,N.targets.json,N.snapshot.json,timestamp.json}
//	<dir>/targets/<dir>/<sha256>.<base>          (consistent-snapshot target names)
//	<dir>/keys/<role>-<n>.json                   (development private keys)
//	<dir>/state.json                             (unsigned working state for the CLI)
type Repo struct {
	Dir    string
	Env    string
	opts   Options
	keys   map[string][]ed25519.PrivateKey
	assign []ed25519.PrivateKey

	root    *metadata.Metadata[metadata.RootType]
	targets *metadata.Metadata[metadata.TargetsType]
	// clients is the delegated clients role (CT-74, clients.go); nil until AddClientsRole.
	clients *metadata.Metadata[metadata.TargetsType]
	// channels are the delegated channel roles (LNK-23, channels.go), by name; dest is the channel that target
	// changes go to ("" the top-level targets; InChannel).
	channels     map[string]*metadata.Metadata[metadata.TargetsType]
	dest         string
	keysOverride ed25519.PrivateKey
	// clientsEnv: the env the AI client channel is signed for when not Env (ClientsEnv; the GitHub repository, ONE-05).
	clientsEnv string
	snapshot   *metadata.Metadata[metadata.SnapshotType]
	timestamp  *metadata.Metadata[metadata.TimestampType]
}

func (o *Options) defaults() {
	if o.Layout == LayoutGitHub {
		gh := Options{}
		gh.githubExpiries()
		for _, p := range []struct{ v, d *time.Duration }{{&o.TargetsExp, &gh.TargetsExp}, {&o.SnapshotExp, &gh.SnapshotExp},
			{&o.TimestampEx, &gh.TimestampEx}, {&o.RootExpiry, &gh.RootExpiry}} {
			if *p.v == 0 {
				*p.v = *p.d
			}
		}
	}
	if o.Env == "" {
		o.Env = "dev"
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.RootExpiry == 0 {
		o.RootExpiry = 365 * 24 * time.Hour
		if o.Custody == CustodyOnlinePilot {
			o.RootExpiry = PilotRootExpiry
		}
	}
	if o.TargetsExp == 0 {
		o.TargetsExp = 90 * 24 * time.Hour
	}
	if o.SnapshotExp == 0 {
		o.SnapshotExp = 7 * 24 * time.Hour
	}
	if o.TimestampEx == 0 {
		o.TimestampEx = 24 * time.Hour
	}
}

func newKey() ed25519.PrivateKey {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return k
}

// New creates a repository with fresh development keys (one per role, one assignment key) and
// publishes version 1 of every role.
func New(dir string, opts Options) (*Repo, error) {
	opts.defaults()
	if err := checkMode(dir, opts); err != nil {
		return nil, err
	}
	r := &Repo{Dir: dir, Env: opts.Env, opts: opts, keys: map[string][]ed25519.PrivateKey{}}
	if r.prod() {
		if err := r.checkNewProd(); err != nil {
			return nil, err
		}
	}
	// Production: the repository is served by another (dynamic) user, so it is world-readable; it holds no key.
	dirMode := os.FileMode(0o700)
	if r.prod() {
		dirMode = 0o755
	}
	for _, d := range []string{"metadata", "targets"} {
		if err := os.MkdirAll(filepath.Join(dir, d), dirMode); err != nil {
			return nil, err
		}
		if err := os.Chmod(filepath.Join(dir, d), dirMode); err != nil {
			return nil, err
		}
	}
	now := opts.Now().UTC()
	r.root = metadata.Root(now.Add(opts.RootExpiry))
	r.root.Signed.ConsistentSnapshot = true
	for _, role := range topRoles {
		k := newKey()
		r.keys[role] = []ed25519.PrivateKey{k}
		if err := r.addRootKey(k, role); err != nil {
			return nil, err
		}
	}
	r.targets = metadata.Targets(now.Add(opts.TargetsExp))
	r.snapshot = metadata.Snapshot(now.Add(opts.SnapshotExp))
	r.timestamp = metadata.Timestamp(now.Add(opts.TimestampEx))
	// Production: control holds the assignment key (MG-21); its public half is added with
	// SetAssignmentKey. Development: the repository makes one. Community: none at all (no control, UP-X27).
	if !r.prod() && !r.Community() {
		r.assign = []ed25519.PrivateKey{newKey()}
		if err := r.writeAssignmentKeys(); err != nil {
			return nil, err
		}
	}
	// Production: the keys are on disk before any metadata names them.
	if r.prod() {
		if err := r.saveKeys(); err != nil {
			return nil, err
		}
	}
	if err := r.signWriteRoot(nil); err != nil {
		return nil, err
	}
	// Version 1 of targets/snapshot/timestamp; Publish bumps from here.
	r.targets.Signed.Version = 0
	r.snapshot.Signed.Version = 0
	r.timestamp.Signed.Version = 0
	if err := r.Publish(); err != nil {
		return nil, err
	}
	return r, r.saveKeys()
}

func (r *Repo) addRootKey(k ed25519.PrivateKey, role string) error {
	key, err := metadata.KeyFromPublicKey(k.Public())
	if err != nil {
		return err
	}
	return r.root.Signed.AddKey(key, role)
}

func signer(k ed25519.PrivateKey) signature.Signer {
	s, err := signature.LoadSigner(k, crypto.Hash(0))
	if err != nil {
		panic(err)
	}
	return s
}

func (r *Repo) metaDir() string    { return filepath.Join(r.Dir, "metadata") }
func (r *Repo) targetsDir() string { return filepath.Join(r.Dir, "targets") }

// MetadataDir is the directory to serve as the TUF metadata base URL.
func (r *Repo) MetadataDir() string { return r.metaDir() }

// TargetsDir is the directory to serve as the TUF targets base URL.
func (r *Repo) TargetsDir() string { return r.targetsDir() }

// writeJSON replaces p atomically (a client reading root.json or timestamp.json never sees half a file).
func writeJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// signWriteRoot signs the current root with its own keys plus extra (previous) root keys, and
// writes N.root.json and root.json.
func (r *Repo) signWriteRoot(previous []ed25519.PrivateKey) error {
	r.root.ClearSignatures()
	seen := map[string]bool{}
	for _, k := range append(append([]ed25519.PrivateKey{}, previous...), r.keys[metadata.ROOT]...) {
		id := hex.EncodeToString(k.Public().(ed25519.PublicKey))
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, err := r.root.Sign(signer(k)); err != nil {
			return err
		}
	}
	v := r.root.Signed.Version
	if err := writeJSON(filepath.Join(r.metaDir(), fmt.Sprintf("%d.root.json", v)), r.root); err != nil {
		return err
	}
	return writeJSON(filepath.Join(r.metaDir(), "root.json"), r.root)
}

// RootBytes returns the current root metadata bytes.
func (r *Repo) RootBytes() []byte {
	b, _ := os.ReadFile(filepath.Join(r.metaDir(), "root.json"))
	return b
}

// InitialRoot returns 1.root.json (what a device is provisioned with).
func (r *Repo) InitialRoot() []byte {
	b, _ := os.ReadFile(filepath.Join(r.metaDir(), "1.root.json"))
	return b
}

// consistentName returns targets/<dir>/<sha256>.<base>.
func consistentName(targetPath, sha string) string {
	dir, base := path.Split(targetPath)
	return path.Join(dir, sha+"."+base)
}

func (r *Repo) putTarget(targetPath string, content []byte, custom any) (*metadata.TargetFiles, error) {
	targetPath = r.destPath(targetPath)
	tf, err := metadata.TargetFile().FromBytes(targetPath, content, "sha256")
	if err != nil {
		return nil, err
	}
	if custom != nil {
		raw, err := json.Marshal(map[string]any{trust.CustomKey: custom})
		if err != nil {
			return nil, err
		}
		rm := json.RawMessage(raw)
		tf.Custom = &rm
	}
	sha := hex.EncodeToString(tf.Hashes["sha256"])
	p := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(targetPath, sha)))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(p, content, 0o644); err != nil {
		return nil, err
	}
	r.destTargets()[targetPath] = tf
	return tf, nil
}

// TargetFilePath returns the on-disk path of a published target (for corruption fixtures).
func (r *Repo) TargetFilePath(targetPath string) (string, error) {
	targetPath = r.destPath(targetPath)
	tf, ok := r.destTargets()[targetPath]
	if !ok {
		return "", fmt.Errorf("no target %s", targetPath)
	}
	return filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(targetPath, hex.EncodeToString(tf.Hashes["sha256"])))), nil
}

// AddRelease approves a release tuple (not yet published): target releases/<id>.json whose content
// is the tuple's canonical JSON and whose custom metadata carries the tuple.
func (r *Repo) AddRelease(t release.ReleaseTuple) error { return r.AddReleaseAllowingDowngrade(t) }

// AddReleaseAllowingDowngrade approves a release tuple that devices on one of the `from` releases may move
// back to although it is older (custody-signed rollback, trust.CheckForward).
func (r *Repo) AddReleaseAllowingDowngrade(t release.ReleaseTuple, from ...string) error {
	if err := t.Validate(); err != nil {
		return err
	}
	canon, err := canonjson.Marshal(t)
	if err != nil {
		return err
	}
	custom := map[string]any{"kind": trust.KindReleaseTuple, "tuple": t}
	if len(from) > 0 {
		custom["allowDowngradeFrom"] = from
	}
	_, err = r.putTarget(trust.ReleaseTarget(t.ReleaseID), canon, custom)
	return err
}

// RemoveTarget removes a target (e.g. unapproves a release).
func (r *Repo) RemoveTarget(targetPath string) { delete(r.destTargets(), r.destPath(targetPath)) }

// AssignmentKeysDoc returns the current (unpublished changes included) AssignmentKeys document.
func (r *Repo) AssignmentKeysDoc() release.AssignmentKeys {
	doc := release.AssignmentKeys{V: 1, Env: release.Environment(r.Env), Keys: []release.AssignmentKeysKeysItem{}}
	tf, ok := r.targets.Signed.Targets[trust.AssignmentKeysTarget]
	if !ok || tf.Custom == nil {
		return doc
	}
	var c struct {
		Whombat struct {
			Document release.AssignmentKeys `json:"document"`
		} `json:"whombat"`
	}
	if json.Unmarshal(*tf.Custom, &c) == nil && c.Whombat.Document.V == 1 {
		return c.Whombat.Document
	}
	return doc
}

// SetAssignmentKeysDoc validates the document against the schema and the contract's key state
// machine (release.AssignmentKeyMap, CT-41: an active key without window, next keys with notBefore
// and no notAfter, retired keys with notAfter and no notBefore, at least one active key) and writes
// the control/assignment-keys.json target (content = canonical JSON; custom = {kind, document}).
// Not yet published.
func (r *Repo) SetAssignmentKeysDoc(doc release.AssignmentKeys) error {
	if string(doc.Env) != r.Env {
		return fmt.Errorf("devtuf: assignment keys for env %q do not belong in a %q repository", doc.Env, r.Env)
	}
	sort.Slice(doc.Keys, func(i, j int) bool { return doc.Keys[i].Kid < doc.Keys[j].Kid })
	canon, err := canonjson.Marshal(doc)
	if err != nil {
		return err
	}
	if _, err := release.AssignmentKeyMap(canon, doc.Env, 0); err != nil {
		return err
	}
	return r.SetAssignmentKeysDocUnchecked(doc)
}

// SetAssignmentKeysDocUnchecked writes the target without the state-machine check. Tests only: it
// lets a test publish an invalid document to prove that devices refuse it.
func (r *Repo) SetAssignmentKeysDocUnchecked(doc release.AssignmentKeys) error {
	canon, err := canonjson.Marshal(doc)
	if err != nil {
		return err
	}
	_, err = r.putTarget(trust.AssignmentKeysTarget, canon, map[string]any{"kind": trust.KindAssignmentKeys, "document": doc})
	return err
}

func withKey(doc release.AssignmentKeys, item release.AssignmentKeysKeysItem) release.AssignmentKeys {
	for i := range doc.Keys {
		if doc.Keys[i].Kid == item.Kid {
			doc.Keys[i] = item
			return doc
		}
	}
	doc.Keys = append(doc.Keys, item)
	return doc
}

// SetAssignmentKey adds or replaces one key (by kid) in the document, e.g. control's public key:
// release custody authorizing an online assignment key. Windows follow the contract: active — none;
// next — notBefore (accepted from then; promote to active later); retired — notAfter (accepted until
// then). Not yet published.
func (r *Repo) SetAssignmentKey(kid, publicHex, state string, notBefore, notAfter *int64) error {
	return r.SetAssignmentKeysDoc(withKey(r.AssignmentKeysDoc(), release.AssignmentKeysKeysItem{
		Kid: kid, PublicKey: publicHex, State: state, NotBefore: notBefore, NotAfter: notAfter}))
}

// RemoveAssignmentKey drops a key from the document (immediate revocation). Not yet published.
func (r *Repo) RemoveAssignmentKey(kid string) error {
	doc := r.AssignmentKeysDoc()
	var keep []release.AssignmentKeysKeysItem
	for _, k := range doc.Keys {
		if k.Kid != kid {
			keep = append(keep, k)
		}
	}
	doc.Keys = keep
	return r.SetAssignmentKeysDoc(doc)
}

// EditionOf is the edition a repository directory's state.json names ("" for commercial or no state), without its keys
// or lock (check-newer --dir).
func EditionOf(dir string) string {
	var st struct {
		Edition string `json:"edition"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil || json.Unmarshal(b, &st) != nil {
		return ""
	}
	return st.Edition
}

// Community reports whether this is the community edition's repository (Options.Edition).
func (r *Repo) Community() bool { return r.opts.Edition == EditionCommunity }

func (r *Repo) writeAssignmentKeys() error {
	if r.Community() {
		return errors.New("devtuf: a community repository holds no assignment key (a community box has no control, UP-X27)")
	}
	if len(r.assign) == 0 {
		return errors.New("devtuf: this repository holds no assignment key (production: control holds it)")
	}
	return r.SetAssignmentKey(assignmentKeyID(r.assign[0]), hex.EncodeToString(r.assign[0].Public().(ed25519.PublicKey)), "active", nil, nil)
}

// assignmentKeyID is a contracts Ident derived from the public key ("asg-dev-<12 hex>").
func assignmentKeyID(k ed25519.PrivateKey) string {
	sum := sha256.Sum256(k.Public().(ed25519.PublicKey))
	return "asg-dev-" + hex.EncodeToString(sum[:6])
}

// AssignmentKeyID returns the kid of the current development assignment key ("" in production).
func (r *Repo) AssignmentKeyID() string {
	if len(r.assign) == 0 {
		return ""
	}
	return assignmentKeyID(r.assign[0])
}

// RotateAssignmentKey makes a fresh development key active in one document change. With grace > 0
// the previous key becomes `retired` with notAfter = now+grace (long-offline devices); with
// grace <= 0 it is removed. Not yet published.
func (r *Repo) RotateAssignmentKey(grace time.Duration) error {
	if len(r.assign) == 0 {
		return errors.New("devtuf: this repository holds no assignment key (production: control rotates it; use add-assignment-key)")
	}
	old := r.assign[0]
	r.assign = []ed25519.PrivateKey{newKey()}
	doc := withKey(r.AssignmentKeysDoc(), release.AssignmentKeysKeysItem{Kid: assignmentKeyID(r.assign[0]),
		PublicKey: hex.EncodeToString(r.assign[0].Public().(ed25519.PublicKey)), State: "active"})
	oldKid := assignmentKeyID(old)
	if grace > 0 {
		na := r.opts.Now().Add(grace).Unix()
		doc = withKey(doc, release.AssignmentKeysKeysItem{Kid: oldKid, PublicKey: hex.EncodeToString(old.Public().(ed25519.PublicKey)),
			State: "retired", NotAfter: &na})
	} else {
		var keep []release.AssignmentKeysKeysItem
		for _, k := range doc.Keys {
			if k.Kid != oldKid {
				keep = append(keep, k)
			}
		}
		doc.Keys = keep
	}
	if err := r.SetAssignmentKeysDoc(doc); err != nil {
		return err
	}
	return r.saveKeys()
}

// SignAssignmentWith signs a payload with an arbitrary key/kid (tests of retired or unknown keys).
func SignAssignmentWith(p release.AssignmentPayload, kid string, key ed25519.PrivateKey) ([]byte, error) {
	return trust.SignAssignment(p, kid, key)
}

// Publish bumps and signs targets, snapshot and timestamp and writes them (consistent snapshots).
func (r *Repo) Publish() error {
	if r.dest != "" {
		return r.publishChannel(r.dest)
	}
	now := r.opts.Now().UTC()
	r.targets.Signed.Version++
	// Production: every targets version gets the full lifetime (the runbook's 90 days).
	if r.prod() || r.targets.Signed.Expires.Before(now.Add(time.Minute)) {
		r.targets.Signed.Expires = now.Add(r.opts.TargetsExp)
	}
	if err := r.signTargets(); err != nil {
		return err
	}
	return r.PublishSnapshot()
}

func (r *Repo) signTargets() error {
	r.targets.ClearSignatures()
	for _, k := range r.keys[metadata.TARGETS] {
		if _, err := r.targets.Sign(signer(k)); err != nil {
			return err
		}
	}
	return writeJSON(filepath.Join(r.metaDir(), fmt.Sprintf("%d.targets.json", r.targets.Signed.Version)), r.targets)
}

// PublishSnapshot bumps snapshot and timestamp only.
func (r *Repo) PublishSnapshot() error {
	if len(r.keys[metadata.SNAPSHOT]) == 0 || len(r.keys[metadata.TIMESTAMP]) == 0 {
		if r.GitHub() {
			// The GitHub layout's snapshot and timestamp keys live in the repository's Actions secrets (LNK-25): the
			// workflow signs them on the push of the role metadata.
			return nil
		}
		return errors.New("devtuf: no snapshot or timestamp key")
	}
	now := r.opts.Now().UTC()
	r.snapshot.Signed.Version++
	r.snapshot.Signed.Expires = now.Add(r.opts.SnapshotExp)
	r.snapshot.Signed.Meta = map[string]*metadata.MetaFiles{"targets.json": metadata.MetaFile(r.targets.Signed.Version)}
	if r.clients != nil {
		r.snapshot.Signed.Meta[trust.ClientsRole+".json"] = metadata.MetaFile(r.clients.Signed.Version)
	}
	for name, md := range r.channels {
		r.snapshot.Signed.Meta[name+".json"] = metadata.MetaFile(md.Signed.Version)
	}
	r.snapshot.ClearSignatures()
	for _, k := range r.keys[metadata.SNAPSHOT] {
		if _, err := r.snapshot.Sign(signer(k)); err != nil {
			return err
		}
	}
	if err := writeJSON(filepath.Join(r.metaDir(), fmt.Sprintf("%d.snapshot.json", r.snapshot.Signed.Version)), r.snapshot); err != nil {
		return err
	}
	return r.PublishTimestamp()
}

// PublishTimestamp bumps and re-signs only the timestamp (what the online timestamp key does often).
func (r *Repo) PublishTimestamp() error {
	now := r.opts.Now().UTC()
	r.timestamp.Signed.Version++
	r.timestamp.Signed.Expires = now.Add(r.opts.TimestampEx)
	snapBytes, err := os.ReadFile(filepath.Join(r.metaDir(), fmt.Sprintf("%d.snapshot.json", r.snapshot.Signed.Version)))
	if err != nil {
		return err
	}
	mf := metadata.MetaFile(r.snapshot.Signed.Version)
	sum := sha256.Sum256(snapBytes)
	mf.Length = int64(len(snapBytes))
	mf.Hashes = metadata.Hashes{"sha256": sum[:]}
	r.timestamp.Signed.Meta = map[string]*metadata.MetaFiles{"snapshot.json": mf}
	return r.signWriteTimestamp()
}

func (r *Repo) signWriteTimestamp() error {
	r.timestamp.ClearSignatures()
	for _, k := range r.keys[metadata.TIMESTAMP] {
		if _, err := r.timestamp.Sign(signer(k)); err != nil {
			return err
		}
	}
	return writeJSON(filepath.Join(r.metaDir(), "timestamp.json"), r.timestamp)
}

// SetTimestampExpiry re-signs the current timestamp (same version) with the given expiry.
// Used for "expired timestamp" fixtures.
func (r *Repo) SetTimestampExpiry(t time.Time) error {
	r.timestamp.Signed.Expires = t.UTC()
	return r.signWriteTimestamp()
}

// SetTargetsExpiry sets the targets expiry used by the next Publish.
func (r *Repo) SetTargetsExpiry(t time.Time) { r.targets.Signed.Expires = t.UTC() }

// RotateKeys replaces the keys of the given roles with fresh development keys and publishes a new
// root version signed by both the old and the new root keys (TUF rotation), then republishes.
func (r *Repo) RotateKeys(roles ...string) error {
	oldRoot := append([]ed25519.PrivateKey{}, r.keys[metadata.ROOT]...)
	for _, role := range roles {
		if !contains(topRoles, role) {
			return fmt.Errorf("unknown role %q", role)
		}
		for _, k := range r.keys[role] {
			key, _ := metadata.KeyFromPublicKey(k.Public())
			id, _ := key.ID()
			if err := r.root.Signed.RevokeKey(id, role); err != nil {
				return err
			}
		}
		nk := newKey()
		r.keys[role] = []ed25519.PrivateKey{nk}
		if err := r.addRootKey(nk, role); err != nil {
			return err
		}
	}
	r.root.Signed.Version++
	now := r.opts.Now().UTC()
	if r.root.Signed.Expires.Before(now.Add(30 * 24 * time.Hour)) {
		r.root.Signed.Expires = now.Add(r.opts.RootExpiry)
	}
	if err := r.signWriteRoot(oldRoot); err != nil {
		return err
	}
	if err := r.saveKeys(); err != nil {
		return err
	}
	return r.Publish()
}

// Assign signs a development install assignment for releaseID (tuple digest filled in from the
// approved target; an unapproved id gets a zero digest so refusal paths can be tested).
func (r *Repo) Assign(deviceID, releaseID string, seq int64, validity time.Duration) ([]byte, error) {
	digest := "sha256:" + strings.Repeat("0", 64)
	if tf, ok := r.destTargets()[r.destPath(trust.ReleaseTarget(releaseID))]; ok {
		digest = "sha256:" + hex.EncodeToString(tf.Hashes["sha256"])
	}
	return r.SignPayload(r.Payload(deviceID, "install", &releaseID, &digest, seq, validity))
}

// Hold signs a development hold assignment (pause/emergency stop).
func (r *Repo) Hold(deviceID string, seq int64, validity time.Duration) ([]byte, error) {
	return r.SignPayload(r.Payload(deviceID, "hold", nil, nil, seq, validity))
}

// Payload builds an assignment payload valid from now for validity (max 7 days).
func (r *Repo) Payload(deviceID, action string, releaseID, digest *string, seq int64, validity time.Duration) release.AssignmentPayload {
	now := r.opts.Now().UTC()
	rollout := "dev-rollout"
	return release.AssignmentPayload{Purpose: release.AssignmentPurpose, Env: release.Environment(r.Env), Device: deviceID,
		Sequence: seq, Action: action, ReleaseID: releaseID, TupleDigest: digest, RolloutID: &rollout,
		IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(validity).Unix()}
}

// SignPayload signs an arbitrary payload with the development assignment key.
func (r *Repo) SignPayload(p release.AssignmentPayload) ([]byte, error) {
	if len(r.assign) == 0 {
		return nil, errors.New("devtuf: this repository holds no assignment key (production assignments come from control)")
	}
	return trust.SignAssignment(p, assignmentKeyID(r.assign[0]), r.assign[0])
}

// AssignmentKey returns the current development assignment private key (nil in production).
func (r *Repo) AssignmentKey() ed25519.PrivateKey {
	if len(r.assign) == 0 {
		return nil
	}
	return r.assign[0]
}

// Versions returns the current role versions.
func (r *Repo) Versions() map[string]int64 {
	return map[string]int64{
		metadata.ROOT: r.root.Signed.Version, metadata.TARGETS: r.targets.Signed.Version,
		metadata.SNAPSHOT: r.snapshot.Signed.Version, metadata.TIMESTAMP: r.timestamp.Signed.Version,
	}
}

// RoleVersions returns the current versions of every role, the delegated ones included.
func (r *Repo) RoleVersions() map[string]int64 {
	v := r.Versions()
	if r.clients != nil {
		v[trust.ClientsRole] = r.clients.Signed.Version
	}
	for name, md := range r.channels {
		v[name] = md.Signed.Version
	}
	return v
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

type keyFile struct {
	Development bool   `json:"development"`
	Environment string `json:"environment,omitempty"` // production: "prod"
	Custody     string `json:"custody,omitempty"`     // production: CustodyOnlinePilot
	Warning     string `json:"warning"`
	Role        string `json:"role"`
	KeyID       string `json:"keyid"`
	Seed        string `json:"ed25519Seed"`
}

func (r *Repo) keysDir() string {
	if r.opts.KeysDir == "" {
		return filepath.Join(r.Dir, "keys")
	}
	if filepath.IsAbs(r.opts.KeysDir) {
		return filepath.Clean(r.opts.KeysDir)
	}
	return filepath.Join(r.Dir, r.opts.KeysDir)
}

// keyFileHook, when set (tests), runs before each change saveKeys makes to the keys folder ("write" or "remove", the
// file's name): an error stops it there, as a kill would (R2 A2).
var keyFileHook func(op, name string) error

// saveKeys makes the keys folder hold r's keys, one file at a time and never the whole folder at once (R2 A2): a key
// file that changed is written to a temporary file, synced and renamed over it; a key file of no key any more is removed
// after every write; the rest is left as it is. A kill at any point leaves every key that stays readable where it was,
// and running it again finishes the change.
func (r *Repo) saveKeys() error {
	if r.prod() {
		return r.saveProdKeys()
	}
	kd := r.keysDir()
	if err := os.MkdirAll(kd, 0o700); err != nil {
		return err
	}
	want := map[string][]byte{}
	add := func(role string, i int, k ed25519.PrivateKey) {
		key, _ := metadata.KeyFromPublicKey(k.Public())
		id, _ := key.ID()
		if role == "assignment" {
			id = assignmentKeyID(k)
		}
		kf := keyFile{Development: true, Warning: DevWarning, Role: role, KeyID: id, Seed: base64.StdEncoding.EncodeToString(k.Seed())}
		b, _ := json.MarshalIndent(kf, "", " ")
		want[fmt.Sprintf("%s-%d.json", role, i)] = b
	}
	for role, ks := range r.keys {
		for i, k := range ks {
			add(role, i, k)
		}
	}
	for i, k := range r.assign {
		add("assignment", i, k)
	}
	entries, err := os.ReadDir(kd)
	if err != nil {
		return err
	}
	for _, e := range entries {
		// A temporary file a kill left behind: never a key (Load reads *.json only).
		if strings.Contains(e.Name(), ".tmp-") {
			_ = os.Remove(filepath.Join(kd, e.Name()))
		}
	}
	names := make([]string, 0, len(want))
	for n := range want {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if old, err := os.ReadFile(filepath.Join(kd, n)); err == nil && bytes.Equal(old, want[n]) {
			continue
		}
		if keyFileHook != nil {
			if err := keyFileHook("write", n); err != nil {
				return err
			}
		}
		if err := replaceFileSync(filepath.Join(kd, n), want[n], 0o600); err != nil {
			return err
		}
	}
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".json") || want[n] != nil {
			continue
		}
		if keyFileHook != nil {
			if err := keyFileHook("remove", n); err != nil {
				return err
			}
		}
		if err := os.Remove(filepath.Join(kd, n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := syncDir(kd); err != nil {
			return err
		}
	}
	st := map[string]any{"env": r.Env, "development": true}
	if r.opts.KeysDir != "" {
		st["keysDir"] = r.opts.KeysDir
	}
	if r.Community() {
		st["edition"] = EditionCommunity
	}
	if r.GitHub() {
		st["layout"] = LayoutGitHub
	}
	if r.clientsEnv != "" {
		st["clientsEnv"] = r.clientsEnv
	}
	return writeJSON(filepath.Join(r.Dir, "state.json"), st)
}

// replaceFileSync replaces path with b: a temporary file beside it, synced, renamed over it, the folder synced.
func replaceFileSync(path string, b []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return syncDir(dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func parseKeyFile(b []byte, name string) (string, []byte, error) {
	var kf keyFile
	if err := json.Unmarshal(b, &kf); err != nil || !kf.Development || kf.Custody != "" || kf.Environment == "prod" {
		return "", nil, fmt.Errorf("devtuf: %s is not a development key", name)
	}
	seed, err := base64.StdEncoding.DecodeString(kf.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return "", nil, fmt.Errorf("devtuf: bad key %s", name)
	}
	return kf.Role, seed, nil
}

// WriteKeyFile writes a development key file for role (0600, refuses to overwrite).
func WriteKeyFile(path, role string, k ed25519.PrivateKey) error {
	key, _ := metadata.KeyFromPublicKey(k.Public())
	id, _ := key.ID()
	b, _ := json.MarshalIndent(keyFile{Development: true, Warning: DevWarning, Role: role, KeyID: id,
		Seed: base64.StdEncoding.EncodeToString(k.Seed())}, "", " ")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// NewDevKey returns a fresh development Ed25519 key.
func NewDevKey() ed25519.PrivateKey { return newKey() }

// Load opens an existing development repository created by New.
func Load(dir string, opts Options) (*Repo, error) {
	if opts.Custody != "" {
		return loadProd(dir, opts)
	}
	opts.defaults()
	r := &Repo{Dir: dir, opts: opts, keys: map[string][]ed25519.PrivateKey{}}
	var st struct {
		Env         string `json:"env"`
		Development bool   `json:"development"`
		KeysDir     string `json:"keysDir"`
		Custody     string `json:"custody"`
		Edition     string `json:"edition"`
		Layout      string `json:"layout"`
		ClientsEnv  string `json:"clientsEnv"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, errors.New("devtuf: not a development repository")
	}
	if st.Custody != "" || st.Env == "prod" {
		return nil, errors.New("devtuf: this is a production repository; use --env prod --custody " + CustodyOnlinePilot + " --keys-dir DIR")
	}
	if !st.Development {
		return nil, errors.New("devtuf: not a development repository")
	}
	r.Env = st.Env
	r.opts.Env = st.Env
	switch st.Edition {
	case "", EditionCommunity:
		r.opts.Edition = st.Edition
	default:
		return nil, fmt.Errorf("devtuf: unknown edition %q", st.Edition)
	}
	if st.KeysDir != "" {
		r.opts.KeysDir = st.KeysDir
	}
	switch st.Layout {
	case "", LayoutGitHub:
		r.opts.Layout = st.Layout
	default:
		return nil, fmt.Errorf("devtuf: unknown layout %q", st.Layout)
	}
	if r.GitHub() {
		r.opts.githubExpiries()
	}
	switch st.ClientsEnv {
	case "", "prod", "dev", "local":
		r.clientsEnv = st.ClientsEnv
	default:
		return nil, fmt.Errorf("devtuf: unknown clients env %q", st.ClientsEnv)
	}
	entries, err := os.ReadDir(r.keysDir())
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(r.keysDir(), e.Name()))
		if err != nil {
			return nil, err
		}
		role, seed, err := parseKeyFile(b, e.Name())
		if err != nil {
			return nil, err
		}
		k := ed25519.NewKeyFromSeed(seed)
		if role == "assignment" {
			r.assign = append(r.assign, k)
		} else {
			r.keys[role] = append(r.keys[role], k)
		}
	}
	return r, r.loadMetadata()
}

// loadMetadata reads the current root, timestamp, snapshot, targets and clients role.
func (r *Repo) loadMetadata() error {
	var err error
	md := r.metaDir()
	if r.root, err = metadata.Root().FromFile(filepath.Join(md, "root.json")); err != nil {
		return err
	}
	if r.timestamp, err = metadata.Timestamp().FromFile(filepath.Join(md, "timestamp.json")); err != nil {
		return err
	}
	sv := r.timestamp.Signed.Meta["snapshot.json"].Version
	if r.snapshot, err = metadata.Snapshot().FromFile(filepath.Join(md, fmt.Sprintf("%d.snapshot.json", sv))); err != nil {
		return err
	}
	tv := r.snapshot.Signed.Meta["targets.json"].Version
	if r.targets, err = metadata.Targets().FromFile(filepath.Join(md, fmt.Sprintf("%d.targets.json", tv))); err != nil {
		return err
	}
	if cm, ok := r.snapshot.Signed.Meta[trust.ClientsRole+".json"]; ok {
		if r.clients, err = metadata.Targets().FromFile(filepath.Join(md, fmt.Sprintf("%d.%s.json", cm.Version, trust.ClientsRole))); err != nil {
			return err
		}
	}
	if err := r.loadChannels(); err != nil {
		return err
	}
	if r.GitHub() {
		return r.loadNewest()
	}
	return nil
}
