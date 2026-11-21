package collect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/agent/pkgs"
	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// systemCollector reports operating-system health (proto.SystemInfo):
// failed services, reboot-required, time synchronisation, OOM kills (and
// which of them were at a cgroup's own limit, oom.go) and
// task counts every 60 s, and pending package updates every 6 hours (the
// "updates" sub; sooner after the package database or the cached lists
// changed).
type systemCollector struct {
	root   fsRoot
	toggle toggleFn // [collectors] updates
	c      *collector

	mu   sync.Mutex
	info proto.SystemInfo
	have bool

	// Package check (runUpdates).
	pm           string
	pending      *int
	security     *int
	checkedAt    time.Time
	updErr       string
	needsReboot  string // needs-restarting -r said so (reason)
	stampAtCheck string

	timeSrc   string
	timeSrcAt time.Time

	// oom tells the OOM kills the machine made from those at a cgroup's
	// own limit (oom.go, LM-04).
	oom oomTracker
}

func newSystemCollector(root fsRoot, toggle toggleFn, c *collector) *systemCollector {
	return &systemCollector{root: root, toggle: toggle, c: c, oom: oomTracker{root: root}}
}

// minUpdateRecheck bounds how often a changed package database triggers
// an early package check.
const minUpdateRecheck = 10 * time.Minute

// maxFailedUnits bounds SystemInfo.FailedUnits (FailedCount is the total).
const maxFailedUnits = 32

func (s *systemCollector) run(ctx context.Context) error {
	r := s.root
	var info proto.SystemInfo
	var problems []string

	info.InitSystem = services.InitSystem()
	switch info.InitSystem {
	case services.Systemd, services.OpenRC:
		names, err := services.Failed(ctx)
		if err != nil {
			problems = append(problems, "failed services: "+err.Error())
		} else {
			info.FailedCount = len(names)
			if len(names) > maxFailedUnits {
				names = names[:maxFailedUnits]
			}
			info.FailedUnits = names
		}
	}

	info.RebootRequired, info.RebootReason = rebootRequired(r, r.readString("/proc/sys/kernel/osrelease"))

	synced, offset, err := timeStatus(ctx, r)
	if err == nil {
		info.TimeSynced, info.TimeOffsetMs = synced, offset
	}
	info.TimeSource = s.timeSource()

	// vmstat before the kernel log: the limit kills never run ahead.
	b, err := r.read("/proc/vmstat")
	if err == nil {
		info.OOMKills = parseVMStatOOM(b)
	}
	s.oom.poll(ctx, info.InitSystem, info.OOMKills, err == nil)
	info.ProcessCount = parseLoadavgTasks(r.readString("/proc/loadavg"))
	info.Arch = runtime.GOARCH

	s.mu.Lock()
	s.info, s.have = info, true
	pm, stamp, checked := s.pm, s.stampAtCheck, s.checkedAt
	s.mu.Unlock()

	// Re-check packages early after an upgrade or `apt update`.
	if pm != "" && !checked.IsZero() && time.Since(checked) > minUpdateRecheck && pkgs.Stamp(pm) != stamp {
		s.c.updatesSub.markDirty()
	}
	if len(problems) > 0 {
		return partial(strings.Join(problems, "; "))
	}
	return nil
}

// runUpdates checks pending package updates from the package manager's
// cache (it never refreshes the lists). UpdatesCheckedAt is when the check
// started: after a package task ended the agent records the task's
// outcome first and then starts this check, so a report whose
// UpdatesCheckedAt is at or after PackageLast.Finished has the counts
// read after the task (a check that was already running when the task
// ended is older).
func (s *systemCollector) runUpdates(ctx context.Context) error {
	started := time.Now().UTC()
	pm := ""
	if s.toggle.enabled(true) {
		pm = pkgs.Detect()
	}
	s.c.updatesSub.setAbsent(pm == "")
	if pm == "" {
		s.mu.Lock()
		s.pm, s.pending, s.security, s.updErr, s.checkedAt, s.needsReboot = "", nil, nil, "", time.Time{}, ""
		s.mu.Unlock()
		return nil
	}
	res, err := pkgs.Check(ctx)
	needsReboot := ""
	if pm == pkgs.DNF || pm == pkgs.YUM {
		needsReboot = needsRestarting(ctx)
	}
	stamp := pkgs.Stamp(pm)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pm, s.checkedAt, s.stampAtCheck, s.needsReboot = pm, started, stamp, needsReboot
	if err != nil {
		s.pending, s.security = nil, nil
		s.updErr = truncate(err.Error(), 300)
		return partial("package check: " + err.Error())
	}
	s.updErr = ""
	n := len(res.Updates)
	s.pending = &n
	s.security = nil
	if res.SecurityKnown {
		sec := res.Security()
		s.security = &sec
	}
	return nil
}

