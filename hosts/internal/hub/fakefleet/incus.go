package fakefleet

import (
	"fmt"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Incus parts of the fake fleet (docs/MANAGE.md 2.5, IU-02, IU-04): every
// guest's MACs, basalt's complete Incus (projects, pools, networks,
// profiles, images, custom volumes, snapshot schedules and a backup) and
// the guest that is "this Whombat": basalt's Incus VM "whombat", whose MAC
// is SelfMAC (run the hub with --self-macs SelfMAC to see it marked).
// Like addHealth they are left out of the exact fixture.

// SelfMAC is the MAC of basalt's Incus VM "whombat".
const SelfMAC = "10:66:6a:77:68:01"

// fakeMAC is a stable MAC for a guest: Incus' 10:66:6a, Proxmox's
// bc:24:11, libvirt's 52:54:00, then three bytes of the host and id.
func fakeMAC(host string, s *GuestSpec) string {
	if s.MAC != "" {
		return s.MAC
	}
	prefix := "52:54:00"
	switch s.Platform {
	case proto.PlatformIncus:
		prefix = "10:66:6a"
	case proto.PlatformPVE:
		prefix = "bc:24:11"
	}
	h := hash(host + "/" + s.Platform + "/" + s.ID)
	return fmt.Sprintf("%s:%02x:%02x:%02x", prefix, byte(h>>16), byte(h>>8), byte(h))
}

// seedBasaltIncus gives basalt its Incus host view, the self guest, a
// guest without a snapshot schedule and a backup.
func seedBasaltIncus(h *Host) {
	tb := func(v float64) *uint64 { n := uint64(v * 1e12); return &n }
	gb := func(v uint64) *uint64 { n := v << 30; return &n }
	nat := true
	up := Ref.Add(-20 * 24 * time.Hour)
	used := Ref.Add(-3 * 24 * time.Hour)
	h.IncusDetail = &proto.IncusDetail{
		Projects: []proto.IncusProject{{Name: "ci", Description: "CI runners"}, {Name: "default", Description: "Default Incus project"}},
		Pools: []proto.IncusPool{
			{Name: "default", Driver: "zfs", Status: "Created", UsedBytes: tb(1.42), TotalBytes: tb(1.6), Volumes: 2},
			{Name: "scratch", Driver: "dir", Status: "Created", Description: "Throwaway builds", UsedBytes: gb(40), TotalBytes: gb(400)},
		},
		Networks: []proto.IncusNetwork{
			{Name: "br-lan", Type: "bridge", UsedBy: 1},
			{Name: "incusbr0", Type: "bridge", Managed: true, IPv4: "10.62.52.1/24", NAT: &nat, UsedBy: 6},
		},
		Profiles: []proto.IncusProfileInfo{
			{Name: "big", Project: "default", Description: "8 CPUs, 16 GiB", UsedBy: 1},
			{Name: "default", Project: "default", Description: "Default Incus profile", UsedBy: 7},
			{Name: "gpu", Project: "default", Description: "The NVIDIA card"},
		},
		Images: []proto.IncusImageInfo{
			{Fingerprint: strings.Repeat("6f9e1c3b2a4d", 5) + "0123", Aliases: []string{"debian/13"}, Description: "Debian trixie amd64",
				Type: "container", Architecture: "x86_64", SizeBytes: 98 << 20, UploadedAt: &up, LastUsedAt: &used, AutoUpdate: true, Cached: true, Project: "default"},
			{Fingerprint: strings.Repeat("1a2b3c4d5e6f", 5) + "4567", Aliases: []string{"nixos/26.05"}, Description: "NixOS 26.05 amd64",
				Type: "virtual-machine", Architecture: "x86_64", SizeBytes: 612 << 20, UploadedAt: &up, Project: "default"},
			{Fingerprint: strings.Repeat("9c8b7a6f5e4d", 5) + "89ab", Description: "Alpine 3.22 amd64", Type: "container",
				Architecture: "x86_64", SizeBytes: 3 << 20, UploadedAt: &up, Cached: true, Project: "default"},
		},
		Volumes: []proto.IncusVolume{
			{Pool: "default", Name: "git-data", Project: "default", ContentType: "filesystem", SizeBytes: gb(200), UsedBytes: gb(61),
				UsedBy: []string{"git-mirror"}, Description: "Mirrored repositories"},
			{Pool: "default", Name: "debian-13-netinst", Project: "default", ContentType: "iso", SizeBytes: gb(1)},
		},
	}
	backup := Ref.Add(-2 * 24 * time.Hour)
	for i := range h.Guests {
		g := &h.Guests[i]
		switch {
		case g.Platform != proto.PlatformIncus:
		case g.ID == "ci-runner":
			g.NoSchedule = true // no schedule, no backup: incus.no_snapshots
		case g.ID == "nixbuild":
			g.IncusBackup = &backup
		}
	}
	self := incVM("whombat", "nixos/26.05", "running", 4, 6.2, 5900, 8, 3, 9, 4, 2, 2, 864000)
	self.MAC, self.Extra = SelfMAC, true
	h.Guests = append(h.Guests, self)
}

// addIncus adds the Incus extras of a drifting report: schedules, creation
// times, backups and basalt's host view with its project counts.
func (h *Host) addIncus(r *proto.Report) {
	if r.Incus == nil {
		return
	}
	specs := map[string]*GuestSpec{}
	for i := range h.Guests {
		if s := &h.Guests[i]; s.Platform == proto.PlatformIncus {
			specs[s.ID] = s
		}
	}
	created := Ref.Add(-90 * 24 * time.Hour)
	running := 0
	for i := range r.Incus.Guests {
		g := &r.Incus.Guests[i]
		s := specs[g.ID]
		g.CreatedAt = &created
		if s == nil || !s.NoSchedule {
			g.SnapshotSchedule = "@daily"
		}
		if s != nil && s.IncusBackup != nil {
			g.LastBackup = &proto.BackupMark{Result: "ok", At: *s.IncusBackup}
		}
		if g.State == proto.StateRunning {
			running++
		}
	}
	if h.IncusDetail == nil {
		return
	}
	d := *h.IncusDetail
	d.Projects = append([]proto.IncusProject(nil), h.IncusDetail.Projects...)
	for i := range d.Projects {
		if d.Projects[i].Name == "default" {
			d.Projects[i].Instances, d.Projects[i].Running = len(r.Incus.Guests), running
		}
	}
	r.Incus.Incus = &d
}

// UpdateIncus changes the host's Incus view (simulated volume, profile and
// image changes).
func (h *Host) UpdateIncus(f func(*proto.IncusDetail)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.IncusDetail != nil {
		f(h.IncusDetail)
	}
}

// IncusView returns a copy of the host's Incus view (nil without one).
func (h *Host) IncusView() *proto.IncusDetail {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.IncusDetail == nil {
		return nil
	}
	d := *h.IncusDetail
	d.Projects = append([]proto.IncusProject(nil), d.Projects...)
	d.Pools = append([]proto.IncusPool(nil), d.Pools...)
	d.Networks = append([]proto.IncusNetwork(nil), d.Networks...)
	d.Profiles = append([]proto.IncusProfileInfo(nil), d.Profiles...)
	d.Images = append([]proto.IncusImageInfo(nil), d.Images...)
	d.Volumes = append([]proto.IncusVolume(nil), d.Volumes...)
	return &d
}
