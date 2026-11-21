package devtuf

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// Reading a published repository read-only (`tufrepo check-newer`, MG-44): the metadata chain from a trusted root
// (root rotations, timestamp → snapshot → targets with the versions, lengths and hashes each names, every role's
// signature threshold) and the approved releases it signs, without keys, locks or a TUF client cache. An expired role
// fails when the caller asks for a fresh repository (a published one, MG-50: a device would refuse it too) and is
// reported otherwise (a repository on this machine, re-signed when something is published).

// MetadataSource reads a repository's metadata files by name ("timestamp.json", "4.snapshot.json"); a missing file is
// os.ErrNotExist.
type MetadataSource interface {
	ReadMetadata(name string, maxBytes int64) ([]byte, error)
	// Describe names the source for messages.
	Describe() string
}

// DirMetadata reads <dir>/metadata/<name> (a repository on this machine).
type DirMetadata string

// ReadMetadata implements MetadataSource.
func (d DirMetadata) ReadMetadata(name string, maxBytes int64) ([]byte, error) {
	if name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		return nil, fmt.Errorf("bad metadata name %q", name)
	}
	f, err := os.Open(filepath.Join(string(d), "metadata", name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readLimited(f, name, maxBytes)
}

// Describe implements MetadataSource.
func (d DirMetadata) Describe() string { return filepath.Join(string(d), "metadata") }

// HTTPMetadata reads <base>/<name> over HTTP(S) (a published repository, e.g. https://updates.whombat.com/metadata/).
type HTTPMetadata struct {
	BaseURL string
	Client  *http.Client
}

// ReadMetadata implements MetadataSource.
func (h HTTPMetadata) ReadMetadata(name string, maxBytes int64) ([]byte, error) {
	c := h.Client
	if c == nil {
		c = &http.Client{Timeout: time.Minute}
	}
	resp, err := c.Get(strings.TrimSuffix(h.BaseURL, "/") + "/" + name)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%s: HTTP %d: %w", name, resp.StatusCode, os.ErrNotExist)
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%s: HTTP %d", name, resp.StatusCode)
	}
	return readLimited(resp.Body, name, maxBytes)
}

// Describe implements MetadataSource.
func (h HTTPMetadata) Describe() string { return strings.TrimSuffix(h.BaseURL, "/") + "/" }

func readLimited(r io.Reader, name string, maxBytes int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxBytes {
		return nil, fmt.Errorf("%s is larger than %d bytes", name, maxBytes)
	}
	return b, nil
}

// Size limits of the metadata files read.
const (
	maxRootBytes      = 512 << 10
	maxTimestampBytes = 64 << 10
	maxSnapshotBytes  = 4 << 20
	maxTargetsBytes   = 64 << 20
	maxRootRotations  = 1024
)

// PublishedView is a verified reading of a published repository.
type PublishedView struct {
	Source string `json:"source"`
	// Verified says in plain words what was checked; NotVerified what wasn't.
	Verified    []string         `json:"verified"`
	NotVerified []string         `json:"notVerified,omitempty"`
	Versions    map[string]int64 `json:"versions"`
	Warnings    []string         `json:"warnings"`
	Releases    []ReleaseSummary `json:"releases"`
}

// VerifyPublished reads the repository from src and verifies its metadata chain against trustedRoot (a root.json;
// nil: the repository's own 1.root.json, trusted on first use, which proves the metadata consistent but not the
// repository genuine). production refuses a root that trusts a development key (L-4); requireFresh refuses expired
// metadata (ErrExpired).
func VerifyPublished(src MetadataSource, trustedRoot []byte, production, requireFresh bool, now time.Time) (*PublishedView, error) {
	return VerifyPublishedIn(src, trustedRoot, production, requireFresh, now, "")
}

