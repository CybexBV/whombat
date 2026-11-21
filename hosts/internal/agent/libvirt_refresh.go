package agent

import "rackoon/internal/proto"

// libvirtReads are the libvirt manage operations that change nothing.
var libvirtReads = map[string]bool{proto.OpConfigGet: true, proto.OpChoices: true, proto.OpBackupList: true,
	proto.OpContentList: true, proto.OpTaskList: true, proto.OpTaskStatus: true, proto.OpNetworkLeases: true, proto.OpLogGet: true}

// libvirtChanged: a libvirt change went through, or one of its tasks
// (clone, backup, restore, download) has just ended, so the next report
// should carry libvirt's domains and host view as they are now.
func libvirtChanged(req proto.ManageRequest, resp proto.ManageResponse) bool {
	if !resp.OK || req.Platform != proto.PlatformLibvirt {
		return false
	}
	if req.Op == proto.OpTaskStatus {
		return resp.TaskStatus != nil && resp.TaskStatus.Status != "running"
	}
	return !libvirtReads[req.Op]
}

// refreshLibvirt reads libvirt again and reports at once.
func (rt *Runtime) refreshLibvirt() {
	c, ok := rt.Collector.(interface{ RefreshLibvirt() })
	if !ok {
		return
	}
	c.RefreshLibvirt()
	select {
	case rt.collectNow <- struct{}{}:
	default:
	}
}
