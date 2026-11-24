package hub

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"rackoon/internal/hub/ca"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
	"rackoon/internal/wire"
)

// Hub is the running hub.
type Hub struct {
	cfg    Config
	log    *slog.Logger
	store  *store.Store
	ca     *ca.CA
	bus    *Bus
	alerts *rules.Engine
	now    func() time.Time

	startedAt time.Time

	mu      sync.RWMutex
	servers map[string]*srvState

	// selfMACs are the hub machine's own MACs (selfguest.go).
	selfMACs atomic.Pointer[map[string]bool]

	consoles        *consoleRegistry
	consoleCreateMu sync.Mutex
	consolesLive    atomic.Int64 // running console relays
	thumbs          *thumbCache
	actions         *actionTracker
	tasks           *taskWatcher // platform tasks of manage requests
	limits          *limiters

	webauthn   *webauthn.WebAuthn
	ceremonies *ceremonyStore
	oidc       *oidcAuth // single sign-on (nil: off)

	setupMu        sync.Mutex
	setupTokenHash []byte // set while no account exists

	rollupMu   sync.Mutex
	rollupFrom int64

	maint        maintenanceSet
	watch        watchSet // the servers' watch settings (watch.go)
	notify       *notifier
	seriesCache  *seriesCache
	agentTLS     *tls.Config
	listenerCert *listenerCert
	uiCert       *fileCert // --tls-cert, reloaded when the files change

	bg sync.WaitGroup

	lastWatchdog atomic.Int64 // unix ns of the last watchdog run (health check)
	lock         *os.File     // DataDir/hub.lock, held while the hub runs
	closing      atomic.Bool  // shutdown started: refuse new background work

	rollout rollout       // agent self-update rollout
	checks  checkSet      // availability checks
	assist  *assistant    // the AI assistant (docs/ASSIST.md); nil when headless
	svc     *serviceToken // the Whombat server's service token (nil: none)
	lan     lanURL        // --agent-url auto
	addrs   addrState     // the addresses agents are told (addrs.go)
	hold    reconnectHold // heartbeat alerts wait while the hub reconnects (hold.go)

	// Restores (restore.go): when the database was restored (the 14-day
	// adoption), the last staged backup that failed, a backup staged by
	// POST /hub/restore and Run's stop for it.
	restoredAt    atomic.Pointer[time.Time]
	restoreErr    atomic.Pointer[restoreFailure]
	restoreMu     sync.Mutex
	restoreStaged atomic.Bool
	stopCh        chan struct{}
	stopOnce      sync.Once

	hbMu      sync.Mutex // hub heartbeat state
	hbLast    time.Time
	hbFailing bool
}

// srvState is the live state of one server.
type srvState struct {
	meta          store.Server
	report        *proto.Report // immutable once stored
	reportAt      time.Time
	reportGapAt   time.Time // when reports last went missing
	lastFrame     time.Time
	conn          *AgentConn
	skew          *float64
	offline       bool // last announced status was offline
	guestStates   map[string]string
	guestStops    map[string]time.Time // most recent planned stop or restart for each guest
	hostStop      time.Time
	dirty         bool                               // report / last_seen not yet persisted
	reportSavedAt time.Time                          // last time the report was written to the database
	guestSampleTS int64                              // last guest history sample (report time)
	memo          rules.Memo                         // history of the stateful alert rules
	forecast      map[string]float64                 // volume entity -> days until full (forecast job)
	macHelperOff  time.Time                          // a Mac's helper missing from the screen's session since then
	diskUsage     map[string]proto.DiskUsageResponse // mount -> latest on-request breakdown
}

