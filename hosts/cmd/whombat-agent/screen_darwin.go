package main

import (
	"log/slog"

	"rackoon/internal/agent"
	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/macos"
	"rackoon/internal/agent/screen"
)

// wireScreen gives a Mac's agent its screen: the screen stream, the host's
// vnc console and still picture (the Mac broker's), the screen and helper
// parts of the report (the Mac collector's), and Whombat Helper's updates.
func wireScreen(rt *agent.Runtime, cfg *agent.Config, log *slog.Logger) {
	s := screen.New(screen.Options{ConfigDir: cfg.Dir, Log: log})
	s.Start()
	screen.SetDefault(s)
	rt.Screen = s
	rt.Helper = s // Whombat Helper's updates from the hub
	broker.SetMacScreen(screen.Console, screen.Thumbnail)
	macos.SetScreenStatus(screen.Status)
}
