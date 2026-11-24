package rules

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Host health rules: data the agent collects besides the core metrics
// (proto/health.go). Stateless rules are part of HostConditions; the ones
// that need history (OOM kills, container restarts) use a Memo, and the
// disk-full forecast comes from the volume series (Forecast).
const (
	RuleSMARTFailing = "disk.smart_failing"
	RuleSMARTErrors  = "disk.smart_errors"
	RulePoolDegraded = "pool.degraded"
	RulePoolErrors   = "pool.errors"
	RuleRAIDDegraded = "raid.degraded"
	RuleReadOnlyFS   = "fs.read_only"
	RuleInodesHigh   = "fs.inodes_high"
	RuleQuorumLost   = "pve.quorum_lost"
	RuleBackupFailed = "backup.failed"
	RuleReplication  = "pve.replication_failed"
	RuleCeph         = "ceph.health"
	RuleTimeUnsynced = "time.unsynced"
	RuleUPSOnBattery = "ups.on_battery"
	RuleLinkDown     = "net.link_down"
	RuleFanFailed    = "sensor.fan_failed"
	RuleOOM          = "host.oom"
	RuleRestartLoop  = "guest.restart_loop"
	RuleGuestStopped = "guest.stopped"
	RuleDiskFullSoon = "disk.full_soon"
)

// LinkSystem is the System card of the summary.
const LinkSystem = "#system"

// Health rule thresholds.
const (
	InodesHighPct    = 90.0
	TimeUnsyncedFor  = 30 * time.Minute
	UPSOnBatteryFor  = 30 * time.Second
	LinkDownFor      = 2 * time.Minute
	FanFailedFor     = 2 * time.Minute
	OOMWindow        = time.Hour        // host.oom holds this long after the last kill
	RestartWindow    = 15 * time.Minute // guest.restart_loop: restarts counted in this window
	RestartLoopCount = 3
	FullSoonDays     = 7.0  // disk.full_soon fires below this
	FullWatchDays    = 30.0 // hint below this
	ScrubStaleDays   = 45.0 // hint: no scrub for this long
	StealHintPct     = 10.0 // hint: CPU steal at or above
)

// NVMe critical_warning bits (NVMe base spec, SMART / health log).
var nvmeWarnings = []struct {
	bit  uint64
	text string
}{
	{0x01, "spare capacity below threshold"},
	{0x02, "temperature out of range"},
	{0x04, "reliability degraded by media errors"},
	{0x08, "media placed in read-only mode"},
	{0x10, "volatile memory backup failed"},
	{0x20, "persistent memory region read-only"},
}

// SmartFailure explains why a disk is failing, or "" when it is not.
func SmartFailure(d proto.Disk) string {
	var why []string
	if d.SmartPassed != nil && !*d.SmartPassed {
		why = append(why, "SMART overall health check failed")
	}
	if d.CriticalWarning != nil && *d.CriticalWarning != 0 {
		for _, w := range nvmeWarnings {
			if *d.CriticalWarning&w.bit != 0 {
				why = append(why, w.text)
			}
		}
		if len(why) == 0 {
			why = append(why, fmt.Sprintf("NVMe critical warning 0x%x", *d.CriticalWarning))
		}
	} else if d.SparePct != nil && d.SpareThreshold != nil && *d.SpareThreshold > 0 && *d.SparePct < *d.SpareThreshold {
		why = append(why, fmt.Sprintf("spare at %s%%, below the %s%% threshold", pct0(*d.SparePct), pct0(*d.SpareThreshold)))
	}
	if len(why) == 0 {
		return ""
	}
	s := strings.Join(why, ", ")
	return strings.ToUpper(s[:1]) + s[1:]
}

// SmartErrors lists the error counters worth a warning: pending and
// uncorrectable sectors, NVMe media errors and a failed self-test.
// Reallocated sectors and CRC errors are hints (often old and stable).
func SmartErrors(d proto.Disk) string {
	var why []string
	if d.Pending != nil && *d.Pending > 0 {
		why = append(why, plural(int64(*d.Pending), "pending sector", "pending sectors"))
	}
	if d.Uncorrectable != nil && *d.Uncorrectable > 0 {
		why = append(why, plural(int64(*d.Uncorrectable), "uncorrectable sector", "uncorrectable sectors"))
	}
	if d.MediaErrors != nil && *d.MediaErrors > 0 {
		why = append(why, plural(int64(*d.MediaErrors), "media error", "media errors"))
	}
	if t := d.SelfTest; t != nil && t.Result == "failed" {
		why = append(why, "the last "+t.Type+" self-test failed")
	}
	if len(why) == 0 {
		return ""
	}
	s := strings.Join(why, ", ")
	return strings.ToUpper(s[:1]) + s[1:]
}

