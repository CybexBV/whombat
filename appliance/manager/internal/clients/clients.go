// Package clients installs the AI clients (Claude Code, Codex) at the latest version Whombat has tested (SUB-09,
// contracts CT-72…CT-74, docs/decisions/manager.md MG-33). The manager fetches the signed client channel (TUF target
// clients/channel.json of the delegated `clients` role, signed again with the pinned channel key), selects the bundle
// for this machine and the runtime's adapter level, downloads the artifact by its TUF target, checks the artifact's
// and the executable's sha256, unpacks it unmodified into <root>/<provider>/<version>/ (read-only), switches
// <root>/<provider>/current and pushes the status to the runtime (`POST /clients`). It never runs a client.
package clients

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Error codes (the contract's client.* codes, CT-72).
const (
	CodeUnavailable    = "client.unavailable"
	CodeInstallFailed  = "client.install_failed"
	CodeDigestMismatch = "client.digest_mismatch"
)

// Errors of the socket operations.
var (
	// ErrBusy: the provider is being removed (409 busy).
	ErrBusy = errors.New("the client is being removed")
	// ErrUnavailable: no tested bundle fits this machine and runtime, or the channel is unavailable (404 unavailable).
	ErrUnavailable = errors.New("no tested client version for this machine")
)

// Runtime is the runtime's admin socket as the clients manager needs it.
type Runtime interface {
	// ClientAdapters returns the runtime's adapter levels (RuntimeFacts.clientAdapters); nil when the runtime
	// does not report them (a runtime before contracts 0.9.0: it runs the providers its release pins).
	ClientAdapters(ctx context.Context) (*local.RuntimeFactsClientAdapters, error)
	PushClients(ctx context.Context, req *local.ClientsPushRequest) error
}

// RepoFunc returns a TUF view that resolved the client targets (Config.ResolveClients); fresh asks for a refresh.
type RepoFunc func(ctx context.Context, fresh bool) (*trust.Repo, error)

// Config configures the clients manager.
type Config struct {
	// Root is where clients are installed (/persist/whombat/clients): <provider>/<version>/… and
	// <provider>/current. Plain path segments only (the contract's executable path pattern).
	Root string
	// StateDir keeps the manager's private state (state.json, the last verified channel.json) and the download
	// staging area.
	StateDir string
	// KeysFile is the pinned channel key document (AssignmentKeys shape, CT-74).
	KeysFile string
	Env      string
	// Arch defaults to this machine's.
	Arch release.ClientArch
	// Retain: a replaced version stays at least this long (default 24 h); the newest previous one stays anyway.
	Retain time.Duration
	// CheckEvery: channel check interval when nobody pokes (default 1 h).
	CheckEvery time.Duration
	Limits     clientbundle.Limits
	// Now is the clock (default time.Now).
	Now func() time.Time
}

// Manager is the clients manager.
type Manager struct {
	Cfg     Config
	Repo    RepoFunc
	Source  tufclient.Source
	Runtime Runtime
	Now     func() time.Time
	Log     *slog.Logger

	mu       sync.Mutex
	st       *fileState
	channel  *release.SignedClientChannel
	chanErr  error
	adapters *local.RuntimeFactsClientAdapters
	jobs     map[Provider]*job
	removing map[Provider]bool
	progress map[Provider]int64
	wake     chan struct{}
	pushReq  chan struct{}
	lastPush time.Time
	base     context.Context
	// tidying counts the gc runs started after an install (Settled).
	tidying sync.WaitGroup
}

type job struct {
	version string
	cancel  context.CancelFunc
	done    chan struct{}
}

// ArchOf maps a Go GOARCH to the contract's architecture.
func ArchOf(goarch string) release.ClientArch {
	if goarch == "arm64" {
		return release.ClientArchAarch64
	}
	return release.ClientArchX8664
}

// New loads the manager's state. Installs interrupted by a restart are resumed by the next check.
func New(cfg Config, repo RepoFunc, src tufclient.Source, rt Runtime, log *slog.Logger) (*Manager, error) {
	if cfg.Root == "" || cfg.StateDir == "" || cfg.KeysFile == "" || cfg.Env == "" {
		return nil, errors.New("clients: root, stateDir, channelKeys and env are required")
	}
	if !rootRe.MatchString(cfg.Root) || filepath.Clean(cfg.Root) != cfg.Root {
		// Executable paths are pushed as <root>/<provider>/<version>/<path>; the contract allows plain segments only.
		return nil, fmt.Errorf("clients: root %q must be absolute with plain segments (no dot-files, no spaces)", cfg.Root)
	}
	if cfg.Arch == "" {
		cfg.Arch = ArchOf(runtime.GOARCH)
	}
	if cfg.Retain <= 0 {
		cfg.Retain = 24 * time.Hour
	}
	if cfg.CheckEvery <= 0 {
		cfg.CheckEvery = time.Hour
	}
	if log == nil {
		log = slog.Default()
	}
	for _, d := range []string{cfg.StateDir, filepath.Join(cfg.StateDir, "staging")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	// Explicit modes: the manager's unit runs with UMask=0077, and the runner must traverse these.
	if err := mkdirReadable(cfg.Root); err != nil {
		return nil, err
	}
	st, err := loadState(filepath.Join(cfg.StateDir, "state.json"))
	if err != nil {
		return nil, fmt.Errorf("clients state: %w", err)
	}
	m := &Manager{Cfg: cfg, Repo: repo, Source: src, Runtime: rt, Log: log, st: st, jobs: map[Provider]*job{},
		removing: map[Provider]bool{}, progress: map[Provider]int64{}, wake: make(chan struct{}, 1), pushReq: make(chan struct{}, 1),
		adapters: st.Adapters, Now: cfg.Now}
	for _, p := range Providers {
		ps := st.provider(p)
		if ps.State == local.LocalClientStateInstalling || ps.State == local.LocalClientStateUpdating {
			// Interrupted by a restart: what was installed still runs; the next check resumes.
			ps.State = local.LocalClientStateNotInstalled
			if ps.Installed != nil {
				ps.State = local.LocalClientStateInstalled
			}
		}
	}
	// The last verified channel, so a restart without network still knows the latest versions (re-verified: an
	// expired one is dropped).
	if raw, err := os.ReadFile(filepath.Join(cfg.StateDir, "channel.json")); err == nil {
		if ch, err := m.verify(raw); err == nil {
			m.channel = ch
		}
	}
	return m, nil
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (m *Manager) saveLocked() error { return m.st.save(filepath.Join(m.Cfg.StateDir, "state.json")) }

// Poke asks for a channel check soon (after a TUF refresh, or when the runtime changed).
func (m *Manager) Poke() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) requestPush() {
	select {
	case m.pushReq <- struct{}{}:
	default:
	}
}

// Run checks the channel at start, every CheckEvery and when poked, and pushes status changes to the runtime at
// most once a second.
func (m *Manager) Run(ctx context.Context) {
	m.mu.Lock()
	m.base = ctx
	m.mu.Unlock()
	go m.pushLoop(ctx)
	for ctx.Err() == nil {
		if err := m.Check(ctx, false); err != nil {
			m.Log.Debug("clients: channel check", "err", err)
		}
		select {
		case <-ctx.Done():
		case <-m.wake:
		case <-time.After(m.Cfg.CheckEvery):
		}
	}
	m.mu.Lock()
	for _, j := range m.jobs {
		j.cancel()
	}
	m.mu.Unlock()
}

func (m *Manager) pushLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.pushReq:
		}
		m.mu.Lock()
		wait := time.Second - m.now().Sub(m.lastPush)
		m.mu.Unlock()
		if wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		if err := m.PushNow(ctx); err != nil {
			m.Log.Debug("clients: push to the runtime", "err", err)
		}
	}
}

