package main

import (
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

func TestSimPackages(t *testing.T) {
	pkgTaskDur = map[string]time.Duration{proto.OpPackagesCheck: 40 * time.Millisecond, proto.OpPackagesInstall: 60 * time.Millisecond}
	pkgSim = &pkgSimState{tasks: map[string]*simPkgTask{}}
	granite := simHost(t, "granite", true)
	wait := func(a *simAgent, id string) proto.TaskStatus {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			st := a.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformHost, Task: id, LogStart: 0})
			if !st.OK {
				t.Fatalf("status: %+v", st)
			}
			if st.TaskStatus.Status != "running" {
				return *st.TaskStatus
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("the task did not end")
		return proto.TaskStatus{}
	}
	report := func(a *simAgent) *proto.SystemInfo { return a.host.Report(time.Now(), 1, "sim").System }

	before := report(granite)
	if *before.UpdatesPending == 0 || before.RebootRequired || before.PackageTask != nil || before.PackageLast != nil {
		t.Fatalf("granite before: %+v", before)
	}
	if n := len(granite.inspect(proto.InspectRequest{Kind: proto.InspectUpdates}).Updates); n != *before.UpdatesPending {
		t.Errorf("inspect lists %d, the report counts %d", n, *before.UpdatesPending)
	}
	r := granite.manage(proto.ManageRequest{Op: proto.OpPackagesInstall, Platform: proto.PlatformHost})
	if !r.OK || !strings.HasPrefix(r.Task.ID, proto.PackageTaskPrefix) {
		t.Fatalf("install: %+v", r)
	}
	if s := report(granite); s.PackageTask == nil || s.PackageTask.ID != r.Task.ID || s.PackageTask.Op != "install" {
		t.Errorf("running task in the report: %+v", s.PackageTask)
	}
	if b := granite.manage(proto.ManageRequest{Op: proto.OpPackagesCheck, Platform: proto.PlatformHost}); b.Code != "busy" {
		t.Errorf("second task: %+v", b)
	}
	if s := granite.manage(proto.ManageRequest{Op: proto.OpTaskStop, Task: r.Task.ID}); s.Code != proto.CodeNotAllowed {
		t.Errorf("stop an install: %+v", s)
	}
	st := wait(granite, r.Task.ID)
	if st.Status != "ok" || st.Packages == nil || st.Packages.Installed != *before.UpdatesPending || !strings.Contains(strings.Join(st.Log, "\n"), "dist-upgrade") {
		t.Errorf("install ended: %+v %+v", st, st.Packages)
	}
	after := report(granite)
	if *after.UpdatesPending != 0 || *after.SecurityUpdates != 0 || !after.RebootRequired || after.PackageTask != nil ||
		after.PackageLast == nil || after.PackageLast.Status != "ok" || *after.PackageLast.Installed != *before.UpdatesPending ||
		after.UpdatesCheckedAt.Before(after.PackageLast.Finished) {
		t.Errorf("granite after: %+v %+v", after, after.PackageLast)
	}
	if n := len(granite.inspect(proto.InspectRequest{Kind: proto.InspectUpdates}).Updates); n != 0 {
		t.Errorf("still listed: %d", n)
	}

	// shale: the enterprise repository refuses; a named install.
	shale := simHost(t, "shale", true)
	ps := shale.host.Packages()
	r = shale.manage(proto.ManageRequest{Op: proto.OpPackagesInstall, Packages: []string{"openssl", "nosuch"}})
	st = wait(shale, r.Task.ID)
	if st.Packages.Warning == "" || st.Packages.Installed != 1 || st.Message != "Installed 1 update." {
		t.Errorf("shale: %+v %+v", st, st.Packages)
	}
	if p := shale.host.Packages(); p.Pending != ps.Pending-1 || p.Reboot {
		t.Errorf("shale after: %+v (before %+v)", p, ps)
	}
	// A check can be stopped.
	r = shale.manage(proto.ManageRequest{Op: proto.OpPackagesCheck})
	if s := shale.manage(proto.ManageRequest{Op: proto.OpTaskStop, Task: r.Task.ID}); !s.OK {
		t.Errorf("stop a check: %+v", s)
	}
	if st := wait(shale, r.Task.ID); st.Status != "error" || shale.host.Packages().Last.Status != "failed" {
		t.Errorf("stopped check: %+v", st)
	}
	if l := shale.manage(proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformHost}); len(l.Tasks) != 2 {
		t.Errorf("list: %+v", l.Tasks)
	}

	// blackbox runs Unraid.
	bb := &simAgent{o: options{manage: true}, host: fakefleet.Blackbox(), early: make(chan struct{}, 1)}
	if r := bb.manage(proto.ManageRequest{Op: proto.OpPackagesCheck, Platform: proto.PlatformHost}); r.Code != "unsupported" {
		t.Errorf("blackbox: %+v", r)
	}
}
