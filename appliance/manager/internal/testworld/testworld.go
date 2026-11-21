// Package testworld assembles a complete fake appliance for manager tests: a development TUF
// repository, the real update helper (fake activator) on a unix socket, a fake runtime admin
// endpoint, the manager's TUF client, staging and the update engine, all on a controllable clock.
package testworld

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/helpertest"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/hostinfo"
	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi/fakeruntime"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// T0 is the fixture epoch.
var T0 = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

// Clock is a manually advanced clock.
type Clock struct {
	mu sync.Mutex
	t  time.Time
}

// Now returns the current fake time.
func (c *Clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }

// Advance moves the clock forward.
func (c *Clock) Advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

// Set sets the clock.
func (c *Clock) Set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

// Space is an injectable free-space source.
type Space struct {
	mu   sync.Mutex
	Free int64 // bytes; <0 = use statfs
}

// FreeBytes implements tufclient.Space.
func (s *Space) FreeBytes(dir string) (int64, error) {
	s.mu.Lock()
	f := s.Free
	s.mu.Unlock()
	if f < 0 {
		return tufclient.StatfsSpace{}.Free(dir)
	}
	return f, nil
}

type spaceAdapter struct{ s *Space }

func (a spaceAdapter) Free(dir string) (int64, error) { return a.s.FreeBytes(dir) }

// Standard fixture releases.
const (
	Factory     = "rt-1"
	RuntimeGood = "rt-2"
	RuntimeBad  = "rt-3-bad"
	HostGood    = "rt-4-host"
	HostNoBoot  = "rt-5-noboot"
	MigrateBad  = "rt-6-migrate-bad"
	Incompat    = "rt-7-incompatible"
	RuntimeNext = "rt-8"
	ExpandBad   = "rt-9-expand-bad"
	ReadOnlyBad = "rt-10-readonly-bad"
	Contract    = "rt-11-contract"
	ForwardFix  = "rt-12-forward-fix"
	// Whombat's convention (MD-01): a runtime declares it reads only its own newest schema; since MD-12 its schema
	// check reports the floors of the schema it migrates to (MG-43). All migrate schema 10 to 11.
	ExpandFloors    = "rt-13-expand-floors"     // an expand the factory reads and writes (floors 10/10)
	ExpandFloorsBad = "rt-14-expand-floors-bad" // the same, unhealthy
	ContractFloors  = "rt-15-contract-floors"   // a contract the factory may only read (floors 10/11)
	NoFloors        = "rt-16-no-floors"         // a runtime before MD-12 (production, 2026-09-28)
	PastFloors      = "rt-17-past-floors"       // nothing older reads schema 11 (floors 11/11), no contract named
	Schema10        = "rt-18-schema-10"         // a newer version that still writes schema 10
)

// Paths used by a world.
type Paths struct {
	Dir, Pinned, Journal, Cache, Mirror, Staging, Assignment, NetCands, HelperState, Fake, HelperSock, AdminSock, DB string
}

// World is a fake appliance.
type World struct {
	T       testing.TB
	P       Paths
	Clock   *Clock
	Repo    *devtuf.Repo
	Helper  *helpertest.Helper
	Runtime *fakeruntime.Runtime
	TUF     *tufclient.Client
	Staging *tufclient.Downloader
	Space   *Space
	Engine  *update.Engine
	Policy  update.Policy
	seq     int64
	// CrashAt, when set, makes the engine fail at that crash point (occurrence CrashN, 1-based).
	CrashAt string
	CrashN  int
	seen    map[string]int
	// Points records every crash point reached (in order).
	Points []string
	// lastRaw is the most recent assignment; Run re-delivers it like the daemon's poll loop.
	lastRaw []byte
	// Checkpoints is the fake backup service.
	Checkpoints *FakeCheckpointer
	// RedeliverInRun makes Run re-offer the last assignment while steady (daemon poll semantics).
	RedeliverInRun bool
	Log            *slog.Logger
	// edition is the helper's (SetEdition); channel its default channel (SetChannel).
	edition string
	channel string
}

// ErrCrash is returned by the engine at an injected crash point.
var ErrCrash = errors.New("injected crash")

