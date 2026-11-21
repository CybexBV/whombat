package main

import (
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

func simHost(t *testing.T, id string, manage bool) *simAgent {
	t.Helper()
	for _, h := range fakefleet.Fleet() {
		if h.ID == id {
			return &simAgent{o: options{manage: manage}, host: h, early: make(chan struct{}, 1)}
		}
	}
	t.Fatalf("no host %s", id)
	return nil
}

func TestShaleManage(t *testing.T) {
	simLatency, mgState = 0, newManageState()
	if r := simHost(t, "shale", false).manage(proto.ManageRequest{Op: proto.OpChoices, Platform: "pve"}); r.Code != "remote_control_disabled" {
		t.Errorf("manage off: %+v", r)
	}
	if r := simHost(t, "obsidian", true).manage(proto.ManageRequest{Op: proto.OpChoices, Platform: "incus"}); r.Code != "unsupported" {
		t.Errorf("other host: %+v", r)
	}
	a := simHost(t, "shale", true)
	get := func(id string) *proto.GuestConfig {
		t.Helper()
		r := a.manage(proto.ManageRequest{Op: proto.OpConfigGet, Platform: "pve", GuestID: id})
		if !r.OK || r.Config == nil {
			t.Fatalf("config.get %s: %+v", id, r)
		}
		return r.Config
	}
	c := get("104")
	if !c.Running || c.Values["memory"] != "8192" || c.Pending["memory"] != "12288" || c.Digest == "" {
		t.Errorf("config 104 = %+v", c)
	}
	// A running VM takes tags at once; cores wait for a restart.
	r := a.manage(proto.ManageRequest{Op: proto.OpConfigSet, Platform: "pve", GuestID: "104", Digest: c.Digest,
		Set: map[string]string{"cores": "6", "tags": "ci;build", "cipassword": "secret"}})
	if !r.OK || len(r.Changes) != 3 || r.Changes[0].New != masked || !r.Changes[1].Pending || r.Changes[2].Pending {
		t.Fatalf("config.set = %+v", r)
	}
	c2 := get("104")
	if c2.Values["tags"] != "ci;build" || c2.Pending["cores"] != "6" || c2.Values["cipassword"] != "" || c2.Digest == c.Digest {
		t.Errorf("after config.set = %+v", c2)
	}
	if g, _ := a.host.FindGuest("pve", "104"); len(g.Tags) != 2 || g.PendingChanges != 3 {
		t.Errorf("report spec = %+v", g)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpConfigSet, Platform: "pve", GuestID: "104", Digest: c.Digest, Set: map[string]string{"cores": "2"}}); r.Code != proto.CodeDigestMismatch {
		t.Errorf("stale digest: %+v", r)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpConfigSet, Platform: "pve", GuestID: "103", Set: map[string]string{"args": "-x"}}); r.Code != proto.CodeNotAllowed {
		t.Errorf("root-only key: %+v", r)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpDiskResize, Platform: "pve", GuestID: "104", Disk: "scsi0", Size: "10G"}); r.Code != proto.CodeInvalidValue || r.FieldErrors["size"] == "" {
		t.Errorf("shrink: %+v", r)
	}
	r = a.manage(proto.ManageRequest{Op: proto.OpDiskResize, Platform: "pve", GuestID: "104", Disk: "scsi0", Size: "+8G"})
	if !r.OK || r.Task == nil {
		t.Fatalf("resize = %+v", r)
	}
	st := a.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: "pve", Task: r.Task.ID})
	if st.TaskStatus == nil || st.TaskStatus.Status != "running" || st.TaskStatus.GuestID != "104" {
		t.Errorf("task status = %+v", st)
	}
	// Running guests cannot be deleted; protected ones neither.
	if r := a.manage(proto.ManageRequest{Op: proto.OpDelete, Platform: "pve", GuestID: "104"}); r.Code != proto.CodeGuestRunning {
		t.Errorf("delete running: %+v", r)
	}
	ch := a.manage(proto.ManageRequest{Op: proto.OpChoices, Platform: "pve"}).Choices
	if ch == nil || ch.NextID != 122 || len(ch.Templates) != 2 || len(ch.ISOs) == 0 || !ch.Download {
		t.Errorf("choices = %+v", ch)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpCreate, Platform: "pve", Kind: "vm", NewID: 100}); r.Code != proto.CodeExists {
		t.Errorf("create over 100: %+v", r)
	}
	r = a.manage(proto.ManageRequest{Op: proto.OpCreate, Platform: "pve", Kind: "container", Name: "ct", Set: map[string]string{"unprivileged": "0", "ostemplate": "x"}})
	if r.Code != proto.CodeNotAllowed {
		t.Errorf("privileged container: %+v", r)
	}
	b := a.manage(proto.ManageRequest{Op: proto.OpBackupList, Platform: "pve", GuestID: "102"})
	if !b.OK || len(b.Backups) != 4 || b.Backups[0].Storage != "pbs-01" {
		t.Errorf("backups = %+v", b)
	}
	fw := a.manage(proto.ManageRequest{Op: proto.OpFirewallGet, Platform: "pve", GuestID: "200"}).Firewall
	if fw == nil || len(fw.Rules) != 3 || fw.RulesDigest == "" {
		t.Fatalf("firewall = %+v", fw)
	}
	pos := 2
	if r := a.manage(proto.ManageRequest{Op: proto.OpFirewallRuleDelete, Platform: "pve", GuestID: "200", Pos: &pos, Digest: fw.RulesDigest}); !r.OK {
		t.Errorf("delete rule: %+v", r)
	}
	if r := a.manage(proto.ManageRequest{Op: proto.OpFirewallRuleDelete, Platform: "pve", GuestID: "200", Pos: &pos, Digest: fw.RulesDigest}); r.Code != proto.CodeDigestMismatch {
		t.Errorf("stale rules digest: %+v", r)
	}
}

