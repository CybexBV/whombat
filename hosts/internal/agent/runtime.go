package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/checks"
	"rackoon/internal/netaddrs"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Subprotocol is the WebSocket subprotocol of the agent connection;
// LegacySubprotocol is Rackoon's name for the same protocol, offered too,
// so the agent connects to a Rackoon hub as well.
const (
	Subprotocol       = "whombat.agent.v1"
	LegacySubprotocol = "rackoon.agent.v1"
)

// ConnectPath is the hub's agent connection endpoint.
const ConnectPath = "/agent/v1/connect"

// MaxConsoleSessions is the agent-side limit of concurrent consoles.
const MaxConsoleSessions = 20

// Runtime is the long-running agent: it collects reports, keeps one
// connection to the hub, buffers samples while offline and serves the
// hub's action, thumbnail and console streams.
type Runtime struct {
	Collector Collector
	Broker    Broker // may be nil (no remote control support)
	// Diagnostics serves the assistant's diagnose and exec streams; nil
	// answers them with unsupported.
	Diagnostics Diagnostics
	// Screen serves the screen stream (a Mac's screen); nil answers it with
	// unsupported.
	Screen Screen
	// DiskUsage serves the on-request disk usage stream; nil answers it with
	// unsupported.
	DiskUsage DiskUsage
	Version   string
	Log       *slog.Logger

	// Tunables; NewRuntime sets the production values, tests shorten them.
	ReportInterval time.Duration
	EventDebounce  time.Duration
	BackoffMin     time.Duration
	BackoffMax     time.Duration
	PersistEvery   time.Duration
	ConsoleOpenMax time.Duration // bound for Broker.Console
	MaxConsoles    int
	RenewJitter    time.Duration // spread of the renewal reconnects

	cfgMu sync.RWMutex
	cfg   *Config

	idMu sync.RWMutex
	id   *Identity

	buf     *Buffer
	latest  atomic.Pointer[proto.Report]
	seq     atomic.Uint64
	started time.Time
	self    selfStats

	consoleMu sync.Mutex
	consoleN  int

	connMu sync.Mutex
	conn   *hubConn // set while connected and past the initial backfill

	connected  atomic.Bool
	errLog     rateLimitedLog
	collectNow chan struct{}

	// Self-update (update.go). Updater nil: updates are refused. Restart
	// is set by the caller of Run: it ends Run so the caller re-executes
	// the agent (after an update or a rollback).
	Updater *Updater
	Restart func()
	upd     selfUpdate
	// Helper installs Whombat Helper sent on the update stream (a Mac's
	// screen part); nil: the agent doesn't report CapHelperUpdate.
	Helper HelperUpdater

	// Checks the hub assigned (MsgChecks), reported in Report.Checks.
	checksOnce sync.Once
	checks     *checks.Runner

	// Reported in AgentInfo: connections made after the first one, and
	// events that could not be handed to a hub connection.
	connects      atomic.Uint64
	droppedEvents atomic.Uint64

	// Finding the hub (hubsearch.go): search after SearchFailures network
	// or TLS failures in a row over at least SearchAfter, again after each
	// of SearchDelays, then every SearchEvery; a probe connects within
	// SearchConnectTimeout and finishes its TLS handshake within
	// SearchHandshakeTimeout, SearchParallel at a time. Interfaces,
	// DialContext and Now replace the machine's interfaces, the dialer
	// (hub connection and search) and the clock in tests.
	SearchAfter            time.Duration
	SearchFailures         int
	SearchDelays           []time.Duration
	SearchEvery            time.Duration
	SearchConnectTimeout   time.Duration
	SearchHandshakeTimeout time.Duration
	SearchParallel         int
	Interfaces             func() ([]netaddrs.Interface, error)
	DialContext            func(ctx context.Context, network, addr string) (net.Conn, error)
	Now                    func() time.Time

	hubAddrMu sync.Mutex
	hubAddrs  []string // the hub's addresses (hub-addresses.json)

	moveMu sync.Mutex
	move   moveState // a move to another of the hub's addresses (hubmove.go)
}

