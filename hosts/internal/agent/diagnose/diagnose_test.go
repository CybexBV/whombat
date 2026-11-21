package diagnose

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// fakeRunner answers commands by their command line ("smartctl -x -n
// standby /dev/sda", argv[0] by its base name) and records them.
type fakeRunner struct {
	mu    sync.Mutex
	calls []string
	specs []runSpec
	out   map[string]runResult
	// prefix answers command lines starting with a key not in out.
	prefix map[string]runResult
}

func (f *fakeRunner) run(_ context.Context, s runSpec) runResult {
	key := strings.Join(append([]string{filepath.Base(s.argv[0])}, s.argv[1:]...), " ")
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, key)
	f.specs = append(f.specs, s)
	if r, ok := f.out[key]; ok {
		return r
	}
	for p, r := range f.prefix {
		if strings.HasPrefix(key, p) {
			return r
		}
	}
	return runResult{out: []byte("output of " + key + "\n")}
}

func (f *fakeRunner) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

var testNow = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

// testDiag returns diagnostics on root (a directory standing for /) with
// the given tools installed.
func testDiag(t *testing.T, root string, tools ...string) (*Diagnostics, *fakeRunner) {
	t.Helper()
	f := &fakeRunner{out: map[string]runResult{}, prefix: map[string]runResult{}}
	d := &Diagnostics{
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		run: f.run,
		lookPath: func(name string) (string, error) {
			if slices.Contains(tools, name) {
				return "/usr/bin/" + name, nil
			}
			return "", fmt.Errorf("%s is not installed", name)
		},
		root:       root,
		initSystem: services.SysV,
		pkgManager: func() string { return "" },
		now:        func() time.Time { return testNow },
		shell:      "/bin/sh",
	}
	return d, f
}

func touch(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func catalogNames(d *Diagnostics) []string {
	var names []string
	for _, c := range d.Catalog() {
		names = append(names, c.Name)
	}
	return names
}

func TestCatalogFollowsTheHost(t *testing.T) {
	root := t.TempDir()
	d, _ := testDiag(t, root)
	if got := catalogNames(d); !slices.Equal(got, []string{"system", "processes", "ports"}) {
		t.Fatalf("bare host: %v", got)
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "smart", Args: map[string]string{"device": "sda"}}); r.Code != CodeUnsupported || !strings.Contains(r.Message, "smartctl is not installed") {
		t.Fatalf("smart without smartctl: %+v", r)
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "rm"}); r.Code != CodeUnsupported || !strings.Contains(r.Message, "unknown check") {
		t.Fatalf("unknown check: %+v", r)
	}

	// A Docker CLI is not enough without a daemon.
	d, _ = testDiag(t, root, "lsblk", "smartctl", "zpool", "ip", "sensors", "docker", "incus", "virsh",
		"pveversion", "upsc", "systemctl", "journalctl")
	if got := catalogNames(d); slices.Contains(got, "docker") || slices.Contains(got, "incus") || slices.Contains(got, "libvirt") {
		t.Fatalf("CLIs without their daemons: %v", got)
	}
	touch(t, root, "/run/docker.sock", "/var/lib/incus/unix.socket", "/run/libvirt/virtqemud-sock-ro", "/var/log/syslog")
	d.initSystem = services.Systemd
	d.pkgManager = func() string { return "apt" }
	want := []string{"system", "processes", "ports", "services", "service", "logs", "disks", "smart", "zfs", "network",
		"sensors", "docker", "docker_logs", "incus", "libvirt", "pve", "ups", "updates"}
	if got := catalogNames(d); !slices.Equal(got, want) {
		t.Fatalf("full host:\n got %v\nwant %v", got, want)
	}
	for _, c := range d.Catalog() {
		if c.Description == "" {
			t.Errorf("%s has no description", c.Name)
		}
		if c.Name == "smart" && (len(c.Args) != 1 || !c.Args[0].Required) {
			t.Errorf("smart args: %+v", c.Args)
		}
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: proto.DiagnoseList}); len(r.Checks) != len(want) || r.Code != "" {
		t.Fatalf("list: %+v", r)
	}

	// Linux md arrays and Unraid's array.
	d, _ = testDiag(t, "testdata/linux")
	if got := catalogNames(d); !slices.Contains(got, "raid") || slices.Contains(got, "unraid") {
		t.Fatalf("md host: %v", got)
	}
	d, _ = testDiag(t, "testdata/unraid")
	d.initSystem = services.Unraid
	if got := catalogNames(d); slices.Contains(got, "raid") || !slices.Contains(got, "unraid") || !slices.Contains(got, "logs") || slices.Contains(got, "services") {
		t.Fatalf("Unraid: %v", got)
	}
}