func pathsFor(t testing.TB, dir string) Paths {
	p := Paths{Dir: dir, Pinned: filepath.Join(dir, "pinned-root.json"), Journal: filepath.Join(dir, "manager", "journal"),
		Cache: filepath.Join(dir, "manager", "tuf"), Mirror: filepath.Join(dir, "manager", "mirror"), Staging: filepath.Join(dir, "manager", "staging"),
		Assignment: filepath.Join(dir, "manager", "assignment", "current.json"), NetCands: filepath.Join(dir, "manager", "network", "candidates"),
		HelperState: filepath.Join(dir, "helper"), Fake: filepath.Join(dir, "fake"), DB: filepath.Join(dir, "db")}
	// Unix socket paths are limited to 108 bytes: keep sockets in a short runtime directory.
	sockBase := os.Getenv("XDG_RUNTIME_DIR")
	if sockBase == "" {
		sockBase = "/tmp"
	}
	sockDir, err := os.MkdirTemp(sockBase, "wbw")
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	// Recorded for Open: a process killed on purpose (kill tests) never runs its cleanup.
	must(t, os.MkdirAll(dir, 0o755))
	must(t, os.WriteFile(filepath.Join(dir, "socket-dir"), []byte(sockDir), 0o644))
	p.HelperSock, p.AdminSock = filepath.Join(sockDir, "helper.sock"), filepath.Join(sockDir, "admin.sock")
	must(t, os.MkdirAll(p.NetCands, 0o755))
	return p
}

func newWorld(t testing.TB, dir string, now time.Time) *World {
	w := &World{T: t, Clock: &Clock{t: now}, Space: &Space{Free: -1}, seen: map[string]int{}}
	w.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		w.Log = slog.Default()
	}
	w.P = pathsFor(t, dir)
	w.Checkpoints = &FakeCheckpointer{w: w}
	w.Policy = update.DefaultPolicy()
	return w
}

func (w *World) wire() {
	w.TUF = &tufclient.Client{PinnedRootPath: w.P.Pinned, CacheDir: w.P.Cache, MirrorDir: w.P.Mirror, MetadataURL: "file://repo/metadata",
		Fetcher: trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: w.Repo.MetadataDir()}, Now: w.Clock.Now, Floor: w.floor}
	w.Staging = &tufclient.Downloader{StagingDir: w.P.Staging, Source: tufclient.DirSource{Dir: w.Repo.TargetsDir()}, Space: spaceAdapter{w.Space}}
}

// New builds a world with the standard releases published and rt-1 installed, at T0.
func New(t testing.TB) *World { t.Helper(); return NewAt(t, T0) }

// NewAt builds a world whose clock starts at now (daemon tests use the real time).
func NewAt(t testing.TB, now time.Time) *World {
	t.Helper()
	w := newWorld(t, t.TempDir(), now)
	var err error
	w.Repo, err = standardRepo(filepath.Join(w.P.Dir, "repo"), now, devtuf.Options{Now: w.Clock.Now})
	must(t, err)
	must(t, os.WriteFile(w.P.Pinned, w.Repo.InitialRoot(), 0o644))
	w.wire()
	repo := w.Refresh()
	factory, err := repo.Release(Factory)
	must(t, err)
	w.startHelper(factory.Tuple.Host.StorePath)
	// Factory image: the tuple's closures are in the store, its runtime and providers in the profiles.
	paths, err := w.Repo.FakeStore(factory.Artifacts())
	must(t, err)
	store := map[string]helpertest.StorePath{}
	for sp, p := range paths {
		store[sp] = helpertest.StorePath{Content: p.Content, References: p.References}
	}
	providers := map[string]string{}
	for _, p := range factory.Tuple.Providers {
		providers[p.Provider] = p.StorePath
	}
	must(t, w.Helper.FactoryInstall(store, factory.Tuple.Runtime.StorePath, providers))
	must(t, w.Helper.SeedFactory(Factory))
	w.Runtime = &fakeruntime.Runtime{FakeRoot: w.P.Fake, DBDir: w.P.DB, Now: w.Clock.Now}
	w.Runtime.SetSchema(10)
	must(t, w.Runtime.Start(w.P.AdminSock))
	t.Cleanup(func() { w.Runtime.Close(); w.Helper.Stop() })
	w.NewEngine()
	must(t, w.Engine.Provision(factory))
	w.SaveClock()
	return w
}