// NewRuntime returns a runtime for cfg. Set Collector (required) and Broker
// before calling Run.
func NewRuntime(cfg *Config, version string, log *slog.Logger) *Runtime {
	if log == nil {
		log = slog.Default()
	}
	return &Runtime{
		Version:        version,
		Log:            log,
		ReportInterval: proto.ReportInterval,
		EventDebounce:  2 * time.Second,
		BackoffMin:     time.Second,
		BackoffMax:     60 * time.Second,
		PersistEvery:   time.Minute,
		ConsoleOpenMax: 45 * time.Second,
		MaxConsoles:    MaxConsoleSessions,
		RenewJitter:    time.Hour,
		SearchAfter:    time.Minute,
		SearchFailures: 3,
		SearchDelays:   []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute},
		SearchEvery:    15 * time.Minute,
		// 300 ms to connect, 64 at a time: a /22 on one port in about 5 s.
		SearchConnectTimeout:   300 * time.Millisecond,
		SearchHandshakeTimeout: 5 * time.Second,
		SearchParallel:         64,
		cfg:                    cfg,
		started:                time.Now().UTC(),
		collectNow:             make(chan struct{}, 1),
		buf:                    NewBuffer(filepath.Join(cfg.StateDir, BufferFileName)),
	}
}

// Config returns the current configuration.
func (rt *Runtime) Config() *Config {
	rt.cfgMu.RLock()
	defer rt.cfgMu.RUnlock()
	return rt.cfg
}

// Policy returns the local remote-control policy.
func (rt *Runtime) Policy() proto.Policy { return rt.Config().Policy() }

// Inventory returns the most recent report (nil before the first one). It
// is the broker's agent.InventoryFunc.
func (rt *Runtime) Inventory() *proto.Report { return rt.latest.Load() }

// Connected reports whether the hub connection is up.
func (rt *Runtime) Connected() bool { return rt.connected.Load() }

// Reload re-reads agent.toml and applies what can change while the agent
// runs: [remote_control] and the [collectors] toggles (the collector picks
// those up at its next run). Every other setting (hub, ca_sha256,
// state_dir, [pve], ...) needs a restart; a change to one is logged as
// such and not applied. The log names exactly what changed.
func (rt *Runtime) Reload() error {
	old := rt.Config()
	c, err := LoadConfig(old.Dir)
	if err != nil {
		return err
	}
	rt.cfgMu.Lock()
	n := *old
	n.RemoteControl = c.RemoteControl
	n.Update = c.Update
	n.Collectors = c.Collectors
	rt.cfg = &n
	rt.cfgMu.Unlock()
	if sc, ok := rt.Collector.(interface{ SetCollectors(Collectors) }); ok {
		sc.SetCollectors(c.Collectors)
	}
	if ca, ok := rt.Broker.(configApplier); ok {
		go ca.ApplyConfig(context.Background(), &n)
	}

	var applied, restart []string
	ov, nv := reflect.ValueOf(*old), reflect.ValueOf(*c)
	for i := 0; i < ov.NumField(); i++ {
		f := ov.Type().Field(i)
		name := tomlName(f)
		if name == "" {
			continue // Dir and other runtime-only fields
		}
		d := configDiff(name, ov.Field(i), nv.Field(i))
		switch f.Name {
		case "RemoteControl", "Update", "Collectors":
			applied = append(applied, d...)
		default:
			restart = append(restart, d...)
		}
	}
	switch {
	case len(applied) > 0:
		rt.Log.Info("configuration reloaded", "applied", strings.Join(applied, ", "))
	case len(restart) == 0:
		rt.Log.Info("configuration reloaded: no changes")
	}
	if len(restart) > 0 {
		rt.Log.Warn("configuration changes need an agent restart and were not applied", "changed", strings.Join(restart, ", "))
	}
	return nil
}

// configApplier is implemented by brokers that act on the configuration
// (the Proxmox VE manage token, docs/MANAGE.md 2.2). The runtime calls it
// at start and after every reload, in the background.
type configApplier interface {
	ApplyConfig(ctx context.Context, cfg *Config)
}

// tomlName returns the agent.toml key of a struct field ("" for fields
// that are not read from the file).
func tomlName(f reflect.StructField) string {
	tag, _, _ := strings.Cut(f.Tag.Get("toml"), ",")
	if tag == "-" || !f.IsExported() {
		return ""
	}
	if tag == "" {
		return strings.ToLower(f.Name)
	}
	return tag
}

