package collect

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"rackoon/internal/proto"
)

func TestIncusCollector(t *testing.T) {
	raw := readTestdata(t, "incus_instances.json")
	var round atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/1.0", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"type":"sync","status":"Success","status_code":200,"metadata":{"environment":{"server_version":"6.0.4"}}}`))
	})
	// The fixture is a recursion=2 listing; the collector asks for
	// recursion=1 and then each running / frozen instance's state, and for
	// the snapshot lists every 5 minutes.
	instances := func() []map[string]any {
		var resp struct {
			Metadata []map[string]any `json:"metadata"`
		}
		json.Unmarshal(raw, &resp)
		n := float64(round.Load())
		for _, in := range resp.Metadata {
			st, _ := in["state"].(map[string]any)
			if in["name"] == "test-vm" {
				in["status"], st["status"] = "Frozen", "Frozen"
			}
			if st == nil || in["status"] != "Running" {
				continue
			}
			if in["name"] == "web" {
				cfg := in["expanded_config"].(map[string]any)
				cfg["volatile.eth0.hwaddr"] = "10:66:6A:00:00:01"
				cfg["snapshots.schedule"] = "@daily"
			}
			cpu := st["cpu"].(map[string]any)
			// 1 s of CPU time per second on every instance.
			cpu["usage"] = cpu["usage"].(float64) + n*1e9
			if nets, ok := st["network"].(map[string]any); ok {
				for _, v := range nets {
					c := v.(map[string]any)["counters"].(map[string]any)
					c["bytes_received"] = c["bytes_received"].(float64) + n*1000
				}
			}
		}
		return resp.Metadata
	}
	sync := func(w http.ResponseWriter, v any) {
		json.NewEncoder(w).Encode(map[string]any{"type": "sync", "status": "Success", "status_code": 200, "metadata": v})
	}
	var stateCalls, snapCalls, backupCalls atomic.Int64
	mux.HandleFunc("/1.0/instances", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("recursion") != "1" || r.URL.Query().Get("all-projects") != "true" {
			t.Errorf("query %q", r.URL.RawQuery)
		}
		var out []map[string]any
		for _, in := range instances() {
			delete(in, "state")
			delete(in, "snapshots")
			out = append(out, in)
		}
		sync(w, out)
	})
	mux.HandleFunc("/1.0/instances/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/1.0/instances/")
		name, sub, _ := strings.Cut(rest, "/")
		for _, in := range instances() {
			if in["name"] != name {
				continue
			}
			if r.URL.Query().Get("project") != in["project"] {
				t.Errorf("%s: project %q", r.URL, r.URL.Query().Get("project"))
			}
			switch sub {
			case "state":
				stateCalls.Add(1)
				if in["status"] == "Stopped" {
					t.Errorf("state of a stopped instance requested: %s", name)
				}
				sync(w, in["state"])
			case "snapshots":
				snapCalls.Add(1)
				urls := []string{}
				snaps, _ := in["snapshots"].([]any)
				for i := range snaps {
					urls = append(urls, "/1.0/instances/"+name+"/snapshots/s"+itoa(i))
				}
				sync(w, urls)
			case "backups":
				backupCalls.Add(1)
				if r.URL.Query().Get("recursion") != "1" {
					t.Errorf("backups without recursion: %s", r.URL)
				}
				var bks []map[string]any
				if name == "web" {
					bks = []map[string]any{{"name": "b1", "created_at": "2026-10-01T02:00:00Z"}, {"name": "b2", "created_at": "2026-10-09T02:00:00Z"}}
				}
				sync(w, bks)
			default:
				t.Errorf("unexpected %s", r.URL)
			}
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/1.0/warnings", func(w http.ResponseWriter, r *http.Request) {
		w.Write(readTestdata(t, "incus_warnings.json"))
	})
	serveIncusDetail(t, mux, sync)
	sock := serveUnix(t, mux)

	// Per-dataset ZFS I/O for the container "web".
	kroot := t.TempDir()
	objset := func(nr, nw int) string {
		return "16400 1 0x01 27 7600 1 2\nname                            type data\n" +
			"dataset_name                    7    tank/incus/default/containers/web\n" +
			"writes                          4    10\nnwritten                        4    " + itoa(nw) + "\n" +
			"reads                           4    10\nnread                           4    " + itoa(nr) + "\n"
	}
	writeTree(t, kroot, map[string]string{"proc/spl/kstat/zfs/tank/objset-0x1": objset(1000, 5000)})

	c := newTestCollector()
	x := c.incus
	x.zfs = newObjsetIndex(fsRoot(kroot))
	x.root = fsRoot(kroot) // no /proc/<pid>/io, no cgroup files
	x.socket = sock
	x.client = unixHTTPClient(sock, 5*time.Second)
	// run() looks the socket up itself; point it at the fake one.
	saved := incusSockets
	incusSockets = []string{sock}
	defer func() { incusSockets = saved }()

	ctx := context.Background()
	if err := x.run(ctx); err != nil {
		t.Fatal(err)
	}
	// Second sample 2 s later.
	x.mu.Lock()
	for k, s := range x.prev {
		s.at = s.at.Add(-2 * time.Second)
		x.prev[k] = s
	}
	x.mu.Unlock()
	writeTree(t, kroot, map[string]string{"proc/spl/kstat/zfs/tank/objset-0x1": objset(1000+4000, 5000+8000)})
	round.Store(2)
	if err := x.run(ctx); err != nil {
		t.Fatal(err)
	}
	p := x.snapshot()
	if p == nil || p.Version != "6.0.4" || len(p.Guests) != 5 {
		t.Fatalf("platform: %+v", p)
	}
	g := map[string]proto.Guest{}
	for _, gg := range p.Guests {
		g[gg.ID] = gg
	}
	job := g["ci/job-1"]
	if job.Kind != "vm" || job.Name != "job-1" || job.Image != "debian/13" || job.VCPU != 12 || job.MemConfigBytes != 36<<30 {
		t.Errorf("job-1: %+v", job)
	}
	// 2e9 ns over ~2 s on 12 vCPUs = 8.3 %.
	if job.CPUPct == nil || *job.CPUPct < 8 || *job.CPUPct > 8.7 {
		t.Errorf("job-1 cpu = %v", job.CPUPct)
	}
	// Only the Incus-managed NIC (enp5s0) counts: 2000 B in ~2 s.
	if job.NetRxBps == nil || *job.NetRxBps < 900 || *job.NetRxBps > 1100 {
		t.Errorf("job-1 rx = %v", job.NetRxBps)
	}
	if job.Console.Default != proto.ProtoSPICE || job.StartedAt == nil {
		t.Errorf("job-1 console/start: %+v", job)
	}
	web := g["web"]
	if web.Kind != "container" || web.Console.Default != proto.ProtoShell || *web.SnapshotsCount != 2 || web.MemLimitBytes == nil || *web.MemLimitBytes != 2<<30 {
		t.Errorf("web: %+v", web)
	}
	if web.DiskReadBps == nil || *web.DiskReadBps < 1800 || *web.DiskReadBps > 2200 || web.DiskWriteBps == nil || *web.DiskWriteBps < 3600 || *web.DiskWriteBps > 4400 {
		t.Errorf("web disk rd=%v wr=%v", web.DiskReadBps, web.DiskWriteBps)
	}
	tmpl := g["ci/tmpl-c"]
	if tmpl.State != proto.StateStopped || tmpl.Image != "ubuntu/24.04" || tmpl.CPUPct != nil || tmpl.MemUsedBytes != nil || *tmpl.SnapshotsCount != 1 {
		t.Errorf("tmpl-c: %+v", tmpl)
	}
	if app := g["app-prod"]; app.Image != "" || app.VCPU != 4 || app.MemUsedBytes != nil {
		t.Errorf("app-prod: %+v", app)
	}
	// State details: disk, processes, global addresses (not lo, not the
	// guest's own docker0 bridge).
	if job.DiskUsedBytes == nil || *job.DiskUsedBytes != 26109747200 || job.Processes == nil || *job.Processes != 34 {
		t.Errorf("job-1 disk/procs: %v %v", job.DiskUsedBytes, job.Processes)
	}
	if strings.Join(job.Addresses, ",") != "192.0.2.10,192.0.2.12" {
		t.Errorf("job-1 addresses: %v", job.Addresses)
	}
	if strings.Join(web.Addresses, ",") != "192.0.2.13,192.0.2.14,fd7a:115c:a1e0::d532:291f" {
		t.Errorf("web addresses: %v", web.Addresses)
	}
	if app := g["app-prod"]; app.Processes != nil || app.DiskUsedBytes == nil {
		t.Errorf("app-prod: VM without agent reports -1 processes: %+v", app)
	}
	// Frozen is paused.
	if vm := g["test-vm"]; vm.State != proto.StatePaused || vm.DiskUsedBytes == nil {
		t.Errorf("test-vm: %+v", vm)
	}
	// Warnings: resolved ones dropped, repeats merged.
	if len(p.Warnings) != 2 || p.Warnings[0].Type != "Couldn't restore network" || p.Warnings[1].Count != 73 || p.Warnings[0].Message != "Failed to create OVS bridge" {
		t.Errorf("warnings: %+v", p.Warnings)
	}
	// State for the 4 running / frozen instances per run; snapshot and
	// backup lists only on the first run (every 5 minutes).
	if stateCalls.Load() != 8 || snapCalls.Load() != 5 || backupCalls.Load() != 5 {
		t.Errorf("state calls %d, snapshot calls %d, backup calls %d", stateCalls.Load(), snapCalls.Load(), backupCalls.Load())
	}
	// MACs, the schedule in effect, the creation time and the newest backup.
	if strings.Join(web.MACs, ",") != "10:66:6a:00:00:01" || web.SnapshotSchedule != "@daily" || web.CreatedAt == nil ||
		web.LastBackup == nil || !web.LastBackup.At.Equal(time.Date(2026, 10, 9, 2, 0, 0, 0, time.UTC)) || web.LastBackup.Result != "ok" {
		t.Errorf("web incus fields: %+v %+v", web, web.LastBackup)
	}
	if job.LastBackup != nil || job.SnapshotSchedule != "" {
		t.Errorf("job-1: %+v", job)
	}
	checkIncusDetail(t, p.Incus)
}

