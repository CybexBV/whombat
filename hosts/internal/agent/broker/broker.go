// Package broker implements agent.Broker: guest power actions, snapshots,
// screenshots and console sessions for Docker, Incus, libvirt and Proxmox
// VE, the host's own shell, log, reboot and shutdown, and the inspect views.
//
// Every request is validated against the latest inventory (the guest must
// be listed, the protocol must be in its console capabilities); the hub
// only names a platform, a guest id and a protocol, never a socket path,
// port or command. Endpoints are local only (Unix sockets, loopback, local
// tools) and guest-side credentials (VNC passwords, SPICE tickets) are
// handled here and never sent to the hub.
package broker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Error codes in ActionResponse / ThumbnailResponse / ConsoleResponse.
const (
	CodeInvalid             = "invalid_request"
	CodeInventory           = "inventory_unavailable"
	CodeUnknownGuest        = "unknown_guest"
	CodeUnsupported         = "unsupported"
	CodeUnsupportedAction   = "unsupported_action"
	CodeUnsupportedProtocol = "unsupported_protocol"
	CodeProtocolUnavailable = "protocol_unavailable"
	CodeGuestNotRunning     = "guest_not_running"
	CodeNoScreen            = "no_screen"
	CodeTimeout             = "timeout"
	CodePlatformError       = "platform_error"
	CodeOpenFailed          = "open_failed"
	CodeCaptureFailed       = "capture_failed"
	CodeBusy                = "busy"
	CodeGuestNotPaused      = "guest_not_paused"
	CodeUnknownSnapshot     = "unknown_snapshot"
)

// actionWait is how long an action waits for the guest to reach the
// target state (REMOTE-CONSOLE.md 7).
const actionWait = 60

// codeError carries a response code with a user-facing message.
type codeError struct {
	code, msg string
}

func (e *codeError) Error() string { return e.msg }

func codeErr(code, msg string) error { return &codeError{code: code, msg: msg} }

// errCode splits an error into (code, message), defaulting to def.
func errCode(err error, def string) (string, string) {
	var ce *codeError
	if errors.As(err, &ce) {
		return ce.code, ce.msg
	}
	return def, err.Error()
}

// driver is one platform. Drivers with snapshots also implement
// snapshotter; actionStater refines state() for actions.
type driver interface {
	// state returns proto.StateRunning, proto.StateStopped or another
	// platform state ("paused", ...).
	state(ctx context.Context, g *proto.Guest) (string, error)
	// power starts the action and returns once the platform accepted it
	// (it may wait for completion).
	power(ctx context.Context, g *proto.Guest, action string) error
	// screenshot returns a PNG, JPEG or PPM image of the guest's screen.
	screenshot(ctx context.Context, g *proto.Guest) ([]byte, error)
	// console opens a session; resolution is reported when known.
	console(ctx context.Context, g *proto.Guest, req proto.ConsoleRequest) (agent.ConsoleSession, string, error)
	// list returns the platform's guests (console-test's local inventory).
	list(ctx context.Context) ([]proto.Guest, error)
}

// actionStater is implemented by drivers whose state() cannot tell a
// paused guest from a running one cheaply (PVE).
type actionStater interface {
	actionState(ctx context.Context, g *proto.Guest) (string, error)
}

// Broker implements agent.Broker.
type Broker struct {
	cfg     *agent.Config
	inv     agent.InventoryFunc
	log     *slog.Logger
	drivers map[string]driver

	lockMu sync.Mutex
	locks  map[string]chan struct{} // per guest: one action at a time

	// Host reboot / shutdown (host.go); tests replace hostRun and, so that
	// they don't depend on the machine's own tools, hostCommands.
	hostMu       sync.Mutex
	hostPending  string
	hostDelay    time.Duration
	hostRun      func(argv []string) error
	hostCommands func(action string) [][]string

	// unRAID management (unraid_manage.go), created on first use;
	// OnUnraidChange runs after an unRAID task ended (the agent reads
	// unRAID's state again).
	unraidOnce     sync.Once
	unraidMgr      *unraidManager
	OnUnraidChange func()

	// Package updates (pkg_tasks.go), created on first use;
	// OnPackageChange runs when a package task started (the agent reports)
	// or ended (it also reads the waiting updates and the reboot need
	// again).
	// Backup places (backupplace.go), created on first use.
	placeOnce sync.Once
	placeMgr  *placeManager

	pkgOnce         sync.Once
	pkgMgr          *pkgTasks
	pkgHost         pkgHost
	OnPackageChange func(ended bool)

	// App updates (app_tasks.go), created on first use; OnAppChange runs
	// when an app task started or ended (the agent reports).
	appOnce     sync.Once
	appMgr      *appTasks
	OnAppChange func()
}

