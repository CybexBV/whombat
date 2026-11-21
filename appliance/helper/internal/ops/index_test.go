package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// stageBlobs plays the manager for closure indexes: every blob of the release's indexes into staging (by file sha256),
// except the paths in skip.
func (w *world) stageBlobs(id string, skip ...string) {
	rel := w.release(id)
	must(w.t, w.repo.InChannel(w.channel))
	defer w.repo.InChannel("")
	for _, ia := range rel.Indexes(true) {
		p, err := w.repo.TargetFilePath(ia.Target)
		must(w.t, err)
		b, _ := os.ReadFile(p)
		ci, err := trust.ParseClosureIndex(b, ia)
		must(w.t, err)
	paths:
		for i, ip := range ci.Paths {
			for _, s := range skip {
				if s == ip.StorePath {
					continue paths
				}
			}
			bp, ok := w.repo.BlobPath(ip.NarHash)
			if !ok {
				w.t.Fatalf("no blob for %s", ip.StorePath)
			}
			b, _ := os.ReadFile(bp)
			must(w.t, os.WriteFile(filepath.Join(w.cfg.StagingDir, ci.Blob(i).SHA256()), b, 0o644))
		}
	}
}

func (w *world) indexRelease(id, runtimeVersion string) {
	f := devtuf.StandardRelease(id, "26.05.1", runtimeVersion)
	f.Providers = []devtuf.FakeProvider{{Name: "codex", Version: "0.60.0"}}
	must(w.t, w.add(f))
	must(w.t, w.repo.Publish())
}

func TestMissingPaths(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	have := devtuf.FakeStorePath("whombat-runtime-1.0.0")
	lack := devtuf.FakeStorePath("whombat-runtime-9.9.9")
	res, perr, _ := w.h.Handle(t.Context(), proto.Request{V: 1, Op: proto.OpMissingPaths, StorePaths: []string{lack, have}})
	if perr != nil || len(res.Missing) != 1 || res.Missing[0] != lack {
		t.Fatalf("%+v %v", res, perr)
	}
	for _, bad := range [][]string{nil, {"/tmp/x"}, {have + "/../../etc"}} {
		if _, perr, _ := w.h.Handle(t.Context(), proto.Request{V: 1, Op: proto.OpMissingPaths, StorePaths: bad}); code(perr) != proto.CodeBadRequest {
			t.Errorf("%v: %v", bad, perr)
		}
	}
}

// UP-X14: a component is staged through its closure index from the blobs of the paths the store lacks, in import
// order; paths already valid need no blob.
func TestStageThroughIndex(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.indexRelease("rt-idx", "1.5.0")
	w.stageIndexes("rt-idx")
	rt := devtuf.FakeStorePath("whombat-runtime-1.5.0")
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx"); code(perr) != proto.CodeNotStaged || !strings.Contains(perr.Message, rt) {
		t.Fatalf("blobs missing: %v", perr)
	}
	w.stageBlobs("rt-idx")
	before := len(w.fake.Events())
	res, perr := w.do(proto.OpStageRuntime, "rt-idx")
	if perr != nil {
		t.Fatal(perr)
	}
	if len(res.StorePaths) != 2 || res.StorePaths[0] != rt {
		t.Fatalf("staged %+v", res)
	}
	// The store holds the fixture content; the library came with rt-1 and is not imported again.
	content, err := w.fake.StoreContent(rt)
	if err != nil || !strings.Contains(string(content), `"version":"1.5.0"`) {
		t.Fatalf("content %q %v", content, err)
	}
	var imports []string
	for _, e := range w.fake.Events()[before:] {
		if strings.HasPrefix(e, "import-nar ") {
			imports = append(imports, strings.TrimPrefix(e, "import-nar "))
		}
	}
	if len(imports) != 2 || imports[0] != rt {
		t.Fatalf("imports %v", imports)
	}
	// The next release shares the library: it is valid, so its blob is not needed.
	w.indexRelease("rt-idx-2", "1.6.0")
	w.stageIndexes("rt-idx-2")
	w.stageBlobs("rt-idx-2", devtuf.FakeLibPath)
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx-2"); perr != nil {
		t.Fatal(perr)
	}
	// Staging again changes nothing.
	n := len(w.fake.Events())
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx-2"); perr != nil || len(w.fake.Events()) != n {
		t.Fatalf("restage: %v, %d events", perr, len(w.fake.Events())-n)
	}
	// The working copies are gone.
	if entries, _ := os.ReadDir(filepath.Join(w.cfg.StateDir, "work")); len(entries) != 0 {
		t.Fatalf("work dir: %v", entries)
	}
}

