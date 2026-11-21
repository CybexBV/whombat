package broker

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"syscall"

	"rackoon/internal/agent"
	"rackoon/internal/agent/macos"
	"rackoon/internal/proto"
)

// MacBroker implements agent.Broker on a Mac: the host's power (shutdown),
// its root shell (zsh on a PTY), its log (the unified log), its screen
// (through the screen package's hook), the inspect views (ps, lsof,
// launchd, softwareupdate) and OS updates as package tasks. A Mac has no
// guest platforms: every guest request is unsupported.
type MacBroker struct {
	b   *Broker // the host power and package task machinery, shared with Linux
	log *slog.Logger
}

// NewMacBroker returns the broker of a Mac. onPackageChange runs when a
// package task starts (ended false) or ends (true).
func NewMacBroker(cfg *agent.Config, log *slog.Logger, onPackageChange func(ended bool)) *MacBroker {
	if cfg == nil {
		cfg = &agent.Config{Dir: agent.DefaultConfigDir, StateDir: agent.DefaultStateDir}
	}
	if log == nil {
		log = slog.Default()
	}
	b := &Broker{cfg: cfg, log: log, locks: map[string]chan struct{}{}, drivers: map[string]driver{},
		hostDelay: hostPowerDelay, hostRun: runHostCommand, hostCommands: macHostPowerCommands}
	b.OnPackageChange = onPackageChange
	return &MacBroker{b: b, log: log}
}

// macHostPowerCommands restarts or shuts down a Mac.
func macHostPowerCommands(action string) [][]string {
	if action == proto.ActionHostShutdown {
		return [][]string{{macos.Shutdown, "-h", "now"}}
	}
	return [][]string{{macos.Shutdown, "-r", "now"}}
}

// ---- the screen, from the screen package ---------------------------------------------

// MacScreenConsole opens the Mac's screen as a VNC console (the host's
// vnc); MacScreenThumbnail takes a still picture of it.
type (
	MacScreenConsole   func(ctx context.Context) (agent.ConsoleSession, proto.ConsoleResponse)
	MacScreenThumbnail func(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse
)

type macScreenHooks struct {
	console   MacScreenConsole
	thumbnail MacScreenThumbnail
}

var macScreen atomic.Pointer[macScreenHooks]

// SetMacScreen installs the screen package's console and still picture
// (cmd/whombat-agent wires them on a Mac). Until then the host's vnc and
// its thumbnail answer unsupported.
func SetMacScreen(console MacScreenConsole, thumbnail MacScreenThumbnail) {
	macScreen.Store(&macScreenHooks{console: console, thumbnail: thumbnail})
}

func screenHooks() macScreenHooks {
	if h := macScreen.Load(); h != nil {
		return *h
	}
	return macScreenHooks{}
}

// ---- agent.Broker --------------------------------------------------------------------

func hostOnly(platform, guest string) error {
	switch {
	case platform != proto.PlatformHost:
		return codeErr(CodeUnsupported, "a Mac runs no virtual machines or containers Whombat can reach")
	case guest != HostID:
		return codeErr(CodeInvalid, `host requests need guest "host"`)
	}
	return nil
}

// Action implements agent.Broker: restart or shut down the Mac.
func (m *MacBroker) Action(_ context.Context, req proto.ActionRequest) proto.ActionResponse {
	if err := hostOnly(req.Platform, req.GuestID); err != nil {
		code, msg := errCode(err, CodeInvalid)
		return proto.ActionResponse{Code: code, Message: msg}
	}
	return m.b.hostAction(req)
}

// Thumbnail implements agent.Broker: a still picture of the Mac's screen.
func (m *MacBroker) Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
	if err := hostOnly(req.Platform, req.GuestID); err != nil {
		code, msg := errCode(err, CodeInvalid)
		return proto.ThumbnailResponse{Code: code, Message: msg}
	}
	if req.Format != "" && req.Format != "jpeg" && req.Format != "png" {
		return proto.ThumbnailResponse{Code: CodeInvalid, Message: "format must be jpeg or png"}
	}
	if f := screenHooks().thumbnail; f != nil {
		return f(ctx, req)
	}
	return proto.ThumbnailResponse{Code: CodeUnsupported, Message: "this agent can’t show the Mac’s screen yet"}
}

