package broker

import (
	"context"
	"encoding/json"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// pve01Job is pve-01's real backup job (PVE 9.2, `pvesh get /cluster/backup`).
const pve01Job = `{"all":1,"compress":"zstd","enabled":1,"exclude":"100,101,104,105","fleecing":{"enabled":0},"id":"backup-dc316015-ac2c","mode":"snapshot","next-run":1792288800,"notes-template":"{{guestname}}","notification-mode":"notification-system","prune-backups":{"keep-daily":"14","keep-last":"7","keep-monthly":"6","keep-weekly":"8"},"schedule":"04:00","storage":"pbs","type":"vzdump"}`

// withJobs serves /cluster/backup: pve-01's job, a guests job restricted
// to pve1, a pool job, a replication job and a vzdump.cron job.
func withJobs(f *fakePVE) {
	var jobs []any
	for _, s := range []string{pve01Job,
		`{"id":"backup-0a1b2c3d-0001","type":"vzdump","enabled":0,"schedule":"sat 02:30","storage":"local","vmid":"200,100","mode":"stop","compress":"1","node":"pve1","comment":"Weekly","next-run":1792300000}`,
		`{"id":"backup-pool","type":"vzdump","schedule":"21:00","storage":"local","pool":"prod","prune-backups":"keep-all=1"}`,
		`{"id":"100-0","type":"replication","schedule":"*/15"}`,
		`{"id":"5f2e4c1a8b","schedule":"01:00","storage":"local","vmid":100,"dumpdir":"/mnt/dump"}`,
	} {
		jobs = append(jobs, json.RawMessage(s))
	}
	f.data("GET /cluster/backup", jobs)
	f.data("GET /pools", []map[string]any{{"poolid": "prod"}, {"poolid": "lab/dev"}})
}

// pveshRunner records pvesh calls and fails them with err.
type pveshRunner struct {
	calls [][]string
	err   error
}

func (p *pveshRunner) run(ctx context.Context, argv ...string) ([]byte, error) {
	p.calls = append(p.calls, argv)
	return nil, p.err
}

func str(s string) *string { return &s }

func TestPVEBackupJobList(t *testing.T) {
	f := newFakePVE(t)
	withJobs(f)
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobList})
	if !r.OK || len(r.BackupJobs) != 4 {
		t.Fatalf("backupjob.list: %+v", r)
	}
	byID := map[string]proto.BackupJob{}
	for _, j := range r.BackupJobs {
		byID[j.ID] = j
	}
	next := time.Unix(1792288800, 0).UTC()
	a := byID["backup-dc316015-ac2c"]
	want := proto.BackupJob{ID: "backup-dc316015-ac2c", Enabled: true, Schedule: "04:00", Storage: "pbs", Selection: "all",
		Exclude: []string{"100", "101", "104", "105"}, Mode: "snapshot", Compress: "zstd",
		Keep: &proto.BackupKeep{Last: 7, Daily: 14, Weekly: 8, Monthly: 6}, NotesTemplate: "{{guestname}}", NextRun: &next, Digest: a.Digest}
	if !reflect.DeepEqual(a, want) || len(a.Digest) != 64 {
		t.Errorf("all job =\n%+v\nwant\n%+v", a, want)
	}
	g := byID["backup-0a1b2c3d-0001"]
	if g.Selection != "guests" || !reflect.DeepEqual(g.Guests, []string{"100", "200"}) || g.Enabled || g.NextRun != nil ||
		g.Node != "pve1" || g.Compress != "lzo" || g.Mode != "stop" || g.Comment != "Weekly" || g.Keep != nil {
		t.Errorf("guests job = %+v", g)
	}
	p := byID["backup-pool"]
	if p.Selection != "pool" || p.Pool != "prod" || p.Keep == nil || *p.Keep != (proto.BackupKeep{}) || p.Compress != "" || !p.Enabled || p.Mode != "snapshot" {
		t.Errorf("pool job = %+v", p)
	}
	if l := byID["5f2e4c1a8b"]; l.Selection != "guests" || !reflect.DeepEqual(l.Guests, []string{"100"}) {
		t.Errorf("vzdump.cron job = %+v", l)
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Errorf("a list changed something: %v", ch)
	}

	// The digest ignores next-run (it moves with the clock) and follows
	// every stored field.
	other := strings.Replace(pve01Job, `"next-run":1792288800`, `"next-run":1792375200`, 1)
	j2, _ := parseJob(json.RawMessage(other))
	j3, _ := parseJob(json.RawMessage(strings.Replace(pve01Job, `"keep-daily":"14"`, `"keep-daily":"15"`, 1)))
	j4, _ := parseJob(json.RawMessage(`{"schedule":"04:00","all":1,"next-run":1,"id":"backup-dc316015-ac2c"}`))
	j5, _ := parseJob(json.RawMessage(`{"id":"backup-dc316015-ac2c","all":1,"schedule":"04:00"}`))
	if j2.job.Digest != a.Digest || j3.job.Digest == a.Digest || j4.job.Digest != j5.job.Digest {
		t.Errorf("digests %s %s %s / %s %s", a.Digest, j2.job.Digest, j3.job.Digest, j4.job.Digest, j5.job.Digest)
	}
}

