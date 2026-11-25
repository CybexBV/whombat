package rules

import (
	"fmt"
	"math"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Alert rule ids (PRODUCT-SPEC section 5, "Default alert rules").
const (
	RuleHeartbeatMissing = "agent.heartbeat_missing"
	RuleTempHigh         = "sensor.temp_high"
	RuleTempCritical     = "sensor.temp_critical"
	RuleWearHigh         = "disk.wear_high"
	RuleWearCritical     = "disk.wear_critical"
	RuleSpaceHigh        = "disk.space_high"
	RuleOvercommit       = "hypervisor.overcommit"
	RuleMemAssigned      = "hypervisor.memory_assigned"
)

// Severities.
const (
	SevCritical = "critical"
	SevWarning  = "warning"
)

// Rule durations: how long a condition must hold before the alert fires.
const (
	TempHighFor       = 10 * time.Minute
	TempCriticalFor   = 5 * time.Minute
	OvercommitFor     = 30 * time.Minute
	OvercommitBusyPct = 80.0        // processors over-booked only count while the CPU is this busy
	SpaceFor          = time.Minute // disk.space_high
	// TempClearAfter is the hysteresis for temperature alerts: a firing alert
	// resolves only after its condition has been false this long.
	TempClearAfter = time.Minute
	// ClearAfter is the hysteresis of every other rule: a value hovering at
	// its threshold (a volume at 89.9 / 90.1%) keeps one alert open instead
	// of opening and resolving a new one with every report.
	ClearAfter = 10 * time.Minute
)

// Section links for the banner.
const (
	LinkStorage        = "#storage"
	LinkTemps          = "#temps"
	LinkVirtualization = "#virtualization"
)

// Text is the rendered text of an alert.
type Text struct {
	Title        string // "nvme1n1 wear at 78%"
	Detail       string // "936 of 1,200 TBW written"
	BannerTitle  string // "nvme1n1 wear is at 78%"
	BannerDetail string // "936 of 1,200 TBW written. Plan a replacement."
}

// Condition is a rule that currently holds for an entity of a host.
type Condition struct {
	Rule       string
	Entity     string // sensor id, disk device, "fs:/mount", "pool:x", "storage:x", "host"
	Severity   string
	For        time.Duration // condition must hold this long before firing
	ClearAfter time.Duration // firing alert resolves after the condition is false this long
	Link       string        // banner link ("#storage"), may be empty
	StatusNote string        // short reason on the server card ("disk wear")
	// Since, when set, is when the condition started (used instead of the
	// engine's own tracking, e.g. the last heartbeat) and is the alert's
	// opened_at.
	Since time.Time
	// Render produces the texts; held is how long the condition has held.
	Render func(held time.Duration) Text
}

// ServerRules are the alert rules evaluated for a server (the hub's own,
// check.* and security.*, belong to no server): the rules a server's watch
// settings can switch off (HS-195).
var ServerRules = []string{
	RuleHeartbeatMissing, RuleTempHigh, RuleTempCritical, RuleWearHigh, RuleWearCritical, RuleSpaceHigh,
	RuleOvercommit, RuleMemAssigned, RuleSMARTFailing, RuleSMARTErrors, RulePoolDegraded, RulePoolErrors,
	RuleRAIDDegraded, RuleReadOnlyFS, RuleInodesHigh, RuleQuorumLost, RuleBackupFailed, RuleReplication,
	RuleCeph, RuleTimeUnsynced, RuleUPSOnBattery, RuleLinkDown, RuleFanFailed, RuleOOM, RuleRestartLoop, RuleGuestStopped,
	RuleDiskFullSoon,
}

// IsServerRule reports whether rule is one of ServerRules.
func IsServerRule(rule string) bool {
	for _, r := range ServerRules {
		if r == rule {
			return true
		}
	}
	return false
}

// Key is the stable alert key of the condition (rule + entity).
func (c Condition) Key() string { return c.Rule + ":" + c.Entity }

func pct0(f float64) string { return fmt.Sprintf("%.0f", math.Round(f)) }

// HostConditions evaluates the report-based default rules for one host.
// The heartbeat rule is evaluated separately (HeartbeatCondition).
func HostConditions(r *proto.Report) []Condition {
	return HostConditionsWithLimits(r, nil)
}

func HostConditionsWithLimits(r *proto.Report, limits LimitLookup) []Condition {
	if r == nil {
		return nil
	}
	var out []Condition

	// Sensors.
	for _, s := range r.Sensors {
		if !finite(s.TempC) {
			continue
		}
		s := s
		limit := SensorLimit(s)
		critical, customCritical := limits.threshold(RuleTempCritical, s.ID, limit)
		thr, customHigh := warningThreshold(limits, RuleTempHigh, s.ID, TempWarnThreshold(limit), critical)
		high := (customHigh || limit > 0) && s.TempC >= thr-eps
		serious := (customCritical || limit > 0) && s.TempC >= critical-eps
		if !high && !serious {
			continue
		}
		label := s.Label
		if label == "" {
			label = s.ID
		}
		note := SensorShortName(s.ID) + " temperature"
		title := fmt.Sprintf("%s at %s", label, FormatTemp(s.TempC))
		bannerTitle := fmt.Sprintf("%s is at %s", label, FormatTemp(s.TempC))
		if high {
			out = append(out, Condition{
				Rule: RuleTempHigh, Entity: s.ID, Severity: SevWarning,
				For: TempHighFor, ClearAfter: TempClearAfter, Link: LinkTemps, StatusNote: note,
				Render: func(held time.Duration) Text {
					warning := FormatTemp(math.Floor(thr))
					d := fmt.Sprintf("Above %s for %s", warning, FormatDuration(held))
					bd := fmt.Sprintf("%s. The warning limit is %s.", d, warning)
					if customHigh {
						d = limitWords(s.TempC, thr, "°C") + " for " + FormatDuration(held)
						bd = d + "."
					}
					return Text{Title: title, Detail: d, BannerTitle: bannerTitle, BannerDetail: bd}
				},
			})
		}
		if serious {
			out = append(out, Condition{
				Rule: RuleTempCritical, Entity: s.ID, Severity: SevCritical,
				For: TempCriticalFor, ClearAfter: TempClearAfter, Link: LinkTemps, StatusNote: note,
				Render: func(held time.Duration) Text {
					d := fmt.Sprintf("At or above the %s limit for %s", FormatTemp(critical), FormatDuration(held))
					if customCritical {
						d = limitWords(s.TempC, critical, "°C") + " for " + FormatDuration(held)
					}
					return Text{Title: title, Detail: d, BannerTitle: bannerTitle,
						BannerDetail: d + ". Check cooling and load."}
				},
			})
		}
	}

	// SSD wear.
	for _, d := range r.Disks {
		w, ok := ssdWear(d)
		if !ok {
			continue
		}
		critical, customCritical := limits.threshold(RuleWearCritical, d.Device, WearSeriousPct)
		warning, customWarning := warningThreshold(limits, RuleWearHigh, d.Device, WearWarnPct, critical)
		if w < warning-eps && w < critical-eps {
			continue
		}
		dev := d.Device
		title := fmt.Sprintf("Disk %s is %s%% worn out", dev, pct0(w))
		bannerTitle := title
		evidence := wearEvidence(d)
		rule, sev, advice := RuleWearHigh, SevWarning, "Plan to replace it."
		threshold, custom := warning, customWarning
		if w >= critical-eps {
			rule, sev, advice = RuleWearCritical, SevCritical, "Replace the disk soon."
			threshold, custom = critical, customCritical
		}
		evidence = withLimitWords(evidence, w, threshold, "%", custom)
		bd := advice
		if evidence != "" {
			bd = evidence + ". " + advice
		}
		out = append(out, Condition{
			Rule: rule, Entity: dev, Severity: sev, ClearAfter: ClearAfter, Link: LinkStorage, StatusNote: "disk wear",
			Render: func(time.Duration) Text {
				return Text{Title: title, Detail: evidence, BannerTitle: bannerTitle, BannerDetail: bd}
			},
		})
	}

	// Space: filesystems (ZFS datasets are covered by their pool), pools and
	// Proxmox storages.
	for _, v := range spaceEntities(r) {
		p := v.usedPct()
		threshold, custom := limits.threshold(RuleSpaceHigh, v.entity, DiskUsedSeriousPct)
		if p < threshold-eps {
			continue
		}
		ev := withLimitWords(v.evidence(), p, threshold, "%", custom)
		name := PlainVolume(v.entity, v.label)
		title := fmt.Sprintf("%s %s%% full", name, pct0(p))
		bt := fmt.Sprintf("%s is %s%% full", name, pct0(p))
		out = append(out, Condition{
			Rule: RuleSpaceHigh, Entity: v.entity, Severity: SevWarning, For: SpaceFor, ClearAfter: ClearAfter,
			Link: LinkStorage, StatusNote: "disk space",
			Render: func(time.Duration) Text {
				return Text{Title: title, Detail: ev, BannerTitle: bt, BannerDetail: ev + ". Free up space or add more."}
			},
		})
	}

	// Hypervisor allocation.
	if IsHypervisor(r) {
		a := Allocation(r)
		threads := HostThreads(r)
		ratio := OvercommitRatio(a.VCPUAllocated, threads)
		// Several virtual processors per real one is normal at home: it only
		// matters while the server is also busy.
		if OvercommitLevel(ratio) == Warning && r.CPU.UsagePct >= OvercommitBusyPct-eps {
			rs := fmt.Sprintf("%.2f", ratio)
			alloc := a.VCPUAllocated
			out = append(out, Condition{
				Rule: RuleOvercommit, Entity: "host", Severity: SevWarning, For: OvercommitFor, ClearAfter: ClearAfter,
				Link: LinkVirtualization, StatusNote: "too few processors",
				Render: func(held time.Duration) Text {
					d := fmt.Sprintf("%d virtual processors share %d real ones (%s : 1) while it’s busy, for %s", alloc, threads, rs, FormatDuration(held))
					return Text{Title: "Machines want more processors than the server has", Detail: d,
						BannerTitle:  "Machines want more processors than the server has",
						BannerDetail: d + "."}
				},
			})
		}
		host := HostMemoryBytes(r)
		mp := MemAssignedPct(a.MemAssignedBytes, host)
		if host > 0 && mp >= MemAssignedSeriousPct-eps {
			ev := fmt.Sprintf("%s of %s given to running machines",
				FormatMemoryGB(float64(a.MemAssignedBytes)/GiB), FormatMemoryGB(float64(host)/GiB))
			out = append(out, Condition{
				Rule: RuleMemAssigned, Entity: "host", Severity: SevWarning, For: SpaceFor, ClearAfter: ClearAfter,
				Link: LinkVirtualization, StatusNote: "memory assigned",
				Render: func(time.Duration) Text {
					return Text{Title: fmt.Sprintf("Machines have %s%% of the memory", pct0(mp)), Detail: ev,
						BannerTitle: fmt.Sprintf("Machines have %s%% of the memory", pct0(mp)), BannerDetail: ev + "."}
				},
			})
		}
	}
	return append(out, healthConditions(r, limits)...)
}

// ssdWear returns the wear of an SSD (capped at 100 for display); ok is
// false for HDDs and disks without a wear value.
func ssdWear(d proto.Disk) (w float64, ok bool) {
	if !IsSSD(d) || d.WearPct == nil || !finite(*d.WearPct) {
		return 0, false
	}
	return WearDisplay(*d.WearPct), true
}

// spaceEntity is a volume watched by the space rules: a filesystem
// ("fs:/srv"), a pool ("pool:tank") or a Proxmox storage ("storage:local").
type spaceEntity struct {
	entity, label string
	used, total   uint64
}

func (v spaceEntity) usedPct() float64 { return float64(v.used) / float64(v.total) * 100 }

// evidence is the "440 GB of 1 TB used" text.
func (v spaceEntity) evidence() string {
	return fmt.Sprintf("%s of %s used", FormatStorageGB(float64(v.used)/GB), FormatStorageGB(float64(v.total)/GB))
}

// spaceEntities lists the volumes of the space rules (proto.Report.Volumes:
// filesystems except ZFS datasets, pools, active Proxmox storages).
func spaceEntities(r *proto.Report) []spaceEntity {
	var out []spaceEntity
	for _, v := range watchedVolumes(r) {
		out = append(out, spaceEntity{entity: v.Entity, label: v.Label, used: v.Used, total: v.Total})
	}
	return out
}

// watchedVolumes are the report's volumes without a Proxmox storage named
// like a ZFS pool: it is that pool seen by Proxmox, and both read
// “Storage “vmdata” 83% full” to people.
func watchedVolumes(r *proto.Report) []proto.Volume {
	pools := map[string]bool{}
	for _, p := range r.Pools {
		pools[p.Name] = true
	}
	var out []proto.Volume
	for _, v := range r.Volumes() {
		if id, ok := strings.CutPrefix(v.Entity, "storage:"); ok && pools[id] {
			continue
		}
		out = append(out, v)
	}
	return out
}

func wearEvidence(d proto.Disk) string {
	switch {
	case d.WrittenBytes != nil && d.RatedTBW != nil && *d.RatedTBW > 0:
		return fmt.Sprintf("%s of the %s TB it’s built to write",
			FormatNumber(float64(*d.WrittenBytes)/TB, 0), FormatNumber(*d.RatedTBW, 0))
	case d.WrittenBytes != nil:
		return fmt.Sprintf("%s TB written", FormatNumber(float64(*d.WrittenBytes)/TB, 0))
	}
	return "Worn by writing"
}

// HeartbeatCondition is the agent.heartbeat_missing condition for a host
// whose last heartbeat was at lastSeen (zero: never), evaluated at now. It
// returns false when the heartbeat is recent.
func HeartbeatCondition(lastSeen, now time.Time) (Condition, bool) {
	return HeartbeatConditionWith(lastSeen, now, HeartbeatTimeout)
}

// HeartbeatConditionWith is HeartbeatCondition with a configurable timeout.
func HeartbeatConditionWith(lastSeen, now time.Time, timeout time.Duration) (Condition, bool) {
	if !lastSeen.IsZero() && now.Sub(lastSeen) < timeout {
		return Condition{}, false
	}
	since := lastSeen
	if since.IsZero() {
		since = now
	}
	return Condition{
		Rule: RuleHeartbeatMissing, Entity: "host", Severity: SevCritical, StatusNote: "not checking in",
		Since: since,
		Render: func(time.Duration) Text {
			d := "Nothing heard from it yet"
			if !lastSeen.IsZero() {
				d = "Nothing heard from it for " + FormatDuration(now.Sub(lastSeen))
			}
			return Text{Title: "Whombat’s helper isn’t checking in", Detail: d, BannerTitle: "Whombat’s helper isn’t checking in", BannerDetail: d + "."}
		},
	}, true
}

// SeverityRank orders severities: critical first.
func SeverityRank(s string) int {
	if s == SevCritical {
		return 0
	}
	return 1
}
