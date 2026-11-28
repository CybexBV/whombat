//go:build !windows

package main

import (
	"os"

	"rackoon/internal/agent"
	"rackoon/internal/agent/screen"
)

// cmdScreen runs one screen step on this Mac, without a hub, for trying it
// over ssh (as root).
func cmdScreen(args []string) error {
	return screen.CLI(args, agent.DefaultConfigDir, os.Stdout, newLogger("warn"))
}

func screenUsage() string { return screen.CLIUsage }
