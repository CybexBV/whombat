package devtuf

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// Update channels in the repository (Whombat LNK-23, UP-X29): the top-level targets delegate `development` and
// `production` by path prefix (trust.ChannelRolePaths); a channel's tuples and closure indexes are its role's targets
// under `<channel>/`. Promotion lists the identical targets (same bytes, same hashes) in `production`.

// LayoutGitHub is Options.Layout of the GitHub repository (LNK-24): metadata on Pages, files as release assets.
const LayoutGitHub = "github"

// Lifetimes of the GitHub repository's roles (LNK-25). The development role is online and re-signed with every
// publish; production, top targets and root are offline; snapshot and timestamp are the workflow's.
const (
	GitHubTargetsExpiry     = 365 * 24 * time.Hour
	ProductionRoleExpiry    = 120 * 24 * time.Hour
	DevelopmentRoleExpiry   = 90 * 24 * time.Hour
	GitHubSnapshotExpiry    = 3 * 24 * time.Hour
	GitHubTimestampExpiry   = 3 * 24 * time.Hour
	GitHubRootExpiry        = 365 * 24 * time.Hour
	defaultChannelThreshold = 1
)

// ChannelExpiry is how long a channel role version stays valid.
func ChannelExpiry(channel string) time.Duration {
	if channel == trust.ChannelProduction {
		return ProductionRoleExpiry
	}
	return DevelopmentRoleExpiry
}

// GitHub reports whether this is the GitHub repository's layout (Options.Layout).
func (r *Repo) GitHub() bool { return r.opts.Layout == LayoutGitHub }

func (o *Options) githubExpiries() {
	o.TargetsExp, o.SnapshotExp, o.TimestampEx, o.RootExpiry = GitHubTargetsExpiry, GitHubSnapshotExpiry, GitHubTimestampExpiry, GitHubRootExpiry
}

// destPath is a target path in the destination of target changes (the channel's prefix in front, InChannel).
func (r *Repo) destPath(p string) string {
	if r.dest == "" || strings.HasPrefix(p, r.dest+"/") {
		return p
	}
	return trust.ChannelTarget(r.dest, p)
}

// destTargets is the target map changes go to.
func (r *Repo) destTargets() map[string]*metadata.TargetFiles {
	if r.dest == "" {
		return r.targets.Signed.Targets
	}
	return r.channels[r.dest].Signed.Targets
}

// destView is the destination's targets as the release logic reads them: a channel's without its prefix.
func (r *Repo) destView() map[string]*metadata.TargetFiles {
	if r.dest == "" {
		return r.targets.Signed.Targets
	}
	out := map[string]*metadata.TargetFiles{}
	for p, tf := range r.channels[r.dest].Signed.Targets {
		if rel, ok := strings.CutPrefix(p, r.dest+"/"); ok {
			out[rel] = tf
		}
	}
	return out
}

// indexVersion is the closure-index version this repository writes: version 2 (blobs in the GitHub bucket
// releases) for a channel of the GitHub layout, version 1 otherwise.
func (r *Repo) indexVersion() int {
	if r.dest != "" && r.GitHub() {
		return trust.IndexV2
	}
	return trust.IndexV1
}

func (r *Repo) newerOptions(allow []string) NewerOptions {
	return NewerOptions{Production: r.prod() && r.dest == "", Community: r.Community(), AllowDowngradeFrom: allow, Channel: r.dest != ""}
}

// InChannel makes the following target changes (AddRelease, AddFakeRelease, PublishRelease, RemoveTarget, Publish)
// go to a channel role ("" the top-level targets again).
func (r *Repo) InChannel(channel string) error {
	if channel != "" {
		if _, ok := r.channels[channel]; !ok {
			return fmt.Errorf("devtuf: no %s role (tufrepo add-channels)", channel)
		}
	}
	r.dest = channel
	return nil
}

// Channel is the destination InChannel set.
func (r *Repo) Channel() string { return r.dest }

// HasChannel reports whether the top-level targets delegate the channel.
func (r *Repo) HasChannel(channel string) bool { _, ok := r.channels[channel]; return ok }