// configDiff lists the settings that differ between a and b as
// "collectors.docker: auto -> false" (nested tables are walked; unset
// collector toggles read "auto").
func configDiff(name string, a, b reflect.Value) []string {
	if a.Kind() == reflect.Struct {
		var out []string
		for i := 0; i < a.NumField(); i++ {
			if n := tomlName(a.Type().Field(i)); n != "" {
				out = append(out, configDiff(name+"."+n, a.Field(i), b.Field(i))...)
			}
		}
		return out
	}
	if reflect.DeepEqual(a.Interface(), b.Interface()) {
		return nil
	}
	return []string{name + ": " + configValue(a) + " -> " + configValue(b)}
}

func configValue(v reflect.Value) string {
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return "auto"
		}
		return configValue(v.Elem())
	case reflect.String:
		return fmt.Sprintf("%q", v.String())
	}
	return fmt.Sprint(v.Interface())
}

func (rt *Runtime) identity() *Identity {
	rt.idMu.RLock()
	defer rt.idMu.RUnlock()
	return rt.id
}

// Run runs the agent until ctx is cancelled. It returns an error only when
// the agent cannot start (not enrolled, unreadable identity).
func (rt *Runtime) Run(ctx context.Context) error {
	if rt.Collector == nil {
		return errors.New("runtime: no collector")
	}
	cfg := rt.Config()
	if cfg.Hub == "" {
		return fmt.Errorf("%s: hub is not set (run `whombat-agent enroll` first)", filepath.Join(cfg.Dir, ConfigFileName))
	}
	id, err := LoadIdentity(cfg)
	if err != nil {
		return fmt.Errorf("agent identity: %w (run `whombat-agent enroll` first)", err)
	}
	rt.idMu.Lock()
	rt.id = id
	rt.idMu.Unlock()
	if time.Now().After(id.Cert.NotAfter) {
		rt.Log.Error("client certificate has expired; enroll the agent again", "not_after", id.Cert.NotAfter)
	}

	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		rt.Log.Warn("cannot create state dir; buffer is memory-only", "dir", cfg.StateDir, "err", err)
		rt.buf.setPath("")
	}
	if err := rt.buf.Load(); errors.Is(err, ErrBufferUnreadable) {
		rt.Log.Warn("sample buffer file was unusable; starting with an empty buffer", "err", err)
	} else if err != nil {
		rt.Log.Warn("cannot load sample buffer", "err", err)
	} else if n := rt.buf.Len(); n > 0 {
		rt.Log.Info("loaded buffered samples", "count", n)
	}
	rt.hubAddrMu.Lock()
	rt.hubAddrs = loadHubAddrs(cfg.StateDir)
	rt.hubAddrMu.Unlock()

	rt.Log.Info("agent starting", "version", rt.Version, "hub", cfg.Hub, "server", id.Cert.Subject.CommonName,
		"console", cfg.RemoteControl.Console, "power", cfg.RemoteControl.Power,
		"host_shell", cfg.RemoteControl.HostShell, "host_power", cfg.RemoteControl.HostPower,
		"manage", cfg.RemoteControl.Manage, "diagnose", cfg.DiagnoseAllowed(),
		"update", cfg.UpdateAllowed(), "update_key", UpdateKeyFingerprint())

	var wg sync.WaitGroup
	if ca, ok := rt.Broker.(configApplier); ok {
		wg.Add(1)
		go func() { defer wg.Done(); ca.ApplyConfig(ctx, cfg) }()
	}
	wg.Add(2)
	go func() { defer wg.Done(); rt.collectLoop(ctx) }()
	go func() { defer wg.Done(); rt.persistLoop(ctx) }()
	wg.Add(1)
	go func() { defer wg.Done(); rt.checkRunner().Run(ctx) }()

	rt.connectLoop(ctx)

	wg.Wait()
	if err := rt.buf.Save(); err != nil {
		rt.Log.Warn("cannot save sample buffer", "err", err)
	}
	rt.Log.Info("agent stopped")
	return nil
}

// ---- collection --------------------------------------------------------------

func (rt *Runtime) collectLoop(ctx context.Context) {
	events := rt.Collector.Events()
	rt.collectOnce(ctx)
	ticker := time.NewTicker(rt.ReportInterval)
	defer ticker.Stop()
	var early <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rt.collectOnce(ctx)
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			rt.forwardEvent(ev)
			if early == nil {
				early = time.After(rt.EventDebounce)
			}
		case <-early:
			early = nil
			rt.collectOnce(ctx)
		case <-rt.collectNow:
			rt.collectOnce(ctx)
		}
	}
}