func TestArgumentValidation(t *testing.T) {
	root := t.TempDir()
	touch(t, root, "/run/docker.sock", "/var/lib/incus/unix.socket", "/run/libvirt/libvirt-sock", "/dev/notadisk")
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "dev", "evil")); err != nil {
		t.Fatal(err)
	}
	d, f := testDiag(t, root, "systemctl", "journalctl", "smartctl", "docker", "zpool", "pveversion", "incus", "virsh")
	d.initSystem = services.Systemd
	long := strings.Repeat("a", 201)
	for _, tc := range []struct {
		check string
		args  map[string]string
		msg   string
	}{
		{"service", nil, `needs the argument "name"`},
		{"service", map[string]string{"name": "../../etc/passwd"}, "not a unit name"},
		{"service", map[string]string{"name": "-H"}, "not a unit name"},
		{"service", map[string]string{"name": "ssh;reboot"}, "not a unit name"},
		{"service", map[string]string{"name": "ssh", "lines": "5"}, `has no argument "lines"`},
		{"logs", map[string]string{"unit": "a b"}, "not a unit name"},
		{"logs", map[string]string{"lines": "many"}, "whole number"},
		{"logs", map[string]string{"lines": "0"}, "whole number"},
		{"logs", map[string]string{"since": "$(reboot)"}, "duration"},
		{"logs", map[string]string{"since": "last tuesday"}, "duration"},
		{"logs", map[string]string{"grep": long}, "200 characters"},
		{"logs", map[string]string{"grep": "a\x00b"}, "control characters"},
		{"logs", map[string]string{"priority": "loud"}, "emerg"},
		{"logs", map[string]string{"kernel": "maybe"}, "true or false"},
		{"logs", map[string]string{"kernel": "true", "unit": "ssh"}, "exclude"},
		{"logs", map[string]string{"path": "/etc/shadow"}, `has no argument "path"`},
		{"smart", nil, `needs the argument "device"`},
		{"smart", map[string]string{"device": "../etc/passwd"}, "not a disk name"},
		{"smart", map[string]string{"device": "/dev/../etc/passwd"}, "not a disk name"},
		{"smart", map[string]string{"device": "sda/../../x"}, "not a disk name"},
		{"smart", map[string]string{"device": "notadisk"}, "not a block device"},
		{"smart", map[string]string{"device": "evil"}, "does not name a disk"},
		{"smart", map[string]string{"device": "sdz"}, "no disk"},
		{"docker", map[string]string{"container": "a b"}, "not a container"},
		{"docker_logs", map[string]string{"lines": "10"}, `needs the argument "container"`},
		{"zfs", map[string]string{"pool": "tank;ls"}, "not a pool name"},
		{"pve", map[string]string{"guest": "10a"}, "not a VMID"},
		{"pve", map[string]string{"guest": "101"}, "no guest 101"},
		{"incus", map[string]string{"instance": "a/b/c"}, "not an instance name"},
		{"libvirt", map[string]string{"domain": "--all"}, "not a domain name"},
		{proto.DiagnoseList, map[string]string{"x": "y"}, "no arguments"},
	} {
		r := d.Run(context.Background(), proto.DiagnoseRequest{Check: tc.check, Args: tc.args})
		if r.Code != CodeInvalid || !strings.Contains(r.Message, tc.msg) {
			t.Errorf("%s %v: %+v (want %q)", tc.check, tc.args, r, tc.msg)
		}
	}
	if n := len(f.called()); n != 0 {
		t.Fatalf("refused requests ran %d commands: %v", n, f.called())
	}

	// Accepted values arrive normalized, as single arguments.
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: map[string]string{
		"unit": "systemd-fsck@dev-disk-by\\x2duuid-1.service", "lines": "99999", "since": "2h",
		"grep": "-x; reboot (err|fail)", "priority": "Error", "kernel": "false"}})
	if r.Code != "" {
		t.Fatalf("logs: %+v", r)
	}
	want := "journalctl --no-pager --no-hostname -o short-iso -n 2000 --unit=systemd-fsck@dev-disk-by\\x2duuid-1.service " +
		"--since=2026-10-17 10:00:00 UTC --grep=-x; reboot (err|fail) --priority=err"
	if got := f.called(); len(got) != 1 || got[0] != want {
		t.Fatalf("journalctl argv:\n got %q\nwant %q", got, want)
	}
	if got := f.specs[0].argv; len(got) != 11 || got[9] != "--grep=-x; reboot (err|fail)" {
		t.Fatalf("grep is not one argument: %q", got)
	}
	if r.Commands[0] != `journalctl --no-pager --no-hostname -o short-iso -n 2000 '--unit=systemd-fsck@dev-disk-by\x2duuid-1.service' '--since=2026-10-17 10:00:00 UTC' '--grep=-x; reboot (err|fail)' --priority=err` {
		t.Fatalf("commands %q", r.Commands)
	}
	f.out["docker container inspect web"] = runResult{out: []byte("[]\n")}
	r = d.Run(context.Background(), proto.DiagnoseRequest{Check: "docker", Args: map[string]string{"container": "/web"}})
	if r.Code != "" || r.Commands[0] != "docker container inspect web (without Config.Env)" {
		t.Fatalf("docker /web: %+v", r)
	}
}

