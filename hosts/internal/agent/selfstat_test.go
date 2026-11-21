package agent

import (
	"os/exec"
	"testing"
)

// Child process CPU time counts toward the agent's own CPU use.
func TestSelfStatsCountsChildren(t *testing.T) {
	before, ok := CPUTimeWithChildren()
	if !ok {
		t.Fatal("getrusage failed")
	}
	// A child that burns some CPU, waited for.
	if err := exec.Command("sh", "-c", "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done").Run(); err != nil {
		t.Skip("no sh:", err)
	}
	after, _ := CPUTimeWithChildren()
	if after-before <= 0 {
		t.Fatalf("child CPU not counted: %v -> %v", before, after)
	}
}

func TestDetectInstall(t *testing.T) {
	env := func(kv map[string]string) func(string) string { return func(k string) string { return kv[k] } }
	none := env(nil)
	for _, c := range []struct {
		name string
		e    installEnv
		want string
	}{
		{"unraid dir", installEnv{configDir: "/boot/config/plugins/whombat-agent", env: none, parentCmdline: []string{"/usr/local/bin/whombat-agent", "supervise"}}, InstallUnraid},
		{"unraid host", installEnv{configDir: "/etc/whombat-agent", env: none, unraid: true}, InstallUnraid},
		{"systemd", installEnv{configDir: "/etc/whombat-agent", env: env(map[string]string{"INVOCATION_ID": "abc"})}, InstallSystemd},
		{"openrc env", installEnv{configDir: "/etc/whombat-agent", env: env(map[string]string{"RC_SVCNAME": "whombat-agent"})}, InstallOpenRC},
		{"openrc parent", installEnv{configDir: "/etc/whombat-agent", env: none, parentComm: "supervise-daemon"}, InstallOpenRC},
		{"sysv", installEnv{configDir: "/etc/whombat-agent", env: none, parentCmdline: []string{"/usr/local/bin/whombat-agent", "supervise", "--config-dir", "/etc/whombat-agent"}}, InstallSysV},
		{"systemd without env", installEnv{configDir: "/etc/whombat-agent", env: none, parentPID: 1, pid1Comm: "systemd", unitExists: true}, InstallSystemd},
		{"shell", installEnv{configDir: "/etc/whombat-agent", env: none, parentPID: 4242, parentComm: "bash", pid1Comm: "systemd", unitExists: true}, InstallManual},
		{"launchd", installEnv{configDir: "/etc/whombat-agent", env: none, parentPID: 1, darwin: true, launchdPlist: true}, InstallLaunchd},
		{"mac by hand", installEnv{configDir: "/etc/whombat-agent", env: none, parentPID: 4242, darwin: true, launchdPlist: true}, InstallManual},
		{"mac without the daemon", installEnv{configDir: "/etc/whombat-agent", env: none, parentPID: 1, darwin: true}, InstallManual},
	} {
		if got := detectInstall(c.e); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
