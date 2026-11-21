package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// pveData reads a /pending capture: the configuration in effect and the
// number of pending changes.
func pveData(t *testing.T, name string) (map[string]flexString, int) {
	t.Helper()
	var env struct {
		Data []pvePendingItem `json:"data"`
	}
	if err := json.Unmarshal(readTestdata(t, name), &env); err != nil {
		t.Fatal(err)
	}
	return pvePendingConfig(env.Data)
}

func TestParsePVEGuestConfig(t *testing.T) {
	raw, pending := pveData(t, "pve_qemu_100_pending.json")
	vnc := parsePVEGuestConfig("vm", raw, 1)
	if vnc.vcpu != 1 || vnc.memBytes != 1<<30 || vnc.firmware != "SeaBIOS" || vnc.machine != "q35" || vnc.conf["serial0"] != "socket" || vnc.osType != "linux" || !vnc.agent || pending != 0 {
		t.Errorf("100: %+v pending=%d", vnc, pending)
	}
	if vnc.image() != "Linux" {
		t.Errorf("100 image %q", vnc.image())
	}
	// The cloud-init drive is a CD-ROM, not a disk.
	if len(vnc.disks) != 1 || vnc.disks["local"] != 8<<30 {
		t.Errorf("100 disks: %v", vnc.disks)
	}
	// Running with changes that wait for a restart: the values in effect
	// count (memory 1024, onboot still set, no net1 yet).
	raw, pending = pveData(t, "pve_qemu_101_pending.json")
	sp := parsePVEGuestConfig("vm", raw, 1)
	if pending != 3 || sp.memBytes != 1<<30 || sp.conf["onboot"] != "1" || sp.conf["net1"] != "" || !sp.agent {
		t.Errorf("101: %+v pending=%d", sp, pending)
	}
	raw, _ = pveData(t, "pve_lxc_200_pending.json")
	ct := parsePVEGuestConfig("container", raw, 4)
	if ct.vcpu != 1 || ct.memBytes != 512<<20 || ct.image() != "debian" || ct.osType != "linux" {
		t.Errorf("200: %+v image=%q", ct, ct.image())
	}
	// Bind mounts are not on a storage.
	raw, _ = pveData(t, "pve_lxc_201_pending.json")
	if d := parsePVEGuestConfig("container", raw, 4).disks; len(d) != 1 || d["local-zfs"] != 8<<30 {
		t.Errorf("201 disks: %v", d)
	}
	ct.osInfo = "debian 13"
	if ct.image() != "debian 13" {
		t.Errorf("200 with os-release: %q", ct.image())
	}
	win := parsePVEGuestConfig("vm", map[string]flexString{
		"ostype": "win11", "bios": "ovmf", "tpmstate0": "local-lvm:vm-101-disk-2,size=4M,version=v2.0",
		"cores": "4", "sockets": "2", "memory": "current=16384", "balloon": "8192", "vga": "qxl2", "machine": "pc-q35-9.2+pve1", "agent": "1,fstrim_cloned_disks=1",
	}, 8)
	if win.image() != "Windows 11 · OVMF · TPM" || win.vcpu != 8 || win.memBytes != 16<<30 || !win.balloon || win.osType != "windows" || !win.agent {
		t.Errorf("win: %+v image=%q", win, win.image())
	}
	if a := parsePVEGuestConfig("vm", map[string]flexString{"agent": "enabled=0,fstrim_cloned_disks=1"}, 1); a.agent {
		t.Error("agent enabled=0 parsed as enabled")
	}
	nolimit := parsePVEGuestConfig("container", map[string]flexString{"ostype": "alpine"}, 6)
	if nolimit.vcpu != 6 {
		t.Errorf("container without cores: vcpu=%d", nolimit.vcpu)
	}
}

