// Package daemon wires the manager: control polling, TUF refresh, the update engine, the local API
// broker, the network guard, status reporting, systemd notify/watchdog and known-good promotion.
// It runs identically in normal and recovery mode except that recovery mode never starts an
// activation (MG-16).
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/internal/environment"
	"github.com/CybexBV/whombat/appliance/manager/internal/backupclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/clients"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/hardware"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/hostinfo"
	"github.com/CybexBV/whombat/appliance/manager/internal/hostmetrics"
	"github.com/CybexBV/whombat/appliance/manager/internal/identity"
	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/appliance/manager/internal/link"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/appliance/manager/internal/outbox"
	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/sdnotify"
	"github.com/CybexBV/whombat/appliance/manager/internal/tailscale"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/contracts/go/device"
)

// Daemon is a running manager.
type Daemon struct {
	Cfg      *config.Config
	Dev      *config.Device
	Log      *slog.Logger
	Recovery bool

	// Control is nil on a community box (MG-136): no control polls, reports or claim lookups; the newest release of
	// the box's own repository is offered after every TUF refresh instead (offerLatest).
	Control *controlapi.Client
	// Channel is the box's update channel (LNK-21): with one, updates are its newest release, never control's
	// assignments (newestUpdates).
	Channel *updatechannel.Service
	TUF     *tufclient.Client
	Engine  *update.Engine
	Runtime *runtimeapi.Client
	Net     *netguard.Guard
	Broker  *broker.Server
	// Clients installs the AI clients (MG-33); nil when the configuration has no clients.root.
	Clients *clients.Manager
	// Host measures the box for the runtime's POST /v1/host/metrics (MG-63).
	Host *hostmetrics.Sampler
	// OwnAddress is the box's own address (MG-161…MG-166); nil when it has none.
	OwnAddress *ownaddress.Service
	// Env is the box's environment (LNK-01a, link.go); nil without a resolved one (the configuration stands for it).
	Env *environment.Resolved
	// Link is the box's Whombat Link state (LNK-02, link.go): every control call but its own waits for it.
	Link *link.Keeper
	// Tailscale is the box's tailscaled (the broker's too); nil on a box without it.
	Tailscale *tailscale.Manager
	// ReachFile is the owner's reach choice (internal/reach, read at Run) and RegistrationFile the signed registration
	// provisioning kept (read when Link starts); New sets both, tests may move them.
	ReachFile, RegistrationFile string

	// controlURL is control's address from the environment ("" : no Link here); identity is device.json as read at
	// start; registeredAtControl: control registered this box before Link (it starts `on`, its claim lease stays).
	controlURL          string
	identity            *identityFile
	registeredAtControl bool
	// claimWindowIgnored: said once in the log, not at every sync.
	claimWindowIgnored sync.Once
	// linkSig wakes whileLinkActive at every Link change.
	linkSig linkSignal

	started time.Time
	// wake tells the progress loop that the outbox has new reports (a coalescing signal: the outbox holds them all,
	// SR-03).
	wake chan struct{}
	// statusNow asks the status loop for a status.report soon (a coalescing signal): the device record control and
	// release/ship read then shows a new update state within seconds, not at the next 15-minute report (MG-61).
	statusNow chan struct{}
	// pollNow hands the control loop a check's reply channel (MG-67): it polls at once and answers every check it took
	// before that poll.
	pollNow chan chan<- checkReply
	// engineNow wakes the engine loop (a coalescing signal): an assignment the control loop accepted is taken at once,
	// not at the engine's next idle step, up to a minute later (MG-68).
	engineNow chan struct{}
	Outbox    *outbox.Outbox
	// DrainTimeout bounds how long Run waits for its loops once it stops (SR-02); 0: 20 s.
	DrainTimeout time.Duration
	// statusMu guards outboxProblem, the outbox's write failure shown in the unit's status line (SR-08).
	statusMu      sync.Mutex
	outboxProblem string
	mu            sync.Mutex
	lastErr       map[string]string
	// outages are control's and the runtime's current outages (MG-62, outage.go), guarded by mu.
	outages map[string]*outage
	// now is the outages' clock (tests); nil: the wall clock.
	now         func() time.Time
	lastChecked time.Time
	// factsMu serializes facts pushes, each built from the journal and the backup status as they are at send time, so
	// an older state never overwrites a newer one at the runtime.
	factsMu sync.Mutex
	// backupSent is the backupKey of the backup status the runtime was last handed (guarded by factsMu).
	backupSent string
	// lease is the claim-code lookup lease (MG-28, claimlease.go).
	lease claimLease
	// lic is the licence loop's state (MG-34, licence.go); nil without licence.keysFile.
	lic *licenceKeeper
	// Clock is the licence clock (tests roll it back); nil: the wall clock.
	Clock func() time.Time
	// supportEvery overrides SupportWatchSec (tests).
	supportEvery time.Duration
	// supportTold is the support state (supportclient.Key) of the last status.report control took; nil before the
	// first. The support watch compares its first look after that report with it.
	supportTold atomic.Pointer[string]
	// Waits are the loops' fixed waits; New sets DefaultWaits.
	Waits Waits
}

// Waits are the fixed waits of the daemon's loops: the ones no configuration sets. The manager runs on DefaultWaits;
// tests shorten them, so that they wait for what the daemon does and not for minutes of the wall clock.
type Waits struct {
	// StatusFirst: the first status.report after the start.
	StatusFirst time.Duration
	// StatusSettle: how long a status.report asked for by an update transition waits, so the transitions of one step
	// (e.g. Staged → WaitingForSafeBoundary → Activating) are reported once.
	StatusSettle time.Duration
	// StatusRetry: the first retry of a status.report control didn't answer (it doubles up to the report interval).
	StatusRetry time.Duration
	// ProgressRetry: the first retry of an update.progress report control didn't take (it doubles up to 5 minutes).
	ProgressRetry time.Duration
	// LeaseRenew: the least time between two claim.lookup calls, however soon the lease runs out.
	LeaseRenew time.Duration
	// LicenceSecond: how long a second of control's renewAfterS lasts when the next licence renewal is scheduled
	// (control's answer is refused below 60, so a test can't ask for less).
	LicenceSecond time.Duration
}