// Open re-opens an existing world directory in this process (kill tests: a child process continues
// the appliance a killed process left behind).
func Open(t testing.TB, dir string) *World {
	t.Helper()
	// The socket directory of the process that left the world behind (killed, or done with it): nobody uses it now.
	if old, err := os.ReadFile(filepath.Join(dir, "socket-dir")); err == nil && strings.HasPrefix(filepath.Base(string(old)), "wbw") {
		_ = os.RemoveAll(string(old))
	}
	b, err := os.ReadFile(filepath.Join(dir, "clock"))
	must(t, err)
	now, err := time.Parse(time.RFC3339Nano, string(b))
	must(t, err)
	w := newWorld(t, dir, now)
	w.Repo, err = devtuf.Load(filepath.Join(dir, "repo"), devtuf.Options{Now: w.Clock.Now})
	must(t, err)
	w.wire()
	w.startHelper("")
	w.Runtime = &fakeruntime.Runtime{FakeRoot: w.P.Fake, DBDir: w.P.DB, Now: w.Clock.Now}
	must(t, w.Runtime.Start(w.P.AdminSock))
	t.Cleanup(func() { w.Runtime.Close(); w.Helper.Stop() })
	w.NewEngine()
	return w
}

// SaveClock persists the fake clock (for Open).
func (w *World) SaveClock() {
	_ = os.WriteFile(filepath.Join(w.P.Dir, "clock"), []byte(w.Clock.Now().Format(time.RFC3339Nano)), 0o644)
}

func must(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// standardRepo makes the repository a world starts with in dir: the standard releases, published. A repository
// signed at T0 is the same for every world but for its keys, and building it (18 releases compressed and signed) was
// most of what a world costs, several times more under the race detector: it is built once in a process and every
// world at T0 gets a copy of its files, so these worlds share their development keys. A world at another time (the
// daemon tests' real clock) builds its own.
func standardRepo(dir string, now time.Time, opts devtuf.Options) (*devtuf.Repo, error) {
	if !now.Equal(T0) {
		return buildStandard(dir, opts)
	}
	standardT0.once.Do(func() {
		tmp, err := os.MkdirTemp("", "wbstd")
		if err != nil {
			standardT0.err = err
			return
		}
		defer os.RemoveAll(tmp)
		if _, standardT0.err = buildStandard(tmp, devtuf.Options{Now: func() time.Time { return T0 }}); standardT0.err == nil {
			standardT0.files, standardT0.err = readTree(tmp)
		}
	})
	if standardT0.err != nil {
		return nil, standardT0.err
	}
	for _, f := range standardT0.files {
		p := filepath.Join(dir, f.path)
		var err error
		if f.mode.IsDir() {
			err = os.MkdirAll(p, f.mode.Perm())
		} else {
			err = os.WriteFile(p, f.content, f.mode.Perm())
		}
		if err != nil {
			return nil, err
		}
	}
	return devtuf.Load(dir, opts)
}

// standardT0 is the standard repository at T0: its directories and files, parents first.
var standardT0 struct {
	once  sync.Once
	files []treeFile
	err   error
}

type treeFile struct {
	path    string // relative
	mode    os.FileMode
	content []byte
}

func readTree(root string) ([]treeFile, error) {
	var out []treeFile
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		f := treeFile{path: rel, mode: info.Mode()}
		switch {
		case info.IsDir():
		case info.Mode().IsRegular():
			if f.content, err = os.ReadFile(p); err != nil {
				return err
			}
		default:
			return fmt.Errorf("standard repository: %s is neither a file nor a directory", rel)
		}
		out = append(out, f)
		return nil
	})
	return out, err
}

// buildStandard creates a repository in dir and publishes the standard releases.
func buildStandard(dir string, opts devtuf.Options) (*devtuf.Repo, error) {
	repo, err := devtuf.New(dir, opts)
	if err != nil {
		return nil, err
	}
	if err := addStandard(repo); err != nil {
		return nil, err
	}
	return repo, repo.Publish()
}