func TestParseVzdumpLog(t *testing.T) {
	var env struct {
		Data []struct {
			T string `json:"t"`
		} `json:"data"`
	}
	if err := json.Unmarshal(readTestdata(t, "pve_task_log.json"), &env); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, l := range env.Data {
		lines = append(lines, l.T)
	}
	l := parseVzdumpLog(lines, time.UTC)
	if l.Total != 5 || l.OK != 5 || len(l.Failed) != 0 || l.Mode != "snapshot" || l.Storage != "local" {
		t.Errorf("log: %+v", l)
	}
	// 479MB + 482MB + 367MB + 161MB + 159MB, binary units.
	if want := uint64((479 + 482 + 367 + 161 + 159) << 20); l.Written != want {
		t.Errorf("written %d, want %d", l.Written, want)
	}
	if g := l.Guests[101]; g.Result != "ok" || !g.At.Equal(time.Date(2026, 10, 11, 14, 16, 12, 0, time.UTC)) {
		t.Errorf("guest 101: %+v", g)
	}

	failed := parseVzdumpLog([]string{
		"INFO: starting new backup job: vzdump 100 101 --mode stop --storage pbs1",
		"INFO: Starting Backup of VM 100 (qemu)",
		"INFO: Backup started at 2026-10-11 00:00:01",
		"INFO: transferred 8.00 GiB in 30 seconds (273.1 MiB/s)",
		"INFO: backup was done incrementally, reused 7.50 GiB (93%)",
		"INFO: Finished Backup of VM 100 (00:00:30)",
		"INFO: Starting Backup of VM 101 (qemu)",
		"INFO: Backup started at 2026-10-11 00:00:31",
		"ERROR: Backup of VM 101 failed - unable to open file",
		"INFO: Failed at 2026-10-11 00:00:32",
	}, time.UTC)
	if failed.Total != 2 || failed.OK != 1 || len(failed.Failed) != 1 || failed.Mode != "stop" || failed.Storage != "pbs1" {
		t.Errorf("failed log: %+v", failed)
	}
	if failed.Written != 512<<20 { // PBS: transferred - reused
		t.Errorf("pbs written %d", failed.Written)
	}
	if failed.Guests[101].Result != "error" {
		t.Errorf("guest 101: %+v", failed.Guests[101])
	}
	for status, want := range map[string]string{"OK": "ok", "WARNINGS: 2": "warning", "job errors": "error"} {
		if got, _ := taskResult(status); got != want {
			t.Errorf("taskResult(%q) = %q", status, got)
		}
	}
	if _, w := taskResult("WARNINGS: 3"); w != 3 {
		t.Errorf("warnings %d", w)
	}
}

func TestPVETokenID(t *testing.T) {
	if pveTokenID("pve1") != "agent-pve1" || pveTokenID("node 1") != "agent-node-1" || pveTokenID("") != "agent" {
		t.Error(pveTokenID("node 1"))
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "tok")
	os.WriteFile(p, []byte("whombat@pve!agent-pve1=11111111-2222-3333-4444-555555555555\n"), 0o600)
	if tok, err := readPVEToken(p); err != nil || !strings.HasPrefix(tok, "whombat@pve!agent-pve1=") {
		t.Errorf("readPVEToken: %q %v", tok, err)
	}
	os.WriteFile(p, []byte("garbage"), 0o600)
	if _, err := readPVEToken(p); err == nil {
		t.Error("malformed token accepted")
	}
}

func TestPVEStorageDetail(t *testing.T) {
	for _, c := range []struct {
		cfg  pveStorageCfg
		want string
	}{
		{pveStorageCfg{Type: "zfspool", Pool: "rpool/data"}, "rpool/data"},
		{pveStorageCfg{Type: "dir", Path: "/var/lib/vz"}, "/var/lib/vz"},
		{pveStorageCfg{Type: "lvmthin", VGName: "pve", ThinPool: "data"}, "pve/data"},
		{pveStorageCfg{Type: "pbs", Server: "192.0.2.5", Datastore: "store1"}, "192.0.2.5:store1"},
		{pveStorageCfg{Type: "nfs", Server: "192.0.2.6", Export: "/export/pve", Path: "/mnt/pve/nfs"}, "192.0.2.6:/export/pve"},
	} {
		if got := c.cfg.detail(); got != c.want {
			t.Errorf("%s: %q, want %q", c.cfg.Type, got, c.want)
		}
	}
}

