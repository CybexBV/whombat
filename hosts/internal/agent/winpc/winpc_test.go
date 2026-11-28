package winpc

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseFactsDesktop(t *testing.T) {
	f, err := parseFacts(readFixture(t, "facts-desktop.json"))
	if err != nil {
		t.Fatal(err)
	}
	d := f.defender
	if d == nil || !d.Running || d.Mode != proto.DefenderNormal || !d.Antivirus || !d.RealTime || d.Tamper == nil || !*d.Tamper {
		t.Fatalf("defender = %+v", d)
	}
	if want := time.Date(2026, 11, 27, 6, 12, 40, 0, time.UTC); !d.SignaturesAt.Equal(want) {
		t.Errorf("signatures at %v, want %v", d.SignaturesAt, want)
	}
	if !f.sc || len(f.antivirus) != 2 {
		t.Fatalf("security center %v, antivirus %+v", f.sc, f.antivirus)
	}
	// 397568 = 0x061100: on, up to date; 266240 = 0x041000: on, up to date.
	if a := f.antivirus[0]; !a.On || !a.UpToDate {
		t.Errorf("defender product = %+v", a)
	}
	if f.systemDrive != "C:" {
		t.Errorf("system drive %q", f.systemDrive)
	}
	wantBL := []proto.WindowsVolume{
		{Drive: "C:", Protection: proto.BitLockerOn, System: true},
		{Drive: "D:", Protection: proto.BitLockerOff},
		{Drive: "E:", Protection: proto.BitLockerUnknown},
	}
	if len(f.bitlocker) != len(wantBL) {
		t.Fatalf("bitlocker = %+v", f.bitlocker)
	}
	for i, v := range wantBL {
		if f.bitlocker[i] != v {
			t.Errorf("bitlocker[%d] = %+v, want %+v", i, f.bitlocker[i], v)
		}
	}
	if f.driveDisk["C:"] != "disk0" || f.driveDisk["D:"] != "disk1" || len(f.driveDisk) != 2 {
		t.Errorf("drive disks = %v", f.driveDisk)
	}
	if len(f.disks) != 2 {
		t.Fatalf("disks = %+v", f.disks)
	}
	nvme, hdd := f.disks[0], f.disks[1]
	if nvme.Device != "disk0" || nvme.Type != "nvme" || nvme.SmartPassed == nil || !*nvme.SmartPassed ||
		nvme.WearPct == nil || *nvme.WearPct != 4 || nvme.PowerOnHours == nil || *nvme.PowerOnHours != 5120 ||
		nvme.Uncorrectable == nil || *nvme.Uncorrectable != 0 || nvme.CapacityBytes != 1000204886016 {
		t.Errorf("nvme = %+v", nvme)
	}
	if hdd.Device != "disk1" || hdd.Type != "hdd" || hdd.SmartPassed == nil || *hdd.SmartPassed ||
		hdd.WearPct != nil || hdd.TempC == nil || *hdd.TempC != 38 || hdd.Uncorrectable == nil || *hdd.Uncorrectable != 3 {
		t.Errorf("hdd = %+v", hdd)
	}
}

func TestParseFactsServer(t *testing.T) {
	f, err := parseFacts(readFixture(t, "facts-server.json"))
	if err != nil {
		t.Fatal(err)
	}
	if d := f.defender; d == nil || d.Running || d.Mode != proto.DefenderOff || !d.SignaturesAt.IsZero() || d.Tamper != nil {
		t.Errorf("defender = %+v", d)
	}
	if f.sc || f.antivirus != nil {
		t.Errorf("security center %v %+v", f.sc, f.antivirus)
	}
	// No BitLocker answer (the feature isn't installed): unknown, not off.
	if f.bitlocker != nil {
		t.Errorf("bitlocker = %+v", f.bitlocker)
	}
	if len(f.disks) != 1 || f.disks[0].SmartPassed != nil || f.disks[0].Type != "ssd" {
		t.Errorf("disks = %+v", f.disks)
	}
	if _, err := parseFacts([]byte("Get-MpComputerStatus : not here")); err == nil {
		t.Error("text that isn't JSON parsed")
	}
}

func TestProductState(t *testing.T) {
	for _, c := range []struct {
		state        int64
		on, upToDate bool
	}{
		{0x061100, true, true},  // Defender, on, current
		{0x041000, true, true},  // another product, on
		{0x060100, false, true}, // off
		{0x061110, true, false}, // signatures out of date
		{0x041010, true, false},
		{0, false, true},
	} {
		on, cur := productState(c.state)
		if on != c.on || cur != c.upToDate {
			t.Errorf("productState(%#x) = %v %v, want %v %v", c.state, on, cur, c.on, c.upToDate)
		}
	}
}

func TestDefenderMode(t *testing.T) {
	for _, c := range []struct {
		mode    string
		running bool
		want    string
	}{
		{"Normal", true, proto.DefenderNormal},
		{"Passive Mode", true, proto.DefenderPassive},
		{"SxS Passive Mode", true, proto.DefenderPassive},
		{"EDR Block Mode", true, proto.DefenderEDRBlock},
		{"Not running", false, proto.DefenderOff},
		{"", false, proto.DefenderOff},
		{"", true, ""},
	} {
		if got := defenderMode(c.mode, c.running); got != c.want {
			t.Errorf("defenderMode(%q, %v) = %q, want %q", c.mode, c.running, got, c.want)
		}
	}
}