// PushNow sends the full status to the runtime (`POST /clients`). The runtime keeps it and hands it to its runner
// (WHOMBAT_CLIENTS_FILE, written by the server). A runtime without the endpoint (before contracts 0.9.0) answers
// runtimeapi.ErrNotSupported, which is not an error here.
func (m *Manager) PushNow(ctx context.Context) error {
	m.mu.Lock()
	s := m.statusLocked()
	m.lastPush = m.now()
	m.mu.Unlock()
	req := &local.ClientsPushRequest{V: local.LocalAPIVersion, Clients: s.Clients, Channel: s.Channel}
	if m.Runtime == nil {
		return nil
	}
	err := m.Runtime.PushClients(ctx, req)
	if errors.Is(err, runtimeapi.ErrNotSupported) {
		return nil
	}
	return err
}

// Status is the local contract status (GET /v1/clients).
func (m *Manager) Status() local.LocalClientsStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func (m *Manager) statusLocked() local.LocalClientsStatus {
	out := local.LocalClientsStatus{V: local.LocalAPIVersion, Clients: []local.LocalClient{}}
	for _, p := range Providers {
		out.Clients = append(out.Clients, m.clientLocked(p))
	}
	if m.channel != nil && !m.st.ChannelCheckedAt.IsZero() {
		out.Channel = &local.LocalClientsStatusChannel{Sequence: m.channel.Payload.Sequence, CheckedAt: rfc3339(m.st.ChannelCheckedAt)}
	}
	return out
}

