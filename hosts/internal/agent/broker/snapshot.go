package broker

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"rackoon/internal/proto"
)

// snapshotter is implemented by the drivers with guest snapshots (Incus,
// libvirt, Proxmox VE).
type snapshotter interface {
	snapshots(ctx context.Context, g *proto.Guest) ([]proto.Snapshot, error)
	// snapshotCreate takes a snapshot; memory asks for the VM's RAM state
	// where the platform supports it.
	snapshotCreate(ctx context.Context, g *proto.Guest, name, description string, memory bool) error
	snapshotRestore(ctx context.Context, g *proto.Guest, name string) error
	snapshotDelete(ctx context.Context, g *proto.Guest, name string) error
}

// Snapshot operations may take long (a VM's RAM is written out): the
// platform keeps going in the background for up to snapshotMax while the
// answer is sent after snapshotWait.
const (
	snapshotWait = 70 * time.Second
	snapshotMax  = 30 * time.Minute
	maxSnapDesc  = 512
)

var (
	// New snapshot names: what Incus, libvirt and PVE all accept.
	newSnapshotRe = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,39}$`)
	// Existing snapshots (restore, delete) may have longer names made
	// elsewhere; they must also be in the guest's snapshot list.
	snapshotRefRe = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.:+@-]{0,127}$`)
	// PVE: a letter first, no dots (pve-snapshot-name).
	pveSnapshotRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]+$`)
)

// DefaultSnapshotName is the name of a snapshot created without one.
func DefaultSnapshotName(now time.Time) string {
	return "whombat-" + now.UTC().Format("20060102-150405")
}

// cleanDescription keeps a description to one printable line.
func cleanDescription(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > maxSnapDesc {
		s = s[:maxSnapDesc]
		s = strings.ToValidUTF8(s, "")
	}
	return s
}

// snapshotAction runs snapshot_create / _restore / _delete. It holds the
// guest's lock until the platform finishes, also when the answer was sent
// earlier with code timeout.
func (b *Broker) snapshotAction(ctx context.Context, req proto.ActionRequest, g *proto.Guest, d driver, platform string) proto.ActionResponse {
	sd, ok := d.(snapshotter)
	if !ok {
		return proto.ActionResponse{Code: CodeUnsupportedAction, Message: "snapshots are not available for this platform"}
	}
	name := strings.TrimSpace(req.Args[proto.ArgSnapshot])
	desc := cleanDescription(req.Args[proto.ArgDescription])
	memory := req.Args[proto.ArgWithMemory] == "true"
	switch req.Action {
	case proto.ActionSnapshotCreate:
		if name == "" {
			name = DefaultSnapshotName(time.Now())
		}
		if !newSnapshotRe.MatchString(name) {
			return proto.ActionResponse{Code: CodeInvalid, Message: "snapshot names are 1 to 40 letters, digits, '_', '.' or '-' and do not start with '-'"}
		}
		if platform == proto.PlatformPVE && !pveSnapshotRe.MatchString(name) {
			return proto.ActionResponse{Code: CodeInvalid, Message: "Proxmox VE snapshot names start with a letter and contain only letters, digits, '_' and '-'"}
		}
	default:
		if !snapshotRefRe.MatchString(name) {
			return proto.ActionResponse{Code: CodeInvalid, Message: "invalid snapshot name"}
		}
	}

	unlock, ok := b.lockGuest(ctx, platform, g.ID)
	if !ok {
		return proto.ActionResponse{Code: CodeBusy, Message: "another action on this guest is still running"}
	}
	list, err := sd.snapshots(ctx, g)
	if err != nil {
		unlock()
		code, msg := errCode(err, CodePlatformError)
		return proto.ActionResponse{Code: code, Message: msg}
	}
	exists := false
	for _, s := range list {
		exists = exists || s.Name == name
	}
	switch {
	case req.Action == proto.ActionSnapshotCreate && exists:
		unlock()
		return proto.ActionResponse{Code: CodeInvalid, Message: fmt.Sprintf("a snapshot named %q already exists", name)}
	case req.Action != proto.ActionSnapshotCreate && !exists:
		unlock()
		return proto.ActionResponse{Code: CodeUnknownSnapshot, Message: fmt.Sprintf("the guest has no snapshot %q", name)}
	}

	// The platform operation outlives the RPC when it takes long.
	opCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), snapshotMax)

	b.log.Info("running snapshot action", "platform", platform, "guest", g.ID, "action", req.Action, "snapshot", name, "memory", memory)
	done := make(chan error, 1)
	go func() {
		defer unlock()
		defer cancel()
		var err error
		switch req.Action {
		case proto.ActionSnapshotCreate:
			err = sd.snapshotCreate(opCtx, g, name, desc, memory)
		case proto.ActionSnapshotRestore:
			err = sd.snapshotRestore(opCtx, g, name)
		case proto.ActionSnapshotDelete:
			err = sd.snapshotDelete(opCtx, g, name)
		}
		if err != nil {
			b.log.Warn("snapshot action failed", "platform", platform, "guest", g.ID, "action", req.Action, "snapshot", name, "err", err)
		} else {
			b.log.Info("snapshot action finished", "platform", platform, "guest", g.ID, "action", req.Action, "snapshot", name)
		}
		done <- err
	}()
	wait := snapshotWait
	if dl, ok := ctx.Deadline(); ok && time.Until(dl)-5*time.Second < wait {
		wait = time.Until(dl) - 5*time.Second
	}
	select {
	case err := <-done:
		sctx, scancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		st, _ := d.state(sctx, g)
		scancel()
		if err != nil {
			code, msg := errCode(err, CodePlatformError)
			return proto.ActionResponse{Code: code, Message: msg, State: st}
		}
		return proto.ActionResponse{OK: true, State: st, Message: "snapshot " + name}
	case <-time.After(wait):
		return proto.ActionResponse{Code: CodeTimeout, Message: fmt.Sprintf("the snapshot operation on %q is still running on the host", name)}
	}
}

// inspectSnapshots lists a guest's snapshots, oldest first.
func (b *Broker) inspectSnapshots(ctx context.Context, req proto.InspectRequest) proto.InspectResponse {
	g, d, err := b.lookup(req.Platform, req.GuestID)
	if err != nil {
		code, msg := errCode(err, CodeInvalid)
		return proto.InspectResponse{Code: code, Message: msg}
	}
	sd, ok := d.(snapshotter)
	if !ok {
		return proto.InspectResponse{Code: CodeUnsupported, Message: "snapshots are not available for this platform"}
	}
	list, err := sd.snapshots(ctx, g)
	if err != nil {
		code, msg := errCode(err, CodePlatformError)
		return proto.InspectResponse{Code: code, Message: msg}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if !list[i].Created.Equal(list[j].Created) {
			return list[i].Created.Before(list[j].Created)
		}
		return list[i].Name < list[j].Name
	})
	limit := req.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	resp := proto.InspectResponse{Snapshots: list}
	if len(list) > limit {
		resp.Snapshots, resp.Truncated = list[len(list)-limit:], true
	}
	if resp.Snapshots == nil {
		resp.Snapshots = []proto.Snapshot{}
	}
	return resp
}