func (rt *Runtime) collectOnce(ctx context.Context) {
	timeout := rt.ReportInterval - time.Second
	if timeout < 5*time.Second {
		timeout = 5 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	r, err := rt.Collector.Collect(cctx)
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil || r == nil {
		if err == nil {
			err = errors.New("collector returned no report")
		}
		rt.errLog.log(rt.Log, "collect failed", err)
		return
	}
	if r.At.IsZero() {
		r.At = time.Now().UTC()
	}
	r.Seq = rt.seq.Add(1)
	r.Policy = rt.Policy()
	// The collector fills RSS and CPU (including its helper processes such
	// as smartctl and zpool) and the events it had to drop; the runtime
	// adds its own view.
	ai := r.Agent
	ai.Version = rt.Version
	ai.StartedAt = rt.started
	if ai.RSSBytes == 0 {
		ai.RSSBytes, ai.CPUPct = rt.self.sample()
	}
	ai.BufferSize = rt.buf.Len()
	ai.ConsolesOpen = rt.ConsoleCount()
	if n := rt.connects.Load(); n > 1 {
		ai.Reconnects = n - 1
	}
	ai.DroppedEvents += rt.droppedEvents.Load()
	ai.Install = installMethod(rt.Config().Dir)
	ai.Arch = runtime.GOARCH
	if runtime.GOOS != "linux" {
		ai.OS = runtime.GOOS
	}
	ai.UpdateKey = UpdateKeyFingerprint()
	if rt.Helper != nil {
		ai.Caps = append(ai.Caps, proto.CapHelperUpdate)
	}
	r.Agent = ai
	r.Checks = rt.checkRunner().Results()
	// The running package task and the last one that ended (the broker's
	// view: the task runs outside the agent).
	if pr, ok := rt.Broker.(interface {
		PackageReport() (*proto.PackageTask, *proto.PackageLast)
	}); ok && r.System != nil {
		r.System.PackageTask, r.System.PackageLast = pr.PackageReport()
	}
	// Which Compose apps are being updated now and how each one's last
	// update went (the broker's view: the update runs outside the agent).
	if ar, ok := rt.Broker.(interface {
		AppReport() (map[string]bool, map[string]proto.AppLast)
	}); ok && r.Docker != nil {
		busy, last := ar.AppReport()
		for i := range r.Docker.Guests {
			g := &r.Docker.Guests[i]
			if g.App == nil {
				continue
			}
			app := *g.App
			app.Updating = busy[g.ID]
			if l, ok := last[g.ID]; ok {
				app.Last = &l
			}
			g.App = &app
		}
	}
	rt.latest.Store(r)
	rt.deliver(r)
}

// deliver hands a report to the live connection, or buffers its sample.
func (rt *Runtime) deliver(r *proto.Report) {
	rt.connMu.Lock()
	hc := rt.conn
	if hc != nil {
		select {
		case hc.reports <- r:
			rt.connMu.Unlock()
			return
		default: // connection is stuck: keep the sample for backfill
		}
	}
	rt.connMu.Unlock()
	rt.buf.Add(sampleOf(r))
}

func sampleOf(r *proto.Report) proto.Sample {
	return proto.Sample{At: r.At, Values: r.Series()}
}

func (rt *Runtime) forwardEvent(ev proto.Event) {
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	rt.connMu.Lock()
	defer rt.connMu.Unlock()
	if rt.conn != nil {
		select {
		case rt.conn.events <- ev:
			return
		default:
		}
	}
	// No connection, or its queue is full: the event is lost (samples are
	// buffered, events are not).
	rt.droppedEvents.Add(1)
}

func (rt *Runtime) persistLoop(ctx context.Context) {
	t := time.NewTicker(rt.PersistEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := rt.buf.Save(); err != nil {
				rt.errLog.log(rt.Log, "cannot save sample buffer", err)
			}
		}
	}
}

// ---- connection --------------------------------------------------------------

type rejectedError struct{ reason string }

func (e *rejectedError) Error() string { return "hub rejected the agent: " + e.reason }