func (m *Manager) clientLocked(p Provider) local.LocalClient {
	ps := m.st.provider(p)
	c := local.LocalClient{Provider: p, State: ps.State}
	if c.State == "" {
		c.State = local.LocalClientStateNotInstalled
	}
	if v := ps.Installed; v != nil {
		c.Installed = &local.LocalClientInstalled{Version: v.Version, InstalledAt: rfc3339(v.InstalledAt),
			Executable: local.LocalClientInstalledExecutable{Path: v.ExecPath, SHA256: v.SHA256}, FixturesDigest: v.FixturesDigest}
	}
	if b := m.selectLocked(p); b != nil {
		c.Latest = &local.LocalClientLatest{Version: b.Version, PublishedAt: rfc3339(time.Unix(b.PublishedAt, 0))}
	}
	if c.State == local.LocalClientStateInstalling || c.State == local.LocalClientStateUpdating {
		pr := m.progress[p]
		c.Progress = &pr
	}
	if ps.Error != nil {
		e := *ps.Error
		c.Error = &e
	}
	return c
}

func (m *Manager) selectLocked(p Provider) *release.ClientBundle {
	if m.channel == nil || m.adapters == nil {
		return nil
	}
	// The runtime reports Claude Code's adapter only (contracts 3.0.0): a channel's Codex bundles have no runtime that
	// runs them (Whombat HN-A02, IN-432), so none is selected.
	if p != release.ClientProviderClaude {
		return nil
	}
	return release.SelectClientBundle(m.channel.Payload.Bundles, p, release.ClientOsLinux, m.Cfg.Arch, m.adapters.Claude)
}

// verify checks a channel document against the pinned key document, the environment, the time and the last
// accepted sequence (CT-74: the same sequence again is fine, a lower one is a rollback).
func (m *Manager) verify(raw []byte) (*release.SignedClientChannel, error) {
	keysRaw, err := os.ReadFile(m.Cfg.KeysFile)
	if err != nil {
		return nil, fmt.Errorf("channel keys: %w", err)
	}
	now := m.now()
	km, err := release.AssignmentKeyMap(keysRaw, release.Environment(m.Cfg.Env), now.Unix())
	if err != nil {
		return nil, fmt.Errorf("channel keys: %w", err)
	}
	keys := map[string]ed25519.PublicKey{}
	for kid, h := range km {
		pub, err := hex.DecodeString(h)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("channel keys: bad key %q", kid)
		}
		keys[kid] = pub
	}
	m.mu.Lock()
	last := m.st.ChannelSequence
	m.mu.Unlock()
	return release.VerifyClientChannel(raw, release.ClientChannelContext{Keys: keys, Env: release.Environment(m.Cfg.Env),
		Now: now.Unix(), LastSequence: last})
}

// fetchTarget downloads a small TUF target into memory and checks its length and hashes.
func (m *Manager) fetchTarget(ctx context.Context, a trust.Artifact, max int64) ([]byte, error) {
	if a.Length > max {
		return nil, fmt.Errorf("%s is %d bytes (more than %d)", a.Target, a.Length, max)
	}
	rc, _, err := m.Source.Open(ctx, tufclient.RemotePath(a), 0)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, a.Length+1))
	if err != nil {
		return nil, err
	}
	if err := checkHashes(a, b); err != nil {
		return nil, err
	}
	return b, nil
}

func checkHashes(a trust.Artifact, b []byte) error {
	if int64(len(b)) != a.Length {
		return fmt.Errorf("%w: %s is %d bytes, TUF says %d", trust.ErrArtifact, a.Target, len(b), a.Length)
	}
	for alg, want := range a.Hashes {
		var h hash.Hash
		switch alg {
		case "sha256":
			h = sha256.New()
		case "sha512":
			h = sha512.New()
		default:
			return fmt.Errorf("%w: unsupported hash %s", trust.ErrArtifact, alg)
		}
		h.Write(b)
		if hex.EncodeToString(h.Sum(nil)) != want {
			return fmt.Errorf("%w: %s %s mismatch", trust.ErrArtifact, a.Target, alg)
		}
	}
	return nil
}