func TestPVEBackupJobCreate(t *testing.T) {
	f := newFakePVE(t)
	withJobs(f)
	m := newTestManage(t, f)
	p := &pveshRunner{}
	m.run = p.run
	keep := &proto.BackupKeep{Last: 7, Daily: 14}
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: &proto.BackupJobSpec{
		Schedule: str("04:00"), Storage: str("local"), Selection: str("all"), Exclude: []string{"200", "100"},
		Keep: keep, NotesTemplate: str("{{guestname}} -- nightly"), Comment: str("Nightly, everything")}})
	if !r.OK || !pveJobIDRe.MatchString(r.JobID) || !strings.HasPrefix(r.JobID, "backup-") || len(r.JobID) != 20 || len(p.calls) != 1 {
		t.Fatalf("create: %+v %q", r, p.calls)
	}
	want := []string{"pvesh", "create", "/cluster/backup", "--id=" + r.JobID, "--all=1", "--comment=Nightly, everything",
		"--compress=zstd", "--exclude=100,200", "--mode=snapshot", "--notes-template={{guestname}} -- nightly",
		"--prune-backups=keep-last=7,keep-daily=14", "--schedule=04:00", "--storage=local"}
	if !reflect.DeepEqual(p.calls[0], want) {
		t.Errorf("pvesh =\n%q\nwant\n%q", p.calls[0], want)
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Errorf("API changes %v (jobs change as root)", ch)
	}
	// On a Proxmox Backup Server the job does not compress; guests jobs
	// name their vmids.
	p.calls = nil
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: &proto.BackupJobSpec{
		Schedule: str("sat 02:30"), Storage: str("pbs"), Selection: str("guests"), Guests: []string{"200", "100"},
		Enabled: new(false), Node: str("pve1"), Mode: str("stop")}})
	if !r.OK || len(p.calls) != 1 || !reflect.DeepEqual(p.calls[0][4:], []string{"--enabled=0", "--mode=stop", "--node=pve1",
		"--schedule=sat 02:30", "--storage=pbs", "--vmid=100,200"}) {
		t.Fatalf("guests job: %+v %q", r, p.calls)
	}

	// Every value is checked before anything runs.
	base := func() *proto.BackupJobSpec {
		return &proto.BackupJobSpec{Schedule: str("04:00"), Storage: str("local"), Selection: str("all")}
	}
	cases := []struct {
		name  string
		edit  func(*proto.BackupJobSpec)
		field string
	}{
		{"no storage", func(s *proto.BackupJobSpec) { s.Storage = nil }, "storage"},
		{"guest storage", func(s *proto.BackupJobSpec) { s.Storage = str("local-zfs") }, "storage"},
		{"inactive storage", func(s *proto.BackupJobSpec) { s.Storage = str("nas-iso") }, "storage"},
		{"other storage", func(s *proto.BackupJobSpec) { s.Storage = str("elsewhere") }, "storage"},
		{"no schedule", func(s *proto.BackupJobSpec) { s.Schedule = nil }, "schedule"},
		{"schedule", func(s *proto.BackupJobSpec) { s.Schedule = str("04:00; reboot") }, "schedule"},
		{"long schedule", func(s *proto.BackupJobSpec) { s.Schedule = str(strings.Repeat("1", 129)) }, "schedule"},
		{"no selection", func(s *proto.BackupJobSpec) { s.Selection = nil }, "selection"},
		{"selection", func(s *proto.BackupJobSpec) { s.Selection = str("some") }, "selection"},
		{"mode", func(s *proto.BackupJobSpec) { s.Mode = str("fast") }, "mode"},
		{"compress", func(s *proto.BackupJobSpec) { s.Compress = str("none") }, "compress"},
		{"keep", func(s *proto.BackupJobSpec) { s.Keep = &proto.BackupKeep{Daily: 10001} }, "keep"},
		{"negative keep", func(s *proto.BackupJobSpec) { s.Keep = &proto.BackupKeep{Last: -1} }, "keep"},
		{"comment", func(s *proto.BackupJobSpec) { s.Comment = str("two\nlines") }, "comment"},
		{"notes", func(s *proto.BackupJobSpec) { s.NotesTemplate = str(strings.Repeat("x", 1025)) }, "notes_template"},
		{"unknown guest", func(s *proto.BackupJobSpec) { s.Exclude = []string{"999"} }, "exclude"},
		{"bad guest", func(s *proto.BackupJobSpec) { s.Exclude = []string{"--all"} }, "exclude"},
		{"guests of all", func(s *proto.BackupJobSpec) { s.Guests = []string{"100"} }, "guests"},
		{"no guests", func(s *proto.BackupJobSpec) { s.Selection = str("guests") }, "guests"},
		{"exclude of guests", func(s *proto.BackupJobSpec) {
			s.Selection, s.Guests, s.Exclude = str("guests"), []string{"100"}, []string{"200"}
		}, "exclude"},
		{"no pool", func(s *proto.BackupJobSpec) { s.Selection = str("pool") }, "pool"},
		{"unknown pool", func(s *proto.BackupJobSpec) { s.Selection, s.Pool = str("pool"), str("staging") }, "pool"},
		{"pool name", func(s *proto.BackupJobSpec) { s.Selection, s.Pool = str("pool"), str("-x") }, "pool"},
		{"node", func(s *proto.BackupJobSpec) { s.Node = str("pve9") }, "node"},
		{"clear", func(s *proto.BackupJobSpec) { s.Clear = []string{"comment"} }, "comment"},
	}
	for _, tc := range cases {
		s := base()
		tc.edit(s)
		p.calls = nil
		r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: s})
		if r.OK || r.Code != proto.CodeInvalidValue || r.FieldErrors[tc.field] == "" || len(p.calls) != 0 {
			t.Errorf("%s: %+v %q", tc.name, r, p.calls)
		}
	}
	// Pools of a nested pool tree are pools too.
	s := base()
	s.Selection, s.Pool = str("pool"), str("lab/dev")
	if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobCreate, BackupJob: s}); !r.OK {
		t.Errorf("nested pool: %+v", r)
	}
	if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobCreate}); r.Code != CodeInvalid {
		t.Errorf("no job: %+v", r)
	}
}

