package look

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// Manager is what Look reads from the manager (managerclient.Client).
type Manager interface {
	Hardware(ctx context.Context) (json.RawMessage, error)
	NetworkState(ctx context.Context) (json.RawMessage, error)
	UpdateStatus(ctx context.Context) (json.RawMessage, error)
	HostMetrics(ctx context.Context) (json.RawMessage, error)
}

// Bins are the fixed binaries Look runs (absolute paths).
type Bins struct {
	Journalctl, Systemctl, Ps, Df, Lsblk, Free, IP, Cat, Uname, Uptime, Readlink, Resolvectl string
}

// SystemBin is NixOS's system profile, where DefaultBins finds every binary.
const SystemBin = "/run/current-system/sw/bin"

// DefaultBins are the binaries in dir (SystemBin on the box).
// unitProperties are what `status <unit>` shows of each unit: its state and recent history, no process tree.
const unitProperties = "Id,Description,LoadState,ActiveState,SubState,Result,MainPID,ExecMainStatus," +
	"ExecMainStartTimestamp,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts,MemoryCurrent,CPUUsageNSec,TasksCurrent"

func DefaultBins(dir string) Bins {
	b := func(n string) string { return filepath.Join(dir, n) }
	return Bins{Journalctl: b("journalctl"), Systemctl: b("systemctl"), Ps: b("ps"), Df: b("df"), Lsblk: b("lsblk"),
		Free: b("free"), IP: b("ip"), Cat: b("cat"), Uname: b("uname"), Uptime: b("uptime"), Readlink: b("readlink"), Resolvectl: b("resolvectl")}
}

func (b Bins) all() []string {
	return []string{b.Journalctl, b.Systemctl, b.Ps, b.Df, b.Lsblk, b.Free, b.IP, b.Cat, b.Uname, b.Uptime, b.Readlink, b.Resolvectl}
}

// Config is the Look runner's configuration.
type Config struct {
	Bins Bins
	// UID and GID are whombat-support-look's; Groups its supplementary groups (systemd-journal). Never root.
	UID, GID uint32
	Groups   []uint32
	// KeepGroups runs without setgroups: only for tests, which run unprivileged and as themselves; refused as root.
	KeepGroups bool
	// Manager answers hardware, network, updates and the measurements in status; nil: those say it isn't reachable.
	Manager Manager
	// Timeout bounds a command that doesn't follow (default 2 min); report gets 3 times as long.
	Timeout time.Duration
	// Path is the PATH the commands see (default SystemBin).
	Path string
}

// Runner runs Look commands.
type Runner struct {
	cfg Config
	env []string
}

// New checks the configuration: absolute binaries, an unprivileged user, KeepGroups only when not root.
func New(cfg Config) (*Runner, error) {
	if cfg.UID == 0 || cfg.GID == 0 {
		return nil, errors.New("look: commands must not run as root")
	}
	if cfg.KeepGroups && os.Geteuid() == 0 {
		return nil, errors.New("look: KeepGroups is for unprivileged tests only")
	}
	for _, b := range cfg.Bins.all() {
		if !filepath.IsAbs(b) {
			return nil, fmt.Errorf("look: binary %q isn't an absolute path", b)
		}
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 2 * time.Minute
	}
	if cfg.Path == "" {
		cfg.Path = SystemBin
	}
	env := []string{"PATH=" + cfg.Path, "LC_ALL=C.UTF-8", "LANG=C.UTF-8", "TERM=dumb", "HOME=/var/empty",
		"PAGER=cat", "SYSTEMD_PAGER=cat", "SYSTEMD_COLORS=0", "SYSTEMD_URLIFY=0", "COLUMNS=200"}
	return &Runner{cfg: cfg, env: env}, nil
}