// Check refreshes the adapter levels and the channel (fresh: a TUF refresh first), then starts updates where the
// selection changed. A failure keeps the last verified channel; installed clients keep running either way.
func (m *Manager) Check(ctx context.Context, fresh bool) error {
	m.refreshAdapters(ctx)
	err := m.refreshChannel(ctx, fresh)
	m.mu.Lock()
	m.chanErr = err
	m.mu.Unlock()
	m.reconcile(ctx)
	m.gc()
	m.requestPush()
	return err
}

func (m *Manager) refreshAdapters(ctx context.Context) {
	if m.Runtime == nil {
		return
	}
	a, err := m.Runtime.ClientAdapters(ctx)
	if err != nil {
		return // keep the last known levels while the runtime is away
	}
	m.mu.Lock()
	m.adapters, m.st.Adapters = a, a
	m.mu.Unlock()
}

// SetAdapters records adapter levels learnt elsewhere (the runtime sync) and pokes a check when they changed.
func (m *Manager) SetAdapters(a *local.RuntimeFactsClientAdapters) {
	m.mu.Lock()
	changed := (a == nil) != (m.adapters == nil) || (a != nil && *a != *m.adapters)
	m.adapters, m.st.Adapters = a, a
	m.mu.Unlock()
	if changed {
		m.Poke()
	}
}

func (m *Manager) refreshChannel(ctx context.Context, fresh bool) error {
	if m.Repo == nil {
		return errors.New("no TUF repository")
	}
	repo, err := m.Repo(ctx, fresh)
	if err != nil {
		return err
	}
	a, err := repo.ClientTarget(release.ClientChannelTarget)
	if err != nil {
		return err
	}
	raw, err := m.fetchTarget(ctx, a, 1<<20)
	if err != nil {
		return err
	}
	ch, err := m.verify(raw)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	advanced := m.channel == nil || ch.Payload.Sequence != m.channel.Payload.Sequence
	m.channel = ch
	m.st.ChannelSequence = ch.Payload.Sequence
	m.st.ChannelCheckedAt = m.now()
	if advanced {
		_ = atomicfile.WriteFile(filepath.Join(m.Cfg.StateDir, "channel.json"), raw, 0o600)
		m.Log.Info("clients: channel", "sequence", ch.Payload.Sequence, "bundles", len(ch.Payload.Bundles))
	}
	return m.saveLocked()
}

// retryDelay is the back-off of automatic retries of a failed version: 15 min, doubling, at most 12 h.
func retryDelay(attempts int) time.Duration {
	d := 15 * time.Minute
	for i := 1; i < attempts && d < 12*time.Hour; i++ {
		d *= 2
	}
	return min(d, 12*time.Hour)
}