// New opens the data directory and prepares the hub. It prints the
// one-time setup token to setupOut when no account exists yet.
func New(cfg Config, log *slog.Logger, setupOut io.Writer) (*Hub, error) {
	cfg.Defaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	tp := cfg.trusted
	trustedProxyFn.Store(&tp)
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	lock, err := lockDataDir(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	started := false
	defer func() {
		if !started {
			lock.Close()
		}
	}()
	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	// A staged backup is applied before anything opens the database or
	// listens (HS-178).
	staged := applyStagedRestore(context.Background(), cfg.DataDir, nowFn(), log)
	st, err := store.Open(filepath.Join(cfg.DataDir, "hub.db"))
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	authority, err := ca.LoadOrCreate(cfg.DataDir)
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("ca: %w", err)
	}
	h := &Hub{
		cfg: cfg, log: log, store: st, ca: authority, bus: NewBus(), alerts: rules.NewEngine(), now: nowFn, lock: lock,
		startedAt: nowFn(), servers: map[string]*srvState{},
		consoles: newConsoleRegistry(), thumbs: newThumbCache(), actions: newActionTracker(), limits: newLimiters(),
		tasks: newTaskWatcher(), ceremonies: newCeremonyStore(), seriesCache: newSeriesCache(), stopCh: make(chan struct{}),
	}
	h.notify = newNotifier(h)
	h.alerts.Off = h.watch.isOff
	if !cfg.Headless {
		h.assist = newAssistant(h)
	}
	ctx := context.Background()
	if err := h.recordStaged(ctx, staged); err != nil {
		st.Close()
		return nil, err
	}
	h.refreshSelfMACs(ctx)
	if err := h.load(ctx); err != nil {
		st.Close()
		return nil, err
	}
	if cfg.ServiceTokenFile != "" {
		if h.svc, err = loadServiceToken(cfg.ServiceTokenFile, log); err != nil {
			st.Close()
			return nil, err
		}
	}
	if !cfg.Headless {
		if err := h.assist.load(ctx); err != nil {
			st.Close()
			return nil, fmt.Errorf("assistant: %w", err)
		}
		if err := h.initAuth(ctx, setupOut); err != nil {
			st.Close()
			return nil, err
		}
	}
	lan := ""
	if cfg.AgentURLAuto {
		if lan, err = lanAddress(); err != nil {
			log.Warn("--agent-url auto: no LAN address yet", "err", err)
		}
	}
	lc, err := newListenerCert(func() (tls.Certificate, error) {
		return authority.ServerCertificate(cfg.DataDir, cfg.agentHosts(lan))
	})
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("agent listener certificate: %w", err)
	}
	h.listenerCert = lc
	// The agents' address now: a different one than recorded becomes the
	// previous address (HS-172).
	h.currentAgentURL(ctx)
	h.agentTLS = &tls.Config{
		MinVersion:     tls.VersionTLS13,
		GetCertificate: lc.get,
		ClientAuth:     tls.VerifyClientCertIfGiven,
		ClientCAs:      authority.Pool(),
		NextProtos:     []string{"http/1.1"},
	}
	if cfg.TLSCert != "" {
		fc, err := newFileCert(cfg.TLSCert, cfg.TLSKey, func(err error) { log.Error("reloading --tls-cert", "err", err) })
		if err != nil {
			st.Close()
			return nil, fmt.Errorf("--tls-cert: %w", err)
		}
		h.uiCert = fc
	}
	log.Info("hub ready", "data", cfg.DataDir, "ca_sha256", authority.Pin, "servers", len(h.servers), "headless", cfg.Headless)
	started = true
	return h, nil
}

// load restores servers, latest reports and open alerts.
func (h *Hub) load(ctx context.Context) error {
	servers, err := h.store.ListServers(ctx)
	if err != nil {
		return err
	}
	reports, err := h.store.LoadReports(ctx)
	if err != nil {
		return err
	}
	diskUsages, err := h.store.LoadAllDiskUsage(ctx)
	if err != nil {
		return err
	}
	duByServer := map[string]map[string]proto.DiskUsageResponse{}
	for _, du := range diskUsages {
		var resp proto.DiskUsageResponse
		if err := wire.Unmarshal(du.Data, &resp); err != nil || resp.Mount == "" {
			continue
		}
		if duByServer[du.ServerID] == nil {
			duByServer[du.ServerID] = map[string]proto.DiskUsageResponse{}
		}
		duByServer[du.ServerID][du.Mount] = resp
	}
	for _, s := range servers {
		ss := &srvState{meta: s, lastFrame: s.LastSeen, guestStates: map[string]string{}, diskUsage: duByServer[s.ID]}
		if rp, ok := reports[s.ID]; ok {
			var r proto.Report
			if err := wire.Unmarshal(rp.Report, &r); err == nil {
				sanitizeReport(&r)
				h.annotateReport(&r)
				ss.report, ss.reportAt = &r, rp.At
				for _, g := range r.AllGuests() {
					ss.guestStates[model.GuestID(g.Platform, g.ID)] = g.State
				}
			}
		}
		ss.offline = ss.lastFrame.IsZero() || h.now().Sub(ss.lastFrame) >= h.cfg.HeartbeatTimeout
		h.servers[s.ID] = ss
	}
	open, err := h.store.ListAlerts(ctx, rules.AlertOpen, 0)
	if err != nil {
		return err
	}
	// Drop alerts of servers that no longer exist.
	var keep []rules.Alert
	for _, a := range open {
		if _, ok := h.servers[a.Server]; ok || a.Server == "" { // "": hub-level alerts
			keep = append(keep, a)
		}
	}
	h.alerts.Load(keep)
	if err := h.reloadWatch(ctx); err != nil {
		return err
	}
	if err := h.reloadMaintenance(ctx); err != nil {
		return err
	}
	if err := h.notify.load(ctx); err != nil {
		return err
	}
	if err := h.loadChecks(ctx); err != nil {
		return err
	}
	if err := h.loadAddrState(ctx); err != nil {
		return err
	}
	if err := h.loadRestoreState(ctx); err != nil {
		return err
	}
	// An alert left open although its rule is switched off (a restored
	// database, a change that raced an evaluation) resolves now.
	for id := range h.servers {
		h.resolveWatchOff(ctx, id)
	}
	h.rollupFrom = h.now().Add(-store.RawRetention).Unix()
	if v, ok, _ := h.store.GetMeta(ctx, "rollup_done"); ok {
		var t int64
		if _, err := fmt.Sscan(v, &t); err == nil && t > h.rollupFrom {
			h.rollupFrom = t - 180
		}
	}
	return nil
}

