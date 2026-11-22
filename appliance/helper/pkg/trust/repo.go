package trust

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/fetcher"
	"github.com/theupdateframework/go-tuf/v2/metadata/trustedmetadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

// Error classes returned (wrapped) by this package.
var (
	ErrNotApproved     = errors.New("release is not an approved TUF target")
	ErrIncompatible    = errors.New("release tuple components are incompatible")
	ErrInvalidMetadata = errors.New("invalid release metadata")
	ErrExpired         = errors.New("TUF metadata expired")
	ErrRollback        = errors.New("TUF metadata rollback or version mismatch")
	ErrSignature       = errors.New("TUF metadata signature threshold not met")
	ErrUnavailable     = errors.New("TUF repository unavailable")
	ErrArtifact        = errors.New("artifact does not match TUF target length/hashes")
)

// Config configures one TUF refresh.
type Config struct {
	// PinnedRoot is the trusted root installed at provisioning. A newer root cached in MetadataDir
	// (reached through verified rotations) takes precedence.
	PinnedRoot []byte
	// MetadataDir is this process's own trusted metadata cache (0700).
	MetadataDir string
	// MetadataURL is the base URL the Fetcher resolves (http(s) for the manager, mirror:// for the helper).
	MetadataURL string
	Fetcher     fetcher.Fetcher
	// Now is the reference time for expiry checks (the caller applies its trusted time floor).
	Now time.Time
	// Production refuses roots (pinned, cached or rotated to) that trust a development key (L-4), and, once the pinned
	// root needs two root keys, any that one key can replace (ONE-05).
	Production bool
	// ResolveClients also resolves the client channel through the delegated `clients` role (CT-74; the manager
	// only, the helper never needs it). Its failure is reported by Repo.ClientsError, never by Refresh.
	ResolveClients bool
	// Channel, when set (ChannelProduction or ChannelDevelopment, LNK-23), makes the view the targets of that
	// delegated channel role instead of the top-level targets: releases resolve only through the box's channel. A
	// repository without the role fails the refresh (ErrChannelUnavailable). Empty: the top-level targets, as before.
	Channel string
	// LoadChannels are further channel roles to verify and cache (the manager mirrors both channels for its helper, so
	// a channel change never waits for a refresh). Their failure fails nothing.
	LoadChannels []string
}

// Repo is a verified, consistent view of the top-level TUF targets, or of one channel's (Config.Channel).
type Repo struct {
	RootVersion      int64
	TimestampVersion int64
	SnapshotVersion  int64
	TargetsVersion   int64
	TimestampExpires time.Time
	TargetsExpires   time.Time
	RefTime          time.Time
	// Channel is the channel role the view reads ("" the top-level targets); ChannelVersion and ChannelExpires are
	// its metadata's; ChannelPaused is true when the verified channel role carries the pause marker.
	Channel        string
	ChannelVersion int64
	ChannelExpires time.Time
	ChannelPaused  bool
	// RoleVersions are the versions of the delegated channel roles this refresh verified (the manager's mirror
	// publishes them for its helper).
	RoleVersions map[string]int64
	// targets is what releases resolve through (the channel's, prefix taken off, or the top level's); top the
	// top-level targets (assignment keys).
	targets       map[string]*metadata.TargetFiles
	top           map[string]*metadata.TargetFiles
	clientTargets map[string]*metadata.TargetFiles
	clientsErr    error
}