// Run runs c, writing its output to stdout and what went wrong to stderr; it returns the exit status. A command that
// follows (logs -f) runs until ctx ends; anything else is bounded by the timeout. The output's control characters
// (but tabs and newlines) become '?', so nothing on the box can drive the support person's terminal.
func (r *Runner) Run(ctx context.Context, c Command, stdout, stderr io.Writer) int {
	if !c.Follow {
		timeout := r.cfg.Timeout
		if c.Name == "report" {
			timeout *= 3
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	o := &out{ctx: ctx, r: r, stdout: clean(stdout), stderr: clean(stderr)}
	b := r.cfg.Bins
	switch c.Name {
	case "help":
		io.WriteString(o.stdout, Help())
	case "status":
		if len(c.Units) > 0 {
			// Named properties, not `systemctl status`: its process tree shows every program's full command line,
			// which can carry tokens (what `processes` deliberately leaves out). The unit's recent lines follow.
			o.run(b.Systemctl, append([]string{"--no-pager", "show", "--property=" + unitProperties, "--"}, c.Units...)...)
			for _, u := range c.Units {
				o.run(b.Journalctl, "--no-pager", "-o", "short-iso", "--lines=20", "--unit="+u)
			}
			break
		}
		o.section("state")
		o.run(b.Systemctl, "is-system-running")
		o.section("failed units")
		o.run(b.Systemctl, "--no-pager", "--failed")
		o.section("uptime")
		o.run(b.Uptime)
		o.section("release")
		o.run(b.Cat, "/etc/whombat/platform")
		o.run(b.Readlink, "/run/current-system")
		o.section("measurements")
		o.manager("measurements", r.hostNow)
	case "units":
		if c.Failed {
			o.run(b.Systemctl, "--no-pager", "list-units", "--failed")
		} else {
			o.run(b.Systemctl, "--no-pager", "list-units", "--all")
		}
	case "logs":
		o.run(b.Journalctl, c.argv...)
	case "boots":
		o.run(b.Journalctl, "--no-pager", "--list-boots")
	case "hardware":
		o.manager("hardware", r.mgr(Manager.Hardware))
	case "network":
		o.section("network state")
		o.manager("network state", r.mgr(Manager.NetworkState))
		o.section("addresses")
		o.run(b.IP, "-br", "addr")
		o.section("routes")
		o.run(b.IP, "route")
		o.run(b.IP, "-6", "route")
		o.section("DNS")
		o.run(b.Resolvectl, "--no-pager", "status")
	case "disks":
		o.run(b.Df, "-h", "-x", "tmpfs", "-x", "devtmpfs")
		io.WriteString(o.stdout, "\n")
		o.run(b.Lsblk, "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT")
	case "memory":
		o.run(b.Free, "-m")
		o.section("pressure")
		o.run(b.Cat, "/proc/pressure/memory", "/proc/pressure/cpu", "/proc/pressure/io")
		o.section("swap")
		o.run(b.Cat, "/proc/swaps")
	case "processes":
		// comm only: a program's arguments can hold anything, so they are never shown.
		o.run(b.Ps, "-e", "-o", "pid,ppid,user,pcpu,pmem,rss,stat,etime,comm", "--sort=-pcpu")
	case "updates":
		o.manager("update status", r.mgr(Manager.UpdateStatus))
	case "report":
		r.report(o)
	default:
		fmt.Fprintf(o.stderr, "%s isn't a Look command.\n", c.Name)
		return 2
	}
	return o.code
}

// report is every section a first look at a box needs, in one go.
func (r *Runner) report(o *out) {
	b := r.cfg.Bins
	o.section("units")
	o.run(b.Systemctl, "--no-pager", "--failed")
	o.run(b.Systemctl, "--no-pager", "list-units", "--all", "whombat-*", "postgresql*")
	o.section("system")
	o.run(b.Uname, "-a")
	o.run(b.Uptime)
	o.run(b.Cat, "/etc/whombat/platform")
	o.run(b.Readlink, "/run/current-system")
	o.run(b.Free, "-m")
	o.run(b.Df, "-h", "-x", "tmpfs", "-x", "devtmpfs")
	o.run(b.Cat, "/proc/pressure/memory", "/proc/pressure/cpu", "/proc/pressure/io")
	o.section("journal: whombat units, last 2 hours")
	o.run(b.Journalctl, "--no-pager", "-o", "short-iso", "--since=-2h", "--unit=whombat-*")
	o.section("journal: warnings, last 24 hours")
	o.run(b.Journalctl, "--no-pager", "-o", "short-iso", "--since=-24h", "--priority=warning")
	o.section("boots")
	o.run(b.Journalctl, "--no-pager", "--list-boots")
	o.section("network")
	o.run(b.IP, "-br", "addr")
	o.run(b.IP, "route")
	o.run(b.IP, "-6", "route")
	o.section("DNS")
	o.run(b.Resolvectl, "--no-pager", "status")
}

func (r *Runner) mgr(read func(Manager, context.Context) (json.RawMessage, error)) func(context.Context) (json.RawMessage, error) {
	return func(ctx context.Context) (json.RawMessage, error) {
		if r.cfg.Manager == nil {
			return nil, errors.New("the manager isn't reachable")
		}
		return read(r.cfg.Manager, ctx)
	}
}

// hostNow is the "now" part of the box's measurements.
func (r *Runner) hostNow(ctx context.Context) (json.RawMessage, error) {
	all, err := r.mgr(Manager.HostMetrics)(ctx)
	if err != nil {
		return nil, err
	}
	var m struct {
		Metrics struct {
			Now json.RawMessage `json:"now"`
		} `json:"metrics"`
	}
	if json.Unmarshal(all, &m) == nil && len(m.Metrics.Now) > 0 {
		return m.Metrics.Now, nil
	}
	return all, nil
}

// out runs the steps of one command and keeps the first failure's status.
type out struct {
	ctx            context.Context
	r              *Runner
	stdout, stderr io.Writer
	code           int
	sections       int
}

func (o *out) fail(code int) {
	if o.code == 0 {
		o.code = code
	}
}

func (o *out) section(name string) {
	if o.sections > 0 {
		io.WriteString(o.stdout, "\n")
	}
	o.sections++
	fmt.Fprintf(o.stdout, "== %s ==\n", name)
}

func (o *out) manager(what string, read func(context.Context) (json.RawMessage, error)) {
	if o.ctx.Err() != nil {
		return
	}
	raw, err := read(o.ctx)
	if err != nil {
		fmt.Fprintf(o.stderr, "%s: %v\n", what, err)
		o.fail(1)
		return
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		fmt.Fprintf(o.stderr, "%s: the manager's answer isn't JSON\n", what)
		o.fail(1)
		return
	}
	buf.WriteByte('\n')
	_, _ = o.stdout.Write(buf.Bytes())
}

// run runs one fixed binary as the Look user: no shell, a fixed environment, no input, its own process group (killed
// whole when ctx ends; systemd's control-group kill ends it with the service).
func (o *out) run(bin string, args ...string) {
	if o.ctx.Err() != nil {
		o.fail(1)
		return
	}
	cfg := o.r.cfg
	cmd := exec.CommandContext(o.ctx, bin, args...)
	cmd.Env = o.r.env
	cmd.Dir = "/"
	cmd.Stdout = o.stdout
	cmd.Stderr = o.stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
		Credential: &syscall.Credential{Uid: cfg.UID, Gid: cfg.GID, Groups: cfg.Groups,
			NoSetGroups: cfg.KeepGroups},
	}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee) && o.ctx.Err() == nil:
		o.fail(max(ee.ExitCode(), 1))
	case o.ctx.Err() != nil && errors.Is(o.ctx.Err(), context.DeadlineExceeded):
		fmt.Fprintf(o.stderr, "%s took too long and was stopped.\n", filepath.Base(bin))
		o.fail(124)
	case o.ctx.Err() != nil:
		o.fail(130)
	default:
		fmt.Fprintf(o.stderr, "can't run %s: %v\n", filepath.Base(bin), err)
		o.fail(127)
	}
}

// clean replaces control characters but tab and newline with '?'.
func clean(w io.Writer) io.Writer { return &cleaner{w: w} }

type cleaner struct {
	w   io.Writer
	buf []byte
}

func (c *cleaner) Write(p []byte) (int, error) {
	c.buf = append(c.buf[:0], p...)
	for i, b := range c.buf {
		if b < 0x20 && b != '\t' && b != '\n' || b == 0x7f {
			c.buf[i] = '?'
		}
	}
	if _, err := c.w.Write(c.buf); err != nil {
		return 0, err
	}
	return len(p), nil
}
