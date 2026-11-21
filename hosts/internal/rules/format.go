package rules

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Display formats (docs/handoff/docs/SCREENS.md section 7). The UI does its
// own formatting; the hub uses these for alert and banner texts, and they
// pin the format vectors of ACCEPTANCE.md section 7 in unit tests.

// trim formats f with at most dec decimals and trims trailing zeros.
func trim(f float64, dec int) string {
	s := strconv.FormatFloat(f, 'f', dec, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(s, "0")
		s = strings.TrimSuffix(s, ".")
	}
	if s == "-0" {
		s = "0"
	}
	return s
}

// FormatStorageGB formats a decimal storage size given in GB: MB below 1 GB,
// GB below 1000 GB, TB with two decimals below 10 TB and one decimal from
// 10 TB, trailing zeros trimmed ("440 GB", "1.42 TB", "10.2 TB", "100 TB").
func FormatStorageGB(gb float64) string {
	switch {
	case gb < 1:
		return trim(math.Round(gb*1000), 0) + " MB"
	case gb < 10:
		return trim(gb, 1) + " GB"
	case gb < 999.5:
		return trim(math.Round(gb), 0) + " GB"
	}
	tb := gb / 1000
	if tb < 10 {
		return trim(tb, 2) + " TB"
	}
	return trim(tb, 1) + " TB"
}

// FormatStorageTB formats a storage size given in TB ("62.2 TB").
func FormatStorageTB(tb float64) string { return FormatStorageGB(tb * 1000) }

// FormatMemoryGB formats memory given in GB (GiB, shown as "GB"): MB below
// 1 GB ("128 MB"), else one decimal trimmed ("9.8 GB", "256 GB").
func FormatMemoryGB(gb float64) string {
	if gb < 1 {
		return trim(math.Round(gb*1024), 0) + " MB"
	}
	return trim(gb, 1) + " GB"
}

// FormatDiskRate formats a disk rate in MB/s ("42 MB/s").
func FormatDiskRate(mbs float64) string {
	if mbs < 10 {
		return trim(mbs, 1) + " MB/s"
	}
	return trim(math.Round(mbs), 0) + " MB/s"
}

// FormatNetRate formats a network rate in Mb/s, switching to Gb/s above 1000
// ("412 Mb/s", "1.2 Gb/s").
func FormatNetRate(mbps float64) string {
	if mbps >= 1000 {
		return trim(mbps/1000, 1) + " Gb/s"
	}
	if mbps < 10 {
		return trim(mbps, 1) + " Mb/s"
	}
	return trim(math.Round(mbps), 0) + " Mb/s"
}

// FormatTemp formats a temperature for running text ("64 °C").
func FormatTemp(c float64) string { return trim(math.Round(c), 0) + " °C" }

// FormatTempDense formats a temperature for dense tables ("64°").
func FormatTempDense(c float64) string { return trim(math.Round(c), 0) + "°" }

// FormatPct formats a percentage as an integer ("78%").
func FormatPct(p float64) string { return trim(math.Round(p), 0) + "%" }

// Thousands formats an integer with comma separators ("1,200").
func Thousands(n int64) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// FormatNumber formats a non-negative number with thousands separators and up
// to dec decimals (trailing zeros trimmed): "1,200", "1,234.5".
func FormatNumber(f float64, dec int) string {
	p := math.Pow(10, float64(dec))
	f = math.Round(f*p) / p
	ip, frac := math.Modf(math.Abs(f))
	s := Thousands(int64(ip))
	if f < 0 {
		s = "-" + s
	}
	if dec > 0 && frac > 0 {
		fs := trim(frac, dec)
		s += strings.TrimPrefix(fs, "0")
	}
	return s
}

// FormatRelative formats the age of a past instant: "8 s ago", "14 min ago",
// "3 h ago", "2 d ago".
func FormatRelative(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s ago", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d/time.Minute))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d h ago", int(d/time.Hour))
	}
	return fmt.Sprintf("%d d ago", int(d/(24*time.Hour)))
}

// FormatDuration formats an elapsed duration for alert texts: "45 s",
// "14 min", "11 h 47 m", "2 d 3 h".
func FormatDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d s", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d/time.Minute))
	case d < 24*time.Hour:
		h := int(d / time.Hour)
		m := int((d % time.Hour) / time.Minute)
		return fmt.Sprintf("%d h %d m", h, m)
	}
	days := int(d / (24 * time.Hour))
	h := int((d % (24 * time.Hour)) / time.Hour)
	return fmt.Sprintf("%d d %d h", days, h)
}

// Ranges.
const (
	Range1h  = "1h"
	Range6h  = "6h"
	Range24h = "24h"
	Range7d  = "7d"
	Range30d = "30d"
)

// AxisTick formats an x-axis label for a range in the given location:
// 1h/6h "13:15", 24h "Sat 20:11", 7d/30d "Oct 6".
func AxisTick(rng string, t time.Time, loc *time.Location) string {
	t = t.In(loc)
	switch rng {
	case Range1h, Range6h:
		return t.Format("15:04")
	case Range24h:
		return t.Format("Mon 15:04")
	}
	return t.Format("Jan 2")
}

// TooltipTime formats a tooltip time: 7d/30d "Oct 6, 14:00", 24h
// "Sat 20:11", otherwise "13:15".
func TooltipTime(rng string, t time.Time, loc *time.Location) string {
	t = t.In(loc)
	switch rng {
	case Range7d, Range30d:
		return t.Format("Jan 2, 15:04")
	case Range24h:
		return t.Format("Mon 15:04")
	}
	return t.Format("15:04")
}

// PlainVolume is a volume as people say it: “System disk” for /, “Disk
// “srv”” for another mount, “Storage “tank”” for a pool or a Proxmox
// storage. Mount paths, “Pool” and storage ids alone read like typos or
// jargon in a title.
func PlainVolume(entity, label string) string {
	switch {
	case entity == "fs:/":
		return "System disk"
	case strings.HasPrefix(entity, "fs:"):
		m := strings.TrimRight(strings.TrimPrefix(entity, "fs:"), "/")
		if i := strings.LastIndex(m, "/"); i >= 0 {
			m = m[i+1:]
		}
		return "Disk “" + m + "”"
	case strings.HasPrefix(entity, "pool:"):
		return "Storage “" + strings.TrimPrefix(entity, "pool:") + "”"
	case strings.HasPrefix(entity, "storage:"):
		return "Storage “" + strings.TrimPrefix(entity, "storage:") + "”"
	}
	return label
}
