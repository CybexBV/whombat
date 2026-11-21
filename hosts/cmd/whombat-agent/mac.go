package main

import (
	"log/slog"
	"os"
	"runtime"

	"rackoon/internal/agent"
	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/diagnose"
	"rackoon/internal/agent/diskusage"
	"rackoon/internal/agent/macos"
)

// wireMac sets up the agent of a Mac: macOS's collector, broker and
// diagnostics. The screen (Report.MacOS.Screen and .Helper, the host's
// vnc console and its still picture) comes from the screen package, which
// installs itself with macos.SetScreenStatus and broker.SetMacScreen.
func wireMac(rt *agent.Runtime, cfg *agent.Config, log *slog.Logger) {
	mc := macos.New(cfg, version)
	rt.Collector = mc
	br := broker.NewMacBroker(cfg, log, rt.RefreshPackages)
	rt.Broker = br
	rt.Diagnostics = diagnose.NewMac(br.Inspect, log)
	rt.DiskUsage = diskusage.New(rt.Inventory, log)
}

// restartByExit: on a Mac launchd started, the agent restarts by exiting
// (its LaunchDaemon keeps it alive) rather than by re-executing itself.
func restartByExit() bool {
	return isLaunchd()
}

// isLaunchd: a Mac's agent started by launchd (PID 1) from its
// LaunchDaemon.
func isLaunchd() bool {
	if os.Getppid() != 1 {
		return false
	}
	_, err := os.Stat(agent.LaunchdPlist)
	return err == nil && runtime.GOOS == "darwin"
}
