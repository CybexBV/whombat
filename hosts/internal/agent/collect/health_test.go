package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestPressure(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"proc/pressure/cpu":    string(readTestdata(t, "psi_cpu")),
		"proc/pressure/memory": string(readTestdata(t, "psi_memory")),
		"proc/pressure/io":     string(readTestdata(t, "psi_io")),
	})
	p := readPressure(fsRoot(dir))
	if p == nil || *p != (proto.Pressure{CPUSome: 1.25, MemorySome: 3.1, MemoryFull: 2.05, IOSome: 12.4, IOFull: 10}) {
		t.Fatalf("pressure: %+v", p)
	}
	if readPressure(fsRoot(t.TempDir())) != nil {
		t.Error("no PSI must give nil")
	}
}

// Steal is not usage: a VM whose hypervisor is busy is not busy itself.
func TestCPUSteal(t *testing.T) {
	prev, _ := parseCPULine([]byte("cpu  1000 0 500 8000 100 0 0 0 0 0\n"))
	// +200 user, +100 system, +500 idle, +0 iowait, +200 steal = 1000.
	cur, _ := parseCPULine([]byte("cpu  1200 0 600 8500 100 0 0 200 0 0\n"))
	c := cpuPercents(prev, cur)
	if c.StealPct != 20 || c.UsagePct != 30 {
		t.Errorf("steal %v usage %v", c.StealPct, c.UsagePct)
	}
}

func TestKernelVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"6.12.111+deb13-amd64", "6.12.107+deb13-amd64", 1},
		{"6.8.12-4-pve", "6.8.12-10-pve", -1},
		{"6.8.0-45-generic", "6.8.0-45-generic", 0},
		{"6.11.4-301.fc41.x86_64", "6.11.10-300.fc41.x86_64", -1},
		{"6.12~rc3", "6.12", -1},
		{"6.17.2-arch1-1", "6.17.10-arch1-1", -1},
	} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compare(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	for v, want := range map[string]string{
		"6.12.111+deb13-amd64": "amd", "6.12.111+deb13-cloud-amd64": "cloud-amd", "6.8.0-45-generic": "generic",
		"6.8.12-4-pve": "pve", "6.17.2-arch1-1": "arch", "6.11.4-301.fc41.x86_64": "",
	} {
		if got := kernelFlavour(v); got != want {
			t.Errorf("flavour(%s) = %q, want %q", v, got, want)
		}
	}
}

func TestRebootRequired(t *testing.T) {
	// A Debian server with a newer kernel and reboot-required from its package.
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"boot/vmlinuz-6.12.107+deb13-amd64":       "",
		"boot/vmlinuz-6.12.111+deb13-amd64":       "",
		"boot/vmlinuz-6.12.115+deb13-cloud-amd64": "", // other flavour: ignored
		"run/reboot-required":                     "",
		"run/reboot-required.pkgs":                "linux-image-6.12.111+deb13-amd64\n",
	})
	r := fsRoot(dir)
	ok, why := rebootRequired(r, "6.12.107+deb13-amd64")
	if !ok || why != "Kernel 6.12.111+deb13-amd64 is installed, 6.12.107+deb13-amd64 runs" {
		t.Errorf("kernel: %v %q", ok, why)
	}
	// Running the newest kernel: the file still asks (other packages).
	ok, why = rebootRequired(r, "6.12.111+deb13-amd64")
	if !ok || why != "Updated packages need a reboot: linux-image-6.12.111+deb13-amd64" {
		t.Errorf("pkgs: %v %q", ok, why)
	}
	os.Remove(filepath.Join(dir, "run/reboot-required"))
	if ok, why := rebootRequired(r, "6.12.111+deb13-amd64"); ok {
		t.Errorf("up to date: %q", why)
	}
	// Proxmox with a pinned kernel: no kernel comparison.
	writeTree(t, dir, map[string]string{"etc/kernel/proxmox-boot-pin": "6.12.107+deb13-amd64\n"})
	if ok, _ := rebootRequired(r, "6.12.107+deb13-amd64"); ok {
		t.Error("pinned kernel")
	}
	// Arch / Fedora keep the image in the modules directory.
	arch := t.TempDir()
	writeTree(t, arch, map[string]string{"usr/lib/modules/6.17.2-arch1-1/vmlinuz": ""})
	if ok, why := rebootRequired(fsRoot(arch), "6.17.1-arch1-1"); !ok || !strings.Contains(why, "6.17.2-arch1-1") {
		t.Errorf("arch: %v %q", ok, why)
	}
	// NixOS: booted vs current system kernel.
	nix := t.TempDir()
	writeTree(t, nix, map[string]string{"nix/store/aaa-linux/bzImage": "", "nix/store/bbb-linux/bzImage": "", "run/current-system/x": ""})
	os.MkdirAll(filepath.Join(nix, "run/booted-system"), 0o755)
	os.Symlink(filepath.Join(nix, "nix/store/aaa-linux/bzImage"), filepath.Join(nix, "run/booted-system/kernel"))
	os.Symlink(filepath.Join(nix, "nix/store/bbb-linux/bzImage"), filepath.Join(nix, "run/current-system/kernel"))
	if ok, _ := rebootRequired(fsRoot(nix), "6.12.1"); !ok {
		t.Error("nixos kernel change")
	}
	more := t.TempDir()
	writeTree(t, more, map[string]string{"run/reboot-required": "", "run/reboot-required.pkgs": "libc6\nlibssl3\ndbus\nsystemd\nlibc6\n"})
	if _, why := rebootRequired(fsRoot(more), ""); why != "Updated packages need a reboot: libc6, libssl3, dbus and 1 more" {
		t.Errorf("summary: %q", why)
	}
}