// reconcile starts an install for every chosen provider whose selection differs from what is installed, except
// while it is installing or being removed, and not before a failed version's back-off.
func (m *Manager) reconcile(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Installs live as long as the manager, not as the caller (Check also runs inside an owner's install request).
	base := m.base
	if base == nil {
		base = context.WithoutCancel(ctx)
	}
	for _, p := range Providers {
		ps := m.st.provider(p)
		if !ps.Chosen || m.jobs[p] != nil || m.removing[p] {
			continue
		}
		b := m.selectLocked(p)
		if b == nil || (ps.Installed != nil && ps.Installed.Version == b.Version) {
			continue
		}
		if ps.FailedVersion == b.Version && m.now().Before(ps.FailedAt.Add(retryDelay(ps.Attempts))) {
			continue
		}
		m.startLocked(base, p, *b)
	}
}

// Install makes the provider chosen and installs the selected version (idempotent: an install in progress or the
// selected version already installed answers the current status).
func (m *Manager) Install(ctx context.Context, p Provider) (local.LocalClient, error) {
	m.mu.Lock()
	if m.removing[p] {
		m.mu.Unlock()
		return local.LocalClient{}, ErrBusy
	}
	if m.jobs[p] != nil {
		defer m.mu.Unlock()
		return m.clientLocked(p), nil
	}
	need := m.selectLocked(p) == nil
	m.mu.Unlock()
	if need {
		_ = m.Check(ctx, true)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.removing[p] {
		return local.LocalClient{}, ErrBusy
	}
	if m.jobs[p] != nil {
		return m.clientLocked(p), nil
	}
	b := m.selectLocked(p)
	if b == nil {
		why := "no tested version for this machine and this Whombat"
		switch {
		case m.adapters == nil:
			why = "this Whombat's runtime does not report client adapters (it runs the clients its release pins)"
		case m.channel == nil && m.chanErr != nil:
			why = "the tested versions could not be fetched: " + m.chanErr.Error()
		case m.channel == nil:
			why = "the tested versions have not been fetched yet"
		}
		return local.LocalClient{}, fmt.Errorf("%w: %s", ErrUnavailable, why)
	}
	ps := m.st.provider(p)
	ps.Chosen = true
	ps.FailedVersion, ps.Attempts = "", 0 // an owner's request retries at once
	if ps.Installed != nil && ps.Installed.Version == b.Version {
		ps.State, ps.Error = local.LocalClientStateInstalled, nil
		_ = m.saveLocked()
		m.requestPush()
		return m.clientLocked(p), nil
	}
	base := m.base
	if base == nil {
		base = context.WithoutCancel(ctx)
	}
	m.startLocked(base, p, *b)
	return m.clientLocked(p), nil
}

// Remove stops an install in progress, deletes every version of the provider and forgets the choice. Sign-ins are
// the runtime's and are not touched.
func (m *Manager) Remove(ctx context.Context, p Provider) (local.LocalClient, error) {
	m.mu.Lock()
	if m.removing[p] {
		m.mu.Unlock()
		return local.LocalClient{}, ErrBusy
	}
	m.removing[p] = true
	j := m.jobs[p]
	m.mu.Unlock()
	if j != nil {
		j.cancel()
		select {
		case <-j.done:
		case <-ctx.Done():
			// The job ends on its own (cancelled); removal continues below.
			<-j.done
		}
	}
	err := clientbundle.ForceRemove(filepath.Join(m.Cfg.Root, string(p)))
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.removing, p)
	if err != nil {
		return local.LocalClient{}, err
	}
	m.st.Providers[p] = &ProviderState{State: local.LocalClientStateNotInstalled}
	delete(m.progress, p)
	if err := m.saveLocked(); err != nil {
		return local.LocalClient{}, err
	}
	m.requestPush()
	m.Log.Info("clients: removed", "provider", p)
	return m.clientLocked(p), nil
}

func (m *Manager) startLocked(ctx context.Context, p Provider, b release.ClientBundle) {
	ps := m.st.provider(p)
	ps.State = local.LocalClientStateInstalling
	if ps.Installed != nil {
		ps.State = local.LocalClientStateUpdating
	}
	ps.Error = nil
	m.progress[p] = 0
	_ = m.saveLocked()
	jctx, cancel := context.WithCancel(ctx)
	j := &job{version: b.Version, cancel: cancel, done: make(chan struct{})}
	m.jobs[p] = j
	m.requestPush()
	m.Log.Info("clients: installing", "provider", p, "version", b.Version, "state", ps.State)
	go func() {
		defer close(j.done)
		defer cancel()
		v, err := m.install(jctx, p, b)
		m.finish(jctx, p, b, v, err)
	}()
}

func (m *Manager) finish(ctx context.Context, p Provider, b release.ClientBundle, v *Version, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.jobs, p)
	delete(m.progress, p)
	ps := m.st.provider(p)
	if ctx.Err() != nil && err != nil {
		// Cancelled by a remove (or shutdown): Remove resets the state; a shutdown resumes after the restart.
		return
	}
	if err != nil {
		code := CodeInstallFailed
		if errors.Is(err, errDigest) {
			code = CodeDigestMismatch
		}
		ps.State = local.LocalClientStateFailed
		ps.Error = &local.LocalClientError{Code: code, Message: runtimeapi.ASCII(err.Error(), 500)}
		if ps.FailedVersion != b.Version {
			ps.Attempts = 0
		}
		ps.FailedVersion, ps.FailedAt, ps.Attempts = b.Version, m.now(), ps.Attempts+1
		_ = m.saveLocked()
		m.requestPush()
		m.Log.Warn("clients: install failed; what was installed still runs", "provider", p, "version", b.Version, "code", code, "err", err)
		return
	}
	prev := ps.Installed
	ps.Installed = v
	var keep []Version
	if prev != nil && prev.Version != v.Version {
		at := m.now()
		prev.RetiredAt = &at
		keep = append(keep, *prev)
	}
	for _, o := range ps.Previous {
		if o.Version != v.Version && (prev == nil || o.Version != prev.Version) {
			keep = append(keep, o)
		}
	}
	ps.Previous = keep
	ps.State, ps.Error, ps.FailedVersion, ps.Attempts = local.LocalClientStateInstalled, nil, "", 0
	if err := m.switchCurrent(p, v.Version); err != nil {
		m.Log.Warn("clients: current link", "provider", p, "err", err)
	}
	_ = m.saveLocked()
	m.requestPush()
	m.Log.Info("clients: installed", "provider", p, "version", v.Version, "executable", v.ExecPath)
	m.tidying.Go(m.gc)
}

