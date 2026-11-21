package ops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

var t0 = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

type world struct {
	t     *testing.T
	repo  *devtuf.Repo
	fake  *activator.Fake
	h     *Helper
	cfg   Config
	clock time.Time
	seq   int64
	// channel is the channel the test reads releases through (LNK-23; "" the top-level targets).
	channel string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, clock: t0}
	d := t.TempDir()
	var err error
	w.repo, err = devtuf.New(filepath.Join(d, "repo"), devtuf.Options{Now: func() time.Time { return w.clock }})
	if err != nil {
		t.Fatal(err)
	}
	must(t, w.add(devtuf.StandardRelease("rt-1", "26.05.1", "1.0.0")))
	must(t, w.add(devtuf.StandardRelease("rt-2", "26.05.1", "1.1.0")))
	must(t, w.add(devtuf.StandardRelease("rt-3", "26.05.2", "1.2.0")))
	nb := devtuf.StandardRelease("rt-4-noboot", "26.05.3", "1.3.0")
	nb.HostBoots = false
	must(t, w.add(nb))
	other := devtuf.StandardRelease("rt-5-otherhost", "26.06.0", "1.4.0")
	must(t, w.add(other))
	must(t, w.repo.Publish())
	pinned := filepath.Join(d, "root.json")
	os.WriteFile(pinned, w.repo.InitialRoot(), 0o644)
	w.fake, err = activator.NewFake(filepath.Join(d, "fake"), devtuf.FakeStorePath("nixos-system-whombat-26.05.1"))
	if err != nil {
		t.Fatal(err)
	}
	w.fake.DBDir = filepath.Join(d, "db")
	os.MkdirAll(w.fake.DBDir, 0o755)
	os.WriteFile(filepath.Join(w.fake.DBDir, "schema"), []byte("10"), 0o644)
	w.cfg = Config{DeviceID: "dev-1", Env: "dev", PinnedRootPath: pinned, MirrorDir: w.repo.MetadataDir(),
		StagingDir: filepath.Join(d, "staging"), AssignmentPath: filepath.Join(d, "assignment.json"),
		NetworkCandidatesDir: filepath.Join(d, "net"), StateDir: filepath.Join(d, "state"), Now: func() time.Time { return w.clock }}
	os.MkdirAll(w.cfg.StagingDir, 0o755)
	os.MkdirAll(w.cfg.NetworkCandidatesDir, 0o755)
	w.h, err = New(w.cfg, w.fake)
	if err != nil {
		t.Fatal(err)
	}
	// Factory: r1 is installed.
	w.stageFiles("rt-1")
	if _, perr := w.do(proto.OpStageRuntime, "rt-1"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SetRuntime(context.Background(), runtimeSet(w.release("rt-1")))
	if err := w.h.SeedFactory(context.Background(), "rt-1"); err != nil {
		t.Fatal(err)
	}
	return w
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (w *world) add(f devtuf.FakeRelease) error { _, err := w.repo.AddFakeRelease(f); return err }

func (w *world) release(id string) *trust.Release {
	repo, err := trust.Refresh(trust.Config{PinnedRoot: w.repo.InitialRoot(), MetadataDir: w.t.TempDir(), MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: w.repo.MetadataDir()}, Now: w.clock, Channel: w.channel})
	must(w.t, err)
	rel, err := repo.Release(id)
	must(w.t, err)
	return rel
}

// stageFiles plays the manager: the release's closure indexes and every blob of them into staging.
func (w *world) stageFiles(id string) {
	w.stageIndexes(id)
	w.stageBlobs(id)
}

// stageIndexes copies the release's closure indexes into staging named by sha256.
func (w *world) stageIndexes(id string) {
	must(w.t, w.repo.InChannel(w.channel))
	defer w.repo.InChannel("")
	for _, a := range w.release(id).Artifacts() {
		src, err := w.repo.TargetFilePath(a.Target)
		must(w.t, err)
		b, _ := os.ReadFile(src)
		must(w.t, os.WriteFile(filepath.Join(w.cfg.StagingDir, a.SHA256()), b, 0o644))
	}
}