func TestPVEBackupJobUpdate(t *testing.T) {
	f := newFakePVE(t)
	withJobs(f)
	m := newTestManage(t, f)
	p := &pveshRunner{}
	m.run = p.run
	jobs := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobList}).BackupJobs
	digest := jobs[slices.IndexFunc(jobs, func(j proto.BackupJob) bool { return j.ID == "backup-dc316015-ac2c" })].Digest
	upd := func(id, digest string, s *proto.BackupJobSpec) proto.ManageResponse {
		p.calls = nil
		return manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobUpdate, JobID: id, Digest: digest, BackupJob: s})
	}

	// Pause, change the time and the retention, drop the notes.
	r := upd("backup-dc316015-ac2c", digest, &proto.BackupJobSpec{Enabled: new(false), Schedule: str("02:00"),
		Keep: &proto.BackupKeep{Last: 3}, NotesTemplate: str(""), Exclude: []string{"100", "101", "104", "105", "200"}})
	if !r.OK || len(p.calls) != 1 {
		t.Fatalf("update: %+v %q", r, p.calls)
	}
	want := []string{"pvesh", "set", "/cluster/backup/backup-dc316015-ac2c", "--enabled=0", "--exclude=100,101,104,105,200",
		"--prune-backups=keep-last=3", "--schedule=02:00", "--delete=notes-template"}
	if !reflect.DeepEqual(p.calls[0], want) {
		t.Errorf("pvesh =\n%q\nwant\n%q", p.calls[0], want)
	}
	wantCh := []proto.ConfigChange{{Key: "enabled", Old: "true", New: "false"}, {Key: "schedule", Old: "04:00", New: "02:00"},
		{Key: "keep", Old: "last 7, daily 14, weekly 8, monthly 6", New: "last 3"}, {Key: "exclude", Old: "100,101,104,105", New: "100,101,104,105,200"},
		{Key: "notes_template", Old: "{{guestname}}"}}
	if !reflect.DeepEqual(r.Changes, wantCh) {
		t.Errorf("changes =\n%+v\nwant\n%+v", r.Changes, wantCh)
	}

	// A stale digest, an unknown job, a replication job: refused, nothing runs.
	if r := upd("backup-dc316015-ac2c", "stale", &proto.BackupJobSpec{Schedule: str("03:00")}); r.Code != proto.CodeDigestMismatch || len(p.calls) != 0 {
		t.Errorf("stale digest: %+v", r)
	}
	for _, id := range []string{"backup-gone", "100-0"} {
		if r := upd(id, "", &proto.BackupJobSpec{Schedule: str("03:00")}); r.Code != proto.CodeNotFound || len(p.calls) != 0 {
			t.Errorf("%s: %+v", id, r)
		}
	}
	if r := upd("../../nodes", "", &proto.BackupJobSpec{Schedule: str("03:00")}); r.Code != proto.CodeInvalidValue || len(p.calls) != 0 {
		t.Errorf("bad id: %+v", r)
	}
	// Nothing changes: nothing runs.
	if r := upd("backup-dc316015-ac2c", digest, &proto.BackupJobSpec{Schedule: str("04:00"), Mode: str("snapshot")}); !r.OK || len(r.Changes) != 0 || len(p.calls) != 0 {
		t.Errorf("no change: %+v %q", r, p.calls)
	}
	// From every guest to two: PVE drops all and exclude itself.
	r = upd("backup-dc316015-ac2c", "", &proto.BackupJobSpec{Selection: str("guests"), Guests: []string{"200", "100"}})
	if !r.OK || !reflect.DeepEqual(p.calls[0][3:], []string{"--vmid=100,200"}) {
		t.Errorf("to guests: %+v %q", r, p.calls)
	}
	// From a list to a pool, clearing the node and the comment.
	r = upd("backup-0a1b2c3d-0001", "", &proto.BackupJobSpec{Selection: str("pool"), Pool: str("prod"), Clear: []string{"node", "comment"}})
	if !r.OK || !reflect.DeepEqual(p.calls[0][3:], []string{"--pool=prod", "--delete=comment,node"}) {
		t.Errorf("to pool: %+v %q", r, p.calls)
	}
	// To all with an empty exclude list; keep-all.
	r = upd("backup-pool", "", &proto.BackupJobSpec{Selection: str("all"), Keep: &proto.BackupKeep{Weekly: 4}})
	if !r.OK || !reflect.DeepEqual(p.calls[0][3:], []string{"--all=1", "--prune-backups=keep-weekly=4"}) {
		t.Errorf("to all: %+v %q", r, p.calls)
	}
	r = upd("backup-dc316015-ac2c", "", &proto.BackupJobSpec{Clear: []string{"exclude", "keep"}})
	if !r.OK || !reflect.DeepEqual(p.calls[0][3:], []string{"--delete=exclude,prune-backups"}) {
		t.Errorf("clear: %+v %q", r, p.calls)
	}
	for name, s := range map[string]*proto.BackupJobSpec{
		"guests of all":  {Guests: []string{"100"}},
		"empty guests":   {Selection: str("guests")},
		"set and clear":  {Comment: str("x"), Clear: []string{"comment"}},
		"not clearable":  {Clear: []string{"schedule"}},
		"pool of guests": {Selection: str("guests"), Guests: []string{"100"}, Pool: str("prod")},
		"new unknown id": {Exclude: []string{"100", "101", "999"}},
	} {
		if r := upd("backup-dc316015-ac2c", "", s); r.Code != proto.CodeInvalidValue || len(p.calls) != 0 {
			t.Errorf("%s: %+v %q", name, r, p.calls)
		}
	}
}