// DefaultWaits are the manager's waits.
func DefaultWaits() Waits {
	return Waits{StatusFirst: 5 * time.Second, StatusSettle: 3 * time.Second, StatusRetry: 10 * time.Second, ProgressRetry: 5 * time.Second,
		LeaseRenew: 5 * time.Second, LicenceSecond: time.Second}
}

// New builds a daemon from configuration.
func New(cfg *config.Config, recovery bool, log *slog.Logger) (*Daemon, error) {
	dev, err := config.LoadDevice(cfg.DeviceFile)
	if err != nil {
		return nil, err
	}
	key, err := identity.Load(cfg.ManagementKey)
	if err != nil {
		return nil, fmt.Errorf("management key: %w", err)
	}
	j, err := journal.Open(cfg.JournalDir)
	if err != nil {
		return nil, err
	}
	d := &Daemon{Cfg: cfg, Dev: dev, Log: log, Recovery: recovery, started: time.Now(), wake: make(chan struct{}, 1), statusNow: make(chan struct{}, 1), lastErr: map[string]string{},
		pollNow: make(chan chan<- checkReply), engineNow: make(chan struct{}, 1),
		Outbox: outbox.Open(filepath.Join(cfg.JournalDir, "progress-outbox-v2.json")),
		lease:  claimLease{wake: make(chan struct{}, 1)}, Waits: DefaultWaits()}
	d.loadClaimState()
	// The licence is inert (LNK-04): the token a box holds is still handed to its runtime (a rollback to the release
	// before finds it), but it is never renewed again.
	d.setupLicence(cfg)
	d.setupEnvironment()
	if d.controlURL != "" {
		// Control is where Link lives; what the box sends there follows its Link state (link.go).
		d.Control = &controlapi.Client{BaseURL: d.controlURL, Env: dev.Env, DeviceID: dev.DeviceID, Key: key.Private}
	}
	floor := func() time.Time {
		if d.Engine == nil {
			return time.Time{}
		}
		st, err := d.Engine.Load()
		if err != nil {
			return time.Time{}
		}
		return time.Unix(st.TimeFloor, 0)
	}
	// A channel change is checked at once: the new channel's metadata refreshed and its newest release offered.
	d.Channel = &updatechannel.Service{Helper: helperclient.Client{Socket: cfg.HelperSocket},
		Changed: func() { go d.CheckNow(context.Background()) }, View: func() *trust.Repo { return d.TUF.Latest() },
		Installed: d.installed}
	d.TUF = &tufclient.Client{PinnedRootPath: cfg.TUF.PinnedRoot, CacheDir: cfg.TUF.CacheDir, MirrorDir: cfg.TUF.MirrorDir,
		MetadataURL: cfg.TUF.MetadataURL, Fetcher: tufclient.NewHTTPFetcher("whombat-manager/" + cfg.ManagerVersion), Floor: floor,
		Production: dev.Env == "prod", ResolveClients: cfg.Clients.Root != "", Channel: d.Channel.Current}
	d.Runtime = runtimeapi.New(cfg.Runtime.AdminSocket, cfg.Runtime.HealthURL)
	var units health.UnitState
	if len(cfg.Runtime.Units) > 0 {
		units = health.SystemdUnits{Systemctl: cfg.Systemctl, Units: cfg.Runtime.Units}
	}
	helper := helperclient.Client{Socket: cfg.HelperSocket}
	d.Engine = &update.Engine{
		J: j, Helper: helper, Runtime: d.Runtime,
		Health:         &health.Checker{Units: units, Runtime: d.Runtime, SessionAddr: cfg.Runtime.SessionAddr},
		Host:           hostinfo.Host{BootIDPath: cfg.Host.BootIDPath, CurrentSystemLink: cfg.Host.CurrentSystem},
		Staging:        &tufclient.Downloader{StagingDir: cfg.StagingDir, Source: tufclient.HTTPSource{BaseURL: cfg.TUF.TargetsURL, Client: &http.Client{Timeout: 2 * time.Hour}, Layout: cfg.TUF.TargetsLayout}, Space: tufclient.StatfsSpace{}, ReserveBytes: cfg.ReserveBytes},
		AssignmentPath: cfg.AssignmentPath, Policy: update.DefaultPolicy(), RecoveryMode: recovery, Log: log,
		Refresh:      func(ctx context.Context) error { _, err := d.TUF.Refresh(ctx); return err },
		OnTransition: func(st update.State) { d.onTransition(st) },
		Channel:      d.Channel.Current,
	}
	if cfg.BackupSocket != "" {
		d.Engine.Checkpointer = backupclient.Client{Socket: cfg.BackupSocket}
	}
	if wd := sdnotify.WatchdogInterval(); wd > 0 {
		// The step that waits for the store collection after an update keeps the watchdog fed (UP-X19).
		d.Engine.Heartbeat, d.Engine.HeartbeatEvery = func() { _ = sdnotify.Watchdog() }, wd/2
	}
	applyPolicy(&d.Engine.Policy, cfg)
	if cfg.Network.CandidatesDir != "" {
		// A network change is kept when the update repository answers on it: every box needs that one, and a box with
		// Link off makes no connection to control at all (LNK-03).
		d.Net = &netguard.Guard{CandidatesDir: cfg.Network.CandidatesDir, StateDir: cfg.Network.StateDir, Helper: helper,
			Check: netguard.DialChecker{ControlURL: cfg.TUF.MetadataURL}, Lock: engineLock{d.Engine}, Log: log}
	}
	runtimeUID, err := uidOf(cfg.Runtime.User)
	if err != nil {
		return nil, err
	}
	var lockUIDs []uint32
	for _, u := range cfg.LockUsers {
		id, err := uidOf(u)
		if err != nil {
			return nil, err
		}
		lockUIDs = append(lockUIDs, id)
	}
	d.Broker = &broker.Server{RuntimeUID: runtimeUID, LockUIDs: lockUIDs, Engine: d.Engine, Net: d.Net, Log: log,
		OnClaimed: d.MarkClaimed, OnClaimReported: d.licenceNudge,
		AdminUIDs: []uint32{0, uint32(os.Getuid())}, CheckNow: d.CheckNow, WakeEngine: d.wakeEngine, Helper: helper}
	d.Broker.Channel = d.Channel // the update channel's routes (broker/channel.go)
	// No Broker.Licence: the runtime's forced renewal answers 404 unavailable now that the licence is inert (LNK-04).
	if cfg.BackupSocket != "" {
		bc := backupclient.Client{Socket: cfg.BackupSocket}
		d.Broker.RestoreState = func(ctx context.Context) (broker.RestoreState, error) {
			phase, since, err := bc.Restore(ctx)
			return broker.RestoreState{Phase: phase, Since: since}, err
		}
	}
	// Remote help (MG-118): the support service runs as root, without a User=. Without control (MG-136) the broker's
	// Control and Support stay nil, never a nil client in an interface.
	d.Broker.SupportUIDs = []uint32{0}
	if d.Control != nil {
		d.Broker.Control, d.Broker.Support = d.Control, d.Control
	}
	// Tailscale for This Whombat (CT-1255, MG-130): the manager is tailscaled's operator (NX-441).
	if cfg.TailscaleSocket != "" {
		d.Tailscale = tailscale.New(tailscale.Config{Socket: cfg.TailscaleSocket, Log: log, WantFile: cfg.TailscaleWantFile()})
		d.Broker.Tailscale = d.Tailscale
	}
	if err := d.setupLink(key.Private); err != nil {
		// Without its Link state the box can't tell what it may send to control: it sends nothing (updates go on).
		d.Log.Error("link: the Link state is unreadable; no control calls on this start", "err", err)
		d.Control, d.Broker.Control, d.Broker.Support = nil, nil, nil
	}
	d.setupOwnAddress(runtimeUID)
	d.Host = hostmetrics.New(hostmetrics.Config{Dir: cfg.Metrics.Dir, Persist: cfg.Metrics.PersistDir, Log: log})
	d.Broker.Host = d.Host
	// The hardware report (MG-110…MG-114): the kernel's lines from the helper's read-only hardware-log.
	d.Broker.Hardware = hardware.New(hardware.Config{Log: log, KernelLog: func(ctx context.Context) ([]string, error) {
		res, err := helper.Do(ctx, proto.Request{Op: proto.OpHardwareLog})
		if err != nil {
			return nil, err
		}
		return res.KernelLog, nil
	}})
	if cfg.Clients.Root != "" {
		repo := func(ctx context.Context, fresh bool) (*trust.Repo, error) {
			if !fresh {
				if r := d.TUF.Latest(); r != nil {
					return r, nil
				}
			}
			return d.TUF.Refresh(ctx)
		}
		src := tufclient.HTTPSource{BaseURL: cfg.TUF.TargetsURL, Client: &http.Client{Timeout: time.Hour}, Layout: cfg.TUF.TargetsLayout}
		d.Clients, err = clients.New(clients.Config{Root: cfg.Clients.Root, StateDir: cfg.Clients.StateDir, KeysFile: cfg.Clients.ChannelKeys,
			Env: dev.Env, CheckEvery: config.Seconds(cfg.Clients.CheckSec, time.Hour)}, repo, src, d.Runtime, log)
		if err != nil {
			return nil, err
		}
		d.Broker.Clients = d.Clients
	}
	return d, nil
}

