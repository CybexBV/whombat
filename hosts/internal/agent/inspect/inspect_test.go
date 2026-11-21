package inspect

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeProc writes a procfs tree with three processes.
func fakeProc(t *testing.T) (root, passwd string) {
	dir := t.TempDir()
	root = filepath.Join(dir, "proc")
	passwd = filepath.Join(dir, "passwd")
	writeFile(t, passwd, "root:x:0:0:root:/root:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n")
	writeFile(t, filepath.Join(root, "stat"), "cpu  1 2 3\nbtime 1760000000\n")
	stat := func(pid int, comm, state string, ppid int, ut, st uint64, threads int, start, rss uint64) string {
		f := []string{state, strconv.Itoa(ppid), "1", "1", "0", "-1", "0", "0", "0", "0", "0",
			strconv.FormatUint(ut, 10), strconv.FormatUint(st, 10), "0", "0", "20", "0", strconv.Itoa(threads), "0",
			strconv.FormatUint(start, 10), "1000", strconv.FormatUint(rss, 10), "0"}
		return strconv.Itoa(pid) + " (" + comm + ") " + strings.Join(f, " ") + "\n"
	}
	// pid 1: init; pid 42: a web worker in a Docker container with a
	// tricky name; pid 2: a kernel thread.
	writeFile(t, filepath.Join(root, "1", "stat"), stat(1, "systemd", "S", 0, 10, 5, 1, 1, 3000))
	writeFile(t, filepath.Join(root, "1", "cmdline"), "/sbin/init\x00splash\x00")
	writeFile(t, filepath.Join(root, "1", "status"), "Name:\tsystemd\nUid:\t0\t0\t0\t0\n")
	writeFile(t, filepath.Join(root, "1", "cgroup"), "0::/init.scope\n")
	writeFile(t, filepath.Join(root, "42", "stat"), stat(42, "php (fpm) x", "R", 1, 100, 50, 4, 500, 9000))
	writeFile(t, filepath.Join(root, "42", "cmdline"), "php-fpm: pool www\x00"+strings.Repeat("a", 600)+"\x00")
	writeFile(t, filepath.Join(root, "42", "status"), "Name:\tphp\nUid:\t33\t33\t33\t33\n")
	writeFile(t, filepath.Join(root, "42", "cgroup"), "0::/system.slice/docker-"+strings.Repeat("ab", 32)+".scope\n")
	writeFile(t, filepath.Join(root, "2", "stat"), stat(2, "kthreadd", "S", 0, 0, 0, 1, 1, 0))
	writeFile(t, filepath.Join(root, "2", "cmdline"), "")
	writeFile(t, filepath.Join(root, "2", "status"), "Name:\tkthreadd\nUid:\t0\t0\t0\t0\n")
	writeFile(t, filepath.Join(root, "2", "cgroup"), "0::/\n")
	return root, passwd
}

