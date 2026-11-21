// Package macos is the agent on a Mac: the collector (CPU, memory,
// volumes, disks, network and temperatures through gopsutil and macOS's
// own tools, and the Mac's facts in Report.MacOS) and the parsers of the
// tools' outputs that the broker and the diagnostics use too.
//
// Every tool runs with a fixed argv (never a shell, never a value from the
// hub), a clean environment and a time limit. The package builds on every
// platform so its parsers are tested anywhere; only a Mac runs the tools.
package macos

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Env is the clean environment of the tools the agent runs on a Mac.
var Env = []string{
	"PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/libexec",
	"LANG=en_US.UTF-8",
	"LC_ALL=C",
	"HOME=/var/root",
	"TERM=dumb",
}

// maxToolOutput bounds what the agent reads of one tool's output.
const maxToolOutput = 16 << 20

// Run runs argv (an absolute path first) with Env, in its own process
// group (killed as a whole when timeout passes), and returns stdout. A
// non-zero exit is an error carrying the first line of stderr; stdout is
// returned with it.
func Run(ctx context.Context, timeout time.Duration, argv ...string) ([]byte, error) {
	return runner(ctx, timeout, argv)
}

// runner is Run's implementation (tests replace it).
var runner = runReal

func runReal(ctx context.Context, timeout time.Duration, argv []string) ([]byte, error) {
	if len(argv) == 0 {
		return nil, errors.New("no command")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = Env
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	stdout := &capped{max: maxToolOutput}
	var stderr capped
	stderr.max = 64 << 10
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	err := cmd.Run()
	name := argv[0][strings.LastIndexByte(argv[0], '/')+1:]
	switch {
	case ctx.Err() != nil:
		return stdout.Bytes(), fmt.Errorf("%s: timed out after %s", name, timeout)
	case err != nil:
		msg := strings.TrimSpace(stderr.String())
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg != "" {
			return stdout.Bytes(), fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return stdout.Bytes(), fmt.Errorf("%s: %w", name, err)
	}
	return stdout.Bytes(), nil
}

// capped keeps at most max bytes.
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	n := len(p)
	if room := c.max - c.Len(); room < len(p) {
		p = p[:max(room, 0)]
	}
	c.Buffer.Write(p)
	return n, nil
}

// ExitCode is the exit status inside err, or -1.
func ExitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// Tool paths (absolute: the agent never searches PATH for them).
const (
	SwVers         = "/usr/bin/sw_vers"
	Sysctl         = "/usr/sbin/sysctl"
	SystemProfiler = "/usr/sbin/system_profiler"
	Csrutil        = "/usr/bin/csrutil"
	Fdesetup       = "/usr/bin/fdesetup"
	Defaults       = "/usr/bin/defaults"
	Stat           = "/usr/bin/stat"
	Ioreg          = "/usr/sbin/ioreg"
	Diskutil       = "/usr/sbin/diskutil"
	Plutil         = "/usr/bin/plutil"
	SoftwareUpdate = "/usr/sbin/softwareupdate"
	Launchctl      = "/bin/launchctl"
	Ps             = "/bin/ps"
	Lsof           = "/usr/sbin/lsof"
	Ifconfig       = "/sbin/ifconfig"
	Route          = "/sbin/route"
	Networksetup   = "/usr/sbin/networksetup"
	Log            = "/usr/bin/log"
	Shutdown       = "/sbin/shutdown"
	Pmset          = "/usr/bin/pmset"
	Df             = "/bin/df"
	Netstat        = "/usr/sbin/netstat"
	Scutil         = "/usr/sbin/scutil"
	Uptime         = "/usr/bin/uptime"
	Uname          = "/usr/bin/uname"
	VMStat         = "/usr/bin/vm_stat"
	Zsh            = "/bin/zsh"
)