// needsRestarting runs `needs-restarting -r` (dnf-utils / yum-utils; dnf5:
// `dnf needs-restarting -r`): exit status 1 means a reboot is required.
func needsRestarting(ctx context.Context) string {
	var out []byte
	var err error
	if _, lerr := lookPath("needs-restarting"); lerr == nil {
		out, err = runCmd(ctx, time.Minute, "needs-restarting", "-r")
	} else if _, lerr := lookPath("dnf5"); lerr == nil {
		out, err = runCmd(ctx, time.Minute, "dnf", "--cacheonly", "needs-restarting", "-r")
	} else {
		return ""
	}
	var ee interface{ ExitCode() int }
	if err != nil && errors.As(err, &ee) && ee.ExitCode() == 1 {
		msg := "Core libraries or services were updated (needs-restarting)"
		if l := strings.TrimSpace(firstLine(string(out))); l != "" {
			msg = l
		}
		return truncate(msg, 160)
	}
	return ""
}

func (s *systemCollector) snapshot() *proto.SystemInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.have {
		return nil
	}
	info := s.info
	info.FailedUnits = append([]string(nil), s.info.FailedUnits...)
	info.TimeSynced = copyPtr(s.info.TimeSynced)
	info.TimeOffsetMs = copyPtr(s.info.TimeOffsetMs)
	info.PackageManager = s.pm
	info.UpdatesPending = copyPtr(s.pending)
	info.SecurityUpdates = copyPtr(s.security)
	info.UpdatesCheckedAt = s.checkedAt
	info.UpdatesError = s.updErr
	if !info.RebootRequired && s.needsReboot != "" {
		info.RebootRequired, info.RebootReason = true, s.needsReboot
	}
	info.OOMLimitKills, info.OOMLimited = s.oom.report(time.Now())
	return &info
}

// ---- reboot required ----------------------------------------------------------------

// rebootRequired decides whether the host needs a reboot:
//
//   - a newer kernel is installed than the one running (the most specific
//     reason, so it wins): /boot/vmlinuz-<version> and
//     /lib/modules/<version>/vmlinuz of the running kernel's flavour;
//     skipped on Proxmox VE with a pinned kernel;
//   - NixOS: the current system's kernel differs from the booted one;
//   - /run/reboot-required (Debian, Ubuntu), with the packages from
//     reboot-required.pkgs.
//
// needs-restarting (Fedora family) runs with the package check.
func rebootRequired(r fsRoot, running string) (bool, string) {
	if r.exists("/run/current-system") { // NixOS
		for _, f := range []string{"kernel", "initrd", "kernel-modules"} {
			booted, err1 := filepath.EvalSymlinks(r.path("/run/booted-system/" + f))
			current, err2 := filepath.EvalSymlinks(r.path("/run/current-system/" + f))
			if err1 == nil && err2 == nil && booted != current {
				return true, "The current NixOS generation has a different kernel than the booted one"
			}
		}
		return false, ""
	}
	if running != "" && !r.exists("/etc/kernel/proxmox-boot-pin") {
		if newest := newestKernel(r, running); newest != "" {
			return true, fmt.Sprintf("Kernel %s is installed, %s runs", newest, running)
		}
	}
	for _, p := range []string{"/run/reboot-required", "/var/run/reboot-required"} {
		if !r.exists(p) {
			continue
		}
		var names []string
		seen := map[string]bool{}
		scanLines([]byte(r.readString(p+".pkgs")), func(line string) {
			if n := strings.TrimSpace(line); n != "" && !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		})
		switch {
		case len(names) == 0:
			return true, "A package update asked for a reboot"
		case len(names) <= 3:
			return true, "Updated packages need a reboot: " + strings.Join(names, ", ")
		default:
			return true, fmt.Sprintf("Updated packages need a reboot: %s and %d more", strings.Join(names[:3], ", "), len(names)-3)
		}
	}
	return false, ""
}

