// Package trust is the release-authorization core shared by whombat-manager and
// whombat-update-helper: TUF metadata refresh (go-tuf/v2), approved release tuples carried as TUF
// target custom metadata, control-signed update assignments and artifact verification.
//
// This package is part of the update helper's trusted computing base (MG-03): the helper runs it
// independently of the manager on its own metadata cache, so a compromised manager cannot make the
// helper activate anything the release keys did not approve and control did not assign.
package trust

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// CustomKey is the key under a TUF target's `custom` object that carries Whombat metadata.
const CustomKey = "whombat"

// Kind classifies TUF targets.
type Kind string

const (
	KindReleaseTuple     Kind = "release-tuple"
	KindRuntimeBundle    Kind = "runtime-bundle"
	KindProviderBundle   Kind = "provider-bundle"
	KindHostGeneration   Kind = "host-generation"
	KindAssignmentKeys   Kind = "assignment-keys"
	ArtifactFormatNix         = "nix-export" // `nix-store --export` stream of the closure
	ReleaseTargetPrefix       = "releases/"
	AssignmentKeysTarget      = "control/assignment-keys.json"
)

var (
	// Release ids follow @whombat/release ReleaseId.
	releaseIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,79}$`)
	targetPathRe = regexp.MustCompile(`^(host|runtime|provider)(/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}){1,6}$`)
	storePathRe  = regexp.MustCompile(`^/nix/store/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]{1,180}$`)
	versionRe    = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`)
)

// ValidReleaseID reports whether id is a syntactically valid release id.
func ValidReleaseID(id string) bool { return releaseIDRe.MatchString(id) }

// ValidStorePath reports whether p is a syntactically valid Nix store path.
func ValidStorePath(p string) bool { return storePathRe.MatchString(p) }

// ArtifactMeta is the custom metadata of a runtime bundle, provider bundle or host generation target.
// Tuple components (release.ReleaseTuple) are linked to artifact targets by store path and NAR hash.
type ArtifactMeta struct {
	Kind      Kind   `json:"kind"`
	Version   string `json:"version"`
	Format    string `json:"format"`
	StorePath string `json:"storePath"`
	NarHash   string `json:"narHash"`
	// ClosureSize is the unpacked closure size in bytes, used for capacity planning.
	ClosureSize int64 `json:"closureSize,omitempty"`
	// Host generations: the whombat-manager store path the generation contains (tuple.manager).
	ManagerStorePath string `json:"managerStorePath,omitempty"`
	// Provider bundles: the provider name (tuple.providers[].provider).
	Provider string `json:"provider,omitempty"`
}

var (
	digestRe   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	providerRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
)

// ValidProviderName reports whether n is a valid provider name.
func ValidProviderName(n string) bool { return providerRe.MatchString(n) }

// Validate checks the metadata.
func (m ArtifactMeta) Validate() error {
	if !versionRe.MatchString(m.Version) {
		return fmt.Errorf("bad version %q", m.Version)
	}
	if m.Format != ArtifactFormatNix {
		return fmt.Errorf("unsupported artifact format %q", m.Format)
	}
	if !storePathRe.MatchString(m.StorePath) {
		return fmt.Errorf("bad store path %q", m.StorePath)
	}
	if !digestRe.MatchString(m.NarHash) {
		return fmt.Errorf("bad narHash %q", m.NarHash)
	}
	if m.ClosureSize < 0 {
		return errors.New("negative closure size")
	}
	switch m.Kind {
	case KindHostGeneration:
		if !storePathRe.MatchString(m.ManagerStorePath) {
			return errors.New("host generation without managerStorePath")
		}
	case KindRuntimeBundle:
	case KindProviderBundle:
		if !providerRe.MatchString(m.Provider) {
			return errors.New("provider bundle without a valid provider name")
		}
	default:
		return fmt.Errorf("kind %q is not an artifact", m.Kind)
	}
	return nil
}

// ValidTargetPath reports whether p is an acceptable artifact target path (no traversal).
func ValidTargetPath(p string) bool {
	if !targetPathRe.MatchString(p) {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." || strings.HasPrefix(seg, "..") {
			return false
		}
	}
	return true
}

// ReleaseTarget returns the TUF target path of a release tuple.
func ReleaseTarget(id string) string { return ReleaseTargetPrefix + id + ".json" }

// customEnvelope is the shape of a target's custom metadata.
type customEnvelope struct {
	Whombat json.RawMessage `json:"whombat"`
}

type kindOnly struct {
	Kind Kind `json:"kind"`
}

type tupleCustom struct {
	Kind  Kind            `json:"kind"`
	Tuple json.RawMessage `json:"tuple"`
	// AllowDowngradeFrom lists the releases from which a device may move to this (older) tuple: release
	// custody's explicit, TUF-signed permission for a downgrade (MA-21c). Absent: forward only.
	AllowDowngradeFrom []string `json:"allowDowngradeFrom,omitempty"`
}

// assignmentKeysCustom is the custom metadata of control/assignment-keys.json: the contract
// AssignmentKeys document (release custody authorizes control's online keys by publishing it).
type assignmentKeysCustom struct {
	Kind     Kind            `json:"kind"`
	Document json.RawMessage `json:"document"`
}

func strictUnmarshal(data []byte, v any) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func whombatCustom(raw *json.RawMessage) (json.RawMessage, Kind, error) {
	if raw == nil {
		return nil, "", errors.New("target has no custom metadata")
	}
	var env customEnvelope
	if err := json.Unmarshal(*raw, &env); err != nil {
		return nil, "", fmt.Errorf("custom metadata: %w", err)
	}
	if len(env.Whombat) == 0 {
		return nil, "", errors.New("target has no whombat custom metadata")
	}
	var k kindOnly
	if err := json.Unmarshal(env.Whombat, &k); err != nil {
		return nil, "", fmt.Errorf("custom metadata: %w", err)
	}
	return env.Whombat, k.Kind, nil
}