func (rt *Runtime) connectLoop(ctx context.Context) {
	backoff := rt.BackoffMin
	search := newSearchSchedule(rt)
	defer func() {
		if l := rt.takeMoved(); l != nil {
			l.close()
		}
	}()
	for ctx.Err() == nil {
		start := time.Now()
		var err error
		if l := rt.takeMoved(); l != nil {
			err = rt.runHub(ctx, l)
		} else {
			err = rt.connectOnce(ctx)
		}
		if ctx.Err() != nil {
			return
		}
		// A move under way (the hub may already have closed this
		// connection for the new one): carry on with the new one.
		if rt.waitMove(ctx) {
			backoff = rt.BackoffMin
			search.reached()
			continue
		}
		if time.Since(start) > time.Minute {
			backoff = rt.BackoffMin
		}
		var unreach *unreachableError
		if errors.As(err, &unreach) {
			search.unreachable(rt.now())
		} else {
			search.reached() // connected, or the hub answered
		}
		if errors.Is(err, errRenewalDue) {
			continue // reconnect at once; the handshake renews the certificate
		}
		var rej *rejectedError
		if errors.As(err, &rej) {
			backoff = rt.BackoffMax
		}
		// The saved address keeps failing: look for the hub elsewhere
		// (never after a rejection: the hub was there).
		if search.due(rt.now()) {
			rt.Log.Warn("the hub can't be reached at its saved address", "hub", rt.Config().Hub, "err", err,
				"failures", search.failures)
			found := rt.searchHub(ctx)
			search.searched(rt.now())
			if found != "" {
				rt.useFoundHub(found)
				search.reached()
				backoff = rt.BackoffMin
				continue
			}
			if ctx.Err() != nil {
				return
			}
		}
		wait := backoff/2 + rand.N(backoff/2+1)
		if id := rt.identity(); id != nil && time.Now().After(id.Cert.NotAfter) {
			rt.Log.Error("hub connection failed; the client certificate has expired, enroll again", "err", err)
		} else {
			rt.Log.Warn("hub connection failed", "err", err, "retry_in", wait.Round(100*time.Millisecond))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > rt.BackoffMax {
			backoff = rt.BackoffMax
		}
	}
}

// hubConn is one established connection.
type hubConn struct {
	rt *Runtime
	// base is the context the connection was opened under (the agent's
	// run): a connection made for a move outlives the one it replaces.
	base    context.Context
	sess    *yamux.Session
	ctrl    *yamux.Stream
	wmu     sync.Mutex
	reports chan *proto.Report
	events  chan proto.Event
	streams sync.WaitGroup
}

// dialHub opens the WebSocket to the hub at hubURL, within 30 s or by
// deadline when one is set.
func (rt *Runtime) dialHub(ctx context.Context, hubURL string, deadline time.Time) (*websocket.Conn, error) {
	base, err := HubWSBase(hubURL)
	if err != nil {
		return nil, err
	}
	id := rt.identity()
	tlsCfg := CATLSConfig(id.CA, func() *tls.Certificate {
		cur := rt.identity()
		return &cur.TLS
	})
	hc := &http.Client{Transport: &http.Transport{
		TLSClientConfig:     tlsCfg,
		TLSHandshakeTimeout: 15 * time.Second,
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         rt.dialContext,
	}}
	if deadline.IsZero() {
		deadline = time.Now().Add(30 * time.Second)
	}
	dctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	c, resp, err := websocket.Dial(dctx, base+ConnectPath, &websocket.DialOptions{
		HTTPClient:   hc,
		Subprotocols: []string{Subprotocol, LegacySubprotocol},
	})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return nil, &rejectedError{reason: fmt.Sprintf("HTTP %d (certificate revoked or server deleted?)", resp.StatusCode)}
		}
		if resp == nil && ctx.Err() == nil {
			// No HTTP answer over a verified connection: a network or
			// TLS error (hubsearch.go).
			return nil, &unreachableError{err: err}
		}
		return nil, err
	}
	if c.Subprotocol() != Subprotocol {
		c.Close(websocket.StatusProtocolError, "subprotocol required")
		return nil, fmt.Errorf("hub did not accept subprotocol %s", Subprotocol)
	}
	return c, nil
}

// hubLink is a connection to the hub whose hello it accepted.
type hubLink struct {
	hc     *hubConn
	ack    *proto.HelloAck
	url    string
	cancel context.CancelFunc // ends the connection
}