// Close releases resources (after Run returned).
func (h *Hub) Close() error {
	err := h.store.Close()
	if h.lock != nil {
		h.lock.Close()
	}
	return err
}

// CAPin returns the CA pin (hex SHA-256 of the CA certificate).
func (h *Hub) CAPin() string { return h.ca.Pin }

// AgentTLSConfig is the TLS configuration of the agent listener.
// The clone also lists the current certificate, so servers that fill in
// a default certificate (httptest) keep the hub's.
func (h *Hub) AgentTLSConfig() *tls.Config {
	c := h.agentTLS.Clone()
	if cur := h.listenerCert.cur.Load(); cur != nil {
		c.Certificates = []tls.Certificate{*cur}
	}
	return c
}

// Store exposes the database (tests, CLI).
func (h *Hub) Store() *store.Store { return h.store }

// Run serves the UI and agent listeners until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) error {
	// Requests and jobs get their own context: it is cancelled only after
	// the console sessions were closed cleanly, not when ctx is.
	srvCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ui := &http.Server{
		Addr: h.cfg.Listen, Handler: h.UIHandler(), ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 120 * time.Second, ErrorLog: slog.NewLogLogger(h.log.Handler(), slog.LevelDebug),
		BaseContext: func(net.Listener) context.Context { return srvCtx },
	}
	agent := &http.Server{
		Addr: h.cfg.AgentListen, Handler: h.AgentHandler(), TLSConfig: h.agentTLS, ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:    slog.NewLogLogger(h.log.Handler(), slog.LevelDebug),
		BaseContext: func(net.Listener) context.Context { return srvCtx },
	}
	uiLn, err := h.listenAPI()
	if err != nil {
		return err
	}
	if _, ok := unixSocket(h.cfg.Listen); ok {
		ui.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
			return context.WithValue(ctx, unixConnKey{}, true)
		}
	}
	agentLn, err := net.Listen("tcp", h.cfg.AgentListen)
	if err != nil {
		uiLn.Close()
		return fmt.Errorf("agent listen %s: %w", h.cfg.AgentListen, err)
	}
	if *h.cfg.AgentProxyProtocol {
		agentLn = &proxyListener{Listener: agentLn, trusted: func(ip net.IP) bool { return ip.IsLoopback() }}
	}
	h.StartJobs(srvCtx)
	errc := make(chan error, 2)
	go func() {
		var err error
		if h.uiCert != nil {
			ui.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: h.uiCert.get}
			err = ui.ServeTLS(uiLn, "", "")
		} else {
			err = ui.Serve(uiLn)
		}
		errc <- err
	}()
	go func() { errc <- agent.ServeTLS(agentLn, "", "") }()
	scheme := "http"
	if h.cfg.TLSCert != "" {
		scheme = "https"
	}
	api := scheme + "://" + uiLn.Addr().String()
	if path, ok := unixSocket(h.cfg.Listen); ok {
		api = "unix:" + path
	}
	agentURL, _ := h.agentURL(nil)
	h.log.Info("listening", "api", api, "agents", "wss://"+agentLn.Addr().String(),
		"public_url", h.cfg.PublicURL, "agent_url", agentURL)
	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errc:
	case <-h.stopCh:
		h.log.Warn("stopping to apply the restored backup; the service manager starts the hub again")
		runErr = ErrRestart
	}
	// No new background work from here on (an action started now would
	// race the wait below).
	h.closing.Store(true)
	// Console sessions first, so they end with a "closed" frame and their
	// audit record before the store closes.
	h.consoles.closeAll("revoked")
	h.waitConsoles(6 * time.Second)
	cancel()
	sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer scancel()
	h.disconnectAll()
	_ = ui.Shutdown(sctx)
	_ = agent.Shutdown(sctx)
	h.consoles.closeAll("revoked")
	h.waitConsoles(3 * time.Second)
	h.bg.Wait()
	h.persist(context.Background(), true)
	h.rollup(context.Background())
	if errors.Is(runErr, http.ErrServerClosed) {
		runErr = nil
	}
	return runErr
}

