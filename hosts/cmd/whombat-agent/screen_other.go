//go:build !darwin

package main

import (
	"log/slog"

	"rackoon/internal/agent"
)

// wireScreen: only a Mac has a screen the agent drives; the runtime answers
// the screen stream with unsupported.
func wireScreen(*agent.Runtime, *agent.Config, *slog.Logger) {}
