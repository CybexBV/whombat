package diagnose

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"rackoon/internal/agent/inspect"
	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// catalog is docs/ASSIST.md 3.1, in the order the catalog lists it.
var catalog = []check{
	{name: "system", desc: "Kernel, uptime, OS release, memory, file systems and the recent boots",
		plan: planSystem},
	{name: "processes", desc: "The top processes by CPU (sampled over 1 s) or memory, with the guest a process belongs to",
		args: []arg{
			{name: "sort", desc: "cpu (default) or mem", parse: oneOf("cpu", "mem", "memory")},
			{name: "limit", desc: "rows, at most 200 (default 40)", parse: intArg(40, 200)},
		},
		plan: planProcesses},
	{name: "ports", desc: "Listening TCP and UDP sockets with their process",
		plan: planPorts},
	{name: "services", desc: "Service units: failed ones (default, all unit types), running or all",
		args:  []arg{{name: "state", desc: "failed (default), running or all", parse: oneOf("failed", "running", "all")}},
		avail: needInit, plan: planServices},
	{name: "service", desc: "One service's status and its last 50 log lines",
		args:  []arg{{name: "name", desc: `unit or service name ("nginx", "pveproxy.service")`, required: true, parse: reArg(unitRe, "a unit name")}},
		avail: needInit, plan: planService},
	{name: "logs", desc: "The system log (journal, or the syslog files without journald), newest last",
		tail: true,
		args: []arg{
			{name: "unit", desc: "only this unit / program", parse: reArg(unitRe, "a unit name")},
			{name: "since", desc: `"2h", "30m", "1d", "today", "yesterday" or a time ("2026-10-17 10:00")`, parse: parseSinceArg},
			{name: "lines", desc: "at most this many lines, up to 2000 (default 200)", parse: intArg(200, 2000)},
			{name: "grep", desc: "only lines matching this regular expression (case-insensitive unless it has capitals)", parse: parseGrep},
			{name: "priority", desc: "this priority and worse: 0-7 or emerg, alert, crit, err, warning, notice, info, debug", parse: parsePriority},
			{name: "kernel", desc: "true: kernel messages only", parse: parseBool},
		},
		avail: needLogs, plan: planLogs},
	{name: "disks", desc: "Block devices (model, serial, transport, state) and file systems",
		needs: [][]string{{"lsblk"}}, plan: planDisks},
	{name: "smart", desc: "Full SMART data of one disk (a disk in standby is not woken up)",
		args:  []arg{{name: "device", desc: "sda, nvme0n1, or a /dev/disk/by-id name", required: true, parse: parseDevice}},
		needs: [][]string{{"smartctl"}}, plan: planSmart},
	{name: "raid", desc: "Linux md arrays: /proc/mdstat and mdadm --detail of each",
		avail: needMD, plan: planRaid},
	{name: "unraid", desc: "The Unraid array: md status, emhttp's var.ini and disks.ini, the array and disk lines of the syslog",
		avail: needUnraid, plan: planUnraid},
	{name: "zfs", desc: "ZFS pools (status with errors, capacity) and datasets",
		args:  []arg{{name: "pool", desc: "only this pool", parse: reArg(poolRe, "a pool name")}},
		needs: [][]string{{"zpool"}}, plan: planZFS},
	{name: "network", desc: "Addresses, routes, interface counters, DNS resolvers and bonds",
		needs: [][]string{{"ip"}}, plan: planNetwork},
	{name: "sensors", desc: "Temperatures, fans and voltages (lm-sensors)",
		needs: [][]string{{"sensors"}}, plan: planSensors},
	{name: "docker", desc: "Docker containers, or one container's details (without its environment)",
		args:  []arg{{name: "container", desc: "a container name or id", parse: parseContainer}},
		needs: [][]string{{"docker"}, dockerSockets}, plan: planDocker},
	{name: "docker_logs", desc: "A Docker container's log, newest last",
		tail: true,
		args: []arg{
			{name: "container", desc: "a container name or id", required: true, parse: parseContainer},
			{name: "lines", desc: "at most this many lines, up to 2000 (default 200)", parse: intArg(200, 2000)},
			{name: "since", desc: `"2h", "30m", "today" or a time ("2026-10-17 10:00")`, parse: parseSinceArg},
		},
		needs: [][]string{{"docker"}, dockerSockets}, plan: planDockerLogs},
	{name: "incus", desc: "Incus instances, or one instance's state and log",
		args:  []arg{{name: "instance", desc: `an instance name ("web", or "project/web")`, parse: reArg(instanceRe, "an instance name")}},
		needs: [][]string{{"incus"}, incusSockets}, plan: planIncus},
	{name: "libvirt", desc: "libvirt domains, or one domain's state, disks and interfaces",
		args:  []arg{{name: "domain", desc: "a domain name or UUID", parse: reArg(domainRe, "a domain name")}},
		needs: [][]string{{"virsh"}, libvirtSockets}, plan: planLibvirt},
	{name: "pve", desc: "Proxmox VE: version, cluster, storage, HA and guests, or one guest's configuration (secrets redacted) and status",
		args:  []arg{{name: "guest", desc: "a VMID on this node", parse: reArg(vmidRe, "a VMID")}},
		needs: [][]string{{"pveversion"}}, plan: planPVE},
	{name: "ups", desc: "UPS status (NUT upsc, apcupsd apcaccess)",
		needs: [][]string{{"upsc", "apcaccess"}}, plan: planUPS},
	{name: "updates", desc: "Pending package updates, from the package manager's cache",
		avail: needPkgManager, plan: planUpdates},
}