func TestTimeSync(t *testing.T) {
	// A server whose kernel PLL runs with nanosecond offsets, synchronized.
	if s, off := mapTimex(0, 0x2001, 283300); !s || off != 0.28 {
		t.Errorf("synced: %v %v", s, off)
	}
	if s, off := mapTimex(5, 0x0041, -1500); s || off != -1.5 {
		t.Errorf("unsync (us): %v %v", s, off)
	}
	// chronyc -c tracking.
	line := []byte("A9FEA97B,169.254.169.123,4,1791880000.123,0.000012345,-0.000001,0.000010,-1.234,0.001,0.010,0.000400,0.000100,64.4,Normal\n")
	s, off, ok := parseChronyTracking(line)
	if !ok || !s || off == nil || *off != 0.01 {
		t.Errorf("chrony: %v %v %v", ok, s, off)
	}
	if s, _, _ := parseChronyTracking([]byte("7F7F0101,,10,0.0,0,0,0,0,0,0,0,0,0,Not synchronised")); s {
		t.Error("chrony unsynchronised")
	}
	// A sandbox that blocks adjtimex falls back to timesyncd's marker.
	old := adjtimex
	defer func() { adjtimex = old }()
	adjtimex = func() (int, int32, int64, error) { return -1, 0, 0, syscall.EPERM }
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{"run/systemd/timesync/synchronized": ""})
	synced, offset, err := timeStatus(context.Background(), fsRoot(dir))
	if _, lerr := lookPath("chronyc"); lerr == nil {
		t.Skip("chronyc installed here; fallback order differs")
	}
	if err != nil || synced == nil || !*synced || offset != nil {
		t.Errorf("fallback: %v %v %v", synced, offset, err)
	}
	adjtimex = func() (int, int32, int64, error) { return -1, 0, 0, errors.New("boom") }
	if _, _, err := timeStatus(context.Background(), fsRoot(dir)); err == nil {
		t.Error("other errors are reported")
	}
}

func TestKernelCounters(t *testing.T) {
	if parseVMStatOOM([]byte("nr_free_pages 1\noom_kill 697\nfoo 2\n")) != 697 {
		t.Error("oom_kill")
	}
	if parseLoadavgTasks("6.15 4.43 3.65 7/5895 1639573") != 5895 {
		t.Error("tasks")
	}
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{"proc/1/comm": "systemd\n", "proc/412/comm": "systemd-timesyn\n", "proc/self/comm": "x\n"})
	if detectTimeDaemon(fsRoot(dir)) != "timesyncd" {
		t.Error("timesyncd")
	}
	writeTree(t, dir, map[string]string{"proc/900/comm": "chronyd\n"})
	if detectTimeDaemon(fsRoot(dir)) != "chrony" {
		t.Error("chrony wins")
	}
}

