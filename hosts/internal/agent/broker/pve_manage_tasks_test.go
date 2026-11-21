package broker

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func clusterOf(f *fakePVE) {
	f.data("GET /cluster/status", []map[string]any{
		{"type": "cluster", "name": "lab", "quorate": 1, "nodes": 3},
		{"type": "node", "name": "pve1", "local": 1, "online": 1},
		{"type": "node", "name": "pve3", "local": 0, "online": 0},
		{"type": "node", "name": "pve2", "local": 0, "online": 1},
	})
}

func TestPVEChoices(t *testing.T) {
	f := newFakePVE(t)
	clusterOf(f)
	f.data("GET /cluster/sdn/vnets", []map[string]any{{"vnet": "vnet10", "zone": "lab", "type": "vnet"}, {"vnet": "vmbr0"}})
	f.data("GET /cluster/resources", []map[string]any{
		{"id": "qemu/100", "type": "qemu", "vmid": 100, "name": "web", "node": "pve1", "template": 0},
		{"id": "qemu/9000", "type": "qemu", "vmid": 9000, "name": "debian-tmpl", "node": "pve1", "template": 1, "maxdisk": 8 << 30},
		{"id": "lxc/9001", "type": "lxc", "vmid": 9001, "name": "ct-tmpl", "node": "pve1", "template": 1},
		{"id": "qemu/9100", "type": "qemu", "vmid": 9100, "name": "other-node", "node": "pve2", "template": 1},
	})
	f.data("GET /nodes/pve1/capabilities/qemu/cpu", []map[string]any{{"name": "x86-64-v2-AES", "custom": 0}, {"name": "host", "custom": 0}})
	f.on("GET /access/permissions", func(q url.Values) fakeResp {
		if q.Get("path") != "/nodes/pve1" {
			t.Errorf("permissions path %q", q.Get("path"))
		}
		return okResp(map[string]any{"/nodes/pve1": map[string]any{"Sys.Audit": 1, "Sys.AccessNetwork": 1}})
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpChoices})
	if !r.OK || r.Choices == nil {
		t.Fatalf("choices: %+v", r)
	}
	c := r.Choices
	if c.Platform != "pve" || c.Node != "pve1" || !c.Cluster || c.NextID != 105 || !c.Download {
		t.Fatalf("choices header %+v", c)
	}
	if !reflect.DeepEqual(c.Nodes, []string{"pve2", "pve3"}) || !reflect.DeepEqual(c.Bridges, []string{"vmbr0", "vmbr1", "vnet10"}) ||
		!reflect.DeepEqual(c.CPUTypes, []string{"host", "x86-64-v2-AES"}) {
		t.Fatalf("nodes %v bridges %v cpus %v", c.Nodes, c.Bridges, c.CPUTypes)
	}
	var ids []string
	thin := map[string]bool{}
	for _, s := range c.Storages {
		ids = append(ids, s.ID)
		thin[s.ID] = s.Thin
	}
	if !reflect.DeepEqual(ids, []string{"local", "local-zfs", "pbs", "tank"}) { // nas-iso is inactive
		t.Fatalf("storages %v", ids)
	}
	if !thin["local"] || !thin["local-zfs"] || thin["tank"] || thin["pbs"] {
		t.Fatalf("thin %v", thin)
	}
	if c.Storages[1].AvailBytes != 400<<30 || !reflect.DeepEqual(c.Storages[1].Content, []string{"images", "rootdir"}) {
		t.Fatalf("local-zfs %+v", c.Storages[1])
	}
	if len(c.ISOs) != 1 || c.ISOs[0].Name != "debian-13.0.0-amd64-netinst.iso" || len(c.CTTemplates) != 1 || c.CTTemplates[0].Content != "vztmpl" {
		t.Fatalf("isos %+v templates %+v", c.ISOs, c.CTTemplates)
	}
	want := []proto.TemplateGuest{{ID: "9000", Name: "debian-tmpl", Kind: "vm", Node: "pve1", DiskBytes: 8 << 30}, {ID: "9001", Name: "ct-tmpl", Kind: "container", Node: "pve1"}}
	if !reflect.DeepEqual(c.Templates, want) {
		t.Fatalf("templates %+v", c.Templates)
	}

	// Without the ACL (PVE before 8.3): no downloads.
	f.data("GET /access/permissions", map[string]any{"/nodes/pve1": map[string]any{"Sys.Audit": 1}})
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpChoices}); r.Choices.Download {
		t.Fatal("download without Sys.AccessNetwork")
	}
}