type engineLock struct{ e *update.Engine }

func (l engineLock) AcquireLock(h, r string, ttl time.Duration) error {
	_, err := l.e.AcquireLock(h, r, ttl)
	return err
}
func (l engineLock) ReleaseLock(h string) error { return l.e.ReleaseLock(h) }

func uidOf(name string) (uint32, error) {
	if name == "" {
		return uint32(os.Getuid()), nil
	}
	if n, err := strconv.ParseUint(name, 10, 32); err == nil {
		return uint32(n), nil
	}
	u, err := user.Lookup(name)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseUint(u.Uid, 10, 32)
	return uint32(n), err
}

// onTransition records the report of every persisted journal state in the outbox before it returns (SR-03), then
// wakes the progress loop. It never waits for the network: sending is the progress loop's.
func (d *Daemon) onTransition(st update.State) {
	d.recordReport(&st, false)
	select {
	case d.wake <- struct{}{}:
	default: // a wake is pending: the loop reads everything the outbox holds
	}
	select {
	case d.statusNow <- struct{}{}:
	default: // a report is already asked for: it reads the journal when it is sent
	}
}

// progressReport is the update.progress report of a journal state.
func (d *Daemon) progressReport(st *update.State) device.UpdateProgressRequest {
	r := st.Record
	p := device.UpdateProgressRequest{Sequence: r.AssignmentSequence, State: r.State, Current: r.Current,
		Candidate: r.Candidate, Attempt: r.Attempt, Failure: r.Failure, FailedChecks: []string{}, At: r.UpdatedAt}
	for _, h := range r.Health {
		if !h.Ok && len(p.FailedChecks) < 8 {
			p.FailedChecks = append(p.FailedChecks, h.Check)
		}
	}
	p.Waiting = update.WaitingReport(st) // MG-53
	if fd := update.FailureDetail(st); fd != nil {
		r := device.UpdateFailureReport(*fd)
		p.FailureDetail = &r
		if err := p.Validate(); err != nil {
			d.warnOnce("update.progress failure detail does not validate (sent without it)", err)
			p.FailureDetail = nil
		}
	}
	return p
}