var (
	dockerSockets  = []string{"/var/run/docker.sock", "/run/docker.sock"}
	incusSockets   = []string{"/var/lib/incus/unix.socket", "/run/incus/unix.socket"}
	libvirtSockets = []string{"/var/run/libvirt/libvirt-sock-ro", "/run/libvirt/libvirt-sock-ro",
		"/var/run/libvirt/virtqemud-sock-ro", "/run/libvirt/virtqemud-sock-ro",
		"/var/run/libvirt/libvirt-sock", "/run/libvirt/libvirt-sock"}
)

// ---- argument parsers ----------------------------------------------------------------

// Argument patterns. Unit names may carry systemd's escapes
// ("dev-disk-by\x2duuid-…"); no value may start with "-".
var (
	unitRe      = regexp.MustCompile(`^[A-Za-z0-9@._:\\-]{1,128}$`)
	poolRe      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,254}$`)
	containerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	instanceRe  = regexp.MustCompile(`^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}/)?[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`)
	domainRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+:-]{0,127}$`)
	vmidRe      = regexp.MustCompile(`^[0-9]{1,9}$`)
	deviceRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:+@-]{0,127}$`)
	upsNameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$`)
	mdNameRe    = regexp.MustCompile(`(?m)^(md[A-Za-z0-9_]+)\s*:\s*(?:active|inactive)`)
	nvmeCtrlRe  = regexp.MustCompile(`^nvme[0-9]+$`)
)

func oneOf(vals ...string) func(*Diagnostics, string) (string, error) {
	return func(_ *Diagnostics, v string) (string, error) {
		v = strings.ToLower(v)
		for _, x := range vals {
			if v == x {
				return v, nil
			}
		}
		return "", fmt.Errorf("use %s", strings.Join(vals, ", "))
	}
}

// intArg accepts a positive integer, at most max (larger values are
// lowered to it).
func intArg(def, max int) func(*Diagnostics, string) (string, error) {
	return func(_ *Diagnostics, v string) (string, error) {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return "", fmt.Errorf("a whole number from 1 to %d (default %d)", max, def)
		}
		return strconv.Itoa(min(n, max)), nil
	}
}

func (a args) int(k string, def int) int {
	if n, err := strconv.Atoi(a[k]); err == nil {
		return n
	}
	return def
}

func reArg(re *regexp.Regexp, what string) func(*Diagnostics, string) (string, error) {
	return func(_ *Diagnostics, v string) (string, error) {
		if !re.MatchString(v) || strings.HasPrefix(v, "-") {
			return "", fmt.Errorf("%q is not %s", v, what)
		}
		return v, nil
	}
}