// delegate adds (or replaces, by name) a delegated role and its key in the top-level targets.
func (r *Repo) delegate(key *metadata.Key, id string, role metadata.DelegatedRole) {
	d := r.targets.Signed.Delegations
	if d == nil {
		d = &metadata.Delegations{Keys: map[string]*metadata.Key{}}
		r.targets.Signed.Delegations = d
	}
	if d.Keys == nil {
		d.Keys = map[string]*metadata.Key{}
	}
	d.Keys[id] = key
	for i := range d.Roles {
		if d.Roles[i].Name == role.Name {
			d.Roles[i] = role
			return
		}
	}
	d.Roles = append(d.Roles, role)
}

// delegatedRole returns a delegated role of the top-level targets by name.
func (r *Repo) delegatedRole(name string) (metadata.DelegatedRole, bool) {
	if r.targets.Signed.Delegations == nil {
		return metadata.DelegatedRole{}, false
	}
	for _, dr := range r.targets.Signed.Delegations.Roles {
		if dr.Name == name {
			return dr, true
		}
	}
	return metadata.DelegatedRole{}, false
}

// loadChannels reads the channel roles the snapshot lists.
func (r *Repo) loadChannels() error {
	r.channels = map[string]*metadata.Metadata[metadata.TargetsType]{}
	for _, c := range trust.Channels {
		cm, ok := r.snapshot.Signed.Meta[c+".json"]
		if !ok {
			continue
		}
		md, err := metadata.Targets().FromFile(filepath.Join(r.metaDir(), fmt.Sprintf("%d.%s.json", cm.Version, c)))
		if err != nil {
			return err
		}
		r.channels[c] = md
	}
	return nil
}

// AddChannelRoles delegates each channel without a role yet to a new role held by its key (keys[channel]; a missing
// or nil key: a fresh development key kept with the repository's keys), signs an empty version 1 of it and
// republishes the top-level targets (with the top-level targets key) and snapshot and timestamp (when held).
// The development key is online (whombat-ops on the build server), the production key offline (LNK-25): keep[channel] false
// (with keep non-nil) for a key the repository must not keep (it signs version 1 and is forgotten).
func (r *Repo) AddChannelRoles(keys map[string]ed25519.PrivateKey, keep map[string]bool) error {
	if r.channels == nil {
		r.channels = map[string]*metadata.Metadata[metadata.TargetsType]{}
	}
	if len(r.keys[metadata.TARGETS]) == 0 {
		return errors.New("devtuf: adding channel roles needs the top-level targets key")
	}
	now := r.opts.Now().UTC()
	added := 0
	for _, c := range trust.Channels {
		if _, ok := r.channels[c]; ok {
			continue
		}
		priv := keys[c]
		if priv == nil {
			priv = newKey()
		}
		key, err := metadata.KeyFromPublicKey(priv.Public())
		if err != nil {
			return err
		}
		id, err := key.ID()
		if err != nil {
			return err
		}
		r.delegate(key, id, metadata.DelegatedRole{Name: c, KeyIDs: []string{id}, Threshold: defaultChannelThreshold,
			Terminating: true, Paths: trust.ChannelRolePaths(c)})
		md := metadata.Targets(now.Add(ChannelExpiry(c)))
		md.Signed.Version = 0
		r.channels[c] = md
		if keep == nil || keep[c] {
			r.keys[c] = []ed25519.PrivateKey{priv}
		}
		if err := r.signChannel(c, priv); err != nil {
			return err
		}
		added++
	}
	if added == 0 {
		return nil
	}
	if err := r.saveKeys(); err != nil {
		return err
	}
	dest := r.dest
	r.dest = ""
	defer func() { r.dest = dest }()
	return r.Publish()
}

// ChannelKey returns a channel role's private key when the repository holds it.
func (r *Repo) ChannelKey(channel string) ed25519.PrivateKey {
	if ks := r.keys[channel]; len(ks) > 0 {
		return ks[0]
	}
	return nil
}