func (w *world) assign(id string) {
	w.seq++
	b, err := w.repo.Assign("dev-1", id, w.seq, time.Hour)
	must(w.t, err)
	must(w.t, os.WriteFile(w.cfg.AssignmentPath, b, 0o644))
}

func (w *world) do(op proto.Op, id string) (*proto.Result, *proto.Error) {
	req := proto.Request{V: 1, Op: op}
	if strings.HasSuffix(string(op), "network") {
		req.CandidateID = id
	} else {
		req.ReleaseID = id
	}
	res, perr, post := w.h.Handle(context.Background(), req)
	if post != nil {
		post()
	}
	return res, perr
}

func code(perr *proto.Error) string {
	if perr == nil {
		return ""
	}
	return perr.Code
}

func TestRuntimeActivateAndRollback(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("runtime profile %s", got)
	}
	if res, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil || !res.AlreadyDone {
		t.Fatalf("idempotent activate: %v %v", res, perr)
	}
	// Rollback must not depend on TUF: wipe the mirror.
	os.RemoveAll(w.cfg.MirrorDir)
	res, perr := w.do(proto.OpRollbackRuntime, "")
	if perr != nil || res.ReleaseID != "rt-1" || res.RolledBackFrom != "rt-2" {
		t.Fatalf("rollback: %+v %v", res, perr)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
		t.Fatalf("rolled back profile %s", got)
	}
	if res, perr := w.do(proto.OpRollbackRuntime, ""); perr != nil || !res.AlreadyDone {
		t.Fatalf("idempotent rollback: %+v %v", res, perr)
	}
	// Rolling back "from" a release that is not current is a no-op (never past known-good).
	if res, perr := w.do(proto.OpRollbackRuntime, "rt-3"); perr != nil || !res.AlreadyDone || res.ReleaseID != "rt-1" {
		t.Fatalf("rollback from a non-current release: %+v %v", res, perr)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
		t.Fatalf("profile changed: %s", got)
	}
}

func TestActivationRequiresAssignment(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-2")
	w.do(proto.OpStageRuntime, "rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("no assignment: %v", perr)
	}
	w.assign("rt-1") // assignment for another release
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("other release: %v", perr)
	}
	// Assignment for another device.
	b, _ := w.repo.Assign("dev-2", "rt-2", 50, time.Hour)
	os.WriteFile(w.cfg.AssignmentPath, b, 0o644)
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("other device: %v", perr)
	}
	// Replayed older assignment after a newer one was accepted.
	w.seq = 10
	w.assign("rt-2")
	old, _ := os.ReadFile(w.cfg.AssignmentPath)
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.seq = 3
	w.assign("rt-2")
	if _, perr := w.do(proto.OpRollbackRuntime, ""); perr != nil {
		t.Fatal(perr)
	}
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("replayed assignment: %v", perr)
	}
	os.WriteFile(w.cfg.AssignmentPath, old, 0o644)
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatalf("same sequence re-delivered: %v", perr)
	}
}

func TestHelperDoesNotTrustManagerVerdict(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	// 1. Unapproved release with a valid assignment.
	w.assign("rt-x")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-x"); code(perr) != proto.CodeVerificationFailed {
		t.Fatalf("unapproved: %v", perr)
	}
	// 2. Corrupted staged index (manager claims it verified it).
	rel := w.release("rt-2")
	w.stageFiles("rt-2")
	p := filepath.Join(w.cfg.StagingDir, rel.RuntimeIndex.SHA256())
	b, _ := os.ReadFile(p)
	b[10] ^= 0xff
	os.WriteFile(p, b, 0o644)
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); code(perr) != proto.CodeVerificationFailed {
		t.Fatalf("corrupt staged: %v", perr)
	}
	if ok, _ := w.fake.HasStorePath(context.Background(), rel.RuntimeIndex.Meta.StorePath); ok {
		t.Fatal("corrupt artifact imported")
	}
	// 3. Forged mirror (attacker-signed repository).
	evil, _ := devtuf.New(filepath.Join(t.TempDir(), "evil"), devtuf.Options{Now: func() time.Time { return w.clock }})
	evil.AddFakeRelease(devtuf.StandardRelease("rt-2", "26.05.1", "6.6.6"))
	evil.Publish()
	w.h.cfg.MirrorDir = evil.MetadataDir()
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeVerificationFailed {
		t.Fatalf("forged mirror: %v", perr)
	}
	// 4. Expired metadata in the mirror (freeze): refused.
	w.h.cfg.MirrorDir = w.repo.MetadataDir()
	w.clock = w.clock.Add(3 * 24 * time.Hour)
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); code(perr) != proto.CodeMetadataStale {
		t.Fatalf("expired: %v", perr)
	}
}

