package diagnose

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v4/sensors"

	"rackoon/internal/agent/macos"
	"rackoon/internal/agent/pkgs"
	"rackoon/internal/proto"
)

// A Mac's checks (docs/ASSIST.md 3.1, macOS): the same names as Linux's
// where the question is the same, macOS's tools behind them. Every value
// is validated here; a log filter is built from validated parts, never a
// predicate from the hub.

// NewMac returns a Mac's diagnostics. inspect is the Mac broker's views.
func NewMac(inspect func(context.Context, proto.InspectRequest) proto.InspectResponse, log *slog.Logger) *Diagnostics {
	if log == nil {
		log = slog.Default()
	}
	return &Diagnostics{
		Inspect:    inspect,
		Log:        log,
		run:        runReal,
		lookPath:   macLookPath,
		initSystem: "launchd",
		pkgManager: pkgs.Detect,
		now:        time.Now,
		shell:      "/bin/sh",
		checks:     macCatalog,
		env:        macEnv,
		execEnv:    MacExecEnv,
		home:       "/var/root",
	}
}

// macBinDirs: macOS's own tools only (a Homebrew tool of the same name
// never stands in for one).
var macBinDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/libexec"}

func macLookPath(name string) (string, error) {
	if filepath.IsAbs(name) {
		if st, err := os.Stat(name); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return name, nil
		}
		return "", fmt.Errorf("%s is not installed", name)
	}
	for _, d := range macBinDirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s is not installed", name)
}

// macEnv is the clean environment of a Mac's check commands.
func macEnv(parse bool) []string {
	e := []string{
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/libexec",
		"LANG=en_US.UTF-8",
		"HOME=/var/root",
		"TERM=dumb",
		"PAGER=cat",
	}
	if parse {
		e = append(e, "LC_ALL=C")
	}
	return e
}

// MacExecEnv is the clean environment of the assistant's commands on a
// Mac: macOS's PATH with Homebrew's folders, root's home.
var MacExecEnv = []string{
	"PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
	"HOME=/var/root",
	"LANG=en_US.UTF-8",
	"USER=root",
	"LOGNAME=root",
	"SHELL=/bin/sh",
	"TERM=dumb",
}

var macCatalog = []check{
	{name: "system", desc: "macOS version, model, uptime, memory and the volumes",
		plan: planMacSystem},
	{name: "processes", desc: "The top processes by CPU or memory",
		args: []arg{
			{name: "sort", desc: "cpu (default) or mem", parse: oneOf("cpu", "mem", "memory")},
			{name: "limit", desc: "rows, at most 200 (default 40)", parse: intArg(40, 200)},
		},
		plan: planMacProcesses},
	{name: "ports", desc: "Listening TCP and UDP sockets with their process",
		plan: planMacPorts},
	{name: "services", desc: "launchd's jobs: failed ones (default: not running, last exit not clean), running or all",
		args: []arg{{name: "state", desc: "failed (default), running or all", parse: oneOf("failed", "running", "all")}},
		plan: planMacServices},
	{name: "service", desc: "One launchd job: its definition, state and last exit",
		args: []arg{{name: "name", desc: `the job's label ("com.openssh.sshd")`, required: true, parse: reArg(launchdLabelRe, "a launchd label")}},
		plan: planMacService},
	{name: "logs", desc: "The unified log, newest last",
		tail: true,
		args: []arg{
			{name: "process", desc: `only this process ("sshd-session", "kernel")`, parse: reArg(macProcessRe, "a process name")},
			{name: "subsystem", desc: `only this subsystem ("com.apple.xpc")`, parse: reArg(subsystemRe, "a subsystem")},
			{name: "since", desc: `"2h", "30m", "1d", "today", "yesterday" or a time ("2026-10-17 10:00"); default the last hour`, parse: parseSinceArg},
			{name: "lines", desc: "at most this many lines, up to 2000 (default 200)", parse: intArg(200, 2000)},
			{name: "grep", desc: "only lines matching this regular expression (case-insensitive unless it has capitals)", parse: parseMacGrep},
		},
		plan: planMacLogs},
	{name: "disks", desc: "Disks, APFS containers and volumes, and the mounted file systems",
		plan: planMacDisks},
	{name: "smart", desc: "One disk's details and SMART values (diskutil)",
		args: []arg{{name: "device", desc: `a whole disk ("disk0")`, required: true, parse: parseMacDisk}},
		plan: planMacSmart},
	{name: "network", desc: "Interfaces, hardware ports, routes and DNS resolvers",
		plan: planMacNetwork},
	{name: "sensors", desc: "Temperatures the Mac reports",
		plan: planMacSensors},
	{name: "updates", desc: "Updates macOS's own check found, and what was installed",
		plan: planMacUpdates},
	{name: "power", desc: "Power settings, what keeps the Mac awake, and the latest sleep and wake events",
		plan: planMacPower},
}

