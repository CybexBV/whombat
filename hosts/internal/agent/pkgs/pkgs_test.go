package pkgs

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func testdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func byName(us []proto.PackageUpdate) map[string]proto.PackageUpdate {
	m := map[string]proto.PackageUpdate{}
	for _, u := range us {
		m[u.Name] = u
	}
	return m
}

func TestParseAptSimulate(t *testing.T) {
	ups := ParseAptSimulate(testdata(t, "apt_simulate.txt"))
	// 17 upgrades (+1 Ubuntu line); the 2 new installs are dependencies.
	if len(ups) != 18 {
		t.Fatalf("got %d updates: %+v", len(ups), ups)
	}
	m := byName(ups)
	if _, ok := m["golang-1.27-go"]; ok {
		t.Error("new install counted as an update")
	}
	c := m["chromium"]
	if c.Current != "154.0.8037.92-1~deb13u1" || c.New != "155.0.8059.39-1~deb13u1" || !c.Security || c.Source != "Debian-Security:13/stable-security" {
		t.Errorf("chromium: %+v", c)
	}
	d := m["docker-ce"]
	if d.Security || d.Source != "Docker CE:trixie" || d.New != "5:29.9.0-1~debian.13~trixie" {
		t.Errorf("docker-ce: %+v", d)
	}
	if u := m["libssl3t64"]; !u.Security || u.Source != "Ubuntu:24.04/noble-security" {
		t.Errorf("ubuntu security from the second origin: %+v", u)
	}
	n := 0
	for _, u := range ups {
		if u.Security {
			n++
		}
	}
	if n != 7 {
		t.Errorf("security updates: %d, want 7", n)
	}
}

func TestParseRPM(t *testing.T) {
	ups := ParseCheckUpdate(testdata(t, "dnf_check_update.txt"))
	m := byName(ups)
	if len(ups) != 4 || m["openssl-libs"].New != "1:3.2.2-9.fc41" || m["kernel"].Source != "updates" {
		t.Fatalf("check-update: %+v", ups)
	}
	if _, ok := m["grub2-tools-efi"]; ok {
		t.Error("obsoleting section parsed as updates")
	}
	sec := ParseUpdateinfo(testdata(t, "dnf_updateinfo_security.txt"))
	if !sec["openssl-libs"] || !sec["kernel-core"] || sec["kernel"] || len(sec) != 2 {
		t.Errorf("updateinfo: %v", sec)
	}
	if rpmName("python3-requests-2.32.3-3.fc41.noarch") != "python3-requests" {
		t.Error("rpmName")
	}
}

func TestParseOthers(t *testing.T) {
	z := ParseZypper(testdata(t, "zypper_lu.txt"))
	if len(z) != 2 || z[0].Name != "curl" || z[0].Current != "8.6.0-150600.4.6.1" || z[0].New != "8.6.0-150600.4.9.1" || z[0].Source != "repo-sle-update" {
		t.Errorf("zypper: %+v", z)
	}
	a := byName(ParseAPK(testdata(t, "apk_version.txt")))
	if len(a) != 3 || a["py3-cryptography"].Current != "42.0.8-r0" || a["py3-cryptography"].New != "42.0.8-r1" || a["busybox"].New != "1.36.1-r31" {
		t.Errorf("apk: %+v", a)
	}
	p := ParsePacman(testdata(t, "pacman_qu.txt"))
	if len(p) != 2 || p[0].Name != "linux" || p[0].Current != "6.17.1.arch1-1" || p[0].New != "6.17.2.arch1-1" {
		t.Errorf("pacman: %+v", p)
	}
}

func TestSortSecurityFirst(t *testing.T) {
	u := []proto.PackageUpdate{{Name: "b"}, {Name: "a"}, {Name: "z", Security: true}}
	sortUpdates(u)
	if u[0].Name != "z" || u[1].Name != "a" {
		t.Errorf("%+v", u)
	}
	r := Result{Updates: u}
	if r.Security() != 1 {
		t.Error("Security count")
	}
}

// pacman -Qu exits 1 with no output when nothing is upgradable; dnf
// check-update exits 100 when there are updates. Both are not errors.
func TestExitCodes(t *testing.T) {
	err := exec.Command("sh", "-c", "exit 100").Run()
	if exitCode(err) != 100 {
		t.Fatalf("exitCode %d", exitCode(err))
	}
	if exitCode(errors.New("x")) != -1 {
		t.Fatal("exitCode of a plain error")
	}
	old := run
	defer func() { run = old }()
	run = func(ctx context.Context, _ time.Duration, name string, args ...string) ([]byte, error) {
		out := testdata(t, "dnf_check_update.txt")
		return out, exec.Command("sh", "-c", "exit 100").Run()
	}
	ups, err := checkRPM(context.Background(), DNF)
	if err != nil || len(ups) != 4 {
		t.Fatalf("checkRPM: %v %d", err, len(ups))
	}
}

func TestStamp(t *testing.T) {
	if Stamp("nonexistent") != "" {
		t.Error("stamp of unknown manager")
	}
}
