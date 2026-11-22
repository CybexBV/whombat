package trust

import (
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

// Update channels (Whombat LNK-20…LNK-23, UP-X29): every box takes the newest release of its channel. A channel is a
// delegated targets role of the same name that the top-level targets delegate by path prefix: its release tuples and
// closure indexes sit under `<channel>/`, so a channel's key can approve nothing outside it. Promotion lists the
// identical target (same bytes, same hashes) under `production/`.
const (
	ChannelProduction  = string(release.UpdateChannelProduction)
	ChannelDevelopment = string(release.UpdateChannelDevelopment)
	// DefaultChannel is the channel of a box nobody moved (LNK-21).
	DefaultChannel = release.DefaultUpdateChannel
	// ChannelPausedKey is the boolean key under CustomKey in a channel role's signed TUF metadata.
	ChannelPausedKey = "paused"
)

// SetChannelPaused sets or clears the pause marker in a channel role's signed TUF metadata.
// Clearing removes the custom key when empty so unpaused channel metadata stays identical to before.
func SetChannelPaused(md *metadata.Metadata[metadata.TargetsType], paused bool) {
	if md == nil {
		return
	}
	var whombat map[string]any
	if md.Signed.UnrecognizedFields != nil {
		if existing, ok := md.Signed.UnrecognizedFields[CustomKey].(map[string]any); ok {
			whombat = existing
		}
	}
	if paused {
		if md.Signed.UnrecognizedFields == nil {
			md.Signed.UnrecognizedFields = map[string]any{}
		}
		if whombat == nil {
			whombat = map[string]any{}
		}
		whombat[ChannelPausedKey] = true
		md.Signed.UnrecognizedFields[CustomKey] = whombat
		return
	}
	if whombat == nil {
		return
	}
	delete(whombat, ChannelPausedKey)
	if len(whombat) == 0 {
		delete(md.Signed.UnrecognizedFields, CustomKey)
		if len(md.Signed.UnrecognizedFields) == 0 {
			md.Signed.UnrecognizedFields = nil
		}
	}
}

// IsChannelPaused reports whether a verified channel role carries the pause marker in its signed metadata.
func IsChannelPaused(md *metadata.Metadata[metadata.TargetsType]) (bool, error) {
	if md == nil || len(md.Signed.UnrecognizedFields) == 0 {
		return false, nil
	}
	raw, ok := md.Signed.UnrecognizedFields[CustomKey]
	if !ok || raw == nil {
		return false, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return false, fmt.Errorf("%w: channel %s metadata is not an object", ErrInvalidMetadata, CustomKey)
	}
	v, ok := obj[ChannelPausedKey]
	if !ok || v == nil {
		return false, nil
	}
	paused, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("%w: channel %s.%s is not a boolean", ErrInvalidMetadata, CustomKey, ChannelPausedKey)
	}
	return paused, nil
}

// Channels are the update channels, in the order a person reads them.
var Channels = []string{ChannelProduction, ChannelDevelopment}

// ValidChannel reports whether c names an update channel.
func ValidChannel(c string) bool { return c == ChannelProduction || c == ChannelDevelopment }

// ChannelRolePaths are a channel role's delegation patterns. go-tuf matches them segment by segment, so each target
// shape the role signs needs one: the tuple, the host and runtime indexes, the provider indexes.
func ChannelRolePaths(channel string) []string {
	return []string{channel + "/releases/*", channel + "/host/*/*", channel + "/runtime/*/*", channel + "/provider/*/*/*"}
}

// ChannelTarget is the TUF target path of a top-level-shaped target (releases/<id>.json, an index path) in a channel.
func ChannelTarget(channel, target string) string { return channel + "/" + target }

// ErrChannelUnavailable: the repository has no role for the box's channel, or it could not be verified.
var ErrChannelUnavailable = errors.New("update channel unavailable")

// channelProbe is a path inside a channel role's delegation: looking it up makes go-tuf load and verify the role (the
// target itself need not exist).
func channelProbe(channel string) string {
	return ChannelTarget(channel, ReleaseTargetPrefix+"probe.json")
}

// loadChannel resolves a channel role through the top-level delegation and returns its targets with the channel prefix
// taken off (releases/<id>.json, runtime/…), so the release logic reads them as it reads the top-level targets. Only
// paths the delegation grants and that sit under the prefix count.
func loadChannel(up *updater.Updater, channel string) (map[string]*metadata.TargetFiles, *metadata.Metadata[metadata.TargetsType], error) {
	if !ValidChannel(channel) {
		return nil, nil, fmt.Errorf("%w: unknown channel %q", ErrInvalidMetadata, channel)
	}
	_, probeErr := up.GetTargetInfo(channelProbe(channel))
	set := up.GetTrustedMetadataSet()
	md := set.Targets[channel]
	top := set.Targets[metadata.TARGETS]
	if md == nil || top == nil || top.Signed.Delegations == nil {
		if probeErr != nil && !strings.Contains(probeErr.Error(), "not found") {
			return nil, nil, fmt.Errorf("%w: %s: %w", ErrChannelUnavailable, channel, classify(probeErr))
		}
		return nil, nil, fmt.Errorf("%w: the repository delegates no %s role", ErrChannelUnavailable, channel)
	}
	var role *metadata.DelegatedRole
	for i := range top.Signed.Delegations.Roles {
		if top.Signed.Delegations.Roles[i].Name == channel {
			role = &top.Signed.Delegations.Roles[i]
		}
	}
	if role == nil {
		return nil, nil, fmt.Errorf("%w: the repository delegates no %s role", ErrChannelUnavailable, channel)
	}
	out := map[string]*metadata.TargetFiles{}
	prefix := channel + "/"
	for p, tf := range md.Signed.Targets {
		rel, ok := strings.CutPrefix(p, prefix)
		if !ok {
			continue
		}
		if granted, err := role.IsDelegatedPath(p); err != nil || !granted {
			continue
		}
		out[rel] = tf
	}
	return out, md, nil
}

// RemoteName is the file name of a target in a GitHub release (Whombat LNK-24): the consistent-snapshot name
// <sha256>.<base>, flat, because a release's assets have no directories.
func RemoteName(targetPath, sha256hex string) string { return sha256hex + "." + path.Base(targetPath) }

// releaseRemote is where a channel release's target lives under the targets base: in the GitHub release named after
// the release id, which the publisher fills with the tuple and every index of the tuple (an index shared with an
// older release is uploaded again: it is small, and each release then stands on its own).
func releaseRemote(id string, a *Artifact) {
	if a != nil {
		a.Remote = id + "/" + RemoteName(a.Target, a.SHA256())
	}
}

// BlobBucket is the GitHub release that holds a blob (Whombat LNK-24): `nar-` and the first two hex digits of the
// blob file's sha256, so the 256 buckets share the load and no release gets near GitHub's asset limit soon.
func BlobBucket(fileHashHex string) string { return "nar-" + fileHashHex[:2] }

// ChannelOf returns the channel whose prefix a TUF target path carries ("" for a top-level target).
func ChannelOf(targetPath string) string {
	for _, c := range Channels {
		if strings.HasPrefix(targetPath, c+"/") {
			return c
		}
	}
	return ""
}