// serveIncusDetail answers the host-view requests: two projects, two
// pools (one with a custom volume attached to web), networks (a managed
// bridge, a host bridge, Docker's bridges, a physical card), profiles and
// images.
func serveIncusDetail(t *testing.T, mux *http.ServeMux, sync func(http.ResponseWriter, any)) {
	mux.HandleFunc("/1.0/projects", func(w http.ResponseWriter, r *http.Request) {
		sync(w, []map[string]any{{"name": "default", "description": "Default Incus project"}, {"name": "ci", "description": ""}})
	})
	mux.HandleFunc("/1.0/storage-pools", func(w http.ResponseWriter, r *http.Request) {
		sync(w, []map[string]any{{"name": "default", "driver": "zfs", "status": "Created"}, {"name": "fast", "driver": "dir", "status": "Created", "description": "NVMe"}})
	})
	mux.HandleFunc("/1.0/storage-pools/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/1.0/storage-pools/")
		switch rest {
		case "default/resources":
			sync(w, map[string]any{"space": map[string]any{"used": 900 << 30, "total": 1000 << 30}})
		case "fast/resources":
			sync(w, map[string]any{"space": map[string]any{"used": 0, "total": 0}})
		case "default/volumes":
			if r.URL.Query().Get("all-projects") != "true" {
				t.Errorf("volumes: %s", r.URL)
			}
			sync(w, []map[string]any{
				{"name": "web", "type": "container", "project": "default"},
				{"name": "data", "type": "custom", "project": "default", "content_type": "filesystem", "config": map[string]any{"size": "20GiB"},
					"used_by": []string{"/1.0/instances/web"}},
				{"name": "cache", "type": "custom", "project": "ci", "content_type": "block", "used_by": []string{"/1.0/instances/job-1?project=ci"}},
			})
		case "fast/volumes":
			sync(w, []map[string]any{})
		case "default/volumes/custom/data/state":
			sync(w, map[string]any{"usage": map[string]any{"used": 5 << 30, "total": 0}})
		case "default/volumes/custom/cache/state":
			if r.URL.Query().Get("project") != "ci" {
				t.Errorf("volume state project: %s", r.URL)
			}
			sync(w, map[string]any{})
		default:
			t.Errorf("unexpected %s", r.URL)
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/1.0/networks", func(w http.ResponseWriter, r *http.Request) {
		sync(w, []map[string]any{
			{"name": "incusbr0", "type": "bridge", "managed": true, "config": map[string]any{"ipv4.address": "10.62.52.1/24", "ipv4.nat": "true", "ipv6.address": "none"},
				"used_by": []string{"/1.0/instances/web", "/1.0/profiles/default"}},
			{"name": "br-lan", "type": "bridge", "managed": false},
			{"name": "docker0", "type": "bridge", "managed": false},
			{"name": "br-0a11af480358", "type": "bridge", "managed": false},
			{"name": "enp5s0", "type": "physical", "managed": false},
			{"name": "lo", "type": "loopback", "managed": false},
		})
	})
	mux.HandleFunc("/1.0/profiles", func(w http.ResponseWriter, r *http.Request) {
		sync(w, []map[string]any{{"name": "default", "project": "default", "description": "Default profile", "used_by": []string{"/1.0/instances/web", "/1.0/instances/app-prod"}},
			{"name": "big", "project": "default", "used_by": []string{}}})
	})
	mux.HandleFunc("/1.0/images", func(w http.ResponseWriter, r *http.Request) {
		sync(w, []map[string]any{
			{"fingerprint": "aaaa", "type": "container", "architecture": "x86_64", "size": 100 << 20, "project": "default", "cached": true,
				"properties": map[string]any{"description": "Debian trixie amd64"}, "uploaded_at": "2026-10-16T12:50:00Z", "last_used_at": "0001-01-01T00:00:00Z"},
			{"fingerprint": "bbbb", "type": "virtual-machine", "aliases": []map[string]any{{"name": "debian/13/vm"}}, "auto_update": true, "project": "default"},
		})
	})
}