func (l *hubLink) close() {
	l.hc.sess.Close()
	l.cancel()
}

// openHub connects to the hub at hubURL and says hello: within 30 s for
// each step, or by deadline when one is set. The connection lasts until
// ctx ends or it is closed.
func (rt *Runtime) openHub(ctx context.Context, hubURL string, deadline time.Time) (*hubLink, error) {
	lctx, cancel := context.WithCancel(ctx)
	ws, err := rt.dialHub(lctx, hubURL, deadline)
	if err != nil {
		cancel()
		return nil, err
	}
	nc := websocket.NetConn(lctx, ws, websocket.MessageBinary)
	sess, err := yamux.Client(nc, wire.YamuxConfig())
	if err != nil {
		nc.Close()
		cancel()
		return nil, err
	}
	fail := func(err error) (*hubLink, error) {
		sess.Close()
		cancel()
		return nil, err
	}
	ctrl, err := sess.OpenStream()
	if err != nil {
		return fail(fmt.Errorf("open control stream: %w", err))
	}
	hc := &hubConn{
		rt:      rt,
		base:    ctx,
		sess:    sess,
		ctrl:    ctrl,
		reports: make(chan *proto.Report, 4),
		events:  make(chan proto.Event, 64),
	}
	ack, err := hc.handshake(deadline)
	if err != nil {
		return fail(err)
	}
	if ack.Rejected != "" {
		return fail(&rejectedError{reason: ack.Rejected})
	}
	return &hubLink{hc: hc, ack: ack, url: hubURL, cancel: cancel}, nil
}

func (rt *Runtime) connectOnce(ctx context.Context) error {
	link, err := rt.openHub(ctx, rt.Config().Hub, time.Time{})
	if err != nil {
		return err
	}
	return rt.runHub(ctx, link)
}