func TestIncompatibleTuplesRefused(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	// r5 needs a different host than the booted one: runtime-only activation refused.
	w.stageFiles("rt-5-otherhost")
	w.do(proto.OpStageRuntime, "rt-5-otherhost")
	w.assign("rt-5-otherhost")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-5-otherhost"); code(perr) != proto.CodeIncompatible {
		t.Fatalf("host mismatch: %v", perr)
	}
	// ABI-incompatible tuple published by mistake: refused on stage and activate.
	bad := devtuf.StandardRelease("rt-6-abi", "26.05.1", "9.0.0")
	bad.RuntimeHostABI = release.IntRange{Min: 8, Max: 9}
	w.add(bad)
	w.repo.Publish()
	if _, perr := w.do(proto.OpStageRuntime, "rt-6-abi"); code(perr) != proto.CodeIncompatible {
		t.Fatalf("abi: %v", perr)
	}
}

func TestHostActivationBlessAndFallback(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-3")
	if _, perr := w.do(proto.OpStageHost, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-3")
	res, perr := w.do(proto.OpActivateHostOnReboot, "rt-3")
	if perr != nil || !res.RebootPending || !w.fake.RebootRequested() {
		t.Fatalf("host activate: %+v %v", res, perr)
	}
	if _, perr := w.do(proto.OpBlessBoot, ""); code(perr) != proto.CodeBootMismatch {
		t.Fatalf("bless before reboot: %v", perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
	// A host that does not boot: boot counting falls back to r3.
	w.stageFiles("rt-4-noboot")
	w.do(proto.OpStageHost, "rt-4-noboot")
	w.assign("rt-4-noboot")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-4-noboot"); perr != nil {
		t.Fatal(perr)
	}
	if booted := w.fake.SimulateReboot(); booted != devtuf.FakeStorePath("nixos-system-whombat-26.05.2") {
		t.Fatalf("fallback booted %s", booted)
	}
	if _, perr := w.do(proto.OpBlessBoot, ""); code(perr) != proto.CodeBootMismatch {
		t.Fatalf("bless fallback: %v", perr)
	}
	// Manager restores the known-good tuple without TUF and without reboot.
	os.RemoveAll(w.cfg.MirrorDir)
	res, perr = w.do(proto.OpActivateHostOnReboot, "rt-3")
	if perr != nil || res.RebootPending {
		t.Fatalf("restore known good: %+v %v", res, perr)
	}
	if got := w.fake.Readlink("profiles/system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.2") {
		t.Fatalf("boot default %s", got)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.2.0") {
		t.Fatalf("runtime %s", got)
	}
	// Prune: the failed candidate's generation goes; booted/current (r3) and known-good (factory) stay.
	res, perr = w.do(proto.OpPruneHostGenerations, "")
	if perr != nil || len(res.Deleted) != 1 {
		t.Fatalf("prune: %+v %v", res, perr)
	}
	gens, _ := w.fake.HostGenerations(context.Background())
	kept := map[string]bool{}
	for _, g := range gens {
		kept[g.StorePath] = true
	}
	if kept[devtuf.FakeStorePath("nixos-system-whombat-26.05.3")] || !kept[devtuf.FakeStorePath("nixos-system-whombat-26.05.2")] ||
		!kept[devtuf.FakeStorePath("nixos-system-whombat-26.05.1")] {
		t.Fatalf("generations after prune: %+v", gens)
	}
	if res, perr := w.do(proto.OpPruneHostGenerations, ""); perr != nil || !res.AlreadyDone {
		t.Fatalf("second prune: %+v %v", res, perr)
	}
}

// activate stages, assigns and activates a runtime-only release.
func (w *world) activate(id string) {
	w.t.Helper()
	w.stageFiles(id)
	if _, perr := w.do(proto.OpStageRuntime, id); perr != nil {
		w.t.Fatal(perr)
	}
	w.assign(id)
	if _, perr := w.do(proto.OpActivateRuntime, id); perr != nil {
		w.t.Fatal(perr)
	}
}

func (w *world) runtimeGenerations() map[int]string {
	gens, err := w.fake.RuntimeGenerations(context.Background())
	must(w.t, err)
	out := map[int]string{}
	for _, g := range gens {
		out[g.Number] = g.StorePath
	}
	return out
}

func (w *world) inStore(version string) bool {
	ok, _ := w.fake.HasStorePath(context.Background(), devtuf.FakeStorePath("whombat-runtime-"+version))
	return ok
}

// UP-X18: the runtime profile kept a generation per runtime ever activated (each a GC root). The prune keeps the
// runtimes of the helper's records — current and previous runtime, and the hosts' (the factory record names the factory
// runtime) — and the profile's current one; the rest goes, and the store collection then frees their closures.
func TestPruneRuntimeGenerations(t *testing.T) {
	t.Parallel()
	w := newWorld(t) // factory rt-1: runtime 1.0.0 is generation 1
	w.factoryHost()
	must(t, w.add(devtuf.StandardRelease("rt-6", "26.05.1", "1.5.0")))
	must(t, w.add(devtuf.StandardRelease("rt-7", "26.05.1", "1.6.0")))
	must(t, w.repo.Publish())
	w.activate("rt-2")
	if res, perr := w.do(proto.OpPruneRuntimeGenerations, ""); perr != nil || !res.AlreadyDone || len(w.runtimeGenerations()) != 2 {
		t.Fatalf("nothing to prune after one update: %+v %v %v", res, perr, w.runtimeGenerations())
	}
	w.activate("rt-6")
	w.activate("rt-7")
	if g := w.runtimeGenerations(); len(g) != 4 || g[2] != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("fixture generations %v", g)
	}
	res, perr := w.do(proto.OpPruneRuntimeGenerations, "")
	if perr != nil || len(res.Deleted) != 1 || res.Deleted[0] != 2 {
		t.Fatalf("prune: %+v %v", res, perr)
	}
	g := w.runtimeGenerations()
	if len(g) != 3 || g[1] != devtuf.FakeStorePath("whombat-runtime-1.0.0") || g[3] != devtuf.FakeStorePath("whombat-runtime-1.5.0") ||
		g[4] != devtuf.FakeStorePath("whombat-runtime-1.6.0") {
		t.Fatalf("generations after prune %v", g)
	}
	if res, perr := w.do(proto.OpPruneRuntimeGenerations, ""); perr != nil || !res.AlreadyDone {
		t.Fatalf("second prune: %+v %v", res, perr)
	}
	// The pruned runtime's closure goes with the collection; every kept generation's, the booted host and the
	// providers (their own profiles' generations) stay.
	if !w.inStore("1.1.0") {
		t.Fatal("pruning a generation deleted its closure (only the collection does)")
	}
	res, perr = w.do(proto.OpCollectGarbage, "")
	if perr != nil || res.Collected == nil || res.Collected.Paths != 1 || res.Collected.FreedBytes <= 0 || res.AlreadyDone {
		t.Fatalf("collect: %+v %v", res, perr)
	}
	if w.inStore("1.1.0") || !w.inStore("1.0.0") || !w.inStore("1.5.0") || !w.inStore("1.6.0") {
		t.Fatal("collection kept or deleted the wrong runtimes")
	}
	for _, p := range []string{devtuf.FakeStorePath("nixos-system-whombat-26.05.1"), devtuf.FakeStorePath("whombat-provider-codex-0.50.0")} {
		if ok, _ := w.fake.HasStorePath(context.Background(), p); !ok {
			t.Fatalf("collection deleted %s", p)
		}
	}
	if res, perr := w.do(proto.OpCollectGarbage, ""); perr != nil || !res.AlreadyDone || res.Collected.Paths != 0 {
		t.Fatalf("second collection: %+v %v", res, perr)
	}
	// The previous runtime is still there to roll back to, without TUF.
	os.RemoveAll(w.cfg.MirrorDir)
	if res, perr := w.do(proto.OpRollbackRuntime, "rt-7"); perr != nil || res.ReleaseID != "rt-6" {
		t.Fatalf("rollback after the collection: %+v %v", res, perr)
	}
}

// A failing activator deletes nothing; the profile's current and newest generations stay even when no record names
// them (a profile set by something other than the helper); without a recorded runtime nothing is deleted.
func TestPruneRuntimeGenerationsKeepsCurrent(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	must(t, w.add(devtuf.StandardRelease("rt-6", "26.05.1", "1.5.0")))
	must(t, w.add(devtuf.StandardRelease("rt-7", "26.05.1", "1.6.0")))
	must(t, w.repo.Publish())
	w.activate("rt-2")
	w.activate("rt-6")
	w.activate("rt-7") // generations 1.0.0, 1.1.0, 1.5.0, 1.6.0: 1.1.0 is no record's
	w.fake.SetFail("delete-runtime-generations", errors.New("disk on fire"))
	if _, perr := w.do(proto.OpPruneRuntimeGenerations, ""); code(perr) != proto.CodeActivationFailed || len(w.runtimeGenerations()) != 4 {
		t.Fatalf("failed delete: %v %v", perr, w.runtimeGenerations())
	}
	w.fake.SetFail("delete-runtime-generations", nil)
	// Records naming only rt-6 and the factory host, the profile pointed at 1.1.0 by hand: 1.1.0 is the current
	// generation, 1.6.0 the newest; both stay.
	st, _ := loadState(w.cfg.StateDir)
	st.Runtime.Current, st.Runtime.Previous = st.Runtime.Previous, nil
	must(t, saveState(w.cfg.StateDir, st))
	must(t, os.Remove(filepath.Join(w.fake.Root, "profiles", "whombat-runtime")))
	must(t, os.Symlink(devtuf.FakeStorePath("whombat-runtime-1.1.0"), filepath.Join(w.fake.Root, "profiles", "whombat-runtime")))
	if res, perr := w.do(proto.OpPruneRuntimeGenerations, ""); perr != nil || !res.AlreadyDone || len(w.runtimeGenerations()) != 4 {
		t.Fatalf("current or newest generation pruned: %+v %v %v", res, perr, w.runtimeGenerations())
	}
	// Without a recorded runtime the helper can't tell what the box rolls back to: nothing goes.
	fresh, err := New(Config{DeviceID: "dev-1", Env: "dev", PinnedRootPath: w.cfg.PinnedRootPath, MirrorDir: w.cfg.MirrorDir,
		StagingDir: w.cfg.StagingDir, AssignmentPath: w.cfg.AssignmentPath, NetworkCandidatesDir: w.cfg.NetworkCandidatesDir,
		StateDir: t.TempDir(), Now: w.cfg.Now}, w.fake)
	must(t, err)
	if _, perr, _ := fresh.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpPruneRuntimeGenerations}); code(perr) != proto.CodeNothingToRollBack ||
		len(w.runtimeGenerations()) != 4 {
		t.Fatalf("no records: %v %v", perr, w.runtimeGenerations())
	}
}

