package update_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// countingSource counts what the downloader fetches.
type countingSource struct {
	inner tufclient.Source
	mu    sync.Mutex
	got   []string
}

func (c *countingSource) Open(ctx context.Context, rel string, offset int64) (io.ReadCloser, bool, error) {
	c.mu.Lock()
	c.got = append(c.got, rel)
	c.mu.Unlock()
	return c.inner.Open(ctx, rel, offset)
}

func (c *countingSource) take() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.got
	c.got = nil
	return out
}

func count(paths []string, prefix string) int {
	n := 0
	for _, p := range paths {
		if strings.HasPrefix(p, prefix) {
			n++
		}
	}
	return n
}

// addRelease publishes a fixture release with a provider of its own.
func addRelease(t *testing.T, w *testworld.World, id, host, runtime string) {
	t.Helper()
	f := devtuf.StandardRelease(id, host, runtime)
	f.Providers = []devtuf.FakeProvider{{Name: "codex", Version: "0.60.0"}}
	if _, err := w.Repo.AddFakeRelease(f); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
}

func counting(w *testworld.World) *countingSource {
	cs := &countingSource{inner: w.Staging.Source}
	w.Staging.Source = cs
	return cs
}

func indexOf(t *testing.T, w *testworld.World, ia *trust.Artifact) *trust.ClosureIndex {
	t.Helper()
	p, err := w.Repo.TargetFilePath(ia.Target)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	ci, err := trust.ParseClosureIndex(b, *ia)
	if err != nil {
		t.Fatal(err)
	}
	return ci
}

// UP-X14: a release downloads its closure indexes and only the blobs of the paths the box lacks; the next release
// sharing paths downloads less; one log line per component says so.
func TestIndexReleaseDownloadsOnlyMissingBlobs(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	addRelease(t, w, "rt-30-index", "26.05.1", "1.20.0")
	addRelease(t, w, "rt-31-index", "26.05.1", "1.21.0")
	cs := counting(w)
	var logs bytes.Buffer
	w.Engine.Log = slog.New(slog.NewTextHandler(&logs, nil))
	mustOffer(t, w, "rt-30-index", update.DecisionStarted)
	w.Run(300, testworld.PhaseIs(update.Healthy))
	if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.20.0") {
		t.Fatalf("runtime %s", got)
	}
	got := cs.take()
	// Runtime and provider index, and two blobs: the runtime and the provider (the shared library came with the
	// factory).
	if count(got, "runtime/") != 1 || count(got, "provider/") != 1 || count(got, "nar/") != 2 || len(got) != 4 {
		t.Fatalf("downloads %v", got)
	}
	if strings.Count(logs.String(), "paths=2 missing=1") != 2 {
		t.Fatalf("plan log:\n%s", logs.String())
	}
	// The journal keeps the release's TUF targets (every index), not the blobs.
	st := w.State()
	rel := w.Release("rt-30-index")
	want := map[string]bool{}
	for _, a := range rel.Artifacts() {
		want[a.SHA256()] = true
	}
	if len(st.Current.ArtifactSHA256) != 3 || len(want) != 3 || !want[rel.RuntimeIndex.SHA256()] || !want[rel.ProviderIndexes[0].SHA256()] {
		t.Fatalf("journal artifacts %v", st.Current.ArtifactSHA256)
	}
	for _, s := range st.Current.ArtifactSHA256 {
		if !want[s] {
			t.Fatalf("journal keeps %s", s)
		}
	}
	// The next runtime shares the library and the provider: one index and one blob.
	logs.Reset()
	mustOffer(t, w, "rt-31-index", update.DecisionStarted)
	w.Run(300, testworld.PhaseIs(update.Healthy))
	got = cs.take()
	if count(got, "runtime/") != 1 || count(got, "nar/") != 1 || len(got) != 2 {
		t.Fatalf("second release downloads %v", got)
	}
	if !strings.Contains(logs.String(), "paths=2 missing=1") || !strings.Contains(logs.String(), "paths=2 missing=0 bytes=0") {
		t.Fatalf("plan log:\n%s", logs.String())
	}
	if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.21.0") {
		t.Fatalf("runtime %s", got)
	}
}

// A host release through its index: the host closure (with the manager) is imported and the box boots it.
func TestHostReleaseThroughIndex(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	addRelease(t, w, "rt-33-host-index", "26.05.7", "1.23.0")
	mustOffer(t, w, "rt-33-host-index", update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == "rt-33-host-index"
	})
	if got := w.Helper.Readlink("current-system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.7") {
		t.Fatalf("booted %s", got)
	}
}

// A crash in the middle of the blob downloads: the restarted manager plans again and downloads only what is missing.
func TestIndexDownloadCrashReplans(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	addRelease(t, w, "rt-34-index", "26.05.1", "1.24.0")
	cs := counting(w)
	rel := w.Release("rt-34-index")
	rtIndex := indexOf(t, w, rel.RuntimeIndex)
	rtBlob := rtIndex.Blob(len(rtIndex.Paths) - 1) // the runtime itself (the library came with the factory)
	w.CrashAt = "effect:download:" + rtBlob.SHA256()[:12]
	mustOffer(t, w, "rt-34-index", update.DecisionStarted)
	if err := w.Run(100, testworld.PhaseIs(update.Healthy)); err == nil {
		t.Fatal("no crash")
	}
	before := cs.take()
	if count(before, "nar/") != 1 || w.State().Phase != update.Downloading {
		t.Fatalf("before the crash: %v (%s)", before, w.State().Phase)
	}
	w.RestartHelper()
	w.NewEngine()
	w.Run(300, testworld.PhaseIs(update.Healthy))
	after := cs.take()
	// Only the provider's index was read again from staging (no download); its blob is the one left.
	if count(after, "nar/") != 1 || len(after) != 1 {
		t.Fatalf("after the restart: %v", after)
	}
	if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.24.0") {
		t.Fatalf("runtime %s", got)
	}
}

// A blob the repository serves that is not the index's file fails the download; nothing is imported.
func TestIndexCorruptBlobRefused(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	addRelease(t, w, "rt-35-index", "26.05.1", "1.25.0")
	rel := w.Release("rt-35-index")
	ci := indexOf(t, w, rel.RuntimeIndex)
	bp, ok := w.Repo.BlobPath(ci.Paths[len(ci.Paths)-1].NarHash)
	if !ok {
		t.Fatal("no blob")
	}
	b, _ := os.ReadFile(bp)
	b[len(b)/2] ^= 0xff
	os.WriteFile(bp, b, 0o644)
	mustOffer(t, w, "rt-35-index", update.DecisionStarted)
	w.Run(100, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Failure != nil && st.Candidate.Failure.Code == "download_corrupt"
	})
	factoryRunning(t, w)
	if ok, _ := filepath.Glob(filepath.Join(w.P.Fake, "store", "*whombat-runtime-1.25.0")); len(ok) != 0 {
		t.Fatal("corrupt runtime imported")
	}
}
