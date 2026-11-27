package rules

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Hint kinds (docs/CONTRACT.md 1, "hints").
const (
	HintNearLimit       = "sensor.near_limit"
	HintSwapHigh        = "swap.high"
	HintMemoryLow       = "memory.low"
	HintDiskSpace       = "disk.space"
	HintDiskWear        = "disk.wear"
	HintCollectorError  = "collector.error"
	HintGuestsUnhealthy = "guests.unhealthy"
	HintAgentOutdated   = "agent.outdated"
	HintUpdates         = "system.updates"
	HintReboot          = "system.reboot"
	HintFailedUnits     = "system.failed_units"
	HintDiskCounters    = "disk.counters"
	HintScrubStale      = "pool.scrub"
	HintArraySync       = "raid.sync"
	HintBackupWarning   = "backup.warning"
	HintPlatformWarning = "platform.warnings"
	HintImageUpdates    = "docker.image_updates"
	HintSteal           = "cpu.steal"
	HintFullForecast    = "disk.forecast"
	// HintMemoryLimit: processes killed at a guest's or another cgroup's
	// own memory limit in the last hour (LM-04; health.go).
	HintMemoryLimit = "memory.limit"
)

// Hint severities: warning (worth a look now) or info (for the record).
const (
	HintWarning = "warning"
	HintInfo    = "info"
)

// Section links of hints, besides LinkStorage, LinkTemps and
// LinkVirtualization.
const (
	LinkGuests = "#guests"
	LinkAgent  = "#agent"
)

// Hint thresholds.
const (
	NearLimitRatio     = 0.70 // sensor at or above 70% of its limit
	SwapHighRatio      = 0.80 // swap used / total at or above: info
	SwapWarnRatio      = 0.90 // warning
	SwapRAMUsedRatio   = 0.80 // and only while memory is this full: idle pages parked in swap are no problem
	SwapMinBytes       = GiB  // smaller swap devices are not watched
	MemoryLowRatio     = 0.10 // memory available / total below: info
	MemoryLowWarnRatio = 0.05 // warning
	WearWatchPct       = 60.0 // SSD wear at or above (below WearWarnPct): info
	UnhealthyNames     = 5    // container names listed by guests.unhealthy
)

// Hint is a condition worth watching that is not (yet) an alert.
type Hint struct {
	// ID is the hint's stable id within its server, kind + ":" + entity
	// (set by the hub's model.BuildHints, HS-192).
	ID       string `json:"id"`
	Kind     string `json:"kind"`     // one of the Hint* kinds
	Severity string `json:"severity"` // "warning" | "info"
	Entity   string `json:"entity"`   // sensor id, device, volume ("fs:/srv"), collector name, "docker", "host"
	Title    string `json:"title"`    // "CPU package at 80 °C"
	Detail   string `json:"detail"`   // "94% of the 85 °C limit"
	Link     string `json:"link"`     // "#temps" | "#storage" | "#virtualization" | "#guests" | "#agent" | ""
	// Guests: the hub guest ids a per-host guest hint is about, when it
	// names guests (incus.no_snapshots), for a way out to the guest.
	Guests []string `json:"guests,omitempty"`

	Code   string         `json:"code,omitempty"`
	Params map[string]any `json:"params,omitempty"`
}

// HintRank orders hint severities: warning first.
func HintRank(severity string) int {
	if severity == HintWarning {
		return 0
	}
	return 1
}

