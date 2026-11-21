package clients_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/clients"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
	"github.com/CybexBV/whombat/appliance/release-tools/clientchannel"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

var t0 = time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

// fakeRuntime is the admin socket as the clients manager sees it.
type fakeRuntime struct {
	mu       sync.Mutex
	adapters *local.RuntimeFactsClientAdapters
	pushes   []*local.ClientsPushRequest
}

func (f *fakeRuntime) ClientAdapters(context.Context) (*local.RuntimeFactsClientAdapters, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.adapters, nil
}

func (f *fakeRuntime) PushClients(_ context.Context, r *local.ClientsPushRequest) error {
	if err := r.Validate(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pushes = append(f.pushes, r)
	return nil
}

func (f *fakeRuntime) last() *local.ClientsPushRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pushes) == 0 {
		return nil
	}
	return f.pushes[len(f.pushes)-1]
}

// gate blocks artifact downloads, and downloads from a publisher's site, while closed (a slow install). It is also
// the publishers' sites: files maps an address to the file it serves.
type gate struct {
	inner tufclient.Source
	mu    sync.Mutex
	hold  chan struct{}
	opens int
	files map[string]string
	gets  []string
}

func (g *gate) Get(ctx context.Context, url string) (io.ReadCloser, error) {
	g.mu.Lock()
	h := g.hold
	g.opens++
	g.gets = append(g.gets, url)
	path, ok := g.files[url]
	g.mu.Unlock()
	if h != nil {
		select {
		case <-h:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if !ok {
		return nil, errors.New("HTTP 404")
	}
	return os.Open(path)
}

func (g *gate) serve(url, path string) { g.mu.Lock(); g.files[url] = path; g.mu.Unlock() }

// fetched lists the addresses fetched from publishers' sites, in order.
func (g *gate) fetched() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.gets...)
}

// targets counts the artifact downloads by TUF target.
func (g *gate) targets() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.opens - len(g.gets)
}

func (g *gate) Open(ctx context.Context, rel string, off int64) (io.ReadCloser, bool, error) {
	g.mu.Lock()
	h := g.hold
	if filepath.Ext(rel) == ".gz" {
		g.opens++
	}
	g.mu.Unlock()
	if h != nil && filepath.Ext(rel) == ".gz" {
		select {
		case <-h:
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}
	return g.inner.Open(ctx, rel, off)
}

func (g *gate) close() { g.mu.Lock(); g.hold = make(chan struct{}); g.mu.Unlock() }
func (g *gate) open()  { g.mu.Lock(); close(g.hold); g.hold = nil; g.mu.Unlock() }
func (g *gate) downloads() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.opens
}

type world struct {
	t       *testing.T
	dir     string
	clk     *clock
	repo    *devtuf.Repo
	pub     *clientchannel.Publisher
	rt      *fakeRuntime
	src     *gate
	tuf     *tufclient.Client
	m       *clients.Manager
	keys    string
	sources string
	rootDir string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	dir := t.TempDir()
	w := &world{t: t, dir: dir, clk: &clock{t: t0}, rt: &fakeRuntime{adapters: &local.RuntimeFactsClientAdapters{Claude: 1}}}
	var err error
	w.repo, err = devtuf.New(filepath.Join(dir, "repo"), devtuf.Options{Env: "dev", Now: w.clk.Now})
	must(t, err)
	must(t, w.repo.AddClientsRole(nil))
	w.pub = &clientchannel.Publisher{Repo: w.repo, Now: w.clk.Now}
	doc, err := w.repo.ClientChannelKeys()
	must(t, err)
	b, _ := json.Marshal(doc)
	w.keys = filepath.Join(dir, "channel-keys.json")
	must(t, os.WriteFile(w.keys, b, 0o644))
	w.sources = filepath.Join(dir, "sources")
	must(t, os.MkdirAll(w.sources, 0o755))
	w.src = &gate{inner: tufclient.DirSource{Dir: w.repo.TargetsDir()}, files: map[string]string{}}
	w.tuf = &tufclient.Client{PinnedRootPath: filepath.Join(w.repo.MetadataDir(), "1.root.json"), CacheDir: filepath.Join(dir, "tuf-cache"),
		MirrorDir: filepath.Join(dir, "tuf-mirror"), MetadataURL: "mirror://m",
		Fetcher: trust.DirFetcher{BaseURL: "mirror://m", Dir: w.repo.MetadataDir()}, Now: w.clk.Now, ResolveClients: true}
	w.rootDir = clientsRoot(t)
	w.start()
	return w
}

