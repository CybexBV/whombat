package agent

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// selfStats measures the agent's own RSS and CPU use. The collector
// measures the same (package collect); the runtime only uses this when the
// collector did not fill AgentInfo.
type selfStats struct {
	mu      sync.Mutex
	lastCPU time.Duration
	lastAt  time.Time
}

// sample returns RSS bytes and CPU percent of one core since the previous
// call (0 on the first call). CPU time includes reaped child processes
// (smartctl, zpool, apt-get), which the agent starts and waits for.
func (s *selfStats) sample() (rss uint64, cpuPct float64) {
	rss = readRSS()
	cpu, ok := CPUTimeWithChildren()
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if ok && !s.lastAt.IsZero() && cpu >= s.lastCPU {
		if dt := now.Sub(s.lastAt).Seconds(); dt > 0 {
			cpuPct = (cpu - s.lastCPU).Seconds() / dt * 100
			cpuPct = float64(int(cpuPct*100+0.5)) / 100
		}
	}
	if ok {
		s.lastCPU, s.lastAt = cpu, now
	}
	return rss, cpuPct
}

// CPUTimeWithChildren returns the user+system CPU time of this process
// (all threads) plus that of its terminated, waited-for children.
func CPUTimeWithChildren() (time.Duration, bool) {
	var self, children syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &self) != nil || syscall.Getrusage(syscall.RUSAGE_CHILDREN, &children) != nil {
		return 0, false
	}
	tv := func(t syscall.Timeval) time.Duration {
		return time.Duration(t.Sec)*time.Second + time.Duration(t.Usec)*time.Microsecond
	}
	return tv(self.Utime) + tv(self.Stime) + tv(children.Utime) + tv(children.Stime), true
}

// readRSS returns VmRSS from /proc/self/status in bytes.
func readRSS() uint64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			fields := strings.Fields(v)
			if len(fields) >= 1 {
				n, err := strconv.ParseUint(fields[0], 10, 64)
				if err == nil {
					return n * 1024 // kB
				}
			}
		}
	}
	return 0
}

// Install methods reported in AgentInfo.Install.
const (
	InstallSystemd = "systemd"
	InstallOpenRC  = "openrc"
	InstallSysV    = "sysv"
	InstallUnraid  = "unraid"
	InstallManual  = "manual"
	InstallLaunchd = "launchd"
)

// LaunchdLabel is the agent's LaunchDaemon on a Mac
// (/Library/LaunchDaemons/com.whombat.agent.plist).
const LaunchdLabel = "com.whombat.agent"

// LaunchdPlist is that LaunchDaemon's file.
const LaunchdPlist = "/Library/LaunchDaemons/" + LaunchdLabel + ".plist"

// unraidConfigDir is where the Unraid installer keeps the agent's
// configuration (on the boot flash).
const unraidConfigDir = "/boot/config/plugins/whombat-agent"

// installEnv is what detectInstall looks at; tests fill it.
type installEnv struct {
	configDir     string // resolved configuration directory
	env           func(string) string
	parentCmdline []string // argv of the parent process
	parentComm    string
	parentPID     int
	pid1Comm      string
	unraid        bool // /etc/unraid-version exists
	unitExists    bool // a whombat-agent.service unit file is installed
	darwin        bool // a Mac
	launchdPlist  bool // the agent's LaunchDaemon is installed
}

// detectInstall tells how the agent was installed and started. It is a
// heuristic on what the process can see:
//
//   - unraid: the configuration lives on the Unraid flash (the installer's
//     layout), or the host is Unraid;
//   - systemd: systemd set INVOCATION_ID (it does for every service), or
//     the parent is PID 1 = systemd and the agent's unit is installed;
//   - openrc: openrc-run exported RC_SVCNAME, or the parent is
//     supervise-daemon;
//   - sysv: the parent is `whombat-agent supervise` (the SysV script and
//     other init systems use it);
//   - launchd: a Mac whose agent launchd started (parent PID 1) from its
//     LaunchDaemon;
//   - manual: anything else (a shell, a container entrypoint, tmux).
func detectInstall(e installEnv) string {
	if e.darwin {
		if e.parentPID == 1 && e.launchdPlist {
			return InstallLaunchd
		}
		return InstallManual
	}
	if e.unraid || hasPathPrefix(e.configDir, unraidConfigDir) {
		return InstallUnraid
	}
	if e.env("INVOCATION_ID") != "" {
		return InstallSystemd
	}
	if e.env("RC_SVCNAME") != "" || e.parentComm == "supervise-daemon" {
		return InstallOpenRC
	}
	for _, a := range e.parentCmdline {
		if a == "supervise" {
			return InstallSysV
		}
	}
	if e.parentPID == 1 && e.pid1Comm == "systemd" && e.unitExists {
		return InstallSystemd
	}
	return InstallManual
}

func hasPathPrefix(p, prefix string) bool {
	return p == prefix || strings.HasPrefix(p, prefix+"/")
}

var (
	installOnce  sync.Once
	installValue string
)

// installMethod returns detectInstall for this process (computed once: it
// cannot change while the agent runs).
func installMethod(configDir string) string {
	installOnce.Do(func() {
		dir := configDir
		if abs, err := filepath.Abs(dir); err == nil {
			dir = abs
		}
		if r, err := filepath.EvalSymlinks(dir); err == nil {
			dir = r
		}
		ppid := os.Getppid()
		e := installEnv{
			configDir:  dir,
			env:        os.Getenv,
			parentPID:  ppid,
			parentComm: strings.TrimSpace(readSmall("/proc/" + strconv.Itoa(ppid) + "/comm")),
			pid1Comm:   strings.TrimSpace(readSmall("/proc/1/comm")),
		}
		if b := readSmall("/proc/" + strconv.Itoa(ppid) + "/cmdline"); b != "" {
			e.parentCmdline = strings.Split(strings.TrimRight(b, "\x00"), "\x00")
		}
		if runtime.GOOS == "darwin" {
			_, err := os.Stat(LaunchdPlist)
			e.darwin, e.launchdPlist = true, err == nil
			installValue = detectInstall(e)
			return
		}
		_, err := os.Stat("/etc/unraid-version")
		e.unraid = err == nil
		for _, p := range []string{"/etc/systemd/system/whombat-agent.service", "/usr/lib/systemd/system/whombat-agent.service", "/lib/systemd/system/whombat-agent.service"} {
			if _, err := os.Stat(p); err == nil {
				e.unitExists = true
				break
			}
		}
		installValue = detectInstall(e)
	})
	return installValue
}

func readSmall(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	return string(buf[:n])
}
