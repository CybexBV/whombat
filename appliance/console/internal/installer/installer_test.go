package installer

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

const gib = int64(1) << 30

// lsblk output of an installer VM on Proxmox: the 128 GiB target, a small disk, the ISO on a USB stick (a
// hardware install), a disk with a mounted partition, one with LVM on it, a CD-ROM, zram.
const lsblkJSON = `{"blockdevices":[
 {"name":"sda","path":"/dev/sda","type":"disk","size":137438953472,"model":"QEMU HARDDISK   ","mountpoints":[null],"label":null,"fstype":null,"ro":false},
 {"name":"sdb","path":"/dev/sdb","type":"disk","size":4294967296,"model":"QEMU HARDDISK","mountpoints":[null],"label":null,"fstype":null,"ro":false},
 {"name":"sdc","path":"/dev/sdc","type":"disk","size":274877906944,"model":"USB\u001b[2J Stick","mountpoints":[null],"label":null,"fstype":"iso9660","ro":false,
  "children":[{"name":"sdc1","path":"/dev/sdc1","type":"part","size":2318368768,"model":null,"mountpoints":["/iso"],"label":"WHOMBAT-INSTALLER","fstype":"iso9660","ro":false}]},
 {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","size":512110190592,"model":"Samsung SSD","mountpoints":[null],"label":null,"fstype":null,"ro":false,
  "children":[{"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","size":1073741824,"model":null,"mountpoints":["/mnt/x"],"label":null,"fstype":"vfat","ro":false}]},
 {"name":"sdd","path":"/dev/sdd","type":"disk","size":549755813888,"model":null,"mountpoints":[null],"label":null,"fstype":"LVM2_member","ro":false,
  "children":[{"name":"vg-root","path":"/dev/mapper/vg-root","type":"lvm","size":549755813888,"model":null,"mountpoints":[null],"label":null,"fstype":"ext4","ro":false}]},
 {"name":"sde","path":"/dev/sde","type":"disk","size":549755813888,"model":"RO","mountpoints":[null],"label":null,"fstype":null,"ro":"1"},
 {"name":"sr0","path":"/dev/sr0","type":"rom","size":2318368768,"model":"QEMU DVD-ROM","mountpoints":["/iso"],"label":"WHOMBAT-INSTALLER","fstype":"iso9660","ro":false},
 {"name":"zram0","path":"/dev/zram0","type":"disk","size":4294967296,"model":null,"mountpoints":["[SWAP]"],"label":null,"fstype":"swap","ro":false}
]}`

// A dedicated machine (CG-34): the NVMe SSD, a SATA SSD sold as 120 GB, the installer on a USB stick, an external
// USB drive, eMMC with its read-only boot partitions.
const lsblkHardwareJSON = `{"blockdevices":[
 {"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","size":512110190592,"model":"Samsung SSD 980","mountpoints":[null],"label":null,"fstype":null,"ro":false,"tran":"nvme"},
 {"name":"sda","path":"/dev/sda","type":"disk","size":120034123776,"model":"KINGSTON SA400S37120G","mountpoints":[null],"label":null,"fstype":null,"ro":false,"tran":"sata"},
 {"name":"sdb","path":"/dev/sdb","type":"disk","size":30752636928,"model":"Ultra Fit","mountpoints":[null],"label":"WHOMBAT-INSTALLER","fstype":"iso9660","ro":false,"tran":"usb",
  "children":[{"name":"sdb1","path":"/dev/sdb1","type":"part","size":2707292160,"model":null,"mountpoints":["/iso"],"label":"WHOMBAT-INSTALLER","fstype":"iso9660","ro":false,"tran":null}]},
 {"name":"sdc","path":"/dev/sdc","type":"disk","size":2000398934016,"model":"Expansion HDD","mountpoints":[null],"label":null,"fstype":null,"ro":false,"tran":"usb"},
 {"name":"mmcblk0","path":"/dev/mmcblk0","type":"disk","size":125069950976,"model":null,"mountpoints":[null],"label":null,"fstype":null,"ro":false,"tran":null},
 {"name":"mmcblk0boot0","path":"/dev/mmcblk0boot0","type":"disk","size":4194304,"model":null,"mountpoints":[null],"label":null,"fstype":null,"ro":true,"tran":null}
]}`