// TestPVECollector runs the collector against a fake PVE API that serves the
// sanitized captures of the test cluster.
func TestPVECollector(t *testing.T) {
	files := map[string]string{
		"/api2/json/version":                      "pve_version.json",
		"/api2/json/cluster/status":               "pve_cluster_status.json",
		"/api2/json/cluster/config/nodes":         "pve_cluster_config_nodes.json",
		"/api2/json/cluster/ha/status/current":    "pve_ha_status.json",
		"/api2/json/cluster/resources":            "pve_cluster_resources.json",
		"/api2/json/cluster/backup":               "pve_cluster_backup.json",
		"/api2/json/storage":                      "pve_storage_cfg.json",
		"/api2/json/nodes/pve1/storage":           "pve_node_storage.json",
		"/api2/json/nodes/pve1/qemu/100/pending":  "pve_qemu_100_pending.json",
		"/api2/json/nodes/pve1/qemu/101/pending":  "pve_qemu_101_pending.json",
		"/api2/json/nodes/pve1/qemu/102/pending":  "pve_qemu_100_pending.json",
		"/api2/json/nodes/pve1/qemu/9000/pending": "pve_qemu_100_pending.json",
		"/api2/json/nodes/pve1/lxc/200/pending":   "pve_lxc_200_pending.json",
		"/api2/json/nodes/pve1/lxc/201/pending":   "pve_lxc_201_pending.json",
		"/api2/json/nodes/pve1/tasks":             "pve_tasks.json",
		"/api2/json/nodes/pve1/qemu":              "pve_qemu_list.json",
		"/api2/json/cluster/tasks":                "pve_cluster_tasks.json",
		"/api2/json/nodes/pve1/replication":       "pve_replication.json",
		"/api2/json/cluster/ceph/status":          "pve_ceph_status.json",
		"/api2/json/nodes/pve1/tasks/UPID:pve1:00004926:0000FAD7:6ACB9A27:vzdump::root@pam:/log": "pve_task_log.json",
	}
	var sawAuth bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "PVEAPIToken=whombat@pve!agent-pve1=secret" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		sawAuth = true
		switch {
		case strings.HasSuffix(r.URL.Path, "/status/current"):
			w.Write([]byte(`{"data":{"pid":0}}`))
			return
		case strings.HasSuffix(r.URL.Path, "/content"):
			w.Write([]byte(`{"data":[]}`)) // PVEAuditor sees no backup volumes
			return
		case strings.HasSuffix(r.URL.Path, "/snapshot"):
			if strings.Contains(r.URL.Path, "/101/") {
				w.Write([]byte(`{"data":[{"name":"before-upgrade","snaptime":1791000000},{"name":"base","snaptime":1790000000},{"name":"current","parent":"before-upgrade"}]}`))
			} else {
				w.Write([]byte(`{"data":[{"name":"current"}]}`))
			}
			return
		case strings.HasSuffix(r.URL.Path, "/agent/get-osinfo"):
			switch r.URL.Path {
			case "/api2/json/nodes/pve1/qemu/100/agent/get-osinfo":
				w.Write([]byte(`{"data":{"result":{"id":"debian","version-id":"13","name":"Debian GNU/Linux"}}}`))
			case "/api2/json/nodes/pve1/qemu/101/agent/get-osinfo":
				pveFail(w, http.StatusInternalServerError, "QEMU guest agent is not running")
			default:
				t.Errorf("guest agent of a guest that is not running asked: %s", r.URL)
				http.NotFound(w, r)
			}
			return
		}
		if r.URL.Path == "/api2/json/nodes/pve1/qemu" && r.URL.Query().Get("full") != "1" {
			t.Errorf("qemu list without full=1: %s", r.URL)
		}
		f, ok := files[r.URL.Path]
		if !ok {
			t.Errorf("unexpected request %s", r.URL)
			http.NotFound(w, r)
			return
		}
		w.Write(readTestdata(t, f))
	}))
	defer srv.Close()

	tok := filepath.Join(t.TempDir(), "pve-token")
	os.WriteFile(tok, []byte("whombat@pve!agent-pve1=secret\n"), 0o600)
	on := true
	cfg := &agent.Config{PVE: agent.PVEConfig{URL: srv.URL + "/api2/json", TokenFile: tok}, Collectors: agent.Collectors{PVE: &on}}
	c := New(cfg, "test").(*collector)
	// This node is part of a Ceph cluster.
	hostRoot := t.TempDir()
	writeTree(t, hostRoot, map[string]string{"etc/pve/ceph.conf": "[global]\n"})
	c.host.root = fsRoot(hostRoot)
	p := c.pve
	ctx := context.Background()
	if err := p.run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.runSlow(ctx); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	for k, s := range p.prev {
		s.at = s.at.Add(-20 * time.Second) // unchanged counters within 15 s keep the old rate
		p.prev[k] = s
	}
	p.mu.Unlock()
	if err := p.run(ctx); err != nil {
		t.Fatal(err)
	}
	if !sawAuth {
		t.Fatal("token not sent")
	}
	r := p.snapshot()
	if r == nil || r.Error != "" || r.Node != "pve1" || r.Version != "9.2.21" {
		t.Fatalf("pve: %+v", r)
	}
	if r.Cluster == nil || r.Cluster.Name != "lab" || !r.Cluster.Quorate || r.Cluster.VotesHave != 2 || r.Cluster.VotesExpected != 2 {
		t.Errorf("cluster: %+v", r.Cluster)
	}
	if len(r.Nodes) != 2 || !r.Nodes[0].ThisNode || r.Nodes[0].VMs != 3 || r.Nodes[0].Containers != 2 || r.Nodes[1].Containers != 1 || !r.Nodes[1].Online {
		t.Errorf("nodes: %+v", r.Nodes)
	}
	if len(r.Storages) != 2 || r.Storages[0].ID != "local" || r.Storages[0].Detail != "/var/lib/vz" || r.Storages[0].TotalBytes == 0 || !r.Storages[0].Active {
		t.Errorf("storages: %+v", r.Storages)
	}
	// Provisioned: 100, 101, 102 and the template 9000 (8 GiB each) and
	// 200 (4 GiB) on local; 201's root disk on local-zfs (its bind mount
	// is no storage). Both are thin (files; ZFS with sparse).
	if st := r.Storages[0]; st.ProvisionedBytes != 36<<30 || !st.Thin {
		t.Errorf("local provisioned: %+v", st)
	}
	if st := r.Storages[1]; st.ID != "local-zfs" || st.ProvisionedBytes != 8<<30 || !st.Thin || st.Detail != "rpool/data" {
		t.Errorf("local-zfs: %+v", st)
	}
	// Templates of this node only, sized from their configs.
	if len(r.Templates) != 1 || r.Templates[0] != (proto.TemplateGuest{ID: "9000", Name: "deb-template", Kind: "vm", Node: "pve1", DiskBytes: 8 << 30}) {
		t.Errorf("templates: %+v", r.Templates)
	}
	b := r.Backups
	if b == nil || b.LastJob == nil || b.LastJob.Schedule != "daily" || b.LastJob.GuestsOK != 5 || b.LastJob.GuestsTotal != 5 || b.LastJob.Result != "ok" || b.LastJob.DurationS != 18 || b.Target != "local" || b.NextRun == nil {
		t.Errorf("backups: %+v / %+v", b, b.LastJob)
	}
	if len(r.Guests) != 5 {
		t.Fatalf("guests: %+v", r.Guests)
	}
	g := map[string]proto.Guest{}
	for _, x := range r.Guests {
		g[x.ID] = x
	}
	vm := g["100"]
	if vm.Kind != "vm" || vm.VMID != 100 || vm.Node != "pve1" || vm.State != proto.StateRunning || vm.Image != "debian 13" || vm.VCPU != 1 || vm.MemConfigBytes != 1<<30 {
		t.Errorf("100: %+v", vm)
	}
	if strings.Join(vm.Tags, ",") != "prod,web" || vm.GuestAgent != "running" || vm.PendingChanges != 0 || vm.HAState != "" || vm.OldestSnapshot != nil {
		t.Errorf("100 tags/agent/pending/ha: %+v", vm)
	}
	// 101 waits for a restart (memory, a new NIC, onboot removed), its
	// agent does not answer, it is an HA resource.
	if sp := g["101"]; sp.PendingChanges != 3 || sp.GuestAgent != "not_running" || sp.HAState != "started" || sp.MemConfigBytes != 1<<30 {
		t.Errorf("101 pending/agent/ha: %+v", sp)
	}
	if st := g["102"]; st.GuestAgent != "" {
		t.Errorf("102 stopped with agent state %q", st.GuestAgent)
	}
	// Backup jobs: everything but 102 and 201 (all + exclude), 201 through
	// its pool; the job for 102 runs on pve2 only, the other is disabled.
	for id, want := range map[string]bool{"100": true, "101": true, "102": false, "200": true, "201": true} {
		if b := g[id].BackupJob; b == nil || *b != want {
			t.Errorf("%s backup job: %v, want %v", id, b, want)
		}
	}
	if vm.Console.Default != proto.ProtoVNC || len(vm.Console.Protocols) != 2 || vm.CPUPct == nil || vm.StartedAt == nil {
		t.Errorf("100 console/live: %+v", vm)
	}
	if vm.LastBackup == nil || vm.LastBackup.Result != "ok" {
		t.Errorf("100 last backup: %+v", vm.LastBackup)
	}
	if sp := g["101"]; len(sp.Console.Protocols) != 3 || sp.Console.Protocols[1] != proto.ProtoSPICE {
		t.Errorf("101 console: %+v", sp.Console)
	}
	if ct := g["200"]; ct.Kind != "container" || ct.Console.Default != proto.ProtoShell || ct.MemLimitBytes == nil {
		t.Errorf("200: %+v", ct)
	}
	if st := g["102"]; st.State != proto.StateStopped || st.CPUPct != nil || st.StartedAt != nil {
		t.Errorf("102: %+v", st)
	}
	// Rates come from deltas; identical counters give zero.
	if vm.DiskWriteBps == nil || *vm.DiskWriteBps != 0 {
		t.Errorf("100 disk write rate: %v", vm.DiskWriteBps)
	}
	// QMP says 101 is paused; snapshots exclude "current"; LXC disk usage.
	if sp := g["101"]; sp.State != proto.StatePaused || sp.SnapshotsCount == nil || *sp.SnapshotsCount != 2 || sp.OldestSnapshot == nil || sp.OldestSnapshot.Unix() != 1790000000 {
		t.Errorf("101 paused/snapshots: %+v", sp)
	}
	if vm.SnapshotsCount == nil || *vm.SnapshotsCount != 0 {
		t.Errorf("100 snapshots: %v", vm.SnapshotsCount)
	}
	if ct := g["200"]; ct.DiskUsedBytes == nil || *ct.DiskUsedBytes != 598827008 {
		t.Errorf("200 disk: %v", ct.DiskUsedBytes)
	}
	// The running backup is always listed (the fixture's failed tasks are
	// older than 48 hours by now).
	if len(r.Tasks) == 0 || r.Tasks[0].Status != "running" || r.Tasks[0].End != nil || r.Tasks[0].OK {
		t.Errorf("tasks: %+v", r.Tasks)
	}
	if len(r.Replication) != 2 || r.Replication[1].ID != "101-0" || r.Replication[1].FailCount != 2 || r.Replication[1].Error == "" || r.Replication[1].Guest != "101" {
		t.Errorf("replication: %+v", r.Replication)
	}
	if r.Ceph == nil || r.Ceph.Status != "HEALTH_WARN" || len(r.Ceph.Summary) != 3 || r.Ceph.Summary[0] != "mon pve1 is very low on available space" {
		t.Errorf("ceph: %+v", r.Ceph)
	}
}

