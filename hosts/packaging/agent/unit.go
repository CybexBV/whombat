// Package agentpkg exposes the agent's packaged files to the hub, so that
// install.sh writes the same systemd unit as the .deb.
package agentpkg

import (
	_ "embed"
	"strings"
)

//go:embed whombat-agent.service
var unit string

//go:embed rc.whombat-agent
var RCService string

//go:embed whombat-agent.openrc
var OpenRCService string

// Unit returns the systemd unit with the agent binary at binPath.
func Unit(binPath string) string {
	return strings.Replace(unit, "/usr/bin/whombat-agent", binPath, 1)
}