// What the collection cannot know (why the manager runs it only right after an update became Healthy, UP-X19): a
// closure staged for an activation that hasn't happened yet is not rooted yet and goes; the activation then needs it
// staged again. A failing collection changes nothing.
func TestCollectGarbageDropsAStagedClosure(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.fake.SetFail("collect-garbage", errors.New("boom"))
	if _, perr := w.do(proto.OpCollectGarbage, ""); code(perr) != proto.CodeActivationFailed {
		t.Fatalf("failed collection: %v", perr)
	}
	w.fake.SetFail("collect-garbage", nil)
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	if res, perr := w.do(proto.OpCollectGarbage, ""); perr != nil || res.Collected.Paths != 1 || w.inStore("1.1.0") {
		t.Fatalf("collect: %+v %v", res, perr)
	}
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotStaged {
		t.Fatalf("activation of a collected closure: %v", perr)
	}
}

// References keep paths alive: the shared library runtimes imported through their closure indexes (UP-X14) stays while
// a kept generation's runtime references it, when the runtime that brought it goes (activator.TestFakeCollectGarbage
// covers the last referrer going).
func TestCollectGarbageFollowsReferences(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	f := devtuf.StandardRelease("rt-idx-1", "26.05.1", "1.8.0")
	f.Providers = nil
	must(t, w.add(f))
	must(t, w.repo.Publish())
	w.stageFiles("rt-idx-1")
	if _, perr := w.do(proto.OpStageRuntime, "rt-idx-1"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-idx-1")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-idx-1"); perr != nil {
		t.Fatal(perr)
	}
	lib := devtuf.FakeLibPath
	has := func(p string) bool { ok, _ := w.fake.HasStorePath(context.Background(), p); return ok }
	if res, perr := w.do(proto.OpCollectGarbage, ""); perr != nil || !res.AlreadyDone || !has(lib) {
		t.Fatalf("collect with the index runtime current: %+v %v lib %v", res, perr, has(lib))
	}
	must(t, w.add(devtuf.StandardRelease("rt-8", "26.05.1", "1.9.1")))
	must(t, w.add(devtuf.StandardRelease("rt-9", "26.05.1", "1.9.2")))
	must(t, w.repo.Publish())
	w.activate("rt-8")
	w.activate("rt-9")
	if res, perr := w.do(proto.OpPruneRuntimeGenerations, ""); perr != nil || len(res.Deleted) != 1 {
		t.Fatalf("prune: %+v %v", res, perr)
	}
	// rt-idx-1's runtime goes, the library the kept runtimes reference stays; the provider stays a root of its own
	// profile.
	res, perr := w.do(proto.OpCollectGarbage, "")
	if perr != nil || res.Collected.Paths != 1 || !has(lib) || w.inStore("1.8.0") || !w.inStore("1.9.1") ||
		!has(devtuf.FakeStorePath("whombat-provider-codex-0.50.0")) {
		t.Fatalf("collect: %+v %v lib %v", res, perr, has(lib))
	}
}