func addStandard(repo *devtuf.Repo) error {
	var failed error
	add := func(f devtuf.FakeRelease) {
		if _, err := repo.AddFakeRelease(f); err != nil && failed == nil {
			failed = err
		}
	}
	factory := devtuf.StandardRelease(Factory, "26.05.1", "1.0.0")
	factory.SchemaReadOnlyMax = 12
	add(factory)
	add(devtuf.StandardRelease(RuntimeGood, "26.05.1", "1.1.0"))
	bad := devtuf.StandardRelease(RuntimeBad, "26.05.1", "1.1.1-bad")
	bad.RuntimeHealth = "bad"
	add(bad)
	add(devtuf.StandardRelease(HostGood, "26.05.2", "1.2.0"))
	nb := devtuf.StandardRelease(HostNoBoot, "26.05.3", "1.3.0")
	nb.HostBoots = false
	add(nb)
	// Migrates past what the factory runtime can even read: forward repair only.
	mig := devtuf.StandardRelease(MigrateBad, "26.05.1", "2.0.0-bad")
	mig.RuntimeHealth, mig.SchemaWrites, mig.SchemaReads = "bad", 13, release.IntRange{Min: 10, Max: 13}
	add(mig)
	inc := devtuf.StandardRelease(Incompat, "26.05.1", "9.9.9")
	inc.RuntimeHostABI = release.IntRange{Min: 7, Max: 8}
	add(inc)
	add(devtuf.StandardRelease(RuntimeNext, "26.05.1", "1.1.5"))
	// Expand migration (factory still reads/writes it) and a bad runtime: code rollback read-write.
	exp := devtuf.StandardRelease(ExpandBad, "26.05.1", "1.5.0-bad")
	exp.RuntimeHealth, exp.SchemaWrites, exp.SchemaReads = "bad", 11, release.IntRange{Min: 10, Max: 11}
	add(exp)
	// Migration the factory can only read: rollback runs read-only.
	ro := devtuf.StandardRelease(ReadOnlyBad, "26.05.1", "1.6.0-bad")
	ro.RuntimeHealth, ro.SchemaWrites, ro.SchemaReads = "bad", 12, release.IntRange{Min: 10, Max: 12}
	add(ro)
	// Contract migration: needs a verified checkpoint at the safe boundary; healthy.
	con := devtuf.StandardRelease(Contract, "26.05.1", "1.7.0")
	con.SchemaWrites, con.SchemaReads, con.ContractMigration = 11, release.IntRange{Min: 10, Max: 11}, true
	add(con)
	// Fix-forward for rt-6: reads and writes schema 13.
	fix := devtuf.StandardRelease(ForwardFix, "26.05.1", "2.0.1")
	fix.SchemaWrites, fix.SchemaReads = 13, release.IntRange{Min: 12, Max: 13}
	add(fix)
	floors := func(id, version string, readers, writers int64) devtuf.FakeRelease {
		f := devtuf.StandardRelease(id, "26.05.1", version)
		f.SchemaWrites, f.SchemaReads, f.ReaderFloor, f.WriterFloor = 11, release.IntRange{Min: 11, Max: 11}, readers, writers
		return f
	}
	add(floors(ExpandFloors, "1.8.0", 10, 10))
	eb := floors(ExpandFloorsBad, "1.8.1-bad", 10, 10)
	eb.RuntimeHealth = "bad"
	add(eb)
	cf := floors(ContractFloors, "1.8.2", 10, 11)
	cf.ContractMigration = true
	add(cf)
	add(floors(NoFloors, "1.8.3", 0, 0))
	add(floors(PastFloors, "1.8.4", 11, 11))
	s10 := devtuf.StandardRelease(Schema10, "26.05.1", "1.9.0")
	s10.SchemaReads, s10.ReaderFloor, s10.WriterFloor = release.IntRange{Min: 10, Max: 10}, 10, 10
	add(s10)
	return failed
}

func (w *World) floor() time.Time {
	var st update.State
	j, err := journal.Open(w.P.Journal)
	if err != nil {
		return time.Time{}
	}
	if found, err := j.Load(&st); err != nil || !found {
		return time.Time{}
	}
	return time.Unix(st.TimeFloor, 0)
}

func (w *World) startHelper(booted string) {
	now := time.Now // daemon tests run on the real clock (Clock nil)
	if w.Clock != nil {
		now = w.Clock.Now
	}
	h, err := helpertest.Start(helpertest.Config{DeviceID: "dev-1", Env: "dev", Edition: w.edition, DefaultChannel: w.channel, PinnedRootPath: w.P.Pinned, MirrorDir: w.P.Mirror,
		StagingDir: w.P.Staging, AssignmentPath: w.P.Assignment, NetworkCandidatesDir: w.P.NetCands, StateDir: w.P.HelperState,
		FakeRoot: w.P.Fake, FakeDBDir: w.P.DB, BootedSystem: booted, Socket: w.P.HelperSock, ManagerUID: uint32(os.Getuid()), Now: now})
	must(w.T, err)
	w.Helper = h
}

