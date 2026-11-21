package broker

import (
	"context"
	"sync"

	"rackoon/internal/proto"
)

// The libvirt operations of docs/MANAGE.md 2.7 join the broker's operation
// tables (manage.go). Most are the shared ops with platform libvirt; the
// ones Incus has too (rename, log, leases, volumes) are registered by both
// (idempotent).
func init() {
	for _, op := range []string{proto.OpRename, proto.OpLogGet} {
		manageGuestOps[op] = true
	}
	for _, op := range []string{proto.OpNetworkLeases, proto.OpVolumeCreate, proto.OpVolumeResize, proto.OpVolumeDelete} {
		manageHostOps[op] = true
	}
	for _, op := range []string{proto.OpLogGet, proto.OpNetworkLeases} {
		manageReadOps[op] = true
	}
}

// libvirtManaged: the broker passes these libvirt ops without looking the
// VM up in the inventory (Broker.Manage): a host-wide backup list, and the
// backups of a VM that may be gone.
func libvirtSkipLookup(req proto.ManageRequest) bool {
	return req.Platform == proto.PlatformLibvirt && lvGuestOptional[req.Op] && (req.Op != proto.OpBackupList || req.GuestID == "")
}

// libvirtDriver's manager, made on first use.
var lvMgrOnce sync.Map // *libvirtDriver -> *lvManager

func (d *libvirtDriver) manager() *lvManager {
	if m, ok := lvMgrOnce.Load(d); ok {
		return m.(*lvManager)
	}
	backups := ""
	if d.cfg != nil {
		backups = d.cfg.Libvirt.BackupsDir
	}
	m := newLvManager(func() (LibvirtConn, error) { return d.connect() }, lvOSFS{}, backups, nil)
	actual, _ := lvMgrOnce.LoadOrStore(d, m)
	return actual.(*lvManager)
}

func (d *libvirtDriver) manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	return d.manager().manage(ctx, g, req)
}