func TestDeviceResolution(t *testing.T) {
	d, _ := testDiag(t, "")
	dev, err := firstBlockDevice()
	if err != nil {
		t.Skip(err)
	}
	for _, in := range []string{dev, "/dev/" + dev} {
		if got, err := parseDevice(d, in); err != nil || got != "/dev/"+dev {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	ids, _ := os.ReadDir("/dev/disk/by-id")
	for _, e := range ids {
		target, err := filepath.EvalSymlinks("/dev/disk/by-id/" + e.Name())
		if err != nil {
			continue
		}
		if got, err := parseDevice(d, e.Name()); err != nil || got != target {
			t.Errorf("by-id %s: %q %v (want %s)", e.Name(), got, err, target)
		}
		if got, err := parseDevice(d, "/dev/disk/by-id/"+e.Name()); err != nil || got != target {
			t.Errorf("by-id path %s: %q %v", e.Name(), got, err)
		}
		break
	}
	if _, err := parseDevice(d, "null"); err == nil {
		t.Error("/dev/null accepted as a disk")
	}
}

func TestSmartExitStatus(t *testing.T) {
	root := t.TempDir()
	d, f := testDiag(t, root, "smartctl")
	d.root = "" // real /dev for the device
	dev, err := firstBlockDevice()
	if err != nil {
		t.Skip(err)
	}
	cmd := "smartctl -x -n standby /dev/" + dev
	run := func(r runResult) proto.DiagnoseResponse {
		f.out[cmd] = r
		return d.Run(context.Background(), proto.DiagnoseRequest{Check: "smart", Args: map[string]string{"device": dev}})
	}
	if r := run(runResult{out: []byte("SMART overall-health: FAILED\n"), exit: 8}); r.Code != "" || !strings.Contains(r.Output, "FAILED") {
		t.Fatalf("failing disk (exit 8) is an answer: %+v", r)
	}
	if r := run(runResult{out: []byte("Device is in STANDBY mode, exit(2)\n"), exit: 2}); r.Code != "" {
		t.Fatalf("standby: %+v", r)
	}
	if r := run(runResult{out: []byte("Smartctl open device: /dev/x failed: Permission denied\n"), exit: 2}); r.Code != CodeFailed ||
		!strings.Contains(r.Message, "Permission denied") || !strings.Contains(r.Output, "Permission denied") {
		t.Fatalf("open failure: %+v", r)
	}
	if r := run(runResult{exit: -1, err: errTimedOut}); r.Code != CodeTimeout {
		t.Fatalf("timeout: %+v", r)
	}
}

// firstBlockDevice returns a block device node in /dev (not a symlink such
// as /dev/cdrom, which resolves to its target).
func firstBlockDevice() (string, error) {
	entries, _ := os.ReadDir("/dev")
	for _, e := range entries {
		if e.Type()&os.ModeSymlink != 0 {
			continue
		}
		if st, err := os.Stat("/dev/" + e.Name()); err == nil && st.Mode()&os.ModeDevice != 0 && st.Mode()&os.ModeCharDevice == 0 {
			return e.Name(), nil
		}
	}
	return "", fmt.Errorf("no block device in /dev")
}

func TestMultiCommandCheck(t *testing.T) {
	d, f := testDiag(t, t.TempDir(), "uname", "uptime", "free", "df", "who")
	f.out["free -m"] = runResult{out: []byte("free: cannot open /proc/meminfo\n"), exit: 1}
	f.out["who -b"] = runResult{err: errTimedOut, exit: -1}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "system"})
	if r.Code != "" {
		t.Fatalf("one failing command failed the check: %+v", r)
	}
	for _, want := range []string{
		"$ uname -a\noutput of uname -a\n\n",
		"$ cat /etc/os-release\n[open ",
		"$ free -m\nfree: cannot open /proc/meminfo\n[exit status 1]\n",
		"$ df -hT -x tmpfs -x devtmpfs",
		"$ who -b\n[did not finish within 30 s]",
	} {
		if !strings.Contains(r.Output, want) {
			t.Errorf("output lacks %q:\n%s", want, r.Output)
		}
	}
	if len(r.Commands) != 6 || r.Commands[2] != "cat /etc/os-release" {
		t.Fatalf("commands %q", r.Commands)
	}
	// Every command failing fails the check.
	for _, k := range []string{"uname -a", "uptime", "df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x fuse.lxcfs"} {
		f.out[k] = runResult{exit: 1}
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "system"}); r.Code != CodeFailed {
		t.Fatalf("all failing: %+v", r)
	}
}