func TestPVETasks(t *testing.T) {
	var env struct {
		Data []pveClusterTask `json:"data"`
	}
	if err := json.Unmarshal(readTestdata(t, "pve_cluster_tasks.json"), &env); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1791880100, 0)
	got := pveTasks(env.Data, now)
	// Running vzdump and the failed qmstart; not the OK migration, not the
	// vzdump with warnings, not the failure from 10 days ago.
	if len(got) != 2 {
		t.Fatalf("tasks: %+v", got)
	}
	if got[0].Type != "vzdump" || got[0].Status != "running" || got[0].End != nil {
		t.Errorf("running: %+v", got[0])
	}
	if f := got[1]; f.Type != "qmstart" || f.ID != "300" || f.Node != "pve2" || f.OK || f.End == nil || f.Status != "start failed: QEMU exited with code 1" {
		t.Errorf("failed: %+v", f)
	}
}

// A 403 (no Sys.Audit) or 501 (Ceph not installed) is not an error.
func TestPVEStatusError(t *testing.T) {
	err := fmt.Errorf("pve /cluster/ceph/status: %w", &pveStatusError{Code: 501, Msg: "501 Not Implemented"})
	if pveStatus(err) != 501 || pveStatus(errors.New("x")) != 0 {
		t.Error("pveStatus")
	}
}

