package winpc

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Broker codes, as the Linux and Mac brokers answer them.
const (
	codeInvalid           = "invalid_request"
	codeUnsupported       = "unsupported"
	codeUnsupportedAction = "unsupported_action"
	codePlatformError     = "platform_error"
	hostID                = "host"
)

// hostPowerDelay lets the action's answer reach the hub before Windows
// starts to go down.
const hostPowerDelay = 3 * time.Second

// powerNotice is what Windows shows anyone signed in to the PC, and how
// long it gives open apps before it closes them.
const (
	powerNotice = "Whombat is restarting this PC."
	shutNotice  = "Whombat is shutting down this PC."
	powerGrace  = "15"
)

// Broker implements agent.Broker on a Windows PC: restart and shut down,
// and the process, port, service and update lists. A PC has no guest
// platforms, and Whombat doesn't open a shell or the screen on it.
type Broker struct {
	log     *slog.Logger
	updates func() []proto.PackageUpdate

	mu      sync.Mutex
	pending string // the host action under way
	delay   time.Duration
	run     func(argv []string) error
}

// NewBroker returns the broker of a PC; updates gives the collector's last
// list of waiting updates.
func NewBroker(log *slog.Logger, updates func() []proto.PackageUpdate) *Broker {
	if log == nil {
		log = slog.Default()
	}
	return &Broker{log: log, updates: updates, delay: hostPowerDelay, run: runPower}
}

// powerCommand is shutdown.exe's command for an action: planned
// maintenance, a notice, and 15 seconds before Windows closes open apps
// (a person at the PC sees it coming; an app waiting on a question
// doesn't hold the restart up).
func powerCommand(action string) []string {
	exe := filepath.Join(SystemRoot(), "System32", "shutdown.exe")
	if action == proto.ActionHostShutdown {
		return []string{exe, "/s", "/t", powerGrace, "/d", "p:4:1", "/c", shutNotice}
	}
	return []string{exe, "/r", "/t", powerGrace, "/d", "p:4:1", "/c", powerNotice}
}

func runPower(argv []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, clip(string(out), 200))
	}
	return nil
}

func hostOnly(platform, guest string) *proto.ActionResponse {
	switch {
	case platform != proto.PlatformHost:
		return &proto.ActionResponse{Code: codeUnsupported, Message: "a Windows PC runs no virtual machines or containers Whombat can reach"}
	case guest != hostID:
		return &proto.ActionResponse{Code: codeInvalid, Message: `host requests need guest "host"`}
	}
	return nil
}

// Action implements agent.Broker: restart or shut down the PC.
func (b *Broker) Action(_ context.Context, req proto.ActionRequest) proto.ActionResponse {
	if r := hostOnly(req.Platform, req.GuestID); r != nil {
		return *r
	}
	var state, what string
	switch req.Action {
	case proto.ActionHostReboot:
		state, what = "rebooting", "restart"
	case proto.ActionHostShutdown:
		state, what = "shutting_down", "shut down"
	default:
		return proto.ActionResponse{Code: codeUnsupportedAction, Message: fmt.Sprintf("action %q is not available for the host", req.Action)}
	}
	argv := powerCommand(req.Action)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending != "" {
		return proto.ActionResponse{OK: true, Noop: true, State: b.pending}
	}
	b.pending = state
	b.log.Warn("PC "+what+" requested through the hub; it starts in a few seconds", "delay", b.delay, "command", argv)
	time.AfterFunc(b.delay, func() {
		b.log.Warn("running the PC's "+what, "command", argv)
		if err := b.run(argv); err != nil {
			b.log.Error("the PC's "+what+" failed", "err", err)
			b.mu.Lock()
			b.pending = ""
			b.mu.Unlock()
		}
	})
	return proto.ActionResponse{OK: true, State: state,
		Message: fmt.Sprintf("The PC will %s in %d s", what, int(b.delay.Seconds())+15)}
}

// Thumbnail implements agent.Broker: Whombat doesn't show a PC's screen.
func (b *Broker) Thumbnail(context.Context, proto.ThumbnailRequest) proto.ThumbnailResponse {
	return proto.ThumbnailResponse{Code: codeUnsupported, Message: "Whombat can’t show a Windows PC’s screen"}
}

// Console implements agent.Broker: no shell or screen on a PC yet.
func (b *Broker) Console(context.Context, proto.ConsoleRequest) (agent.ConsoleSession, proto.ConsoleResponse) {
	return nil, proto.ConsoleResponse{Code: codeUnsupported, Message: "Whombat can’t open a console on a Windows PC yet"}
}

// Manage implements agent.Broker: a PC has no guests, and Whombat doesn't
// install Windows updates.
func (b *Broker) Manage(context.Context, proto.ManageRequest) proto.ManageResponse {
	return proto.ManageResponse{Code: codeUnsupported, Message: "unknown operation: Whombat doesn’t install Windows updates or manage guests on a PC"}
}