// newestKernel returns the newest installed kernel of the running
// kernel's flavour when it is newer than running, else "".
func newestKernel(r fsRoot, running string) string {
	flavour := kernelFlavour(running)
	var cands []string
	if m, _ := filepath.Glob(r.path("/boot/vmlinuz-*")); m != nil {
		for _, p := range m {
			cands = append(cands, strings.TrimPrefix(filepath.Base(p), "vmlinuz-"))
		}
	}
	for _, dir := range []string{"/lib/modules", "/usr/lib/modules"} {
		ents, err := os.ReadDir(r.path(dir))
		if err != nil {
			continue
		}
		for _, e := range ents {
			if r.exists(dir + "/" + e.Name() + "/vmlinuz") {
				cands = append(cands, e.Name())
			}
		}
	}
	newest := ""
	for _, v := range cands {
		if strings.HasSuffix(v, ".old") || kernelFlavour(v) != flavour || !startsWithDigit(v) {
			continue
		}
		if newest == "" || compareVersions(v, newest) > 0 {
			newest = v
		}
	}
	if newest != "" && compareVersions(newest, running) > 0 {
		return newest
	}
	return ""
}

func startsWithDigit(s string) bool { return s != "" && s[0] >= '0' && s[0] <= '9' }

// kernelFlavour returns the build flavour of a kernel release: "amd64" of
// "6.12.111+deb13-amd64", "generic" of "6.8.0-45-generic", "pve" of
// "6.8.12-4-pve", "arch" of "6.17.2-arch1-1", "" of Fedora's
// "6.11.4-301.fc41.x86_64". Only kernels of the same flavour are compared
// (a -rt or -cloud kernel installed next to the generic one is not an
// upgrade of it).
func kernelFlavour(v string) string {
	parts := strings.Split(v, "-")
	var fl []string
	for _, p := range parts[1:] {
		if p != "" && (p[0] < '0' || p[0] > '9') {
			fl = append(fl, strings.TrimRight(p, "0123456789"))
		}
	}
	return strings.Join(fl, "-")
}

// compareVersions compares version strings the way humans read them:
// digit runs numerically, everything else byte-wise; "~" sorts before
// anything (Debian pre-releases).
func compareVersions(a, b string) int {
	for a != "" || b != "" {
		if a == "" || b == "" {
			if strings.HasPrefix(a+b, "~") {
				if a == "" {
					return 1
				}
				return -1
			}
			if a == "" {
				return -1
			}
			return 1
		}
		da, db := isDigit(a[0]), isDigit(b[0])
		switch {
		case da && db:
			ra, rb := digitRun(a), digitRun(b)
			na := strings.TrimLeft(ra, "0")
			nb := strings.TrimLeft(rb, "0")
			if len(na) != len(nb) {
				if len(na) < len(nb) {
					return -1
				}
				return 1
			}
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			a, b = a[len(ra):], b[len(rb):]
		case da != db:
			// "1.2" vs "1.a": a number sorts after a separator, a tilde before all.
			if a[0] == '~' {
				return -1
			}
			if b[0] == '~' {
				return 1
			}
			if da {
				return 1
			}
			return -1
		default:
			if a[0] != b[0] {
				if a[0] == '~' {
					return -1
				}
				if b[0] == '~' {
					return 1
				}
				if a[0] < b[0] {
					return -1
				}
				return 1
			}
			a, b = a[1:], b[1:]
		}
	}
	return 0
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func digitRun(s string) string {
	i := 0
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	return s[:i]
}

// ---- time ------------------------------------------------------------------------------

// Kernel NTP status bits (adjtimex).
const (
	staUnsync = 0x0040
	staNano   = 0x2000
	timeError = 5 // TIME_ERROR: the clock is not synchronized
)

// mapTimex interprets adjtimex(): synchronized unless the kernel says
// TIME_ERROR or STA_UNSYNC; the offset is the remaining PLL offset, in
// nanoseconds with STA_NANO, else microseconds.
func mapTimex(state int, status int32, offset int64) (synced bool, offsetMs float64) {
	synced = state != timeError && status&staUnsync == 0
	if status&staNano != 0 {
		offsetMs = float64(offset) / 1e6
	} else {
		offsetMs = float64(offset) / 1e3
	}
	return synced, round2(offsetMs)
}

// adjtimex reads the kernel clock state (modes 0: read only). It is a
// variable so tests can simulate a sandbox that blocks it.
var adjtimex = readAdjtimex

// timeStatus reports clock synchronisation. adjtimex() is the source; a
// sandbox that filters it (systemd's ProtectClock= blocks even reads)
// falls back to timesyncd's marker file or `chronyc tracking`.
func timeStatus(ctx context.Context, r fsRoot) (*bool, *float64, error) {
	state, status, offset, err := adjtimex()
	if err == nil {
		synced, off := mapTimex(state, status, offset)
		return &synced, &off, nil
	}
	if !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.ENOSYS) {
		return nil, nil, err
	}
	if _, lerr := lookPath("chronyc"); lerr == nil {
		if out, cerr := runCmd(ctx, 5*time.Second, "chronyc", "-n", "-c", "tracking"); cerr == nil {
			if synced, off, ok := parseChronyTracking(out); ok {
				return &synced, off, nil
			}
		}
	}
	if r.exists("/run/systemd/timesync") || r.exists("/lib/systemd/systemd-timesyncd") || r.exists("/usr/lib/systemd/systemd-timesyncd") {
		synced := r.exists("/run/systemd/timesync/synchronized")
		return &synced, nil, nil
	}
	return nil, nil, err
}

