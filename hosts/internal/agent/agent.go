// Package agent holds the agent runtime (connection to the hub, enrollment,
// buffering) and the interfaces implemented by the collectors
// (internal/agent/collect) and the console/action broker
// (internal/agent/broker).
package agent

import (
	"context"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Collector produces reports. Implemented by package collect.
type Collector interface {
	// Collect returns a full report of the host. It is called every
	// proto.ReportInterval; slow sub-collectors (SMART every 10 min, disks
	// every 60 s, KVM every 5 min) cache their last result internally.
	Collect(ctx context.Context) (*proto.Report, error)
	// Events delivers immediate change notifications (Docker, Incus,
	// libvirt event streams). A received event also triggers an early
	// report. The channel may be nil.
	Events() <-chan proto.Event
}

// Broker runs guest and host actions, screenshots, consoles and inspect
// views. Implemented by package broker. The runtime enforces the local
// Policy before calling it (streams.go); the broker must still validate
// that the guest exists in the latest inventory and never accept a socket
// path, port or command from the hub.
type Broker interface {
	// Action runs a guest action, or a host action (Platform
	// proto.PlatformHost).
	Action(ctx context.Context, req proto.ActionRequest) proto.ActionResponse
	Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse
	// Console opens the local endpoint for the guest (or the host) and
	// protocol. On failure it returns a nil session and a response with
	// OK=false.
	Console(ctx context.Context, req proto.ConsoleRequest) (ConsoleSession, proto.ConsoleResponse)
	// Inspect returns one read-only view: the host's processes, ports,
	// services or pending updates, or a guest's snapshots.
	Inspect(ctx context.Context, req proto.InspectRequest) proto.InspectResponse
	// Manage runs one guest configuration / lifecycle operation
	// (proto.StreamManage, docs/MANAGE.md).
	Manage(ctx context.Context, req proto.ManageRequest) proto.ManageResponse
}

// Diagnostics runs the hub's assistant's work on the host (docs/ASSIST.md
// 3): read-only checks from a fixed catalog and root shell commands.
// Implemented by package diagnose. The runtime enforces Policy.Diagnose
// and Policy.HostShell before calling it.
type Diagnostics interface {
	// Run runs one named check (proto.DiagnoseList: the catalog). The
	// implementation validates every argument and bounds its own time.
	Run(ctx context.Context, req proto.DiagnoseRequest) proto.DiagnoseResponse
	// Exec runs one shell command as root, outside the agent's sandbox.
	Exec(ctx context.Context, req proto.ExecRequest) proto.ExecResponse
}

// Screen runs the screen steps of a Mac (proto.StreamScreen): looking,
// clicking and typing through Screen Sharing, and finding buttons by name
// through Whombat Helper. Implemented by the macOS screen package; the
// runtime enforces Policy.HostShell (op "status" also Policy.Diagnose) and
// answers "unsupported" when the agent has none.
type Screen interface {
	Screen(ctx context.Context, req proto.ScreenRequest) proto.ScreenResponse
}

// ConsoleSession is an open console. Run pumps frames until ctx is
// cancelled, in is closed, or the local endpoint closes; it must release all
// local resources before returning.
//
// in receives frames from the browser: data frames for open channels and
// control frames ("resize", "open", "close"). Pings are answered by the
// runtime and never reach the session. out sends frames to the browser; the
// session sends data frames and control frames ("status", "opened",
// "closed", "error").
type ConsoleSession interface {
	Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error
}

// InventoryFunc returns the most recent report (nil before the first one).
// The broker uses it to validate guests.
type InventoryFunc func() *proto.Report