// Refresh runs the TUF client workflow (root rotation, timestamp, snapshot, targets with rollback,
// freeze and consistency checks) and returns the verified targets view.
func Refresh(cfg Config) (*Repo, error) {
	if cfg.MetadataDir == "" || cfg.Fetcher == nil || cfg.MetadataURL == "" {
		return nil, errors.New("trust: incomplete config")
	}
	if err := os.MkdirAll(cfg.MetadataDir, 0o700); err != nil {
		return nil, err
	}
	cachedRoot := filepath.Join(cfg.MetadataDir, "root.json")
	root, err := chooseRoot(cfg.PinnedRoot, cachedRoot)
	if err != nil {
		return nil, err
	}
	if cfg.Production {
		if err := checkProductionRootBytes(cfg.PinnedRoot); err != nil {
			return nil, err
		}
		if err := checkRootThresholdBytes(cfg.PinnedRoot, cfg.PinnedRoot); err != nil {
			return nil, err
		}
		// A cached root the rules refuse (written before they were checked ahead of the write) is never trusted again:
		// the chain is walked once more from the pinned root, so a corrected root can still be reached.
		if !bytes.Equal(root, cfg.PinnedRoot) && rootRefused(cfg.PinnedRoot, root) != nil {
			if err := os.Remove(cachedRoot); err != nil && !os.IsNotExist(err) {
				return nil, err
			}
			root = cfg.PinnedRoot
		}
	}
	// The one root walk of this refresh (R1 #3, R2 A1): every newer root is verified and, in production, checked
	// against the rules (ONE-05) before it is written; the walk stops at the first refused one and the cache keeps the
	// last accepted root. go-tuf starts from that root and fetches no root itself (MaxRootRotations 0), so nothing it
	// does can write or trust another.
	if root, err = walkRoots(cfg, root, cachedRoot); err != nil {
		return nil, err
	}
	dropCorruptCache(cfg.MetadataDir)
	uc, err := config.New(cfg.MetadataURL, root)
	if err != nil {
		return nil, err
	}
	uc.LocalMetadataDir = cfg.MetadataDir
	uc.LocalTargetsDir = filepath.Join(cfg.MetadataDir, "targets")
	uc.Fetcher = cfg.Fetcher
	uc.PrefixTargetsWithHash = true
	uc.MaxRootRotations = 0
	up, err := updater.New(uc)
	if err != nil {
		return nil, classify(err)
	}
	now := cfg.Now
	if now.IsZero() {
		now = time.Now()
	}
	up.UnsafeSetRefTime(now.UTC())
	refreshErr := up.Refresh()
	// go-tuf persists metadata without fsync; make whatever it wrote durable either way.
	syncCache(cfg.MetadataDir)
	if refreshErr != nil {
		return nil, classify(refreshErr)
	}
	set := up.GetTrustedMetadataSet()
	if walked, err := rootVersion(root); err != nil || set.Root.Signed.Version != walked {
		return nil, fmt.Errorf("%w: the refresh trusts root %d, not the walked root", ErrInvalidMetadata, set.Root.Signed.Version)
	}
	r := &Repo{
		RootVersion:      set.Root.Signed.Version,
		TimestampVersion: set.Timestamp.Signed.Version,
		SnapshotVersion:  set.Snapshot.Signed.Version,
		TargetsVersion:   set.Targets[metadata.TARGETS].Signed.Version,
		TimestampExpires: set.Timestamp.Signed.Expires,
		TargetsExpires:   set.Targets[metadata.TARGETS].Signed.Expires,
		RefTime:          now,
		targets:          up.GetTopLevelTargets(),
		top:              up.GetTopLevelTargets(),
		RoleVersions:     map[string]int64{},
	}
	if cfg.Channel != "" {
		targets, md, err := loadChannel(up, cfg.Channel)
		syncCache(cfg.MetadataDir)
		if err != nil {
			return nil, err
		}
		paused, err := IsChannelPaused(md)
		if err != nil {
			return nil, err
		}
		r.Channel, r.ChannelVersion, r.ChannelExpires, r.ChannelPaused, r.targets = cfg.Channel, md.Signed.Version, md.Signed.Expires, paused, targets
		r.RoleVersions[cfg.Channel] = md.Signed.Version
	}
	for _, c := range cfg.LoadChannels {
		if _, done := r.RoleVersions[c]; done {
			continue
		}
		if _, md, err := loadChannel(up, c); err == nil {
			r.RoleVersions[c] = md.Signed.Version
		}
	}
	if len(cfg.LoadChannels) > 0 {
		syncCache(cfg.MetadataDir)
	}
	if cfg.ResolveClients {
		r.resolveClients(up)
		syncCache(cfg.MetadataDir)
	}
	return r, nil
}

