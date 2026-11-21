package main

import (
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestBasaltIncus(t *testing.T) {
	simLatency = 0
	a := simHost(t, "basalt", true)
	m := func(req proto.ManageRequest) proto.ManageResponse {
		t.Helper()
		req.Platform = "incus"
		return a.manage(req)
	}
	c := m(proto.ManageRequest{Op: proto.OpConfigGet, GuestID: "git-mirror"})
	if !c.OK || c.Config.Values["device.git"] == "" || c.Config.Values["snapshots.schedule"] != "@daily" {
		t.Fatalf("config.get: %+v", c)
	}
	r := m(proto.ManageRequest{Op: proto.OpConfigSet, GuestID: "ci-runner", Digest: m(proto.ManageRequest{Op: proto.OpConfigGet, GuestID: "ci-runner"}).Config.Digest,
		Set: map[string]string{"snapshots.schedule": "@hourly"}, Profiles: []string{"default", "big"}})
	if !r.OK || len(r.Changes) != 2 {
		t.Fatalf("config.set: %+v", r)
	}
	if g, _ := a.host.FindGuest("incus", "ci-runner"); g.NoSchedule {
		t.Errorf("schedule not reflected: %+v", g)
	}
	if r := m(proto.ManageRequest{Op: proto.OpConfigSet, GuestID: "ci-runner", Set: map[string]string{"raw.lxc": "x"}}); r.Code != proto.CodeNotAllowed {
		t.Errorf("raw key: %+v", r)
	}
	ch := m(proto.ManageRequest{Op: proto.OpChoices, Project: "ci"})
	if !ch.OK || ch.Choices.Project != "ci" || len(ch.Choices.Projects) != 2 || len(ch.Choices.Storages) != 2 || len(ch.Choices.RemoteImages) == 0 {
		t.Errorf("choices: %+v", ch.Choices)
	}
	if r := m(proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Name: "app1", Image: "images:debian/13"}); !r.OK || r.Task == nil || r.NewID != "app1" {
		t.Errorf("create: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpRename, GuestID: "nixbuild", Name: "x"}); r.Code != proto.CodeGuestRunning {
		t.Errorf("rename running: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpRename, GuestID: "scratch", Name: "scratch2"}); !r.OK || r.NewID != "scratch2" {
		t.Errorf("rename: %+v", r)
	}
	bl := m(proto.ManageRequest{Op: proto.OpBackupList, GuestID: "nixbuild"})
	if !bl.OK || len(bl.Backups) != 1 || bl.Backups[0].ExpiresAt == nil {
		t.Fatalf("backups: %+v", bl)
	}
	rs := m(proto.ManageRequest{Op: proto.OpBackupRestore, GuestID: "nixbuild", Volume: bl.Backups[0].Volume})
	if !rs.OK || rs.NewID != "nixbuild-restored" {
		t.Errorf("restore: %+v", rs)
	}
	ts := m(proto.ManageRequest{Op: proto.OpTaskStatus, Task: rs.Task.ID, LogStart: -1})
	if !ts.OK || ts.TaskStatus.Status != "running" || !ts.TaskStatus.Cancellable {
		t.Errorf("task: %+v", ts.TaskStatus)
	}
	if r := m(proto.ManageRequest{Op: proto.OpTaskStop, Task: rs.Task.ID}); !r.OK {
		t.Errorf("task.stop: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpTaskList}); !r.OK || len(r.Tasks) < 2 {
		t.Errorf("task.list: %+v", r.Tasks)
	}
	if r := m(proto.ManageRequest{Op: proto.OpNetworkLeases, Network: "incusbr0"}); !r.OK || len(r.Leases) < 3 || r.Leases[1].GuestID == "" {
		t.Errorf("leases: %+v", r.Leases)
	}
	if r := m(proto.ManageRequest{Op: proto.OpLogGet, GuestID: "nixbuild"}); !r.OK || r.Log.File != "qemu.log" {
		t.Errorf("log: %+v", r.Log)
	}
	// Profiles.
	if r := m(proto.ManageRequest{Op: proto.OpProfileCreate, Name: "small", CopyFrom: "big"}); !r.OK {
		t.Errorf("profile.create: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpProfileUpdate, Profile: "small", Set: map[string]string{"limits.cpu": "2"}}); !r.OK || len(r.Changes) != 1 {
		t.Errorf("profile.update: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "big"}); r.Code != proto.CodeInUse {
		t.Errorf("delete used: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "small"}); !r.OK {
		t.Errorf("profile.delete: %+v", r)
	}
	// Volumes.
	if r := m(proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "scratch", Name: "cache", Size: "20GiB"}); !r.OK {
		t.Errorf("volume.create: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpVolumeResize, Pool: "scratch", Volume: "cache", Size: "+10GiB"}); !r.OK || r.Changes[0].New != "30GiB" {
		t.Errorf("volume.resize: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "default", Volume: "git-data"}); r.Code != proto.CodeInUse {
		t.Errorf("delete attached: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "scratch", Volume: "cache"}); !r.OK {
		t.Errorf("volume.delete: %+v", r)
	}
	// Images.
	if r := m(proto.ManageRequest{Op: proto.OpImageDownload, Alias: "ubuntu/24.04", ImageType: "container"}); !r.OK || r.Task == nil {
		t.Errorf("image.download: %+v", r)
	}
	if r := m(proto.ManageRequest{Op: proto.OpImageDelete, Fingerprint: "9c8b7a6f5e4d"}); !r.OK {
		t.Errorf("image.delete: %+v", r)
	}
	rep := a.host.Report(a.start, 1, "test")
	if rep.Incus == nil || rep.Incus.Incus == nil || len(rep.Incus.Incus.Images) != 2 || !strings.HasPrefix(rep.Incus.Incus.Images[0].Fingerprint, "6f9e") {
		t.Errorf("report images: %+v", rep.Incus.Incus)
	}
}