// listenAPI opens the UI / API listener: TCP, or a Unix socket with
// --socket-mode (a socket file left by an earlier run is replaced).
func (h *Hub) listenAPI() (net.Listener, error) {
	path, ok := unixSocket(h.cfg.Listen)
	if !ok {
		ln, err := net.Listen("tcp", h.cfg.Listen)
		if err != nil {
			return nil, fmt.Errorf("listen %s: %w", h.cfg.Listen, err)
		}
		if a, ok := ln.Addr().(*net.TCPAddr); ok && h.cfg.Headless && !a.IP.IsLoopback() {
			h.log.Warn("headless API on a network address: anyone with the service token can use it; prefer --listen unix:/path",
				"listen", h.cfg.Listen)
		}
		return ln, nil
	}
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("listen %s: the file exists and is not a socket", h.cfg.Listen)
		}
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return nil, fmt.Errorf("listen %s: another process serves this socket", h.cfg.Listen)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("listen %s: %w", h.cfg.Listen, err)
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", h.cfg.Listen, err)
	}
	if err := os.Chmod(path, h.cfg.SocketMode); err != nil {
		ln.Close()
		return nil, fmt.Errorf("listen %s: %w", h.cfg.Listen, err)
	}
	return ln, nil
}

// waitConsoles waits (bounded) for running console relays to finish.
func (h *Hub) waitConsoles(d time.Duration) {
	deadline := time.Now().Add(d)
	for h.consolesLive.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *Hub) disconnectAll() {
	h.mu.RLock()
	var conns []*AgentConn
	for _, s := range h.servers {
		if s.conn != nil {
			conns = append(conns, s.conn)
		}
	}
	h.mu.RUnlock()
	for _, c := range conns {
		c.Close()
	}
}

// ---- helpers ------------------------------------------------------------------

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func newID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func sha(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// snapshot returns the model state of every server in card order.
func (h *Hub) snapshot() []*model.ServerState {
	type item struct {
		st      *model.ServerState
		created time.Time
	}
	h.mu.RLock()
	parents := h.detectParentsLocked()
	items := make([]item, 0, len(h.servers))
	for _, s := range h.servers {
		items = append(items, item{h.stateOf(s, parents), s.meta.CreatedAt})
	}
	h.mu.RUnlock()
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].created.Equal(items[j].created) {
			return items[i].created.Before(items[j].created)
		}
		return items[i].st.ID < items[j].st.ID
	})
	now := h.now()
	byID := map[string]*model.ServerState{}
	for _, it := range items {
		byID[it.st.ID] = it.st
	}
	out := make([]*model.ServerState, len(items))
	for i, it := range items {
		it.st.Open = h.alerts.Open(it.st.ID)
		it.st.Maintenance = h.maint.activeFor(it.st.ID, it.st.Group, now)
		if p := byID[it.st.Parent]; p != nil {
			it.st.ParentOffline = !p.Online(now)
		}
		out[i] = it.st
	}
	return out
}