// The helper checks every blob itself: a staged blob that is not the index's file, and a blob whose file is the
// index's but does not decompress to the indexed NAR, are refused before anything is imported.
func TestStageThroughIndexRefusesBadBlobs(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.indexRelease("rt-idx", "1.5.0")
	w.stageIndexes("rt-idx")
	w.stageBlobs("rt-idx")
	rel := w.release("rt-idx")
	p, _ := w.repo.TargetFilePath(rel.RuntimeIndex.Target)
	b, _ := os.ReadFile(p)
	ci, _ := trust.ParseClosureIndex(b, *rel.RuntimeIndex)
	staged := filepath.Join(w.cfg.StagingDir, ci.Blob(1).SHA256())
	good, _ := os.ReadFile(staged)
	bad := append([]byte{}, good...)
	bad[len(bad)/2] ^= 0xff
	os.WriteFile(staged, bad, 0o644)
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx"); code(perr) != proto.CodeVerificationFailed {
		t.Fatalf("tampered blob: %v", perr)
	}
	if ok, _ := w.fake.HasStorePath(t.Context(), ci.Paths[1].StorePath); ok {
		t.Fatal("tampered blob imported")
	}
	os.WriteFile(staged, good, 0o644)

	// A signed index whose blob decompresses to something else (a release tooling bug or a compromised build host).
	tuple := w.release("rt-1").Tuple
	tuple.ReleaseID = "rt-bad-nar"
	rtPath := devtuf.FakeStorePath("whombat-runtime-1.9.9")
	content := []byte(`{"fake":true,"kind":"runtime-bundle","version":"1.9.9"}`)
	sum := sha256.Sum256(devtuf.FakeNar(content))
	tuple.Runtime = release.ReleaseTupleRuntime{Version: "1.9.9", StorePath: rtPath, NarHash: "sha256:" + hex.EncodeToString(sum[:]),
		SchemaReads: tuple.Runtime.SchemaReads, SchemaWrites: tuple.Runtime.SchemaWrites, Protocol: tuple.Runtime.Protocol, HostABI: tuple.Runtime.HostABI}
	must(t, w.repo.AddFakeIndex(devtuf.RuntimeIndexTarget("1.9.9"), trust.IndexMeta{Kind: trust.KindClosureIndex, Of: trust.KindRuntimeBundle,
		Version: "1.9.9", StorePath: rtPath, NarHash: tuple.Runtime.NarHash}, []devtuf.FakeNarPath{
		{StorePath: rtPath, Content: content, References: []string{}, CorruptNar: devtuf.FakeNar([]byte(`{"evil":true}`))}}))
	must(t, w.repo.AddRelease(tuple))
	must(t, w.repo.Publish())
	w.stageIndexes("rt-bad-nar")
	w.stageBlobs("rt-bad-nar")
	if _, perr := w.do(proto.OpStageRuntime, "rt-bad-nar"); code(perr) != proto.CodeVerificationFailed || !strings.Contains(perr.Message, rtPath) {
		t.Fatalf("corrupt NAR: %v", perr)
	}
	if ok, _ := w.fake.HasStorePath(t.Context(), rtPath); ok {
		t.Fatal("corrupt NAR imported")
	}
}

func TestStageThroughIndexNoSpace(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.indexRelease("rt-idx", "1.5.0")
	w.stageIndexes("rt-idx")
	w.stageBlobs("rt-idx")
	w.fake.StoreQuota = 1
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx"); code(perr) != proto.CodeNoSpace {
		t.Fatalf("full store: %v", perr)
	}
	w.fake.StoreQuota = 0
	w.fake.SetFail("import", errors.New("boom"))
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx"); code(perr) != proto.CodeActivationFailed {
		t.Fatalf("import failure: %v", perr)
	}
	w.fake.SetFail("import", nil)
	if err := importErr("x", activator.ErrNoSpace); err.Code != proto.CodeNoSpace {
		t.Fatal(err)
	}
	if err := importErr("x", syscall.ENOSPC); err.Code != proto.CodeNoSpace {
		t.Fatal(err)
	}
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx"); perr != nil {
		t.Fatal(perr)
	}
}