// rootRefused is why a production box doesn't trust root b (a development key, or one key that can replace it once the
// pinned root needs two), or nil.
func rootRefused(pinned, b []byte) error {
	if err := checkProductionRootBytes(b); err != nil {
		return err
	}
	return checkRootThresholdBytes(pinned, b)
}

// walkRoots follows the root rotations from the trusted root as go-tuf would (each new root signed by its predecessor's
// threshold and its own, its version the next), checking each against the production rules (cfg.Production) before
// anything is written. It is the only fetch of roots in a refresh.
// The newest root the rules accept goes into the cache (atomically); a refused root ends the walk with its error, and
// the cache keeps the last accepted one, so the next refresh fetches that version again.
func walkRoots(cfg Config, trusted []byte, cachedRoot string) ([]byte, error) {
	tm, err := trustedmetadata.New(trusted)
	if err != nil {
		return nil, classify(err)
	}
	base := cfg.MetadataURL
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	cur := trusted
	var refused error
	start := tm.Root.Signed.Version
	for v := start + 1; v <= start+maxRootRotations; v++ {
		data, err := cfg.Fetcher.DownloadFile(fmt.Sprintf("%s%d.root.json", base, v), maxRootBytes, 0)
		if err != nil {
			var h *metadata.ErrDownloadHTTP
			if errors.As(err, &h) && h.StatusCode == http.StatusNotFound {
				break
			}
			refused = classify(err)
			break
		}
		next, err := tm.UpdateRoot(data)
		if err != nil {
			refused = classify(err)
			break
		}
		if cfg.Production {
			if err := CheckProductionRoot(next); err != nil {
				refused = err
				break
			}
			if err := CheckRootThreshold(cfg.PinnedRoot, next); err != nil {
				refused = err
				break
			}
		}
		cur = data
	}
	if !bytes.Equal(cur, trusted) {
		if err := atomicfile.WriteFile(cachedRoot, cur, 0o644); err != nil {
			return nil, errors.Join(refused, err)
		}
	}
	if refused != nil {
		return nil, refused
	}
	return cur, nil
}

// maxRootRotations and maxRootBytes are go-tuf's defaults (config.New), which the walk keeps to.
const (
	maxRootRotations = 256
	maxRootBytes     = 512000
)

func chooseRoot(pinned []byte, cachedPath string) ([]byte, error) {
	pv, perr := rootVersion(pinned)
	cached, rerr := os.ReadFile(cachedPath)
	if rerr == nil {
		if cv, err := rootVersion(cached); err == nil && (perr != nil || cv >= pv) {
			return cached, nil
		}
	}
	if perr != nil {
		return nil, fmt.Errorf("%w: pinned root: %v", ErrInvalidMetadata, perr)
	}
	return pinned, nil
}

func rootVersion(b []byte) (int64, error) {
	if len(b) == 0 {
		return 0, errors.New("empty root")
	}
	r, err := metadata.Root().FromBytes(b)
	if err != nil {
		return 0, err
	}
	// Self-signature threshold must hold for a root to be a usable trust anchor.
	if err := r.VerifyDelegate(metadata.ROOT, r); err != nil {
		return 0, err
	}
	return r.Signed.Version, nil
}

// dropCorruptCache removes cached metadata that no longer parses (e.g. a torn write after power loss); go-tuf would
// otherwise fail every refresh. Valid-but-old files are kept: they provide rollback protection. A delegated role's
// file (the channels, clients) is of type targets.
func dropCorruptCache(dir string) {
	for role, typ := range map[string]string{metadata.TIMESTAMP: metadata.TIMESTAMP, metadata.SNAPSHOT: metadata.SNAPSHOT,
		metadata.TARGETS: metadata.TARGETS, ChannelProduction: metadata.TARGETS, ChannelDevelopment: metadata.TARGETS,
		ClientsRole: metadata.TARGETS} {
		p := filepath.Join(dir, role+".json")
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var probe struct {
			Signed struct {
				Type string `json:"_type"`
			} `json:"signed"`
		}
		if json.Unmarshal(b, &probe) != nil || probe.Signed.Type != typ {
			_ = os.Remove(p)
		}
	}
}