// resolveChannelKey checks that key (or the repository's own key when nil) is authorized for channel.
func (r *Repo) resolveChannelKey(channel string, key ed25519.PrivateKey) (ed25519.PrivateKey, error) {
	if key == nil {
		key = r.ChannelKey(channel)
	}
	if key == nil {
		return nil, fmt.Errorf("devtuf: no %s key (it is offline: pass it with --key-file)", channel)
	}
	role, ok := r.delegatedRole(channel)
	pk, _ := metadata.KeyFromPublicKey(key.Public())
	id, _ := pk.ID()
	if !ok || !containsString(role.KeyIDs, id) {
		return nil, fmt.Errorf("devtuf: this key does not hold the %s role", channel)
	}
	return key, nil
}

// signChannel bumps, signs and writes a channel role (N.<channel>.json). Production's lifetime starts again with
// every version; development's too (it is signed with every publish).
func (r *Repo) signChannel(channel string, key ed25519.PrivateKey) error {
	md := r.channels[channel]
	k, err := r.resolveChannelKey(channel, key)
	if err != nil {
		return err
	}
	md.Signed.Version++
	md.Signed.Expires = r.opts.Now().UTC().Add(ChannelExpiry(channel))
	md.ClearSignatures()
	if _, err := md.Sign(signer(k)); err != nil {
		return err
	}
	return writeJSON(filepath.Join(r.metaDir(), fmt.Sprintf("%d.%s.json", md.Signed.Version, channel)), md)
}

// ChannelPauseScopeNote states which boxes a channel pause holds.
const ChannelPauseScopeNote = "This pause only holds boxes already running a pause-aware release; older boxes keep updating."

// ChannelPauseResult reports the channel role version written by PauseChannel or ResumeChannel.
type ChannelPauseResult struct {
	Channel string `json:"channel"`
	Paused  bool   `json:"paused"`
	Version int64  `json:"version"`
	Already bool   `json:"already,omitempty"`
	Note    string `json:"note,omitempty"`
}

// ChannelPaused reports whether the channel role carries the pause marker.
func (r *Repo) ChannelPaused(channel string) bool {
	md, ok := r.channels[channel]
	if !ok {
		return false
	}
	paused, _ := trust.IsChannelPaused(md)
	return paused
}

// PauseChannel signs the pause marker into channel's own role metadata so boxes stop taking new releases from it.
// Listed releases stay in place so rollbacks keep working and boxes never downgrade.
func (r *Repo) PauseChannel(channel string, key ed25519.PrivateKey) (*ChannelPauseResult, error) {
	return r.setChannelPaused(channel, true, key)
}

// ResumeChannel clears the pause marker from channel's own role metadata so boxes resume taking releases from it.
func (r *Repo) ResumeChannel(channel string, key ed25519.PrivateKey) (*ChannelPauseResult, error) {
	return r.setChannelPaused(channel, false, key)
}

func (r *Repo) setChannelPaused(channel string, paused bool, key ed25519.PrivateKey) (*ChannelPauseResult, error) {
	if !trust.ValidChannel(channel) {
		return nil, fmt.Errorf("devtuf: unknown channel %q", channel)
	}
	md, ok := r.channels[channel]
	if !ok {
		return nil, fmt.Errorf("devtuf: no %s role (tufrepo add-channels)", channel)
	}
	k, err := r.resolveChannelKey(channel, key)
	if err != nil {
		return nil, err
	}
	note := ""
	if paused {
		note = ChannelPauseScopeNote
	}
	cur, err := trust.IsChannelPaused(md)
	if err == nil && cur == paused {
		return &ChannelPauseResult{Channel: channel, Paused: paused, Version: md.Signed.Version, Already: true, Note: note}, nil
	}
	trust.SetChannelPaused(md, paused)
	if err := r.PublishChannelWith(channel, k); err != nil {
		trust.SetChannelPaused(md, cur)
		return nil, err
	}
	return &ChannelPauseResult{Channel: channel, Paused: paused, Version: md.Signed.Version, Note: note}, nil
}