func TestParseDisks(t *testing.T) {
	disks, err := ParseDisks([]byte(lsblkJSON), "WHOMBAT-INSTALLER")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Disk{}
	var names []string
	for _, d := range disks {
		got[d.Name] = d
		names = append(names, d.Name)
	}
	if strings.Join(names, " ") != "sda sdb sdc nvme0n1 sdd sde" {
		t.Fatalf("disks %v", names)
	}
	for name, want := range map[string]string{"sda": "", "sdb": "too-small", "sdc": "installer-medium", "nvme0n1": "in-use",
		"sdd": "in-use", "sde": "in-use"} {
		d := got[name]
		if d.Reason != want || d.Eligible != (want == "") {
			t.Errorf("%s: %+v, want %q", name, d, want)
		}
	}
	if d := got["sda"]; d.Path != "/dev/sda" || d.SizeBytes != 128*gib || d.Model != "QEMU HARDDISK" {
		t.Errorf("%+v", d)
	}
	if got["sdc"].Model != "USB[2J Stick" {
		t.Errorf("model not cleaned: %q", got["sdc"].Model)
	}
	hw, err := ParseDisks([]byte(lsblkHardwareJSON), "WHOMBAT-INSTALLER")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"nvme0n1": "", "sda": "", "sdb": "installer-medium", "sdc": "usb", "mmcblk0": "",
		"mmcblk0boot0": "in-use"}
	if len(hw) != len(want) {
		t.Fatalf("hardware disks %+v", hw)
	}
	for _, d := range hw {
		if w, ok := want[d.Name]; !ok || d.Reason != w || d.Eligible != (w == "") {
			t.Errorf("hardware %s: %+v, want %q", d.Name, d, w)
		}
	}
	// Exactly 110 GiB is enough, a byte less is not.
	one := `{"blockdevices":[{"name":"sda","path":"/dev/sda","type":"disk","size":118111600639,"mountpoints":[null]}]}`
	if d, _ := ParseDisks([]byte(one), "X"); d[0].Reason != "too-small" {
		t.Errorf("%+v", d)
	}
	one = `{"blockdevices":[{"name":"sda","path":"/dev/sda","type":"disk","size":118111600640,"mountpoints":[null]}]}`
	if d, _ := ParseDisks([]byte(one), "X"); !d[0].Eligible {
		t.Errorf("%+v", d)
	}
	for _, bad := range []string{`nope`, `{"blockdevices":[{"name":"x","path":"/etc/passwd","type":"disk","size":1}]}`} {
		d, err := ParseDisks([]byte(bad), "X")
		if err == nil && len(d) != 0 {
			t.Errorf("%s: %+v", bad, d)
		}
	}
}

func TestProgress(t *testing.T) {
	for line, want := range map[string]struct {
		step   string
		pct    int
		before string
		ok     bool
	}{
		"@@progress partition 0":                        {"partition", 0, "", true},
		"@@progress copy 57":                            {"copy", 57, "", true},
		"copying path '/nix/store/x'@@progress copy 12": {"copy", 12, "copying path '/nix/store/x'", true},
		"@@progress copy 101":                           {ok: false},
		"@@progress copy -1":                            {ok: false},
		"@@progress copy":                               {ok: false},
		"@@progress unpack 5":                           {ok: false},
		"@@progress copy 5 extra":                       {ok: false},
		"== partitioning /dev/sda":                      {ok: false},
	} {
		step, pct, before, ok := ParseProgress(line)
		if ok != want.ok || (ok && (step != want.step || pct != want.pct || before != want.before)) {
			t.Errorf("%q: %q %d %q %v", line, step, pct, before, ok)
		}
	}
	prev := -1
	for _, s := range Steps {
		for _, p := range []int{0, 50, 100} {
			o := Overall(s, p)
			if o < prev || o < 0 || o > 100 {
				t.Errorf("%s %d: %d after %d", s, p, o, prev)
			}
			prev = o
		}
	}
	if Overall("finish", 100) != 100 || Overall("partition", 0) != 0 {
		t.Error("ends")
	}
}

