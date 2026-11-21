package main

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/yamux"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Simulated remote views and actions: the host's process / service / port
// / update lists, guest snapshots, pause and resume, host reboot and
// shutdown (answered, never done), the host journal and Docker logs.

var (
	snapMu sync.Mutex
	snaps  = map[string][]proto.Snapshot{} // host|platform|guest -> snapshots
)

// patchReport adds what the fake fleet does not model: Docker shell and
// logs, and the host access, manage and diagnose switches of the agent's
// configuration.
func (a *simAgent) patchReport(r *proto.Report) {
	if r.Docker != nil {
		for i := range r.Docker.Guests {
			r.Docker.Guests[i].Console = proto.ConsoleCaps{Protocols: []string{proto.ProtoShell, proto.ProtoLogs}, Default: proto.ProtoShell}
		}
	}
	r.Policy.HostShell, r.Policy.HostPower, r.Policy.Manage = a.o.hostShell, a.o.hostPower, a.o.manage
	r.Policy.Diagnose = true // the agent's default
	if a.o.updateKey != "" {
		r.Agent.UpdateKey = a.agentKey()
		r.Policy.Update = r.Agent.UpdateKey != "" && !a.o.updateOff[a.host.ID]
	}
	if r.Agent.Install == "" {
		r.Agent.Install = "systemd" // like an installed agent (the last install needs one)
	}
	if r.Agent.Arch == "" {
		r.Agent.Arch = "amd64"
	}
}