func checkIncusDetail(t *testing.T, d *proto.IncusDetail) {
	t.Helper()
	if d == nil {
		t.Fatal("no Incus detail")
	}
	if len(d.Projects) != 2 || d.Projects[0].Name != "ci" || d.Projects[0].Instances != 2 || d.Projects[0].Running != 1 ||
		d.Projects[1].Name != "default" || d.Projects[1].Instances != 3 || d.Projects[1].Running != 2 {
		t.Errorf("projects: %+v", d.Projects)
	}
	if len(d.Pools) != 2 || d.Pools[0].Name != "default" || *d.Pools[0].UsedBytes != 900<<30 || d.Pools[0].Volumes != 2 ||
		d.Pools[1].TotalBytes != nil || d.Pools[1].Description != "NVMe" {
		t.Errorf("pools: %+v", d.Pools)
	}
	if len(d.Volumes) != 2 || d.Volumes[0].Project != "ci" || d.Volumes[0].ContentType != "block" || strings.Join(d.Volumes[0].UsedBy, ",") != "ci/job-1" ||
		d.Volumes[1].Name != "data" || *d.Volumes[1].SizeBytes != 20<<30 || *d.Volumes[1].UsedBytes != 5<<30 || strings.Join(d.Volumes[1].UsedBy, ",") != "web" {
		t.Errorf("volumes: %+v", d.Volumes)
	}
	if len(d.Networks) != 2 || d.Networks[0].Name != "br-lan" || d.Networks[0].Managed || d.Networks[0].NAT != nil ||
		d.Networks[1].IPv4 != "10.62.52.1/24" || d.Networks[1].IPv6 != "" || d.Networks[1].NAT == nil || !*d.Networks[1].NAT || d.Networks[1].UsedBy != 2 {
		t.Errorf("networks: %+v", d.Networks)
	}
	if len(d.Profiles) != 2 || d.Profiles[0].Name != "big" || d.Profiles[1].UsedBy != 2 {
		t.Errorf("profiles: %+v", d.Profiles)
	}
	if len(d.Images) != 2 || d.Images[0].Fingerprint != "bbbb" || !d.Images[0].AutoUpdate || d.Images[1].Description != "Debian trixie amd64" ||
		d.Images[1].UploadedAt == nil || d.Images[1].LastUsedAt != nil || !d.Images[1].Cached {
		t.Errorf("images: %+v", d.Images)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestIncusParsers(t *testing.T) {
	for in, want := range map[string]int{"4": 4, "0-3": 4, "0,2,4-5": 4, "": 0} {
		if got := incusVCPU(in, "container"); got != want {
			t.Errorf("incusVCPU(%q) = %d, want %d", in, got, want)
		}
	}
	if incusVCPU("", "vm") != 1 {
		t.Error("VM default vCPU is 1")
	}
	for in, want := range map[string]uint64{"2GiB": 2 << 30, "512MiB": 512 << 20, "512MB": 512e6, "1.5GiB": 3 << 29, "1024": 1024, "1kB": 1000} {
		if got, err := parseByteSize(in); err != nil || got != want {
			t.Errorf("parseByteSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if v, ok := incusMemory("50%", 8<<30); !ok || v != 4<<30 {
		t.Errorf("percent: %d %v", v, ok)
	}
	if _, err := parseByteSize("lots"); err == nil {
		t.Error("invalid size accepted")
	}
	in := &incusInstance{}
	for cfg, want := range map[[2]string]string{
		{"Debian", "trixie"}: "debian/13", {"Ubuntu", "noble"}: "ubuntu/24.04", {"nixos", "26.05"}: "nixos/26.05",
		{"Alpine", "3.22"}: "alpine/3.22", {"", ""}: "",
	} {
		if got := incusImage(map[string]string{"image.os": cfg[0], "image.release": cfg[1]}, in); got != want {
			t.Errorf("incusImage(%v) = %q, want %q", cfg, got, want)
		}
	}
}

func TestIncusEvents(t *testing.T) {
	ev := incusEvent{Project: "default"}
	ev.Metadata.Source = "/1.0/instances/web"
	if got := incusEventGuest(&ev); got != "web" {
		t.Errorf("default project: %q", got)
	}
	ev.Metadata.Source = "/1.0/instances/job-1?project=ci"
	if got := incusEventGuest(&ev); got != "ci/job-1" {
		t.Errorf("project: %q", got)
	}
	ev.Metadata.Source = "/1.0/instances/web/snapshots/s1"
	if got := incusEventGuest(&ev); got != "" {
		t.Errorf("snapshot source: %q", got)
	}
	for action, want := range map[string]string{
		"instance-started": proto.StateRunning, "instance-stopped": proto.StateStopped,
		"instance-paused": proto.StatePaused, "instance-resumed": proto.StateRunning,
		"instance-shutdown": proto.StateStopped, "instance-deleted": proto.StateStopped,
		"instance-updated": "", "instance-snapshot-created": "",
	} {
		if got, _ := incusEventState(action); got != want {
			t.Errorf("incusEventState(%q) = %q", action, got)
		}
	}
}

func TestIOCounterParsers(t *testing.T) {
	rd, wr, ok := parseObjsetIO(readTestdata(t, "objset.txt"))
	if !ok || rd == 0 || wr == 0 {
		t.Errorf("objset: %d %d %v", rd, wr, ok)
	}
	rd, wr, ok = parseCgroupIOStat(readTestdata(t, "cgroup_io.stat"))
	if !ok || rd != 4562944+29511680 || wr != 0 {
		t.Errorf("io.stat: %d %d %v", rd, wr, ok)
	}
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{"proc/42/io": "rchar: 1\nwchar: 2\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n"})
	if rd, wr, ok := readProcIO(fsRoot(dir), 42); !ok || rd != 4096 || wr != 8192 {
		t.Errorf("proc io: %d %d %v", rd, wr, ok)
	}
}

func TestIncusEventStream(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/1.0/events", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("type") != "lifecycle,operation" || r.URL.Query().Get("all-projects") != "true" {
			t.Errorf("query %q", r.URL.RawQuery)
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		for _, m := range []string{
			`{"type":"lifecycle","project":"default","metadata":{"action":"instance-started","source":"/1.0/instances/web"}}`,
			`{"type":"lifecycle","project":"ci","metadata":{"action":"instance-updated","source":"/1.0/instances/job-1?project=ci"}}`,
			`{"type":"lifecycle","project":"ci","metadata":{"action":"instance-deleted","source":"/1.0/instances/job-1?project=ci"}}`,
			`{"type":"operation","project":"default","metadata":{"id":"op1","class":"task","description":"Creating instance snapshot","created_at":"2026-10-13T10:00:00Z","updated_at":"2026-10-13T10:00:05Z","status":"Running","resources":{"instances":["/1.0/instances/web"]}}}`,
			`{"type":"operation","project":"default","metadata":{"id":"op1","class":"task","description":"Creating instance snapshot","created_at":"2026-10-13T10:00:00Z","updated_at":"2026-10-13T10:00:09Z","status":"Failure","err":"no space left on device","resources":{"instances":["/1.0/instances/web"]}}}`,
		} {
			conn.Write(r.Context(), websocket.MessageText, []byte(m))
		}
		conn.Close(websocket.StatusNormalClosure, "")
	})
	sock := serveUnix(t, mux)
	c := newTestCollector()
	_ = c.incus.streamEvents(context.Background(), sock)
	var got []string
	for len(c.events) > 0 {
		ev := <-c.events
		got = append(got, ev.Platform+":"+ev.GuestID+"="+ev.State+"("+ev.Message+")")
	}
	if want := "incus:web=running(started),incus:ci/job-1=stopped(removed)"; strings.Join(got, ",") != want {
		t.Errorf("events %v, want %s", got, want)
	}
	// The failed operation is a task; the running one is not.
	c.incus.mu.Lock()
	ops := append([]proto.PVETask(nil), c.incus.failedOps...)
	c.incus.mu.Unlock()
	if len(ops) != 1 || ops[0].ID != "web" || ops[0].Type != "Creating instance snapshot" || ops[0].Status != "no space left on device" || ops[0].OK {
		t.Errorf("failed operations %+v", ops)
	}
}