func TestFullDiskDuringStaging(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.fake.StoreQuota = 10 // bytes: nothing more fits
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); code(perr) != proto.CodeNoSpace {
		t.Fatalf("full disk: %v", perr)
	}
	// Existing runtime untouched.
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
		t.Fatalf("runtime changed: %s", got)
	}
	w.fake.StoreQuota = 0
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatalf("after space freed: %v", perr)
	}
}

func TestNetworkOps(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	cand := `{"v":1,"id":"n-static","interface":"enp1s0","ipv4":{"mode":"static","address":"192.168.7.2/24","gateway":"192.168.7.1"},"ipv6":{"mode":"disabled"},"dns":["192.168.7.1"],"confirmTimeoutSec":60}`
	os.WriteFile(filepath.Join(w.cfg.NetworkCandidatesDir, "n-static.json"), []byte(cand), 0o644)
	if _, perr := w.do(proto.OpApplyNetwork, "n-static"); perr != nil {
		t.Fatal(perr)
	}
	if !w.fake.DeadmanArmed() || !strings.Contains(w.fake.ActiveNetwork(), "192.168.7.2/24") {
		t.Fatal("not applied/armed")
	}
	// Dead-man fires (manager died): reverted.
	if err := w.h.RevertNetworkDeadman(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.fake.DeadmanArmed() || strings.Contains(w.fake.ActiveNetwork(), "192.168.7.2") {
		t.Fatal("not reverted")
	}
	w.do(proto.OpApplyNetwork, "n-static")
	if _, perr := w.do(proto.OpConfirmNetwork, "n-static"); perr != nil {
		t.Fatal(perr)
	}
	if w.fake.DeadmanArmed() {
		t.Fatal("still armed after confirm")
	}
	// Candidate with smuggled fields is refused.
	os.WriteFile(filepath.Join(w.cfg.NetworkCandidatesDir, "n-evil.json"), []byte(strings.Replace(cand, `"v":1`, `"v":1,"exec":"sh"`, 1)), 0o644)
	if _, perr := w.do(proto.OpApplyNetwork, "n-evil"); code(perr) != proto.CodeBadRequest {
		t.Fatalf("evil candidate: %v", perr)
	}
	// Symlinked candidate is refused (no following into other files).
	os.Symlink("/etc/passwd", filepath.Join(w.cfg.NetworkCandidatesDir, "n-link.json"))
	if _, perr := w.do(proto.OpApplyNetwork, "n-link"); code(perr) != proto.CodeBadRequest {
		t.Fatalf("symlink candidate: %v", perr)
	}
}

func TestFailedApplyReverts(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	cand := `{"v":1,"id":"n-a","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60}`
	os.WriteFile(filepath.Join(w.cfg.NetworkCandidatesDir, "n-a.json"), []byte(cand), 0o644)
	w.fake.SetFail("network-apply", errors.New("boom"))
	if _, perr := w.do(proto.OpApplyNetwork, "n-a"); code(perr) != proto.CodeActivationFailed {
		t.Fatalf("%v", perr)
	}
	if w.fake.DeadmanArmed() {
		t.Fatal("dead-man left armed")
	}
}

func TestSchemaOps(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	mig := devtuf.StandardRelease("rt-mig", "26.05.1", "2.0.0")
	mig.SchemaWrites, mig.SchemaReads = 12, release.IntRange{Min: 10, Max: 12}
	mig.ContractMigration = true
	must(t, w.add(mig))
	must(t, w.repo.Publish())
	w.stageFiles("rt-mig")
	if _, perr := w.do(proto.OpStageRuntime, "rt-mig"); perr != nil {
		t.Fatal(perr)
	}
	res, perr := w.do(proto.OpCheckSchema, "rt-mig")
	if perr != nil || res.Schema.Exit != proto.SchemaExitMigrationRequired || len(res.Schema.NeedsCheckpoint) != 1 {
		t.Fatalf("check: %+v %v", res, perr)
	}
	// The known-good (recorded) release can be checked without TUF.
	os.Rename(w.cfg.MirrorDir, w.cfg.MirrorDir+".off")
	if res, perr := w.do(proto.OpCheckSchema, "rt-1"); perr != nil || res.Schema.Verdict != "current" {
		t.Fatalf("known-good check: %+v %v", res, perr)
	}
	os.Rename(w.cfg.MirrorDir+".off", w.cfg.MirrorDir)
	// Migration needs an assignment.
	req := proto.Request{V: 1, Op: proto.OpMigrateRuntime, ReleaseID: "rt-mig"}
	if _, perr, _ := w.h.Handle(context.Background(), req); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("unassigned migrate: %v", perr)
	}
	w.assign("rt-mig")
	res, perr, _ = w.h.Handle(context.Background(), req)
	if perr != nil || res.Schema.Exit != proto.SchemaExitCheckpointRequired {
		t.Fatalf("migrate without checkpoint: %+v %v", res, perr)
	}
	req.CheckpointID = "ckpt-1"
	res, perr, _ = w.h.Handle(context.Background(), req)
	if perr != nil || res.Schema.Exit != 0 || res.Schema.Verdict != "current" || len(res.Schema.Applied) != 2 {
		t.Fatalf("migrate: %+v %v", res, perr)
	}
	// Known-good now sees a newer, unreadable schema.
	if res, perr := w.do(proto.OpCheckSchema, "rt-1"); perr != nil || res.Schema.Access != "none" {
		t.Fatalf("known-good after migration: %+v %v", res, perr)
	}
}