// Settled returns once the tidying that follows an install is done: it removes unused versions and writes the state
// file by itself, after the install shows as installed (tests wait for it before their folders go).
func (m *Manager) Settled() { m.tidying.Wait() }

// switchCurrent points <root>/<provider>/current at the version directory (relative link, atomic rename).
func (m *Manager) switchCurrent(p Provider, version string) error {
	dir := filepath.Join(m.Cfg.Root, string(p))
	tmp := filepath.Join(dir, ".current.tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(version, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "current")); err != nil {
		return err
	}
	return atomicfile.SyncDir(dir)
}

var errDigest = errors.New("digest mismatch")

// mkdirReadable creates dir (and parents) and makes it 0755 whatever the umask.
func mkdirReadable(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Chmod(dir, 0o755)
}

var rootRe = regexp.MustCompile(`^[/][A-Za-z0-9_][A-Za-z0-9._+-]*([/][A-Za-z0-9_][A-Za-z0-9._+-]*)*$`)

func digestErr(format string, a ...any) error {
	return fmt.Errorf("%w: %s", errDigest, fmt.Sprintf(format, a...))
}

// install downloads, checks and unpacks one bundle. A version already on disk whose executable still matches
// (a rollback to the previous version) is reused without a download.
func (m *Manager) install(ctx context.Context, p Provider, b release.ClientBundle) (*Version, error) {
	provDir := filepath.Join(m.Cfg.Root, string(p))
	if err := mkdirReadable(provDir); err != nil {
		return nil, err
	}
	final := filepath.Join(provDir, b.Version)
	v := &Version{Version: b.Version, PublishedAt: b.PublishedAt, ExecPath: filepath.Join(final, filepath.FromSlash(b.Artifact.Path)),
		SHA256: b.Executable.SHA256, Size: b.Executable.Size, FixturesDigest: b.FixturesDigest}
	if st, err := os.Lstat(final); err == nil && st.IsDir() {
		if clientbundle.CheckExecutable(final, b.Artifact.Path, b.Executable.Size, b.Executable.SHA256) == nil {
			v.InstalledAt = m.now()
			m.setProgress(p, 100)
			return v, nil
		}
	}
	if err := clientbundle.ForceRemove(final); err != nil {
		return nil, err
	}
	repo, err := m.Repo(ctx, false)
	if err != nil {
		return nil, fmt.Errorf("TUF: %w", err)
	}
	a, err := repo.ClientTarget(b.Artifact.Target)
	if err != nil {
		return nil, fmt.Errorf("the bundle's artifact is not a TUF target: %w", err)
	}
	if a.SHA256() != b.Artifact.SHA256 || a.Length != b.Artifact.Size {
		return nil, digestErr("TUF says %s is %d bytes sha256 %s, the channel says %d bytes %s", a.Target, a.Length, a.SHA256(), b.Artifact.Size, b.Artifact.SHA256)
	}
	staged := filepath.Join(m.Cfg.StateDir, "staging", a.SHA256())
	defer os.Remove(staged)
	// Download: 0-80 %, unpack and check: 80-100 %.
	if err := m.download(ctx, p, a, staged); err != nil {
		return nil, err
	}
	incoming := filepath.Join(provDir, ".incoming-"+b.Version)
	if err := clientbundle.ForceRemove(incoming); err != nil {
		return nil, err
	}
	var unpacked int64
	lim := m.Cfg.Limits
	err = clientbundle.Unpack(ctx, staged, incoming, lim, func(done int64) {
		unpacked = done
		if b.Executable.Size > 0 {
			m.setProgress(p, 80+min(15, 15*done/max(b.Executable.Size, 1)))
		}
	})
	if err != nil {
		if errors.Is(err, syscall.ENOSPC) {
			return nil, fmt.Errorf("not enough space to unpack %s", b.Version)
		}
		return nil, fmt.Errorf("unpack: %w", err)
	}
	if err := clientbundle.CheckExecutable(incoming, b.Artifact.Path, b.Executable.Size, b.Executable.SHA256); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, digestErr("%v", err)
	}
	if err := clientbundle.ReadOnly(incoming); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	if err := os.Rename(incoming, final); err != nil {
		_ = clientbundle.ForceRemove(incoming)
		return nil, err
	}
	_ = atomicfile.SyncDir(provDir)
	m.setProgress(p, 100)
	v.InstalledAt = m.now()
	m.Log.Debug("clients: unpacked", "provider", p, "version", b.Version, "bytes", unpacked)
	return v, nil
}

