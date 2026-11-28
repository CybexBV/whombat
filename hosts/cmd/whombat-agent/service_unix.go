//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"rackoon/internal/agent"
)

// agentPIDFile is where the SysV and Unraid scripts' supervisor keeps its
// PID.
const agentPIDFile = "/run/whombat-agent.pid"

// isRoot: the commands that change the agent's own settings run as root.
func isRoot() bool { return os.Geteuid() == 0 }

// asRoot is how to run cmd as root.
func asRoot(cmd string) string { return "root: sudo " + cmd }

// restartAgent restarts the service of the agent of dir after its hub
// changed: launchd's job on a Mac, systemd's unit on Linux. false: neither
// runs it, the change applies when the agent restarts.
func restartAgent(dir string) (bool, error) {
	if filepath.Clean(dir) == agent.DefaultConfigDir && launchdLoaded() {
		if out, err := exec.Command(launchctlPath, "kickstart", "-k", launchdService).CombinedOutput(); err != nil {
			return false, fmt.Errorf("launchctl kickstart -k %s failed: %s", launchdService, strings.TrimSpace(string(out)))
		}
		return true, nil
	}
	if filepath.Clean(dir) == agent.DefaultConfigDir && systemdActive() {
		if out, err := exec.Command("systemctl", "restart", "whombat-agent.service").CombinedOutput(); err != nil {
			return false, fmt.Errorf("systemctl restart whombat-agent failed: %s", strings.TrimSpace(string(out)))
		}
		return true, nil
	}
	return false, nil
}

// reloadAgent makes the running agent of dir read agent.toml again:
// systemd's unit when it is active (the agent of /etc/whombat-agent), else
// SIGHUP to the supervisor in the PID file (SysV, Unraid), else to the
// agent processes of dir (OpenRC's supervise-daemon, by hand). false: no
// agent runs, the change applies when it starts.
func reloadAgent(dir string) (bool, error) {
	if filepath.Clean(dir) == agent.DefaultConfigDir && launchdLoaded() {
		// launchd hands the agent SIGHUP, which re-reads agent.toml (a
		// reload, as systemctl reload is on Linux).
		if out, err := exec.Command(launchctlPath, "kill", "SIGHUP", launchdService).CombinedOutput(); err != nil {
			return false, fmt.Errorf("launchctl kill SIGHUP %s: %s", launchdService, strings.TrimSpace(string(out)))
		}
		return true, nil
	}
	if filepath.Clean(dir) == agent.DefaultConfigDir && systemdActive() {
		if out, err := exec.Command("systemctl", "reload", "whombat-agent.service").CombinedOutput(); err != nil {
			return false, fmt.Errorf("systemctl reload whombat-agent: %s", strings.TrimSpace(string(out)))
		}
		return true, nil
	}
	agents := agent.FindAgents("/proc", dir, os.Getpid())
	if b, err := os.ReadFile(agentPIDFile); err == nil {
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		for _, a := range agents {
			if a.PID == pid && a.Supervisor {
				agents = []agent.AgentProcess{a}
				break
			}
		}
	}
	if len(agents) == 0 {
		return false, nil
	}
	n, err := agent.SignalReload(agents)
	if n == 0 {
		return false, err
	}
	return true, nil
}

// The agent's LaunchDaemon on a Mac, in launchd's system domain.
const (
	launchctlPath  = "/bin/launchctl"
	launchdService = "system/" + agent.LaunchdLabel
)

// launchdLoaded: a Mac whose launchd has the agent's LaunchDaemon loaded.
func launchdLoaded() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	return exec.Command(launchctlPath, "print", launchdService).Run() == nil
}

func systemdActive() bool {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return false
	}
	return exec.Command("systemctl", "is-active", "--quiet", "whombat-agent.service").Run() == nil
}
