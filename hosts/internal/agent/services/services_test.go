package services

import (
	"os"
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

func TestSystemdJSONAndUnitFiles(t *testing.T) {
	units, err := ParseSystemctlJSON(testdata(t, "systemctl_units.json"))
	if err != nil || len(units) != 8 {
		t.Fatalf("%v %d", err, len(units))
	}
	ApplyUnitFiles(units, ParseUnitFiles(testdata(t, "systemctl_unit_files.txt")))
	Sort(units)
	if units[0].Name != "backup-export.service" || units[1].Name != "nix-gc.service" || units[2].Name != "apparmor.service" {
		t.Errorf("order: %s %s %s", units[0].Name, units[1].Name, units[2].Name)
	}
	m := map[string]proto.Service{}
	for _, u := range units {
		m[u.Name] = u
	}
	if m["getty@tty1.service"].Enabled != "enabled" || m["nix-gc.service"].Enabled != "disabled" || m["apt-daily.timer"].Sub != "waiting" {
		t.Errorf("enabled: %+v", m)
	}
	if m["connman.service"].Load != "not-found" || m["connman.service"].Enabled != "" {
		t.Errorf("connman: %+v", m["connman.service"])
	}
}

func TestSystemdPlain(t *testing.T) {
	s := ParseSystemctlPlain(testdata(t, "systemctl_failed.txt"))
	if len(s) != 3 || s[2].Name != "run-r1a2b3c4.service" || s[0].Description != "Export and back up all instances" || s[1].Active != "failed" {
		t.Errorf("%+v", s)
	}
}

func TestStateChange(t *testing.T) {
	boot := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	m := ParseStateChange([]byte("Id=nix-gc.service\nStateChangeTimestampMonotonic=3600000000\n\nId=x.service\nStateChangeTimestampMonotonic=0\n"), boot)
	if !m["nix-gc.service"].Equal(boot.Add(time.Hour)) || len(m) != 1 {
		t.Errorf("%v", m)
	}
}

func TestOpenRC(t *testing.T) {
	s := ParseRCStatus(testdata(t, "rc_status.txt"))
	Sort(s)
	m := map[string]proto.Service{}
	for _, x := range s {
		m[x.Name] = x
	}
	if s[0].Name != "nginx" || s[0].Active != "failed" {
		t.Errorf("failed first: %+v", s[0])
	}
	if m["sshd"].Active != "active" || m["sshd"].Enabled != "enabled" || m["docker"].Enabled != "disabled" || m["killprocs"].Active != "inactive" {
		t.Errorf("%+v", m)
	}
	if len(s) != 9 {
		t.Errorf("services: %d", len(s))
	}
}

func TestInitSystem(t *testing.T) {
	dir := t.TempDir()
	if initSystem(dir) != SysV {
		t.Error("empty root")
	}
	os.MkdirAll(filepath.Join(dir, "run/systemd/system"), 0o755)
	if initSystem(dir) != Systemd {
		t.Error("systemd")
	}
	os.MkdirAll(filepath.Join(dir, "etc"), 0o755)
	os.WriteFile(filepath.Join(dir, "etc/unraid-version"), []byte("version=\"7.1.4\"\n"), 0o644)
	if initSystem(dir) != Unraid {
		t.Error("unraid")
	}
}
