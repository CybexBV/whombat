package main

import (
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

func TestBlackboxUnraid(t *testing.T) {
	for op := range unraidTaskDur {
		unraidTaskDur[op] = time.Millisecond
	}
	fakefleet.ParityCheckTime = 80 * time.Millisecond
	unraidSim = &unraidSimState{tasks: map[string]*simUnraidTask{}}
	a := &simAgent{o: options{manage: true}, host: fakefleet.Blackbox(), early: make(chan struct{}, 1)}
	run := func(req proto.ManageRequest) proto.TaskStatus {
		t.Helper()
		if req.Platform == "" {
			req.Platform = proto.PlatformUnraid
		}
		r := a.manage(req)
		if !r.OK || r.Task == nil {
			t.Fatalf("%s: %+v", req.Op, r)
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
			st := a.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformUnraid, Task: r.Task.ID})
			if st.TaskStatus.Status != "running" {
				return *st.TaskStatus
			}
		}
		t.Fatalf("%s did not end", req.Op)
		return proto.TaskStatus{}
	}
	report := func() *proto.Report { return a.host.Report(time.Now(), 1, "sim") }
	if r := report(); r.Unraid == nil || r.Agent.Install != "unraid" || r.Unraid.Array.State != "started" || len(r.Unraid.Pools) != 3 {
		t.Fatalf("report: %+v", r.Unraid)
	}
	if st := run(proto.ManageRequest{Op: proto.OpArrayStop}); st.Status != "ok" || st.Message != "The array is stopped." {
		t.Errorf("stop: %+v", st)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpParityStart, Platform: proto.PlatformUnraid}); r.Code != "busy" {
		t.Errorf("parity on a stopped array: %+v", r)
	}
	run(proto.ManageRequest{Op: proto.OpArrayStart})
	// A read check (no parity disk) runs with the clock and ends its task.
	if st := run(proto.ManageRequest{Op: proto.OpParityStart}); st.Status != "ok" || st.Message != "No errors." {
		t.Errorf("parity: %+v", st)
	}
	if p := report().Unraid.Array.Parity; p.State != "idle" || p.Last == nil || p.Last.Result != "ok" || p.Last.Action != "read_check" {
		t.Errorf("after the check: %+v", p)
	}
	// Plugins, notifications, containers.
	if st := run(proto.ManageRequest{Op: proto.OpPluginUpdate, Plugin: "all"}); st.Message != "2 plugins updated." {
		t.Errorf("plugins: %+v", st)
	}
	for _, p := range report().Unraid.Plugins {
		if p.Update != "" {
			t.Errorf("still an update: %+v", p)
		}
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpNotificationArchive, Platform: proto.PlatformUnraid,
		Notification: "Docker_critical_image_disk_utilization_1760180400"}); !r.OK || len(report().Unraid.Notifications) != 1 {
		t.Errorf("archive: %+v", r)
	}
	if st := run(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "plex"}); st.Message != "plex is up to date." || st.GuestID != "plex" {
		t.Errorf("container: %+v", st)
	}
	r := report()
	for _, g := range r.Docker.Guests {
		if g.ID == "plex" && (g.UpdateAvailable == nil || *g.UpdateAvailable || g.WebUI == "" || !g.UnraidTemplate) {
			t.Errorf("plex after update: %+v", g)
		}
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "immich_server"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("no template: %+v", r)
	}
	off := false
	if r := a.manage(proto.ManageRequest{Op: proto.OpGuestAutostart, Platform: proto.PlatformLibvirt, GuestID: "pbs", On: &off}); !r.OK {
		t.Errorf("autostart: %+v", r)
	}
	for _, g := range report().Libvirt.Guests {
		if g.ID == "pbs" && (g.Autostart == nil || *g.Autostart) {
			t.Errorf("pbs autostart: %+v", g.Autostart)
		}
	}
	if l := a.manage(proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformUnraid}); len(l.Tasks) != 5 {
		t.Errorf("tasks: %d", len(l.Tasks))
	}
	// Other hosts know nothing of unRAID.
	if r := simHost(t, "basalt", true).manage(proto.ManageRequest{Op: proto.OpMoverStart, Platform: proto.PlatformUnraid}); r.Code != "unsupported" {
		t.Errorf("basalt: %+v", r)
	}
}
