// Package hostinfo reads the boot id and the booted system without privileges.
package hostinfo

import (
	"os"
	"strings"
)

// Host reads /proc/sys/kernel/random/boot_id and /run/current-system (paths configurable).
type Host struct {
	BootIDPath        string
	CurrentSystemLink string
}

// BootID returns the kernel boot id.
func (h Host) BootID() (string, error) {
	b, err := os.ReadFile(h.BootIDPath)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// CurrentSystem returns the booted system store path.
func (h Host) CurrentSystem() (string, error) { return os.Readlink(h.CurrentSystemLink) }