// pveFail answers like the PVE API server: the error text is the HTTP
// reason phrase.
func pveFail(w http.ResponseWriter, code int, reason string) {
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		http.Error(w, reason, code)
		return
	}
	defer conn.Close()
	body := `{"data":null}`
	fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\nContent-Type: application/json;charset=UTF-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", code, reason, len(body), body)
	buf.Flush()
}

// TestPVEGuestAgent: the agent state of a running VM and when it is asked
// again.
func TestPVEGuestAgent(t *testing.T) {
	var answer func(w http.ResponseWriter)
	var calls int
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/pending"):
			w.Write([]byte(`{"data":[{"key":"agent","value":"1"},{"key":"memory","value":"1024"}]}`))
		case strings.HasSuffix(r.URL.Path, "/agent/get-osinfo"):
			calls++
			answer(w)
		default:
			t.Errorf("unexpected %s", r.URL)
		}
	}))
	defer srv.Close()
	p := newPVECollector(&agent.Config{}, nil)
	p.client, p.baseURL, p.token = srv.Client(), srv.URL, "x"
	ok := func(w http.ResponseWriter) { w.Write([]byte(`{"data":{"result":{"id":"debian","version-id":"13"}}}`)) }
	notRunning := func(w http.ResponseWriter) {
		pveFail(w, http.StatusInternalServerError, "QEMU guest agent is not running")
	}
	for _, tc := range []struct {
		name   string
		uptime int64
		answer func(w http.ResponseWriter)
		state  string
		next   time.Duration
	}{
		{"answers", 600, ok, "running", pveOSInfoEvery},
		{"not running", 600, notRunning, "not_running", pveAgentRetry},
		{"still booting", 30, notRunning, "", pveAgentBootRetry},
		{"no permission", 600, func(w http.ResponseWriter) { pveFail(w, http.StatusForbidden, "Permission check failed") }, "", pveOSInfoEvery},
		{"vm just stopped", 600, func(w http.ResponseWriter) { pveFail(w, http.StatusInternalServerError, "VM 100 is not running") }, "", pveOSInfoEvery},
	} {
		p.cfgCache = map[int]*pveGuestCfg{}
		answer, calls = tc.answer, 0
		now := time.Now()
		r := pveResource{VMID: 100, Status: "running", Uptime: tc.uptime}
		gc := p.guestConfig(context.Background(), "pve1", r, "vm", now)
		if gc == nil || calls != 1 || gc.agentState != tc.state || !gc.osNext.Equal(now.Add(tc.next)) {
			t.Errorf("%s: %+v calls=%d", tc.name, gc, calls)
			continue
		}
		// Not asked again before osNext (the VM keeps running).
		later := tc.next - time.Second
		r.Uptime += int64(later / time.Second)
		p.guestConfig(context.Background(), "pve1", r, "vm", now.Add(later))
		if calls != 1 {
			t.Errorf("%s: asked again after %v", tc.name, tc.next-time.Second)
		}
	}
	// A stopped VM has no agent state and is asked as soon as it runs.
	p.cfgCache = map[int]*pveGuestCfg{}
	answer, calls = ok, 0
	now := time.Now()
	p.guestConfig(context.Background(), "pve1", pveResource{VMID: 100, Status: "running", Uptime: 600}, "vm", now)
	gc := p.guestConfig(context.Background(), "pve1", pveResource{VMID: 100, Status: "stopped"}, "vm", now.Add(time.Minute))
	if gc.agentState != "" || !gc.osNext.IsZero() {
		t.Errorf("stopped: %+v", gc)
	}
	gc = p.guestConfig(context.Background(), "pve1", pveResource{VMID: 100, Status: "running", Uptime: 200}, "vm", now.Add(2*time.Minute))
	if calls != 2 || gc.agentState != "running" {
		t.Errorf("started: %+v calls=%d", gc, calls)
	}
	// A reboot (lower uptime) re-reads the config (pending changes apply)
	// and asks the agent again; a frozen uptime does neither.
	reads := 0
	for _, up := range []int64{210, 210, 210, 20} {
		before := gc.at
		gc = p.guestConfig(context.Background(), "pve1", pveResource{VMID: 100, Status: "running", Uptime: up}, "vm", now.Add(3*time.Minute))
		if !gc.at.Equal(before) {
			reads++
		}
	}
	if reads != 1 || calls != 3 {
		t.Errorf("reboot: %d config reads, %d agent calls", reads, calls)
	}
}