// publishChannel serves the channel's releases at their GitHub paths too, signs the role with keysOverride (an offline
// key given on the command line) or the repository's key, then snapshot and timestamp when held.
func (r *Repo) publishChannel(channel string) error {
	if err := r.linkReleaseFiles(channel); err != nil {
		return err
	}
	k := r.keysOverride
	if err := r.signChannel(channel, k); err != nil {
		return err
	}
	return r.PublishSnapshot()
}

// PublishChannelWith signs a new version of the channel role with key (nil: the repository's), then snapshot and
// timestamp when held. Offline roles (production) are signed this way.
func (r *Repo) PublishChannelWith(channel string, key ed25519.PrivateKey) error {
	if _, ok := r.channels[channel]; !ok {
		return fmt.Errorf("devtuf: no %s role", channel)
	}
	r.keysOverride = key
	defer func() { r.keysOverride = nil }()
	return r.publishChannel(channel)
}

// ChannelReleases lists a channel's approved releases with their versions.
func (r *Repo) ChannelReleases(channel string) ([]ReleaseSummary, error) {
	dest := r.dest
	defer func() { r.dest = dest }()
	if err := r.InChannel(channel); err != nil {
		return nil, err
	}
	return r.PublishedReleases()
}

// ChannelTargets lists a channel role's targets (full TUF paths) with their sha256 and length.
func (r *Repo) ChannelTargets(channel string) map[string]TargetInfo {
	out := map[string]TargetInfo{}
	md, ok := r.channels[channel]
	if !ok {
		return out
	}
	for p, tf := range md.Signed.Targets {
		out[p] = TargetInfo{SHA256: hex.EncodeToString(tf.Hashes["sha256"]), Length: tf.Length}
	}
	return out
}

// TargetInfo is a target's hash and length.
type TargetInfo struct {
	SHA256 string `json:"sha256"`
	Length int64  `json:"length"`
}

// PromoteResult says what Promote listed.
type PromoteResult struct {
	ReleaseID string   `json:"releaseId"`
	From      string   `json:"from"`
	To        string   `json:"to"`
	Targets   []string `json:"targets"`
	Already   bool     `json:"already,omitempty"`
}

