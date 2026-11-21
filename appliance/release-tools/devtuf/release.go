package devtuf

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Real releases (MG-41, UP-X14, UP-X23). A release directory holds, per component, a closure listing with the
// compressed NAR of every path, and release.json:
//
//	release.json   {"v":2, "releaseId", "tuple": ReleaseTuple, "indexes": [{"target", "file", "meta": trust.IndexMeta}]}
//	host.paths.json, runtime.paths.json, provider-<name>.paths.json                (listings: the index without blob fields)
//	nar/<narhex>.nar.zst                                                           (blobs, hard links into the NAR cache)
//	SHA256SUMS     (sha256sum -c format, every other top-level file; not nar/: an upload may leave out blobs the
//	               repository has)
//
// ExportRelease writes one from built store paths; PublishRelease verifies it again from the bytes (closure sizes,
// completeness, the manager inside the host closure, the tuple's compatibility; every new blob by decompressing it)
// and signs it into the repository. Releases carry closure indexes only: the `nix-store --export` streams of whole
// closures (MG-09) went with the managers before 0.3.0 that needed them (UP-X23, HE-52).

// ReleaseManifestFile is the name of the manifest in a release directory.
const ReleaseManifestFile = "release.json"

// ReleaseManifestVersion is release.json's version.
const ReleaseManifestVersion = 2

// ReleaseManifest is release.json.
type ReleaseManifest struct {
	V         int                  `json:"v"`
	ReleaseID string               `json:"releaseId"`
	Tuple     release.ReleaseTuple `json:"tuple"`
	// Indexes are the closure listings to publish as closure-index targets.
	Indexes []ReleaseIndex `json:"indexes"`
}

// ReleaseIndex is one closure index of a release directory: the listing file (<component>.paths.json) and the
// metadata of its target (Paths and DownloadSize are recomputed when it is published).
type ReleaseIndex struct {
	Target string          `json:"target"`
	File   string          `json:"file"`
	Meta   trust.IndexMeta `json:"meta"`
}

var fileNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)

// ExportOptions select what ExportRelease writes.
type ExportOptions struct {
	// ReuseHost leaves the host artifact and index out: they must already be published in the repository (same store
	// path and NAR hash), and the template must carry host.narHash and manager.narHash (a runtime-only release).
	ReuseHost bool
	// Paths reads the store (NixPaths on a build machine).
	Paths PathSource
	// NarCache holds the compressed NARs across releases (DefaultNarCache).
	NarCache string
	// Workers compress in parallel (0: min(CPUs, 8)).
	Workers int
	// Log receives progress lines (nil: none).
	Log func(format string, a ...any)
}

type countWriter struct{ n int64 }

func (c *countWriter) Write(p []byte) (int, error) { c.n += int64(len(p)); return len(p), nil }

// checkTuple validates the tuple (schema, compatibility with itself, MG-09).
func checkTuple(t *release.ReleaseTuple) error {
	if err := t.Validate(); err != nil {
		return err
	}
	if c := release.CheckActivation(t, t, t.Runtime.SchemaWrites); !c.OK {
		return fmt.Errorf("release tuple is not compatible with itself: %s", strings.Join(c.Reasons, ", "))
	}
	return nil
}

// component is one tuple component that needs an artifact.
type component struct {
	kind      trust.Kind
	version   string
	storePath string
	narHash   string
	provider  string
}

func tupleComponents(t *release.ReleaseTuple) []component {
	cs := []component{
		{kind: trust.KindHostGeneration, version: t.Host.Version, storePath: t.Host.StorePath, narHash: t.Host.NarHash},
		{kind: trust.KindRuntimeBundle, version: t.Runtime.Version, storePath: t.Runtime.StorePath, narHash: t.Runtime.NarHash},
	}
	for _, p := range t.Providers {
		cs = append(cs, component{kind: trust.KindProviderBundle, version: p.Version, storePath: p.StorePath, narHash: p.NarHash, provider: p.Provider})
	}
	return cs
}