func TestPVEBackupCoverage(t *testing.T) {
	on, off := flexString("1"), flexString("0")
	for _, tc := range []struct {
		job  pveBackupJob
		vmid int
		pool string
		want bool
	}{
		{pveBackupJob{All: "1"}, 100, "", true},
		{pveBackupJob{All: "1", Exclude: "100, 101"}, 101, "", false},
		{pveBackupJob{All: "1", Exclude: "100"}, 1000, "", true},
		{pveBackupJob{All: "1", Enabled: &off}, 100, "", false},
		{pveBackupJob{All: "1", Enabled: &on, Node: "pve2"}, 100, "", false},
		{pveBackupJob{All: "1", Node: "pve1"}, 100, "", true},
		{pveBackupJob{VMID: "100,101;102"}, 102, "", true},
		{pveBackupJob{VMID: "100"}, 1001, "", false},
		{pveBackupJob{VMID: "100"}, 10, "", false},
		{pveBackupJob{Pool: "prod"}, 100, "prod", true},
		{pveBackupJob{Pool: "prod"}, 100, "", false},
		{pveBackupJob{Pool: "prod"}, 100, "lab", false},
		{pveBackupJob{All: "1", Type: "other"}, 100, "", false},
	} {
		if got := tc.job.covers("pve1", tc.vmid, tc.pool); got != tc.want {
			t.Errorf("%+v covers %d (pool %q) = %v", tc.job, tc.vmid, tc.pool, got)
		}
	}
	if backupCovered(nil, "pve1", 100, "") {
		t.Error("no jobs cover a guest")
	}
}