// runHub serves an open connection until it ends.
func (rt *Runtime) runHub(ctx context.Context, link *hubLink) error {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer link.close()
	hc, sess, ack := link.hc, link.hc.sess, link.ack
	var err error
	rt.rememberHubAddrs(ack.Addrs)
	if len(ack.Certificate) > 0 {
		if err := rt.applyRenewedCert(ack.Certificate); err != nil {
			rt.Log.Error("hub sent an unusable renewed certificate", "err", err)
		}
	}
	skew := time.Duration(0)
	if !ack.HubClock.IsZero() {
		skew = time.Until(ack.HubClock).Round(time.Second)
	}
	rt.Log.Info("connected to hub", "server_id", ack.ServerID, "hub_version", ack.HubVersion,
		"clock_skew", skew, "buffered", rt.buf.Len())
	if skew > 30*time.Second || skew < -30*time.Second {
		rt.Log.Warn("clock skew to the hub exceeds 30 s; check NTP", "skew", skew)
	}
	rt.connected.Store(true)
	rt.connects.Add(1)
	defer rt.connected.Store(false)
	rt.updateConnected()

	errc := make(chan error, 3)
	go func() { errc <- hc.acceptLoop(cctx) }()
	go func() { errc <- hc.readLoop() }()
	go func() { errc <- hc.writeLoop(cctx) }()
	// The certificate is renewed in the handshake only: a connection that
	// outlives the start of the renewal window reconnects to renew it (a
	// month-long connection must not let the certificate expire).
	renewTimer := rt.renewalTimer()
	defer renewTimer.Stop()
	pending := 3
	select {
	case err = <-errc:
		pending--
	case <-renewTimer.C:
		rt.Log.Info("reconnecting to renew the client certificate")
		err = errRenewalDue
	}
	cancel()
	sess.Close()
	// Wait for the other loops so that reports in flight are buffered.
	for ; pending > 0; pending-- {
		<-errc
	}
	done := make(chan struct{})
	go func() { hc.streams.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	return err
}

// handshake says hello and reads the answer, by deadline (zero: 30 s).
func (hc *hubConn) handshake(deadline time.Time) (*proto.HelloAck, error) {
	rt := hc.rt
	id := rt.identity()
	hello := proto.Hello{
		ProtocolVersion: proto.Version,
		AgentVersion:    rt.Version,
		MachineID:       MachineID(),
		Hostname:        Hostname(),
		Clock:           time.Now().UTC(),
		BufferedSamples: rt.buf.Len(),
	}
	if id.NeedsRenewal(time.Now()) {
		csr, err := CreateCSR(id.Key, id.Cert.Subject.CommonName)
		if err == nil {
			hello.CSR = csr
			rt.Log.Info("requesting client certificate renewal", "not_after", id.Cert.NotAfter)
		}
	}
	if deadline.IsZero() {
		deadline = time.Now().Add(30 * time.Second)
	}
	hc.ctrl.SetDeadline(deadline)
	defer hc.ctrl.SetDeadline(time.Time{})
	if err := wire.WriteMsg(hc.ctrl, proto.StreamHeader{Kind: proto.StreamControl}); err != nil {
		return nil, err
	}
	if err := wire.SendEnvelope(hc.ctrl, proto.MsgHello, hello); err != nil {
		return nil, err
	}
	var env proto.Envelope
	if err := wire.ReadMsg(hc.ctrl, &env); err != nil {
		return nil, fmt.Errorf("waiting for hello_ack: %w", err)
	}
	if env.Type != proto.MsgHelloAck {
		return nil, fmt.Errorf("expected hello_ack, got %q", env.Type)
	}
	var ack proto.HelloAck
	if err := wire.Unmarshal(env.Body, &ack); err != nil {
		return nil, fmt.Errorf("hello_ack: %w", err)
	}
	return &ack, nil
}

// applyRenewedCert switches to the certificate from HelloAck. The hub
// refuses the old serial from now on, so the new certificate is used even
// if it cannot be written to disk (the error is logged; a restart would
// then need a new enrollment).
func (rt *Runtime) applyRenewedCert(certPEM []byte) error {
	id := rt.identity()
	if _, err := VerifyClientCert(certPEM, id.Key, id.CA); err != nil {
		return err
	}
	n := &Identity{Key: id.Key, CA: id.CA}
	if err := n.setCert(certPEM); err != nil {
		return err
	}
	rt.idMu.Lock()
	rt.id = n
	rt.idMu.Unlock()
	if err := WriteFileAtomic(rt.Config().CertPath(), certPEM, 0o644); err != nil {
		rt.Log.Error("renewed client certificate could not be saved; the agent will need a new enrollment after a restart",
			"path", rt.Config().CertPath(), "err", err)
		return nil
	}
	rt.Log.Info("client certificate renewed", "not_after", n.Cert.NotAfter)
	return nil
}

// errRenewalDue ends a connection so the next handshake renews the client
// certificate.
var errRenewalDue = errors.New("client certificate renewal is due")

// renewalTimer fires when the current certificate enters its renewal window
// (plus RenewJitter so a fleet does not reconnect at once). A
// certificate already inside the window was offered for renewal in this
// connection's handshake: the timer then never fires.
func (rt *Runtime) renewalTimer() *time.Timer {
	id := rt.identity()
	if id == nil || id.Cert == nil {
		return time.NewTimer(time.Duration(math.MaxInt64))
	}
	d := time.Until(id.Cert.NotAfter.Add(-RenewBefore))
	if d <= 0 {
		return time.NewTimer(time.Duration(math.MaxInt64))
	}
	if rt.RenewJitter > 0 {
		d += rand.N(rt.RenewJitter)
	}
	return time.NewTimer(d)
}

// send writes one control-stream envelope.
func (hc *hubConn) send(typ string, body any) error {
	b, err := wire.Marshal(body)
	if err != nil {
		return err
	}
	return hc.sendRaw(proto.Envelope{Type: typ, Body: b})
}

func (hc *hubConn) sendRaw(env proto.Envelope) error {
	hc.wmu.Lock()
	defer hc.wmu.Unlock()
	hc.ctrl.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return wire.WriteMsg(hc.ctrl, env)
}

// readLoop answers pings and applies check sets on the control stream.
func (hc *hubConn) readLoop() error {
	for {
		var env proto.Envelope
		if err := wire.ReadMsg(hc.ctrl, &env); err != nil {
			return fmt.Errorf("control stream: %w", err)
		}
		switch env.Type {
		case proto.MsgPing:
			if err := hc.sendRaw(proto.Envelope{Type: proto.MsgPong, Body: env.Body}); err != nil {
				return err
			}
		case proto.MsgChecks:
			var cs proto.CheckSpecs
			if err := wire.Unmarshal(env.Body, &cs); err != nil {
				hc.rt.Log.Warn("ignoring an unreadable check set", "err", err)
				continue
			}
			hc.rt.setChecks(cs.Checks)
		case proto.MsgHubAddrs:
			var ha proto.HubAddrs
			if err := wire.Unmarshal(env.Body, &ha); err != nil {
				hc.rt.Log.Warn("ignoring an unreadable address list", "err", err)
				continue
			}
			hc.rt.rememberHubAddrs(ha.Addrs)
		case proto.MsgHubMove:
			var hm proto.HubMove
			if err := wire.Unmarshal(env.Body, &hm); err != nil {
				hc.rt.Log.Warn("ignoring an unreadable move", "err", err)
				continue
			}
			hc.rt.startMove(hc, hm.URL)
		case proto.MsgPong, proto.MsgHelloAck:
		default:
			hc.rt.Log.Debug("ignoring control message", "type", env.Type)
		}
	}
}

// backfill sends buffered samples, oldest first, in batches.
func (hc *hubConn) backfill() error {
	buf := hc.rt.buf
	for {
		batch, tok := buf.Peek(BackfillBatch)
		if len(batch) == 0 {
			return nil
		}
		if err := hc.send(proto.MsgBackfill, proto.Backfill{Samples: batch}); err != nil {
			return fmt.Errorf("backfill: %w", err)
		}
		buf.Ack(tok)
		hc.rt.Log.Info("backfilled samples", "count", len(batch), "remaining", buf.Len())
	}
}

func (hc *hubConn) writeLoop(ctx context.Context) error {
	rt := hc.rt
	defer func() {
		// Stop accepting reports, then keep what was queued for backfill.
		rt.connMu.Lock()
		if rt.conn == hc {
			rt.conn = nil
		}
		rt.connMu.Unlock()
		for {
			select {
			case r := <-hc.reports:
				rt.buf.Add(sampleOf(r))
			default:
				return
			}
		}
	}()
	if err := hc.backfill(); err != nil {
		return err
	}
	rt.connMu.Lock()
	rt.conn = hc
	rt.connMu.Unlock()
	// Samples buffered between the first backfill and now.
	if err := hc.backfill(); err != nil {
		return err
	}
	// Collect a fresh report right away so the hub has inventory (the
	// latest one's sample may already have been backfilled).
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case r := <-hc.reports:
			if err := hc.send(proto.MsgReport, r); err != nil {
				rt.buf.Add(sampleOf(r))
				return fmt.Errorf("send report: %w", err)
			}
			if rt.buf.Len() > 0 {
				if err := hc.backfill(); err != nil {
					return err
				}
			}
		case ev := <-hc.events:
			if err := hc.send(proto.MsgEvent, ev); err != nil {
				return fmt.Errorf("send event: %w", err)
			}
		}
	}
}

