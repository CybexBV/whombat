package trust_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/klauspost/compress/zstd"
)

func sha(b []byte) string { s := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(s[:]) }

// testIndex is a three-path closure: lib <- mgr <- root (host generation).
func testIndex() (*trust.ClosureIndex, trust.IndexMeta) {
	lib, mgr, root := devtuf.FakeStorePath("lib"), devtuf.FakeStorePath("whombat-manager"), devtuf.FakeStorePath("nixos-system")
	p := func(sp string, refs ...string) trust.IndexPath {
		return trust.IndexPath{StorePath: sp, NarHash: sha([]byte(sp)), NarSize: int64(len(sp)), References: append([]string{}, refs...),
			FileSize: 10, FileHash: sha([]byte("blob " + sp))}
	}
	ci := &trust.ClosureIndex{V: 1, Of: trust.KindHostGeneration, StorePath: root, NarHash: sha([]byte(root)), Compression: "zstd",
		Paths: []trust.IndexPath{p(lib, lib), p(mgr, lib), p(root, lib, mgr, root)}}
	var size int64
	for _, x := range ci.Paths {
		size += x.NarSize
	}
	return ci, trust.IndexMeta{Kind: trust.KindClosureIndex, Of: trust.KindHostGeneration, Version: "26.05.1", StorePath: root,
		NarHash: ci.NarHash, ClosureSize: size, ManagerStorePath: mgr, Paths: 3, DownloadSize: 30}
}

func indexArtifact(t *testing.T, b []byte, m trust.IndexMeta) trust.Artifact {
	t.Helper()
	sum := sha256.Sum256(b)
	return trust.Artifact{Target: "host/26.05.1/whombat-host.index.json", Length: int64(len(b)), Hashes: map[string]string{"sha256": hex.EncodeToString(sum[:])},
		Meta: m.ArtifactMeta(), Index: &m}
}