func TestPVETaskList(t *testing.T) {
	f := newFakePVE(t)
	f.on("GET /nodes/pve1/tasks", func(q url.Values) fakeResp {
		if q.Get("vmid") != "100" || q.Get("limit") != "50" || q.Get("source") != "all" {
			t.Errorf("task query %v", q)
		}
		return okResp([]map[string]any{
			{"upid": upidFor("vzdump", "100"), "type": "vzdump", "id": "100", "user": "root@pam", "starttime": 1760600000, "endtime": 1760600300, "status": "WARNINGS: 2"},
			{"upid": upidFor("qmstart", "100"), "type": "qmstart", "id": "100", "user": "root@pam", "starttime": 1760700000},
			{"upid": upidFor("qmconfig", "100"), "type": "qmconfig", "id": "100", "user": "whombat-manage@pve!agent-pve1", "starttime": 1760650000, "endtime": 1760650001, "status": "OK"},
			{"upid": upidFor("qmclone", "100"), "type": "qmclone", "id": "100", "starttime": 1760500000, "endtime": 1760500100, "status": "clone failed: no space left"},
		})
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpTaskList})
	if !r.OK || len(r.Tasks) != 4 {
		t.Fatalf("task.list: %+v", r)
	}
	var got []string
	for _, ts := range r.Tasks {
		got = append(got, ts.Type+":"+ts.Status)
	}
	if want := []string{"qmstart:running", "qmconfig:ok", "vzdump:warning", "qmclone:error"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tasks %v, want %v", got, want)
	}
	if r.Tasks[0].Ended != nil || r.Tasks[2].Ended == nil || r.Tasks[2].Message != "WARNINGS: 2" || r.Tasks[3].Message != "clone failed: no space left" || r.Tasks[1].GuestID != "100" {
		t.Fatalf("task details %+v", r.Tasks)
	}
}