// Inspect implements agent.Broker: the processes, the listening ports,
// the services and the waiting updates.
func (b *Broker) Inspect(ctx context.Context, req proto.InspectRequest) proto.InspectResponse {
	switch req.Kind {
	case proto.InspectProcesses, proto.InspectPorts, proto.InspectServices, proto.InspectUpdates:
		if req.Platform != proto.PlatformHost || req.GuestID != hostID {
			return proto.InspectResponse{Code: codeInvalid, Message: `host views need platform "host" and guest "host"`}
		}
	case proto.InspectSnapshots:
		return proto.InspectResponse{Code: codeUnsupported, Message: "a Windows PC has no guests with snapshots"}
	default:
		return proto.InspectResponse{Code: codeUnsupported, Message: "unknown inspect kind"}
	}
	var resp proto.InspectResponse
	var err error
	switch req.Kind {
	case proto.InspectProcesses:
		var rows []proto.Process
		rows, err = processes(ctx)
		resp.Processes, resp.Truncated = capRows(rows, req.Limit, 100, 500)
	case proto.InspectPorts:
		var rows []proto.ListenPort
		rows, err = ports(ctx)
		resp.Ports, resp.Truncated = capRows(rows, req.Limit, 500, 500)
	case proto.InspectServices:
		var rows []proto.Service
		rows, err = services()
		resp.Services, resp.Truncated = capRows(rows, req.Limit, 1000, 2000)
	case proto.InspectUpdates:
		rows := b.updates()
		if rows == nil {
			return proto.InspectResponse{Code: codePlatformError, Message: "Windows Update hasn’t been read yet; try again in a minute"}
		}
		resp.Updates, resp.Truncated = capRows(rows, req.Limit, 2000, 2000)
	}
	if err != nil {
		return proto.InspectResponse{Code: codePlatformError, Message: clip(err.Error(), 300)}
	}
	return resp
}

func capRows[T any](rows []T, limit, def, maxN int) ([]T, bool) {
	n := limit
	if n <= 0 {
		n = def
	}
	n = min(n, maxN)
	if len(rows) > n {
		return rows[:n], true
	}
	if rows == nil {
		rows = []T{}
	}
	return rows, false
}

// processes lists the PC's processes by CPU use over one second.
func processes(ctx context.Context) ([]proto.Process, error) {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, err
	}
	type sample struct {
		p   *process.Process
		cpu float64
	}
	before := map[int32]float64{}
	for _, p := range procs {
		if t, err := p.TimesWithContext(ctx); err == nil {
			before[p.Pid] = t.User + t.System
		}
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(time.Second):
	}
	var rows []proto.Process
	users := map[string]string{}
	for _, p := range procs {
		t, err := p.TimesWithContext(ctx)
		if err != nil {
			continue
		}
		row := proto.Process{PID: int(p.Pid), State: "R"}
		if b, ok := before[p.Pid]; ok {
			row.CPUPct = round1(max(t.User+t.System-b, 0) * 100)
		}
		row.Name, _ = p.NameWithContext(ctx)
		if pp, err := p.PpidWithContext(ctx); err == nil {
			row.PPID = int(pp)
		}
		if mi, err := p.MemoryInfoWithContext(ctx); err == nil && mi != nil {
			row.RSSBytes = mi.RSS
		}
		if n, err := p.NumThreadsWithContext(ctx); err == nil {
			row.Threads = int(n)
		}
		if cl, err := p.CmdlineWithContext(ctx); err == nil {
			row.Command = clipBytes(cl, 512)
		}
		if row.Command == "" {
			row.Command = row.Name
		}
		if u, err := p.UsernameWithContext(ctx); err == nil {
			if short, ok := users[u]; ok {
				row.User = short
			} else {
				short = u
				if i := strings.LastIndexByte(u, '\\'); i >= 0 {
					short = u[i+1:]
				}
				users[u] = short
				row.User = short
			}
		}
		rows = append(rows, row)
	}
	slices.SortStableFunc(rows, func(a, b proto.Process) int {
		switch {
		case a.CPUPct != b.CPUPct:
			if a.CPUPct > b.CPUPct {
				return -1
			}
			return 1
		case a.RSSBytes != b.RSSBytes:
			if a.RSSBytes > b.RSSBytes {
				return -1
			}
			return 1
		}
		return a.PID - b.PID
	})
	return rows, nil
}

func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ports lists the listening TCP sockets and the bound UDP ones, with the
// process that holds each.
func ports(ctx context.Context) ([]proto.ListenPort, error) {
	conns, err := net.ConnectionsWithContext(ctx, "inet")
	if err != nil {
		return nil, err
	}
	names := map[int32]string{}
	name := func(pid int32) string {
		if pid <= 0 {
			return ""
		}
		if n, ok := names[pid]; ok {
			return n
		}
		n := ""
		if p, err := process.NewProcessWithContext(ctx, pid); err == nil {
			n, _ = p.NameWithContext(ctx)
		}
		names[pid] = n
		return n
	}
	var rows []proto.ListenPort
	seen := map[string]bool{}
	for _, c := range conns {
		var proto6 string
		switch {
		case c.Type == 1 && c.Status == "LISTEN": // SOCK_STREAM
			proto6 = "tcp"
		case c.Type == 2 && c.Raddr.IP == "": // SOCK_DGRAM, not connected
			proto6 = "udp"
		default:
			continue
		}
		if c.Family == 23 { // AF_INET6 on Windows
			proto6 += "6"
		}
		key := fmt.Sprintf("%s %s %d %d", proto6, c.Laddr.IP, c.Laddr.Port, c.Pid)
		if seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, protoPort(proto6, c.Laddr.IP, int(c.Laddr.Port), int(c.Pid), name(c.Pid)))
	}
	slices.SortFunc(rows, func(a, b proto.ListenPort) int {
		if a.Port != b.Port {
			return a.Port - b.Port
		}
		return strings.Compare(a.Proto, b.Proto)
	})
	return rows, nil
}

func protoPort(p, addr string, port, pid int, name string) proto.ListenPort {
	return proto.ListenPort{Proto: p, Address: addr, Port: port, PID: pid, Process: name}
}