func TestPVEBackupJobDeleteAndErrors(t *testing.T) {
	f := newFakePVE(t)
	withJobs(f)
	m := newTestManage(t, f)
	p := &pveshRunner{}
	m.run = p.run
	if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobDelete, JobID: "backup-pool"}); !r.OK ||
		!reflect.DeepEqual(p.calls, [][]string{{"pvesh", "delete", "/cluster/backup/backup-pool"}}) {
		t.Fatalf("delete: %+v %q", r, p.calls)
	}
	p.calls = nil
	if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobDelete, JobID: "backup-gone"}); r.Code != proto.CodeNotFound || len(p.calls) != 0 {
		t.Errorf("delete unknown: %+v", r)
	}

	// pvesh's errors: parameter errors name the request's fields.
	cases := []struct {
		err    error
		code   string
		fields map[string]string
	}{
		{&cmdError{name: "pvesh", msg: "400 Parameter verification failed.",
			stderr: "400 Parameter verification failed.\nschedule: value does not match the regex pattern\nprune-backups: invalid format\npvesh set <api_path> [OPTIONS]\n"},
			proto.CodeInvalidValue, map[string]string{"schedule": "value does not match the regex pattern", "keep": "invalid format"}},
		{&cmdError{name: "pvesh", msg: "Job 'backup-pool' already exists"}, proto.CodeExists, nil},
		{&cmdError{name: "pvesh", msg: "no such vzdump job"}, proto.CodeNotFound, nil},
		{&cmdError{name: "pvesh", msg: "cfs-lock 'file-jobs_cfg' error: got lock request timeout"}, proto.CodeLocked, nil},
		{&cmdError{name: "pvesh", msg: "storage 'x' does not exist"}, CodePlatformError, nil},
	}
	for _, tc := range cases {
		p.err = tc.err
		r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobUpdate, JobID: "backup-pool", BackupJob: &proto.BackupJobSpec{Schedule: str("22:00")}})
		if r.OK || r.Code != tc.code || (tc.fields != nil && !reflect.DeepEqual(r.FieldErrors, tc.fields)) || r.Message == "" {
			t.Errorf("%v: %+v", tc.err, r)
		}
	}
}

