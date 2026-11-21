package fakefleet

import (
	"time"

	"rackoon/internal/proto"
)

// PackageState is a host's operating-system updates as the report shows
// them: the drifting counts until rackoon-sim's package tasks (check,
// install) change them, the running task and the last one.
type PackageState struct {
	Pending, Security int
	CheckedAt         time.Time
	Reboot            bool
	RebootReason      string
	Task              *proto.PackageTask
	Last              *proto.PackageLast
}

// packagesLocked is the state at t (caller holds h.mu).
func (h *Host) packagesLocked(t time.Time) PackageState {
	if h.pkgs != nil {
		return *h.pkgs
	}
	hv := hash(h.ID)
	ps := PackageState{Pending: int(hv % 23), Security: int(hv % 4), CheckedAt: t.Truncate(6 * time.Hour)}
	if h.ID == "onyx" || h.ID == "flint" {
		ps.Reboot, ps.RebootReason = true, "Kernel 6.12.111+deb13-amd64 is installed, 6.12.107+deb13-amd64 runs"
	}
	return ps
}

// Packages is the host's package state now.
func (h *Host) Packages() PackageState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.packagesLocked(time.Now().UTC())
}

// UpdatePackages changes the host's package state (rackoon-sim's package
// tasks); it starts from the drifting counts of now.
func (h *Host) UpdatePackages(f func(ps *PackageState)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ps := h.packagesLocked(time.Now().UTC())
	f(&ps)
	h.pkgs = &ps
}
