//go:build !windows

package main

import (
	"log/slog"
	"runtime"

	"rackoon/internal/agent"
	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/collect"
	"rackoon/internal/agent/diagnose"
	"rackoon/internal/agent/diskusage"
	"rackoon/internal/agent/macos"
)

// wireAgent gives the runtime its collector, broker, diagnostics and disk
// usage: a Mac's, else Linux's.
func wireAgent(rt *agent.Runtime, cfg *agent.Config, log *slog.Logger) {
	if runtime.GOOS == "darwin" {
		wireMac(rt, cfg, log)
		return
	}
	rt.Collector = collect.New(cfg, version)
	br := broker.NewBroker(cfg, rt.Inventory, log)
	br.OnUnraidChange = rt.RefreshUnraid
	br.OnPackageChange = rt.RefreshPackages
	rt.Broker = br
	rt.Diagnostics = diagnose.New(br.Inspect, log)
	rt.DiskUsage = diskusage.New(rt.Inventory, log)
}

// newCollector is the collector `whombat-agent collect` reads once.
func newCollector(cfg *agent.Config) agent.Collector {
	if runtime.GOOS == "darwin" {
		return macos.New(cfg, version)
	}
	return collect.New(cfg, version)
}