// recordReport records st's report in the outbox (reconcile: the journal's newest state at start-up, SR-07).
func (d *Daemon) recordReport(st *update.State, reconcile bool) {
	if d.Control == nil {
		return // nobody to report to (a community box, MG-136)
	}
	put := d.Outbox.Put
	if reconcile {
		put = d.Outbox.Reconcile
	}
	res, err := put(d.progressReport(st), st.JournalSeq)
	d.logDropped(res.Dropped)
	switch res.Outcome {
	case outbox.Stale:
		d.Log.Debug("update.progress report older than the one recorded for its release (not queued)", "seq", st.JournalSeq)
	case outbox.Recorded:
		if reconcile {
			d.Log.Info("update.progress: the journal's state was not recorded in the outbox; queued (SR-07)",
				"state", st.Phase, "seq", st.JournalSeq)
		}
	}
	d.outboxHealth(err)
}

func (d *Daemon) logDropped(dropped []outbox.Entry) {
	for _, e := range dropped {
		args := []any{"release", e.Key, "state", e.Report.State, "sequence", e.Report.Sequence, "attempt", e.Report.Attempt}
		if e.Terminal() {
			d.Log.Error("update.progress outbox full: a final report control has not taken was dropped (SR-06)", args...)
		} else {
			d.Log.Warn("update.progress outbox full: an intermediate report was dropped (SR-06)", args...)
		}
	}
}

// writeProblem describes a failed write stably: the operation and its error, without file names (an atomic write
// names a new temporary file every time).
func writeProblem(err error) string {
	var le *os.LinkError
	var pe *os.PathError
	var errno syscall.Errno
	switch {
	case errors.As(err, &le):
		return le.Op + ": " + le.Err.Error()
	case errors.As(err, &pe):
		return pe.Op + ": " + pe.Err.Error()
	case errors.As(err, &errno):
		return errno.Error()
	}
	return strings.TrimPrefix(err.Error(), outbox.ErrNotDurable.Error()+": ")
}

// outboxHealth logs a change of the outbox's write state and shows a failure in the unit's status line (SR-08): the
// reports are still queued in memory and sent, but a restart would lose those not yet on disk. A change is a
// different writeProblem: every failed write is not logged again.
func (d *Daemon) outboxHealth(err error) {
	problem := ""
	if err != nil {
		problem = writeProblem(err)
	}
	d.statusMu.Lock()
	defer d.statusMu.Unlock() // held while notifying: the last status line sent is the current one
	if problem == d.outboxProblem {
		return
	}
	d.outboxProblem = problem
	if err != nil {
		d.Log.Error("update.progress reports are not written to disk; they are kept in memory and sent, but lost if the manager stops first (SR-08)",
			"err", err)
	} else {
		d.Log.Info("update.progress outbox written again")
	}
	_ = sdnotify.Status(d.statusLineLocked())
}

func (d *Daemon) statusLineLocked() string {
	mode := "normal"
	if d.Recovery {
		mode = "recovery"
	}
	s := "whombat-manager " + d.Cfg.ManagerVersion + " (" + mode + ")"
	if d.outboxProblem != "" {
		s += "; update reports not saved: " + d.outboxProblem
	}
	return s
}

// jitter returns d ± 20 %.
func jitter(d time.Duration) time.Duration {
	return d + time.Duration((rand.Float64()*0.4-0.2)*float64(d))
}

// Backoff grows exponentially with jitter up to max.
type Backoff struct {
	Base, Max time.Duration
	n         int
}

// Next returns the next delay.
func (b *Backoff) Next() time.Duration {
	d := b.Base << min(b.n, 16)
	b.n++
	return jitter(min(d, b.Max))
}

// Reset resets the backoff.
func (b *Backoff) Reset() { b.n = 0 }

func (d *Daemon) warnOnce(key string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	msg := err.Error()
	if d.lastErr[key] != msg {
		d.lastErr[key] = msg
		d.Log.Warn(key, "err", err)
	}
}

// debugOnce is warnOnce at debug level, for failures that are expected on some networks.
func (d *Daemon) debugOnce(key, msg string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.lastErr[key] != err.Error() {
		d.lastErr[key] = err.Error()
		d.Log.Debug(msg, "err", err)
	}
}

func (d *Daemon) clearErr(key string) {
	d.mu.Lock()
	delete(d.lastErr, key)
	d.mu.Unlock()
}