func TestShellDiskChecksUseTheSameSafetyExclusions(t *testing.T) {
	for _, path := range []string{"/dev/nvme0n1", "/dev/sda", "/dev/mmcblk0"} {
		if err := CheckDisk([]byte(lsblkHardwareJSON), path, "WHOMBAT-INSTALLER", MinDiskBytes); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/dev/sdb", "/dev/sdc", "/dev/mmcblk0boot0", "/dev/nvme0n1p1", "/dev/missing"} {
		if err := CheckDisk([]byte(lsblkHardwareJSON), path, "WHOMBAT-INSTALLER", MinDiskBytes); err == nil {
			t.Fatalf("unsafe target accepted: %s", path)
		}
	}
	for _, path := range []string{"/dev/nvme0n1", "/dev/sdd", "/dev/sde"} {
		if err := CheckDisk([]byte(lsblkJSON), path, "WHOMBAT-INSTALLER", MinDiskBytes); err == nil {
			t.Fatalf("busy target accepted: %s", path)
		}
	}
	// A factory test's smaller layout still obeys its own minimum; production's
	// 110 GiB rule and a custom layout that won't fit both refuse before wiping.
	if err := CheckDisk([]byte(lsblkJSON), "/dev/sdb", "WHOMBAT-INSTALLER", 3*gib); err != nil {
		t.Fatal(err)
	}
	if err := CheckDisk([]byte(lsblkJSON), "/dev/sda", "WHOMBAT-INSTALLER", 129*gib); err == nil {
		t.Fatal("layout exceeds disk")
	}
}