func parseBool(_ *Diagnostics, v string) (string, error) {
	switch strings.ToLower(v) {
	case "true", "1", "yes", "on":
		return "true", nil
	case "false", "0", "no", "off":
		return "", nil
	}
	return "", errors.New("true or false")
}

func parseContainer(d *Diagnostics, v string) (string, error) {
	return reArg(containerRe, "a container name or id")(d, strings.TrimPrefix(v, "/"))
}

// parseDevice resolves a disk name under /dev or /dev/disk/by-id to the
// block device it names. Only a bare name or /dev/<name>,
// /dev/disk/by-id/<name> is accepted, and the result must be a block
// device under /dev (NVMe controllers, /dev/nvmeN, are character devices).
func parseDevice(d *Diagnostics, v string) (string, error) {
	name := v
	for _, p := range []string{"/dev/disk/by-id/", "/dev/"} {
		if strings.HasPrefix(name, p) {
			name = name[len(p):]
			break
		}
	}
	if !deviceRe.MatchString(name) || strings.Contains(name, "..") {
		return "", fmt.Errorf("%q is not a disk name (sda, nvme0n1, or a /dev/disk/by-id name)", v)
	}
	devRoot := d.path("/dev")
	for _, cand := range []string{filepath.Join(devRoot, name), filepath.Join(devRoot, "disk", "by-id", name)} {
		real, err := filepath.EvalSymlinks(cand)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(devRoot, real)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || strings.Contains(rel, "/") {
			return "", fmt.Errorf("%q does not name a disk under /dev", v)
		}
		st, err := os.Stat(real)
		if err != nil {
			continue
		}
		block := st.Mode()&os.ModeDevice != 0 && st.Mode()&os.ModeCharDevice == 0
		nvmeCtrl := st.Mode()&os.ModeCharDevice != 0 && nvmeCtrlRe.MatchString(rel)
		if !block && !nvmeCtrl {
			return "", fmt.Errorf("/dev/%s is not a block device", rel)
		}
		return "/dev/" + rel, nil
	}
	return "", fmt.Errorf("no disk %q on this host", v)
}

// ---- availability -------------------------------------------------------------------

func needInit(d *Diagnostics) string {
	switch {
	case d.initSystem == services.Systemd && d.has("systemctl"):
		return ""
	case d.initSystem == services.OpenRC && d.has("rc-status") && d.has("rc-service"):
		return ""
	}
	return "the agent reads services from systemd or OpenRC only"
}

func needLogs(d *Diagnostics) string {
	if d.journald() || d.syslogFile() != "" {
		return ""
	}
	return "this host has neither journald nor /var/log/syslog or /var/log/messages"
}

// mdArrays returns the Linux md arrays of /proc/mdstat (none on Unraid,
// whose md driver has its own format).
func (d *Diagnostics) mdArrays() []string {
	b, err := d.readFile("/proc/mdstat")
	if err != nil || isUnraidMdstat(b) {
		return nil
	}
	var out []string
	for _, m := range mdNameRe.FindAllSubmatch(b, -1) {
		out = append(out, string(m[1]))
	}
	return out
}

func isUnraidMdstat(b []byte) bool {
	return bytes.Contains(b, []byte("mdState=")) || bytes.HasPrefix(b, []byte("sbName="))
}

func needMD(d *Diagnostics) string {
	if len(d.mdArrays()) == 0 {
		return "no Linux md arrays (/proc/mdstat)"
	}
	return ""
}

func needUnraid(d *Diagnostics) string {
	if d.isUnraid() || d.exists("/var/local/emhttp/var.ini") {
		return ""
	}
	return "this host does not run Unraid"
}

func needPkgManager(d *Diagnostics) string {
	if d.pkgManager() == "" {
		return "no supported package manager"
	}
	return ""
}

// ---- checks -----------------------------------------------------------------------------

// dfStep lists the real file systems (Unraid: with its tmpfs /var/log,
// which fills up in practice).
func dfStep(d *Diagnostics) step {
	argv := []string{"df", "-hT"}
	ex := []string{"devtmpfs", "squashfs", "overlay", "efivarfs", "fuse.lxcfs"}
	if !d.isUnraid() {
		ex = append([]string{"tmpfs"}, ex...)
	}
	for _, t := range ex {
		argv = append(argv, "-x", t)
	}
	return cmdStep(argv...)
}