// fakeNet builds /sys/class/net with a physical NIC, a bond of two NICs,
// a VLAN on the bond, a bridge, a veth, a macvtap on a NIC and Wi-Fi.
func fakeNet(t *testing.T, rx string) string {
	dir := t.TempDir()
	n := "sys/class/net/"
	files := map[string]string{}
	nic := func(name string, extra map[string]string) {
		files[n+name+"/operstate"] = "up\n"
		files[n+name+"/carrier"] = "1\n"
		files[n+name+"/mtu"] = "1500\n"
		files[n+name+"/address"] = "02:00:00:00:00:01\n"
		files[n+name+"/uevent"] = "INTERFACE=" + name + "\n"
		for _, c := range []string{"tx_bytes", "rx_errors", "tx_errors", "rx_dropped", "tx_dropped"} {
			files[n+name+"/statistics/"+c] = "3\n"
		}
		files[n+name+"/statistics/rx_bytes"] = rx
		for k, v := range extra {
			files[n+name+"/"+k] = v
		}
	}
	nic("enp1s0", map[string]string{"device/vendor": "0x8086\n", "speed": "10000\n"})
	nic("enp2s0", map[string]string{"device/vendor": "0x8086\n", "speed": "-1\n", "operstate": "down\n", "carrier": "0\n"})
	nic("enp3s0", map[string]string{"device/vendor": "0x8086\n", "speed": "1000\n"})
	nic("bond0", map[string]string{"bonding/slaves": "enp3s0 enp2s0\n", "speed": "1000\n"})
	nic("bond0.20", map[string]string{"uevent": "DEVTYPE=vlan\n"})
	nic("vmbr0", map[string]string{"uevent": "DEVTYPE=bridge\n", "bridge/stp_state": "0\n"})
	nic("veth1a2b", nil)
	nic("macvtap0", nil)
	nic("wlp4s0", map[string]string{"device/vendor": "0x8086\n", "uevent": "DEVTYPE=wlan\n", "wireless/x": ""})
	nic("lo", nil)
	writeTree(t, dir, files)
	link := func(target, name string) {
		if err := os.Symlink(target, filepath.Join(dir, n, name)); err != nil {
			t.Fatal(err)
		}
	}
	link("../bond0", "enp3s0/master")
	link("../bond0", "enp2s0/master")
	link("../vmbr0", "enp1s0/master")
	link("../bond0", "bond0.20/lower_bond0")
	link("../enp1s0", "macvtap0/lower_enp1s0")
	return dir
}

func TestNetCollector(t *testing.T) {
	dir := fakeNet(t, "1000\n")
	n := newNetCollector(fsRoot(dir))
	n.addrs = func(name string) []string {
		if name == "bond0.20" {
			return []string{"10.0.20.5/24", "2001:db8::5/64"}
		}
		return nil
	}
	if err := n.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := map[string]proto.NetIface{}
	var names []string
	for _, x := range n.snapshot() {
		got[x.Name] = x
		names = append(names, x.Name)
	}
	if strings.Join(names, ",") != "bond0,bond0.20,enp1s0,enp2s0,enp3s0,wlp4s0" {
		t.Fatalf("interfaces: %v", names)
	}
	if e := got["enp1s0"]; e.Kind != "ethernet" || !e.Up || !e.Carrier || e.SpeedMbps != 10000 || e.MTU != 1500 || e.Master != "vmbr0" || e.MAC == "" || e.RxBps != 0 {
		t.Errorf("enp1s0: %+v", e)
	}
	if e := got["enp2s0"]; e.Up || e.Carrier || e.SpeedMbps != 0 || e.Master != "bond0" {
		t.Errorf("enp2s0: %+v", e)
	}
	if b := got["bond0"]; b.Kind != "bond" || strings.Join(b.Members, ",") != "enp3s0,enp2s0" {
		t.Errorf("bond0: %+v", b)
	}
	if v := got["bond0.20"]; v.Kind != "vlan" || len(v.Addresses) != 2 {
		t.Errorf("vlan: %+v", v)
	}
	if w := got["wlp4s0"]; w.Kind != "wireless" || w.RxErrors != 3 || w.TxDrops != 3 {
		t.Errorf("wifi: %+v", w)
	}
	// Second sample: 10 kB more in ~2 s.
	n.mu.Lock()
	n.prevAt = n.prevAt.Add(-2 * time.Second)
	n.mu.Unlock()
	writeTree(t, dir, map[string]string{"sys/class/net/enp1s0/statistics/rx_bytes": "11000\n"})
	n.run(context.Background())
	for _, x := range n.snapshot() {
		if x.Name == "enp1s0" && (x.RxBps < 4500 || x.RxBps > 5500) {
			t.Errorf("rx rate %v", x.RxBps)
		}
	}
}