func TestParseClosureIndex(t *testing.T) {
	ci, m := testIndex()
	b, err := canonjson.Marshal(ci)
	if err != nil {
		t.Fatal(err)
	}
	got, err := trust.ParseClosureIndex(b, indexArtifact(t, b, m))
	if err != nil {
		t.Fatal(err)
	}
	blob := got.Blob(2)
	if blob.Target != "nar/"+strings.TrimPrefix(ci.NarHash, "sha256:")+".nar.zst" || blob.Length != 10 || blob.Meta.ClosureSize != ci.Paths[2].NarSize ||
		blob.SHA256() != strings.TrimPrefix(ci.Paths[2].FileHash, "sha256:") {
		t.Fatalf("blob %+v", blob)
	}
	if blob.Remote != "" {
		t.Fatalf("a version-1 blob has a remote %q", blob.Remote)
	}
	// Version 2 (LNK-24): the same index, its blobs in the GitHub bucket releases nar-<xx>/.
	civ2, m2 := testIndex()
	civ2.V = trust.IndexV2
	b2, _ := canonjson.Marshal(civ2)
	got2, err := trust.ParseClosureIndex(b2, indexArtifact(t, b2, m2))
	if err != nil {
		t.Fatal(err)
	}
	fileHex := strings.TrimPrefix(ci.Paths[2].FileHash, "sha256:")
	if want := "nar-" + fileHex[:2] + "/" + trust.BlobFileName(fileHex, ci.Paths[2].NarHash); got2.Blob(2).Remote != want {
		t.Fatalf("v2 blob remote %q, want %q", got2.Blob(2).Remote, want)
	}
	// Bytes that are not the target's.
	if _, err := trust.ParseClosureIndex(append(b, ' '), indexArtifact(t, b, m)); !errors.Is(err, trust.ErrArtifact) {
		t.Fatalf("tampered: %v", err)
	}
	bad := map[string]func(ci *trust.ClosureIndex, m *trust.IndexMeta){
		"wrong order":        func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0], ci.Paths[1] = ci.Paths[1], ci.Paths[0] },
		"incomplete closure": func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths = ci.Paths[1:] },
		"wrong root hash":    func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[2].NarHash = sha([]byte("x")) },
		"root of another":    func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.StorePath = ci.Paths[1].StorePath },
		"duplicate": func(ci *trust.ClosureIndex, _ *trust.IndexMeta) {
			ci.Paths = append(ci.Paths[:2], ci.Paths[1], ci.Paths[2])
		},
		"path outside the closure": func(ci *trust.ClosureIndex, _ *trust.IndexMeta) {
			extra := devtuf.FakeStorePath("stray")
			ci.Paths = append([]trust.IndexPath{{StorePath: extra, NarHash: sha([]byte(extra)), NarSize: 1, References: []string{}, FileSize: 1,
				FileHash: sha(nil)}}, ci.Paths...)
		},
		"closure size": func(_ *trust.ClosureIndex, m *trust.IndexMeta) { m.ClosureSize++ },
		"no manager": func(_ *trust.ClosureIndex, m *trust.IndexMeta) {
			m.ManagerStorePath = devtuf.FakeStorePath("other-manager")
		},
		"compression":       func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Compression = "xz" },
		"unknown version":   func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.V = 3 },
		"no file size":      func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].FileSize = 0 },
		"bad file hash":     func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].FileHash = "md5:x" },
		"bad store path":    func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].StorePath = "/tmp/x" },
		"bad deriver":       func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].Deriver = "../x.drv" },
		"negative nar size": func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].NarSize = -1 },
		"of another kind":   func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Of = trust.KindRuntimeBundle },
		"nil references":    func(ci *trust.ClosureIndex, _ *trust.IndexMeta) { ci.Paths[0].References = nil },
		"reference twice": func(ci *trust.ClosureIndex, _ *trust.IndexMeta) {
			ci.Paths[1].References = append(ci.Paths[1].References, ci.Paths[0].StorePath)
		},
		"unknown root target": func(_ *trust.ClosureIndex, m *trust.IndexMeta) { m.NarHash = sha([]byte("other")) },
	}
	for name, change := range bad {
		ci, m := testIndex()
		change(ci, &m)
		b, _ := canonjson.Marshal(ci)
		if _, err := trust.ParseClosureIndex(b, indexArtifact(t, b, m)); !errors.Is(err, trust.ErrInvalidMetadata) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Malformed JSON and unknown fields.
	for name, raw := range map[string]string{"not json": "{", "unknown field": `{"v":1,"extra":true}`, "trailing": `{"v":1} {}`} {
		if _, err := trust.ParseClosureIndex([]byte(raw), indexArtifact(t, []byte(raw), m)); !errors.Is(err, trust.ErrInvalidMetadata) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Oversized: a target longer than the bound, and more paths than allowed.
	big := indexArtifact(t, b, m)
	big.Length = trust.MaxIndexBytes + 1
	if _, err := trust.ParseClosureIndex(b, big); !errors.Is(err, trust.ErrInvalidMetadata) {
		t.Fatalf("oversized target: %v", err)
	}
	many := make([]trust.IndexPath, trust.MaxIndexPaths+1)
	if _, err := trust.CheckClosure(many, ci.StorePath, ci.NarHash, true); err == nil || !strings.Contains(err.Error(), "paths") {
		t.Fatalf("too many paths: %v", err)
	}
	// Not an index artifact.
	if _, err := trust.ParseClosureIndex(b, trust.Artifact{Target: "x"}); !errors.Is(err, trust.ErrInvalidMetadata) {
		t.Fatalf("legacy artifact: %v", err)
	}
	// A listing (release directory) has no blob fields; an index needs them.
	ci2, _ := testIndex()
	for i := range ci2.Paths {
		ci2.Paths[i].FileSize, ci2.Paths[i].FileHash = 0, ""
	}
	if _, err := trust.CheckClosure(ci2.Paths, ci2.StorePath, ci2.NarHash, false); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.CheckClosure(ci.Paths, ci.StorePath, ci.NarHash, false); err == nil {
		t.Fatal("a listing with blob fields")
	}
}

func compress(t *testing.T, b []byte) []byte {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer enc.Close()
	return enc.EncodeAll(b, nil)
}

func TestVerifyNar(t *testing.T) {
	nar := bytes.Repeat([]byte("nix-archive-1 "), 1000)
	blob := compress(t, nar)
	if err := trust.VerifyNar(bytes.NewReader(blob), sha(nar), int64(len(nar))); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		blob []byte
		hash string
		size int64
	}{
		"wrong hash":   {blob, sha([]byte("x")), int64(len(nar))},
		"longer":       {blob, sha(nar), int64(len(nar)) - 1},
		"shorter":      {blob, sha(nar), int64(len(nar)) + 1},
		"not zstd":     {nar, sha(nar), int64(len(nar))},
		"truncated":    {blob[:len(blob)/2], sha(nar), int64(len(nar))},
		"two frames":   {append(append([]byte{}, blob...), blob...), sha(nar), int64(len(nar))},
		"empty":        {nil, sha(nar), int64(len(nar))},
		"garbage tail": {append(append([]byte{}, blob...), 1, 2, 3, 4, 5, 6, 7, 8, 9), sha(nar), int64(len(nar))},
	} {
		if err := trust.VerifyNar(bytes.NewReader(c.blob), c.hash, c.size); !errors.Is(err, trust.ErrNarMismatch) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// The checking reader refuses at the end, in place of io.EOF.
	nr, _ := trust.NewNarReader(bytes.NewReader(blob), int64(len(nar)))
	defer nr.Close()
	var out bytes.Buffer
	if _, err := out.ReadFrom(trust.CheckingNarReader(nr, sha([]byte("x")), int64(len(nar)))); !errors.Is(err, trust.ErrNarMismatch) {
		t.Fatalf("checking reader: %v", err)
	}
}

// A release resolves each component through its legacy artifact, its index or both; Units prefers the index; an old
// release (legacy only) resolves exactly as before.
func TestReleaseWithIndexes(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	idx := devtuf.StandardRelease("rt-idx", "26.05.2", "1.1.0")
	idx.Providers = []devtuf.FakeProvider{{Name: "codex", Version: "0.51.0"}}
	if _, err := r.AddFakeRelease(idx); err != nil {
		t.Fatal(err)
	}
	// UP-X22: a component without a closure index is not approved.
	lt, err := r.AddFakeRelease(devtuf.StandardRelease("rt-closure", "26.05.2", "1.3.0"))
	if err != nil {
		t.Fatal(err)
	}
	r.RemoveTarget(devtuf.RuntimeIndexTarget(lt.Runtime.Version))
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Release("rt-closure"); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("a release without a runtime index: %v", err)
	}
	ri, err := repo.Release("rt-idx")
	if err != nil {
		t.Fatal(err)
	}
	if ri.HostIndex == nil || ri.RuntimeIndex == nil || len(ri.ProviderIndexes) != 1 || len(ri.Artifacts()) != 3 || len(ri.RuntimeArtifacts()) != 2 {
		t.Fatalf("index release %+v", ri)
	}
	if ri.HostIndex.Index.ManagerStorePath != ri.Tuple.Manager.StorePath || ri.HostIndex.Meta.ClosureSize != 0 {
		t.Fatalf("host index %+v", ri.HostIndex)
	}
	ixs := ri.Indexes(true)
	if len(ixs) != 3 || ixs[0].Meta.StorePath != ri.Tuple.Host.StorePath || ixs[2].Index.Provider != "codex" || len(ri.Indexes(false)) != 2 {
		t.Fatalf("indexes %+v", ixs)
	}
	// The index downloads and parses; its blobs are the repository's files.
	p, _ := r.TargetFilePath(ri.RuntimeIndex.Target)
	b, _ := os.ReadFile(p)
	ci, err := trust.ParseClosureIndex(b, *ri.RuntimeIndex)
	if err != nil {
		t.Fatal(err)
	}
	if len(ci.Paths) != 2 || ci.Paths[0].StorePath != devtuf.FakeLibPath {
		t.Fatalf("index paths %+v", ci.Paths)
	}
	for i := range ci.Paths {
		bp, ok := r.BlobPath(ci.Paths[i].NarHash)
		if !ok {
			t.Fatalf("no blob for %s", ci.Paths[i].StorePath)
		}
		if err := trust.VerifyFile(bp, ci.Blob(i)); err != nil {
			t.Fatal(err)
		}
	}
	// Old clients skip index targets: their kind is not an artifact kind.
	tf, _ := repo.Target(ri.RuntimeIndex.Target)
	var probe struct {
		Whombat trust.ArtifactMeta `json:"whombat"`
	}
	json.Unmarshal(*tf.Custom, &probe)
	if probe.Whombat.Kind != trust.KindClosureIndex {
		t.Fatalf("index kind %q", probe.Whombat.Kind)
	}
}