func planSystem(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	steps := []step{cmdStep("uname", "-a"), cmdStep("uptime"), fileStep("/etc/os-release")}
	if d.isUnraid() {
		steps = append(steps, fileStep("/etc/unraid-version"))
	}
	steps = append(steps, cmdStep("free", "-m"), dfStep(d))
	if d.journald() {
		s := cmdStep("journalctl", "--list-boots", "--no-pager")
		s.title += " | tail -n 10"
		s.tailLines = 10
		steps = append(steps, s)
	} else {
		steps = append(steps, cmdStep("who", "-b"))
	}
	return steps, nil
}

func planProcesses(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	byMem := a["sort"] == "mem" || a["sort"] == "memory"
	limit := a.int("limit", 40)
	title := "top processes by CPU over 1 s (from /proc)"
	if byMem {
		title = "top processes by memory (from /proc)"
	}
	return []step{{title: title, fn: func(ctx context.Context) (string, error) {
		n := limit
		if byMem {
			// The view orders by CPU, then memory: idle processes come
			// largest first, so the top by memory are in its first rows.
			n = inspect.MaxProcesses
		}
		v, err := d.inspectView(ctx, proto.InspectProcesses, n)
		if err != nil {
			return "", err
		}
		rows := v.Processes
		if byMem {
			sort.SliceStable(rows, func(i, j int) bool { return rows[i].RSSBytes > rows[j].RSSBytes })
		}
		if len(rows) > limit {
			rows = rows[:limit]
		}
		return processTable(rows, d.now()), nil
	}}}, nil
}

func planPorts(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	if d.has("ss") {
		return []step{cmdStep("ss", "-tulpn")}, nil
	}
	return []step{{title: "listening sockets (from /proc/net)", fn: func(ctx context.Context) (string, error) {
		v, err := d.inspectView(ctx, proto.InspectPorts, 0)
		if err != nil {
			return "", err
		}
		return portTable(v.Ports, v.Truncated), nil
	}}}, nil
}

func planServices(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	state := a["state"]
	if state == "" {
		state = "failed"
	}
	if d.initSystem == services.OpenRC {
		if state == "failed" {
			return []step{cmdStep("rc-status", "--crashed", "--nocolor")}, nil
		}
		return []step{cmdStep("rc-status", "--all", "--nocolor")}, nil
	}
	switch state {
	case "failed":
		return []step{cmdStep("systemctl", "list-units", "--state=failed", "--all", "--no-pager")}, nil
	case "running":
		return []step{cmdStep("systemctl", "list-units", "--type=service", "--state=running", "--no-pager")}, nil
	}
	return []step{cmdStep("systemctl", "list-units", "--type=service", "--all", "--no-pager")}, nil
}

// statusOK: systemctl status / rc-service status exit 1 to 3 for units
// that are not running, which is an answer, not a failure.
func statusOK(exit int, _ []byte) bool { return exit >= 0 && exit <= 3 }

func planService(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	name := a["name"]
	if d.initSystem == services.OpenRC {
		st := cmdStep("rc-service", name, "status")
		st.ok = statusOK
		return []step{st, d.syslogStep(logQuery{unit: name, lines: 50})}, nil
	}
	st := cmdStep("systemctl", "status", "--no-pager", "--full", "--lines=0", name)
	st.ok = statusOK
	return []step{st, journalStep(logQuery{unit: name, lines: 50})}, nil
}

func planDisks(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	return []step{
		cmdStep("lsblk", "-e", "1,7", "-o", "NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,MODEL,SERIAL,TRAN,STATE,ROTA"),
		dfStep(d),
	}, nil
}

func planSmart(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	s := cmdStep("smartctl", "-x", "-n", "standby", a["device"])
	// smartctl's exit status is a bit mask: 1 and 2 mean it could not
	// read the device; the others report the disk's health, which the
	// output shows. A disk in standby (exit 2) is left asleep.
	s.ok = func(exit int, out []byte) bool {
		return exit >= 0 && exit&3 == 0 || exit == 2 && bytes.Contains(bytes.ToUpper(out), []byte("STANDBY"))
	}
	return []step{s}, nil
}