func seedOf(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// inspect answers the on-demand views.
func (a *simAgent) inspect(req proto.InspectRequest) proto.InspectResponse {
	switch {
	case req.Kind == proto.InspectSnapshots && !a.host.Policy.Power && !a.o.manage:
		// Like the agent: snapshots are taken under power.
		return proto.InspectResponse{Code: "remote_control_disabled", Message: "Power and manage are disabled in agent.toml."}
	case req.Kind == proto.InspectUpdates:
		// Diagnose (always on here) or console, like the agent (SWU-11).
	case req.Kind != proto.InspectSnapshots && !a.host.Policy.Console:
		return proto.InspectResponse{Code: "remote_control_disabled", Message: "Console is disabled in agent.toml."}
	}
	seed := seedOf(a.host.ID)
	now := time.Now().UTC()
	switch req.Kind {
	case proto.InspectProcesses:
		names := []struct{ name, cmd, user, ct string }{
			{"qemu-system-x86", "/usr/bin/qemu-system-x86_64 -name guest=build-runner -machine q35 -m 8192", "libvirt-qemu", ""},
			{"postgres", "postgres: 16/main: checkpointer", "postgres", "docker:postgres-main"},
			{"java", "java -Xmx2g -jar /opt/jellyfin/jellyfin.jar", "jellyfin", "docker:jellyfin"},
			{"prometheus", "/bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.retention.time=30d", "nobody", "docker:prometheus"},
			{"whombat-agent", "/usr/local/bin/whombat-agent run", "root", ""},
			{"dockerd", "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock", "root", ""},
			{"incusd", "incusd --group incus-admin --logfile /var/log/incus/incusd.log", "root", ""},
			{"zfs", "[z_wr_iss]", "root", ""},
			{"systemd-journal", "/usr/lib/systemd/systemd-journald", "root", ""},
			{"sshd", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", "root", ""},
			{"nginx", "nginx: worker process", "www-data", "docker:nginx"},
			{"node", "node /app/server.js", "node", "incus:dev-shell"},
			{"chronyd", "/usr/sbin/chronyd -F 1", "_chrony", ""},
			{"systemd", "/sbin/init", "root", ""},
			{"bash", "-bash", "john", ""},
		}
		var out []proto.Process
		for i, n := range names {
			cpu := float64((int(seed)>>(i%16))%400) / 10 * float64(len(names)-i) / float64(len(names))
			cpu += float64(now.Unix()%7) * 0.3 / float64(i+1)
			out = append(out, proto.Process{PID: 100 + i*137 + int(seed%97), PPID: 1, User: n.user, Name: n.name, Command: n.cmd,
				CPUPct: float64(int(cpu*10)) / 10, RSSBytes: uint64(20+i*37+int(seed>>i)%900) << 20, State: "S", Threads: 1 + i%12,
				Container: n.ct, Started: now.Add(-time.Duration(i*3600+int(seed%5000)) * time.Second)})
		}
		return proto.InspectResponse{Processes: out}
	case proto.InspectServices:
		list := []proto.Service{
			{Name: "ssh.service", Description: "OpenBSD Secure Shell server", Active: "active", Sub: "running", Enabled: "enabled"},
			{Name: "docker.service", Description: "Docker Application Container Engine", Active: "active", Sub: "running", Enabled: "enabled"},
			{Name: "whombat-agent.service", Description: "Whombat agent", Active: "active", Sub: "running", Enabled: "enabled"},
			{Name: "zfs-scrub-monthly@tank.timer", Description: "Monthly zpool scrub timer for tank", Active: "active", Sub: "waiting", Enabled: "enabled"},
			{Name: "smartd.service", Description: "Self Monitoring and Reporting Technology (SMART) Daemon", Active: "active", Sub: "running", Enabled: "enabled"},
			{Name: "nfs-server.service", Description: "NFS server and services", Active: "inactive", Sub: "dead", Enabled: "disabled"},
			{Name: "apt-daily-upgrade.timer", Description: "Daily apt upgrade and clean activities", Active: "active", Sub: "waiting", Enabled: "enabled"},
			{Name: "chrony.service", Description: "chrony, an NTP client/server", Active: "active", Sub: "running", Enabled: "enabled"},
		}
		if seed%2 == 0 {
			list = append(list, proto.Service{Name: "backup-offsite.service", Description: "Nightly restic backup to the offsite bucket", Active: "failed", Sub: "failed", Enabled: "static"})
		}
		for i := range list {
			list[i].Load = "loaded"
			list[i].Since = now.Add(-time.Duration(3600*(i+1)*int(1+seed%9)) * time.Second)
		}
		return proto.InspectResponse{Services: list}
	case proto.InspectPorts:
		return proto.InspectResponse{Ports: []proto.ListenPort{
			{Proto: "tcp", Address: "0.0.0.0", Port: 22, PID: 811, Process: "sshd"},
			{Proto: "tcp6", Address: "::", Port: 22, PID: 811, Process: "sshd"},
			{Proto: "tcp", Address: "127.0.0.1", Port: 5432, PID: 2210, Process: "postgres"},
			{Proto: "tcp", Address: "0.0.0.0", Port: 443, PID: 3120, Process: "nginx"},
			{Proto: "tcp6", Address: "::", Port: 8443, PID: 977, Process: "incusd"},
			{Proto: "udp", Address: "127.0.0.53", Port: 53, PID: 640, Process: "systemd-resolve"},
			{Proto: "udp", Address: "0.0.0.0", Port: 123, PID: 701, Process: "chronyd"},
			{Proto: "tcp", Address: "10.100.0.7", Port: 9100, PID: 1499, Process: "node_exporter"},
		}}
	case proto.InspectUpdates:
		// The report's counts (packages.go).
		return proto.InspectResponse{Updates: simWaiting(a.host.Packages())}
	case proto.InspectSnapshots:
		if _, ok := a.host.FindGuest(req.Platform, req.GuestID); !ok {
			return proto.InspectResponse{Code: "unknown_guest", Message: "No such guest on this host."}
		}
		snapMu.Lock()
		defer snapMu.Unlock()
		k := a.host.ID + "|" + req.Platform + "|" + req.GuestID
		if _, ok := snaps[k]; !ok {
			snaps[k] = []proto.Snapshot{
				{Name: "before-upgrade", Created: now.Add(-9 * 24 * time.Hour), Description: "Before the 26.05 upgrade"},
				{Name: "whombat-" + now.Add(-26*time.Hour).Format("20060102-150405"), Created: now.Add(-26 * time.Hour), Current: true},
			}
		}
		return proto.InspectResponse{Snapshots: append([]proto.Snapshot(nil), snaps[k]...)}
	}
	return proto.InspectResponse{Code: "unsupported", Message: "The simulator does not have this view."}
}

// remoteAction handles pause / resume, snapshots and host power; ok is
// false for the actions action() handles.
func (a *simAgent) remoteAction(req proto.ActionRequest) (proto.ActionResponse, bool) {
	switch req.Action {
	case proto.ActionHostReboot, proto.ActionHostShutdown:
		if !a.o.hostPower {
			return proto.ActionResponse{Code: "remote_control_disabled", Message: "Host power is disabled in agent.toml."}, true
		}
		what := "reboot"
		if req.Action == proto.ActionHostShutdown {
			what = "shut down"
		}
		log.Warn("simulated host power action (nothing happens)", "host", a.host.ID, "action", req.Action)
		return proto.ActionResponse{OK: true, State: "rebooting", Message: "The host will " + what + " in 5 s"}, true
	case proto.ActionPause, proto.ActionResume, proto.ActionSnapshotCreate, proto.ActionSnapshotRestore, proto.ActionSnapshotDelete:
	default:
		return proto.ActionResponse{}, false
	}
	g, ok := a.host.FindGuest(req.Platform, req.GuestID)
	if !ok {
		return proto.ActionResponse{Code: "guest_not_found", Message: "No such guest on this host."}, true
	}
	if !a.host.Policy.Power {
		return proto.ActionResponse{Code: "remote_control_disabled", Message: "Power actions are disabled in agent.toml."}, true
	}
	time.Sleep(700 * time.Millisecond)
	switch req.Action {
	case proto.ActionPause:
		if g.State != proto.StateRunning && g.State != proto.StateUnhealthy {
			return proto.ActionResponse{Code: "guest_not_running", Message: "the guest is not running", State: g.State}, true
		}
		a.host.SetGuestState(req.Platform, req.GuestID, proto.StatePaused)
		return proto.ActionResponse{OK: true, State: proto.StatePaused}, true
	case proto.ActionResume:
		if g.State != proto.StatePaused {
			return proto.ActionResponse{Code: "guest_not_paused", Message: "the guest is not paused", State: g.State}, true
		}
		a.host.SetGuestState(req.Platform, req.GuestID, proto.StateRunning)
		return proto.ActionResponse{OK: true, State: proto.StateRunning}, true
	}
	name := req.Args[proto.ArgSnapshot]
	k := a.host.ID + "|" + req.Platform + "|" + req.GuestID
	snapMu.Lock()
	defer snapMu.Unlock()
	list := snaps[k]
	idx := -1
	for i, s := range list {
		if s.Name == name {
			idx = i
		}
	}
	switch req.Action {
	case proto.ActionSnapshotCreate:
		if idx >= 0 {
			return proto.ActionResponse{Code: "invalid", Message: fmt.Sprintf("a snapshot named %q already exists", name)}, true
		}
		for i := range list {
			list[i].Current = false
		}
		snaps[k] = append(list, proto.Snapshot{Name: name, Created: time.Now().UTC(), Description: req.Args[proto.ArgDescription],
			WithMemory: req.Args[proto.ArgWithMemory] == "true", Current: true})
	case proto.ActionSnapshotRestore, proto.ActionSnapshotDelete:
		if idx < 0 {
			return proto.ActionResponse{Code: "unknown_snapshot", Message: fmt.Sprintf("the guest has no snapshot %q", name)}, true
		}
		if req.Action == proto.ActionSnapshotDelete {
			snaps[k] = append(list[:idx], list[idx+1:]...)
		} else {
			for i := range list {
				list[i].Current = i == idx
			}
		}
	}
	return proto.ActionResponse{OK: true, State: g.State, Message: "snapshot " + name}, true
}

// streamConsole answers the host journal, the host shell and Docker logs;
// false leaves the request to console().
func (a *simAgent) streamConsole(ctx context.Context, st *yamux.Stream, req proto.ConsoleRequest) bool {
	host := req.Platform == proto.PlatformHost
	logs := req.Protocol == proto.ProtoLogs
	if !host && !logs {
		return false
	}
	name := a.host.ID
	if !host {
		g, ok := a.host.FindGuest(req.Platform, req.GuestID)
		if !ok {
			return false
		}
		name = g.ID
	}
	if host && req.Protocol == proto.ProtoShell {
		if !a.o.hostShell {
			_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "remote_control_disabled", Message: "The host shell is disabled in agent.toml."})
			return true
		}
		return false // the fake shell of console()
	}
	if !a.host.Policy.Console {
		_ = wire.WriteMsg(st, proto.ConsoleResponse{Code: "remote_control_disabled", Message: "Console is disabled in agent.toml."})
		return true
	}
	if err := wire.WriteMsg(st, proto.ConsoleResponse{OK: true}); err != nil {
		return true
	}
	fw := wire.NewFrameWriter(st)
	var wmu sync.Mutex
	write := func(f wire.Frame) error {
		wmu.Lock()
		defer wmu.Unlock()
		_ = st.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return fw.Write(f)
	}
	b, _ := json.Marshal(wire.ConsoleControl{Type: "status", State: "connected", Protocol: proto.ProtoLogs})
	_ = write(wire.Frame{Kind: wire.FrameControl, Payload: b})
	line := func(t time.Time, i int) string {
		if host {
			units := []string{"systemd[1]: Started session-42.scope - Session 42 of User john.", "sshd[811]: Accepted publickey for john from 10.100.0.6 port 51022 ssh2",
				"kernel: zfs: pool tank scrub in progress, 41% done", "whombat-agent[1203]: report sent", "CRON[9921]: (root) CMD (/usr/local/bin/backup.sh)",
				"dockerd[1022]: level=info msg=\"ignoring event\" container=4c1e module=libcontainerd"}
			return fmt.Sprintf("%s %s %s\r\n", t.Format("Jan 02 15:04:05"), name, units[i%len(units)])
		}
		msgs := []string{"GET /health 200 1.2ms", "worker 3 picked job 1842", "cache hit ratio 0.93", "GET /api/items 200 18ms", "checkpoint complete: wrote 412 buffers"}
		return fmt.Sprintf("%s %s\r\n", t.Format(time.RFC3339), msgs[i%len(msgs)])
	}
	start := time.Now().Add(-40 * time.Minute)
	var sb strings.Builder
	for i := 0; i < 40; i++ {
		sb.WriteString(line(start.Add(time.Duration(i)*time.Minute), i))
	}
	_ = write(wire.Frame{Kind: wire.FrameData, Payload: []byte(sb.String())})
	// Drain the browser's frames (pings) and follow with a line every few seconds.
	go func() {
		fr := wire.NewFrameReader(st)
		for {
			f, err := fr.Read()
			if err != nil {
				return
			}
			var cc wire.ConsoleControl
			if f.Kind == wire.FrameControl && json.Unmarshal(f.Payload, &cc) == nil && cc.Type == "ping" {
				pb, _ := json.Marshal(wire.ConsoleControl{Type: "pong", ID: cc.ID})
				_ = write(wire.Frame{Kind: wire.FrameControl, Payload: pb})
			}
		}
	}()
	tick := time.NewTicker(4 * time.Second)
	defer tick.Stop()
	for i := 40; ; i++ {
		select {
		case <-ctx.Done():
			return true
		case t := <-tick.C:
			if write(wire.Frame{Kind: wire.FrameData, Payload: []byte(line(t, i))}) != nil {
				return true
			}
		}
	}
}