func TestProcessesFake(t *testing.T) {
	root, passwd := fakeProc(t)
	rows, trunc, err := Processes(context.Background(), ProcOptions{Root: root, Passwd: passwd, Interval: 10 * time.Millisecond, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !trunc || len(rows) != 2 {
		t.Fatalf("limit: %d rows, truncated %v", len(rows), trunc)
	}
	// All CPU deltas are 0: sorted by RSS.
	p := rows[0]
	if p.PID != 42 || p.Name != "php (fpm) x" || p.User != "www-data" || p.State != "R" || p.PPID != 1 || p.Threads != 4 {
		t.Fatalf("row 0: %+v", p)
	}
	if len(p.Command) != maxCommand || !strings.HasPrefix(p.Command, "php-fpm: pool www aaa") {
		t.Fatalf("command %q (%d)", p.Command, len(p.Command))
	}
	if p.Container != "docker:"+strings.Repeat("ab", 32) {
		t.Fatalf("container %q", p.Container)
	}
	if p.RSSBytes != 9000*uint64(os.Getpagesize()) || !p.Started.Equal(time.Unix(1760000005, 0)) {
		t.Fatalf("rss/start %+v", p)
	}
	if rows[1].PID != 1 || rows[1].Command != "/sbin/init splash" || rows[1].User != "root" || rows[1].Container != "" {
		t.Fatalf("row 1: %+v", rows[1])
	}
	rows, _, _ = Processes(context.Background(), ProcOptions{Root: root, Passwd: passwd, Interval: time.Millisecond,
		Container: func(string) string { return "" }})
	if len(rows) != 3 || rows[2].Command != "[kthreadd]" {
		t.Fatalf("kernel thread: %+v", rows)
	}
}

func TestProcessesLive(t *testing.T) {
	// Real kernel data from a set of processes the test controls: a busy
	// child must outrank an idle one, with the CPU time the kernel gave it.
	// The rest of the machine stays out of the view, so other busy
	// processes cannot push the child off the list.
	busy := exec.Command("/bin/sh", "-c", "while :; do :; done")
	if err := busy.Start(); err != nil {
		t.Skip(err)
	}
	defer func() { busy.Process.Kill(); busy.Wait() }()
	idle := exec.Command("/bin/sh", "-c", "read x")
	idle.Stdin = blockingReader(t)
	if err := idle.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { idle.Process.Kill(); idle.Wait() }()
	root := t.TempDir()
	if err := os.Symlink("/proc/stat", filepath.Join(root, "stat")); err != nil {
		t.Fatal(err)
	}
	for _, pid := range []int{busy.Process.Pid, idle.Process.Pid} {
		if err := os.Symlink(filepath.Join("/proc", strconv.Itoa(pid)), filepath.Join(root, strconv.Itoa(pid))); err != nil {
			t.Fatal(err)
		}
	}

	const interval = 500 * time.Millisecond
	before := liveTicks(t, busy.Process.Pid)
	rows, trunc, err := Processes(context.Background(), ProcOptions{Root: root, Interval: interval, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	ran := liveTicks(t, busy.Process.Pid) - before
	if trunc || len(rows) != 2 {
		t.Fatalf("rows: %+v (truncated %v)", rows, trunc)
	}
	p := rows[0]
	if p.PID != busy.Process.Pid || rows[1].PID != idle.Process.Pid {
		t.Fatalf("busy child %d not first: %+v", busy.Process.Pid, rows)
	}
	if p.Name != "sh" || !strings.Contains(p.Command, "while") || p.User == "" || p.PPID != os.Getpid() || p.State == "" ||
		p.Threads != 1 || p.RSSBytes == 0 || p.Started.IsZero() || time.Since(p.Started) > time.Minute {
		t.Fatalf("busy child: %+v", p)
	}
	// The inspector's window lies inside the test's, so the CPU it reports
	// is more than the idle child's and at most what the kernel counted for
	// the busy one over the test's window (one tick of rounding).
	limit := float64(ran+1) / clockTicks / interval.Seconds() * 100
	if p.CPUPct <= rows[1].CPUPct || p.CPUPct > limit {
		t.Fatalf("CPU: busy %.1f%% (kernel counted %d ticks, at most %.1f%%), idle %.1f%%", p.CPUPct, ran, limit, rows[1].CPUPct)
	}
}

// liveTicks reads a live process's CPU time (utime + stime) from /proc.
func liveTicks(t *testing.T, pid int) uint64 {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		t.Fatal(err)
	}
	s, ok := parseStat(b)
	if !ok {
		t.Fatalf("stat of %d: %q", pid, b)
	}
	return s.ticks
}

// blockingReader is a pipe that never sends anything until the test ends.
func blockingReader(t *testing.T) *os.File {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Close(); r.Close() })
	return r
}

func TestContainerOf(t *testing.T) {
	id := strings.Repeat("0123456789abcdef", 4)
	cases := map[string][2]string{
		"0::/system.slice/docker-" + id + ".scope":                                            {"docker", id},
		"4:memory:/docker/" + id + "\n0::/":                                                   {"docker", id},
		"0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-" + id + ".scope": {"docker", id},
		"0::/lxc.payload.dev-shell/system.slice/sshd.service":                                 {"incus", "dev-shell"},
		"0::/lxc.payload.proj_web/init.scope":                                                 {"incus", "proj_web"},
		"0::/lxc/101/ns/system.slice/cron.service":                                            {"pve", "101"},
		"0::/qemu.slice/100.scope":                                                            {"pve", "100"},
		`0::/machine.slice/machine-qemu\x2d3\x2dwin\x2d11.scope/libvirt/emulator`:             {"libvirt", "win-11"},
		"0::/system.slice/ssh.service":                                                        {"", ""},
		"0::/machine/qemu-1-Windows10.libvirt-qemu/emulator":                                  {"libvirt", "Windows10"},
	}
	for cg, want := range cases {
		p, i := ContainerOf(cg)
		if p != want[0] || i != want[1] {
			t.Errorf("%s: got %s %s", cg, p, i)
		}
	}
}

func TestParseHexAddr(t *testing.T) {
	for in, want := range map[string]string{
		"0100007F:0035":                         "127.0.0.1:53",
		"00000000:1F90":                         "0.0.0.0:8080",
		"00000000000000000000000000000000:0016": ":::22",
		"00000000000000000000000001000000:0277": "::1:631",
		"B80D0120000000000000000001000000:01BB": "2001:db8::1:443",
	} {
		a, p, ok := parseHexAddr(in)
		if !ok || a+":"+strconv.Itoa(p) != want {
			t.Errorf("%s: %s:%d", in, a, p)
		}
	}
}

func TestPortsFake(t *testing.T) {
	root := t.TempDir()
	hdr := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	writeFile(t, filepath.Join(root, "net", "tcp"), hdr+
		"   0: 0100007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1111 1 0000000000000000 100 0 0 10 0\n"+
		"   1: 0100007F:9C40 0100007F:0035 01 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0000000000000000 20 4 30 10 -1\n")
	writeFile(t, filepath.Join(root, "net", "tcp6"), hdr+
		"   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3333 1 0000000000000000 100 0 0 10 0\n")
	writeFile(t, filepath.Join(root, "net", "udp"), hdr+
		"  10: 00000000:0044 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4444 2 0000000000000000 0\n"+
		"  11: 0100007F:A000 0100007F:0035 01 00000000:00000000 00:00000000 00000000     0        0 5555 2 0000000000000000 0\n")
	// pid 7 owns the DNS listener.
	if err := os.MkdirAll(filepath.Join(root, "7", "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.Symlink("socket:[1111]", filepath.Join(root, "7", "fd", "3"))
	os.Symlink("/dev/null", filepath.Join(root, "7", "fd", "0"))
	writeFile(t, filepath.Join(root, "7", "comm"), "dnsmasq\n")

	rows, trunc, err := Ports(context.Background(), PortOptions{Root: root})
	if err != nil || trunc {
		t.Fatal(err, trunc)
	}
	var got []string
	for _, r := range rows {
		got = append(got, r.Proto+" "+net.JoinHostPort(r.Address, strconv.Itoa(r.Port))+" "+strconv.Itoa(r.PID)+" "+r.Process)
	}
	want := "tcp6 [::]:22 0 ,tcp 127.0.0.1:53 7 dnsmasq,udp 0.0.0.0:68 0 "
	if strings.Join(got, ",") != want {
		t.Fatalf("got  %q\nwant %q", strings.Join(got, ","), want)
	}
}

func TestPortsLive(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	rows, _, err := Ports(context.Background(), PortOptions{})
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, r := range rows {
		if (r.Proto == "tcp" && r.Port == ln.Addr().(*net.TCPAddr).Port) || (r.Proto == "udp" && r.Port == pc.LocalAddr().(*net.UDPAddr).Port) {
			if r.PID != os.Getpid() || r.Address != "127.0.0.1" {
				t.Fatalf("own socket: %+v", r)
			}
			found++
		}
	}
	if found != 2 {
		t.Fatalf("own sockets found %d: %+v", found, rows)
	}
}
