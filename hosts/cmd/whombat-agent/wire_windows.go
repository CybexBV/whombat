package main

import (
	"log/slog"

	"rackoon/internal/agent"
	"rackoon/internal/agent/winpc"
)

// wireAgent gives the runtime a Windows PC's collector, broker and
// diagnostics (no disk usage scans: Windows has its own tools for that).
func wireAgent(rt *agent.Runtime, cfg *agent.Config, log *slog.Logger) {
	c := winpc.New(cfg, version)
	rt.Collector = c
	rt.Broker = winpc.NewBroker(log, c.Updates)
	rt.Diagnostics = winpc.NewDiagnostics(cfg.StateDir, log)
}

// newCollector is the collector `whombat-agent collect` reads once.
func newCollector(cfg *agent.Config) agent.Collector {
	return winpc.New(cfg, version)
}