// SetChannel gives the repository both channel roles (once) and restarts the helper as a box with update channels,
// the TUF client reading that channel (LNK-20…LNK-23).
func (w *World) SetChannel(channel string) {
	if !w.Repo.HasChannel(channel) {
		must(w.T, w.Repo.AddChannelRoles(nil, nil))
	}
	w.channel = channel
	w.TUF.Channel = func() string { return w.channel }
	w.RestartHelper()
}

// SetEdition restarts the helper as a box of that edition ("community": no assignments, the newest release; MG-136).
func (w *World) SetEdition(edition string) {
	w.edition = edition
	w.RestartHelper()
}

// Keep withdraws every approved release but ids and publishes (a community repository shaped for a test).
func (w *World) Keep(ids ...string) {
	w.T.Helper()
	keep := map[string]bool{}
	for _, id := range ids {
		keep[id] = true
	}
	for _, id := range w.Refresh().ReleaseIDs() {
		if !keep[id] {
			w.Repo.RemoveTarget(trust.ReleaseTarget(id))
		}
	}
	must(w.T, w.Repo.Publish())
}

// RestartHelper simulates the socket-activated helper exiting and starting again.
func (w *World) RestartHelper() {
	w.Helper.Stop()
	w.startHelper("")
}

// NewEngine creates a fresh engine over the same on-disk state (a manager restart).
func (w *World) NewEngine() *update.Engine {
	j, err := journal.Open(w.P.Journal)
	must(w.T, err)
	rt := runtimeapi.New(w.P.AdminSock, "")
	w.Engine = &update.Engine{
		J: j, Helper: helperclient.Client{Socket: w.P.HelperSock}, Runtime: rt,
		Health:         &health.Checker{Runtime: rt, Now: w.Clock.Now, Units: runtimeUnits{w}},
		Host:           hostinfo.Host{BootIDPath: filepath.Join(w.P.Fake, "boot_id"), CurrentSystemLink: filepath.Join(w.P.Fake, "current-system")},
		Staging:        w.Staging,
		AssignmentPath: w.P.Assignment, Now: w.Clock.Now, Policy: w.Policy, Crash: w.crash, Log: w.Log,
		Checkpointer: w.Checkpoints,
		Refresh:      func(ctx context.Context) error { _, err := w.TUF.Refresh(ctx); return err },
		Channel:      func() string { return w.channel },
	}
	return w.Engine
}

type runtimeUnits struct{ w *World }

func (r runtimeUnits) Active(context.Context) (bool, string) {
	if r.w.Runtime.Down() {
		return false, "inactive"
	}
	return true, ""
}

func (w *World) crash(point string) error {
	w.Points = append(w.Points, point)
	if w.CrashAt == "" || point != w.CrashAt {
		return nil
	}
	w.seen[point]++
	if w.seen[point] == max(w.CrashN, 1) {
		w.CrashAt = ""
		return ErrCrash
	}
	return nil
}

// Refresh refreshes the manager's TUF view (and mirror).
func (w *World) Refresh() *trust.Repo {
	repo, err := w.TUF.Refresh(context.Background())
	must(w.T, err)
	return repo
}

// Offer signs an assignment for id, verifies it as the daemon does and offers it.
func (w *World) Offer(id string) (update.Decision, string, error) {
	w.seq++
	raw, err := w.Repo.Assign("dev-1", id, w.seq, 7*24*time.Hour)
	must(w.T, err)
	w.lastRaw = raw
	return w.OfferRaw(raw)
}

// OfferHold signs and offers a hold assignment.
func (w *World) OfferHold() (update.Decision, string, error) {
	w.seq++
	raw, err := w.Repo.Hold("dev-1", w.seq, 7*24*time.Hour)
	must(w.T, err)
	w.lastRaw = raw
	return w.OfferRaw(raw)
}

// Redeliver offers the last assignment again (what the daemon's poll does after a restart).
func (w *World) Redeliver() {
	if w.lastRaw != nil {
		if _, _, err := w.OfferRaw(w.lastRaw); err != nil && !errors.Is(err, ErrCrash) {
			w.T.Logf("redeliver: %v", err)
		}
	}
}