func TestDriveAndDiskNames(t *testing.T) {
	for in, want := range map[string]string{"C": "C:", "c:": "C:", `D:\`: "D:", " e: ": "E:", "": "", "CD": "", "1:": "", `\\?\Volume{x}\`: ""} {
		if got := driveName(in); got != want {
			t.Errorf("driveName(%q) = %q, want %q", in, got, want)
		}
	}
	for _, c := range []struct{ media, bus, want string }{
		{"SSD", "NVMe", "nvme"}, {"4", "17", "nvme"}, {"SSD", "SATA", "ssd"}, {"HDD", "SATA", "hdd"},
		{"3", "11", "hdd"}, {"Unspecified", "SAS", "ssd"},
	} {
		if got := diskType(c.media, c.bus); got != c.want {
			t.Errorf("diskType(%q, %q) = %q, want %q", c.media, c.bus, got, c.want)
		}
	}
	for in, want := range map[string][2]bool{"Healthy": {true, true}, "0": {true, true}, "Warning": {false, true},
		"Unhealthy": {false, true}, "2": {false, true}, "Unknown": {false, false}, "": {false, false}} {
		ok, known := diskHealthy(in)
		if ok != want[0] || known != want[1] {
			t.Errorf("diskHealthy(%q) = %v %v", in, ok, known)
		}
	}
}

func TestParseUpdates(t *testing.T) {
	u, err := parseUpdates(readFixture(t, "updates.json"))
	if err != nil {
		t.Fatal(err)
	}
	if u.pending == nil || *u.pending != 3 || u.security == nil || *u.security != 1 {
		t.Fatalf("pending %v security %v", u.pending, u.security)
	}
	if len(u.list) != 3 || u.list[0].New != "KB5055523" || !u.list[0].Security || u.list[0].Source == "" ||
		u.list[1].Security || u.list[2].New != "" {
		t.Errorf("list = %+v", u.list)
	}
	if !u.reboot || rebootReason(u) == "" {
		t.Errorf("a waiting servicing restart counts: reboot %v", u.reboot)
	}
	if !u.checked.Equal(time.Date(2026, 11, 28, 4, 0, 0, 0, time.UTC)) || u.installed.IsZero() || u.err != "" {
		t.Errorf("checked %v installed %v err %q", u.checked, u.installed, u.err)
	}

	e, err := parseUpdates(readFixture(t, "updates-error.json"))
	if err != nil {
		t.Fatal(err)
	}
	if e.pending != nil || e.security != nil || e.list != nil || e.err == "" || !e.installed.IsZero() || e.reboot {
		t.Errorf("a failed search = %+v", e)
	}
	if rebootReason(e) != "" || rebootReason(nil) != "" {
		t.Error("no restart, no reason")
	}
}

func TestBuildStorage(t *testing.T) {
	f, err := parseFacts(readFixture(t, "facts-desktop.json"))
	if err != nil {
		t.Fatal(err)
	}
	vols := []volume{
		{drive: "C:", fstype: "NTFS", size: 1000, used: 600},
		{drive: "D:", fstype: "NTFS", size: 4000, used: 100},
		{drive: "Z:", fstype: "NTFS", size: 50, used: 10, remote: true},
	}
	fss, disks := buildStorage(vols, f)
	if len(fss) != 3 || fss[0].Mount != "C:" || len(fss[0].Disks) != 1 || fss[0].Disks[0] != "disk0" || fss[2].Disks != nil {
		t.Fatalf("filesystems = %+v", fss)
	}
	if len(disks) != 2 || disks[0].UsedBytes == nil || *disks[0].UsedBytes != 600 || disks[1].UsedBytes == nil || *disks[1].UsedBytes != 100 {
		t.Fatalf("disks = %+v", disks)
	}
	if disks[0].Role != "System · C:" || disks[1].Role != "D:" {
		t.Errorf("roles %q %q", disks[0].Role, disks[1].Role)
	}
	// Before the facts were read: the drives, no disks.
	fss, disks = buildStorage(vols, nil)
	if len(fss) != 3 || len(disks) != 0 || fss[0].Disks != nil {
		t.Errorf("without facts: %+v %+v", fss, disks)
	}
}

func TestShortCPU(t *testing.T) {
	for in, want := range map[string]string{
		"Intel(R) Core(TM) i7-1185G7 @ 3.00GHz":                        "Core i7-1185G7",
		"AMD Ryzen 9 7950X 16-Core Processor":                          "Ryzen 9 7950X 16-Core",
		"Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Oryon(TM) CPU": "Snapdragon X Elite - X1E78100 - Qualcomm Oryon",
	} {
		if got := shortCPU(in); got != want {
			t.Errorf("shortCPU(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPowerCommand(t *testing.T) {
	r, s := powerCommand(proto.ActionHostReboot), powerCommand(proto.ActionHostShutdown)
	if filepath.Base(r[0]) != "shutdown.exe" || r[1] != "/r" || s[1] != "/s" {
		t.Errorf("restart %v, shut down %v", r, s)
	}
	for _, argv := range [][]string{r, s} {
		if !contains(argv, "/t") || !contains(argv, "/d") || !contains(argv, "/c") {
			t.Errorf("%v lacks the delay, the reason or the notice", argv)
		}
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestScriptCommandQuotes(t *testing.T) {
	got := scriptCommand(`C:\ProgramData\Whombat\it's\whombat-facts.ps1`)
	want := `& ([scriptblock]::Create([IO.File]::ReadAllText('C:\ProgramData\Whombat\it''s\whombat-facts.ps1')))`
	if got != want {
		t.Errorf("scriptCommand = %s", got)
	}
	// PowerShell ends a single-quoted string at a typographic quote too.
	if got := psQuote("D:\\John’s ‘state’"); got != "'D:\\John’’s ‘‘state’’'" {
		t.Errorf("psQuote = %s", got)
	}
}