func (hc *hubConn) acceptLoop(ctx context.Context) error {
	for {
		st, err := hc.sess.AcceptStreamWithContext(ctx)
		if err != nil {
			return fmt.Errorf("accept: %w", err)
		}
		hc.streams.Add(1)
		go func() {
			defer hc.streams.Done()
			hc.rt.handleStream(ctx, st)
		}()
	}
}

// ---- helpers -----------------------------------------------------------------

// rateLimitedLog logs repeated errors at most once per 5 minutes unless the
// message changes.
type rateLimitedLog struct {
	mu   sync.Mutex
	last string
	at   time.Time
}

func (l *rateLimitedLog) log(log *slog.Logger, msg string, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := msg + ": " + err.Error()
	if s == l.last && time.Since(l.at) < 5*time.Minute {
		return
	}
	l.last, l.at = s, time.Now()
	log.Warn(msg, "err", err)
}

// ---- checks ------------------------------------------------------------------

func (rt *Runtime) checkRunner() *checks.Runner {
	rt.checksOnce.Do(func() { rt.checks = checks.NewRunner() })
	return rt.checks
}

// setChecks replaces the checks this agent runs (at most checks.MaxChecks).
func (rt *Runtime) setChecks(specs []proto.CheckSpec) {
	errs := rt.checkRunner().SetSpecs(specs)
	for i, err := range errs {
		if i == 5 {
			rt.Log.Warn("more check errors", "count", len(errs)-i)
			break
		}
		rt.Log.Warn("check refused", "err", err)
	}
	rt.Log.Info("checks updated", "count", rt.checkRunner().Len())
}