// HostHints evaluates the hint rules for one report. hubVersion is the hub's
// own version string (for agent.outdated); open are the host's open alerts
// (hints already covered by an open alert are skipped). Warnings come
// first, then info; the order is stable within a severity.
func HostHints(r *proto.Report, hubVersion string, open []Alert) []Hint {
	if r == nil {
		return nil
	}
	var out []Hint

	// Sensors near their limit (the alert fires at 85% after 10 minutes).
	for _, s := range r.Sensors {
		if !finite(s.TempC) {
			continue
		}
		limit := SensorLimit(s)
		ratio := s.TempC / limit
		if ratio < NearLimitRatio-eps || alerted(open, s.ID, RuleTempHigh, RuleTempCritical) {
			continue
		}
		sev := HintInfo
		if TempLevel(s.TempC, limit) != Good {
			sev = HintWarning // the alert has not held long enough yet
		}
		label := s.Label
		if label == "" {
			label = s.ID
		}
		out = append(out, Hint{Kind: HintNearLimit, Severity: sev, Entity: s.ID, Link: LinkTemps,
			Code: HintNearLimit, Params: map[string]any{"sensor": s.ID, "label": label, "tempC": s.TempC, "limitC": limit, "pct": ratio * 100},
			Title:  fmt.Sprintf("%s at %s", label, FormatTemp(s.TempC)),
			Detail: fmt.Sprintf("%s%% of the %s limit", pct0(ratio*100), FormatTemp(limit))})
	}

	// Swap and memory.
	m := r.Memory
	if m.SwapTotalBytes >= SwapMinBytes && m.TotalBytes > 0 && float64(m.UsedBytes)/float64(m.TotalBytes) >= SwapRAMUsedRatio-eps {
		ratio := float64(m.SwapUsedBytes) / float64(m.SwapTotalBytes)
		if ratio >= SwapHighRatio-eps {
			sev := HintInfo
			if ratio >= SwapWarnRatio-eps {
				sev = HintWarning
			}
			d := fmt.Sprintf("%s of %s used", FormatMemoryGB(float64(m.SwapUsedBytes)/GiB), FormatMemoryGB(float64(m.SwapTotalBytes)/GiB))
			d += fmt.Sprintf(" · RAM %s%% used", pct0(float64(m.UsedBytes)/float64(m.TotalBytes)*100))
			out = append(out, Hint{Kind: HintSwapHigh, Severity: sev, Entity: "host", Title: "Swap almost full", Detail: d,
				Code: HintSwapHigh, Params: map[string]any{"usedGiB": float64(m.SwapUsedBytes) / GiB, "totalGiB": float64(m.SwapTotalBytes) / GiB,
					"ramPct": float64(m.UsedBytes) / float64(m.TotalBytes) * 100}})
		}
	}
	if m.TotalBytes > 0 {
		ratio := float64(m.AvailableBytes) / float64(m.TotalBytes)
		if ratio < MemoryLowRatio-eps {
			sev := HintInfo
			if ratio < MemoryLowWarnRatio-eps {
				sev = HintWarning
			}
			out = append(out, Hint{Kind: HintMemoryLow, Severity: sev, Entity: "host", Title: "Memory almost full",
				Code: HintMemoryLow, Params: map[string]any{"availableGiB": float64(m.AvailableBytes) / GiB, "totalGiB": float64(m.TotalBytes) / GiB},
				Detail: fmt.Sprintf("%s available of %s", FormatMemoryGB(float64(m.AvailableBytes)/GiB), FormatMemoryGB(float64(m.TotalBytes)/GiB))})
		}
	}

	// Space: the warning band (80 to 89%); 90% and above is an alert.
	for _, v := range spaceEntities(r) {
		p := v.usedPct()
		if DiskUsedLevel(p) != Warning || alerted(open, v.entity, RuleSpaceHigh) {
			continue
		}
		out = append(out, Hint{Kind: HintDiskSpace, Severity: HintInfo, Entity: v.entity, Link: LinkStorage,
			Code: HintDiskSpace, Params: v.params(),
			Title: fmt.Sprintf("%s %s%% full", PlainVolume(v.entity, v.label), pct0(p)), Detail: v.evidence()})
	}

	// SSD wear below the alert threshold.
	for _, d := range r.Disks {
		w, ok := ssdWear(d)
		if !ok || w < WearWatchPct-eps || WearLevel(w) != Good || alerted(open, d.Device, RuleWearHigh, RuleWearCritical) {
			continue
		}
		detail, variant, params := wearEvidence(d, w)
		out = append(out, Hint{Kind: HintDiskWear, Severity: HintInfo, Entity: d.Device, Link: LinkStorage,
			Title: fmt.Sprintf("Disk %s is %s%% worn", d.Device, pct0(w)), Detail: detail, Code: HintDiskWear + variant, Params: params})
	}

	// Collectors that failed.
	for _, c := range r.Collectors {
		if c.OK {
			continue
		}
		d := c.Error
		if d == "" {
			d = "It didn’t say why."
		}
		out = append(out, Hint{Kind: HintCollectorError, Severity: HintWarning, Entity: c.Name, Link: LinkAgent,
			Code: HintCollectorError, Params: map[string]any{"collector": c.Name, "error": c.Error},
			Title: "Whombat can’t read this server’s " + collectorWords(c.Name), Detail: d})
	}

	// Unhealthy Docker containers: one hint for all of them.
	if r.Docker != nil {
		var names []string
		for _, g := range r.Docker.Guests {
			if g.State != proto.StateUnhealthy {
				continue
			}
			n := g.Name
			if n == "" {
				n = g.ID
			}
			names = append(names, n)
		}
		if n := len(names); n > 0 {
			title := fmt.Sprintf("%d apps aren’t working properly", n)
			if n == 1 {
				title = "1 app isn’t working properly"
			}
			detail := strings.Join(names, ", ")
			if n > UnhealthyNames {
				detail = strings.Join(names[:UnhealthyNames], ", ") + ", …"
			}
			out = append(out, Hint{Kind: HintGuestsUnhealthy, Severity: HintWarning, Entity: "docker", Link: LinkGuests,
				Code: HintGuestsUnhealthy, Params: map[string]any{"count": n, "names": firstN(names, UnhealthyNames)},
				Title: title, Detail: detail})
		}
	}

	out = append(out, healthHints(r, open)...)
	out = append(out, oomLimitHints(r, time.Now())...)
	out = append(out, incusHints(r, time.Now())...)
	out = append(out, unraidHints(r, open, time.Now())...)
	out = append(out, libvirtHints(r, open, time.Now())...)

	// Agent version differs from the hub's.
	if v := r.Agent.Version; hubVersion != "" && v != "" && v != hubVersion {
		out = append(out, Hint{Kind: HintAgentOutdated, Severity: HintInfo, Entity: "host", Link: LinkAgent,
			Code: HintAgentOutdated, Params: map[string]any{"agentVersion": v, "hubVersion": hubVersion},
			Title: "Whombat’s helper on this server is out of date", Detail: fmt.Sprintf("It runs %s, Whombat %s.", v, hubVersion)})
	}

	sort.SliceStable(out, func(i, j int) bool { return HintRank(out[i].Severity) < HintRank(out[j].Severity) })
	return out
}

// collectorWords is what a collector reads, in people's words (“disk
// health” for smart): its name alone is a code.
func collectorWords(name string) string {
	switch name {
	case "smart":
		return "disk health"
	case "sensors", "temps":
		return "temperatures"
	case "ups":
		return "battery backup"
	case "unraid":
		return "Unraid details"
	case "disks":
		return "disks"
	case "net", "network":
		return "network"
	case "system":
		return "system details"
	case "docker":
		return "apps"
	case "incus", "pve", "libvirt":
		return "machines"
	}
	return name + " details"
}

// alerted reports whether an open alert of one of the rules concerns the
// entity.
func alerted(open []Alert, entity string, rules ...string) bool {
	for _, a := range open {
		if a.Entity != entity || a.State == AlertResolved {
			continue
		}
		for _, r := range rules {
			if a.Rule == r {
				return true
			}
		}
	}
	return false
}
