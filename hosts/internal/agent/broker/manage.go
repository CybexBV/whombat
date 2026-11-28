package broker

import (
	"context"
	"strconv"

	"rackoon/internal/proto"
)

// manager is implemented by drivers that support proto.StreamManage
// (pve_manage.go, incus_manage.go). g is the validated guest for guest
// operations and nil for host operations.
type manager interface {
	manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse
}

// manageGuestOps name a guest that must be in the latest inventory (or,
// on Proxmox VE, among the node's templates).
var manageGuestOps = map[string]bool{
	proto.OpConfigGet: true, proto.OpConfigSet: true, proto.OpDiskResize: true, proto.OpDiskMove: true,
	proto.OpClone: true, proto.OpTemplate: true, proto.OpDelete: true, proto.OpMigrate: true,
	proto.OpBackupList: true, proto.OpBackupCreate: true,
	proto.OpFirewallGet: true, proto.OpFirewallOptions: true, proto.OpFirewallRuleAdd: true,
	proto.OpFirewallRuleUpdate: true, proto.OpFirewallRuleDelete: true,
	proto.OpHASet: true, proto.OpHARemove: true, proto.OpReplicationAdd: true, proto.OpReplicationDelete: true,
}

// manageHostOps act on the platform; backup.restore and task.list may
// also name a guest (restore over it, list its tasks).
var manageHostOps = map[string]bool{
	proto.OpChoices: true, proto.OpCreate: true, proto.OpBackupRestore: true, proto.OpBackupUpdate: true,
	proto.OpBackupDelete: true, proto.OpContentList: true, proto.OpContentDownload: true, proto.OpContentDelete: true,
	proto.OpApplianceList: true, proto.OpApplianceDownload: true, proto.OpTaskList: true, proto.OpTaskStatus: true,
	proto.OpTaskStop: true, proto.OpBackupJobList: true, proto.OpBackupJobCreate: true, proto.OpBackupJobUpdate: true,
	proto.OpBackupJobDelete: true, proto.OpBackupJobRun: true, proto.OpStorageAdd: true, proto.OpBackupConfig: true,
}

// manageReadOps change nothing and skip the per-guest lock.
var manageReadOps = map[string]bool{
	proto.OpConfigGet: true, proto.OpChoices: true, proto.OpBackupList: true, proto.OpContentList: true,
	proto.OpApplianceList: true, proto.OpTaskList: true, proto.OpTaskStatus: true, proto.OpFirewallGet: true,
	proto.OpBackupJobList: true, proto.OpBackupConfig: true,
}

// Manage implements agent.Broker.
func (b *Broker) Manage(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	if resp, ok := b.placeManage(ctx, req); ok {
		return resp // backup places (backupplace.go)
	}
	if resp, ok := b.unraidManage(ctx, req); ok {
		return resp // unRAID, its tasks, and the Docker / libvirt guest ops (unraid_manage.go)
	}
	if resp, ok := b.appsManage(ctx, req); ok {
		return resp // app updates and their tasks (app_tasks.go)
	}
	if resp, ok := b.packagesManage(req); ok {
		return resp // package updates and their tasks (pkg_tasks.go)
	}
	if !manageGuestOps[req.Op] && !manageHostOps[req.Op] {
		return proto.ManageResponse{Code: CodeUnsupported, Message: "unknown operation"}
	}
	d := b.drivers[req.Platform]
	m, ok := d.(manager)
	if req.Platform == "" || req.Platform == proto.PlatformHost || !ok {
		return proto.ManageResponse{Code: CodeUnsupported, Message: "this platform cannot be managed through Whombat"}
	}
	var g *proto.Guest
	if (manageGuestOps[req.Op] || req.GuestID != "") && !libvirtSkipLookup(req) {
		var err error
		if g, err = b.lookupManaged(req.Platform, req.GuestID); err != nil {
			code, msg := errCode(err, CodeInvalid)
			return proto.ManageResponse{Code: code, Message: msg}
		}
		if !manageReadOps[req.Op] {
			unlock, ok := b.lockGuest(ctx, req.Platform, g.ID)
			if !ok {
				return proto.ManageResponse{Code: CodeBusy, Message: "another action on this guest is still running"}
			}
			defer unlock()
		}
	}
	return m.manage(ctx, g, req)
}

// lookupManaged is lookup for manage operations: Proxmox VE templates,
// which the report keeps out of the guest list, are valid targets too.
func (b *Broker) lookupManaged(platform, id string) (*proto.Guest, error) {
	g, _, err := b.lookup(platform, id)
	if err == nil || platform != proto.PlatformPVE {
		return g, err
	}
	if code, _ := errCode(err, ""); code != CodeUnknownGuest {
		return nil, err
	}
	r := b.inv()
	if r.PVE != nil {
		for _, t := range r.PVE.Templates {
			if t.ID == id {
				vmid, _ := strconv.Atoi(t.ID)
				return &proto.Guest{ID: t.ID, Name: t.Name, Kind: t.Kind, State: proto.StateStopped, VMID: vmid, Node: t.Node}, nil
			}
		}
	}
	return nil, err
}