// snapshotOne returns one server's state.
func (h *Hub) snapshotOne(id string) (*model.ServerState, bool) {
	h.mu.RLock()
	s, ok := h.servers[id]
	var st *model.ServerState
	var parent *model.ServerState
	if ok {
		parents := h.detectParentsLocked()
		st = h.stateOf(s, parents)
		if ps, pok := h.servers[st.Parent]; pok && st.Parent != "" {
			parent = h.stateOf(ps, parents)
		}
	}
	h.mu.RUnlock()
	if !ok {
		return nil, false
	}
	now := h.now()
	st.Open = h.alerts.Open(id)
	st.Maintenance = h.maint.activeFor(st.ID, st.Group, now)
	if parent != nil {
		st.ParentOffline = !parent.Online(now)
	}
	return st, true
}

// stateOf converts (caller holds h.mu).
func (h *Hub) stateOf(s *srvState, parents map[string]string) *model.ServerState {
	addr := s.meta.Address
	st := &model.ServerState{
		ID: s.meta.ID, Hostname: s.meta.Hostname, Group: s.meta.Group, Location: s.meta.Location, Address: addr,
		RCConsole: s.meta.RCConsole, RCPower: s.meta.RCPower, RCHostShell: s.meta.RCHostShell, RCHostPower: s.meta.RCHostPower,
		RCManage: s.meta.RCManage, RCDiagnose: s.meta.RCDiagnose, Report: s.report, ReportAt: s.reportAt,
		LastSeen: s.lastFrame, Connected: s.conn != nil, Via: s.conn.Via(), ClockSkewS: s.skew, AgentVersion: s.meta.AgentVersion,
		HeartbeatTimeout: h.cfg.HeartbeatTimeout,
		ParentSetting:    s.meta.Parent, DetectedParent: parents[s.meta.ID],
		Forecast: s.forecast, MacHelperOffSince: s.macHelperOff,
	}
	if len(s.diskUsage) > 0 {
		st.DiskUsage = make(map[string]proto.DiskUsageResponse, len(s.diskUsage))
		for k, v := range s.diskUsage {
			st.DiskUsage[k] = v
		}
	}
	switch s.meta.Parent {
	case "":
		st.Parent = st.DetectedParent
	case "-":
	default:
		if _, ok := h.servers[s.meta.Parent]; ok {
			st.Parent = s.meta.Parent
		}
	}
	return st
}

// detectParentsLocked finds, for each server, the enrolled host it runs on:
// another server with a guest whose name is the server's host name (short
// form, case-insensitive) or whose addresses include the server's address.
// Caller holds h.mu.
func (h *Hub) detectParentsLocked() map[string]string {
	out := map[string]string{}
	if len(h.servers) < 2 {
		return out
	}
	short := func(n string) string {
		n = strings.ToLower(strings.TrimSpace(n))
		if i := strings.IndexByte(n, '.'); i > 0 {
			n = n[:i]
		}
		return n
	}
	byName := map[string]string{} // guest short name -> host id ("" = ambiguous)
	byAddr := map[string]string{}
	for id, s := range h.servers {
		if s.report == nil {
			continue
		}
		for _, g := range s.report.AllGuests() {
			names := []string{short(g.Name), short(g.ID)}
			if g.Platform == proto.PlatformDocker {
				names = nil // application containers do not run a host's agent
			}
			for _, n := range names {
				if n == "" {
					continue
				}
				if prev, ok := byName[n]; ok && prev != id {
					byName[n] = ""
				} else {
					byName[n] = id
				}
			}
			for _, a := range g.Addresses {
				byAddr[a] = id
			}
		}
	}
	for id, s := range h.servers {
		var addrs []string
		if s.meta.Address != "" {
			addrs = append(addrs, s.meta.Address)
		}
		if s.report != nil {
			addrs = append(addrs, s.report.Host.Addresses...)
		}
		parent := ""
		for _, a := range addrs {
			if p, ok := byAddr[strings.SplitN(a, "/", 2)[0]]; ok && p != id {
				parent = p
				break
			}
		}
		if parent == "" {
			if p := byName[short(s.meta.Hostname)]; p != "" && p != id {
				parent = p
			}
		}
		if parent != "" {
			out[id] = parent
		}
	}
	return out
}

// conn returns the live agent connection of a server.
func (h *Hub) conn(id string) *AgentConn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if s, ok := h.servers[id]; ok {
		return s.conn
	}
	return nil
}

// ---- report sanitizing --------------------------------------------------------

const (
	maxGuests  = 5000
	maxItems   = 512
	maxStrLen  = 512
	maxLabel   = 128
	maxSensors = 32
)

func clampStr(s *string, n int) {
	if len(*s) > n {
		*s = (*s)[:n]
	}
}

