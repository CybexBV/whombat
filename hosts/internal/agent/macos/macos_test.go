package macos

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// The testdata are real outputs of a Mac Studio (macOS 27.2.1, Apple
// M2 Ultra) with its addresses, names and serials replaced by made-up ones.

func read(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParsePlist(t *testing.T) {
	v, err := ParsePlist([]byte(`<?xml version="1.0"?><plist version="1.0"><dict>
	<key>s</key><string>a &amp; b</string><key>i</key><integer>-42</integer><key>r</key><real>1.5</real>
	<key>t</key><true/><key>f</key><false/><key>d</key><date>2026-11-17T08:02:32Z</date>
	<key>b</key><data>aGk=</data><key>a</key><array><string>x</string><dict/></array><key>e</key><string></string></dict></plist>`))
	if err != nil {
		t.Fatal(err)
	}
	d := asDict(v)
	if d.str("s") != "a & b" || d["i"] != int64(-42) || d["r"] != 1.5 || d["t"] != true || d["f"] != false ||
		!d.time("d").Equal(time.Date(2026, 11, 17, 8, 2, 32, 0, time.UTC)) || string(d["b"].([]byte)) != "hi" ||
		len(d.list("a")) != 2 || d.str("e") != "" {
		t.Errorf("%#v", d)
	}
	if _, err := ParsePlist([]byte("<plist><dict><key>x</key><integer>nope</integer></dict></plist>")); err == nil {
		t.Error("a broken integer must fail")
	}
	if _, err := ParsePlist([]byte("")); err == nil {
		t.Error("empty input must fail")
	}
}

func TestMacFacts(t *testing.T) {
	v := ParseSwVers(read(t, "sw_vers.txt"))
	if v != (SystemVersion{Name: "macOS", Version: "27.2.1", Build: "26B131"}) || MajorVersion(v.Version) != 27 || MajorVersion("x") != 0 {
		t.Errorf("sw_vers: %+v", v)
	}
	if id := ParseIORegUUID(read(t, "ioreg_platform.txt")); id != "00000000-1111-4222-8333-444455556666" {
		t.Errorf("uuid %q", id)
	}
	hw, ok := ParseHardware(read(t, "sp_hardware.json"))
	if !ok || hw.ModelName != "Mac Studio" || hw.Model != "Mac14,14" || hw.Chip != "Apple M2 Ultra" || hw.Memory != "64 GB" {
		t.Errorf("hardware %+v", hw)
	}
	intel, ok := ParseHardware([]byte(`{"SPHardwareDataType":[{"machine_name":"Mac mini","machine_model":"Macmini8,1","cpu_type":"6-Core Intel Core i7"}]}`))
	if !ok || intel.Chip != "6-Core Intel Core i7" {
		t.Errorf("intel %+v", intel)
	}
	sh := ParseSysctlHost(read(t, "sysctl_host.txt"))
	if sh.Model != "Mac14,14" || sh.CPU != "Apple M2 Ultra" || sh.Cores != 24 || sh.Threads != 24 || sh.MemBytes != 64<<30 ||
		sh.Boot.Unix() != 1794902443 {
		t.Errorf("sysctl %+v", sh)
	}
	for in, want := range map[string]*bool{
		"System Integrity Protection status: enabled.":                        ptr(true),
		"System Integrity Protection status: disabled.":                       ptr(false),
		"System Integrity Protection status: unknown (Custom Configuration).": nil,
	} {
		if got := ParseCsrutil([]byte(in)); !samePtr(got, want) {
			t.Errorf("csrutil %q: %v", in, got)
		}
	}
	for in, want := range map[string]*bool{
		"FileVault is Off.\n":                           ptr(false),
		"FileVault is On.\n":                            ptr(true),
		"Encryption in progress: Percent completed = 3": ptr(true),
		"something else":                                nil,
	} {
		if got := ParseFileVault([]byte(in)); !samePtr(got, want) {
			t.Errorf("fdesetup %q: %v", in, got)
		}
	}
	if ConsoleUser([]byte("jdoe\n")) != "jdoe" || ConsoleUser([]byte("root\n")) != "" || ConsoleUser([]byte("loginwindow")) != "" {
		t.Error("console user")
	}
	if AutoLoginUser([]byte("jdoe\n"), nil) != "jdoe" || AutoLoginUser(nil, os.ErrNotExist) != "" {
		t.Error("auto-login")
	}
	if !ParseRFBVersion([]byte("RFB 003.889\n")) || ParseRFBVersion([]byte("SSH-2.0-Ope")) || ParseRFBVersion([]byte("RFB 003")) {
		t.Error("rfb")
	}
	if ParseDefaultRoute(read(t, "route.txt")) != "en0" {
		t.Error("default route")
	}
	if v := BundleVersion([]byte(`<plist><dict><key>CFBundleShortVersionString</key><string>1.2.0</string><key>CFBundleVersion</key><string>7</string></dict></plist>`)); v != "1.2.0" {
		t.Errorf("bundle version %q", v)
	}
	for in, want := range map[string]string{
		"Apple M2 Ultra": "Apple M2 Ultra", "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz": "Core i9-9880H",
		"Intel(R) Xeon(R) W-3245 CPU @ 3.20GHz": "Xeon W-3245",
	} {
		if got := CPUModel(in); got != want {
			t.Errorf("CPUModel(%q) = %q", in, got)
		}
	}
}

func samePtr(a, b *bool) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func TestSoftwareUpdate(t *testing.T) {
	p, err := ParseSoftwareUpdatePlist(read(t, "swupdate.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Updates) != 1 || p.Updates[0].Name != "Command Line Tools for Xcode 27.2" || p.Updates[0].New != "27.2" ||
		p.Security != 0 || !p.CheckedAt.Equal(time.Date(2026, 11, 17, 8, 2, 32, 0, time.UTC)) {
		t.Errorf("%+v", p)
	}
	l := ParseSoftwareUpdateList(read(t, "softwareupdate_list.txt"))
	if len(l) != 1 || l[0] != (ListedUpdate{Label: "Command Line Tools for Xcode 27.2-27.2", Title: "Command Line Tools for Xcode 27.2", Version: "27.2"}) {
		t.Errorf("list %+v", l)
	}
	// An OS update that restarts the Mac and a security release, in the
	// shape softwareupdate prints them.
	l = ParseSoftwareUpdateList([]byte("Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n" +
		"* Label: macOS Tahoe 26.2-25C56\n\tTitle: macOS Tahoe 26.2, Version: 26.2, Size: 7151335KiB, Recommended: YES, Action: restart, \n" +
		"* Label: Background Security Improvement (a)-25C56a\n\tTitle: Background Security Improvement (a), Version: 26.2 (a), Size: 99KiB, Recommended: YES, Action: restart, \n"))
	if len(l) != 2 || !l[0].Restart || l[0].Version != "26.2" || l[1].Version != "26.2 (a)" {
		t.Fatalf("restart list %+v", l)
	}
	pu := PackageUpdates(l)
	if len(pu) != 2 || !pu[0].Security || pu[0].Name != "Background Security Improvement (a)-25C56a" || pu[1].Source != "Apple · needs a restart" {
		t.Errorf("rows %+v", pu)
	}
	for _, ok := range []string{"macOS Tahoe 26.2-25C56", "Command Line Tools for Xcode 27.2-27.2", "Safari26.2VenturaAuto-26.2", "Background Security Improvement (a)-25C56a"} {
		if !LabelRe.MatchString(ok) {
			t.Errorf("label %q refused", ok)
		}
	}
	for _, bad := range []string{"--all", "-R", "a\nb", "x;rm -rf /", `x"y`, ""} {
		if LabelRe.MatchString(bad) {
			t.Errorf("label %q accepted", bad)
		}
	}
}

func TestDiskutil(t *testing.T) {
	l, err := ParseDiskutilList(read(t, "diskutil_list.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(l.WholeDisks, []string{"disk0", "disk1", "disk2", "disk3", "disk4", "disk5", "disk6", "disk7"}) {
		t.Errorf("whole disks %v", l.WholeDisks)
	}
	if !slices.Equal(l.Containers["disk3"], []string{"disk0"}) || !slices.Equal(l.Containers["disk5"], []string{"disk4"}) ||
		l.IsContainer("disk0") || !l.IsContainer("disk1") {
		t.Errorf("containers %v", l.Containers)
	}
	if l.Volumes["disk3s1"] != "/System/Volumes/Data" || l.Volumes["disk3s3s1"] != "/" {
		t.Errorf("volumes %v", l.Volumes)
	}
	di, err := ParseDiskutilInfo(read(t, "diskutil_info_disk0.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if di.Virtual || di.Device != "disk0" || !di.Internal || di.Bus != "Apple Fabric" {
		t.Errorf("disk0 %+v", di)
	}
	d := di.Disk()
	if d.Type != "nvme" || d.Model != "APPLE SSD AP1024Z" || d.CapacityBytes != 1000555581440 || d.SmartPassed == nil || !*d.SmartPassed ||
		*d.WearPct != 29 || *d.PowerOnHours != 1386 || *d.WrittenBytes != 1457556411*512000 || *d.TempC != 23 ||
		*d.MediaErrors != 0 || *d.UnsafeShutdowns != 20 || *d.SparePct != 100 || *d.SpareThreshold != 99 || d.CriticalWarning != nil {
		t.Errorf("disk %+v", d)
	}
	for _, f := range []string{"diskutil_info_disk3.plist", "diskutil_info_disk4.plist"} {
		if di, err := ParseDiskutilInfo(read(t, f)); err != nil || !di.Virtual {
			t.Errorf("%s must be virtual: %+v %v", f, di, err)
		}
	}
	for in, want := range map[string]*bool{"Verified": ptr(true), "Failing": ptr(false), "About to Fail": ptr(false), "Not Supported": nil, "": nil} {
		if got := SmartPassed(in); !samePtr(got, want) {
			t.Errorf("SmartPassed(%q) = %v", in, got)
		}
	}
	if WholeDiskOf("disk3s3s1") != "disk3" || WholeDiskOf("disk0") != "disk0" || ContainerOfDevice("/dev/disk3s3s1") != "disk3" ||
		ContainerOfDevice("map auto_home") != "" || ContainerOfDevice("//user@nas/share") != "" {
		t.Error("disk names")
	}
}

// mountsOfStudio is what getfsstat lists on the Mac Studio.
var mountsOfStudio = []Mount{
	{"/dev/disk3s3s1", "/", "apfs", []string{"ro", "journaled", "multilabel", "local"}},
	{"devfs", "/dev", "devfs", []string{"rw", "nobrowse", "multilabel", "local"}},
	{"/dev/disk3s6", "/System/Volumes/VM", "apfs", []string{"rw", "noexec", "nobrowse", "journaled"}},
	{"/dev/disk3s4", "/System/Volumes/Preboot", "apfs", []string{"rw", "nobrowse", "journaled"}},
	{"/dev/disk3s2", "/System/Volumes/Update", "apfs", []string{"rw", "nobrowse", "journaled"}},
	{"/dev/disk1s2", "/System/Volumes/xarts", "apfs", []string{"rw", "noexec", "nobrowse"}},
	{"/dev/disk1s1", "/System/Volumes/iSCPreboot", "apfs", []string{"rw", "nobrowse"}},
	{"/dev/disk1s3", "/System/Volumes/Hardware", "apfs", []string{"rw", "nobrowse"}},
	{"/dev/disk3s1", "/System/Volumes/Data", "apfs", []string{"rw", "nobrowse", "journaled", "protect"}},
	{"map auto_home", "/System/Volumes/Data/home", "autofs", []string{"rw", "nobrowse", "automounted"}},
	{"/dev/disk5s1", "/Library/Developer/CoreSimulator/Volumes/iOS_24A94425", "apfs", []string{"ro", "nosuid", "nobrowse"}},
	{"devices -- file:///Users/jdoe/Library/Containers/x/Data/", "/Users/jdoe/Library/Developer/CoreDevice/DeviceFS", "devicefs", []string{"rw", "nobrowse"}},
	{"/dev/disk3s5", "/Volumes/Recovery", "apfs", []string{"rw", "nobrowse", "journaled"}},
}

func TestPickVolumes(t *testing.T) {
	v := PickVolumes(mountsOfStudio)
	if len(v) != 1 || v[0].Mount != "/" || v[0].Device != "/dev/disk3" || v[0].container != "disk3" || v[0].FSType != "apfs" {
		t.Fatalf("studio: %+v", v)
	}
	more := append(slices.Clone(mountsOfStudio),
		Mount{"/dev/disk8s2", "/Volumes/Backup", "apfs", []string{"rw", "journaled", "local"}},
		Mount{"/dev/disk8s1", "/Volumes/Backup - Data", "apfs", []string{"rw", "journaled", "local"}},
		Mount{"/dev/disk9s1", "/Volumes/STICK", "exfat", []string{"rw", "local"}},
		Mount{"//jdoe@nas.example.com/media", "/Volumes/media", "smbfs", []string{"rw", "nodev"}},
		Mount{"//jdoe@nas.example.com/hidden", "/Volumes/hidden", "smbfs", []string{"rw", "nobrowse"}})
	v = PickVolumes(more)
	var got []string
	for _, x := range v {
		got = append(got, x.Mount+"="+x.Device)
	}
	want := []string{"/=/dev/disk3", "/Volumes/Backup=/dev/disk8", "/Volumes/STICK=/dev/disk9", "/Volumes/media=//jdoe@nas.example.com/media"}
	if !slices.Equal(got, want) || !v[3].Remote {
		t.Errorf("volumes %v", got)
	}

	list, _ := ParseDiskutilList(read(t, "diskutil_list.plist"))
	vols := []volume{
		{container: "disk3", Filesystem: proto.Filesystem{Mount: "/", UsedBytes: 237993500672}},
		{container: "disk9", Filesystem: proto.Filesystem{Mount: "/Volumes/STICK", UsedBytes: 5}},
	}
	disks := []proto.Disk{{Device: "disk0"}, {Device: "disk9"}, {Device: "disk10"}}
	io := map[string]*proto.DiskIO{"disk0": {ReadBps: 7}}
	out := DisksWithUse(disks, list, vols, io)
	if *out[0].UsedBytes != 237993500672 || out[0].Role != "System · /" || out[0].IO.ReadBps != 7 ||
		*out[1].UsedBytes != 5 || out[1].Role != "/Volumes/STICK" || out[2].UsedBytes != nil || out[2].Role != "" {
		t.Errorf("disks %+v", out)
	}

	volsWithShare := append(slices.Clone(vols),
		volume{container: "disk4", Filesystem: proto.Filesystem{Mount: "/Volumes/AppDMG"}},
		volume{Filesystem: proto.Filesystem{Mount: "/Volumes/media", Remote: true}},
	)
	fss := FilesystemsWithDisks(volsWithShare, list, disks)
	if len(fss) != 4 || !slices.Equal(fss[0].Disks, []string{"disk0"}) || !slices.Equal(fss[1].Disks, []string{"disk9"}) ||
		len(fss[2].Disks) != 0 || len(fss[3].Disks) != 0 {
		t.Errorf("filesystems with disks %+v", fss)
	}
	// DiskInfo parses APFS physical stores and keeps unknown SolidState distinct from HDD.
	di3, err := ParseDiskutilInfo(read(t, "diskutil_info_disk3.plist"))
	if err != nil || !slices.Equal(di3.APFSPhysicalStores, []string{"disk0"}) || di3.APFSContainer != "disk3" {
		t.Errorf("disk3 info %+v %v", di3, err)
	}
	unknownUSB, err := ParseDiskutilInfo([]byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk9</string>
		<key>BusProtocol</key><string>USB</string>
		<key>Internal</key><false/>
		<key>TotalSize</key><integer>1000000000</integer>
	</dict></plist>`))
	if err != nil || unknownUSB.SolidStateKnown || unknownUSB.Disk().Type != "" {
		t.Errorf("unknown SolidState disk %+v (%+v) %v", unknownUSB, unknownUSB.Disk(), err)
	}
}

func TestLaunchctlList(t *testing.T) {
	s := ParseLaunchctlList(read(t, "launchctl_list.txt"))
	if len(s) != 434 {
		t.Errorf("%d jobs", len(s))
	}
	var failed []string
	for _, x := range s {
		if x.Active == "failed" {
			failed = append(failed, x.Name+": "+x.Description)
		}
	}
	want := []string{"com.apple.Kerberos.digest-service: ended by signal 9", "com.apple.iomfb_fdr_loader: last exit status 1", "com.apple.wifiFirmwareLoader: last exit status 1"}
	if !slices.Equal(failed, want) {
		t.Errorf("failed %v", failed)
	}
	// A running job that died once (pid set) is active, not failed.
	for _, x := range s {
		if x.Name == "com.apple.Kerberos.kdc" && (x.Active != "active" || x.Description != "pid 817") {
			t.Errorf("kdc %+v", x)
		}
	}
	if s[0].Active != "failed" || s[len(s)-1].Active != "inactive" {
		t.Error("failed first, inactive last")
	}
}

func TestPs(t *testing.T) {
	loc := time.FixedZone("CET", 3600)
	p := ParsePs(read(t, "ps.txt"), read(t, "ps_comm.txt"), loc)
	if len(p) < 20 {
		t.Fatalf("%d processes", len(p))
	}
	var launchd *proto.Process
	for i := range p {
		if p[i].PID == 1 {
			launchd = &p[i]
		}
		if p[i].Command == "" || p[i].Name == "" {
			t.Errorf("row %+v", p[i])
		}
	}
	if launchd == nil || launchd.Name != "launchd" || launchd.User != "root" || launchd.PPID != 0 || launchd.State != "S" ||
		!launchd.Started.Equal(time.Date(2026, 11, 17, 8, 0, 43, 0, time.UTC)) || launchd.Command != "/sbin/launchd" || launchd.RSSBytes == 0 {
		t.Errorf("launchd %+v", launchd)
	}
	for i := 1; i < len(p); i++ {
		if p[i].CPUPct > p[i-1].CPUPct {
			t.Fatal("not sorted by CPU")
		}
	}
	// A command line keeps its spacing; a name with spaces comes from ps -c.
	got := ParsePs([]byte("  543     1 root 0.0  27984 Ss   Tue Nov 17 09:01:59 2026     /usr/libexec/UserEventAgent (System)\n"),
		[]byte("  543 UserEventAgent\n"), loc)
	if len(got) != 1 || got[0].Command != "/usr/libexec/UserEventAgent (System)" || got[0].Name != "UserEventAgent" {
		t.Errorf("%+v", got)
	}
}

func TestLsof(t *testing.T) {
	tcp := ParseLsof(read(t, "lsof_tcp.txt"))
	has := func(l []proto.ListenPort, p proto.ListenPort) bool { return slices.Contains(l, p) }
	n22 := 0
	for _, x := range tcp {
		if x.Port == 22 {
			n22++
		}
	}
	if n22 != 2 || !has(tcp, proto.ListenPort{Proto: "tcp", Address: "0.0.0.0", Port: 5900, PID: 1, Process: "launchd"}) ||
		!has(tcp, proto.ListenPort{Proto: "tcp6", Address: "::1", Port: 8021, PID: 1, Process: "launchd"}) {
		t.Errorf("tcp %+v", tcp)
	}
	udp := ParseLsof(read(t, "lsof_udp.txt"))
	for _, x := range udp {
		if x.Port == 0 || !strings.HasPrefix(x.Proto, "udp") {
			t.Errorf("udp row %+v", x)
		}
	}
	if !has(udp, proto.ListenPort{Proto: "udp", Address: "0.0.0.0", Port: 137, PID: 1, Process: "launchd"}) {
		t.Errorf("udp %+v", udp)
	}
	// Connected sockets and unbound ones are not listening.
	if got := ParseLsof([]byte("p9\ncx\nf3\ntIPv4\nPUDP\nn10.100.0.9:5353->10.100.0.1:53\nf4\ntIPv4\nPUDP\nn*:*\n")); len(got) != 0 {
		t.Errorf("%+v", got)
	}
}

func TestNetwork(t *testing.T) {
	ifs := ParseIfconfig(read(t, "ifconfig.txt"))
	ports := ParseHardwarePorts(read(t, "networksetup_ports.txt"))
	if len(ports) != 15 || ports[0] != (HardwarePort{Port: "Ethernet", Device: "en0"}) {
		t.Errorf("ports %+v", ports)
	}
	var en0, bridge Iface
	for _, i := range ifs {
		switch i.Name {
		case "en0":
			en0 = i
		case "bridge0":
			bridge = i
		}
	}
	if !en0.Up || !en0.Active || en0.MTU != 1500 || SpeedMbps(en0.Media) != 10000 || en0.MAC == "" ||
		len(en0.Addrs) != 2 || en0.Addrs[0] != "10.100.0.9/23" || !strings.HasPrefix(en0.Addrs[1], "2001:db8:0:1::") {
		t.Errorf("en0 %+v", en0)
	}
	if len(bridge.Members) != 6 {
		t.Errorf("bridge %+v", bridge)
	}
	n := NetIfaces(ifs, ports, map[string][2]float64{"en0": {5, 6}}, map[string][4]uint64{"en0": {1, 2, 3, 4}})
	if len(n) != 2 || n[0].Name != "en0" || n[0].Kind != "ethernet" || n[0].RxBps != 5 || n[0].TxDrops != 4 || n[0].SpeedMbps != 10000 ||
		n[1].Name != "en1" || n[1].Kind != "wireless" || !n[1].Carrier {
		t.Errorf("ifaces %+v", n)
	}
	a := Addresses(ifs, ports, "en0")
	if len(a) != 4 || a[0] != "10.100.0.9" || a[1] != "10.100.1.45" || !strings.HasPrefix(a[2], "2001:db8") {
		t.Errorf("addresses %v", a)
	}
	for in, want := range map[string]int{"autoselect (1000baseT <full-duplex>)": 1000, "autoselect (2500Base-T <full-duplex>)": 2500, "autoselect": 0, "none": 0} {
		if got := SpeedMbps(in); got != want {
			t.Errorf("SpeedMbps(%q) = %d", in, got)
		}
	}
}

func TestGroupTemps(t *testing.T) {
	s := GroupTemps([]Temp{{"PMU tdie3", 41.26}, {"PMU tdie7", 44.04}, {"PMU tcal", 51.9}, {"PMU TP1g", 38}, {"PMU TP2s", 60},
		{"NAND CH0 temp", 22}, {"PMU tdev1", 70}, {"bogus", 99}})
	if len(s) != 3 || s[0] != (proto.Sensor{ID: proto.SensorCPU, Label: "CPU package", Group: "cpu", Source: "PMU tdie7 · 2 sensors", TempC: 44, LimitC: 105}) ||
		s[1].ID != proto.SensorGPU || s[1].TempC != 38 || s[2].ID != proto.SensorNVMe || s[2].Source != "NAND CH0 temp" {
		t.Errorf("%+v", s)
	}
	intel := GroupTemps([]Temp{{"TC0P", 61}, {"TC0D", 70}, {"TG0P", 50}, {"TA0P", 30}})
	if len(intel) != 2 || intel[0].TempC != 70 || intel[0].LimitC != 100 || intel[1].ID != proto.SensorGPU {
		t.Errorf("intel %+v", intel)
	}
}

func TestRestartNeeded(t *testing.T) {
	state := t.TempDir()
	pk := filepath.Join(state, "packages")
	if err := os.MkdirAll(pk, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadRestartNeeded(state); ok {
		t.Fatal("none yet")
	}
	at := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	if err := WriteRestartNeeded(pk, at); err != nil {
		t.Fatal(err)
	}
	if rn, ok := ReadRestartNeeded(state); !ok || !rn.At.Equal(at) {
		t.Errorf("%+v %v", rn, ok)
	}
}

func TestFillScreen(t *testing.T) {
	defer SetScreenStatus(nil)
	m := proto.MacOS{Version: "27.2.1", Helper: proto.MacHelper{Installed: true, Version: "1.0"}}
	fillScreen(t.Context(), &m)
	if m.Screen != (proto.MacScreen{}) || m.Helper.Running {
		t.Error("no hook: nothing filled")
	}
	ax := true
	SetScreenStatus(func(context.Context) (proto.MacScreen, proto.MacHelper) {
		return proto.MacScreen{Sharing: true, Account: "jdoe", SignIn: "weird", Width: 5120, Height: 2880},
			proto.MacHelper{Installed: false, Running: true, Accessibility: &ax, User: "jdoe"}
	})
	fillScreen(t.Context(), &m)
	if !m.Screen.Sharing || m.Screen.Account != "jdoe" || m.Screen.SignIn != "" || m.Screen.Width != 5120 ||
		!m.Helper.Installed || m.Helper.Version != "1.0" || !m.Helper.Running || m.Helper.Accessibility == nil || m.Helper.User != "jdoe" {
		t.Errorf("%+v", m)
	}
}

// A Mac's agent says when its folder can be changed by others than root.
func TestAgentFolder(t *testing.T) {
	defer func(e func() int, x func() (string, error), r func(string) error) {
		agentEUID, agentExe, agentRootOnly = e, x, r
	}(agentEUID, agentExe, agentRootOnly)
	agentEUID = func() int { return 0 }
	agentExe = func() (string, error) { return "/usr/local/bin/whombat-agent", nil }
	rootErr := errors.New("/usr/local/bin belongs to uid 501")
	agentRootOnly = func(string) error { return rootErr }
	if got := agentFolder(); got != "/usr/local/bin" {
		t.Fatalf("others can change it: %q", got)
	}
	rootErr = nil
	if got := agentFolder(); got != "" {
		t.Fatalf("root's alone: %q", got)
	}
	rootErr = errors.New("x")
	agentExe = func() (string, error) { return "", errors.New("unknown") }
	if got := agentFolder(); got != "" {
		t.Fatalf("unknown executable: %q", got)
	}
	agentEUID = func() int { return 501 }
	agentExe = func() (string, error) { return "/usr/local/bin/whombat-agent", nil }
	if got := agentFolder(); got != "" {
		t.Fatalf("not root: %q", got)
	}
}