func TestPVETaskStatus(t *testing.T) {
	f := newFakePVE(t)
	upid := upidFor("qmclone", "100")
	tasks := "/nodes/pve1/tasks/" + upid
	running := true
	f.on("GET "+tasks+"/status", func(url.Values) fakeResp {
		if running {
			return okResp(map[string]any{"upid": upid, "status": "running", "type": "qmclone", "id": "100", "user": "whombat-manage@pve!agent-pve1", "starttime": 1760000000, "pid": 4242})
		}
		return okResp(map[string]any{"upid": upid, "status": "stopped", "exitstatus": "OK", "type": "qmclone", "id": "100", "starttime": 1760000000})
	})
	f.on("GET "+tasks+"/log", func(q url.Values) fakeResp {
		lines := []string{"create full clone of drive scsi0 (local-zfs:vm-100-disk-0)", "transferred 1.0 GiB of 32.0 GiB (3.12%)", "transferred 32.0 GiB of 32.0 GiB (100.00%)"}
		if q.Get("limit") != "500" {
			t.Errorf("log limit %q", q.Get("limit"))
		}
		start := map[string]int{"0": 0, "2": 2, "3": 3}[q.Get("start")]
		var out []map[string]any
		for i := start; i < len(lines); i++ {
			out = append(out, map[string]any{"n": i + 1, "t": lines[i]})
		}
		return okResp(out)
	})
	f.on("GET /nodes/pve1/tasks", func(q url.Values) fakeResp {
		if q.Get("typefilter") != "qmclone" || q.Get("vmid") != "100" || q.Get("since") != "1729163424" {
			t.Errorf("task end query %v", q)
		}
		return okResp([]map[string]any{{"upid": upid, "type": "qmclone", "starttime": 1760000000, "endtime": 1760000400, "status": "OK"}})
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: upid})
	ts := r.TaskStatus
	if !r.OK || ts == nil || ts.Status != "running" || len(ts.Log) != 3 || ts.LogNext != 3 || ts.Message != "transferred 32.0 GiB of 32.0 GiB (100.00%)" ||
		ts.GuestID != "100" || ts.Type != "qmclone" || ts.Started.Unix() != 0x6710F0A0 || ts.Ended != nil {
		t.Fatalf("running: %+v", ts)
	}
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: upid, LogStart: 2})
	if ts = r.TaskStatus; len(ts.Log) != 1 || ts.LogNext != 3 {
		t.Fatalf("log from 2: %+v", ts)
	}
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: upid, LogStart: 3})
	if ts = r.TaskStatus; len(ts.Log) != 0 || ts.LogNext != 3 {
		t.Fatalf("no new lines: %+v", ts)
	}
	running = false
	f.reset()
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: upid, LogStart: -1})
	if ts = r.TaskStatus; ts.Status != "ok" || ts.Message != "OK" || ts.Log != nil || ts.Ended == nil || ts.Ended.Unix() != 1760000400 {
		t.Fatalf("finished: %+v", ts)
	}
	if len(f.requested("GET", tasks+"/log")) != 0 {
		t.Fatal("log read with LogStart -1")
	}

	// An empty log is PVE's single "no content" line.
	f.on("GET "+tasks+"/log", func(url.Values) fakeResp { return okResp([]map[string]any{{"n": 1, "t": "no content"}}) })
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: upid}); len(r.TaskStatus.Log) != 0 || r.TaskStatus.LogNext != 0 {
		t.Fatalf("empty log: %+v", r.TaskStatus)
	}

	for task, code := range map[string]string{
		"UPID:pve2:0000A1B2:0012C3D4:6710F0A0:qmclone:100:root@pam:": CodeUnsupported,
		"UPID:pve1:xyz:0012C3D4:6710F0A0:qmclone:100:root@pam:":      CodeInvalid,
		"../../nodes/pve1/qemu/100/config":                           CodeInvalid,
		"incus:0f1e2d3c":                                             CodeInvalid,
		"":                                                           CodeInvalid,
	} {
		if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: task}); r.Code != code {
			t.Errorf("task %q: %+v, want %s", task, r, code)
		}
		if r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStop, Task: task}); r.Code != code {
			t.Errorf("stop %q: %+v, want %s", task, r, code)
		}
	}
	f.on("DELETE "+tasks, func(url.Values) fakeResp { return okResp(nil) })
	f.reset()
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpTaskStop, Task: upid}); !r.OK || len(f.requested("DELETE", tasks)) != 1 {
		t.Fatalf("task.stop: %+v %v", r, f.changes())
	}
}