func TestRaidCheck(t *testing.T) {
	d, f := testDiag(t, "testdata/linux", "mdadm")
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "raid"})
	if r.Code != "" || !strings.Contains(r.Output, "$ cat /proc/mdstat\nPersonalities") {
		t.Fatalf("raid: %+v", r)
	}
	want := []string{"mdadm --detail /dev/md127", "mdadm --detail /dev/md1", "mdadm --detail /dev/md2",
		"mdadm --detail /dev/md3", "mdadm --detail /dev/md4", "mdadm --detail /dev/md5"}
	if got := f.called(); !slices.Equal(got, want) {
		t.Fatalf("commands %q", got)
	}
}

func TestUnraidCheck(t *testing.T) {
	d, _ := testDiag(t, "testdata/unraid")
	d.initSystem = services.Unraid
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "unraid"})
	if r.Code != "" {
		t.Fatalf("unraid: %+v", r)
	}
	for _, want := range []string{
		"$ cat /proc/mdstat\nsbName=/boot/config/super.dat", "rdevStatus.2=DISK_INVALID",
		`csrf_token="<redacted>"`, `NAME="BlackBox"`, `luksPassphrase="<redacted>"`, `status="DISK_INVALID"`,
		"blk_update_request: I/O error, dev sdd", "md: disk2 read error", "emhttpd: read SMART /dev/sdd", "mdcmd (36): check",
	} {
		if !strings.Contains(r.Output, want) {
			t.Errorf("output lacks %q", want)
		}
	}
	for _, leak := range []string{"7C2E9B1A44D0F3E6", "hunter2", "sshd", "nginx", "crond"} {
		if strings.Contains(r.Output, leak) {
			t.Errorf("output has %q:\n%s", leak, r.Output)
		}
	}
	if len(r.Commands) != 4 || r.Commands[1] != "cat /var/local/emhttp/var.ini" || !strings.HasSuffix(r.Commands[3], "/var/log/syslog | tail -n 100") {
		t.Fatalf("commands %q", r.Commands)
	}
}

