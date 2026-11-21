package fakefleet

import (
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Guest management parts of the fake fleet (docs/MANAGE.md): tags,
// pending changes, guest agents, snapshots, backup jobs, HA and templates
// on shale, and the methods cmd/rackoon-sim changes guests with. Like
// addHealth they are left out of the exact fixture.

// seedShaleManage fills in shale's management extras, matching the
// configurations of web/dev/fixtures/manage.ts.
func seedShaleManage(h *Host) {
	tags := map[int]string{100: "k3s;prod", 101: "build;windows", 102: "k3s;prod", 103: "db;prod", 104: "ci", 105: "network",
		106: "home", 107: "lab", 200: "monitoring", 201: "edge;web", 202: "secrets"}
	snap := Ref.Add(-45 * 24 * time.Hour)
	for i := range h.Guests {
		g := &h.Guests[i]
		if t, ok := tags[g.VMID]; ok {
			g.Tags = strings.Split(t, ";")
		}
		covered := true
		switch g.Name {
		case "win11-lab", "test-rhel", "old-erp":
			covered = false // lab guests outside the nightly job
		case "wiki":
			g.BackupAgeDays = 11 // in the job, but its last backup is 11 days old
		}
		g.BackupJob = &covered
		if g.Kind == "vm" && g.VMID != 105 {
			g.GuestAgent = "running" // opnsense-fw has none
		}
		switch g.VMID {
		case 100, 102:
			g.HAState = "started"
		case 103:
			g.HAState = "started"
			g.OldestSnapshot = &snap // the pre-upgrade snapshot nobody deleted
		case 104:
			g.PendingChanges = 1 // memory 8192 -> 12288 at the next restart
		case 106:
			g.GuestAgent = "not_running"
		}
	}
	tmpl := func(vmid int, name, image string, disk uint64) GuestSpec {
		g := pveVM(vmid, name, image, proto.StateStopped, 2, 0, 0, 2, 0, 0, 0, 0, 0, vmProtosFull, "1024x768", false)
		g.Template, g.DiskGiB, g.Backup = true, disk, ""
		return g
	}
	h.Guests = append(h.Guests, tmpl(9000, "debian-13-cloud", "debian 13", 3), tmpl(9001, "ubuntu-2404-cloud", "ubuntu 24.04", 4))
}

// addManage adds the storages' provisioned sizes of a drifting report.
func (h *Host) addManage(r *proto.Report) {
	if r.PVE == nil || h.ID != "shale" {
		return
	}
	prov := map[string]uint64{"local-zfs": 420e9, "vmdata": 3500e9, "bulk": 2400e9}
	for i := range r.PVE.Storages {
		s := &r.PVE.Storages[i]
		if p, ok := prov[s.ID]; ok {
			s.ProvisionedBytes, s.Thin = p, true
		}
	}
}

// AddGuest adds a guest (a simulated create, clone or restore).
func (h *Host) AddGuest(g GuestSpec) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.Guests = append(h.Guests, g)
}

// RemoveGuest deletes a guest or template; false when it does not exist.
func (h *Host) RemoveGuest(platform, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, g := range h.Guests {
		if g.Platform == platform && g.ID == id {
			h.Guests = append(h.Guests[:i], h.Guests[i+1:]...)
			return true
		}
	}
	return false
}

// UpdateGuest changes a guest's spec in place; false when it does not
// exist.
func (h *Host) UpdateGuest(platform, id string, f func(*GuestSpec)) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.Guests {
		if g := &h.Guests[i]; g.Platform == platform && g.ID == id {
			f(g)
			return true
		}
	}
	return false
}

// GuestSpecs returns copies of the platform's guest specs (templates too).
func (h *Host) GuestSpecs(platform string) []GuestSpec {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []GuestSpec
	for _, g := range h.Guests {
		if g.Platform == platform {
			out = append(out, g)
		}
	}
	return out
}