func TestParseUPID(t *testing.T) {
	u, ok := parseUPID("UPID:pve-01:0000A1B2:0012C3D4:6710F0A0:vzdump:100:root@pam:")
	if !ok || u.Node != "pve-01" || u.Type != "vzdump" || u.ID != "100" || u.User != "root@pam" || !u.Start.Equal(time.Unix(0x6710F0A0, 0)) {
		t.Fatalf("parse %+v %v", u, ok)
	}
	if _, ok := parseUPID("UPID:pve1:0000A1B2:0012C3D4:6710F0A0:download::whombat-manage@pve!agent-pve1:"); !ok {
		t.Fatal("empty id refused")
	}
	for _, bad := range []string{"UPID:pve1:0000A1B2:0012C3D4:6710F0A0:vzdump:100:root@pam", "UPID:-pve:0000A1B2:0012C3D4:6710F0A0:vzdump:100:root@pam:",
		"UPID:pve1:0000A1B2:0012C3D4:6710F0A0:vz dump:100:root@pam:", "upid:pve1:0000A1B2:0012C3D4:6710F0A0:vzdump:100:root@pam:",
		"UPID:pve1:0000A1B2:0012C3D4:6710F0A0:x:../../qemu/100:root@pam:", "UPID:pve1:0000A1B2:0012C3D4:6710F0A0:x:100:root@pam?a=b:"} {
		if _, ok := parseUPID(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
	if r := taskAnswer("not a upid"); !r.OK || r.Task != nil {
		t.Fatalf("taskAnswer: %+v", r)
	}
}

func TestPVEFirewall(t *testing.T) {
	f := newFakePVE(t)
	fw := "/nodes/pve1/qemu/100/firewall"
	f.data("GET "+fw+"/options", map[string]any{"enable": 1, "policy_in": "DROP", "dhcp": 1, "ipfilter": 0, "digest": "optdigest", "log_level_in": "nolog"})
	f.data("GET "+fw+"/rules", []map[string]any{
		{"pos": 1, "type": "in", "action": "ACCEPT", "enable": 1, "proto": "tcp", "dport": "443", "digest": "ruledigest"},
		{"pos": 0, "type": "group", "action": "webservers", "enable": 0, "digest": "ruledigest", "comment": "shared"},
	})
	f.data("GET /cluster/firewall/groups", []map[string]any{{"group": "webservers", "digest": "g"}, {"group": "dns", "digest": "g"}})
	f.data("GET /cluster/firewall/options", map[string]any{"enable": 1, "policy_in": "DROP"})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallGet})
	if !r.OK || r.Firewall == nil {
		t.Fatalf("firewall.get: %+v", r)
	}
	g := r.Firewall
	if g.OptionsDigest != "optdigest" || g.RulesDigest != "ruledigest" || !g.ClusterEnabled || g.Options["policy_in"] != "DROP" || g.Options["enable"] != "1" {
		t.Fatalf("firewall %+v", g)
	}
	if _, ok := g.Options["digest"]; ok {
		t.Fatal("digest among the options")
	}
	if len(g.Rules) != 2 || g.Rules[0].Type != "group" || g.Rules[0].Enable || g.Rules[1].DPort != "443" || !g.Rules[1].Enable {
		t.Fatalf("rules %+v", g.Rules)
	}
	if !reflect.DeepEqual(g.Groups, []string{"dns", "webservers"}) {
		t.Fatalf("groups %v", g.Groups)
	}

	f.on("PUT "+fw+"/options", func(url.Values) fakeResp { return okResp(nil) })
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallOptions, Digest: "optdigest", Set: map[string]string{"enable": "1", "policy_in": "REJECT"}, Delete: []string{"log_level_in"}})
	ch := f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"enable": {"1"}, "policy_in": {"REJECT"}, "delete": {"log_level_in"}, "digest": {"optdigest"}}) {
		t.Fatalf("firewall.options: %+v %v", r, ch)
	}
	f.reset()
	for _, req := range []proto.ManageRequest{
		{Set: map[string]string{"policy_in": "ALLOW"}},
		{Set: map[string]string{"enable": "yes"}},
		{Set: map[string]string{"log_ratelimit": "enable=0"}},
		{Delete: []string{"macfilter,enable"}},
		{},
	} {
		req.Op = proto.OpFirewallOptions
		if r := manageOp(t, m, testVM, req); r.OK {
			t.Errorf("accepted %+v", req)
		}
	}

	f.on("POST "+fw+"/rules", func(url.Values) fakeResp { return okResp(nil) })
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleAdd, Digest: "ruledigest",
		Rule: &proto.FirewallRule{Type: "in", Action: "ACCEPT", Enable: true, Macro: "SSH", Source: "+trusted", Comment: "admins", Pos: 2}})
	ch = f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"type": {"in"}, "action": {"ACCEPT"}, "enable": {"1"}, "macro": {"SSH"},
		"source": {"+trusted"}, "comment": {"admins"}, "pos": {"2"}, "digest": {"ruledigest"}}) {
		t.Fatalf("rule add: %+v %v", r, ch)
	}
	f.reset()
	for _, rule := range []*proto.FirewallRule{
		nil,
		{Type: "in", Action: "ALLOW"},
		{Type: "forward", Action: "ACCEPT"},
		{Type: "group", Action: "nonexistent"},
		{Type: "in", Action: "DROP", Iface: "eth0"},
		{Type: "in", Action: "DROP", Log: "verbose"},
		{Type: "in", Action: "DROP", Comment: "two\nlines"},
		{Type: "in", Action: "DROP", Macro: "SSH; rm"},
	} {
		if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleAdd, Rule: rule}); r.OK {
			t.Errorf("accepted rule %+v", rule)
		}
	}
	if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleAdd, Rule: &proto.FirewallRule{Type: "group", Action: "dns", Enable: true}}); !r.OK {
		t.Fatalf("group rule: %+v", r)
	}

	f.on("PUT "+fw+"/rules/1", func(url.Values) fakeResp { return okResp(nil) })
	f.reset()
	one, zero := 1, 0
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleUpdate, Pos: &one, Digest: "ruledigest",
		Rule: &proto.FirewallRule{Type: "in", Action: "DROP", Enable: true, Proto: "tcp", DPort: "22"}})
	ch = f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"type": {"in"}, "action": {"DROP"}, "enable": {"1"}, "proto": {"tcp"}, "dport": {"22"},
		"delete": {"macro,source,dest,sport,iface,log,comment"}, "digest": {"ruledigest"}}) {
		t.Fatalf("rule update: %+v %v", r, ch)
	}
	f.reset()
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleUpdate, Pos: &one, MoveTo: &zero})
	if ch = f.changes(); !r.OK || !reflect.DeepEqual(ch[0].Form, url.Values{"moveto": {"0"}}) {
		t.Fatalf("rule move: %+v %v", r, ch)
	}
	if r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleUpdate, Rule: &proto.FirewallRule{Type: "in", Action: "DROP"}}); r.Code != CodeInvalid {
		t.Fatalf("update without position: %+v", r)
	}
	f.on("DELETE "+fw+"/rules/1", func(url.Values) fakeResp { return okResp(nil) })
	f.reset()
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleDelete, Pos: &one, Digest: "ruledigest"})
	if del := f.requested("DELETE", fw+"/rules/1"); !r.OK || len(del) != 1 || del[0].Form.Get("digest") != "ruledigest" {
		t.Fatalf("rule delete: %+v %v", r, del)
	}
	f.on("DELETE "+fw+"/rules/1", func(url.Values) fakeResp {
		return errResp(500, "detected modified configuration - file changed by other user? Try again.")
	})
	if r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpFirewallRuleDelete, Pos: &one, Digest: "old"}); r.Code != proto.CodeDigestMismatch {
		t.Fatalf("stale digest: %+v", r)
	}
}