func planRaid(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	steps := []step{fileStep("/proc/mdstat")}
	if d.has("mdadm") {
		for _, md := range d.mdArrays() {
			steps = append(steps, cmdStep("mdadm", "--detail", "/dev/"+md))
		}
	}
	return steps, nil
}

// unraidSyslogRe picks the array and disk lines of Unraid's syslog.
var unraidSyslogRe = regexp.MustCompile(`(?i)\bmd[0-9a-z]*:|\bmdcmd\b|emhttpd|\bdisk[0-9]*\b|\bsd[a-z]{1,2}[0-9]*\b|\bnvme[0-9]|\bata[0-9]+|i/o error|parity|unraid`)

func planUnraid(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	steps := []step{fileStep("/proc/mdstat")}
	for _, f := range []string{"/var/local/emhttp/var.ini", "/var/local/emhttp/disks.ini"} {
		s := fileStep(f)
		s.redact = true
		steps = append(steps, s)
	}
	if f := d.syslogFile(); f != "" {
		steps = append(steps, step{
			title: fmt.Sprintf("grep -Ei %s %s | tail -n 100", shellQuote(unraidSyslogRe.String()[4:]), f),
			fn: func(ctx context.Context) (string, error) {
				lines, _, err := d.readSyslog(f, func(l string) bool { return unraidSyslogRe.MatchString(l) }, 100)
				return strings.Join(lines, "\n"), err
			},
		})
	}
	return steps, nil
}

func planZFS(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	status := []string{"zpool", "status", "-v"}
	list := []string{"zpool", "list", "-v"}
	ds := []string{"zfs", "list", "-o", "name,used,avail,refer,mountpoint"}
	if p := a["pool"]; p != "" {
		status, list, ds = append(status, p), append(list, p), append(ds, "-r", p)
	}
	return []step{cmdStep(status...), cmdStep(list...), cmdStep(ds...)}, nil
}

func planNetwork(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	steps := []step{
		cmdStep("ip", "-br", "addr"),
		cmdStep("ip", "route"),
		cmdStep("ip", "-6", "route"),
		cmdStep("ip", "-s", "link"),
		fileStep("/etc/resolv.conf"),
	}
	bonds, _ := filepath.Glob(d.path("/proc/net/bonding/*"))
	for _, b := range bonds {
		steps = append(steps, fileStep("/proc/net/bonding/"+filepath.Base(b)))
	}
	return steps, nil
}

func planSensors(context.Context, *Diagnostics, args) ([]step, error) {
	return []step{cmdStep("sensors")}, nil
}

const dockerPS = `table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}`

func planDocker(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	name := a["container"]
	if name == "" {
		return []step{cmdStep("docker", "ps", "-a", "--format", dockerPS)}, nil
	}
	argv := []string{"docker", "container", "inspect", name}
	return []step{{title: quoteArgv(argv) + " (without Config.Env)", fn: func(ctx context.Context) (string, error) {
		out, err := d.output(ctx, argv)
		if err != nil {
			return out, err
		}
		return dockerInspect([]byte(out))
	}}}, nil
}

func planDockerLogs(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	argv := []string{"docker", "logs", "--timestamps", "--tail", strconv.Itoa(a.int("lines", 200))}
	if a.has("since") {
		argv = append(argv, "--since", a["since"])
	}
	return []step{cmdStep(append(argv, a["container"])...)}, nil
}

func planIncus(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	// --force-local: the local daemon only, and no client configuration
	// (which the sandbox's read-only, empty /root could not hold).
	inst := a["instance"]
	if inst == "" {
		return []step{cmdStep("incus", "--force-local", "list", "--all-projects")}, nil
	}
	argv := []string{"incus", "--force-local", "info", "--show-log"}
	if p, n, ok := strings.Cut(inst, "/"); ok {
		argv = append(argv, "--project", p)
		inst = n
	}
	return []step{cmdStep(append(argv, inst)...)}, nil
}