func TestImage(t *testing.T) {
	im, err := ParseImage([]byte(`{"v":1,"platform":"self-installed","storage":"host-encrypted","environment":"local","release":"whombat-20261021.1",
		"appUrl":"https://dev.whombat.com","hosts":{"api":"api-dev.whombat.com","updates":"updates-dev.whombat.com","relay":"relay\u001b.x"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if im.Environment != "dev" || *im.Release != "whombat-20261021.1" || im.AppURL != "dev.whombat.com" || im.Hosts.API != "api-dev.whombat.com" ||
		im.Hosts.Relay != "" {
		t.Fatalf("%+v", im)
	}
	im, err = ParseImage([]byte(`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","release":null,"appUrl":"https://app.whombat.com/","hosts":{}}`))
	if err != nil || im.Environment != "prod" || im.Release != nil || im.AppURL != "app.whombat.com" {
		t.Fatalf("%+v %v", im, err)
	}
	for _, bad := range []string{
		`{"v":2,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":"https://a.b"}`,
		`{"v":1,"platform":"pi","storage":"luks-tpm2","environment":"prod","appUrl":"https://a.b"}`,
		`{"v":1,"platform":"factory","storage":"plain","environment":"dev","appUrl":"https://a.b"}`,
		`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"staging","appUrl":"https://a.b"}`,
		`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":"javascript:x"}`,
		`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":"https://a.b","release":"a b"}`,
		`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":"https://a.b","edition":"open"}`,
		`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":""}`,
	} {
		if _, err := ParseImage([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

// A community image (NX-445): no Whombat service or relay to reach, so no checks for them.
func TestCommunityChecks(t *testing.T) {
	im, err := ParseImage([]byte(`{"v":1,"platform":"self-installed","storage":"host-encrypted","environment":"dev","release":"whombat-community-20261024.1",
		"appUrl":"","edition":"community","hosts":{"api":"","updates":"updates.example.test","relay":""}}`))
	if err != nil || im.Edition != "community" || im.AppURL != "" {
		t.Fatalf("%+v %v", im, err)
	}
	if im, _ := ParseImage([]byte(`{"v":1,"platform":"factory","storage":"luks-tpm2","environment":"prod","appUrl":"https://a.b"}`)); im.Edition != "commercial" {
		t.Fatalf("%+v", im)
	}
	srv := New(t.Context(), im, "WHOMBAT-INSTALLER", newFake())
	srv.addrWait = 50 * time.Millisecond
	srv.StartPreflight()
	waitFor(t, "the checks", func() bool { return srv.State().Preflight.Status == "done" })
	var ids []string
	for _, c := range srv.State().Preflight.Checks {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "uefi,cpu,memory,disk,network,reach-updates" {
		t.Fatal(ids)
	}
}

func TestMemory(t *testing.T) {
	b, err := ParseMemTotal([]byte("MemTotal:        8130212 kB\nMemFree: 1 kB\n"))
	if err != nil || b != 8130212*1024 {
		t.Fatal(b, err)
	}
	// An 8 GiB VM (the qualified size) reports ~7.75 GiB and passes; a 4 GiB one warns; 3 GiB fails.
	for kb, want := range map[uint64]int{8130212: 8, 3995000: 4, 2900000: 3, 16300000: 16} {
		if got := MemoryGiB(kb * 1024); got != want {
			t.Errorf("%d kB: %d", kb, got)
		}
	}
}

// ---- the state machine with a fake machine ------------------------------------------------------------

type fakeSystem struct {
	mu       sync.Mutex
	uefi     bool
	cpus     int
	mem      uint64
	lsblk    string
	addr     string
	wired    string
	reach    map[string]bool
	installs []string
	jobs     []Job
	profiles []string      // the profiles' contents as whombat-install found them
	script   []string      // lines the fake whombat-install prints
	fail     error         // its result
	gate     chan struct{} // held open to keep it running
	rebooted chan struct{}
	lsblkErr error
}

func newFake() *fakeSystem {
	return &fakeSystem{uefi: true, cpus: 4, mem: 8130212 * 1024, lsblk: lsblkJSON, addr: "192.168.1.23", wired: "192.168.1.23",
		reach: map[string]bool{"api.whombat.com": true, "updates.whombat.com": true, "relay.whombat.com": true},
		script: []string{"== installing Whombat on /dev/sda", "@@progress partition 0", "== partitioning /dev/sda",
			"@@progress partition 100", "@@progress filesystems 100", "@@progress copy 50", "copying path '/nix/store/x'",
			"@@progress copy 100", "@@progress boot 100", "@@progress finish 100", "== done: remove the installer medium and restart"},
		rebooted: make(chan struct{}, 1)}
}

func (f *fakeSystem) UEFI() bool                   { return f.uefi }
func (f *fakeSystem) CPUs() int                    { return f.cpus }
func (f *fakeSystem) MemoryBytes() (uint64, error) { return f.mem, nil }
func (f *fakeSystem) BlockDevices(context.Context) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return []byte(f.lsblk), f.lsblkErr
}
func (f *fakeSystem) Address() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addr
}
func (f *fakeSystem) WiredAddress() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.wired
}
func (f *fakeSystem) Reach(_ context.Context, host string) error {
	if f.reach[host] {
		return nil
	}
	return errors.New("unreachable")
}
func (f *fakeSystem) Install(ctx context.Context, job Job, line func(string)) error {
	f.mu.Lock()
	f.installs = append(f.installs, job.Disk)
	f.jobs = append(f.jobs, job)
	if job.WifiProfile != "" {
		b, _ := os.ReadFile(job.WifiProfile)
		f.profiles = append(f.profiles, string(b))
	}
	gate := f.gate
	f.mu.Unlock()
	for i, l := range f.script {
		line(l)
		if i == 5 && gate != nil {
			<-gate
		}
	}
	return f.fail
}
func (f *fakeSystem) Reboot() error { f.rebooted <- struct{}{}; return nil }

var testImage = Image{Platform: "self-installed", Storage: "host-encrypted", Environment: "prod", AppURL: "app.whombat.com",
	Hosts: Hosts{API: "api.whombat.com", Updates: "updates.whombat.com", Relay: "relay.whombat.com"}}

type harness struct {
	srv *Server
	sys *fakeSystem
	h   http.Handler
}

func newHarness(t *testing.T, sys *fakeSystem) *harness {
	t.Helper()
	srv := New(t.Context(), testImage, "WHOMBAT-INSTALLER", sys)
	srv.addrWait = 50 * time.Millisecond
	h := web.Handler(web.Options{Port: 8412, Token: "tok-abcdefgh", UI: fstest.MapFS{"index.html": {Data: []byte("x")}},
		API: srv.Handler(), MaxBody: 4096})
	return &harness{srv: srv, sys: sys, h: h}
}

func (hs *harness) do(method, path, body string) (int, map[string]any) {
	r := httptest.NewRequest(method, "http://127.0.0.1:8412"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer tok-abcdefgh")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	hs.h.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (hs *harness) preflight(t *testing.T) State {
	t.Helper()
	if code, _ := hs.do("POST", "/api/preflight", ""); code != http.StatusAccepted {
		t.Fatalf("preflight: %d", code)
	}
	waitFor(t, "the checks", func() bool { return hs.srv.State().Preflight.Status == "done" })
	return hs.srv.State()
}

func checks(st State) map[string]Check {
	out := map[string]Check{}
	for _, c := range st.Preflight.Checks {
		out[c.ID] = c
	}
	return out
}

func TestChecks(t *testing.T) {
	hs := newHarness(t, newFake())
	st := hs.srv.State()
	if st.Mode != "installer" || st.Preflight.Status != "done" || len(st.Preflight.Checks) != 0 || st.Install.Status != "idle" {
		t.Fatalf("%+v", st)
	}
	st = hs.preflight(t)
	var ids []string
	for _, c := range st.Preflight.Checks {
		ids = append(ids, c.ID)
	}
	// Whombat Link is the default choice: control and the relay, no Tailscale login server.
	if strings.Join(ids, ",") != "uefi,cpu,memory,disk,network,reach-api,reach-updates,reach-relay" {
		t.Fatalf("%v", ids)
	}
	c := checks(st)
	for id, want := range map[string]Check{
		"uefi": {Status: "ok", Value: "UEFI"}, "cpu": {Status: "ok", Value: "4 cores"}, "memory": {Status: "ok", Value: "8 GiB"},
		"disk": {Status: "ok", Value: "sda"}, "network": {Status: "ok", Value: "192.168.1.23"},
		"reach-api": {Status: "ok", Value: "api.whombat.com"}, "reach-relay": {Status: "ok", Value: "relay.whombat.com"},
	} {
		if c[id].Status != want.Status || c[id].Value != want.Value {
			t.Errorf("%s: %+v", id, c[id])
		}
	}
	if len(st.Preflight.Disks) != 6 {
		t.Errorf("disks %+v", st.Preflight.Disks)
	}

	// Thresholds.
	f := newFake()
	f.uefi, f.cpus, f.mem, f.addr = false, 1, 3000000*1024, ""
	f.reach = map[string]bool{}
	f.lsblk = `{"blockdevices":[{"name":"sda","path":"/dev/sda","type":"disk","size":68719476736,"mountpoints":[null]}]}`
	c = checks(newHarness(t, f).preflight(t))
	for id, want := range map[string]string{"uefi": "fail", "cpu": "fail", "memory": "fail", "disk": "fail", "network": "warn",
		"reach-api": "warn", "reach-updates": "warn", "reach-relay": "warn"} {
		if c[id].Status != want {
			t.Errorf("%s: %+v, want %s", id, c[id], want)
		}
	}
	if c["cpu"].Value != "1 core" || c["uefi"].Value != "BIOS" || c["disk"].Value != "" {
		t.Errorf("%+v", c)
	}
	f = newFake()
	f.cpus, f.mem = 2, 4000000*1024
	c = checks(newHarness(t, f).preflight(t))
	if c["cpu"].Status != "warn" || c["memory"].Status != "warn" {
		t.Errorf("%+v", c)
	}
	// An image without a relay host warns without a value.
	f = newFake()
	hs = newHarness(t, f)
	hs.srv.image.Hosts.Relay = ""
	if c := checks(hs.preflight(t)); c["reach-relay"].Status != "warn" || c["reach-relay"].Value != "" {
		t.Errorf("%+v", c["reach-relay"])
	}
}

func TestInstallFlow(t *testing.T) {
	f := newFake()
	f.gate = make(chan struct{})
	hs := newHarness(t, f)
	// Nothing before the checks ran.
	if code, out := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != 400 || out["message"] != "check-failed" {
		t.Fatalf("%d %v", code, out)
	}
	hs.preflight(t)
	for body, want := range map[string]string{
		`{"disk":"/dev/sda","confirm":"sdb"}`:         "confirm",
		`{"disk":"/dev/sda","confirm":"SDA"}`:         "confirm",
		`{"disk":"/dev/sda","confirm":""}`:            "confirm",
		`{"disk":"/dev/sdb","confirm":"sdb"}`:         "not-eligible", // too small
		`{"disk":"/dev/sdc","confirm":"sdc"}`:         "not-eligible", // the installer medium
		`{"disk":"/dev/nvme0n1","confirm":"nvme0n1"}`: "not-eligible", // in use
		`{"disk":"/dev/sr0","confirm":"sr0"}`:         "not-eligible", // not listed
		`{"disk":"/etc/passwd","confirm":"passwd"}`:   "not-eligible",
	} {
		if code, out := hs.do("POST", "/api/install", body); code != 400 || out["message"] != want {
			t.Errorf("%s: %d %v", body, code, out)
		}
	}
	if code, _ := hs.do("POST", "/api/install", `{"disk":`); code != 400 {
		t.Errorf("broken json: %d", code)
	}
	if code, _ := hs.do("POST", "/api/restart", ""); code != http.StatusConflict {
		t.Errorf("restart before the install: %d", code)
	}
	if len(f.installs) != 0 {
		t.Fatal("installed")
	}
	// Go.
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatalf("install: %d", code)
	}
	waitFor(t, "the copy", func() bool { st := hs.srv.State(); return st.Install.Step != nil && *st.Install.Step == "copy" })
	st := hs.srv.State()
	if st.Install.Status != "running" || *st.Install.Disk != "/dev/sda" || st.Install.Percent != Overall("copy", 50) {
		t.Fatalf("%+v", st.Install)
	}
	// Double install, pre-flight and restart while it runs: 409.
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusConflict {
		t.Errorf("second install: %d", code)
	}
	if code, _ := hs.do("POST", "/api/preflight", ""); code != http.StatusConflict {
		t.Errorf("preflight while installing: %d", code)
	}
	if code, _ := hs.do("POST", "/api/restart", ""); code != http.StatusConflict {
		t.Errorf("restart while installing: %d", code)
	}
	close(f.gate)
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	st = hs.srv.State()
	if st.Install.Percent != 100 || *st.Install.Step != "finish" || st.Install.Error != "" {
		t.Fatalf("%+v", st.Install)
	}
	// The log has the human lines only, in order.
	if strings.Join(st.Install.Log, "|") != "== installing Whombat on /dev/sda|== partitioning /dev/sda|copying path '/nix/store/x'|== done: remove the installer medium and restart" {
		t.Fatalf("%q", st.Install.Log)
	}
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusConflict {
		t.Errorf("install after done: %d", code)
	}
	if len(f.installs) != 1 {
		t.Fatalf("installs %v", f.installs)
	}
	if code, _ := hs.do("POST", "/api/restart", ""); code != http.StatusAccepted {
		t.Fatalf("restart: %d", code)
	}
	select {
	case <-f.rebooted:
	case <-time.After(3 * time.Second):
		t.Fatal("no reboot")
	}
}

func TestInstallRefusals(t *testing.T) {
	// A failed check blocks; a warning doesn't.
	f := newFake()
	f.uefi = false
	hs := newHarness(t, f)
	hs.preflight(t)
	if code, out := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != 400 || out["message"] != "check-failed" {
		t.Fatalf("%d %v", code, out)
	}
	f = newFake()
	f.reach, f.addr = map[string]bool{}, ""
	hs = newHarness(t, f)
	hs.preflight(t)
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatalf("warnings blocked the install: %d", code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })

	// The disk got mounted after the checks: looked up again, refused, and the list is updated.
	f = newFake()
	hs = newHarness(t, f)
	hs.preflight(t)
	f.mu.Lock()
	f.lsblk = strings.Replace(lsblkJSON, `"size":137438953472,"model":"QEMU HARDDISK   ","mountpoints":[null]`,
		`"size":137438953472,"model":"QEMU HARDDISK   ","mountpoints":["/mnt"]`, 1)
	f.mu.Unlock()
	if code, out := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != 400 || out["message"] != "not-eligible" {
		t.Fatalf("%d %v", code, out)
	}
	st := hs.srv.State()
	if st.Install.Status != "idle" || st.Preflight.Disks[0].Reason != "in-use" || len(f.installs) != 0 {
		t.Fatalf("%+v", st)
	}
	// While the checks run: 409.
	f = newFake()
	hs = newHarness(t, f)
	hs.srv.mu.Lock()
	hs.srv.preflight.Status = "running"
	hs.srv.mu.Unlock()
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusConflict {
		t.Fatalf("during the checks: %d", code)
	}
}

func TestInstallFails(t *testing.T) {
	f := newFake()
	f.script = []string{"== installing Whombat on /dev/sda", "@@progress partition 0", "== partitioning /dev/sda",
		"@@progress partition 100", "mkfs.vfat: unable to open /dev/disk/by-partlabel/whombat-esp", ""}
	f.fail = errors.New("whombat-install: exit status 1")
	hs := newHarness(t, f)
	hs.preflight(t)
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "failed", func() bool { return hs.srv.State().Install.Status == "failed" })
	st := hs.srv.State()
	if st.Install.Error != "mkfs.vfat: unable to open /dev/disk/by-partlabel/whombat-esp" || st.Install.Percent != Overall("partition", 100) {
		t.Fatalf("%+v", st.Install)
	}
	if code, _ := hs.do("POST", "/api/restart", ""); code != http.StatusConflict {
		t.Errorf("restart after a failure: %d", code)
	}
	// Try again: the checks can run again, and so can the install.
	hs.preflight(t)
	f.fail = nil
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	if st := hs.srv.State(); st.Install.Error != "" || len(f.installs) != 2 {
		t.Fatalf("%+v", st.Install)
	}
}

func TestLogBounded(t *testing.T) {
	hs := newHarness(t, newFake())
	for i := range 500 {
		hs.srv.line(strings.Repeat("x", i) + "\u001b[2J")
	}
	st := hs.srv.State()
	if len(st.Install.Log) != logLines {
		t.Fatal(len(st.Install.Log))
	}
	for _, l := range st.Install.Log {
		if strings.ContainsRune(l, 0x1b) || len([]rune(l)) > logLineRunes+1 {
			t.Fatalf("%q", l)
		}
	}
}

func TestReadLines(t *testing.T) {
	var got []string
	ReadLines(strings.NewReader("a\n\nb\n"+strings.Repeat("c", 70000)+"\nd"), func(l string) { got = append(got, l) })
	if len(got) != 5 || got[0] != "a" || got[1] != "" || got[2] != "b" || len(got[3]) != 64<<10 || got[4] != "d" {
		t.Fatalf("%d %q", len(got), got[:3])
	}
}