func TestPVEGuest(t *testing.T) {
	root := t.TempDir()
	touch(t, root, "/etc/pve/local/qemu-server/101.conf", "/etc/pve/nodes/pve-02/lxc/202.conf")
	d, f := testDiag(t, root, "pveversion", "qm", "pct", "pvesm", "ha-manager", "pvecm")
	cfg, err := os.ReadFile("testdata/qm_config.txt")
	if err != nil {
		t.Fatal(err)
	}
	f.out["qm config 101"] = runResult{out: cfg}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "pve", Args: map[string]string{"guest": "101"}})
	if r.Code != "" || !slices.Equal(r.Commands, []string{"qm config 101", "qm status 101 --verbose"}) {
		t.Fatalf("pve 101: %+v", r)
	}
	for _, want := range []string{"cipassword: <redacted>", "admin password=<redacted>", "ciuser: admin", "sshkeys: ssh-ed25519"} {
		if !strings.Contains(r.Output, want) {
			t.Errorf("output lacks %q:\n%s", want, r.Output)
		}
	}
	if strings.Contains(r.Output, "Q9w8E7r6") || strings.Contains(r.Output, "SuperSecret1") {
		t.Errorf("secret in the output:\n%s", r.Output)
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "pve", Args: map[string]string{"guest": "202"}}); r.Code != CodeInvalid || !strings.Contains(r.Message, "node pve-02") {
		t.Fatalf("guest on another node: %+v", r)
	}
	// pvesm and ha-manager leave the sandbox under systemd.
	d.sandboxed = true
	f.calls = nil
	d.Run(context.Background(), proto.DiagnoseRequest{Check: "pve"})
	got := f.called()
	if len(got) != 6 || got[0] != "pveversion" || !strings.HasPrefix(got[2], "systemd-run ") || !strings.HasSuffix(got[2], "-- /usr/bin/pvesm status") ||
		!strings.HasSuffix(got[3], "-- /usr/bin/ha-manager status") || got[4] != "qm list" {
		t.Fatalf("pve commands %q", got)
	}
}

func TestDockerInspectWithoutEnv(t *testing.T) {
	root := t.TempDir()
	touch(t, root, "/var/run/docker.sock")
	d, f := testDiag(t, root, "docker")
	b, err := os.ReadFile("testdata/docker_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	f.out["docker container inspect db"] = runResult{out: b}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "docker", Args: map[string]string{"container": "db"}})
	if r.Code != "" {
		t.Fatalf("docker db: %+v", r)
	}
	for _, leak := range []string{"hunter2", "POSTGRES_PASSWORD", "PGDATA", "Europe/Amsterdam", `"Env"`} {
		if strings.Contains(r.Output, leak) {
			t.Errorf("output has %q:\n%s", leak, r.Output)
		}
	}
	for _, want := range []string{`"com.example.db.password": "<redacted>"`, `"--password",`, `"--db-token=<redacted>"`,
		`"--listen=0.0.0.0"`, `"s3://backup:<redacted>@minio:9000/backups"`, `"Hostname": "db"`, `"ssl=off"`} {
		if !strings.Contains(r.Output, want) {
			t.Errorf("output lacks %q:\n%s", want, r.Output)
		}
	}
	f.out["docker container inspect gone"] = runResult{out: []byte("Error: No such container: gone\n"), exit: 1}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "docker", Args: map[string]string{"container": "gone"}}); r.Code != CodeFailed || !strings.Contains(r.Output, "No such container") {
		t.Fatalf("missing container: %+v", r)
	}
	r = d.Run(context.Background(), proto.DiagnoseRequest{Check: "docker_logs", Args: map[string]string{"container": "db", "since": "2026-10-17 11:30"}})
	if got := f.called(); got[len(got)-1] != "docker logs --timestamps --tail 200 --since 2026-10-17T11:30:00Z db" {
		t.Fatalf("docker logs: %q", got)
	}
}