func TestPVEBackupJobRun(t *testing.T) {
	f := newFakePVE(t)
	withJobs(f)
	f.on("POST /nodes/pve1/vzdump", func(url.Values) fakeResp { return okResp(upidFor("vzdump", "")) })
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobRun, JobID: "backup-dc316015-ac2c"})
	if !r.OK || r.Task == nil || r.Task.ID != upidFor("vzdump", "") {
		t.Fatalf("run: %+v", r)
	}
	got := f.requested("POST", "/nodes/pve1/vzdump")
	want := url.Values{"all": {"1"}, "exclude": {"100,101,104,105"}, "storage": {"pbs"}, "mode": {"snapshot"}, "compress": {"zstd"},
		"notes-template": {"{{guestname}}"}, "remove": {"0"}}
	if len(got) != 1 || !reflect.DeepEqual(got[0].Form, want) {
		t.Errorf("vzdump = %v, want %v", got, want)
	}
	// A guests job without its own retention prunes as the storage says.
	f.reset()
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobRun, JobID: "backup-0a1b2c3d-0001"})
	got = f.requested("POST", "/nodes/pve1/vzdump")
	if !r.OK || len(got) != 1 || !reflect.DeepEqual(got[0].Form, url.Values{"vmid": {"100,200"}, "storage": {"local"}, "mode": {"stop"}, "compress": {"lzo"}}) {
		t.Errorf("guests job: %+v %v", r, got)
	}
	// Jobs for other nodes or without a storage do not run here.
	f.data("GET /cluster/resources", []map[string]any{{"vmid": 100, "node": "pve2"}, {"vmid": 200, "node": "pve2"}})
	f.reset()
	for id, code := range map[string]string{"backup-0a1b2c3d-0001": CodeUnsupported, "5f2e4c1a8b": proto.CodeNotAllowed, "backup-gone": proto.CodeNotFound} {
		if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobRun, JobID: id}); r.Code != code {
			t.Errorf("%s: %+v", id, r)
		}
	}
	if len(f.changes()) != 0 {
		t.Errorf("refused runs reached Proxmox VE: %v", f.changes())
	}
	withJobs(f)
	f.data("GET /cluster/backup", []any{json.RawMessage(`{"id":"backup-elsewhere","type":"vzdump","schedule":"01:00","storage":"local","all":1,"node":"pve2"}`)})
	if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupJobRun, JobID: "backup-elsewhere"}); r.Code != CodeUnsupported || !strings.Contains(r.Message, "pve2") {
		t.Errorf("other node: %+v", r)
	}
}