// ExportRelease writes a release directory to out from a tuple template: a ReleaseTuple whose narHash fields may
// be empty (they are computed from the store; a given one must match). Every component's closure is listed; the
// manager's NAR hash comes from the host closure (it must be in it).
func ExportRelease(ctx context.Context, out string, template []byte, o ExportOptions) (*ReleaseManifest, error) {
	if o.Paths == nil || o.NarCache == "" {
		return nil, errors.New("closure indexes need a path source and a NAR cache")
	}
	var t release.ReleaseTuple
	dec := json.NewDecoder(bytes.NewReader(template))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("tuple template: %w", err)
	}
	if !trust.ValidReleaseID(t.ReleaseID) {
		return nil, fmt.Errorf("bad release id %q", t.ReleaseID)
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return nil, err
	}
	if entries, _ := os.ReadDir(out); len(entries) > 0 {
		return nil, fmt.Errorf("%s is not empty", out)
	}
	m := &ReleaseManifest{V: ReleaseManifestVersion, ReleaseID: t.ReleaseID, Indexes: []ReleaseIndex{}}
	fill := func(field *string, got, what string) error {
		if *field != "" && *field != got {
			return fmt.Errorf("%s: the template says %s, the store has %s", what, *field, got)
		}
		*field = got
		return nil
	}
	if o.ReuseHost && (t.Host.NarHash == "" || t.Manager.NarHash == "") {
		return nil, errors.New("--reuse-host needs host.narHash and manager.narHash in the template (copy them from the release that published the host)")
	}
	if err := exportIndexes(ctx, out, &t, m, o, fill); err != nil {
		return nil, err
	}
	if err := checkTuple(&t); err != nil {
		return nil, err
	}
	m.Tuple = t
	b, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(out, ReleaseManifestFile), append(b, '\n'), 0o644); err != nil {
		return nil, err
	}
	return m, writeSums(out)
}

func writeSums(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var b strings.Builder
	for _, e := range entries {
		if e.Name() == "SHA256SUMS" || !e.Type().IsRegular() {
			continue
		}
		f, err := os.Open(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "%s  %s\n", hex.EncodeToString(h.Sum(nil)), e.Name())
	}
	return os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(b.String()), 0o644)
}

// ReadReleaseManifest reads and checks release.json (strict JSON, the tuple valid and self-compatible, every
// index's target, file name and metadata well-formed and matching a tuple component).
func ReadReleaseManifest(dir string) (*ReleaseManifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, ReleaseManifestFile))
	if err != nil {
		return nil, err
	}
	var m ReleaseManifest
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("%s: %w", ReleaseManifestFile, err)
	}
	if m.V != ReleaseManifestVersion {
		return nil, fmt.Errorf("%s: unsupported version %d", ReleaseManifestFile, m.V)
	}
	if m.ReleaseID != m.Tuple.ReleaseID {
		return nil, fmt.Errorf("%s: releaseId %q but the tuple is %q", ReleaseManifestFile, m.ReleaseID, m.Tuple.ReleaseID)
	}
	if err := checkTuple(&m.Tuple); err != nil {
		return nil, err
	}
	comps := tupleComponents(&m.Tuple)
	seenFile, seenTarget := map[string]bool{}, map[string]bool{}
	for _, ix := range m.Indexes {
		if !fileNameRe.MatchString(ix.File) || ix.File == ReleaseManifestFile || ix.File == "SHA256SUMS" || seenFile[ix.File] {
			return nil, fmt.Errorf("bad or repeated index file name %q", ix.File)
		}
		if !trust.ValidTargetPath(ix.Target) || seenTarget[ix.Target] {
			return nil, fmt.Errorf("bad or repeated target path %q", ix.Target)
		}
		seenFile[ix.File], seenTarget[ix.Target] = true, true
		if err := ix.Meta.Validate(); err != nil {
			return nil, fmt.Errorf("%s: %w", ix.Target, err)
		}
		found := false
		for _, c := range comps {
			found = found || c.matchesIndex(ix.Meta)
		}
		if !found {
			return nil, fmt.Errorf("%s: no tuple component with this kind, version, store path and narHash", ix.Target)
		}
		if ix.Meta.Of == trust.KindHostGeneration && ix.Meta.ManagerStorePath != m.Tuple.Manager.StorePath {
			return nil, fmt.Errorf("%s: managerStorePath %s is not the tuple's manager %s", ix.Target, ix.Meta.ManagerStorePath, m.Tuple.Manager.StorePath)
		}
	}
	return &m, nil
}