// clientsRoot is outside TMPDIR (~/.cache/… has a dot segment, which the contract's executable path forbids).
func clientsRoot(t *testing.T) string {
	base := "/dev/shm"
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		base = "/tmp"
	}
	d, err := os.MkdirTemp(base, "wbclients")
	if err != nil {
		t.Skip("no writable directory with a plain path:", err)
	}
	t.Cleanup(func() { _ = clientbundle.ForceRemove(d) })
	return d
}

func (w *world) start() {
	cfg := clients.Config{Root: filepath.Join(w.rootDir, "persist", "whombat", "clients"), StateDir: filepath.Join(w.dir, "manager", "clients"),
		KeysFile: w.keys, Env: "dev", Arch: release.ClientArchX8664, Now: w.clk.Now}
	repo := func(ctx context.Context, fresh bool) (*trust.Repo, error) {
		if !fresh {
			if r := w.tuf.Latest(); r != nil {
				return r, nil
			}
		}
		return w.tuf.Refresh(ctx)
	}
	m, err := clients.New(cfg, repo, w.src, w.rt, slog.New(slog.NewTextHandler(io.Discard, nil)))
	must(w.t, err)
	m.Upstream = w.src
	w.m = m
	// The tidying after an install writes the state file: it is over before the test's folder is removed (this
	// clean-up runs before t.TempDir's).
	w.t.Cleanup(m.Settled)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// claude builds a Claude Code-like bundle (a bare executable) for version v, served at Anthropic's address for it.
func (w *world) claude(v string, adapter int64) clientchannel.Built {
	return w.claudeAt(v, adapter, "https://downloads.claude.ai/claude-code-releases/"+v+"/linux-x64/claude")
}

func (w *world) claudeAt(v string, adapter int64, url string) clientchannel.Built {
	src := filepath.Join(w.sources, "claude-"+v)
	must(w.t, os.WriteFile(src, []byte("#!/bin/sh\necho '"+v+" (Claude Code)'\n"), 0o755))
	b, err := clientchannel.Build(context.Background(), clientchannel.Input{Provider: release.ClientProviderClaude, Version: v,
		Arch: release.ClientArchX8664, PublishedAt: t0.Add(-24 * time.Hour), TestedAt: t0.Add(-time.Hour),
		FixturesDigest: "sha256:" + fmt.Sprintf("%064x", 1), Adapter: release.IntRange{Min: adapter, Max: adapter},
		SourceURL: url, SourceFile: src, SourceFormat: "binary"},
		filepath.Join(w.dir, "work"))
	must(w.t, err)
	w.src.serve(url, src)
	return *b
}

// codex builds a Codex-like package (bin/codex next to its resources) for version v.
func (w *world) codex(v string) clientchannel.Built {
	d := filepath.Join(w.sources, "codex-"+v)
	must(w.t, os.MkdirAll(d, 0o755))
	exe, bwrap := filepath.Join(d, "codex"), filepath.Join(d, "bwrap")
	must(w.t, os.WriteFile(exe, []byte("codex-cli "+v+"\n"), 0o755))
	must(w.t, os.WriteFile(bwrap, []byte("bwrap\n"), 0o755))
	pkg := filepath.Join(d, "codex-package.tar.gz")
	f, err := os.Create(pkg)
	must(w.t, err)
	must(w.t, clientbundle.WriteTarGz(f, []clientbundle.Entry{{Name: "bin", Dir: true}, {Name: "bin/codex", Exec: true, Path: exe},
		{Name: "codex-resources", Dir: true}, {Name: "codex-resources/bwrap", Exec: true, Path: bwrap}}))
	must(w.t, f.Close())
	b, err := clientchannel.Build(context.Background(), clientchannel.Input{Provider: release.ClientProviderCodex, Version: v,
		Arch: release.ClientArchX8664, PublishedAt: t0.Add(-24 * time.Hour), TestedAt: t0.Add(-time.Hour),
		FixturesDigest: "sha256:" + fmt.Sprintf("%064x", 2), Adapter: release.IntRange{Min: 1, Max: 1},
		SourceURL:  "https://github.com/openai/codex/releases/download/rust-v" + v + "/codex-package-x86_64-unknown-linux-musl.tar.gz",
		SourceFile: pkg, SourceFormat: "tar.gz", SourcePath: "bin/codex"}, filepath.Join(w.dir, "work"))
	must(w.t, err)
	return *b
}

func (w *world) publish(add []clientchannel.Built, withdraw ...string) *release.SignedClientChannel {
	w.t.Helper()
	ch, err := w.pub.Publish(add, withdraw)
	must(w.t, err)
	return ch
}

func (w *world) client(p clients.Provider) local.LocalClient {
	for _, c := range w.m.Status().Clients {
		if c.Provider == p {
			return c
		}
	}
	w.t.Fatalf("no %s", p)
	return local.LocalClient{}
}

func (w *world) wait(p clients.Provider, want local.LocalClientState) local.LocalClient {
	w.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c := w.client(p); c.State == want {
			return c
		}
		time.Sleep(5 * time.Millisecond)
	}
	c := w.client(p)
	w.t.Fatalf("%s: state %s (error %+v), want %s", p, c.State, c.Error, want)
	return c
}