// OfferRaw verifies and offers a raw assignment.
func (w *World) OfferRaw(raw []byte) (update.Decision, string, error) {
	// A new assignment is only accepted against freshly verified metadata.
	repo, err := w.TUF.Refresh(context.Background())
	if err != nil {
		return update.DecisionRefused, err.Error(), err
	}
	st := w.State()
	o, err := update.VerifyOffer(repo, raw, update.VerifyParams{DeviceID: "dev-1", Env: "dev", Now: w.TUF.ReferenceTime(), LastSequence: st.LastAssignmentSeq})
	if err != nil {
		if errors.Is(err, trust.ErrAssignmentReplay) {
			return update.DecisionNoop, "already processed", nil
		}
		return update.DecisionRefused, err.Error(), err
	}
	return w.Engine.Offer(context.Background(), *o)
}

// State loads the journal.
func (w *World) State() *update.State {
	st, err := w.Engine.Load()
	must(w.T, err)
	return st
}

// Run steps the engine until done returns true, advancing the fake clock by each suggested wait
// and simulating requested reboots (which also restart the manager). It returns the step error if
// the engine hit an injected crash.
func (w *World) Run(maxSteps int, done func(*update.State) bool) error {
	ctx := context.Background()
	for i := 0; i < maxSteps; i++ {
		if w.Helper.RebootRequested() {
			w.Helper.SimulateReboot()
			w.Runtime.Restarted()
			w.NewEngine()
		}
		st := w.State()
		if done(st) {
			return nil
		}
		if st.Steady() && w.lastRaw != nil && w.RedeliverInRun {
			w.Redeliver()
		}
		wait, err := w.Engine.Step(ctx)
		if errors.Is(err, ErrCrash) {
			return err
		}
		if err != nil {
			w.T.Logf("step error (retrying): %v", err)
			wait = time.Second
		}
		if wait > 0 {
			w.Clock.Advance(min(wait, 10*time.Minute))
		}
		w.SaveClock()
	}
	st := w.State()
	detail := ""
	if st.Candidate != nil {
		b, _ := json.Marshal(struct {
			F *update.Failure
			E []health.Evidence
			D *update.Deferral
		}{st.Candidate.Failure, st.Candidate.Evidence, st.Candidate.Deferral})
		detail = string(b)
	}
	w.T.Fatalf("not done after %d steps: phase %s %s\nhelper events: %v", maxSteps, st.Phase, detail, w.Helper.Events())
	return nil
}

// AwaitsControl is a done-predicate for a candidate that rolled back after it was activated: it waits for control to
// assign it again (MG-56) and retries nothing by itself.
func AwaitsControl(st *update.State) bool {
	return st.Phase == update.RolledBack && st.Candidate != nil && st.Candidate.Failure != nil && st.Candidate.Failure.AfterActivation
}

// PhaseIs returns a done-predicate for a phase.
func PhaseIs(p ...update.Phase) func(*update.State) bool {
	return func(st *update.State) bool {
		for _, x := range p {
			if st.Phase == x {
				return true
			}
		}
		return false
	}
}

// RuntimeProfile returns the active runtime store path.
func (w *World) RuntimeProfile() string { return w.Helper.Readlink("profiles/whombat-runtime") }

// Release returns a verified release from the repo.
func (w *World) Release(id string) *trust.Release {
	rel, err := w.Refresh().Release(id)
	must(w.T, err)
	return rel
}

// FakeCheckpointer is a fake backup service; it records the runtime drain state at checkpoint time.
type FakeCheckpointer struct {
	w    *World
	mu   sync.Mutex
	Refs []string
	Fail error
	// FailNext: errors the next requests get, one each, before Fail applies (a dropped connection, then an answer).
	FailNext     []error
	Calls        int
	WhileDrained []bool
	UnderDrain   []string
}

// Checkpoint implements update.Checkpointer.
func (f *FakeCheckpointer) Checkpoint(_ context.Context, req update.CheckpointRequest) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls++
	if len(f.FailNext) > 0 {
		err := f.FailNext[0]
		f.FailNext = f.FailNext[1:]
		return "", err
	}
	if f.Fail != nil {
		return "", f.Fail
	}
	ref := "ckpt-" + req.ReleaseID
	f.Refs = append(f.Refs, ref)
	f.WhileDrained = append(f.WhileDrained, f.w.Runtime.Draining())
	f.UnderDrain = append(f.UnderDrain, req.UnderDrain)
	return ref, nil
}