// New returns the broker. inv returns the latest report, used to validate
// that a requested guest exists on this host.
func New(cfg *agent.Config, inv agent.InventoryFunc) agent.Broker {
	return NewBroker(cfg, inv, slog.Default())
}

// NewBroker is New with a logger and a concrete type.
func NewBroker(cfg *agent.Config, inv agent.InventoryFunc, log *slog.Logger) *Broker {
	if cfg == nil {
		cfg = &agent.Config{Dir: agent.DefaultConfigDir, StateDir: agent.DefaultStateDir}
	}
	if log == nil {
		log = slog.Default()
	}
	b := &Broker{cfg: cfg, inv: inv, log: log, locks: map[string]chan struct{}{},
		hostDelay: hostPowerDelay, hostRun: runHostCommand, hostCommands: hostPowerCommands}
	b.drivers = map[string]driver{
		proto.PlatformDocker:  &dockerDriver{},
		proto.PlatformIncus:   &incusDriver{inv: inv},
		proto.PlatformLibvirt: &libvirtDriver{cfg: cfg},
		proto.PlatformPVE:     newPVEDriver(cfg),
	}
	return b
}

func (b *Broker) guestLock(platform, id string) chan struct{} {
	b.lockMu.Lock()
	defer b.lockMu.Unlock()
	k := platform + ":" + id
	m := b.locks[k]
	if m == nil {
		m = make(chan struct{}, 1)
		b.locks[k] = m
	}
	return m
}

// lockGuest takes the guest's lock unless ctx ends first (an action stuck
// on a hung platform must not queue every later request forever).
func (b *Broker) lockGuest(ctx context.Context, platform, id string) (unlock func(), ok bool) {
	m := b.guestLock(platform, id)
	select {
	case m <- struct{}{}:
		return func() { <-m }, true
	case <-ctx.Done():
		return nil, false
	}
}

// lookup validates platform and guest id against the latest inventory.
func (b *Broker) lookup(platform, id string) (*proto.Guest, driver, error) {
	if platform == "" || id == "" || len(id) > 256 {
		return nil, nil, codeErr(CodeInvalid, "platform and guest are required")
	}
	if platform == proto.PlatformHost {
		return nil, nil, codeErr(CodeUnsupported, "not available for the host")
	}
	d := b.drivers[platform]
	if d == nil {
		return nil, nil, codeErr(CodeUnsupported, "unknown platform")
	}
	var r *proto.Report
	if b.inv != nil {
		r = b.inv()
	}
	if r == nil {
		return nil, nil, codeErr(CodeInventory, "the agent has no inventory yet; try again in a few seconds")
	}
	g := r.FindGuest(platform, id)
	if g == nil {
		return nil, nil, codeErr(CodeUnknownGuest, "guest not found on this host")
	}
	cp := *g
	return &cp, d, nil
}

// normalizeAction maps the toolbar action to what the guest kind supports.
func normalizeAction(kind, action string) (string, bool) {
	switch action {
	case proto.ActionStart:
		return action, true
	case proto.ActionShutdown:
		if kind == "container" {
			return proto.ActionStop, true
		}
		return action, true
	case proto.ActionStop:
		if kind == "vm" {
			return proto.ActionShutdown, true
		}
		return action, true
	case proto.ActionReboot, proto.ActionRestart:
		if kind == "container" {
			return proto.ActionRestart, true
		}
		return proto.ActionReboot, true
	case proto.ActionForceStop:
		return action, true
	case proto.ActionCtrlAltDel:
		return action, kind == "vm"
	case proto.ActionPause, proto.ActionResume,
		proto.ActionSnapshotCreate, proto.ActionSnapshotRestore, proto.ActionSnapshotDelete:
		return action, true
	}
	return "", false
}

// actionState is the driver's state, refined for actions where the driver
// can (paused PVE VMs).
func actionState(ctx context.Context, d driver, g *proto.Guest) (string, error) {
	if as, ok := d.(actionStater); ok {
		return as.actionState(ctx, g)
	}
	return d.state(ctx, g)
}

