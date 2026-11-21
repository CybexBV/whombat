// Package rules centralizes Rackoon's thresholds and status rules
// (docs/handoff/docs/PRODUCT-SPEC.md section 5), the default alert rules and
// the alert state machine. Everything here is pure: no I/O, time is passed in.
package rules

import (
	"math"
	"time"
)

// Level is the color class of a value: good (blue / green), warning
// (--warning, yellow) or serious (--serious, orange).
type Level int

const (
	Good Level = iota
	Warning
	Serious
)

func (l Level) String() string {
	switch l {
	case Warning:
		return "warning"
	case Serious:
		return "serious"
	default:
		return "good"
	}
}

// eps absorbs float noise in threshold comparisons (e.g. 0.85 * 85).
const eps = 1e-9

// Thresholds (PRODUCT-SPEC section 5).
const (
	TempWarnPct           = 85.0 // sensor: warning at or above 85% of its limit
	DiskUsedWarnPct       = 80.0
	DiskUsedSeriousPct    = 90.0
	WearWarnPct           = 75.0
	WearSeriousPct        = 90.0
	MemAssignedWarnPct    = 80.0
	MemAssignedSeriousPct = 90.0
	OvercommitWarnRatio   = 1.5 // warning when strictly above
	OvercommitMeterMax    = 2.0 // the vCPU meter spans 0 to 2 : 1
	HeartbeatTimeout      = 60 * time.Second
)

// Default sensor limits per sensor group, in °C, used when the agent does not
// report a limit (mockup values).
var DefaultSensorLimits = map[string]float64{
	"cpu_package":  85,
	"board_vrm":    90,
	"nvme_hottest": 75,
	"dimm":         85,
	"hdd_hottest":  55,
	"ssd_hottest":  70,
}

// TempWarnThreshold is the temperature at which a sensor with the given limit
// turns to warning (85% of the limit).
func TempWarnThreshold(limitC float64) float64 { return limitC * TempWarnPct / 100 }

// TempLevel classifies a sensor temperature against its own limit: good below
// 85% of the limit, warning at or above 85%, serious at or above the limit.
func TempLevel(tempC, limitC float64) Level {
	if limitC <= 0 || math.IsNaN(tempC) {
		return Good
	}
	if tempC >= limitC-eps {
		return Serious
	}
	// tempC >= 0.85 * limit, compared as tempC*100 >= 85*limit to stay exact
	// for the usual one-decimal inputs.
	if tempC*100 >= TempWarnPct*limitC-eps {
		return Warning
	}
	return Good
}

// DiskUsedLevel classifies a disk / filesystem / storage usage percentage:
// below 80 good, 80 to 89 warning, 90 and above serious.
func DiskUsedLevel(pct float64) Level {
	switch {
	case pct >= DiskUsedSeriousPct-eps:
		return Serious
	case pct >= DiskUsedWarnPct-eps:
		return Warning
	}
	return Good
}

// WearLevel classifies SSD wear: below 75 good, 75 to 89 warning, 90 and
// above serious.
func WearLevel(pct float64) Level {
	switch {
	case pct >= WearSeriousPct-eps:
		return Serious
	case pct >= WearWarnPct-eps:
		return Warning
	}
	return Good
}

// WearHigh reports whether the disk carries the "Wear high" label.
func WearHigh(pct float64) bool { return pct >= WearWarnPct-eps }

// WearDisplay caps wear at 100 for display.
func WearDisplay(pct float64) float64 {
	if pct > 100 {
		return 100
	}
	if pct < 0 {
		return 0
	}
	return pct
}

// MemAssignedLevel classifies guest memory assigned as a percentage of host
// RAM: below 80 good, 80 to 89 warning, 90 and above serious.
func MemAssignedLevel(pct float64) Level {
	switch {
	case pct >= MemAssignedSeriousPct-eps:
		return Serious
	case pct >= MemAssignedWarnPct-eps:
		return Warning
	}
	return Good
}

// OvercommitLevel classifies the vCPU overcommit ratio (allocated / host
// threads): up to 1.5 : 1 good, above warning. There is no serious level.
func OvercommitLevel(ratio float64) Level {
	if ratio > OvercommitWarnRatio+eps {
		return Warning
	}
	return Good
}

// OvercommitMeterWidth is the fill of the vCPU meter in percent:
// min(ratio / 2, 1) x 100. The 1 : 1 tick sits at 50%.
func OvercommitMeterWidth(ratio float64) float64 {
	w := ratio / OvercommitMeterMax
	if w > 1 {
		w = 1
	}
	if w < 0 {
		w = 0
	}
	return w * 100
}

// OvercommitTickPct is the position of the 1 : 1 tick on the vCPU meter.
const OvercommitTickPct = 50.0

// HeatmapBounds are the lower bounds of heatmap bins 1..6 (CPU %).
var HeatmapBounds = [6]float64{8, 20, 35, 50, 65, 80}

// HeatmapBin returns the heatmap bin (0..6) for a CPU percentage, or -1 for
// a missing value (blank cell).
func HeatmapBin(v *float64) int {
	if v == nil || math.IsNaN(*v) {
		return -1
	}
	bin := 0
	for _, b := range HeatmapBounds {
		if *v >= b-eps {
			bin++
		}
	}
	return bin
}

// Server statuses.
const (
	StatusOnline  = "online"
	StatusWarning = "warning"
	StatusOffline = "offline"
)

// ServerStatus applies the status rule: offline when the last heartbeat is
// 60 s old or older (or there never was one); otherwise warning when the host
// has at least one open alert that asks for attention (not acknowledged,
// muted or suppressed); otherwise online.
func ServerStatus(heartbeatAge time.Duration, everSeen, attention bool) string {
	return ServerStatusWith(heartbeatAge, HeartbeatTimeout, everSeen, attention)
}

// ServerStatusWith is ServerStatus with a configurable heartbeat timeout.
func ServerStatusWith(heartbeatAge, timeout time.Duration, everSeen, attention bool) string {
	if timeout <= 0 {
		timeout = HeartbeatTimeout
	}
	if !everSeen || heartbeatAge >= timeout {
		return StatusOffline
	}
	if attention {
		return StatusWarning
	}
	return StatusOnline
}