// haRunner records ha-manager calls.
type haRunner struct {
	calls [][]string
	err   error
}

func (h *haRunner) run(ctx context.Context, argv ...string) ([]byte, error) {
	h.calls = append(h.calls, argv)
	return nil, h.err
}

func TestPVEHA(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	h := &haRunner{}
	m.run = h.run
	two := 2
	set := proto.ManageRequest{Op: proto.OpHASet, HA: &proto.HASettings{State: "started", MaxRestart: &two, Comment: "-- web --"}}
	if r := manageOp(t, m, testVM, set); r.Code != CodeUnsupported || len(h.calls) != 0 {
		t.Fatalf("HA on a standalone node: %+v %v", r, h.calls)
	}
	clusterOf(f)
	f.on("GET /cluster/ha/resources/vm:100", func(url.Values) fakeResp { return errResp(500, "no such resource 'vm:100'") })
	if r := manageOp(t, m, testVM, set); !r.OK {
		t.Fatalf("ha.set: %+v", r)
	}
	if want := [][]string{{"ha-manager", "add", "vm:100", "--state=started", "--max_restart=2", "--comment=-- web --"}}; !reflect.DeepEqual(h.calls, want) {
		t.Fatalf("calls %q", h.calls)
	}
	if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpHARemove}); r.Code != proto.CodeNotFound {
		t.Fatalf("remove without resource: %+v", r)
	}

	f.data("GET /cluster/ha/resources/ct:200", map[string]any{"sid": "ct:200", "state": "started", "comment": "old", "digest": "x"})
	h.calls = nil
	if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpHASet, HA: &proto.HASettings{State: "stopped"}}); !r.OK {
		t.Fatalf("ha.set existing: %+v", r)
	}
	if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpHARemove}); !r.OK {
		t.Fatalf("ha.remove: %+v", r)
	}
	if want := [][]string{{"ha-manager", "set", "ct:200", "--state=stopped", "--delete=comment"}, {"ha-manager", "remove", "ct:200"}}; !reflect.DeepEqual(h.calls, want) {
		t.Fatalf("calls %q", h.calls)
	}

	h.calls = nil
	eleven, minus := 11, -1
	for _, ha := range []*proto.HASettings{nil, {State: "enabled"}, {State: "started", MaxRestart: &eleven}, {State: "started", MaxRelocate: &minus}, {State: "started", Comment: "a\nb"}} {
		if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpHASet, HA: ha}); r.OK {
			t.Errorf("accepted %+v", ha)
		}
	}
	if len(h.calls) != 0 {
		t.Fatalf("refused HA settings ran: %q", h.calls)
	}
	h.err = errors.New("ha-manager: cfs-lock 'domain-ha' error: got lock request timeout")
	if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpHARemove}); r.Code != CodePlatformError || r.Message != h.err.Error() {
		t.Fatalf("ha-manager failure: %+v", r)
	}
}

