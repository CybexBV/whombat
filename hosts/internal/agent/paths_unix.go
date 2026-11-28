//go:build !windows

package agent

// Default locations.
const (
	DefaultConfigDir = "/etc/whombat-agent"
	DefaultStateDir  = "/var/lib/whombat-agent"
)