func (w *world) root(p ...string) string {
	return filepath.Join(append([]string{w.rootDir, "persist", "whombat", "clients"}, p...)...)
}

func TestInstallUpdateRollbackRemove(t *testing.T) {
	// The manager's unit runs with UMask=0077; the runner must still traverse and run the install.
	defer syscall.Umask(syscall.Umask(0o077))
	w := newWorld(t)
	ctx := context.Background()
	w.publish([]clientchannel.Built{w.claude("2.1.290", 1), w.codex("0.158.0")})

	c, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	if c.State != local.LocalClientStateInstalling || c.Installed != nil {
		t.Fatalf("install answer %+v", c)
	}
	c = w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	exe := w.root("claude", "2.1.290", "claude")
	if c.Installed == nil || c.Installed.Version != "2.1.290" || c.Installed.Executable.Path != exe || c.Latest.Version != "2.1.290" {
		t.Fatalf("installed %+v latest %+v", c.Installed, c.Latest)
	}
	st, err := os.Stat(exe)
	must(t, err)
	if st.Mode().Perm() != 0o555 {
		t.Fatalf("executable mode %v", st.Mode())
	}
	if d, _ := os.Stat(w.root("claude", "2.1.290")); d.Mode().Perm() != 0o555 {
		t.Fatalf("version directory mode %v", d.Mode())
	}
	for _, d := range []string{w.root(), w.root("claude")} {
		if st, _ := os.Stat(d); st.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode %v", d, st.Mode())
		}
	}
	if l, _ := os.Readlink(w.root("claude", "current")); l != "2.1.290" {
		t.Fatalf("current -> %q", l)
	}
	must(t, w.m.PushNow(ctx))
	if p := w.rt.last(); p == nil || p.Clients[0].Installed == nil || p.Clients[0].Installed.Executable.SHA256 != c.Installed.Executable.SHA256 ||
		p.Channel == nil || p.Channel.Sequence != 1 {
		t.Fatalf("push %+v", p)
	}
	// Codex: in the channel, but no runtime runs it, so nothing is offered.
	if s := w.m.Status(); s.Clients[1].State != local.LocalClientStateNotInstalled || s.Clients[1].Latest != nil {
		t.Fatalf("status %+v", s.Clients[1])
	}

	// Idempotent.
	c, err = w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	if c.State != local.LocalClientStateInstalled {
		t.Fatalf("second install %+v", c)
	}

	// A Codex bundle in the channel has no runtime to run it (contracts 3.0.0 reports Claude Code's adapter alone).
	if _, err = w.m.Install(ctx, release.ClientProviderCodex); !errors.Is(err, clients.ErrUnavailable) {
		t.Fatalf("codex: %v", err)
	}
	if _, err := os.Stat(w.root("codex")); !os.IsNotExist(err) {
		t.Fatalf("codex installed: %v", err)
	}

	// The channel advances: an automatic update, the previous version stays.
	w.publish([]clientchannel.Built{w.claude("2.1.291", 1)})
	must(t, w.m.Check(ctx, true))
	c = w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	if c.Installed.Version != "2.1.291" {
		t.Fatalf("after update %+v", c.Installed)
	}
	for _, v := range []string{"2.1.290", "2.1.291"} {
		if _, err := os.Stat(w.root("claude", v, "claude")); err != nil {
			t.Fatalf("%s: %v", v, err)
		}
	}
	if l, _ := os.Readlink(w.root("claude", "current")); l != "2.1.291" {
		t.Fatalf("current -> %q", l)
	}

	// Rollback: 2.1.291 is withdrawn; the previous version is on disk and is switched back without a download.
	downloads := w.src.downloads()
	w.publish(nil, "claude/2.1.291")
	must(t, w.m.Check(ctx, true))
	c = w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	for i := 0; i < 200 && c.Installed.Version != "2.1.290"; i++ {
		time.Sleep(5 * time.Millisecond)
		c = w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	}
	if c.Installed.Version != "2.1.290" || w.src.downloads() != downloads {
		t.Fatalf("rollback: %+v, downloads %d → %d", c.Installed, downloads, w.src.downloads())
	}
	if l, _ := os.Readlink(w.root("claude", "current")); l != "2.1.290" {
		t.Fatalf("current -> %q", l)
	}

	// Garbage collection: after the retention only the installed and the newest previous version stay.
	w.publish([]clientchannel.Built{w.claude("2.1.292", 1)})
	must(t, w.m.Check(ctx, true))
	w.waitVersion(release.ClientProviderClaude, "2.1.292")
	w.clk.Advance(25 * time.Hour)
	w.publish(nil) // re-sign so the channel stays valid on the advanced clock
	must(t, w.m.Check(ctx, true))
	entries, _ := os.ReadDir(w.root("claude"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if fmt.Sprint(names) != "[2.1.290 2.1.292 current]" {
		t.Fatalf("after gc: %v", names)
	}

	// Remove: every version goes, the choice is forgotten, the runtime hears it.
	c, err = w.m.Remove(ctx, release.ClientProviderClaude)
	must(t, err)
	if c.State != local.LocalClientStateNotInstalled || c.Installed != nil {
		t.Fatalf("after remove %+v", c)
	}
	if _, err := os.Stat(w.root("claude")); !os.IsNotExist(err) {
		t.Fatalf("claude dir still there: %v", err)
	}
	must(t, w.m.Check(ctx, true))
	if w.client(release.ClientProviderClaude).State != local.LocalClientStateNotInstalled {
		t.Fatal("a removed client came back")
	}
	must(t, w.m.PushNow(ctx))
	if p := w.rt.last(); p.Clients[0].State != local.LocalClientStateNotInstalled || p.Clients[1].Installed != nil {
		t.Fatalf("push after remove %+v", p.Clients)
	}
}

func (w *world) waitVersion(p clients.Provider, v string) {
	w.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c := w.client(p); c.State == local.LocalClientStateInstalled && c.Installed != nil && c.Installed.Version == v {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	w.t.Fatalf("%s never reached %s: %+v", p, v, w.client(p))
}

func TestDigestMismatch(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	good := w.claude("2.1.290", 1)
	w.publish([]clientchannel.Built{good})
	_, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)

	// A corrupted file on Anthropic's site (same length): refused, nothing installed, 2.1.290 keeps running.
	bad := w.claude("2.1.291", 1)
	w.publish([]clientchannel.Built{bad})
	p := filepath.Join(w.sources, "claude-2.1.291")
	data, err := os.ReadFile(p)
	must(t, err)
	data[len(data)/2] ^= 0xff
	must(t, os.WriteFile(p, data, 0o644))
	must(t, w.m.Check(ctx, true))
	c := w.wait(release.ClientProviderClaude, local.LocalClientStateFailed)
	if c.Error == nil || c.Error.Code != clients.CodeDigestMismatch || c.Installed == nil || c.Installed.Version != "2.1.290" {
		t.Fatalf("after corrupt artifact %+v %+v", c.Error, c.Installed)
	}
	if _, err := os.Stat(w.root("claude", "2.1.291")); !os.IsNotExist(err) {
		t.Fatal("a corrupt version was unpacked")
	}
	if l, _ := os.Readlink(w.root("claude", "current")); l != "2.1.290" {
		t.Fatalf("current -> %q", l)
	}
	// Retries back off: another check right away starts nothing.
	must(t, w.m.Check(ctx, true))
	if c := w.client(release.ClientProviderClaude); c.State != local.LocalClientStateFailed {
		t.Fatalf("retried at once: %+v", c)
	}

	// A channel whose executable digest is wrong: it no longer matches the source's, so nothing is downloaded.
	lie := w.claude("2.1.292", 1)
	lie.Bundle.Executable.SHA256 = fmt.Sprintf("%064x", 7)
	w.publish([]clientchannel.Built{lie}, "claude/2.1.291")
	_, err = w.m.Install(ctx, release.ClientProviderClaude) // an owner's retry starts at once
	must(t, err)
	c = w.wait(release.ClientProviderClaude, local.LocalClientStateFailed)
	if c.Error == nil || c.Error.Code != clients.CodeDigestMismatch || c.Installed.Version != "2.1.290" {
		t.Fatalf("after a lying channel %+v %+v", c.Error, c.Installed)
	}
	if entries, _ := os.ReadDir(w.root("claude")); len(entries) != 2 {
		t.Fatalf("leftovers: %v", entries)
	}
}

func TestChannelRollbackAndKeys(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	first := w.publish([]clientchannel.Built{w.claude("2.1.290", 1)})
	old, err := w.repo.ClientTargetContent(release.ClientChannelTarget)
	must(t, err)
	w.publish([]clientchannel.Built{w.claude("2.1.291", 1)})
	must(t, w.m.Check(ctx, true))
	if s := w.m.Status(); s.Channel == nil || s.Channel.Sequence != first.Payload.Sequence+1 {
		t.Fatalf("channel %+v", s.Channel)
	}
	// An older channel in a newer TUF role version: refused (rolled_back); the manager keeps the newer one.
	must(t, w.repo.PublishClients(nil, map[string][]byte{release.ClientChannelTarget: old}))
	var cce *release.ClientChannelError
	if err := w.m.Check(ctx, true); !errors.As(err, &cce) || cce.Code != release.ClientChannelRolledBack {
		t.Fatalf("older channel: %v", err)
	}
	if c := w.client(release.ClientProviderClaude); c.Latest == nil || c.Latest.Version != "2.1.291" {
		t.Fatalf("latest %+v", c.Latest)
	}
	// A channel signed with a key the device does not pin: unknown_key.
	w.pub.Key = devtuf.NewDevKey()
	if _, err := w.pub.Publish(nil, nil); err == nil {
		t.Fatal("published with a key that does not hold the clients role")
	}
}

func TestUnavailable(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	// No channel published yet.
	if _, err := w.m.Install(ctx, release.ClientProviderClaude); !errors.Is(err, clients.ErrUnavailable) {
		t.Fatalf("no channel: %v", err)
	}
	w.publish([]clientchannel.Built{w.claude("2.1.290", 2)})
	// The runtime's adapter level is outside every bundle's range.
	if _, err := w.m.Install(ctx, release.ClientProviderClaude); !errors.Is(err, clients.ErrUnavailable) {
		t.Fatalf("adapter mismatch: %v", err)
	}
	// A runtime before 0.9.0 reports no adapters: nothing is installed.
	w.rt.mu.Lock()
	w.rt.adapters = nil
	w.rt.mu.Unlock()
	must(t, w.m.Check(ctx, true))
	if _, err := w.m.Install(ctx, release.ClientProviderClaude); !errors.Is(err, clients.ErrUnavailable) {
		t.Fatalf("no adapters: %v", err)
	}
	// After a runtime update the adapter fits: the chosen... nothing was chosen, so nothing installs by itself.
	w.rt.mu.Lock()
	w.rt.adapters = &local.RuntimeFactsClientAdapters{Claude: 2}
	w.rt.mu.Unlock()
	must(t, w.m.Check(ctx, true))
	if c := w.client(release.ClientProviderClaude); c.State != local.LocalClientStateNotInstalled || c.Latest.Version != "2.1.290" {
		t.Fatalf("%+v", c)
	}
	_, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
}

func TestNoUpdateWhileInstallingAndRemoveStops(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.publish([]clientchannel.Built{w.claude("2.1.290", 1)})
	w.src.close()
	_, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	// A newer channel arrives while 2.1.290 downloads: no second install starts.
	w.publish([]clientchannel.Built{w.claude("2.1.291", 1)})
	must(t, w.m.Check(ctx, true))
	if c := w.client(release.ClientProviderClaude); c.State != local.LocalClientStateInstalling {
		t.Fatalf("%+v", c)
	}
	w.src.open()
	c := w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	if c.Installed.Version != "2.1.290" {
		t.Fatalf("%+v", c.Installed)
	}
	// The next check updates.
	must(t, w.m.Check(ctx, true))
	w.waitVersion(release.ClientProviderClaude, "2.1.291")

	// Remove stops an install in progress: the next update, while it downloads.
	w.publish([]clientchannel.Built{w.claude("2.1.292", 1)})
	w.src.close()
	must(t, w.m.Check(ctx, true))
	if c := w.client(release.ClientProviderClaude); c.State != local.LocalClientStateUpdating {
		t.Fatalf("%+v", c)
	}
	done := make(chan local.LocalClient)
	go func() {
		c, err := w.m.Remove(ctx, release.ClientProviderClaude)
		if err != nil {
			t.Error(err)
		}
		done <- c
	}()
	select {
	case c := <-done:
		if c.State != local.LocalClientStateNotInstalled {
			t.Fatalf("%+v", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("remove did not stop the install")
	}
	w.src.open()
	if _, err := os.Stat(w.root("claude", "2.1.292")); !os.IsNotExist(err) {
		t.Fatalf("2.1.292 dir: %v", err)
	}
}

func TestRestartResumes(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.publish([]clientchannel.Built{w.claude("2.1.290", 1)})
	w.src.close()
	_, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	// The manager dies mid-download (its state says installing); a new one resumes on its first check.
	w.start()
	w.src.open()
	if c := w.client(release.ClientProviderClaude); c.State != local.LocalClientStateNotInstalled || c.Latest == nil {
		t.Fatalf("after restart %+v", c)
	}
	must(t, w.m.Check(ctx, false))
	w.waitVersion(release.ClientProviderClaude, "2.1.290")
	// And a restart after the install keeps it, with the channel cached for offline starts.
	w.start()
	c := w.client(release.ClientProviderClaude)
	if c.State != local.LocalClientStateInstalled || c.Latest == nil || c.Latest.Version != "2.1.290" {
		t.Fatalf("second restart %+v", c)
	}
}

// An update started by a check inside a short-lived request (an owner's install of another provider) outlives it.
func TestInstallsOutliveTheirCaller(t *testing.T) {
	w := newWorld(t)
	w.publish([]clientchannel.Built{w.claude("2.1.290", 1)})
	_, err := w.m.Install(context.Background(), release.ClientProviderClaude)
	must(t, err)
	w.waitVersion(release.ClientProviderClaude, "2.1.290")
	w.publish([]clientchannel.Built{w.claude("2.1.291", 1)})
	w.src.close()
	ctx, cancel := context.WithCancel(context.Background())
	must(t, w.m.Check(ctx, true))
	cancel() // the request that ran the check is over
	w.src.open()
	w.waitVersion(release.ClientProviderClaude, "2.1.291")
}

func TestClaudeComesFromAnthropic(t *testing.T) {
	defer syscall.Umask(syscall.Umask(0o077))
	w := newWorld(t)
	ctx := context.Background()
	w.publish([]clientchannel.Built{w.claude("2.1.290", 1)})

	_, err := w.m.Install(ctx, release.ClientProviderClaude)
	must(t, err)
	c := w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
	want := "https://downloads.claude.ai/claude-code-releases/2.1.290/linux-x64/claude"
	if got := w.src.fetched(); len(got) != 1 || got[0] != want {
		t.Fatalf("fetched from publishers: %v, want only %s", got, want)
	}
	if n := w.src.targets(); n != 0 {
		t.Fatalf("Claude Code came from a TUF target too (%d downloads)", n)
	}
	exe := w.root("claude", "2.1.290", "claude")
	if c.Installed == nil || c.Installed.Executable.Path != exe {
		t.Fatalf("installed %+v", c.Installed)
	}
	got, err := os.ReadFile(exe)
	must(t, err)
	src, err := os.ReadFile(filepath.Join(w.sources, "claude-2.1.290"))
	must(t, err)
	if string(got) != string(src) {
		t.Fatal("the installed executable is not the publisher's file")
	}
	if st, err := os.Stat(exe); err != nil || st.Mode().Perm() != 0o555 {
		t.Fatalf("executable mode %v %v", st.Mode(), err)
	}
	if l, _ := os.Readlink(w.root("claude", "current")); l != "2.1.290" {
		t.Fatalf("current -> %q", l)
	}

}

func TestClaudeElsewhereComesFromItsTarget(t *testing.T) {
	for _, url := range []string{
		"https://example.com/claude-code-releases/2.1.290/linux-x64/claude",
		"https://downloads.claude.ai/other/2.1.290/claude",
		"https://downloads.claude.ai:8443/claude-code-releases/2.1.290/linux-x64/claude",
	} {
		t.Run(url, func(t *testing.T) {
			w := newWorld(t)
			w.publish([]clientchannel.Built{w.claudeAt("2.1.290", 1, url)})
			_, err := w.m.Install(context.Background(), release.ClientProviderClaude)
			must(t, err)
			w.wait(release.ClientProviderClaude, local.LocalClientStateInstalled)
			if got := w.src.fetched(); len(got) != 0 || w.src.targets() != 1 {
				t.Fatalf("fetched %v from publishers, %d target downloads", got, w.src.targets())
			}
		})
	}
}

func TestClaudeSiteDown(t *testing.T) {
	w := newWorld(t)
	b := w.claude("2.1.290", 1)
	w.src.serve("https://downloads.claude.ai/claude-code-releases/2.1.290/linux-x64/claude", filepath.Join(w.dir, "missing"))
	w.publish([]clientchannel.Built{b})
	_, err := w.m.Install(context.Background(), release.ClientProviderClaude)
	must(t, err)
	c := w.wait(release.ClientProviderClaude, local.LocalClientStateFailed)
	if c.Error == nil || c.Error.Code != clients.CodeInstallFailed || c.Installed != nil {
		t.Fatalf("site down: %+v %+v", c.Error, c.Installed)
	}
	if n := w.src.targets(); n != 0 {
		t.Fatalf("fell back to the TUF target (%d downloads)", n)
	}
	if entries, _ := os.ReadDir(w.root("claude")); len(entries) != 0 {
		t.Fatalf("leftovers: %v", entries)
	}
}