func syncCache(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".json") {
			_ = atomicfile.SyncFile(filepath.Join(dir, e.Name()))
		}
	}
	_ = atomicfile.SyncDir(dir)
}

func classify(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, &metadata.ErrExpiredMetadata{}):
		return fmt.Errorf("%w: %v", ErrExpired, err)
	case errors.Is(err, &metadata.ErrBadVersionNumber{}), errors.Is(err, &metadata.ErrEqualVersionNumber{}):
		return fmt.Errorf("%w: %v", ErrRollback, err)
	case errors.Is(err, &metadata.ErrUnsignedMetadata{}):
		return fmt.Errorf("%w: %v", ErrSignature, err)
	case errors.Is(err, &metadata.ErrDownloadHTTP{}), errors.Is(err, &metadata.ErrDownload{}):
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	case errors.Is(err, &metadata.ErrLengthOrHashMismatch{}), errors.Is(err, &metadata.ErrDownloadLengthMismatch{}):
		return fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	default:
		var ne interface{ Timeout() bool }
		if errors.As(err, &ne) {
			return fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		return fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
}

// Target returns the verified target info for a path.
func (r *Repo) Target(path string) (*metadata.TargetFiles, bool) {
	t, ok := r.targets[path]
	return t, ok
}

// ReleaseIDs lists the approved release ids.
func (r *Repo) ReleaseIDs() []string {
	var ids []string
	for p := range r.targets {
		if id, ok := strings.CutPrefix(p, ReleaseTargetPrefix); ok {
			if id, ok = strings.CutSuffix(id, ".json"); ok && ValidReleaseID(id) {
				ids = append(ids, id)
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// Artifact is a verified artifact target, a closure index target (Index set) or a blob of an index (Meta.Kind
// KindNarBlob, not a TUF target: verified through the index).
type Artifact struct {
	Target string            `json:"target"`
	Length int64             `json:"length"`
	Hashes map[string]string `json:"hashes"` // algorithm -> lowercase hex
	Meta   ArtifactMeta      `json:"meta"`
	// Index is the custom metadata of a closure-index target (Meta then carries the component with ClosureSize 0).
	Index *IndexMeta `json:"index,omitempty"`
	// Remote is where the file lives under the targets base when that isn't the consistent-snapshot name of Target
	// (LNK-24): a channel release's index in the GitHub release of its id, a version-2 index's blob in its bucket.
	Remote string `json:"remote,omitempty"`
}

// SHA256 returns the hex SHA-256 of the artifact (its content address in staging).
func (a Artifact) SHA256() string { return a.Hashes["sha256"] }

// Release is a verified, compatible approved tuple (the @whombat/release ReleaseTuple) with the closure indexes that
// deliver its components (UP-X14): HostIndex, RuntimeIndex and ProviderIndexes (in the tuple's providers' order).
// Releases carry closure indexes only (UP-X23): a component without one is not approved.
type Release struct {
	Tuple           release.ReleaseTuple `json:"tuple"`
	Digest          string               `json:"digest"`
	HostIndex       *Artifact            `json:"hostIndex,omitempty"`
	RuntimeIndex    *Artifact            `json:"runtimeIndex,omitempty"`
	ProviderIndexes []*Artifact          `json:"providerIndexes,omitempty"`
	// AllowDowngradeFrom: releases from which moving to this tuple is allowed although it is older
	// (TUF-signed custom metadata; see CheckForward).
	AllowDowngradeFrom []string `json:"allowDowngradeFrom,omitempty"`
}

// ID returns the release id.
func (r *Release) ID() string { return r.Tuple.ReleaseID }

// Indexes are the closure indexes an activation stages, in import order: host (host=true only), runtime, providers.
// Each index's Meta.StorePath is its component's root store path.
func (r *Release) Indexes(host bool) []Artifact {
	var out []Artifact
	if host && r.HostIndex != nil {
		out = append(out, *r.HostIndex)
	}
	if r.RuntimeIndex != nil {
		out = append(out, *r.RuntimeIndex)
	}
	for _, ix := range r.ProviderIndexes {
		if ix != nil {
			out = append(out, *ix)
		}
	}
	return out
}

// RuntimeArtifacts are the TUF targets of the runtime and providers (their closure indexes).
func (r *Release) RuntimeArtifacts() []Artifact { return r.Indexes(false) }

// Artifacts are all TUF targets of the tuple (its closure indexes), host first.
func (r *Release) Artifacts() []Artifact { return r.Indexes(true) }

// Release resolves, validates and compatibility-checks an approved tuple: the target
// releases/<id>.json carries the tuple in its custom metadata, its content is the tuple's canonical
// JSON (so the TUF-signed target hash is the tuple digest), and every component resolves to a
// closure-index target with the same store path, NAR hash and version.
func (r *Repo) Release(id string) (*Release, error) {
	if !ValidReleaseID(id) {
		return nil, fmt.Errorf("%w: bad release id", ErrInvalidMetadata)
	}
	tf, ok := r.targets[ReleaseTarget(id)]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotApproved, id)
	}
	raw, kind, err := whombatCustom(tf.Custom)
	if err != nil || kind != KindReleaseTuple {
		return nil, fmt.Errorf("%w: release %s custom metadata: %v", ErrInvalidMetadata, id, err)
	}
	var tc tupleCustom
	if err := strictUnmarshal(raw, &tc); err != nil {
		return nil, fmt.Errorf("%w: release %s: %v", ErrInvalidMetadata, id, err)
	}
	t, err := release.ParseReleaseTuple(tc.Tuple)
	if err != nil {
		return nil, fmt.Errorf("%w: release %s tuple: %v", ErrInvalidMetadata, id, err)
	}
	if t.ReleaseID != id {
		return nil, fmt.Errorf("%w: tuple id %q under target %q", ErrInvalidMetadata, t.ReleaseID, id)
	}
	canon, err := canonjson.Marshal(t)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	if err := tf.VerifyLengthHashes(canon); err != nil {
		return nil, fmt.Errorf("%w: tuple custom metadata does not match target hash: %v", ErrInvalidMetadata, err)
	}
	digest, err := release.TupleDigest(t)
	if err != nil || digest != "sha256:"+hex.EncodeToString(tf.Hashes["sha256"]) {
		return nil, fmt.Errorf("%w: tuple digest %s does not match target", ErrInvalidMetadata, digest)
	}
	for _, from := range tc.AllowDowngradeFrom {
		if !ValidReleaseID(from) {
			return nil, fmt.Errorf("%w: release %s: bad allowDowngradeFrom %q", ErrInvalidMetadata, id, from)
		}
	}
	rel := &Release{Tuple: *t, Digest: digest, AllowDowngradeFrom: tc.AllowDowngradeFrom}
	if rel.HostIndex, err = r.resolve(KindHostGeneration, t.Host.StorePath, t.Host.NarHash, t.Host.Version, "", t.Manager.StorePath); err != nil {
		return nil, err
	}
	if rel.RuntimeIndex, err = r.resolve(KindRuntimeBundle, t.Runtime.StorePath, t.Runtime.NarHash, t.Runtime.Version, "", ""); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, p := range t.Providers {
		if seen[p.Provider] {
			return nil, fmt.Errorf("%w: provider %q", ErrInvalidMetadata, p.Provider)
		}
		seen[p.Provider] = true
		ix, err := r.resolve(KindProviderBundle, p.StorePath, p.NarHash, p.Version, p.Provider, "")
		if err != nil {
			return nil, err
		}
		rel.ProviderIndexes = append(rel.ProviderIndexes, ix)
	}
	if err := CheckCompat(t); err != nil {
		return nil, err
	}
	if r.Channel != "" {
		releaseRemote(id, rel.HostIndex)
		releaseRemote(id, rel.RuntimeIndex)
		for _, ix := range rel.ProviderIndexes {
			releaseRemote(id, ix)
		}
	}
	return rel, nil
}

// CheckCompat verifies the tuple-internal compatibility with the contract's release.CheckActivation
// (CT-35) evaluated on the tuple itself at the schema it writes: the runtime's host ABI range
// contains the host ABI and the runtime reads the schema it writes. Checks against the installed
// tuple and the live database happen in the manager (CheckActivation with the real values).
func CheckCompat(t *release.ReleaseTuple) error {
	if c := release.CheckActivation(t, t, t.Runtime.SchemaWrites); !c.OK {
		return fmt.Errorf("%w: runtime %s / host %s: %s", ErrIncompatible, t.Runtime.Version, t.Host.Version, strings.Join(c.Reasons, ", "))
	}
	return nil
}

// resolve finds a component's closure index (else ErrNotApproved) with the tuple's store path, NAR hash and version,
// the provider name of a provider bundle and the manager of a host generation.
func (r *Repo) resolve(want Kind, storePath, narHash, version, provider, manager string) (*Artifact, error) {
	ix, err := r.index(want, storePath, narHash, version)
	if err != nil {
		return nil, err
	}
	if want == KindHostGeneration && ix.Index.ManagerStorePath != manager {
		return nil, fmt.Errorf("%w: host generation index %s does not name manager %s", ErrInvalidMetadata, storePath, manager)
	}
	if want == KindProviderBundle && ix.Index.Provider != provider {
		return nil, fmt.Errorf("%w: provider index %q", ErrInvalidMetadata, provider)
	}
	return ix, nil
}

// targetHashes converts a target's hashes (sha256 required, sha512 allowed).
func targetHashes(path string, tf *metadata.TargetFiles) (map[string]string, error) {
	hashes := map[string]string{}
	for alg, h := range tf.Hashes {
		if alg != "sha256" && alg != "sha512" {
			return nil, fmt.Errorf("%w: %s: unsupported hash %s", ErrInvalidMetadata, path, alg)
		}
		hashes[alg] = hex.EncodeToString(h)
	}
	if len(hashes["sha256"]) != 64 || tf.Length <= 0 {
		return nil, fmt.Errorf("%w: %s needs a sha256 hash and a length", ErrInvalidMetadata, path)
	}
	return hashes, nil
}

// index finds the closure-index target of a component.
func (r *Repo) index(of Kind, storePath, narHash, version string) (*Artifact, error) {
	paths := make([]string, 0, len(r.targets))
	for p := range r.targets {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		tf := r.targets[path]
		raw, kind, err := whombatCustom(tf.Custom)
		if err != nil || kind != KindClosureIndex {
			continue
		}
		var m IndexMeta
		if err := strictUnmarshal(raw, &m); err != nil {
			continue
		}
		if m.Of != of || m.StorePath != storePath {
			continue
		}
		if err := m.Validate(); err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrInvalidMetadata, path, err)
		}
		if m.NarHash != narHash || m.Version != version {
			return nil, fmt.Errorf("%w: %s narHash/version differ from the tuple", ErrInvalidMetadata, path)
		}
		if !ValidTargetPath(path) {
			return nil, fmt.Errorf("%w: bad index target path %q", ErrInvalidMetadata, path)
		}
		if tf.Length > MaxIndexBytes {
			return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrInvalidMetadata, path, MaxIndexBytes)
		}
		hashes, err := targetHashes(path, tf)
		if err != nil {
			return nil, err
		}
		mm := m
		return &Artifact{Target: path, Length: tf.Length, Hashes: hashes, Meta: m.ArtifactMeta(), Index: &mm}, nil
	}
	return nil, fmt.Errorf("%w: no %s index for %s", ErrNotApproved, of, storePath)
}