// VerifyPublishedIn is VerifyPublished with the releases of a channel role (LNK-23: development or production, signed
// by the top-level targets' delegation to it, at the version the snapshot names) instead of the top level's: what a
// publish into that channel is checked against (`check-newer --channel`, ONE-04). "" is the top level.
func VerifyPublishedIn(src MetadataSource, trustedRoot []byte, production, requireFresh bool, now time.Time, channel string) (*PublishedView, error) {
	if channel != "" && !trust.ValidChannel(channel) {
		return nil, fmt.Errorf("unknown channel %q (%v)", channel, trust.Channels)
	}
	v := &PublishedView{Source: src.Describe(), Versions: map[string]int64{}, Warnings: []string{}}
	anchor := "the given trusted root"
	if trustedRoot == nil {
		b, err := src.ReadMetadata("1.root.json", maxRootBytes)
		if err != nil {
			return nil, fmt.Errorf("the repository's 1.root.json: %w", err)
		}
		trustedRoot, anchor = b, "the repository's own 1.root.json"
		v.NotVerified = append(v.NotVerified, "that this is the genuine repository: its own first root was trusted as found (pass --root with the pinned root, e.g. manifest/prod/tuf-root.json)")
	}
	root, err := metadata.Root().FromBytes(trustedRoot)
	if err != nil {
		return nil, fmt.Errorf("trusted root: %w", err)
	}
	if err := root.VerifyDelegate(metadata.ROOT, root); err != nil {
		return nil, fmt.Errorf("trusted root is not signed by its own keys: %w", err)
	}
	first := root.Signed.Version
	for i := 0; i < maxRootRotations; i++ {
		name := fmt.Sprintf("%d.root.json", root.Signed.Version+1)
		b, err := src.ReadMetadata(name, maxRootBytes)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return nil, err
		}
		next, err := metadata.Root().FromBytes(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if next.Signed.Version != root.Signed.Version+1 {
			return nil, fmt.Errorf("%s says version %d", name, next.Signed.Version)
		}
		if err := root.VerifyDelegate(metadata.ROOT, next); err != nil {
			return nil, fmt.Errorf("%s is not signed by root v%d: %w", name, root.Signed.Version, err)
		}
		if err := next.VerifyDelegate(metadata.ROOT, next); err != nil {
			return nil, fmt.Errorf("%s is not signed by its own keys: %w", name, err)
		}
		root = next
	}
	if production {
		if err := trust.CheckProductionRoot(root); err != nil {
			return nil, err
		}
	}
	v.Versions[metadata.ROOT] = root.Signed.Version
	v.Verified = append(v.Verified, fmt.Sprintf("root v%d, reached from %s (v%d) through %d rotation(s), each signed by the root before it and by itself",
		root.Signed.Version, anchor, first, root.Signed.Version-first))

	b, err := src.ReadMetadata("timestamp.json", maxTimestampBytes)
	if err != nil {
		return nil, fmt.Errorf("timestamp.json: %w", err)
	}
	ts, err := metadata.Timestamp().FromBytes(b)
	if err != nil {
		return nil, fmt.Errorf("timestamp.json: %w", err)
	}
	if err := root.VerifyDelegate(metadata.TIMESTAMP, ts); err != nil {
		return nil, fmt.Errorf("timestamp.json is not signed by the root's timestamp keys: %w", err)
	}
	sm, ok := ts.Signed.Meta["snapshot.json"]
	if !ok {
		return nil, errors.New("timestamp.json names no snapshot")
	}
	name := fmt.Sprintf("%d.snapshot.json", sm.Version)
	if b, err = src.ReadMetadata(name, maxSnapshotBytes); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if err := sm.VerifyLengthHashes(b); err != nil {
		return nil, fmt.Errorf("%s doesn't match the length and hashes the timestamp names: %w", name, err)
	}
	snap, err := metadata.Snapshot().FromBytes(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if err := root.VerifyDelegate(metadata.SNAPSHOT, snap); err != nil {
		return nil, fmt.Errorf("%s is not signed by the root's snapshot keys: %w", name, err)
	}
	if snap.Signed.Version != sm.Version {
		return nil, fmt.Errorf("%s says version %d", name, snap.Signed.Version)
	}
	tm, ok := snap.Signed.Meta["targets.json"]
	if !ok {
		return nil, fmt.Errorf("%s names no targets", name)
	}
	tname := fmt.Sprintf("%d.targets.json", tm.Version)
	if b, err = src.ReadMetadata(tname, maxTargetsBytes); err != nil {
		return nil, fmt.Errorf("%s: %w", tname, err)
	}
	if err := tm.VerifyLengthHashes(b); err != nil {
		return nil, fmt.Errorf("%s doesn't match what the snapshot names: %w", tname, err)
	}
	targets, err := metadata.Targets().FromBytes(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", tname, err)
	}
	if err := root.VerifyDelegate(metadata.TARGETS, targets); err != nil {
		return nil, fmt.Errorf("%s is not signed by the root's targets keys: %w", tname, err)
	}
	if targets.Signed.Version != tm.Version {
		return nil, fmt.Errorf("%s says version %d", tname, targets.Signed.Version)
	}
	v.Versions[metadata.TIMESTAMP], v.Versions[metadata.SNAPSHOT], v.Versions[metadata.TARGETS] =
		ts.Signed.Version, snap.Signed.Version, targets.Signed.Version
	v.Verified = append(v.Verified,
		fmt.Sprintf("timestamp v%d, signed by the root's timestamp keys", ts.Signed.Version),
		fmt.Sprintf("snapshot v%d, the version, length and hashes the timestamp names, signed by the snapshot keys", snap.Signed.Version),
		fmt.Sprintf("targets v%d, the version the snapshot names%s, signed by the targets keys: the release tuples below are what it approves",
			targets.Signed.Version, map[bool]string{true: " with its length and hashes", false: ""}[tm.Length > 0 || len(tm.Hashes) > 0]))
	for _, e := range []struct {
		role string
		at   time.Time
	}{{metadata.ROOT, root.Signed.Expires}, {metadata.TIMESTAMP, ts.Signed.Expires}, {metadata.SNAPSHOT, snap.Signed.Expires},
		{metadata.TARGETS, targets.Signed.Expires}} {
		if !e.at.After(now) {
			msg := fmt.Sprintf(statusExpiredFormat+" (devices refuse the repository until it is re-signed)", e.role, e.at.UTC().Format(time.RFC3339))
			if requireFresh {
				return nil, fmt.Errorf("%w: %s", trust.ErrExpired, msg)
			}
			v.Warnings = append(v.Warnings, msg)
		}
	}
	if channel == "" {
		if v.Releases, err = releaseSummaries(targets.Signed.Targets); err != nil {
			return nil, err
		}
		return v, nil
	}
	cm, ok := snap.Signed.Meta[channel+".json"]
	if !ok {
		return nil, fmt.Errorf("the snapshot names no %s role", channel)
	}
	cname := fmt.Sprintf("%d.%s.json", cm.Version, channel)
	if b, err = src.ReadMetadata(cname, maxTargetsBytes); err != nil {
		return nil, fmt.Errorf("%s: %w", cname, err)
	}
	role, err := metadata.Targets().FromBytes(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", cname, err)
	}
	if err := targets.VerifyDelegate(channel, role); err != nil {
		return nil, fmt.Errorf("%s is not signed by the key the top-level targets delegate %s to: %w", cname, channel, err)
	}
	if role.Signed.Version != cm.Version {
		return nil, fmt.Errorf("%s says version %d", cname, role.Signed.Version)
	}
	if !role.Signed.Expires.After(now) {
		msg := fmt.Sprintf(statusExpiredFormat+" (devices refuse the channel until it is re-signed)", channel, role.Signed.Expires.UTC().Format(time.RFC3339))
		if requireFresh {
			return nil, fmt.Errorf("%w: %s", trust.ErrExpired, msg)
		}
		v.Warnings = append(v.Warnings, msg)
	}
	v.Versions[channel] = role.Signed.Version
	v.Verified = append(v.Verified, fmt.Sprintf("%s v%d, the version the snapshot names, signed by its delegated key: its release tuples are what it approves", channel, role.Signed.Version))
	view := map[string]*metadata.TargetFiles{}
	for p, tf := range role.Signed.Targets {
		if rel, ok := strings.CutPrefix(p, channel+"/"); ok {
			view[rel] = tf
		}
	}
	if v.Releases, err = releaseSummaries(view); err != nil {
		return nil, err
	}
	return v, nil
}