func plural(n int64, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return Thousands(n) + " " + many
}

// cond is a shorthand for a condition with fixed texts.
func cond(rule, entity, sev, link, note, title, detail, advice string, forD time.Duration) Condition {
	bd := detail
	if advice != "" {
		if bd != "" {
			bd += ". "
		}
		bd += advice
	} else if bd != "" {
		bd += "."
	}
	return Condition{Rule: rule, Entity: entity, Severity: sev, For: forD, ClearAfter: ClearAfter, Link: link, StatusNote: note,
		Render: func(time.Duration) Text {
			return Text{Title: title, Detail: detail, BannerTitle: title, BannerDetail: bd}
		}}
}

// healthConditions evaluates the stateless host health rules.
func healthConditions(r *proto.Report, limits LimitLookup) []Condition {
	var out []Condition

	// Disks: SMART failing (critical) and error counters (warning).
	for _, d := range r.Disks {
		if why := SmartFailure(d); why != "" {
			out = append(out, cond(RuleSMARTFailing, d.Device, SevCritical, LinkStorage, "disk failing",
				"Disk "+d.Device+" is failing", why, "Back up its data and replace the disk.", 0))
		} else if why := SmartErrors(d); why != "" {
			out = append(out, cond(RuleSMARTErrors, d.Device, SevWarning, LinkStorage, "disk errors",
				"Disk "+d.Device+" is reporting errors", why, "Keep its backups current and plan to replace it.", 0))
		}
	}

	// ZFS pools.
	for _, p := range r.Pools {
		ent := "pool:" + p.Name
		h := strings.ToUpper(p.Health)
		switch {
		case h != "" && h != "ONLINE":
			title, d := "Storage “"+p.Name+"” isn’t working properly", "ZFS reports it as "+strings.ToLower(h)
			if h == "DEGRADED" {
				title = "Storage “" + p.Name + "” is missing a disk"
			}
			if len(p.Faulted) > 0 {
				d = strings.Join(p.Faulted, ", ") + " is offline; the data is at risk until it’s back"
			}
			out = append(out, cond(RulePoolDegraded, ent, SevCritical, LinkStorage, "missing a disk",
				title, d, "Replace or reconnect the missing disk.", 0))
		case p.ReadErrors+p.WriteErrors+p.CksumErrors > 0 || p.ScrubErrors > 0:
			var parts []string
			if n := p.ReadErrors + p.WriteErrors + p.CksumErrors; n > 0 {
				parts = append(parts, plural(int64(n), "error", "errors")+" reading or writing its disks")
			}
			if p.ScrubErrors > 0 {
				parts = append(parts, plural(int64(p.ScrubErrors), "error", "errors")+" found by the last data check")
			}
			out = append(out, cond(RulePoolErrors, ent, SevWarning, LinkStorage, "damaged data",
				"Storage “"+p.Name+"” found damaged data", strings.Join(parts, " · "), "Have its disks checked.", 0))
		}
	}

	// md / Unraid arrays.
	for _, a := range r.RAID {
		st := strings.ToLower(a.State)
		degraded := st == "degraded" || st == "failed" || st == "inactive" || (a.Devices > 0 && a.Active < a.Devices)
		if !degraded {
			continue
		}
		d := fmt.Sprintf("%d of %d disks working", a.Active, a.Devices)
		if len(a.Failed) > 0 {
			d += " · " + strings.Join(a.Failed, ", ") + " failed"
		}
		if a.SyncPct != nil && (st == "recovering" || st == "resyncing") {
			d += fmt.Sprintf(" · rebuilding, %s%% done", pct0(*a.SyncPct))
		}
		state := st
		if state == "" || (st != "failed" && st != "inactive") {
			state = "degraded"
		}
		link := LinkStorage
		if a.Level == "unraid" {
			link = LinkArray // the unRAID server page's Array tab
		}
		title := "One of " + a.Name + "’s disks has stopped working"
		if state != "degraded" {
			title = a.Name + "’s disks have stopped working"
		}
		out = append(out, cond(RuleRAIDDegraded, "raid:"+a.Name, SevCritical, link, "disk stopped",
			title, d, "Replace the failed disk.", 0))
	}

	// Filesystems: read-only remounts and inodes.
	for _, f := range r.Filesystems {
		ent := "fs:" + f.Mount
		if f.ReadOnly {
			out = append(out, cond(RuleReadOnlyFS, ent, SevCritical, LinkStorage, "can’t write",
				PlainVolume(ent, f.Mount)+" can’t be written to", "It switched to read-only, usually because the disk has problems",
				"Have the disk checked.", 0))
		}
		if f.InodesTotal > 0 {
			p := float64(f.InodesUsed) / float64(f.InodesTotal) * 100
			threshold, custom := limits.threshold(RuleInodesHigh, ent, InodesHighPct)
			if p >= threshold-eps {
				detail := fmt.Sprintf("%s%% of its room for files is used (%s of %s), even with space left", pct0(p), Thousands(int64(f.InodesUsed)), Thousands(int64(f.InodesTotal)))
				out = append(out, cond(RuleInodesHigh, ent, SevWarning, LinkStorage, "too many files",
					fmt.Sprintf("%s can’t take many more files", PlainVolume(ent, f.Mount)),
					withLimitWords(detail, p, threshold, "%", custom),
					"Remove small files you don’t need (caches, old mail, sessions).", SpaceFor))
			}
		}
	}

	// Proxmox: quorum, backups, replication, Ceph.
	if pve := r.PVE; pve != nil {
		if c := pve.Cluster; c != nil && !c.Quorate {
			out = append(out, cond(RuleQuorumLost, "cluster:"+c.Name, SevCritical, LinkVirtualization, "servers apart",
				"The servers of "+c.Name+" can’t reach each other", fmt.Sprintf("Only %d of %d are connected", c.VotesHave, c.VotesExpected),
				"Machines can’t be started or changed until they’re back together.", 0))
		}
		if b := pve.Backups; b != nil && b.LastJob != nil && b.LastJob.Result == "error" {
			j := b.LastJob
			d := fmt.Sprintf("%d of %d machines backed up", j.GuestsOK, j.GuestsTotal)
			out = append(out, Condition{Rule: RuleBackupFailed, Entity: "vzdump", Severity: SevWarning, ClearAfter: ClearAfter,
				Link: LinkVirtualization, StatusNote: "backup failed",
				Render: func(time.Duration) Text {
					return Text{Title: "Last backup failed", Detail: d, BannerTitle: "The last backup failed",
						BannerDetail: d + ". Proxmox’s backup log says why."}
				}})
		}
		for _, x := range pve.Replication {
			if x.Error == "" && x.FailCount == 0 {
				continue
			}
			d := x.Error
			if d == "" {
				d = plural(int64(x.FailCount), "failed run", "failed runs")
			}
			out = append(out, cond(RuleReplication, "repl:"+x.ID, SevWarning, LinkVirtualization, "copies failing",
				"Copies to "+x.Target+" are failing", x.ID+": "+d, "", 0))
		}
		if c := pve.Ceph; c != nil && c.Status != "" && c.Status != "HEALTH_OK" {
			sev := SevWarning
			if c.Status == "HEALTH_ERR" {
				sev = SevCritical
			}
			d := strings.Join(c.Summary, " · ")
			if d == "" {
				d = c.Status
			}
			title := "Shared storage (Ceph) has a warning"
			if c.Status == "HEALTH_ERR" {
				title = "Shared storage (Ceph) has a problem"
			}
			out = append(out, cond(RuleCeph, "ceph", sev, LinkVirtualization, "shared storage",
				title, d, "", 5*time.Minute))
		}
	}

	// Time sync.
	if s := r.System; s != nil && s.TimeSynced != nil && !*s.TimeSynced {
		title := "The clock is off"
		if s.TimeOffsetMs != nil {
			title += " by " + formatOffset(*s.TimeOffsetMs)
		}
		out = append(out, cond(RuleTimeUnsynced, "host", SevWarning, LinkSystem, "clock",
			title, "It isn’t setting its time from a time server", "Check that it can reach a time server ("+orDefault(s.TimeSource, "NTP")+").", TimeUnsyncedFor))
	}

	// UPS on battery.
	for _, u := range r.UPS {
		if u.Status != "on_battery" && u.Status != "low_battery" {
			continue
		}
		d := "The power is out (" + u.Name + ")"
		if u.ChargePct != nil {
			d += " · " + pct0(*u.ChargePct) + "% left"
		}
		if u.RuntimeS != nil {
			d += " · about " + FormatDuration(time.Duration(*u.RuntimeS)*time.Second)
		}
		sev, title, forD := SevWarning, "Running on battery", UPSOnBatteryFor
		if u.Status == "low_battery" {
			sev, title, forD = SevCritical, "The battery is almost empty", 0
		}
		c := cond(RuleUPSOnBattery, "ups:"+u.Name, sev, LinkSystem, "on battery", title, d, "", forD)
		c.ClearAfter = time.Minute
		out = append(out, c)
	}

	// Network: configured links without carrier, bond members down.
	for _, n := range r.Net {
		if n.Kind == "wireless" {
			continue
		}
		switch {
		case len(n.Addresses) > 0 && !n.Carrier:
			out = append(out, cond(RuleLinkDown, "net:"+n.Name, SevWarning, LinkSystem, "cable unplugged",
				"Network cable on "+n.Name+" is unplugged", "Nothing is connected to it, though it has the address "+n.Addresses[0], "Check the cable and the switch port.", LinkDownFor))
		case n.Kind == "bond":
			var down []string
			for _, m := range n.Members {
				for _, x := range r.Net {
					if x.Name == m && !x.Carrier {
						down = append(down, m)
					}
				}
			}
			if len(down) > 0 {
				out = append(out, cond(RuleLinkDown, "net:"+n.Name, SevWarning, LinkSystem, "cable unplugged",
					"One of "+n.Name+"’s network cables is unplugged", strings.Join(down, ", ")+" has nothing connected", "Check the cable and the switch port.", LinkDownFor))
			}
		}
	}

	// Fans below their minimum speed.
	for _, f := range r.Fans {
		if f.MinRPM > 0 && f.RPM < f.MinRPM {
			out = append(out, cond(RuleFanFailed, "fan:"+f.Source, SevWarning, LinkTemps, "fan",
				"A fan is turning too slowly", fmt.Sprintf("%s at %s rpm; it should be at least %s rpm", f.Label, Thousands(int64(f.RPM)), Thousands(int64(f.MinRPM))),
				"Check the fan.", FanFailedFor))
		}
	}
	return out
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func formatOffset(ms float64) string {
	a := math.Abs(ms)
	switch {
	case a >= 1000:
		return trim(ms/1000, 1) + " s"
	default:
		return trim(ms, 0) + " ms"
	}
}

// ---- stateful rules -------------------------------------------------------

// Memo remembers what the stateful rules need between reports of one host:
// the OOM kill counters and the restart counters of containers. The zero
// value is ready to use; the first report only sets the baseline.
type Memo struct {
	seen     bool
	oom      uint64
	oomLimit *uint64 // OOMLimitKills of the last report (nil: not reported)
	oomAt    []oomEvent
	restarts map[string]int         // guest key -> last restart count
	restAt   map[string][]time.Time // guest key -> restarts within RestartWindow
	names    map[string]string
}

type oomEvent struct {
	at time.Time
	n  uint64
}

// Observe updates the memo with a report taken at now.
func (m *Memo) Observe(r *proto.Report, now time.Time) {
	if r == nil {
		return
	}
	if m.restarts == nil {
		m.restarts, m.restAt, m.names = map[string]int{}, map[string][]time.Time{}, map[string]string{}
	}
	if s := r.System; s != nil {
		// host.oom is about the machine (LM-04): kills at a cgroup's own
		// limit do not count when the agent tells them apart in this and
		// the last report. A limit count that went down (the agent
		// restarted and read less of the log) takes nothing off.
		if m.seen && s.OOMKills > m.oom {
			n := s.OOMKills - m.oom
			if l, p := s.OOMLimitKills, m.oomLimit; l != nil && p != nil && *l > *p {
				n -= min(*l-*p, n)
			}
			if n > 0 {
				m.oomAt = append(m.oomAt, oomEvent{now, n})
			}
		}
		m.oom = s.OOMKills
		m.oomLimit = nil
		if s.OOMLimitKills != nil {
			l := *s.OOMLimitKills
			m.oomLimit = &l
		}
	}
	keep := m.oomAt[:0]
	for _, e := range m.oomAt {
		if now.Sub(e.at) < OOMWindow {
			keep = append(keep, e)
		}
	}
	m.oomAt = keep

	present := map[string]bool{}
	for _, g := range r.AllGuests() {
		if g.RestartCount == nil {
			continue
		}
		k := g.Platform + "/" + g.ID
		present[k] = true
		n := *g.RestartCount
		if old, ok := m.restarts[k]; ok && n > old {
			for i := 0; i < n-old && i < 10; i++ {
				m.restAt[k] = append(m.restAt[k], now)
			}
		}
		m.restarts[k] = n
		m.names[k] = orDefault(g.Name, g.ID)
	}
	for k, ts := range m.restAt {
		var keep []time.Time
		for _, t := range ts {
			if now.Sub(t) < RestartWindow {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 || !present[k] {
			delete(m.restAt, k)
		} else {
			m.restAt[k] = keep
		}
	}
	for k := range m.restarts {
		if !present[k] {
			delete(m.restarts, k)
			delete(m.names, k)
		}
	}
	m.seen = true
}

// Conditions returns the stateful conditions at now.
func (m *Memo) Conditions(now time.Time) []Condition {
	var out []Condition
	if len(m.oomAt) > 0 {
		var n uint64
		for _, e := range m.oomAt {
			n += e.n
		}
		last := m.oomAt[len(m.oomAt)-1].at
		d := "It had to stop " + plural(int64(n), "program", "programs") + " in the last hour"
		out = append(out, Condition{Rule: RuleOOM, Entity: "host", Severity: SevWarning, ClearAfter: time.Minute, Link: LinkSystem,
			StatusNote: "out of memory",
			Render: func(time.Duration) Text {
				return Text{Title: "The server ran out of memory", Detail: d, BannerTitle: "The server ran out of memory",
					BannerDetail: d + ", the last " + FormatRelative(now.Sub(last)) + ". Give it more memory, or let its machines use less."}
			}})
	}
	keys := make([]string, 0, len(m.restAt))
	for k := range m.restAt {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		ts := m.restAt[k]
		if len(ts) < RestartLoopCount {
			continue
		}
		name := m.names[k]
		d := fmt.Sprintf("Restarted %d times in %s", len(ts), FormatDuration(RestartWindow))
		out = append(out, Condition{Rule: RuleRestartLoop, Entity: k, Severity: SevWarning, ClearAfter: RestartWindow, Link: LinkGuests,
			StatusNote: "restart loop",
			Render: func(time.Duration) Text {
				return Text{Title: name + " keeps restarting", Detail: d, BannerTitle: name + " keeps restarting",
					BannerDetail: d + ". Its logs say why."}
			}})
	}
	return out
}

// ---- kills at a cgroup's own memory limit ---------------------------------

// oomLimitHints are the memory.limit hints (LM-04): processes the kernel
// killed in the last hour because a guest or another cgroup reached its
// own memory limit, from agents that tell them from the machine running
// out (host.oom). One quiet note per guest, and one for the other cgroups
// (a service's or a session's limit).
func oomLimitHints(r *proto.Report, now time.Time) []Hint {
	s := r.System
	if s == nil || len(s.OOMLimited) == 0 {
		return nil
	}
	type group struct {
		gid, name string
		n         int
		last      time.Time
		what      []string // "python3", or "python3 in backup.service"
	}
	names := map[string]string{}
	for _, g := range r.AllGuests() {
		names[g.Platform+":"+g.ID] = orDefault(g.Name, g.ID)
	}
	var guests []*group
	byID := map[string]*group{}
	other := &group{}
	for _, k := range s.OOMLimited {
		if now.Sub(k.At) >= OOMWindow {
			continue
		}
		g, what := other, orDefault(k.Process, "a process")
		if gid := oomGuestID(k); gid != "" {
			if g = byID[gid]; g == nil {
				g = &group{gid: gid, name: orDefault(names[gid], k.GuestID)}
				byID[gid] = g
				guests = append(guests, g)
			}
		} else if place := cgroupName(k.Cgroup); place != "" {
			what += " in " + place
		}
		g.n++
		if k.At.After(g.last) {
			g.last = k.At
		}
		if !slices.Contains(g.what, what) {
			g.what = append(g.what, what)
		}
	}
	sort.SliceStable(guests, func(i, j int) bool { return guests[i].name < guests[j].name })
	var out []Hint
	for _, g := range guests {
		title := g.name + " ran out of its memory"
		if g.n > 1 {
			title = fmt.Sprintf("%s ran out of its memory %d times", g.name, g.n)
		}
		out = append(out, Hint{Kind: HintMemoryLimit, Severity: HintInfo, Entity: g.gid, Link: LinkGuests, Guests: []string{g.gid},
			Title: title, Detail: stoppedText(g.what, g.n, now.Sub(g.last)) + ". The server itself has memory to spare."})
	}
	// Kills outside machines are a service's or a login session's own limit
	// (test runs, builds): nothing the person runs or can act on.
	return out
}

// oomGuestID is the hub guest id of a kill's guest, "" when it has none.
func oomGuestID(k proto.OOMKill) string {
	switch k.Platform {
	case proto.PlatformDocker, proto.PlatformIncus, proto.PlatformLibvirt, proto.PlatformPVE:
		if k.GuestID != "" {
			return k.Platform + ":" + k.GuestID
		}
	}
	return ""
}

// stoppedText says which processes were stopped and when: "python3 was
// stopped 12 min ago", "php-fpm was stopped 3 times, the last 2 min ago",
// "java and node were stopped, the last 2 min ago".
func stoppedText(what []string, n int, ago time.Duration) string {
	when := FormatRelative(ago)
	switch {
	case n == 1:
		return what[0] + " was stopped " + when
	case len(what) == 1:
		return fmt.Sprintf("%s was stopped %d times, the last %s", what[0], n, when)
	}
	return joinAnd(what, 3) + " were stopped, the last " + when
}

// joinAnd is "a", "a and b", "a, b and c", "a, b, c and 2 more".
func joinAnd(l []string, max int) string {
	if len(l) > max {
		return strings.Join(l[:max], ", ") + fmt.Sprintf(" and %d more", len(l)-max)
	}
	if len(l) < 2 {
		return strings.Join(l, "")
	}
	return strings.Join(l[:len(l)-1], ", ") + " and " + l[len(l)-1]
}

// cgroupName is the last part of a cgroup path, systemd's \xNN escapes
// undone ("wbtest159958.slice").
func cgroupName(cg string) string {
	cg = strings.TrimRight(cg, "/")
	if i := strings.LastIndexByte(cg, '/'); i >= 0 {
		cg = cg[i+1:]
	}
	var b strings.Builder
	for i := 0; i < len(cg); i++ {
		if cg[i] == '\\' && i+3 < len(cg) && cg[i+1] == 'x' {
			if v, err := strconv.ParseUint(cg[i+2:i+4], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(cg[i])
	}
	return b.String()
}

// ---- disk-full forecast ---------------------------------------------------

// Point is one value of a series.
type Point struct {
	T time.Time
	V float64
}

// Forecast fits a line through a volume's used-% history and returns the
// days until it reaches 100%. ok is false without enough history (24 h
// span, 12 points), when usage is not growing, or when full is more than a
// year away.
func Forecast(pts []Point) (days float64, ok bool) {
	if len(pts) < 12 {
		return 0, false
	}
	t0 := pts[0].T
	span := pts[len(pts)-1].T.Sub(t0)
	if span < 24*time.Hour {
		return 0, false
	}
	var sx, sy, sxx, sxy float64
	n := float64(len(pts))
	for _, p := range pts {
		x := p.T.Sub(t0).Hours() / 24
		sx += x
		sy += p.V
		sxx += x * x
		sxy += x * p.V
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return 0, false
	}
	slope := (n*sxy - sx*sy) / den // % per day
	if slope < 0.01 {
		return 0, false
	}
	last := pts[len(pts)-1]
	// The fitted value now, not the last sample: robust to a temporary spike.
	intercept := (sy - slope*sx) / n
	now := intercept + slope*last.T.Sub(t0).Hours()/24
	if now < last.V {
		now = last.V
	}
	days = (100 - now) / slope
	if days < 0 {
		days = 0
	}
	if days > 365 {
		return 0, false
	}
	return days, true
}

// FullSoonCondition is the disk.full_soon condition of a volume that is
// forecast to be full in days.
func FullSoonCondition(entity, label string, days float64) (Condition, bool) {
	if days >= FullSoonDays {
		return Condition{}, false
	}
	when := FormatDays(days)
	return Condition{Rule: RuleDiskFullSoon, Entity: entity, Severity: SevWarning, ClearAfter: time.Hour, Link: LinkStorage,
		StatusNote: "filling up",
		Render: func(time.Duration) Text {
			name := PlainVolume(entity, label)
			return Text{Title: name + " full " + when, Detail: "At the rate it filled last week",
				BannerTitle: name + " will be full " + when, BannerDetail: "At the rate it filled last week. Free up space or add more."}
		}}, true
}

// FormatDays is "in about 3 days", "within a day".
func FormatDays(days float64) string {
	switch {
	case days < 1:
		return "within a day"
	case days < 1.5:
		return "in about a day"
	default:
		return fmt.Sprintf("in about %d days", int(math.Round(days)))
	}
}

// ---- hints ----------------------------------------------------------------

// healthHints are the host health hints (things worth a look, no alert).
func healthHints(r *proto.Report, open []Alert) []Hint {
	var out []Hint
	if s := r.System; s != nil {
		if s.FailedCount > 0 {
			// The unit's name as people know the service: without “.service”.
			units := firstN(s.FailedUnits, UnhealthyNames)
			names := make([]string, len(units))
			for i, u := range units {
				names[i] = strings.TrimSuffix(u, ".service")
			}
			d := strings.Join(names, ", ")
			if s.FailedCount > len(firstN(s.FailedUnits, UnhealthyNames)) {
				d += ", …"
			}
			out = append(out, Hint{Kind: HintFailedUnits, Severity: HintWarning, Entity: "host", Link: LinkSystem,
				Title: plural(int64(s.FailedCount), "service failed", "services failed"), Detail: d})
		}
		if s.UpdatesPending != nil && *s.UpdatesPending > 0 {
			// Info even with security updates: pending updates are routine on
			// most hosts, a warning on every one of them would be noise. The
			// package manager's name means nothing to most people: only the
			// security updates are worth saying.
			d := ""
			if s.SecurityUpdates != nil && *s.SecurityUpdates > 0 {
				d = plural(int64(*s.SecurityUpdates), "security update", "security updates")
			}
			out = append(out, Hint{Kind: HintUpdates, Severity: HintInfo, Entity: "host", Link: LinkSystem,
				Title: plural(int64(*s.UpdatesPending), "update waiting", "updates waiting"), Detail: d})
		}
		if s.RebootRequired {
			out = append(out, Hint{Kind: HintReboot, Severity: HintInfo, Entity: "host", Link: LinkSystem,
				Title: "Restart needed", Detail: "To finish installing updates"})
		}
	}
	if r.CPU.StealPct >= StealHintPct-eps {
		out = append(out, Hint{Kind: HintSteal, Severity: HintInfo, Entity: "host",
			Title: "This server is slowed down by its host", Detail: "The computer it runs on gives it " + pct0(r.CPU.StealPct) + "% less processing time than it asks for"})
	}
	for _, d := range r.Disks {
		if alerted(open, d.Device, RuleSMARTFailing, RuleSMARTErrors) {
			continue
		}
		var parts []string
		if d.Reallocated != nil && *d.Reallocated > 0 {
			parts = append(parts, plural(int64(*d.Reallocated), "worn spot", "worn spots")+" replaced")
		}
		if d.CRCErrors != nil && *d.CRCErrors > 0 {
			parts = append(parts, plural(int64(*d.CRCErrors), "cable error", "cable errors"))
		}
		if len(parts) > 0 {
			out = append(out, Hint{Kind: HintDiskCounters, Severity: HintInfo, Entity: d.Device, Link: LinkStorage,
				Title: "Disk " + d.Device + " has had a few errors", Detail: strings.Join(parts, " · ")})
		}
	}
	for _, p := range r.Pools {
		if alerted(open, "pool:"+p.Name, RulePoolDegraded, RulePoolErrors) {
			continue
		}
		switch {
		case p.ScrubState == "none":
			out = append(out, Hint{Kind: HintScrubStale, Severity: HintInfo, Entity: "pool:" + p.Name, Link: LinkStorage,
				Title: "Storage “" + p.Name + "” has never been checked for damage", Detail: "A monthly data check finds hidden damage early"})
		case p.ScrubState == "finished" && !p.ScrubEnd.IsZero() && time.Since(p.ScrubEnd) > time.Duration(ScrubStaleDays*24)*time.Hour:
			out = append(out, Hint{Kind: HintScrubStale, Severity: HintInfo, Entity: "pool:" + p.Name, Link: LinkStorage,
				Title: "Storage “" + p.Name + "” hasn’t been checked for damage lately", Detail: "Last checked " + p.ScrubEnd.UTC().Format("2 Jan 2006")})
		}
	}
	for _, a := range r.RAID {
		st := strings.ToLower(a.State)
		if (st == "resyncing" || st == "checking" || st == "recovering") && !alerted(open, "raid:"+a.Name, RuleRAIDDegraded) {
			title := a.Name + "’s disks are syncing"
			if st == "checking" {
				title = a.Name + "’s disks are being checked"
			}
			if a.SyncPct != nil {
				title += " (" + pct0(*a.SyncPct) + "%)"
			}
			out = append(out, Hint{Kind: HintArraySync, Severity: HintInfo, Entity: "raid:" + a.Name, Link: LinkStorage,
				Title: title, Detail: "It’s slower until it’s done"})
		}
	}
	if pve := r.PVE; pve != nil && pve.Backups != nil && pve.Backups.LastJob != nil && pve.Backups.LastJob.Result == "warning" {
		j := pve.Backups.LastJob
		out = append(out, Hint{Kind: HintBackupWarning, Severity: HintInfo, Entity: "vzdump", Link: LinkVirtualization,
			Title: "The last backup had a problem", Detail: fmt.Sprintf("%d of %d machines backed up · %s", j.GuestsOK, j.GuestsTotal, plural(int64(j.Warnings), "warning", "warnings"))})
	}
	for _, pl := range []struct {
		name string
		p    *proto.Platform
	}{{"Docker", r.Docker}, {"The virtual machine service", r.Libvirt}} { // Incus: incus.warning (incus.go)
		if pl.p == nil || len(pl.p.Warnings) == 0 {
			continue
		}
		w := pl.p.Warnings[0]
		d := w.Message
		if n := len(pl.p.Warnings); n > 1 {
			d += fmt.Sprintf(" (+%d more)", n-1)
		}
		entity := "docker"
		if pl.p == r.Libvirt {
			entity = "libvirt"
		}
		out = append(out, Hint{Kind: HintPlatformWarning, Severity: HintInfo, Entity: entity, Link: LinkGuests,
			Title: pl.name + " has " + plural(int64(len(pl.p.Warnings)), "warning", "warnings"), Detail: d})
	}
	if r.Docker != nil && r.Unraid == nil { // unRAID: docker.update_available (unraid.go)
		var names []string
		for _, g := range r.Docker.Guests {
			if g.UpdateAvailable != nil && *g.UpdateAvailable {
				names = append(names, orDefault(g.Name, g.ID))
			}
		}
		if len(names) > 0 {
			out = append(out, Hint{Kind: HintImageUpdates, Severity: HintInfo, Entity: "docker", Link: LinkGuests,
				Title: plural(int64(len(names)), "app has an update", "apps have updates"), Detail: someNames(names, 2)})
		}
	}
	return out
}

// ForecastHints are the "full in N days" hints of a host's volumes
// (forecast: entity -> days; labels from the report).
func ForecastHints(r *proto.Report, forecast map[string]float64, open []Alert) []Hint {
	if r == nil || len(forecast) == 0 {
		return nil
	}
	var out []Hint
	for _, v := range watchedVolumes(r) {
		days, ok := forecast[v.Entity]
		if !ok || days >= FullWatchDays || alerted(open, v.Entity, RuleDiskFullSoon, RuleSpaceHigh) {
			continue
		}
		out = append(out, Hint{Kind: HintFullForecast, Severity: HintInfo, Entity: v.Entity, Link: LinkStorage,
			Title: PlainVolume(v.Entity, v.Label) + " full " + FormatDays(days), Detail: "At the rate it filled last week"})
	}
	return out
}

// someNames is a short list for a detail line: “web, db and 6 more”.
func someNames(names []string, n int) string {
	if len(names) <= n {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:n], ", ") + fmt.Sprintf(" and %d more", len(names)-n)
}

func firstN(l []string, n int) []string {
	if len(l) > n {
		return l[:n]
	}
	return l
}