var (
	launchdLabelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	macProcessRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$`)
	subsystemRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	macDiskRe      = regexp.MustCompile(`^(?:/dev/)?(disk[0-9]{1,3})$`)
)

func parseMacGrep(_ *Diagnostics, v string) (string, error) {
	if len(v) > 200 {
		return "", errors.New("at most 200 characters")
	}
	if _, err := compileGrep(v); err != nil {
		return "", err
	}
	return v, nil
}

// parseMacDisk accepts a whole disk that exists ("disk0", "/dev/disk0").
func parseMacDisk(d *Diagnostics, v string) (string, error) {
	m := macDiskRe.FindStringSubmatch(v)
	if m == nil {
		return "", fmt.Errorf("%q is not a whole disk (disk0, disk4)", v)
	}
	if !d.exists("/dev/" + m[1]) {
		return "", fmt.Errorf("no disk %q on this Mac", m[1])
	}
	return m[1], nil
}

func planMacSystem(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	return []step{
		cmdStep("sw_vers"),
		cmdStep("uname", "-a"),
		cmdStep("uptime"),
		cmdStep("sysctl", "hw.model", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize", "kern.boottime"),
		cmdStep("vm_stat"),
		cmdStep("sysctl", "vm.swapusage"),
		cmdStep("df", "-h", "-l"),
	}, nil
}

// planMacProcesses is Linux's check with ps behind it (its CPU column is
// ps's recent average, not a 1 s sample).
func planMacProcesses(ctx context.Context, d *Diagnostics, a args) ([]step, error) {
	steps, err := planProcesses(ctx, d, a)
	for i := range steps {
		steps[i].title = strings.Replace(steps[i].title, " over 1 s (from /proc)", " (ps)", 1)
		steps[i].title = strings.Replace(steps[i].title, " (from /proc)", " (ps)", 1)
	}
	return steps, err
}

func planMacPorts(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	return []step{{title: "listening sockets (lsof)", fn: func(ctx context.Context) (string, error) {
		v, err := d.inspectView(ctx, proto.InspectPorts, 0)
		if err != nil {
			return "", err
		}
		return portTable(v.Ports, v.Truncated), nil
	}}}, nil
}

func planMacServices(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	state := a["state"]
	if state == "" {
		state = "failed"
	}
	return []step{{title: "launchctl list (" + state + ")", fn: func(ctx context.Context) (string, error) {
		v, err := d.inspectView(ctx, proto.InspectServices, 5000)
		if err != nil {
			return "", err
		}
		var rows []proto.Service
		for _, s := range v.Services {
			switch {
			case state == "all",
				state == "failed" && s.Active == "failed",
				state == "running" && s.Active == "active":
				rows = append(rows, s)
			}
		}
		return serviceTable(rows, state), nil
	}}}, nil
}

func serviceTable(rows []proto.Service, state string) string {
	if len(rows) == 0 {
		return "No " + state + " jobs.\n"
	}
	out := make([][]string, 0, len(rows))
	for _, s := range rows {
		out = append(out, []string{s.Name, s.Active, dash(s.Description)})
	}
	return table("LABEL\tSTATE\tDETAIL", out)
}

func planMacService(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	s := cmdStep("launchctl", "print", "system/"+a["name"])
	return []step{s}, nil
}

// logQueryMac is a validated "logs" request on a Mac.
type logQueryMac struct {
	process, subsystem, grep string
	since                    time.Time
	lines                    int
}

// MacLogArgv is `log show` for q: the last hour unless since says
// otherwise, filtered by a predicate the agent builds from the validated
// process and subsystem.
func MacLogArgv(q logQueryMac, now time.Time) []string {
	argv := []string{macos.Log, "show", "--style", "syslog"}
	if q.since.IsZero() {
		argv = append(argv, "--last", "1h")
	} else {
		argv = append(argv, "--start", q.since.In(now.Location()).Format("2006-01-02 15:04:05"))
	}
	var preds []string
	if q.process != "" {
		preds = append(preds, `process == "`+q.process+`"`)
	}
	if q.subsystem != "" {
		preds = append(preds, `subsystem == "`+q.subsystem+`"`)
	}
	if len(preds) > 0 {
		argv = append(argv, "--predicate", strings.Join(preds, " AND "))
	}
	return argv
}

func planMacLogs(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	q := logQueryMac{process: a["process"], subsystem: a["subsystem"], grep: a["grep"], lines: a.int("lines", 200)}
	if a.has("since") {
		q.since, _ = time.Parse(time.RFC3339, a["since"])
	}
	argv := MacLogArgv(q, d.now())
	title := quoteArgv(argv)
	if q.grep != "" {
		title += " | grep " + shellQuote(q.grep)
	}
	title += fmt.Sprintf(" | tail -n %d", q.lines)
	return []step{{title: title, fn: func(ctx context.Context) (string, error) {
		var keep func(string) bool
		if q.grep != "" {
			re, err := compileGrep(q.grep)
			if err != nil {
				return "", err
			}
			keep = re.MatchString
		}
		return tailCommand(ctx, argv, macEnv(false), keep, q.lines, CheckTimeout-5*time.Second)
	}}}, nil
}

// tailCommand runs argv in its own process group and keeps the last n
// output lines that keep accepts (all when nil): log show prints hundreds
// of thousands of lines an hour, more than any buffer should hold.
func tailCommand(ctx context.Context, argv, env []string, keep func(string) bool, n int, limit time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	errBuf := &capBuffer{max: 16 << 10}
	cmd.Stderr = errBuf
	if err := cmd.Start(); err != nil {
		return "", err
	}
	ring := make([]string, 0, n)
	start := 0
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if keep != nil && !keep(line) {
			continue
		}
		if len(line) > 4096 {
			line = line[:4096] + "…"
		}
		if len(ring) < n {
			ring = append(ring, line)
		} else {
			ring[start] = line
			start = (start + 1) % n
		}
	}
	werr := cmd.Wait()
	lines := append(append([]string(nil), ring[start:]...), ring[:start]...)
	out := strings.Join(lines, "\n")
	if out != "" {
		out += "\n"
	}
	switch {
	case ctx.Err() != nil:
		return out, errCheckTime
	case werr != nil:
		if l := lastLine(string(errBuf.bytes())); l != "" {
			return out, fmt.Errorf("%v: %s", werr, l)
		}
		return out, werr
	}
	if out == "" {
		out = "(no matching lines)\n"
	}
	return out, nil
}

func planMacDisks(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	return []step{cmdStep("diskutil", "list"), cmdStep("diskutil", "apfs", "list"), cmdStep("df", "-h", "-l")}, nil
}

func planMacSmart(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	dev := a["device"]
	return []step{
		cmdStep("diskutil", "info", dev),
		{title: "SMART values (diskutil info -plist " + dev + ")", fn: func(ctx context.Context) (string, error) {
			out, err := d.output(ctx, []string{"diskutil", "info", "-plist", dev})
			if err != nil {
				return "", err
			}
			di, err := macos.ParseDiskutilInfo([]byte(out))
			if err != nil {
				return "", err
			}
			return smartTable(di), nil
		}},
	}, nil
}

func smartTable(di *macos.DiskInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "SMART status: %s\n", dash(di.SMARTStatus))
	if len(di.SMART) == 0 {
		b.WriteString("The disk reports no SMART values to macOS.\n")
		return b.String()
	}
	keys := make([]string, 0, len(di.SMART))
	for k := range di.SMART {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %d\n", k, di.SMART[k])
	}
	return b.String()
}

func planMacNetwork(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	return []step{
		cmdStep("networksetup", "-listallhardwareports"),
		cmdStep("ifconfig"),
		cmdStep("netstat", "-rn"),
		cmdStep("scutil", "--dns"),
	}, nil
}

func planMacSensors(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	return []step{{title: "temperature sensors (IOKit)", fn: func(ctx context.Context) (string, error) {
		ts, err := sensors.TemperaturesWithContext(ctx)
		if len(ts) == 0 {
			if err == nil {
				err = errors.New("the Mac reports no temperatures")
			}
			return "", err
		}
		sort.Slice(ts, func(i, j int) bool { return ts[i].SensorKey < ts[j].SensorKey })
		var b strings.Builder
		for _, t := range ts {
			fmt.Fprintf(&b, "%s: %s °C\n", t.SensorKey, strconv.FormatFloat(t.Temperature, 'f', 1, 64))
		}
		return b.String(), nil
	}}}, nil
}

func planMacUpdates(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	return []step{
		{title: "updates macOS's own check found (" + macos.SoftwareUpdatePlist + ")", fn: func(ctx context.Context) (string, error) {
			p, err := macos.ReadPending(ctx)
			if err != nil {
				return "", err
			}
			s := updateTable(p.Updates, "macOS's own check")
			if !p.CheckedAt.IsZero() {
				s += "Last checked " + p.CheckedAt.UTC().Format("2006-01-02 15:04 UTC") + ".\n"
			}
			return s, nil
		}},
		cmdStep("softwareupdate", "--history"),
	}, nil
}

func planMacPower(_ context.Context, _ *Diagnostics, _ args) ([]step, error) {
	logStep := cmdStep("pmset", "-g", "log")
	logStep.title += " | tail -n 100"
	logStep.tailLines = 100
	return []step{cmdStep("pmset", "-g"), cmdStep("pmset", "-g", "assertions"), logStep}, nil
}