// MG-57 (the upgrade gates' gate 4): the known-good is a runtime-only release (rt-2 on rt-1's host), a host candidate
// (rt-3) was activated and booted and failed. Rolling back to rt-2 without an assignment boots rt-1's host generation
// with rt-2's runtime; it is the helper's own record of rt-2 (verified when it was activated), not a new tuple.
// factoryHost puts the factory's host generation in the store, as the image has it.
func (w *world) factoryHost() {
	if _, perr := w.do(proto.OpStageHost, "rt-1"); perr != nil {
		w.t.Fatal(perr)
	}
}

func TestHostRollbackToARuntimeOnlyKnownGood(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.factoryHost()
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.clock = w.clock.Add(7 * time.Hour) // past the runtime rollback window (6 h)
	w.stageFiles("rt-3")
	if _, perr := w.do(proto.OpStageHost, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-3")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SimulateReboot() // into rt-3's host; it fails its checks, never blessed
	knownGoodManager := w.release("rt-2").Tuple.Manager.StorePath
	os.RemoveAll(w.cfg.MirrorDir) // rollbacks work without metadata
	res, perr := w.do(proto.OpActivateHostOnReboot, "rt-2")
	if perr != nil || !res.RebootPending || res.ReleaseID != "rt-2" {
		t.Fatalf("rollback to the runtime-only known-good: %+v %v", res, perr)
	}
	if got := w.fake.Readlink("profiles/system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
		t.Fatalf("boot default %s", got)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("runtime %s", got)
	}
	if booted := w.fake.SimulateReboot(); booted != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
		t.Fatalf("booted %s", booted)
	}
	if res, perr := w.do(proto.OpBlessBoot, ""); perr != nil || res.ReleaseID != "rt-2" {
		t.Fatalf("bless: %+v %v", res, perr)
	}
	st, _ := loadState(w.cfg.StateDir)
	if st.Host.Current == nil || st.Host.Current.ReleaseID != "rt-2" || st.Host.Current.Host != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") ||
		st.Runtime.Current.ReleaseID != "rt-2" || st.Host.Pending != nil {
		t.Fatalf("records host %+v runtime %+v", st.Host.Current, st.Runtime.Current)
	}
	// The recovery manager's known-good manager is still the one of rt-1's host (rt-2 names it too).
	if res, perr := w.do(proto.OpKnownGoodManager, ""); perr != nil || len(res.StorePaths) == 0 ||
		res.StorePaths[0] != knownGoodManager {
		t.Fatalf("known-good manager %+v %v", res, perr)
	}
}

// Without an unfinished activation the same record is refused (L-2 holds), and a release the helper never activated
// still needs its assignment.
func TestHostRollbackToARuntimeOnlyReleaseStaysStrict(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.factoryHost()
	w.stageFiles("rt-2")
	w.do(proto.OpStageRuntime, "rt-2")
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.clock = w.clock.Add(7 * time.Hour)
	// Nothing unfinished, and rt-2's host is booted: an alignment, allowed; rt-5 (never activated) is not recorded.
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-5-otherhost"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("an unrecorded release without an assignment: %v", perr)
	}
	// rt-3 activated and blessed: nothing unfinished; rt-2's host isn't booted, so moving back needs an assignment.
	w.stageFiles("rt-3")
	w.do(proto.OpStageHost, "rt-3")
	w.assign("rt-3")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
	w.clock = w.clock.Add(7 * time.Hour) // past the rollback window (6 h)
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-2"); code(perr) != proto.CodeRollbackRefused {
		t.Fatalf("back to rt-2 after rt-3 was blessed: %v", perr)
	}
}