// Action implements agent.Broker.
func (b *Broker) Action(ctx context.Context, req proto.ActionRequest) proto.ActionResponse {
	if req.Platform == proto.PlatformHost {
		return b.hostAction(req)
	}
	g, d, err := b.lookup(req.Platform, req.GuestID)
	if err != nil {
		code, msg := errCode(err, CodeInvalid)
		return proto.ActionResponse{Code: code, Message: msg}
	}
	action, ok := normalizeAction(g.Kind, req.Action)
	if !ok {
		return proto.ActionResponse{Code: CodeUnsupportedAction, Message: fmt.Sprintf("action %q is not available for a %s", req.Action, g.Kind)}
	}
	switch action {
	case proto.ActionSnapshotCreate, proto.ActionSnapshotRestore, proto.ActionSnapshotDelete:
		return b.snapshotAction(ctx, req, g, d, req.Platform)
	}
	unlock, ok := b.lockGuest(ctx, req.Platform, g.ID)
	if !ok {
		return proto.ActionResponse{Code: CodeBusy, Message: "another action on this guest is still running"}
	}
	defer unlock()

	deadline := time.Now().Add(actionWait * time.Second)
	ctx, cancel := context.WithDeadline(ctx, deadline.Add(10*time.Second))
	defer cancel()

	cur, err := actionState(ctx, d, g)
	if err != nil {
		code, msg := errCode(err, CodePlatformError)
		return proto.ActionResponse{Code: code, Message: msg}
	}
	if action == proto.ActionStart && cur == proto.StatePaused {
		action = proto.ActionResume // "start" on a paused guest continues it
	}
	var target string
	switch action {
	case proto.ActionStart:
		if cur == proto.StateRunning {
			return proto.ActionResponse{OK: true, Noop: true, State: cur}
		}
		target = proto.StateRunning
	case proto.ActionPause:
		if cur == proto.StatePaused {
			return proto.ActionResponse{OK: true, Noop: true, State: cur}
		}
		if cur != proto.StateRunning {
			return proto.ActionResponse{Code: CodeGuestNotRunning, Message: "the guest is not running", State: cur}
		}
		target = proto.StatePaused
	case proto.ActionResume:
		if cur == proto.StateRunning {
			return proto.ActionResponse{OK: true, Noop: true, State: cur}
		}
		if cur != proto.StatePaused {
			return proto.ActionResponse{Code: CodeGuestNotPaused, Message: "the guest is not paused", State: cur}
		}
		target = proto.StateRunning
	case proto.ActionShutdown, proto.ActionStop, proto.ActionForceStop:
		if cur == proto.StateStopped {
			return proto.ActionResponse{OK: true, Noop: true, State: cur}
		}
		target = proto.StateStopped
	case proto.ActionReboot, proto.ActionRestart, proto.ActionCtrlAltDel:
		if cur != proto.StateRunning {
			return proto.ActionResponse{Code: CodeGuestNotRunning, Message: "the guest is not running", State: cur}
		}
		target = proto.StateRunning
	}
	b.log.Info("running guest action", "platform", req.Platform, "guest", g.ID, "action", action, "state", cur)
	if err := d.power(ctx, g, action); err != nil {
		code, msg := errCode(err, CodePlatformError)
		st, _ := actionState(context.WithoutCancel(ctx), d, g)
		return proto.ActionResponse{Code: code, Message: msg, State: st}
	}
	// Verify the outcome by polling the state.
	var st string
	for {
		st, err = actionState(ctx, d, g)
		if err == nil && st == target {
			return proto.ActionResponse{OK: true, State: st}
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	if err != nil {
		code, msg := errCode(err, CodePlatformError)
		return proto.ActionResponse{Code: code, Message: msg, State: st}
	}
	return proto.ActionResponse{
		Code:    CodeTimeout,
		Message: fmt.Sprintf("the guest did not reach %q within %d s", target, actionWait),
		State:   st,
	}
}

// Thumbnail implements agent.Broker.
func (b *Broker) Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
	g, d, err := b.lookup(req.Platform, req.GuestID)
	if err != nil {
		code, msg := errCode(err, CodeInvalid)
		return proto.ThumbnailResponse{Code: code, Message: msg}
	}
	if g.Kind != "vm" {
		return proto.ThumbnailResponse{Code: CodeNoScreen, Message: "containers have no screen"}
	}
	if req.Format != "" && req.Format != "jpeg" && req.Format != "png" {
		return proto.ThumbnailResponse{Code: CodeInvalid, Message: "format must be jpeg or png"}
	}
	st, err := d.state(ctx, g)
	if err != nil {
		code, msg := errCode(err, CodePlatformError)
		return proto.ThumbnailResponse{Code: code, Message: msg}
	}
	if st != proto.StateRunning {
		return proto.ThumbnailResponse{Code: CodeGuestNotRunning, Message: "the guest is not running"}
	}
	raw, err := d.screenshot(ctx, g)
	if err != nil {
		code, msg := errCode(err, CodeCaptureFailed)
		return proto.ThumbnailResponse{Code: code, Message: msg}
	}
	img, w, h, err := Thumbnail(raw, req.MaxWidth, req.Format)
	if err != nil {
		return proto.ThumbnailResponse{Code: CodeCaptureFailed, Message: "cannot decode screenshot: " + err.Error()}
	}
	return proto.ThumbnailResponse{Image: img, Width: w, Height: h}
}

// Console implements agent.Broker.
func (b *Broker) Console(ctx context.Context, req proto.ConsoleRequest) (agent.ConsoleSession, proto.ConsoleResponse) {
	if req.Platform == proto.PlatformHost {
		return b.hostConsole(ctx, req)
	}
	g, d, err := b.lookup(req.Platform, req.GuestID)
	if err != nil {
		code, msg := errCode(err, CodeInvalid)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	if req.Platform == proto.PlatformDocker {
		// The broker knows what it serves for Docker (Caps); inventories
		// from older collectors list no protocols.
		if req.Protocol != proto.ProtoShell && req.Protocol != proto.ProtoLogs {
			return nil, proto.ConsoleResponse{Code: CodeUnsupportedProtocol, Message: fmt.Sprintf("%s is not available for Docker containers", req.Protocol)}
		}
	} else {
		if reason, ok := g.Console.Unavailable[req.Protocol]; ok {
			return nil, proto.ConsoleResponse{Code: CodeProtocolUnavailable, Message: reason}
		}
		if !slices.Contains(g.Console.Protocols, req.Protocol) {
			return nil, proto.ConsoleResponse{Code: CodeUnsupportedProtocol, Message: fmt.Sprintf("%s is not available for this guest", req.Protocol)}
		}
	}
	octx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	st, err := d.state(octx, g)
	if err != nil {
		code, msg := errCode(err, CodePlatformError)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	// Logs are readable in any state (a stopped container's last output).
	if st != proto.StateRunning && req.Protocol != proto.ProtoLogs {
		return nil, proto.ConsoleResponse{Code: CodeGuestNotRunning, Message: "the guest is not running"}
	}
	// The session's resources live as long as ctx (the session); opening
	// is bounded by the platform drivers.
	sess, res, err := d.console(ctx, g, req)
	if err != nil {
		code, msg := errCode(err, CodeOpenFailed)
		b.log.Info("console open failed", "platform", req.Platform, "guest", g.ID, "protocol", req.Protocol, "code", code, "err", msg)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	return sess, proto.ConsoleResponse{OK: true, Resolution: res}
}

// LocalInventory builds a report with the guests of one platform straight
// from the platform API. It is used by `whombat-agent console-test`, which
// runs without the collectors.
func LocalInventory(ctx context.Context, cfg *agent.Config, platform string) (*proto.Report, error) {
	b := NewBroker(cfg, nil, nil)
	d := b.drivers[platform]
	if d == nil {
		return nil, fmt.Errorf("unknown platform %q (docker, incus, libvirt, pve)", platform)
	}
	gs, err := d.list(ctx)
	if err != nil {
		return nil, err
	}
	r := &proto.Report{At: time.Now().UTC()}
	p := &proto.Platform{Guests: gs}
	switch platform {
	case proto.PlatformDocker:
		r.Docker = p
	case proto.PlatformIncus:
		r.Incus = p
	case proto.PlatformLibvirt:
		r.Libvirt = p
	case proto.PlatformPVE:
		r.PVE = &proto.PVE{Guests: gs}
	}
	return r, nil
}