// PublishResult reports what PublishRelease did.
type PublishResult struct {
	ReleaseID   string   `json:"releaseId"`
	TupleDigest string   `json:"tupleDigest"`
	Added       []string `json:"added"`
	Reused      []string `json:"reused"`
	// AlreadyPublished: the identical tuple was approved before; nothing changed.
	AlreadyPublished bool `json:"alreadyPublished"`
	// Ordering: the newest published release of the id family it was checked against (MG-44).
	Ordering Ordering `json:"ordering"`
	// AllowDowngradeFrom: the custody rollback's TUF-signed permission it was published with (MA-21c).
	AllowDowngradeFrom []string `json:"allowDowngradeFrom,omitempty"`
	// Blobs of the closure indexes (UP-X14): written now (verified by decompressing), already in the repository, and
	// the bytes written.
	BlobsAdded  int   `json:"blobsAdded"`
	BlobsReused int   `json:"blobsReused"`
	BytesAdded  int64 `json:"bytesAdded"`
}

// PublishOptions are PublishRelease's options.
type PublishOptions struct {
	// AllowDowngradeFrom makes the release a custody rollback: devices on these releases may move back to it
	// (TUF-signed, trust.CheckForward), and the ordering check (CheckNewer) accepts lower component versions.
	AllowDowngradeFrom []string
}

// PublishRelease verifies a release directory from its bytes and approves it: every listing is checked against its
// metadata and the tuple, every blob the repository lacks is verified by decompressing it and written, the indexes are
// signed; the tuple becomes releases/<id>.json and targets, snapshot and timestamp are published. A component without
// an index in the directory must already be published in the repository. Publishing the identical release again changes nothing; a different tuple (or another
// allowDowngradeFrom) under a published id, or different bytes under a published target path, is refused. Nothing
// older than the published releases of the id family is signed unless it is a custody rollback, and a production
// repository signs whombat-YYYYMMDD.N ids only (CheckNewer, MG-44, MG-50, PI-23); that check runs before any file is copied.
func (r *Repo) PublishRelease(dir string, o PublishOptions) (*PublishResult, error) {
	m, err := ReadReleaseManifest(dir)
	if err != nil {
		return nil, err
	}
	canon, err := canonjson.Marshal(m.Tuple)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canon)
	res := &PublishResult{ReleaseID: m.ReleaseID, TupleDigest: "sha256:" + hex.EncodeToString(sum[:]), Added: []string{}, Reused: []string{},
		AllowDowngradeFrom: o.AllowDowngradeFrom}
	if tf, ok := r.destTargets()[r.destPath(trust.ReleaseTarget(m.ReleaseID))]; ok {
		if hex.EncodeToString(tf.Hashes["sha256"]) != hex.EncodeToString(sum[:]) {
			return nil, fmt.Errorf("release %s is published with a different tuple; use a new release id", m.ReleaseID)
		}
		published, err := r.PublishedReleases()
		if err != nil {
			return nil, err
		}
		for _, p := range published {
			if p.ID == m.ReleaseID && !slices.Equal(p.AllowDowngradeFrom, o.AllowDowngradeFrom) {
				return nil, fmt.Errorf("release %s is published with allowDowngradeFrom %v, not %v; another permission needs a new release id",
					m.ReleaseID, p.AllowDowngradeFrom, o.AllowDowngradeFrom)
			}
		}
		res.AlreadyPublished = true
		return res, nil
	}
	published, err := r.PublishedReleases()
	if err != nil {
		return nil, err
	}
	if res.Ordering, err = CheckNewer(published, SummaryOf(&m.Tuple), r.newerOptions(o.AllowDowngradeFrom)); err != nil {
		return nil, err
	}
	// Every component: an index here, or one already in the repository.
	for _, c := range tupleComponents(&m.Tuple) {
		here := false
		for _, ix := range m.Indexes {
			here = here || c.matchesIndex(ix.Meta)
		}
		if here {
			continue
		}
		ip, ok := r.findIndex(c)
		if !ok {
			return nil, fmt.Errorf("no index for %s %s (%s) in the release directory or the repository", c.kind, c.version, c.storePath)
		}
		res.Reused = append(res.Reused, ip)
	}
	// Indexes: listings checked, blobs reused or verified and written (content-addressed: harmless if a later check
	// fails), index contents prepared, then their targets signed.
	idx, err := r.prepareIndexes(dir, m, res)
	if err != nil {
		return nil, err
	}
	for _, p := range idx {
		added, err := r.putIndex(p.ix.Target, p.ci, p.ix.Meta)
		if err != nil {
			return nil, err
		}
		if added {
			res.Added = append(res.Added, p.ix.Target)
		} else {
			res.Reused = append(res.Reused, p.ix.Target)
		}
	}
	if err := r.AddReleaseAllowingDowngrade(m.Tuple, o.AllowDowngradeFrom...); err != nil {
		return nil, err
	}
	return res, r.Publish()
}