// Console implements agent.Broker: the Mac's root shell, its log or its
// screen.
func (m *MacBroker) Console(ctx context.Context, req proto.ConsoleRequest) (agent.ConsoleSession, proto.ConsoleResponse) {
	if err := hostOnly(req.Platform, req.GuestID); err != nil {
		code, msg := errCode(err, CodeInvalid)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	var sess agent.ConsoleSession
	var err error
	switch req.Protocol {
	case proto.ProtoShell:
		sess, err = macShell(req)
	case proto.ProtoLogs:
		sess, err = startLogCommand(MacLogArgv, "-- the log stream ended --")
	case proto.ProtoVNC:
		if f := screenHooks().console; f != nil {
			return f(ctx)
		}
		err = codeErr(CodeUnsupported, "this agent can’t show the Mac’s screen yet")
	default:
		err = codeErr(CodeUnsupportedProtocol, "a Mac has shell, logs and vnc")
	}
	if err != nil {
		code, msg := errCode(err, CodeOpenFailed)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	return sess, proto.ConsoleResponse{OK: true}
}

// MacShellEnv is the root shell's environment on a Mac.
var MacShellEnv = []string{
	"PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	"HOME=/var/root",
	"USER=root",
	"LOGNAME=root",
	"SHELL=" + macos.Zsh,
	"TERM=xterm-256color",
	"LANG=en_US.UTF-8",
}

// macShell is a root login zsh on a PTY, in root's home.
func macShell(req proto.ConsoleRequest) (agent.ConsoleSession, error) {
	dir := "/var/root"
	if syscall.Access(dir, 1 /* X_OK */) != nil {
		dir = "/"
	}
	p, err := startPTYDir([]string{macos.Zsh, "-l"}, MacShellEnv, dir, req.Cols, req.Rows)
	if err != nil {
		return nil, codeErr(CodeOpenFailed, err.Error())
	}
	return p.session(proto.ProtoShell), nil
}

// MacLogArgv is the logs console: the last 300 lines of the unified log's
// last 10 minutes, then the log as it is written. A fixed command line.
var MacLogArgv = []string{"/bin/sh", "-c",
	macos.Log + " show --last 10m --style syslog | /usr/bin/tail -n 300; exec " + macos.Log + " stream --style syslog"}

// Inspect implements agent.Broker: processes, listening ports, launchd's
// jobs and the waiting updates (softwareupdate --list asks Apple's
// servers: only when someone opens this view).
func (m *MacBroker) Inspect(ctx context.Context, req proto.InspectRequest) proto.InspectResponse {
	switch req.Kind {
	case proto.InspectProcesses, proto.InspectPorts, proto.InspectServices, proto.InspectUpdates:
		if req.Platform != proto.PlatformHost || req.GuestID != HostID {
			return proto.InspectResponse{Code: CodeInvalid, Message: `host views need platform "host" and guest "host"`}
		}
	case proto.InspectSnapshots:
		return proto.InspectResponse{Code: CodeUnsupported, Message: "a Mac has no guests with snapshots"}
	default:
		return proto.InspectResponse{Code: CodeUnsupported, Message: "unknown inspect kind"}
	}
	var resp proto.InspectResponse
	var err error
	switch req.Kind {
	case proto.InspectProcesses:
		var rows []proto.Process
		rows, err = macos.Processes(ctx)
		resp.Processes, resp.Truncated = capRows(rows, req.Limit, 100, 500)
	case proto.InspectPorts:
		var rows []proto.ListenPort
		rows, err = macos.Ports(ctx)
		resp.Ports, resp.Truncated = capRows(rows, req.Limit, 500, 500)
	case proto.InspectServices:
		var rows []proto.Service
		rows, err = macos.Services(ctx)
		resp.Services, resp.Truncated = capRows(rows, req.Limit, defaultServices, maxServices)
	case proto.InspectUpdates:
		var l []macos.ListedUpdate
		l, err = macos.ListUpdates(ctx, true)
		resp.Updates, resp.Truncated = capRows(macos.PackageUpdates(l), req.Limit, defaultUpdates, maxUpdates)
	}
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			return proto.InspectResponse{Code: CodeTimeout, Message: "the view took too long"}
		}
		return proto.InspectResponse{Code: CodePlatformError, Message: err.Error()}
	}
	return resp
}

// Manage implements agent.Broker: OS updates (packages.check,
// packages.install) and their tasks; nothing else on a Mac.
func (m *MacBroker) Manage(_ context.Context, req proto.ManageRequest) proto.ManageResponse {
	if resp, ok := m.b.packagesManage(req); ok {
		return resp
	}
	return proto.ManageResponse{Code: CodeUnsupported, Message: "a Mac has only its updates to manage through Whombat"}
}

// PackageReport is the report's running package task and the last one
// that ended.
func (m *MacBroker) PackageReport() (*proto.PackageTask, *proto.PackageLast) {
	return m.b.PackageReport()
}
