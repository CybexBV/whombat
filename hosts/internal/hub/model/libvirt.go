package model

import (
	"rackoon/internal/proto"
)

// The "libvirt" block of GET /servers/{id} (CONTRACT.md "libvirt", IU-13):
// a host's libvirt — pools, networks, unRAID's VM folders, firmware, the
// backups folder — on every host that runs it (a "libvirt" server, and an
// unRAID server's VM Manager too).

// LibvirtDetail is the "libvirt" block.
type LibvirtDetail struct {
	Version    string           `json:"version"`
	QEMU       *string          `json:"qemu"`
	Pools      []LibvirtPool    `json:"pools"`
	Networks   []LibvirtNetwork `json:"networks"`
	Folders    *LibvirtFolders  `json:"folders"`
	Firmware   LibvirtFirmware  `json:"firmware"`
	BackupsDir *string          `json:"backups_dir"`
}

// LibvirtPool is a storage pool.
type LibvirtPool struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Active     bool    `json:"active"`
	Autostart  bool    `json:"autostart"`
	Path       *string `json:"path"`
	UsedBytes  uint64  `json:"used_bytes"`
	TotalBytes uint64  `json:"total_bytes"`
	AvailBytes uint64  `json:"avail_bytes"`
	Volumes    int     `json:"volumes"`
}

// LibvirtNetwork is a libvirt network.
type LibvirtNetwork struct {
	Name      string  `json:"name"`
	Active    bool    `json:"active"`
	Autostart bool    `json:"autostart"`
	Bridge    *string `json:"bridge"`
	Forward   *string `json:"forward"`
	IPv4      *string `json:"ipv4"`
	DHCP      bool    `json:"dhcp"`
	UsedBy    int     `json:"used_by"`
}

// LibvirtFolders are unRAID's VM folders.
type LibvirtFolders struct {
	Domains *string `json:"domains"`
	ISOs    *string `json:"isos"`
}

// LibvirtFirmware is what a new VM can get.
type LibvirtFirmware struct {
	UEFI       bool `json:"uefi"`
	SecureBoot bool `json:"secure_boot"`
	TPM        bool `json:"tpm"`
}

// buildLibvirt maps the agent's libvirt host view (nil without one).
func buildLibvirt(r *proto.Report) *LibvirtDetail {
	if r == nil || r.Libvirt == nil || r.Libvirt.Libvirt == nil {
		return nil
	}
	d := r.Libvirt.Libvirt
	out := &LibvirtDetail{Version: r.Libvirt.Version, QEMU: strp(d.QEMU), Pools: []LibvirtPool{}, Networks: []LibvirtNetwork{},
		Firmware: LibvirtFirmware{UEFI: d.Firmware.UEFI, SecureBoot: d.Firmware.SecureBoot, TPM: d.Firmware.TPM}, BackupsDir: strp(d.BackupsDir)}
	for _, p := range d.Pools {
		out.Pools = append(out.Pools, LibvirtPool{Name: p.Name, Type: p.Type, Active: p.Active, Autostart: p.Autostart, Path: strp(p.Path),
			UsedBytes: p.UsedBytes, TotalBytes: p.TotalBytes, AvailBytes: p.AvailBytes, Volumes: p.Volumes})
	}
	for _, n := range d.Networks {
		out.Networks = append(out.Networks, LibvirtNetwork{Name: n.Name, Active: n.Active, Autostart: n.Autostart, Bridge: strp(n.Bridge),
			Forward: strp(n.Forward), IPv4: strp(n.IPv4), DHCP: n.DHCP, UsedBy: n.UsedBy})
	}
	if f := d.Folders; f != nil {
		out.Folders = &LibvirtFolders{Domains: strp(f.Domains), ISOs: strp(f.ISOs)}
	}
	return out
}

// libvirtGuestExtras: a libvirt VM's newest Whombat backup and snapshot.
func libvirtGuestExtras(out *Guest, pg proto.PlatformGuest) {
	if pg.Platform != proto.PlatformLibvirt {
		return
	}
	if lb := pg.LastBackup; lb != nil {
		out.LastBackup = &LastBackup{Result: lb.Result, At: Time(lb.At)}
	}
	if pg.LastSnapshot != nil {
		out.LastSnapshot = T(*pg.LastSnapshot)
	}
}

// libvirtGuestKV writes them (only when known).
func libvirtGuestKV(g Guest) []kv {
	if g.Platform != proto.PlatformLibvirt {
		return nil
	}
	var f []kv
	if g.LastBackup != nil {
		f = append(f, kv{"last_backup", g.LastBackup})
	}
	if g.LastSnapshot != nil {
		f = append(f, kv{"last_snapshot", g.LastSnapshot})
	}
	return f
}