// Promote lists a release of one channel in another (LNK-22): the tuple target and the closure indexes its components
// resolve to, identical (same bytes, same hashes, same custom metadata) under the other channel's prefix; nothing is
// rebuilt or uploaded again (the files' names on GitHub carry no channel). The release must be newer than what the
// destination lists (CheckNewer, as a publish). The destination role is signed with key (nil: the repository's;
// production's is offline), then snapshot and timestamp when held.
func (r *Repo) Promote(id, from, to string, key ed25519.PrivateKey) (*PromoteResult, error) {
	if from == to || !trust.ValidChannel(from) || !trust.ValidChannel(to) {
		return nil, fmt.Errorf("devtuf: promote from %q to %q", from, to)
	}
	src, ok := r.channels[from]
	dst, ok2 := r.channels[to]
	if !ok || !ok2 {
		return nil, errors.New("devtuf: the repository lacks a channel role (tufrepo add-channels)")
	}
	if key == nil && r.ChannelKey(to) == nil {
		return nil, fmt.Errorf("devtuf: no %s key (it is offline: pass it with --key-file)", to)
	}
	res := &PromoteResult{ReleaseID: id, From: from, To: to}
	tupleTarget := trust.ChannelTarget(from, trust.ReleaseTarget(id))
	tf, ok := src.Signed.Targets[tupleTarget]
	if !ok {
		return nil, fmt.Errorf("devtuf: %s lists no release %s", from, id)
	}
	if old, ok := dst.Signed.Targets[trust.ChannelTarget(to, trust.ReleaseTarget(id))]; ok {
		if hex.EncodeToString(old.Hashes["sha256"]) != hex.EncodeToString(tf.Hashes["sha256"]) {
			return nil, fmt.Errorf("devtuf: %s lists %s with a different tuple", to, id)
		}
		res.Already = true
		return res, nil
	}
	// What the release resolves to, read as a box reads it (the channel view).
	dest := r.dest
	defer func() { r.dest = dest }()
	r.dest = from
	summaries, err := releaseSummaries(map[string]*metadata.TargetFiles{trust.ReleaseTarget(id): tf})
	if err != nil || len(summaries) != 1 {
		return nil, fmt.Errorf("devtuf: %s: %v", tupleTarget, err)
	}
	t, err := tupleOf(tf)
	if err != nil {
		return nil, err
	}
	paths := []string{tupleTarget}
	for _, c := range tupleComponents(t) {
		ip, ok := r.findIndex(c)
		if !ok {
			return nil, fmt.Errorf("devtuf: %s lists no index for %s %s", from, c.kind, c.version)
		}
		paths = append(paths, trust.ChannelTarget(from, ip))
	}
	r.dest = to
	published, err := r.PublishedReleases()
	if err != nil {
		return nil, err
	}
	allow := summaries[0].AllowDowngradeFrom
	if _, err := CheckNewer(published, summaries[0], NewerOptions{Channel: true, AllowDowngradeFrom: filterPublished(allow, published)}); err != nil {
		return nil, err
	}
	for _, p := range paths {
		rel := strings.TrimPrefix(p, from+"/")
		np := trust.ChannelTarget(to, rel)
		if old, ok := dst.Signed.Targets[np]; ok && hex.EncodeToString(old.Hashes["sha256"]) != hex.EncodeToString(src.Signed.Targets[p].Hashes["sha256"]) {
			return nil, fmt.Errorf("devtuf: %s is listed with different bytes", np)
		}
		cp := *src.Signed.Targets[p]
		cp.Path = np
		dst.Signed.Targets[np] = &cp
		// The one-server layout serves the file under its own path too (same bytes).
		if err := r.linkTargetFile(p, np, hex.EncodeToString(cp.Hashes["sha256"])); err != nil {
			return nil, err
		}
		res.Targets = append(res.Targets, np)
	}
	sort.Strings(res.Targets)
	r.dest = ""
	if err := r.PublishChannelWith(to, key); err != nil {
		return nil, err
	}
	return res, nil
}

// filterPublished keeps the ids of allow that the destination lists (a permission names releases devices there run).
func filterPublished(allow []string, published []ReleaseSummary) []string {
	var out []string
	for _, a := range allow {
		for _, p := range published {
			if p.ID == a {
				out = append(out, a)
			}
		}
	}
	return out
}

func (r *Repo) linkTargetFile(from, to, sha string) error {
	src := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(from, sha)))
	dst := filepath.Join(r.targetsDir(), filepath.FromSlash(consistentName(to, sha)))
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if _, err := os.Stat(src); err != nil {
		return nil // nothing to serve here (GitHub serves it by its channel-free name)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return linkOrCopy(src, dst)
}

// tupleOf reads the tuple from a release target's custom metadata.
func tupleOf(tf *metadata.TargetFiles) (*release.ReleaseTuple, error) {
	if tf.Custom == nil {
		return nil, errors.New("devtuf: a release target without custom metadata")
	}
	var c struct {
		Whombat struct {
			Tuple json.RawMessage `json:"tuple"`
		} `json:"whombat"`
	}
	if err := json.Unmarshal(*tf.Custom, &c); err != nil {
		return nil, err
	}
	return release.ParseReleaseTuple(c.Whombat.Tuple)
}

func containsString(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// MoveChannelTargetUnchecked renames a target inside a channel role without any delegation check. Tests only: it lets
// a test sign a path outside the role's prefix with the role's key to prove that devices ignore it.
func (r *Repo) MoveChannelTargetUnchecked(channel, from, to string) error {
	md, ok := r.channels[channel]
	if !ok {
		return fmt.Errorf("devtuf: no %s role", channel)
	}
	tf, ok := md.Signed.Targets[from]
	if !ok {
		return fmt.Errorf("devtuf: %s lists no %s", channel, from)
	}
	delete(md.Signed.Targets, from)
	cp := *tf
	cp.Path = to
	md.Signed.Targets[to] = &cp
	return nil
}