func (m *Manager) setProgress(p Provider, pct int64) {
	m.mu.Lock()
	changed := m.progress[p] != pct
	m.progress[p] = pct
	m.mu.Unlock()
	if changed {
		m.requestPush()
	}
}

// download streams the TUF target into staging while hashing, never past its TUF length, and checks it.
func (m *Manager) download(ctx context.Context, p Provider, a trust.Artifact, dst string) error {
	_ = os.Remove(dst)
	rc, _, err := m.Source.Open(ctx, tufclient.RemotePath(a), 0)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer rc.Close()
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	pw := &progressWriter{total: a.Length, report: func(done int64) { m.setProgress(p, 80*done/max(a.Length, 1)) }}
	_, cerr := io.Copy(io.MultiWriter(f, pw), io.LimitReader(rc, a.Length+1))
	serr := f.Sync()
	f.Close()
	if cerr != nil {
		if errors.Is(cerr, syscall.ENOSPC) {
			return fmt.Errorf("not enough space to download %s", a.Target)
		}
		return fmt.Errorf("download: %w", cerr)
	}
	if serr != nil {
		return serr
	}
	if err := trust.VerifyFile(dst, a); err != nil {
		return digestErr("%v", err)
	}
	return nil
}

type progressWriter struct {
	total, done int64
	last        time.Time
	report      func(int64)
}

func (w *progressWriter) Write(b []byte) (int, error) {
	w.done += int64(len(b))
	if time.Since(w.last) > 500*time.Millisecond || w.done >= w.total {
		w.last = time.Now()
		w.report(min(w.done, w.total))
	}
	return len(b), nil
}

// gc removes versions nobody needs: everything in <root>/<provider> except `current`, the installed version, the
// newest previous version (rollback) and previous versions younger than Retain; and the directory of a provider
// with nothing installed. Staging leftovers go too. Nothing of a provider is touched while it installs or is
// being removed. Runs under the lock, so no install can start halfway through.
func (m *Manager) gc() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	for _, p := range Providers {
		if m.jobs[p] != nil || m.removing[p] {
			continue
		}
		ps := m.st.provider(p)
		keep := map[string]bool{"current": true}
		if ps.Installed != nil {
			keep[ps.Installed.Version] = true
		}
		var prev []Version
		for i, o := range ps.Previous {
			young := o.RetiredAt != nil && now.Sub(*o.RetiredAt) < m.Cfg.Retain
			if i == 0 || young {
				keep[o.Version] = true
				prev = append(prev, o)
			}
		}
		ps.Previous = prev
		dir := filepath.Join(m.Cfg.Root, string(p))
		if ps.Installed == nil && len(prev) == 0 {
			_ = clientbundle.ForceRemove(dir)
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !keep[e.Name()] {
				if err := clientbundle.ForceRemove(filepath.Join(dir, e.Name())); err == nil {
					m.Log.Info("clients: removed an unused version", "provider", p, "name", e.Name())
				}
			}
		}
	}
	_ = m.saveLocked()
	if len(m.jobs) == 0 {
		staging := filepath.Join(m.Cfg.StateDir, "staging")
		entries, _ := os.ReadDir(staging)
		for _, e := range entries {
			_ = os.Remove(filepath.Join(staging, e.Name()))
		}
	}
}