// parseChronyTracking parses `chronyc -c tracking` (CSV): field 5 is the
// system clock's offset in seconds, the last field the leap status
// ("Normal" when synchronized).
func parseChronyTracking(b []byte) (bool, *float64, bool) {
	f := strings.Split(strings.TrimSpace(string(b)), ",")
	if len(f) < 14 {
		return false, nil, false
	}
	synced := f[len(f)-1] != "Not synchronised"
	var off *float64
	if v, err := strconv.ParseFloat(f[4], 64); err == nil {
		off = ptr(round2(v * 1000))
	}
	return synced, off, true
}

// timeSource names the running time daemon (looked up every 10 minutes).
func (s *systemCollector) timeSource() string {
	s.mu.Lock()
	if !s.timeSrcAt.IsZero() && time.Since(s.timeSrcAt) < 10*time.Minute {
		v := s.timeSrc
		s.mu.Unlock()
		return v
	}
	s.mu.Unlock()
	src := detectTimeDaemon(s.root)
	s.mu.Lock()
	s.timeSrc, s.timeSrcAt = src, time.Now()
	s.mu.Unlock()
	return src
}

// detectTimeDaemon scans process names for chronyd, systemd-timesyncd
// ("systemd-timesyn", comm is 15 bytes) and ntpd (ntpd, ntpsec, OpenNTPD).
func detectTimeDaemon(r fsRoot) string {
	ents, err := os.ReadDir(r.path("/proc"))
	if err != nil {
		return ""
	}
	found := ""
	for _, e := range ents {
		if !startsWithDigit(e.Name()) {
			continue
		}
		switch r.readString("/proc/" + e.Name() + "/comm") {
		case "chronyd":
			return "chrony"
		case "systemd-timesyn":
			found = "timesyncd"
		case "ntpd", "openntpd":
			if found == "" {
				found = "ntpd"
			}
		}
	}
	return found
}

// ---- kernel counters ---------------------------------------------------------------

// parseVMStatOOM returns oom_kill from /proc/vmstat (kernel 4.13+).
func parseVMStatOOM(b []byte) uint64 {
	var v uint64
	scanLines(b, func(line string) {
		if n, ok := strings.CutPrefix(line, "oom_kill "); ok {
			v, _ = strconv.ParseUint(strings.TrimSpace(n), 10, 64)
		}
	})
	return v
}

// parseLoadavgTasks returns the number of tasks (field 4 "running/total"
// of /proc/loadavg).
func parseLoadavgTasks(s string) int {
	f := strings.Fields(s)
	if len(f) < 4 {
		return 0
	}
	_, total, ok := strings.Cut(f[3], "/")
	if !ok {
		return 0
	}
	n, _ := strconv.Atoi(total)
	return n
}