func planLibvirt(_ context.Context, _ *Diagnostics, a args) ([]step, error) {
	virsh := []string{"virsh", "-r", "-c", "qemu:///system"} // a read-only connection
	dom := a["domain"]
	if dom == "" {
		return []step{cmdStep(append(virsh, "list", "--all")...)}, nil
	}
	var steps []step
	for _, sub := range [][]string{{"dominfo"}, {"domblklist", "--details"}, {"domiflist"}} {
		argv := append(append(append([]string{}, virsh...), sub...), "--domain", dom)
		steps = append(steps, cmdStep(argv...))
	}
	return steps, nil
}

func planPVE(_ context.Context, d *Diagnostics, a args) ([]step, error) {
	id := a["guest"]
	if id == "" {
		pvesm := cmdStep("pvesm", "status")
		ha := cmdStep("ha-manager", "status")
		// Like the broker's: outside the agent's sandbox (pvesm activates
		// storages; ProtectSystem=strict keeps their directories read-only).
		pvesm.outside, ha.outside = true, true
		return []step{
			cmdStep("pveversion"), cmdStep("pvecm", "status"), pvesm, ha,
			cmdStep("qm", "list"), cmdStep("pct", "list"),
		}, nil
	}
	tool := ""
	switch {
	case d.exists("/etc/pve/local/qemu-server/" + id + ".conf"):
		tool = "qm"
	case d.exists("/etc/pve/local/lxc/" + id + ".conf"):
		tool = "pct"
	default:
		for _, kind := range []string{"qemu-server", "lxc"} {
			if m, _ := filepath.Glob(d.path("/etc/pve/nodes/*/" + kind + "/" + id + ".conf")); len(m) > 0 {
				node := filepath.Base(filepath.Dir(filepath.Dir(m[0])))
				return nil, invalidf("guest %s is on node %s; ask that node's agent", id, node)
			}
		}
		return nil, invalidf("no guest %s on this node", id)
	}
	cfg := cmdStep(tool, "config", id)
	cfg.redact = true
	return []step{cfg, cmdStep(tool, "status", id, "--verbose")}, nil
}

func planUPS(ctx context.Context, d *Diagnostics, _ args) ([]step, error) {
	var steps []step
	if d.has("upsc") {
		list := []string{"upsc", "-l"}
		out, err := d.output(ctx, list)
		steps = append(steps, step{title: quoteArgv(list), fn: func(context.Context) (string, error) { return out, err }})
		if err == nil {
			for _, name := range strings.Fields(out) {
				if upsNameRe.MatchString(name) {
					steps = append(steps, cmdStep("upsc", name))
				}
			}
		}
	}
	if d.has("apcaccess") {
		steps = append(steps, cmdStep("apcaccess", "status"))
	}
	return steps, nil
}

// pkgCommands names the package manager queries of package pkgs.
var pkgCommands = map[string]string{
	"apt":    "apt-get -s dist-upgrade",
	"dnf":    "dnf check-update",
	"yum":    "yum check-update",
	"zypper": "zypper list-updates",
	"apk":    "apk version -l '<'",
	"pacman": "pacman -Qu",
}

func planUpdates(_ context.Context, d *Diagnostics, _ args) ([]step, error) {
	m := d.pkgManager()
	title := pkgCommands[m]
	if title == "" {
		title = m + " (pending updates)"
	}
	return []step{{title: title + " (cached package lists)", fn: func(ctx context.Context) (string, error) {
		v, err := d.inspectView(ctx, proto.InspectUpdates, 0)
		if err != nil {
			return "", err
		}
		return updateTable(v.Updates, m), nil
	}}}, nil
}

// output runs a command whose output the agent reads (stdout, LC_ALL=C).
// A non-zero exit is an error; the output then includes stderr.
func (d *Diagnostics) output(ctx context.Context, argv []string) (string, error) {
	path, err := d.lookPath(argv[0])
	if err != nil {
		return "", err
	}
	r := d.run(ctx, runSpec{argv: append([]string{path}, argv[1:]...), env: d.cmdEnv(true), stdout: true})
	if r.err == nil && r.exit != 0 {
		r.err = fmt.Errorf("exit status %d", r.exit)
	}
	if r.err != nil {
		return string(r.out) + string(r.stderr), r.err
	}
	return string(r.out), nil
}