func TestPVEListsAndSizes(t *testing.T) {
	if got := strings.Join(pveSplitList(" prod;web,prod  db\t"), "|"); got != "prod|web|db" {
		t.Errorf("split: %q", got)
	}
	if pveSplitList("") != nil {
		t.Error("empty list")
	}
	for in, want := range map[string]uint64{"32G": 32 << 30, "4M": 4 << 20, "709474K": 709474 << 10, "1.5T": 3 << 39, "512": 512, "": 0, "8 G": 0, "-1G": 0} {
		if got := pveSize(in); got != want {
			t.Errorf("pveSize(%q) = %d, want %d", in, got, want)
		}
	}
	d := pveDiskSizes(map[string]string{
		"scsi0":     "local-zfs:vm-100-disk-0,iothread=1,size=32G",
		"virtio1":   "file=tank:vm-100-disk-1,size=100G",
		"efidisk0":  "local-zfs:vm-100-disk-2,efitype=4m,size=1M",
		"ide2":      "local:iso/debian.iso,media=cdrom,size=700M",
		"unused0":   "local-zfs:vm-100-disk-3",
		"mp0":       "/mnt/data,mp=/data",
		"mp1":       "volume=tank:subvol-100-disk-4,mp=/srv,size=8G",
		"net0":      "virtio=02:00:00:00:00:01,bridge=vmbr0",
		"tpmstate0": "local-zfs:vm-100-disk-5,size=4M,version=v2.0",
	})
	if len(d) != 2 || d["local-zfs"] != 32<<30+1<<20+4<<20 || d["tank"] != 108<<30 {
		t.Errorf("disk sizes: %v", d)
	}
	for _, tc := range []struct {
		cfg  pveStorageCfg
		want bool
	}{
		{pveStorageCfg{Type: "lvmthin"}, true},
		{pveStorageCfg{Type: "lvm"}, false},
		{pveStorageCfg{Type: "zfspool"}, false},
		{pveStorageCfg{Type: "zfspool", Sparse: "1"}, true},
		{pveStorageCfg{Type: "rbd"}, true},
		{pveStorageCfg{Type: "nfs"}, true},
		{pveStorageCfg{Type: "pbs"}, false},
		{pveStorageCfg{Type: "iscsi"}, false},
	} {
		if got := tc.cfg.thin(tc.cfg.Type); got != tc.want {
			t.Errorf("%s sparse=%q thin = %v", tc.cfg.Type, tc.cfg.Sparse, got)
		}
	}
}