func TestSimTaskStatus(t *testing.T) {
	task := &simTask{id: "UPID:shale:1", typ: "qmclone", guest: "100", started: time.Now().Add(-10 * time.Second), dur: 2 * time.Second,
		lines: []string{"a", "b"}}
	st := task.status(1)
	if st.Status != "ok" || st.Ended == nil || len(st.Log) != 2 || st.Log[1] != "TASK OK" || st.LogNext != 3 {
		t.Errorf("finished = %+v", st)
	}
	if st := task.status(-1); st.Log != nil || st.LogNext != 0 {
		t.Errorf("without log = %+v", st)
	}
	stopped := task.started.Add(time.Second)
	task.stopped = &stopped
	if st := task.status(0); st.Status != "error" || st.Log[len(st.Log)-1] != "TASK ERROR: interrupted by signal" {
		t.Errorf("stopped = %+v", st)
	}
	task.stopped, task.started = nil, time.Now()
	if st := task.status(0); st.Status != "running" || st.Ended != nil || len(st.Log) != 1 {
		t.Errorf("running = %+v", st)
	}
}

func TestShaleBackupJobs(t *testing.T) {
	simLatency, mgState = 0, newManageState()
	a := simHost(t, "shale", true)
	op := func(req proto.ManageRequest) proto.ManageResponse {
		t.Helper()
		req.Platform = "pve"
		return a.manage(req)
	}
	covered := func(id string) bool {
		t.Helper()
		g, ok := a.host.FindGuest("pve", id)
		return ok && g.BackupJob != nil && *g.BackupJob
	}
	jobs := op(proto.ManageRequest{Op: proto.OpBackupJobList}).BackupJobs
	if len(jobs) != 2 || jobs[0].Selection != "all" || len(jobs[0].Exclude) != 3 || jobs[0].Keep == nil || jobs[0].NextRun == nil ||
		jobs[1].Selection != "guests" || len(jobs[1].Guests) != 2 || jobs[0].Digest == "" {
		t.Fatalf("seeded jobs = %+v", jobs)
	}
	if covered("107") || !covered("100") {
		t.Fatalf("seeded coverage: 107 %v, 100 %v", covered("107"), covered("100"))
	}
	// Add the lab VM to a new job: it is covered at once.
	s := "21:00"
	sel, store := "guests", "pbs-01"
	r := op(proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: &proto.BackupJobSpec{Schedule: &s, Storage: &store, Selection: &sel, Guests: []string{"107"}}})
	if !r.OK || r.JobID == "" || !covered("107") {
		t.Fatalf("create: %+v", r)
	}
	bad := "local-zfs"
	if r := op(proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: &proto.BackupJobSpec{Schedule: &s, Storage: &bad, Selection: &sel, Guests: []string{"107"}}}); r.Code != proto.CodeInvalidValue || r.FieldErrors["storage"] == "" {
		t.Errorf("guest storage: %+v", r)
	}
	// Pausing the nightly job uncovers everyone else; a stale digest is refused.
	off := false
	if r := op(proto.ManageRequest{Op: proto.OpBackupJobUpdate, JobID: jobs[0].ID, Digest: "stale", BackupJob: &proto.BackupJobSpec{Enabled: &off}}); r.Code != proto.CodeDigestMismatch {
		t.Errorf("stale digest: %+v", r)
	}
	r = op(proto.ManageRequest{Op: proto.OpBackupJobUpdate, JobID: jobs[0].ID, Digest: jobs[0].Digest, BackupJob: &proto.BackupJobSpec{Enabled: &off}})
	if !r.OK || len(r.Changes) != 1 || r.Changes[0].Key != "enabled" || covered("100") || !covered("103") {
		t.Errorf("pause: %+v (100 %v, 103 %v)", r, covered("100"), covered("103"))
	}
	run := op(proto.ManageRequest{Op: proto.OpBackupJobRun, JobID: jobs[1].ID})
	if !run.OK || run.Task == nil {
		t.Fatalf("run: %+v", run)
	}
	if st := op(proto.ManageRequest{Op: proto.OpTaskStatus, Task: run.Task.ID, LogStart: 0}).TaskStatus; st == nil || st.Type != "vzdump" {
		t.Errorf("run task = %+v", st)
	}
	if r := op(proto.ManageRequest{Op: proto.OpBackupJobDelete, JobID: r.JobID}); r.Code != proto.CodeNotFound {
		t.Errorf("delete an empty id: %+v", r)
	}
	if r := op(proto.ManageRequest{Op: proto.OpBackupJobDelete, JobID: jobs[1].ID}); !r.OK || covered("103") {
		t.Errorf("delete: %+v", r)
	}
}