// Run runs the manager until ctx ends (nil: a normal stop, SIGTERM) or an essential component fails (its error).
//
// Readiness (SR-01): READY=1 is sent only once the journal loads and the local API socket accepts connections; the
// runtime, control and TUF are not needed (the appliance runs offline). A failure before that returns at once, with
// nothing started. Failure (SR-02): when the local API stops serving, the other loops are cancelled and get
// DrainTimeout to stop, the socket is closed, and Run returns the failure, so systemd restarts the manager
// (Restart=on-failure; repeated failures start the recovery manager, OnFailure=).
func (d *Daemon) Run(ctx context.Context) error {
	st, err := d.Engine.Load()
	if err != nil {
		return fmt.Errorf("journal: %w (provision the appliance first)", err)
	}
	ln, err := d.Broker.Bind(d.Cfg.APISocket)
	if err != nil {
		return fmt.Errorf("local API: %w", err)
	}
	if err := d.Outbox.LoadErr(); err != nil {
		d.Log.Warn("update.progress outbox unreadable; the journal's state is reported again (SR-07)", "err", err)
	}
	d.recordReport(st, true) // before any loop can persist a newer state

	run, fail := context.WithCancelCause(ctx)
	defer fail(nil)
	var wg sync.WaitGroup
	loops := map[string]func(context.Context){
		"engine": d.engineLoop, "tuf": d.tufLoop, "progress": d.progressLoop, "runtime-sync": d.runtimeSyncLoop,
	}
	if d.Control != nil {
		// Without control nothing polls, reports or looks up a claim code; with it, each call waits for Link (link.go).
		// No licence loop: the licence is inert (LNK-04). The claim lease only for a box control registered before
		// Link: every other box is claimed on its own page.
		loops["control"], loops["status"], loops["link"] = d.controlLoop, d.statusLoop, d.linkLoop
		if d.registeredAtControl {
			loops["claim-lease"] = func(ctx context.Context) { d.whileLinkActive(ctx, d.claimLeaseLoop) }
		}
	}
	if d.Host != nil {
		loops["host-metrics"] = d.Host.Run // MG-63
	}
	if d.OwnAddress != nil {
		// MG-161, only while Link is starting, on or in grace (LNK-05).
		loops["own-address"] = func(ctx context.Context) { d.whileLinkActive(ctx, d.ownAddressLoop) }
	}
	if d.Net != nil {
		loops["network"] = d.networkLoop
		loops["cable-backup"] = d.cableBackupLoop
	}
	if d.Cfg.SupportSocket != "" {
		loops["support-watch"] = d.supportWatchLoop // MG-120
	}
	if d.Cfg.BackupSocket != "" {
		loops["backup-watch"] = d.backupWatchLoop // MG-152
	}
	if d.Clients != nil && !d.Recovery {
		// Recovery mode keeps what is installed and changes nothing (MG-16).
		loops["clients"] = d.Clients.Run
	}
	for name, f := range loops {
		wg.Add(1)
		go func() { defer wg.Done(); f(run); d.Log.Info("loop stopped", "loop", name) }()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		err := d.Broker.Serve(run, ln)
		if err == nil && run.Err() == nil {
			err = errors.New("stopped serving")
		}
		if err != nil {
			fail(fmt.Errorf("local API: %w", err))
		}
	}()
	d.statusMu.Lock()
	status := d.statusLineLocked()
	d.statusMu.Unlock()
	// The runtime's facts and claim window are handed over by runtimeSyncLoop (first probe right away).
	if run.Err() == nil { // not when the local API failed already
		if err := sdnotify.Ready(status); err != nil {
			d.Log.Warn("systemd notify (READY=1)", "err", err)
		}
		d.Log.Info("manager ready", "status", status, "api", d.Cfg.APISocket)
	}

	<-run.Done()
	failure := failureOf(ctx, run)
	if failure != nil {
		d.Log.Error("manager stops after a failure; systemd restarts it (SR-02)", "err", failure)
		// No STOPPING=1: the exit status alone tells systemd this is a failure (Restart=on-failure, OnFailure=).
		_ = sdnotify.Status("stopping after a failure: " + failure.Error())
	} else {
		_ = sdnotify.Notify("STOPPING=1")
	}
	timeout := d.DrainTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	stopped := make(chan struct{})
	go func() { wg.Wait(); close(stopped) }()
	// The engine loop pinged the watchdog last; Run pings it while it drains (SR-02): the drain is bounded by
	// DrainTimeout, so this hides no hang for longer, and a failure ends as one (not as a watchdog timeout).
	var ping <-chan time.Time
	if wd := sdnotify.WatchdogInterval(); wd > 0 {
		t := time.NewTicker(wd)
		defer t.Stop()
		ping = t.C
		_ = sdnotify.Watchdog()
	}
	deadline := time.After(timeout)
	for draining := true; draining; {
		select {
		case <-stopped:
			draining = false
		case <-deadline:
			// The process exits anyway; a normal stop still ends cleanly (no OnFailure= recovery for a slow loop).
			d.Log.Error("loops did not stop in time", "timeout", timeout)
			draining = false
		case <-ping:
			_ = sdnotify.Watchdog()
		}
	}
	return failure
}

// failureOf is why run (a child of ctx) ended: its failure, or nil when ctx ended first (a normal stop). A failure
// stays one when a stop (SIGTERM) follows it: run's cause is ctx's only if ctx ended before the failure.
func failureOf(ctx, run context.Context) error {
	if cause := context.Cause(run); cause != context.Cause(ctx) {
		return cause
	}
	return nil
}

// engineLoop steps the state machine; it is also the watchdog heartbeat: if it stalls, systemd
// restarts the manager (and after repeated failures starts the recovery manager).
func (d *Daemon) engineLoop(ctx context.Context) {
	wd := sdnotify.WatchdogInterval()
	for ctx.Err() == nil {
		wait, err := d.Engine.Step(ctx)
		if err != nil {
			d.warnOnce("engine step", err)
			wait = max(wait, 10*time.Second)
		} else {
			d.clearErr("engine step")
		}
		_ = sdnotify.Watchdog()
		if wd > 0 && wait > wd {
			wait = wd
		}
		if wait <= 0 {
			continue
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		case <-d.engineNow:
		}
	}
}

