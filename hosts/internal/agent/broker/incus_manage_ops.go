package broker

import "rackoon/internal/proto"

// The Incus operations of docs/MANAGE.md 2.5 join the broker's operation
// tables (manage.go): guest ops name an instance of the inventory, host
// ops act on the host's Incus, reads skip the guest lock.
func init() {
	for _, op := range []string{proto.OpLogGet, proto.OpRename, proto.OpMove, proto.OpPublish} {
		manageGuestOps[op] = true
	}
	for _, op := range []string{proto.OpNetworkLeases, proto.OpProfileGet, proto.OpProfileCreate, proto.OpProfileUpdate,
		proto.OpProfileDelete, proto.OpVolumeCreate, proto.OpVolumeResize, proto.OpVolumeDelete, proto.OpImageDownload,
		proto.OpImageRefresh, proto.OpImageDelete} {
		manageHostOps[op] = true
	}
	for _, op := range []string{proto.OpLogGet, proto.OpNetworkLeases, proto.OpProfileGet} {
		manageReadOps[op] = true
	}
}