func TestProcessesView(t *testing.T) {
	d, _ := testDiag(t, t.TempDir())
	var asked []proto.InspectRequest
	d.Inspect = func(_ context.Context, req proto.InspectRequest) proto.InspectResponse {
		asked = append(asked, req)
		return proto.InspectResponse{Processes: []proto.Process{
			{PID: 10, User: "root", Name: "busy", Command: "busy --token abc123 --level=2", CPUPct: 97.5, RSSBytes: 10 << 20, State: "R", Threads: 1, Started: testNow.Add(-90 * time.Minute)},
			{PID: 20, User: "mysql", Name: "mysqld", Command: "mysqld --password=s3cr3t", CPUPct: 1, RSSBytes: 900 << 20, State: "S", Threads: 30, Container: "docker:db"},
		}}
	}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "processes", Args: map[string]string{"sort": "mem", "limit": "500"}})
	if r.Code != "" || len(asked) != 1 || asked[0].Platform != proto.PlatformHost || asked[0].GuestID != "host" || asked[0].Limit != 500 {
		t.Fatalf("processes: %+v %+v", r, asked)
	}
	lines := strings.Split(strings.TrimSpace(r.Output), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "PID") || !strings.HasPrefix(lines[1], "20 ") || !strings.Contains(lines[2], "1h30m") {
		t.Fatalf("table:\n%s", r.Output)
	}
	if strings.Contains(r.Output, "abc123") || strings.Contains(r.Output, "s3cr3t") || !strings.Contains(r.Output, "--level=2") || !strings.Contains(r.Output, "docker:db") {
		t.Fatalf("command lines:\n%s", r.Output)
	}
}

func TestOutputLimits(t *testing.T) {
	var b strings.Builder
	for i := 0; b.Len() < 400<<10; i++ {
		fmt.Fprintf(&b, "line %06d of the log\n", i)
	}
	long := b.String()

	s, cut := finish(long, true, false)
	if !cut || len(s) > MaxOutput || !strings.HasSuffix(s, long[strings.LastIndex(long[:len(long)-1], "\n")+1:]) ||
		!strings.HasPrefix(s, "[output cut: only the last 256 KiB are shown]\nline ") {
		t.Fatalf("tail: %d bytes, starts %q, ends %q", len(s), s[:80], s[len(s)-40:])
	}
	s, cut = finish(long, false, false)
	if !cut || len(s) > MaxOutput || !strings.HasPrefix(s, "line 000000 of the log\n") || !strings.HasSuffix(s, "of the log\n[output cut at 256 KiB]\n") {
		t.Fatalf("head: %d bytes, ends %q", len(s), s[len(s)-60:])
	}
	if s, _ := finish("ok \xff\xfe \x1b[31mred\x1b[0m\n", false, false); s != "ok � red\n" {
		t.Fatalf("sanitized %q", s)
	}

	// A long journal keeps its newest lines.
	d, f := testDiag(t, t.TempDir(), "journalctl")
	d.initSystem = services.Systemd
	f.prefix["journalctl "] = runResult{out: []byte(long)}
	r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "logs", Args: map[string]string{"lines": "2000"}})
	if !r.Truncated || !strings.HasSuffix(r.Output, long[len(long)-200:]) || len(r.Output) > MaxOutput {
		t.Fatalf("logs: truncated=%v len=%d", r.Truncated, len(r.Output))
	}
	if !f.specs[0].tail {
		t.Fatal("the journal is not captured from its end")
	}

	c := &capBuffer{max: 10, tail: true}
	for i := 0; i < 10; i++ {
		fmt.Fprintf(c, "%d23456789\n", i)
	}
	if got := string(c.bytes()); got != "923456789\n" || !c.cut {
		t.Fatalf("tail buffer %q", got)
	}
	h := &capBuffer{max: 10}
	h.Write([]byte("0123456789abc"))
	if got := string(h.bytes()); got != "0123456789" || !h.cut {
		t.Fatalf("head buffer %q", got)
	}
}
