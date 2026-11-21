// Package services lists the host's services: systemd units (services and
// timers) or OpenRC / SysV init scripts. The host collector reports failed
// units with every report; the inspect RPC returns the list on demand.
package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// ErrUnsupported is returned when the init system cannot be queried.
var ErrUnsupported = errors.New("no supported init system")

// Init systems (proto.SystemInfo.InitSystem).
const (
	Systemd = "systemd"
	OpenRC  = "openrc"
	SysV    = "sysv"
	Unraid  = "unraid"
)

// InitSystem detects the running init system.
func InitSystem() string { return initSystem("") }

func initSystem(root string) string {
	switch {
	case exists(root + "/etc/unraid-version"):
		return Unraid
	case exists(root + "/run/systemd/system"): // sd_booted()
		return Systemd
	case exists(root+"/run/openrc") || exists(root+"/sbin/openrc-run"):
		return OpenRC
	}
	return SysV
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// List returns the services, failed ones first, then by name.
func List(ctx context.Context) ([]proto.Service, error) {
	var out []proto.Service
	var err error
	switch InitSystem() {
	case Systemd:
		out, err = listSystemd(ctx)
	case OpenRC:
		var b []byte
		b, err = run(ctx, 30*time.Second, "rc-status", "--all", "--nocolor")
		if err == nil {
			out = ParseRCStatus(b)
		}
	default:
		return nil, ErrUnsupported
	}
	if err != nil {
		return nil, err
	}
	Sort(out)
	return out, nil
}

// Failed returns the names of failed services (systemd: failed services
// and timers; OpenRC: crashed services). It is much cheaper than List.
func Failed(ctx context.Context) ([]string, error) {
	switch InitSystem() {
	case Systemd:
		b, err := run(ctx, 20*time.Second, "systemctl", "list-units", "--failed", "--all",
			"--type=service,timer", "--plain", "--no-legend", "--no-pager")
		if err != nil {
			return nil, err
		}
		var names []string
		for _, s := range ParseSystemctlPlain(b) {
			names = append(names, s.Name)
		}
		sort.Strings(names)
		return names, nil
	case OpenRC:
		b, err := run(ctx, 20*time.Second, "rc-status", "--all", "--nocolor")
		if err != nil {
			return nil, err
		}
		var names []string
		for _, s := range ParseRCStatus(b) {
			if s.Active == "failed" {
				names = append(names, s.Name)
			}
		}
		sort.Strings(names)
		return names, nil
	}
	return nil, ErrUnsupported
}

// Sort orders services failed first, then by name.
func Sort(s []proto.Service) {
	sort.SliceStable(s, func(i, j int) bool {
		fi, fj := s[i].Active == "failed", s[j].Active == "failed"
		if fi != fj {
			return fi
		}
		return s[i].Name < s[j].Name
	})
}

// ---- systemd ----------------------------------------------------------------------

func listSystemd(ctx context.Context) ([]proto.Service, error) {
	b, err := run(ctx, 30*time.Second, "systemctl", "list-units", "--all", "--type=service,timer",
		"--output=json", "--no-pager")
	var units []proto.Service
	if err == nil {
		units, err = ParseSystemctlJSON(b)
	}
	if err != nil {
		// systemd before v246 has no JSON output.
		b, err2 := run(ctx, 30*time.Second, "systemctl", "list-units", "--all", "--type=service,timer",
			"--plain", "--no-legend", "--no-pager")
		if err2 != nil {
			return nil, err
		}
		units = ParseSystemctlPlain(b)
	}
	// Enabled state from the unit files (best effort).
	if b, err := run(ctx, 30*time.Second, "systemctl", "list-unit-files", "--type=service,timer",
		"--plain", "--no-legend", "--no-pager"); err == nil {
		ApplyUnitFiles(units, ParseUnitFiles(b))
	}
	// When failed units failed (best effort, failed units only).
	var failed []string
	for _, u := range units {
		if u.Active == "failed" && len(failed) < 100 {
			failed = append(failed, u.Name)
		}
	}
	if len(failed) > 0 {
		args := append([]string{"show", "--property=Id,StateChangeTimestampMonotonic", "--no-pager", "--"}, failed...)
		if b, err := run(ctx, 30*time.Second, "systemctl", args...); err == nil {
			since := ParseStateChange(b, bootTime())
			for i := range units {
				if t, ok := since[units[i].Name]; ok {
					units[i].Since = t
				}
			}
		}
	}
	return units, nil
}

// ParseSystemctlJSON parses `systemctl list-units --output=json`.
func ParseSystemctlJSON(b []byte) ([]proto.Service, error) {
	var rows []struct {
		Unit        string `json:"unit"`
		Load        string `json:"load"`
		Active      string `json:"active"`
		Sub         string `json:"sub"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, err
	}
	out := make([]proto.Service, 0, len(rows))
	for _, r := range rows {
		out = append(out, proto.Service{Name: r.Unit, Load: r.Load, Active: r.Active, Sub: r.Sub, Description: r.Description})
	}
	return out, nil
}

// ParseSystemctlPlain parses `systemctl list-units --plain --no-legend`:
// "UNIT LOAD ACTIVE SUB DESCRIPTION..." (a leading "●" marks units that
// are not found or failed on some versions).
func ParseSystemctlPlain(b []byte) []proto.Service {
	var out []proto.Service
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "●"), "*"))
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		s := proto.Service{Name: f[0], Load: f[1], Active: f[2], Sub: f[3]}
		if len(f) > 4 {
			s.Description = strings.Join(f[4:], " ")
		}
		out = append(out, s)
	}
	return out
}

// ParseUnitFiles parses `systemctl list-unit-files --plain --no-legend`:
// "name state [preset]".
func ParseUnitFiles(b []byte) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			out[f[0]] = f[1]
		}
	}
	return out
}

// ApplyUnitFiles sets Enabled from the unit-file states; template
// instances ("getty@tty1.service") use their template ("getty@.service").
func ApplyUnitFiles(units []proto.Service, files map[string]string) {
	for i := range units {
		n := units[i].Name
		st, ok := files[n]
		if !ok {
			if at := strings.Index(n, "@"); at >= 0 {
				if dot := strings.LastIndex(n, "."); dot > at {
					st, ok = files[n[:at+1]+n[dot:]]
				}
			}
		}
		if ok {
			units[i].Enabled = st
		}
	}
}

// ParseStateChange parses `systemctl show --property=Id,StateChangeTimestampMonotonic`
// (blank-line separated blocks) into wall-clock times.
func ParseStateChange(b []byte, boot time.Time) map[string]time.Time {
	out := map[string]time.Time{}
	if boot.IsZero() {
		return out
	}
	for _, block := range strings.Split(string(b), "\n\n") {
		var id string
		var us int64
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
			if !ok {
				continue
			}
			switch k {
			case "Id":
				id = v
			case "StateChangeTimestampMonotonic":
				us = atoi64(v)
			}
		}
		if id != "" && us > 0 {
			out[id] = boot.Add(time.Duration(us) * time.Microsecond).UTC().Truncate(time.Second)
		}
	}
	return out
}

func atoi64(s string) int64 {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

// bootTime reads btime from /proc/stat.
func bootTime() time.Time {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "btime "); ok {
			return time.Unix(atoi64(strings.TrimSpace(v)), 0)
		}
	}
	return time.Time{}
}

// ---- OpenRC ------------------------------------------------------------------------

// ParseRCStatus parses `rc-status --all --nocolor`:
//
//	Runlevel: default
//	 sshd                    [  started 3 day(s) ago (supervise-daemon) ]
//	 nginx                   [  crashed  ]
//	Dynamic Runlevel: needed/wanted
//	 localmount              [  started  ]
//
// Services in a (static) runlevel are "enabled" for it; crashed services
// are reported as failed.
func ParseRCStatus(b []byte) []proto.Service {
	byName := map[string]*proto.Service{}
	var order []string
	runlevel, dynamic := "", false
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if rl, ok := strings.CutPrefix(t, "Runlevel:"); ok {
			runlevel, dynamic = strings.TrimSpace(rl), false
			continue
		}
		if rl, ok := strings.CutPrefix(t, "Dynamic Runlevel:"); ok {
			runlevel, dynamic = strings.TrimSpace(rl), true
			continue
		}
		i := strings.Index(t, "[")
		j := strings.LastIndex(t, "]")
		if i <= 0 || j < i {
			continue
		}
		name := strings.TrimSpace(t[:i])
		status := strings.Fields(t[i+1 : j])
		if name == "" || len(status) == 0 {
			continue
		}
		s := byName[name]
		if s == nil {
			s = &proto.Service{Name: name, Load: "loaded", Enabled: "disabled"}
			byName[name] = s
			order = append(order, name)
		}
		s.Active, s.Sub = openrcState(status[0])
		if !dynamic && runlevel != "" {
			s.Enabled = "enabled"
		}
	}
	out := make([]proto.Service, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out
}

func openrcState(st string) (active, sub string) {
	switch st {
	case "started":
		return "active", "running"
	case "crashed", "failed":
		return "failed", "failed"
	case "starting":
		return "activating", "start"
	case "stopping":
		return "deactivating", "stop"
	case "inactive":
		return "inactive", "inactive"
	case "scheduled":
		return "inactive", "scheduled"
	}
	return "inactive", "dead"
}