// tufLoop refreshes metadata periodically. Failures never touch the installed release.
func (d *Daemon) tufLoop(ctx context.Context) {
	every := config.Seconds(d.Cfg.RefreshSec, time.Hour)
	bo := &Backoff{Base: time.Minute, Max: every}
	for ctx.Err() == nil {
		wait := jitter(every)
		if repo, err := d.TUF.Refresh(ctx); err != nil {
			d.warnOnce("TUF refresh failed; the installed release keeps running", err)
			wait = bo.Next()
		} else {
			d.clearErr("TUF refresh failed; the installed release keeps running")
			bo.Reset()
			if d.Clients != nil {
				d.Clients.Poke() // a new client channel is picked up with the metadata (MG-33)
			}
			if d.newestUpdates() {
				// A community box, or one with a channel, takes the newest release of what it just verified (MG-136, LNK-20).
				if _, err := d.offerLatest(ctx, repo, false); err != nil {
					d.warnOnce("newest release not offered; the installed release keeps running", err)
				} else {
					d.clearErr("newest release not offered; the installed release keeps running")
				}
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

// controlLoop polls control for the device's assignment with jittered backoff on failure. Control away (network,
// 5xx, 429) is an outage (MG-62): INFO for its first 10 minutes; any other failure is a warning at once.
func (d *Daemon) controlLoop(ctx context.Context) {
	const failed = "control poll failed; the installed release keeps running"
	poll := config.Seconds(d.Cfg.PollSec, 5*time.Minute)
	bo := &Backoff{Base: min(15*time.Second, poll), Max: 30 * time.Minute}
	var asked []chan<- checkReply // checks this poll answers (MG-67)
	var polled time.Time
	for ctx.Err() == nil {
		if gap := checkGap - time.Since(polled); len(asked) > 0 && gap > 0 {
			select { // checks one after another don't poll control more than every checkGap
			case <-ctx.Done():
				return
			case <-time.After(gap):
			}
		}
		polled = time.Now()
		wait, res, err := d.pollGated(ctx, poll)
		for _, r := range asked {
			r <- checkReply{res, err}
		}
		asked = nil
		switch {
		case err == nil:
			d.reachable(depControl)
			d.clearErr(failed)
			bo.Reset()
		case errors.Is(err, controlapi.ErrUnavailable):
			if ctx.Err() == nil {
				d.unreachable(depControl, failed, err, false)
			}
			wait = bo.Next()
		default:
			d.warnOnce(failed, err)
			wait = bo.Next()
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		case r := <-d.pollNow:
			asked = append(asked, r)
		}
	}
}

// checkGap is the least time between two polls a check asks for (MG-67).
const checkGap = 2 * time.Second

// checkReply is a check's answer: control's for a poll made after the check asked.
type checkReply struct {
	res *broker.CheckResult
	err error
}

// CheckNow has the control loop poll control now and returns what it answered (`whombat-manager check`, MG-67): an
// assignment is verified and offered to the engine as at any poll, and the engine takes it at once (MG-68).
func (d *Daemon) CheckNow(ctx context.Context) (*broker.CheckResult, error) {
	if d.newestUpdates() {
		// A community box (MG-136): its own repository, refreshed now, and its newest release offered.
		repo, err := d.TUF.Refresh(ctx)
		if err != nil {
			return nil, fmt.Errorf("the update repository: %w", err)
		}
		return d.offerLatest(ctx, repo, true)
	}
	if d.Control == nil {
		// No channel and no control this start: nobody assigns this box a release (newestUpdates).
		return &broker.CheckResult{Result: controlapi.ResultNone}, nil
	}
	reply := make(chan checkReply, 1)
	select {
	case d.pollNow <- reply:
	case <-ctx.Done():
		return nil, fmt.Errorf("the control loop didn't take the check: %w", ctx.Err())
	}
	select {
	case r := <-reply:
		return r.res, r.err
	case <-ctx.Done():
		return nil, fmt.Errorf("no answer from control yet: %w", ctx.Err())
	}
}

// wakeEngine has the engine loop step now (MG-68).
func (d *Daemon) wakeEngine() {
	select {
	case d.engineNow <- struct{}{}:
	default: // a wake is pending
	}
}

func (d *Daemon) pollOnce(ctx context.Context, poll time.Duration) (time.Duration, *broker.CheckResult, error) {
	if d.newestUpdates() {
		// A box with a channel takes no assignment from control (LNK-31): the TUF loop offers its channel's newest.
		return jitter(poll), &broker.CheckResult{Result: controlapi.ResultNone, NextCheckS: int64(poll / time.Second)}, nil
	}
	st, err := d.Engine.Load()
	if err != nil {
		return 0, nil, err
	}
	result, raw, next, err := d.Control.Assignment(ctx, st.Current.ReleaseID, st.LastAssignmentSeq)
	if err != nil {
		return 0, nil, err
	}
	d.mu.Lock()
	d.lastChecked = time.Now()
	d.mu.Unlock()
	if next <= 0 {
		next = poll
	}
	res := &broker.CheckResult{Result: result, NextCheckS: int64(next / time.Second)}
	if result != controlapi.ResultAssigned {
		return jitter(next), res, nil // unchanged or none: nothing to verify
	}
	// A new assignment is accepted only against freshly verified metadata.
	repo, err := d.TUF.Refresh(ctx)
	if err != nil {
		return 0, nil, fmt.Errorf("cannot verify assignment without fresh metadata: %w", err)
	}
	o, err := update.VerifyOffer(repo, raw, update.VerifyParams{DeviceID: d.Dev.DeviceID, Env: d.Dev.Env,
		Now: d.TUF.ReferenceTime(), LastSequence: st.LastAssignmentSeq, MaxClockSkew: 5 * time.Minute})
	if err != nil {
		if errors.Is(err, trust.ErrAssignmentReplay) {
			res.Decision = string(update.DecisionNoop)
			return jitter(next), res, nil
		}
		return jitter(next), nil, fmt.Errorf("assignment refused: %w", err)
	}
	dec, why, err := d.Engine.Offer(ctx, *o)
	if err != nil {
		return 0, nil, err
	}
	d.Log.Info("assignment", "sequence", o.Payload.Sequence, "action", o.Payload.Action, "decision", dec, "why", why)
	if dec != update.DecisionNoop {
		d.wakeEngine() // the engine takes it now, not at its next idle step (MG-68)
	}
	res.Decision = string(dec)
	return jitter(next), res, nil
}

// installed is the installed release for the channel's staysOn.
func (d *Daemon) installed() (string, *trust.Versions) {
	st, err := d.Engine.Load()
	if err != nil || st.Current == nil {
		return "", nil
	}
	if r := st.Current.Release; r != nil {
		return st.Current.ReleaseID, &trust.Versions{Host: r.Host.Version, Runtime: r.Runtime.Version, Manager: r.Manager.Version}
	}
	return st.Current.ReleaseID, nil
}

// newestUpdates: the box takes the newest release of its verified repository (a community box, MG-136) or of its
// channel (LNK-20) instead of control's assignments. A commercial box without a channel whose environment didn't
// resolve (no control this start) is neither: its helper takes only assigned releases, so offering the newest would
// be refused at every refresh; it waits for its control instead.
func (d *Daemon) newestUpdates() bool {
	return d.Cfg.Community() || (d.Channel != nil && d.Channel.Current() != "")
}

// assignedUpdates: the box's releases are control's assignments, whatever its Link state (LNK-05): no channel, and a
// control that registered it (a box from before Link; a box that made its identity itself and never turned Link on
// is unknown there).
func (d *Daemon) assignedUpdates() bool {
	return !d.newestUpdates() && d.Control != nil && d.registeredAtControl
}

// offerLatest offers the newest release of a freshly verified repository to the engine (a community box, MG-136) and
// answers as a check would: `none` when nothing is newer, `unchanged` when this repository state was offered before,
// else `assigned` with the engine's decision; the next look is the next TUF refresh. now: the owner's check (or a channel
// change), which offers a channel's release again although it was offered before (Engine.OfferLatestNow).
func (d *Daemon) offerLatest(ctx context.Context, repo *trust.Repo, now bool) (*broker.CheckResult, error) {
	offer := d.Engine.OfferLatest
	if now {
		offer = d.Engine.OfferLatestNow
	}
	dec, why, o, err := offer(ctx, repo, d.Dev.DeviceID, d.Dev.Env)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.lastChecked = time.Now()
	d.mu.Unlock()
	res := &broker.CheckResult{Result: controlapi.ResultNone, NextCheckS: int64(config.Seconds(d.Cfg.RefreshSec, time.Hour) / time.Second)}
	switch {
	case o == nil:
	case dec == update.DecisionNoop && why == "already processed":
		res.Result = controlapi.ResultUnchanged
	default:
		res.Result, res.Decision = controlapi.ResultAssigned, string(dec)
		d.Log.Info("newest release", "release", o.Release.ID(), "targets", o.Payload.Sequence, "decision", dec, "why", why)
		if dec != update.DecisionNoop {
			d.wakeEngine() // the engine takes it now (MG-68)
		}
	}
	return res, nil
}

// progressLoop sends the outbox's reports to control (update.progress, CL-22): onTransition records every persisted
// state there first (SR-03); pending reports are sent in journal order and retried with backoff until control
// accepts them, also across restarts. Facts go to the runtime after every wake.
func (d *Daemon) progressLoop(ctx context.Context) {
	wait := time.Duration(0)
	var retry <-chan time.Time
	flush := func() {
		if d.Outbox.Err() != nil {
			d.outboxHealth(d.Outbox.Sync())
		}
		if d.Control == nil || !d.linkActive() {
			return // nothing is recorded without control (MG-136) or without Link (LNK-03): the outbox keeps it
		}
		pend, err := d.Outbox.Pending()
		if err != nil {
			d.warnOnce("update.progress outbox", err)
			return
		}
		for _, e := range pend {
			err := d.Control.Progress(ctx, e.Report)
			if ctx.Err() != nil {
				return // stopping: the report stays in the outbox
			}
			var he *controlapi.HTTPError
			if err != nil && errors.As(err, &he) && !errors.Is(err, controlapi.ErrUnavailable) && he.Status/100 == 4 &&
				he.Status != http.StatusRequestTimeout && he.Status != http.StatusUnauthorized {
				d.warnOnce("update.progress refused by control (dropped)", err)
				err = nil
			}
			if err != nil {
				if errors.Is(err, controlapi.ErrUnavailable) {
					d.unreachable(depControl, "update.progress report failed (kept; retried with backoff)", err, false)
				} else {
					d.warnOnce("update.progress report failed (kept; retried with backoff)", err)
				}
				wait = min(max(wait*2, d.Waits.ProgressRetry), 5*time.Minute)
				retry = time.After(jitter(wait))
				return
			}
			d.reachable(depControl)
			d.clearErr("update.progress report failed (kept; retried with backoff)")
			d.outboxHealth(d.Outbox.Done(e))
		}
		wait, retry = 0, nil
	}
	flush() // reports left from before a restart, and the journal's state (Run reconciled it)
	for {
		select {
		case <-ctx.Done():
			return
		case <-d.wake:
			if retry == nil {
				flush()
			}
			if err := d.sendFacts(ctx); err == nil {
				d.reachable(depRuntime)
			} else if ctx.Err() == nil {
				// The runtime restarts after every activation (MG-62); runtimeSyncLoop hands the facts over again
				// once it is back.
				d.unreachable(depRuntime, "facts push to the runtime failed", err, d.runtimeRestarting())
			}
		case <-retry:
			retry = nil
			flush()
		}
	}
}

// sendFacts hands the runtime the update facts of the journal and the backup service's status as they are now
// (idempotent: the runtime replaces what it had).
func (d *Daemon) sendFacts(ctx context.Context) error {
	d.factsMu.Lock()
	defer d.factsMu.Unlock()
	st, err := d.Engine.Load()
	if err != nil {
		return err
	}
	d.mu.Lock()
	checked := d.lastChecked
	d.mu.Unlock()
	bk := d.backupFacts(ctx)
	if err := d.Runtime.SendFacts(ctx, broker.UpdateFactsOf(st, checked), bk); err != nil {
		return err
	}
	d.backupSent = backupKey(bk)
	return nil
}

// claimWindowRequired is the configured setting, except on a box control registered (before Whombat Link): there it is
// always off. Such a box is claimed through control, where nothing can open a window: the manager only ever sends a
// closed one, and the screen's New letters opens one only on a box claimed on its own pages. Required there, the box
// could never be claimed.
func (d *Daemon) claimWindowRequired() bool {
	if d.Cfg.ClaimWindowRequired && d.registeredAtControl {
		d.claimWindowIgnored.Do(func() {
			d.Log.Warn("claimWindowRequired is ignored: this Whombat is claimed through Whombat's service, where no claim window can be opened")
		})
		return false
	}
	return d.Cfg.ClaimWindowRequired
}

// syncRuntime hands the runtime everything it keeps only in memory: the update facts, the claim window and
// the claim-code lookup lease (a restarted runtime starts without one and shows "waiting", MG-28), and the licence
// (MG-34).
func (d *Daemon) syncRuntime(ctx context.Context) error {
	if err := d.sendFacts(ctx); err != nil {
		return fmt.Errorf("facts: %w", err)
	}
	if err := d.Runtime.SetClaimWindow(ctx, d.claimWindowRequired(), nil); err != nil {
		return fmt.Errorf("claim window: %w", err)
	}
	// A box is claimed on its own page (Whombat HE-59, LNK-01): no control finds it, no lookup lease; only a box control
	// registered before Link keeps the lease it had.
	if d.Control != nil && d.registeredAtControl {
		if err := d.pushLease(ctx); err != nil {
			return fmt.Errorf("claim lookup: %w", err)
		}
	}
	// The runtime keeps the licence token in its database, but a (re)started runtime may be a restored or older
	// one, and the high-water mark moves with every renewal (LC-06).
	if err := d.pushLicence(ctx); err != nil {
		return fmt.Errorf("licence: %w", err)
	}
	if d.Clients != nil {
		// A (re)started runtime may be a new release with other adapter levels, and it keeps the clients' status
		// in memory only (MG-33).
		if f, err := d.Runtime.RuntimeFacts(ctx); err == nil {
			d.Clients.SetAdapters(&f.ClientAdapters)
		}
		if err := d.Clients.PushNow(ctx); err != nil {
			return fmt.Errorf("clients: %w", err)
		}
	}
	return nil
}

// runtimeSyncLoop keeps the runtime's in-memory copy of the facts, claim window and lease current across runtime
// restarts (MG-27). It probes the runtime's health and re-sends when the runtime becomes reachable (it may
// have started before or after the manager, or restarted), when it turns healthy, when the admin socket is a
// new one (a restart between two probes: every runtime process creates its socket anew, MG-31), after a failed
// send, and every FactsResendSec (jittered) while it answers.
func (d *Daemon) runtimeSyncLoop(ctx context.Context) {
	probe := config.Seconds(d.Cfg.RuntimeProbeSec, 10*time.Second)
	every := config.Seconds(d.Cfg.FactsResendSec, 5*time.Minute)
	var up, healthy bool
	pending := true
	var due time.Time
	var sock string
	for ctx.Err() == nil {
		h, err := d.Runtime.Health(ctx)
		nowUp := err == nil
		nowHealthy := nowUp && h.Status == "ok"
		// The probe ends a runtime outage another call found (MG-62), and keeps an open one going, so a runtime that
		// stays away is a warning after 10 minutes; a failed probe alone opens none (boot, every activation).
		if nowUp {
			d.reachable(depRuntime)
		} else if ctx.Err() == nil && d.outageOpen(depRuntime) {
			d.unreachable(depRuntime, "runtime health probe failed", err, d.runtimeRestarting())
		}
		nowSock := socketIdentity(d.Cfg.Runtime.AdminSocket)
		renewed := nowSock != sock
		sock = nowSock
		if nowUp && (!up || renewed || (nowHealthy && !healthy) || pending || !time.Now().Before(due)) {
			if err := d.syncRuntime(ctx); err != nil {
				pending = true
				d.warnOnce("runtime sync (facts, claim window, lease) failed", err)
			} else {
				pending = false
				due = time.Now().Add(jitter(every))
				d.clearErr("runtime sync (facts, claim window, lease) failed")
			}
		}
		up, healthy = nowUp, nowHealthy
		select {
		case <-ctx.Done():
		case <-time.After(jitter(probe)):
		}
	}
}

// socketIdentity tells one socket file from the next at the same path (device, inode, change time); "" when absent.
func socketIdentity(path string) string {
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d:%d.%d", st.Dev, st.Ino, st.Ctim.Sec, st.Ctim.Nsec)
}

// networkLoop steps the network guard's changes (MG-15, MG-100); a submitted Wi-Fi change wakes it at once.
func (d *Daemon) networkLoop(ctx context.Context) {
	for ctx.Err() == nil {
		wait, err := d.Net.Step(ctx)
		if err != nil {
			d.warnOnce("network guard", err)
			wait = 10 * time.Second
		}
		select {
		case <-ctx.Done():
		case <-d.Net.Woken():
		case <-time.After(max(wait, 200*time.Millisecond)):
		}
	}
}

// cableBackupLoop is the cable as the backup: while the box uses Wi-Fi only, a check of control every minute, and the
// cable used again when Wi-Fi hasn't reached control for five minutes and a cable is plugged in. The first check waits a
// minute too: nothing can have been offline for five minutes at the manager's start, and the helper isn't asked while
// the box is still starting (a socket-activated helper that can't start yet is given up on after a few tries).
func (d *Daemon) cableBackupLoop(ctx context.Context) {
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-time.After(d.Net.BackupEvery()):
		}
		if _, err := d.Net.BackupStep(ctx); err != nil {
			d.warnOnce("network: the cable as the backup", err)
		}
	}
}

func applyPolicy(p *update.Policy, cfg *config.Config) {
	ms := func(v int, dst *time.Duration) {
		if v > 0 {
			*dst = time.Duration(v) * time.Millisecond
		}
	}
	o := cfg.Policy
	ms(o.HealthIntervalMs, &p.HealthInterval)
	ms(o.VerifyTimeoutMs, &p.VerifyTimeout)
	ms(o.HostRebootTimeoutMs, &p.HostRebootTimeout)
	ms(o.RollbackRetryBaseMs, &p.RollbackRetryBase)
	ms(o.RollbackRetryMaxMs, &p.RollbackRetryMax)
	ms(o.DrainPollMs, &p.DrainPoll)
	ms(o.RetryBaseMs, &p.RetryBase)
	ms(o.IdleIntervalMs, &p.IdleInterval)
	if o.HealthyStreak > 0 {
		p.HealthyStreak = o.HealthyStreak
	}
	if o.MaxAttempts > 0 {
		p.MaxAttempts = o.MaxAttempts
	}
}