func TestDiskIO(t *testing.T) {
	a := parseDiskstats(readTestdata(t, "diskstats_1"))
	b := parseDiskstats(readTestdata(t, "diskstats_2"))
	if len(a) != 4 || a["sda"].rdIOs != 979613 || a["nvme1n1"].ioTicks != 119400336 {
		t.Fatalf("parse: %+v", a)
	}
	// nvme1n1 over 10 s: +1000 reads of 20000 sectors, +2000 writes of
	// 80000 sectors, +500 ms reading, +1000 ms writing, +5000 ms busy.
	io, ok := diskIODelta(a["nvme1n1"], b["nvme1n1"], 10)
	want := proto.DiskIO{ReadBps: 1024000, WriteBps: 4096000, ReadIOPS: 100, WriteIOPS: 200, UtilPct: 50, AwaitMs: 0.5}
	if !ok || io != want {
		t.Errorf("delta: %+v, want %+v", io, want)
	}
	if io, ok := diskIODelta(a["sda"], b["sda"], 10); !ok || io != (proto.DiskIO{}) {
		t.Errorf("idle: %+v", io)
	}
	if _, ok := diskIODelta(b["nvme1n1"], a["nvme1n1"], 10); ok {
		t.Error("counter going backwards accepted")
	}

	dir := t.TempDir()
	writeTree(t, dir, map[string]string{"proc/diskstats": string(readTestdata(t, "diskstats_1"))})
	c := newDiskIOCollector(fsRoot(dir))
	c.run(context.Background())
	disks := []proto.Disk{{Device: "nvme1n1"}, {Device: "sda"}}
	c.fill(disks)
	if disks[0].IO != nil {
		t.Error("first sample has no rates")
	}
	c.mu.Lock()
	c.prevAt = c.prevAt.Add(-10 * time.Second)
	c.mu.Unlock()
	writeTree(t, dir, map[string]string{"proc/diskstats": string(readTestdata(t, "diskstats_2"))})
	c.run(context.Background())
	c.fill(disks)
	if disks[0].IO == nil || disks[0].IO.ReadIOPS < 95 || disks[0].IO.ReadIOPS > 105 || disks[1].IO == nil {
		t.Errorf("filled: %+v %+v", disks[0].IO, disks[1].IO)
	}
}

// openInRoot resolves symlinks inside the container root: an absolute
// link must not reach the host's file, ".." must not leave the root.
func TestOpenInRoot(t *testing.T) {
	host := t.TempDir()
	writeTree(t, host, map[string]string{
		"etc/os-release":        "ID=host\n",
		"ct/usr/lib/os-release": "ID=alpine\nVERSION_ID=3.22\n",
		"ct/etc/placeholder":    "",
		"ct2/etc/placeholder":   "",
		"ct3/etc/placeholder":   "",
	})
	os.MkdirAll(filepath.Join(host, "ct3/usr/lib/os-release.d"), 0o755)
	root := filepath.Join(host, "ct")
	// Absolute link, as distributions ship it.
	os.Symlink("/usr/lib/os-release", filepath.Join(root, "etc/os-release"))
	// A container that tries to escape.
	os.Symlink("../../../../../../../../etc/os-release", filepath.Join(host, "ct2/etc/os-release"))
	for name, want := range map[string]string{"ct": "ID=alpine", "ct2": ""} {
		f, err := openInRoot(filepath.Join(host, name), "etc/os-release")
		got := ""
		if err == nil {
			b := make([]byte, 64)
			n, _ := f.Read(b)
			got = strings.SplitN(string(b[:n]), "\n", 2)[0]
			f.Close()
		}
		if got != want {
			t.Errorf("%s: %q (%v), want %q", name, got, err, want)
		}
	}
	// The fallback resolver gives the same answers.
	p, err := resolveInRoot(root, "etc/os-release")
	if err != nil || p != filepath.Join(root, "usr/lib/os-release") {
		t.Errorf("resolveInRoot: %s %v", p, err)
	}
	p, err = resolveInRoot(filepath.Join(host, "ct2"), "etc/os-release")
	if err == nil && !strings.HasPrefix(p, filepath.Join(host, "ct2")) {
		t.Errorf("escaped: %s", p)
	}
	// A directory is not a file.
	if _, err := openInRoot(filepath.Join(host, "ct3"), "usr/lib/os-release.d"); err == nil {
		t.Error("directory opened")
	}
}