// A lock taken or released, or new cores, memory or disk sizes in the
// cluster resource list re-read the config before its 5 minutes are up.
func TestPVEConfigFollowsResourceChanges(t *testing.T) {
	reads := 0
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/pending") {
			t.Errorf("unexpected %s", r.URL)
		}
		reads++
		w.Write([]byte(`{"data":[{"key":"cores","value":"2"},{"key":"memory","value":"1024"}]}`))
	}))
	defer srv.Close()
	p := newPVECollector(&agent.Config{}, nil)
	p.client, p.baseURL, p.token = srv.Client(), srv.URL, "x"
	now := time.Now()
	r := pveResource{VMID: 200, Name: "web", Status: "stopped", Lock: "create", MaxCPU: 1, MaxMem: 512 << 20}
	steps := []struct {
		change func()
		read   bool
	}{
		{func() {}, true},                     // first read
		{func() {}, false},                    // nothing changed
		{func() { r.Lock = "" }, true},        // the create finished
		{func() { r.MaxCPU = 2 }, true},       // cores changed
		{func() { r.MaxMem = 1 << 30 }, true}, // memory changed
		{func() { r.Name = "web-2" }, true},   // renamed
		{func() {}, false},
	}
	for i, s := range steps {
		s.change()
		before := reads
		p.guestConfig(context.Background(), "pve1", r, "container", now.Add(time.Duration(i)*time.Second))
		if (reads > before) != s.read {
			t.Errorf("step %d: read=%v, want %v", i, reads > before, s.read)
		}
	}
}