func TestPVEStorageAdd(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	var calls [][]string
	have := map[string]string{} // storage -> pvesh get's answer
	m.run = func(_ context.Context, argv ...string) ([]byte, error) {
		calls = append(calls, argv)
		if argv[1] == "get" {
			id := strings.TrimPrefix(argv[2], "/storage/")
			if s, ok := have[id]; ok {
				return []byte(s), nil
			}
			return nil, &cmdError{name: "pvesh", msg: "storage '" + id + "' does not exist", stderr: "storage '" + id + "' does not exist\n"}
		}
		return nil, nil
	}
	add := func(s proto.PVEStorageSpec) proto.ManageResponse {
		calls = nil
		return manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpStorageAdd, PVEStorage: &s})
	}
	spec := proto.PVEStorageSpec{Storage: "blackbox-backup", Type: "nfs", Server: "10.100.0.40", Export: "/mnt/user/whombat-pve-01", Content: []string{"backup"}}
	if r := add(spec); !r.OK || len(calls) != 2 || !reflect.DeepEqual(calls[1], []string{"pvesh", "create", "/storage",
		"--storage=blackbox-backup", "--type=nfs", "--server=10.100.0.40", "--export=/mnt/user/whombat-pve-01", "--content=backup"}) {
		t.Fatalf("add = %+v %q", r, calls)
	}
	// The same storage again: nothing to do.
	have["blackbox-backup"] = `{"type":"nfs","server":"10.100.0.40","export":"/mnt/user/whombat-pve-01","content":"backup","storage":"blackbox-backup"}`
	if r := add(spec); !r.OK || len(calls) != 1 {
		t.Errorf("again = %+v %q", r, calls)
	}
	// The name is taken by another storage.
	other := spec
	other.Export = "/mnt/user/other"
	if r := add(other); r.Code != proto.CodeExists || len(calls) != 1 {
		t.Errorf("taken = %+v %q", r, calls)
	}
	for field, s := range map[string]proto.PVEStorageSpec{
		"storage": {Storage: "Bad Name", Type: "nfs", Server: "10.100.0.40", Export: "/x", Content: []string{"backup"}},
		"type":    {Storage: "x1", Type: "cifs", Server: "10.100.0.40", Export: "/x", Content: []string{"backup"}},
		"server":  {Storage: "x1", Type: "nfs", Server: "blackbox", Export: "/x", Content: []string{"backup"}},
		"export":  {Storage: "x1", Type: "nfs", Server: "10.100.0.40", Export: "/x/../etc", Content: []string{"backup"}},
		"content": {Storage: "x1", Type: "nfs", Server: "10.100.0.40", Export: "/x", Content: []string{"images"}},
	} {
		if r := add(s); r.Code != proto.CodeInvalidValue || r.FieldErrors[field] == "" || len(calls) != 0 {
			t.Errorf("%s: %+v", field, r)
		}
	}
}