func TestPVEReplication(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	add := proto.ManageRequest{Op: proto.OpReplicationAdd, Target: "pve2", Schedule: "*/30", Rate: "50", Comment: "dr"}
	if r := manageOp(t, m, testVM, add); r.Code != CodeUnsupported {
		t.Fatalf("standalone: %+v", r)
	}
	clusterOf(f)
	f.data("GET /cluster/replication", []map[string]any{
		{"id": "100-0", "guest": 100, "target": "pve3", "type": "local", "jobnum": 0},
		{"id": "100-2", "guest": 100, "target": "pve3", "type": "local", "jobnum": 2},
		{"id": "1001-1", "guest": 1001, "target": "pve2", "type": "local", "jobnum": 1},
	})
	f.on("POST /cluster/replication", func(url.Values) fakeResp { return okResp(nil) })
	r := manageOp(t, m, testVM, add)
	ch := f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"id": {"100-1"}, "type": {"local"}, "target": {"pve2"}, "schedule": {"*/30"}, "rate": {"50"}, "comment": {"dr"}}) {
		t.Fatalf("replication.add: %+v %v", r, ch)
	}
	f.reset()
	for _, req := range []proto.ManageRequest{
		{Target: "pve1"}, {Target: "pve9"}, {Target: ""},
		{Target: "pve2", Schedule: "*/15; reboot"}, {Target: "pve2", Rate: "fast"}, {Target: "pve2", Comment: "a\x00b"},
	} {
		req.Op = proto.OpReplicationAdd
		if r := manageOp(t, m, testVM, req); r.OK {
			t.Errorf("accepted %+v", req)
		}
	}
	f.on("DELETE /cluster/replication/100-2", func(url.Values) fakeResp { return okResp(nil) })
	if r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpReplicationDelete, JobID: "100-2"}); !r.OK {
		t.Fatalf("replication.delete: %+v", r)
	}
	for _, job := range []string{"1001-1", "100", "100-x", "../100-1"} {
		if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpReplicationDelete, JobID: job}); r.OK {
			t.Errorf("deleted job %q", job)
		}
	}
	if ch := f.changes(); len(ch) != 1 {
		t.Fatalf("requests %v", ch)
	}
}