func finite(f *float64) {
	if math.IsNaN(*f) || math.IsInf(*f, 0) {
		*f = 0
	}
}

func finiteP(f **float64) {
	if *f != nil && (math.IsNaN(**f) || math.IsInf(**f, 0)) {
		*f = nil
	}
}

// sanitizeReport bounds an untrusted report: list lengths, string lengths,
// non-finite numbers (which JSON cannot encode) and duplicate guest ids.
func sanitizeReport(r *proto.Report) {
	for _, p := range []*string{&r.Host.Hostname, &r.Host.OSName, &r.Host.OSVersion, &r.Host.OSPretty, &r.Host.Kernel,
		&r.Host.CPUModel, &r.Host.MemoryType, &r.Host.MachineID, &r.Host.Virtual, &r.Agent.Version, &r.Agent.Install,
		&r.Agent.Arch, &r.Agent.UpdateKey, &r.Agent.OS} {
		clampStr(p, maxLabel)
	}
	if len(r.Agent.Caps) > 16 {
		r.Agent.Caps = r.Agent.Caps[:16]
	}
	for i := range r.Agent.Caps {
		clampStr(&r.Agent.Caps[i], 32)
	}
	if m := r.MacOS; m != nil {
		for _, p := range []*string{&m.Version, &m.Build, &m.Model, &m.ModelName, &m.Chip, &m.AutoLogin, &m.ConsoleUser,
			&m.Screen.Account, &m.Screen.SignIn, &m.Helper.Version, &m.Helper.User, &m.AgentFolder} {
			clampStr(p, maxLabel)
		}
		if m.Screen.SignIn != "ok" && m.Screen.SignIn != "failed" {
			m.Screen.SignIn = ""
		}
		if m.Screen.Width < 0 || m.Screen.Width > 65535 || m.Screen.Height < 0 || m.Screen.Height > 65535 {
			m.Screen.Width, m.Screen.Height = 0, 0
		}
	}
	finite(&r.CPU.StealPct)
	if len(r.Host.Addresses) > 16 {
		r.Host.Addresses = r.Host.Addresses[:16]
	}
	for _, f := range []*float64{&r.CPU.UsagePct, &r.CPU.UserPct, &r.CPU.SystemPct, &r.CPU.IOWaitPct, &r.CPU.Load[0],
		&r.CPU.Load[1], &r.CPU.Load[2], &r.Agent.CPUPct} {
		finite(f)
	}
	if len(r.Sensors) > maxSensors {
		r.Sensors = r.Sensors[:maxSensors]
	}
	for i := range r.Sensors {
		s := &r.Sensors[i]
		for _, p := range []*string{&s.ID, &s.Label, &s.Group, &s.Source} {
			clampStr(p, maxLabel)
		}
		finite(&s.TempC)
		finite(&s.LimitC)
	}
	if len(r.Disks) > maxItems {
		r.Disks = r.Disks[:maxItems]
	}
	for i := range r.Disks {
		d := &r.Disks[i]
		for _, p := range []*string{&d.Device, &d.Type, &d.Model, &d.Serial, &d.Role, &d.Pool} {
			clampStr(p, maxStrLen)
		}
		finiteP(&d.WearPct)
		finiteP(&d.RatedTBW)
		finiteP(&d.TempC)
		finiteP(&d.SparePct)
		finiteP(&d.SpareThreshold)
		if d.IO != nil {
			for _, f := range []*float64{&d.IO.ReadBps, &d.IO.WriteBps, &d.IO.ReadIOPS, &d.IO.WriteIOPS, &d.IO.UtilPct, &d.IO.AwaitMs} {
				finite(f)
			}
		}
		if d.SelfTest != nil {
			clampStr(&d.SelfTest.Type, maxLabel)
			clampStr(&d.SelfTest.Result, maxLabel)
		}
	}
	if len(r.Filesystems) > maxItems {
		r.Filesystems = r.Filesystems[:maxItems]
	}
	for i := range r.Filesystems {
		clampStr(&r.Filesystems[i].Error, maxStrLen)
	}
	if len(r.Pools) > maxItems {
		r.Pools = r.Pools[:maxItems]
	}
	for i := range r.Pools {
		p := &r.Pools[i]
		clampStr(&p.ScrubState, maxLabel)
		clampStr(&p.Status, maxStrLen)
		p.Faulted = clampList(p.Faulted, 32, maxLabel)
		finiteP(&p.FragPct)
	}
	if sy := r.System; sy != nil {
		for _, p := range []*string{&sy.PackageManager, &sy.InitSystem, &sy.TimeSource, &sy.Arch} {
			clampStr(p, maxLabel)
		}
		clampStr(&sy.UpdatesError, maxStrLen)
		clampStr(&sy.RebootReason, maxStrLen)
		sy.FailedUnits = clampList(sy.FailedUnits, 32, maxLabel)
		finiteP(&sy.TimeOffsetMs)
		if len(sy.OOMLimited) > proto.OOMLimitedMax {
			sy.OOMLimited = sy.OOMLimited[len(sy.OOMLimited)-proto.OOMLimitedMax:]
		}
		for i := range sy.OOMLimited {
			k := &sy.OOMLimited[i]
			clampStr(&k.Process, maxLabel)
			clampStr(&k.Cgroup, maxStrLen)
			clampStr(&k.Platform, maxLabel)
			clampStr(&k.GuestID, maxStrLen)
		}
		if sy.OOMLimitKills != nil && *sy.OOMLimitKills > sy.OOMKills {
			n := sy.OOMKills
			sy.OOMLimitKills = &n
		}
	}
	if ps := r.Pressure; ps != nil {
		for _, f := range []*float64{&ps.CPUSome, &ps.MemorySome, &ps.MemoryFull, &ps.IOSome, &ps.IOFull} {
			finite(f)
		}
	}
	if len(r.Net) > 64 {
		r.Net = r.Net[:64]
	}
	for i := range r.Net {
		n := &r.Net[i]
		for _, p := range []*string{&n.Name, &n.Kind, &n.MAC, &n.Master} {
			clampStr(p, maxLabel)
		}
		n.Addresses = clampList(n.Addresses, 16, maxLabel)
		n.Members = clampList(n.Members, 16, maxLabel)
		finite(&n.RxBps)
		finite(&n.TxBps)
	}
	if len(r.RAID) > 32 {
		r.RAID = r.RAID[:32]
	}
	for i := range r.RAID {
		a := &r.RAID[i]
		for _, p := range []*string{&a.Name, &a.Level, &a.State} {
			clampStr(p, maxLabel)
		}
		a.Members = clampList(a.Members, 64, maxLabel)
		a.Failed = clampList(a.Failed, 64, maxLabel)
		finiteP(&a.SyncPct)
	}
	if len(r.UPS) > 8 {
		r.UPS = r.UPS[:8]
	}
	for i := range r.UPS {
		u := &r.UPS[i]
		for _, p := range []*string{&u.Name, &u.Source, &u.Model, &u.Status, &u.StatusRaw} {
			clampStr(p, maxLabel)
		}
		finiteP(&u.ChargePct)
		finiteP(&u.LoadPct)
	}
	if len(r.GPUs) > 16 {
		r.GPUs = r.GPUs[:16]
	}
	for i := range r.GPUs {
		g := &r.GPUs[i]
		clampStr(&g.Name, maxLabel)
		clampStr(&g.Vendor, maxLabel)
		finiteP(&g.UtilPct)
		finiteP(&g.TempC)
		finiteP(&g.PowerW)
	}
	if len(r.Fans) > maxSensors {
		r.Fans = r.Fans[:maxSensors]
	}
	for i := range r.Fans {
		f := &r.Fans[i]
		clampStr(&f.Label, maxLabel)
		clampStr(&f.Source, maxLabel)
		finite(&f.RPM)
		finite(&f.MinRPM)
	}
	if len(r.Checks) > 200 {
		r.Checks = r.Checks[:200]
	}
	if len(r.Collectors) > 64 {
		r.Collectors = r.Collectors[:64]
	}
	for i := range r.Collectors {
		clampStr(&r.Collectors[i].Name, maxLabel)
		clampStr(&r.Collectors[i].Error, maxStrLen)
	}
	sanGuests := func(gs []proto.Guest) []proto.Guest {
		if len(gs) > maxGuests {
			gs = gs[:maxGuests]
		}
		seen := map[string]bool{}
		out := gs[:0]
		for _, g := range gs {
			if g.ID == "" || seen[g.ID] {
				continue
			}
			seen[g.ID] = true
			for _, p := range []*string{&g.ID, &g.Name, &g.Kind, &g.Image, &g.State, &g.OSType, &g.Firmware, &g.MachineType,
				&g.HealthCheckText, &g.Node, &g.Console.Default, &g.Console.Resolution, &g.Lock, &g.Project, &g.GuestAgent, &g.HAState} {
				clampStr(p, maxStrLen)
			}
			g.Addresses = clampList(g.Addresses, 16, maxLabel)
			g.Tags = clampList(g.Tags, 32, maxLabel)
			if g.PendingChanges < 0 {
				g.PendingChanges = 0
			}
			if g.Kind != "vm" && g.Kind != "container" {
				g.Kind = "container"
			}
			switch g.State {
			case proto.StateRunning, proto.StateStopped, proto.StateUnhealthy, proto.StatePaused:
			default:
				g.State = proto.StateStopped
			}
			for _, f := range []**float64{&g.CPUPct, &g.DiskReadBps, &g.DiskWriteBps, &g.NetRxBps, &g.NetTxBps} {
				finiteP(f)
			}
			if len(g.Console.Protocols) > 8 {
				g.Console.Protocols = g.Console.Protocols[:8]
			}
			if len(g.Console.Unavailable) > 8 {
				g.Console.Unavailable = nil
			}
			out = append(out, g)
		}
		return out
	}
	for _, p := range []*proto.Platform{r.Docker, r.Incus, r.Libvirt} {
		if p != nil {
			clampStr(&p.Error, maxStrLen)
			clampStr(&p.Version, maxLabel)
			p.Guests = sanGuests(p.Guests)
			if len(p.Warnings) > 64 {
				p.Warnings = p.Warnings[:64]
			}
			if len(p.Tasks) > 100 {
				p.Tasks = p.Tasks[len(p.Tasks)-100:]
			}
			for i := range p.Tasks {
				t := &p.Tasks[i]
				for _, s := range []*string{&t.UPID, &t.Type, &t.ID, &t.Node, &t.User} {
					clampStr(s, maxLabel)
				}
				clampStr(&t.Status, maxStrLen)
			}
			for i := range p.Warnings {
				w := &p.Warnings[i]
				clampStr(&w.Type, maxLabel)
				clampStr(&w.Message, maxStrLen)
				clampStr(&w.Project, maxLabel)
			}
		}
	}
	if r.PVE != nil {
		r.PVE.Guests = sanGuests(r.PVE.Guests)
		clampStr(&r.PVE.Error, maxStrLen)
		if len(r.PVE.Nodes) > 64 {
			r.PVE.Nodes = r.PVE.Nodes[:64]
		}
		for i := range r.PVE.Nodes {
			finite(&r.PVE.Nodes[i].CPUPct)
			finite(&r.PVE.Nodes[i].MemPct)
		}
		if len(r.PVE.Storages) > maxItems {
			r.PVE.Storages = r.PVE.Storages[:maxItems]
		}
		if len(r.PVE.Templates) > maxGuests {
			r.PVE.Templates = r.PVE.Templates[:maxGuests]
		}
		for i := range r.PVE.Templates {
			t := &r.PVE.Templates[i]
			for _, p := range []*string{&t.ID, &t.Name, &t.Kind, &t.Node} {
				clampStr(p, maxStrLen)
			}
		}
		if b := r.PVE.Backups; b != nil && b.LastJob != nil {
			finiteP(&b.LastJob.DedupRatio)
		}
		if len(r.PVE.Tasks) > 200 {
			r.PVE.Tasks = r.PVE.Tasks[:200]
		}
		for i := range r.PVE.Tasks {
			t := &r.PVE.Tasks[i]
			for _, p := range []*string{&t.UPID, &t.Type, &t.ID, &t.Node, &t.User} {
				clampStr(p, maxLabel)
			}
			clampStr(&t.Status, maxStrLen)
		}
		if len(r.PVE.Replication) > maxItems {
			r.PVE.Replication = r.PVE.Replication[:maxItems]
		}
		for i := range r.PVE.Replication {
			x := &r.PVE.Replication[i]
			for _, p := range []*string{&x.ID, &x.Guest, &x.Target} {
				clampStr(p, maxLabel)
			}
			clampStr(&x.Error, maxStrLen)
		}
		if c := r.PVE.Ceph; c != nil {
			clampStr(&c.Status, maxLabel)
			c.Summary = clampList(c.Summary, 16, maxStrLen)
		}
	}
}

// clampList bounds a list of strings and each string.
func clampList(l []string, n, size int) []string {
	if len(l) > n {
		l = l[:n]
	}
	for i := range l {
		clampStr(&l[i], size)
	}
	return l
}
