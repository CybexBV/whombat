package diagnose

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestMacCatalog(t *testing.T) {
	d := NewMac(nil, nil)
	d.root = t.TempDir()
	var names []string
	for _, c := range d.Catalog() {
		names = append(names, c.Name)
	}
	want := []string{"system", "processes", "ports", "services", "service", "logs", "disks", "smart", "network", "sensors", "updates", "power"}
	if !slices.Equal(names, want) {
		t.Errorf("catalog %v", names)
	}
	for _, c := range []proto.DiagnoseRequest{
		{Check: "logs", Args: map[string]string{"process": `sshd" OR 1==1`}},
		{Check: "logs", Args: map[string]string{"subsystem": "com.apple xpc"}},
		{Check: "logs", Args: map[string]string{"predicate": "1==1"}},
		{Check: "logs", Args: map[string]string{"grep": "("}},
		{Check: "service", Args: map[string]string{"name": "-x"}},
		{Check: "smart", Args: map[string]string{"device": "disk0s1"}},
		{Check: "smart", Args: map[string]string{"device": "disk0"}}, // not under this test's /dev
	} {
		if r := d.Run(context.Background(), c); r.Code != CodeInvalid {
			t.Errorf("%v: %+v", c, r)
		}
	}
	if r := d.Run(context.Background(), proto.DiagnoseRequest{Check: "zfs"}); r.Code != CodeUnsupported {
		t.Errorf("zfs: %+v", r)
	}
}

func TestMacLogArgv(t *testing.T) {
	now := time.Date(2026, 11, 17, 10, 0, 0, 0, time.FixedZone("CET", 3600))
	got := MacLogArgv(logQueryMac{}, now)
	if !slices.Equal(got, []string{"/usr/bin/log", "show", "--style", "syslog", "--last", "1h"}) {
		t.Errorf("default %q", got)
	}
	got = MacLogArgv(logQueryMac{process: "sshd-session", subsystem: "com.apple.xpc", since: now.Add(-30 * time.Minute).UTC()}, now)
	want := []string{"/usr/bin/log", "show", "--style", "syslog", "--start", "2026-11-17 09:30:00", "--predicate",
		`process == "sshd-session" AND subsystem == "com.apple.xpc"`}
	if !slices.Equal(got, want) {
		t.Errorf("filtered %q", got)
	}
}

func TestTailCommand(t *testing.T) {
	out, err := tailCommand(context.Background(), []string{"/bin/sh", "-c", "for i in 1 2 3 4 5 6; do echo line$i; echo other$i; done"},
		nil, func(l string) bool { return strings.HasPrefix(l, "line") }, 3, 10*time.Second)
	if err != nil || out != "line4\nline5\nline6\n" {
		t.Errorf("%q %v", out, err)
	}
	out, err = tailCommand(context.Background(), []string{"/bin/sh", "-c", "echo x; echo boom >&2; exit 3"}, nil, nil, 5, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "boom") || out != "x\n" {
		t.Errorf("%q %v", out, err)
	}
}

func TestMacExec(t *testing.T) {
	d := NewMac(nil, nil)
	d.home = t.TempDir()
	r := d.Exec(context.Background(), proto.ExecRequest{Command: `pwd; echo "$HOME|$PATH"`})
	if r.ExitCode != 0 || !strings.Contains(r.Output, d.home+"\n") ||
		!strings.Contains(r.Output, "/var/root|/usr/local/bin:/opt/homebrew/bin:") {
		t.Errorf("%+v", r)
	}
}
