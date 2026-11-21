package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// fakeIncus is the part of the Incus API manage uses, on a Unix socket,
// with instances, profiles, pools, networks, images and operations in
// memory.
type fakeIncus struct {
	t  *testing.T
	mu sync.Mutex

	instances map[string]*api.Instance // "name" or "project/name"
	versions  map[string]int           // ETag versions
	profiles  map[string]api.ProfilePut
	pools     []api.StoragePool
	volumes   map[string]bool // "pool/volume" custom volumes
	networks  []api.Network
	images    []api.Image
	ops       map[string]*fakeOp
	nops      int

	// More of the API (incus_manage_more_test.go).
	projects  []string
	backups   map[string][]api.InstanceBackup // by instance key
	snapshots map[string][]string             // by instance key
	vols      map[string]*api.StorageVolume   // "project|pool|name" custom volumes
	pversions map[string]int                  // profile ETag versions
	leases    map[string][]api.NetworkLease
	nimages   int

	hold     chan struct{} // new operations wait for it when set
	failNext string        // the next operation fails with this error
	raceNext bool          // the next instance GET is followed by a change (ETag)
	puts     []api.InstancePut
	ifMatch  []string
	posts    []api.InstancesPost
	deletes  []string
}

type fakeOp struct {
	op     api.Operation
	done   chan struct{}
	gone   chan struct{}  // closed by forget
	result map[string]any // the metadata of a successful end
}

func newFakeIncus(t *testing.T) (*fakeIncus, string) {
	f := &fakeIncus{
		t:         t,
		instances: map[string]*api.Instance{},
		versions:  map[string]int{},
		ops:       map[string]*fakeOp{},
		profiles: map[string]api.ProfilePut{
			"default": {Devices: api.DevicesMap{
				"eth0": {"type": "nic", "network": "incusbr0", "name": "eth0"},
				"root": {"type": "disk", "path": "/", "pool": "default"},
			}},
			"gpu": {Devices: api.DevicesMap{"gpu0": {"type": "gpu", "gputype": "physical"}}},
			"big": {Config: api.ConfigMap{"limits.memory": "8GiB"}},
		},
		pools: []api.StoragePool{
			{Name: "default", Driver: "zfs", Status: "Created"},
			{Name: "fast", Driver: "lvm", Status: "Created", StoragePoolPut: api.StoragePoolPut{Config: api.ConfigMap{"lvm.use_thinpool": "false", "volume.size": "20GiB"}}},
			{Name: "buckets", Driver: "cephobject", Status: "Created"},
			{Name: "gone", Driver: "dir", Status: "Unavailable"},
		},
		volumes:   map[string]bool{"default/data": true, "default/media": true},
		projects:  []string{"default", "lab"},
		backups:   map[string][]api.InstanceBackup{},
		snapshots: map[string][]string{"web": {"snap0"}},
		vols:      map[string]*api.StorageVolume{},
		pversions: map[string]int{},
		leases: map[string][]api.NetworkLease{"incusbr0": {
			{Hostname: "incusbr0.gw", Address: "10.62.52.1", Type: "gateway"},
			{Hostname: "web", Address: "10.62.52.73", Hwaddr: "10:66:6A:00:00:01", Type: "dynamic"},
			{Hostname: "laptop", Address: "10.62.52.99", Hwaddr: "aa:bb:cc:dd:ee:ff", Type: "dynamic"}}},
		networks: []api.Network{
			{Name: "incusbr0", Type: "bridge", Managed: true},
			{Name: "br-lan", Type: "bridge"},
			{Name: "ovn1", Type: "ovn", Managed: true},
			{Name: "eno1", Type: "physical"},
			{Name: "lo", Type: "loopback"},
		},
		images: []api.Image{
			{Fingerprint: strings.Repeat("6f9e1c3b2a4d", 5) + "0123", Type: "container", Size: 98 << 20,
				Aliases: []api.ImageAlias{{Name: "debian/13"}}, ImagePut: api.ImagePut{Properties: map[string]string{"description": "Debian trixie amd64"}}},
			{Fingerprint: strings.Repeat("1a2b3c4d5e6f", 5) + "4567", Type: "virtual-machine", Size: 612 << 20,
				Aliases: []api.ImageAlias{{Name: "nixos/26.05"}}},
			{Fingerprint: strings.Repeat("9c8b7a6f5e4d", 5) + "89ab", Type: "container", Size: 3 << 20},
		},
	}
	f.add("", "web", "container", "Running", []string{"default"}, api.ConfigMap{
		"limits.cpu": "2", "user.note": "frontend", "raw.lxc": "lxc.apparmor.profile=unconfined",
		"volatile.base_image": "abc", "volatile.eth0.hwaddr": "10:66:6a:00:00:01", "image.os": "Debian",
	}, api.DevicesMap{
		"data":   {"type": "disk", "pool": "default", "source": "data", "path": "/data"},
		"share":  {"type": "disk", "source": "/srv/share", "path": "/share"},
		"web80":  {"type": "proxy", "listen": "tcp:0.0.0.0:80", "connect": "tcp:127.0.0.1:80"},
		"vlans":  {"type": "nic", "nictype": "bridged", "parent": "br-lan", "vlan.tagged": "10,20"},
		"routed": {"type": "nic", "network": "incusbr0", "ipv4.routes": "192.0.2.0/24"},
	}, "Web front end")
	f.add("", "vm1", "virtual-machine", "Stopped", []string{"default", "big"}, api.ConfigMap{
		"security.protection.delete": "true", "volatile.uuid": "x",
	}, nil, "")
	f.add("", "ct1", "container", "Stopped", []string{"default"}, nil, nil, "")
	f.add("lab", "db", "container", "Stopped", []string{"default"}, nil, api.DevicesMap{
		"root": {"type": "disk", "path": "/", "pool": "fast", "size": "20GiB"},
	}, "")

	sock := filepath.Join(t.TempDir(), "incus.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: f}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	// Set once and never restored: a task watcher of an earlier test may
	// still be sleeping on it (restoring it raced with that goroutine).
	fastFollow.Do(func() { incusFollowRetry = 10 * time.Millisecond })
	return f, sock
}

var fastFollow sync.Once

// add creates an instance; expand fills its expanded config and devices.
func (f *fakeIncus) add(project, name, typ, status string, profiles []string, config api.ConfigMap, devices api.DevicesMap, desc string) {
	if config == nil {
		config = api.ConfigMap{}
	}
	if devices == nil {
		devices = api.DevicesMap{}
	}
	in := &api.Instance{Name: name, Type: typ, Status: status, Project: project,
		InstancePut: api.InstancePut{Architecture: "x86_64", Config: config, Devices: devices, Profiles: profiles, Description: desc}}
	f.expand(in)
	f.instances[fakeKey(project, name)] = in
}

func fakeKey(project, name string) string {
	if project == "" || project == "default" {
		return name
	}
	return project + "/" + name
}

func (f *fakeIncus) expand(in *api.Instance) {
	in.ExpandedConfig, in.ExpandedDevices = api.ConfigMap{}, api.DevicesMap{}
	for _, p := range in.Profiles {
		maps.Copy(in.ExpandedConfig, f.profiles[p].Config)
		maps.Copy(in.ExpandedDevices, f.profiles[p].Devices)
	}
	maps.Copy(in.ExpandedConfig, in.Config)
	maps.Copy(in.ExpandedDevices, in.Devices)
}

func (f *fakeIncus) etag(key string) string { return fmt.Sprintf("etag-%s-%d", key, f.versions[key]) }

func fakeSync(w http.ResponseWriter, etag string, v any) {
	if etag != "" {
		w.Header().Set("ETag", `"`+etag+`"`)
	}
	json.NewEncoder(w).Encode(map[string]any{"type": "sync", "status": "Success", "status_code": 200, "metadata": v})
}

func fakeError(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": msg, "error_code": code})
}

// newOp starts an operation that runs run (after f.hold, when set).
// Callers hold f.mu; run is called with f.mu held.
func (f *fakeIncus) newOp(desc, project, name string, run func() error) *fakeOp {
	instance := "/1.0/instances/" + name
	if project != "" && project != "default" {
		instance += "?project=" + project
	}
	f.nops++
	now := time.Now().UTC()
	op := &fakeOp{done: make(chan struct{}), gone: make(chan struct{}), op: api.Operation{
		ID: fmt.Sprintf("%08x-0000-4000-8000-%012x", f.nops, f.nops), Class: "task", Description: desc,
		CreatedAt: now, UpdatedAt: now, Status: "Running", StatusCode: api.Running,
		Resources: map[string][]string{"instances": {instance}}, Metadata: map[string]any{},
	}}
	f.ops[op.op.ID] = op
	hold, fail := f.hold, f.failNext
	f.failNext = ""
	if hold != nil {
		op.op.Metadata["download_progress"] = "rootfs: 42% (12.30MB/s)"
	}
	go func() {
		if hold != nil {
			<-hold
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		err := run()
		if err == nil && fail != "" {
			err = fmt.Errorf("%s", fail)
		}
		op.op.UpdatedAt = time.Now().UTC()
		op.op.Metadata = map[string]any{}
		if err == nil && op.result != nil {
			op.op.Metadata = op.result
		}
		if err != nil {
			op.op.Status, op.op.StatusCode, op.op.Err = "Failure", api.Failure, err.Error()
		} else {
			op.op.Status, op.op.StatusCode = "Success", api.Success
		}
		close(op.done)
	}()
	return op
}

func (f *fakeIncus) async(w http.ResponseWriter, op *fakeOp) {
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]any{"type": "async", "status": "Operation created", "status_code": 100,
		"operation": "/1.0/operations/" + op.op.ID, "metadata": op.op})
}

// setHold makes new operations wait until the channel is closed; nil
// closes the current one.
func (f *fakeIncus) setHold(ch chan struct{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ch == nil && f.hold != nil {
		close(f.hold)
	}
	f.hold = ch
}

// forget drops an operation, as Incus does 5 s after it ended (or when
// it restarts).
func (f *fakeIncus) forget(uuid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if op := f.ops[uuid]; op != nil {
		close(op.gone)
		delete(f.ops, uuid)
	}
}

func (f *fakeIncus) waitOp(uuid string) {
	f.mu.Lock()
	op := f.ops[uuid]
	f.mu.Unlock()
	if op == nil {
		f.t.Fatalf("no operation %s", uuid)
	}
	select {
	case <-op.done:
	case <-time.After(5 * time.Second):
		f.t.Fatalf("operation %s did not end", uuid)
	}
}

func (f *fakeIncus) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	project := r.URL.Query().Get("project")
	path := r.URL.Path
	switch {
	case path == "/1.0":
		fakeSync(w, "", map[string]any{"api_extensions": fakeExtensions,
			"api_version": "1.0", "auth": "trusted", "environment": map[string]any{"server_version": "6.0.4"}})
		return
	case strings.HasPrefix(path, "/1.0/operations/"):
		f.serveOperation(w, r, strings.TrimPrefix(path, "/1.0/operations/"))
		return
	}
	if r.Header.Get("Content-Type") == "application/octet-stream" {
		// An import streams the export of the same server: read it before
		// taking the lock the export needs.
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.serveMore(w, r, project, path) {
		return
	}
	switch {
	case path == "/1.0/instances" && r.Method == http.MethodPost:
		var req api.InstancesPost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fakeError(w, 400, err.Error())
			return
		}
		f.posts = append(f.posts, req)
		key := fakeKey(project, req.Name)
		if f.instances[key] != nil {
			fakeError(w, 500, fmt.Sprintf("Instance %q already exists", req.Name))
			return
		}
		typ := string(req.Type)
		if req.Source.Type == "copy" {
			srcProject := project
			if req.Source.Project != "" {
				srcProject = req.Source.Project
			}
			src := f.instances[fakeKey(srcProject, req.Source.Source)]
			if src == nil {
				fakeError(w, 404, "Instance not found")
				return
			}
			typ = src.Type
		}
		f.async(w, f.newOp("Creating instance", project, req.Name, func() error {
			f.add(project, req.Name, typ, "Stopped", req.Profiles, req.Config, req.Devices, req.Description)
			return nil
		}))
	case strings.HasPrefix(path, "/1.0/instances/"):
		name := strings.TrimPrefix(path, "/1.0/instances/")
		key := fakeKey(project, name)
		in := f.instances[key]
		if in == nil {
			fakeError(w, 404, "Instance not found")
			return
		}
		switch r.Method {
		case http.MethodGet:
			fakeSync(w, f.etag(key), in)
			if f.raceNext {
				f.raceNext = false
				f.versions[key]++
			}
		case http.MethodPut:
			match := strings.Trim(r.Header.Get("If-Match"), `"`)
			f.ifMatch = append(f.ifMatch, match)
			if match != "" && match != f.etag(key) {
				fakeError(w, 412, "ETag doesn't match: "+f.etag(key)+" vs "+match)
				return
			}
			var put api.InstancePut
			if err := json.NewDecoder(r.Body).Decode(&put); err != nil {
				fakeError(w, 400, err.Error())
				return
			}
			f.puts = append(f.puts, put)
			f.async(w, f.newOp("Updating instance", project, name, func() error {
				in.InstancePut = put
				f.expand(in)
				f.versions[key]++
				return nil
			}))
		case http.MethodDelete:
			f.deletes = append(f.deletes, key)
			f.async(w, f.newOp("Deleting instance", project, name, func() error {
				delete(f.instances, key)
				return nil
			}))
		}
	case path == "/1.0/storage-pools":
		fakeSync(w, "", f.pools)
	case strings.HasPrefix(path, "/1.0/storage-pools/"):
		rest := strings.Split(strings.TrimPrefix(path, "/1.0/storage-pools/"), "/")
		var pool *api.StoragePool
		for i := range f.pools {
			if f.pools[i].Name == rest[0] {
				pool = &f.pools[i]
			}
		}
		switch {
		case pool == nil:
			fakeError(w, 404, "Storage pool not found")
		case len(rest) == 1:
			fakeSync(w, "", pool)
		case len(rest) == 2 && rest[1] == "resources":
			if pool.Name != "default" {
				fakeError(w, 500, "not available")
				return
			}
			fakeSync(w, "", api.ResourcesStoragePool{Space: api.ResourcesStoragePoolSpace{Used: 100 << 30, Total: 1000 << 30}})
		case len(rest) == 4 && rest[1] == "volumes" && rest[2] == "custom" && f.volumes[pool.Name+"/"+rest[3]] && r.Method == http.MethodGet:
			fakeSync(w, "", api.StorageVolume{Name: rest[3], Type: "custom"})
		case len(rest) >= 3 && rest[1] == "volumes" && rest[2] == "custom":
			f.serveVolume(w, r, project, pool.Name, rest[3:])
		default:
			fakeError(w, 404, "Storage volume not found")
		}
	case path == "/1.0/networks":
		fakeSync(w, "", f.networks)
	case path == "/1.0/profiles" && r.Method == http.MethodGet:
		var urls []string
		for _, n := range slices.Sorted(maps.Keys(f.profiles)) {
			urls = append(urls, "/1.0/profiles/"+n)
		}
		fakeSync(w, "", urls)
	case path == "/1.0/images":
		fakeSync(w, "", f.images)
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL)
		fakeError(w, 404, "not found")
	}
}

func (f *fakeIncus) serveOperation(w http.ResponseWriter, r *http.Request, rest string) {
	uuid, wait := strings.CutSuffix(rest, "/wait")
	f.mu.Lock()
	op := f.ops[uuid]
	f.mu.Unlock()
	if op == nil {
		fakeError(w, 404, "Operation not found")
		return
	}
	if wait {
		secs, _ := strconv.Atoi(r.URL.Query().Get("timeout"))
		select {
		case <-op.done:
		case <-op.gone:
			fakeError(w, 404, "Operation not found")
			return
		case <-time.After(time.Duration(secs) * time.Second):
		case <-r.Context().Done():
			return
		}
	}
	f.mu.Lock()
	cur := op.op
	f.mu.Unlock()
	fakeSync(w, "", cur)
}

func incusGuestOf(id, kind string) *proto.Guest { return &proto.Guest{ID: id, Kind: kind} }

func TestIncusConfigGet(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	r := d.manage(context.Background(), incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpConfigGet, Platform: "incus", GuestID: "web"})
	if !r.OK || r.Config == nil {
		t.Fatalf("config.get: %+v", r)
	}
	c := r.Config
	if c.Platform != "incus" || c.Kind != "container" || !c.Running || c.Digest != f.etag("web") {
		t.Errorf("header: %+v", c)
	}
	want := map[string]string{
		"limits.cpu": "2", "user.note": "frontend", "raw.lxc": "lxc.apparmor.profile=unconfined", "image.os": "Debian",
		"description":   "Web front end",
		"device.eth0":   "type=nic,name=eth0,network=incusbr0",
		"device.root":   "type=disk,path=/,pool=default",
		"device.data":   "type=disk,path=/data,pool=default,source=data",
		"device.share":  "type=disk,path=/share,source=/srv/share",
		"device.web80":  "type=proxy,connect=tcp:127.0.0.1:80,listen=tcp:0.0.0.0:80",
		"device.vlans":  "type=nic,nictype=bridged,parent=br-lan,vlan.tagged=10,20",
		"device.routed": "type=nic,ipv4.routes=192.0.2.0/24,network=incusbr0",
	}
	if len(c.Values) != len(want) {
		t.Errorf("values: %v", c.Values)
	}
	for k, v := range want {
		if c.Values[k] != v {
			t.Errorf("%s = %q, want %q", k, c.Values[k], v)
		}
	}
	if got := strings.Join(c.Inherited, ","); got != "device.eth0,device.root" {
		t.Errorf("inherited: %s", got)
	}
	if got := strings.Join(c.Restricted, ","); got != "device.routed,device.share,device.web80,image.os,raw.lxc" {
		t.Errorf("restricted: %s", got)
	}
	if strings.Join(c.Profiles, ",") != "default" {
		t.Errorf("profiles: %v", c.Profiles)
	}
	if len(c.Disks) != 3 || c.Disks[0] != (proto.GuestDisk{Key: "root", Storage: "default", Media: "disk", Path: "/", Boot: true}) ||
		c.Disks[1] != (proto.GuestDisk{Key: "data", Storage: "default", Volume: "data", Media: "disk", Path: "/data"}) || c.Disks[2].Key != "share" {
		t.Errorf("disks: %+v", c.Disks)
	}

	// A VM: container-only keys are restricted, the root disk has Incus'
	// default size; a project's instance.
	r = d.manage(context.Background(), incusGuestOf("vm1", "vm"), proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK || r.Config.Kind != "vm" || r.Config.Running || r.Config.Disks[0].SizeBytes != 10<<30 || r.Config.Values["limits.memory"] != "8GiB" ||
		strings.Join(r.Config.Inherited, ",") != "device.eth0,device.root,limits.memory" {
		t.Errorf("vm1: %+v", r.Config)
	}
	r = d.manage(context.Background(), incusGuestOf("lab/db", "container"), proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK || r.Config.Disks[0].SizeBytes != 20<<30 || r.Config.Disks[0].Storage != "fast" {
		t.Errorf("lab/db: %+v", r)
	}
	if r := d.manage(context.Background(), incusGuestOf("nope", "container"), proto.ManageRequest{Op: proto.OpConfigGet}); r.Code != CodeUnknownGuest {
		t.Errorf("unknown instance: %+v", r)
	}
}

func TestIncusConfigSet(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	web := incusGuestOf("web", "container")
	digest := f.etag("web")
	r := d.manage(ctx, web, proto.ManageRequest{Op: proto.OpConfigSet, Digest: digest,
		Set: map[string]string{
			"limits.cpu":       "4",
			"limits.memory":    "2GiB",
			"security.nesting": "true",
			"user.note":        "front end\nsecond line",
			"description":      "Public web",
			"device.eth1":      "type=nic,network=ovn1,name=eth1",
			"device.lan":       "network=br-lan,type=nic,name=eth2",
			"device.media":     "type=disk,pool=default,source=media,path=/srv/media,readonly=true",
			"device.eth0":      "type=nic,network=incusbr0,name=eth0", // the profile's value: no override
			"device.vlans":     "type=nic,nictype=bridged,parent=br-lan,vlan.tagged=10,20,30",
		},
		Delete: []string{"device.data", "boot.autostart"},
	})
	if !r.OK || r.Task != nil {
		t.Fatalf("config.set: %+v", r)
	}
	if len(f.puts) != 1 || f.ifMatch[0] != digest {
		t.Fatalf("puts %d, If-Match %v", len(f.puts), f.ifMatch)
	}
	put := f.puts[0]
	if put.Config["limits.cpu"] != "4" || put.Config["limits.memory"] != "2GiB" || put.Config["security.nesting"] != "true" ||
		put.Config["user.note"] != "front end\nsecond line" || put.Description != "Public web" {
		t.Errorf("config: %v %q", put.Config, put.Description)
	}
	// Keys Whombat does not change stay as they were, volatile ones too.
	if put.Config["raw.lxc"] != "lxc.apparmor.profile=unconfined" || put.Config["volatile.eth0.hwaddr"] != "10:66:6a:00:00:01" || put.Config["image.os"] != "Debian" {
		t.Errorf("untouched keys lost: %v", put.Config)
	}
	if strings.Join(put.Profiles, ",") != "default" || put.Architecture != "x86_64" {
		t.Errorf("profiles/architecture: %+v", put)
	}
	devs := put.Devices
	if _, ok := devs["data"]; ok {
		t.Error("data not removed")
	}
	if _, ok := devs["eth0"]; ok {
		t.Error("eth0 overridden with the profile's own value")
	}
	if devs["eth1"]["network"] != "ovn1" || devs["media"]["source"] != "media" || devs["vlans"]["vlan.tagged"] != "10,20,30" {
		t.Errorf("devices: %v", devs)
	}
	// network= naming a host bridge becomes a bridged NIC.
	if l := devs["lan"]; l["nictype"] != "bridged" || l["parent"] != "br-lan" || l["network"] != "" {
		t.Errorf("lan: %v", l)
	}
	if devs["share"]["source"] != "/srv/share" || devs["web80"]["type"] != "proxy" {
		t.Errorf("restricted devices lost: %v", devs)
	}
	ch := map[string]proto.ConfigChange{}
	for _, c := range r.Changes {
		ch[c.Key] = c
	}
	if len(r.Changes) != 10 || ch["limits.cpu"] != (proto.ConfigChange{Key: "limits.cpu", Old: "2", New: "4"}) ||
		ch["device.data"] != (proto.ConfigChange{Key: "device.data", Old: "type=disk,path=/data,pool=default,source=data"}) ||
		ch["device.lan"].New != "type=nic,name=eth2,nictype=bridged,parent=br-lan" || ch["description"].Old != "Web front end" {
		t.Errorf("changes: %+v", r.Changes)
	}
	if _, ok := ch["boot.autostart"]; ok {
		t.Error("removing an absent key is a change")
	}

	// The digest from before the change is stale now.
	if r := d.manage(ctx, web, proto.ManageRequest{Op: proto.OpConfigSet, Digest: digest, Set: map[string]string{"limits.cpu": "1"}}); r.Code != proto.CodeDigestMismatch || len(f.puts) != 1 {
		t.Errorf("stale digest: %+v", r)
	}
	// Nothing changes: no PUT.
	if r := d.manage(ctx, web, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"limits.cpu": "4"}}); !r.OK || len(r.Changes) != 0 || len(f.puts) != 1 {
		t.Errorf("no-op: %+v", r)
	}
	// Changed between our GET and PUT: Incus answers 412.
	f.mu.Lock()
	f.raceNext = true
	f.mu.Unlock()
	if r := d.manage(ctx, web, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"limits.cpu": "1"}}); r.Code != proto.CodeDigestMismatch || len(f.puts) != 1 {
		t.Errorf("changed meanwhile: %+v", r)
	}
	// A failing operation is reported with Incus' message.
	f.mu.Lock()
	f.failNext = "Invalid config: Invalid value for limits.cpu"
	f.mu.Unlock()
	if r := d.manage(ctx, web, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"limits.cpu": "512"}}); r.Code != proto.CodeInvalidValue || !strings.Contains(r.Message, "limits.cpu") {
		t.Errorf("failed operation: %+v", r)
	}
}

// TestIncusConfigSetRefused: keys and values outside the allowlist never
// reach Incus.
func TestIncusConfigSetRefused(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	for _, tc := range []struct {
		guest  string
		set    map[string]string
		del    []string
		revert []string
		code   string
		field  string
	}{
		{"web", map[string]string{"raw.lxc": "lxc.cap.drop="}, nil, nil, proto.CodeNotAllowed, "raw.lxc"},
		{"web", map[string]string{"security.privileged": "true"}, nil, nil, proto.CodeNotAllowed, "security.privileged"},
		{"web", map[string]string{"raw.idmap": "both 0 0"}, nil, nil, proto.CodeNotAllowed, "raw.idmap"},
		{"web", map[string]string{"volatile.base_image": "x"}, nil, nil, proto.CodeNotAllowed, "volatile.base_image"},
		{"web", nil, []string{"raw.lxc"}, nil, proto.CodeNotAllowed, "raw.lxc"},
		{"vm1", map[string]string{"security.nesting": "true"}, nil, nil, proto.CodeNotAllowed, "security.nesting"},
		{"vm1", map[string]string{"limits.processes": "100"}, nil, nil, proto.CodeNotAllowed, "limits.processes"},
		{"web", map[string]string{"limits.cpu": "two"}, nil, nil, proto.CodeInvalidValue, "limits.cpu"},
		{"web", map[string]string{"limits.memory": "1.5GiB"}, nil, nil, proto.CodeInvalidValue, "limits.memory"},
		{"web", map[string]string{"boot.autostart": "maybe"}, nil, nil, proto.CodeInvalidValue, "boot.autostart"},
		{"web", map[string]string{"snapshots.schedule": "@daily; rm -rf /"}, nil, nil, proto.CodeInvalidValue, "snapshots.schedule"},
		{"web", map[string]string{"user.x": "a\x00b"}, nil, nil, proto.CodeInvalidValue, "user.x"},
		{"web", map[string]string{"user.x": "\xff"}, nil, nil, proto.CodeInvalidValue, "user.x"},
		{"web", map[string]string{"limits.cpu": "2\n"}, nil, nil, proto.CodeInvalidValue, "limits.cpu"},
		{"web", map[string]string{"user.bad key": "x"}, nil, nil, proto.CodeNotAllowed, "user.bad key"},
		// Devices: host paths, other device types, other NIC types.
		{"web", map[string]string{"device.x": "type=disk,source=/etc,path=/mnt"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=/etc,path=/mnt"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=../data,path=/mnt"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=ceph:pool/vol,path=/mnt"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data,path=/mnt,shift=true"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data,path=/mnt,raw.mount.options=x"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=gpu"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=unix-char,path=/dev/kvm"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=usb,vendorid=1234"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=pci,address=0000:01:00.0"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=proxy,listen=tcp:0.0.0.0:22,connect=tcp:127.0.0.1:22"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,nictype=macvlan,parent=eno1"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,nictype=physical,parent=eno1"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,network=incusbr0,ipv4.routes=0.0.0.0/0"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,network=incusbr0,nictype=bridged,parent=br-lan"}, nil, nil, proto.CodeNotAllowed, "device.x"},
		// ... and what must exist on the host.
		{"web", map[string]string{"device.x": "type=nic,network=nope"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,nictype=bridged,parent=eno1"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=nope,source=data,path=/mnt"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=missing,path=/mnt"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,path=/mnt"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data,path=mnt"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data,path=/a/../../b"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=disk,pool=default,source=data,path=/mnt,size=10GiB"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.root": "type=disk,pool=default,path=/,size=lots"}, nil, nil, proto.CodeInvalidValue, "device.root"},
		// Malformed device strings and names.
		{"web", map[string]string{"device.x": "garbage"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "network=incusbr0"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,network=incusbr0,network=ovn1"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,net work=incusbr0"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.x": "type=nic,network=incusbr0,name=eth\x01"}, nil, nil, proto.CodeInvalidValue, "device.x"},
		{"web", map[string]string{"device.../x": "type=nic,network=incusbr0"}, nil, nil, proto.CodeInvalidValue, "device.../x"},
		{"web", map[string]string{"device.": "type=nic,network=incusbr0"}, nil, nil, proto.CodeInvalidValue, "device."},
		// Restricted devices are neither replaced nor removed; profile
		// devices and keys are not removed from the instance.
		{"web", map[string]string{"device.share": "type=disk,pool=default,source=data,path=/share"}, nil, nil, proto.CodeNotAllowed, "device.share"},
		{"web", nil, []string{"device.web80"}, nil, proto.CodeNotAllowed, "device.web80"},
		{"web", nil, []string{"device.eth0"}, nil, proto.CodeInvalidValue, "device.eth0"},
		{"vm1", nil, []string{"limits.memory"}, nil, proto.CodeInvalidValue, "limits.memory"},
		{"web", map[string]string{"limits.cpu": "3"}, []string{"limits.cpu"}, nil, proto.CodeInvalidValue, "limits.cpu"},
		{"web", nil, nil, []string{"limits.cpu"}, proto.CodeInvalidValue, "limits.cpu"},
	} {
		g := incusGuestOf(tc.guest, "container")
		r := d.manage(ctx, g, proto.ManageRequest{Op: proto.OpConfigSet, Set: tc.set, Delete: tc.del, Revert: tc.revert})
		if r.OK || r.Code != tc.code || r.FieldErrors[tc.field] == "" {
			t.Errorf("set %v delete %v revert %v: %+v", tc.set, tc.del, tc.revert, r)
		}
	}
	if len(f.puts) != 0 {
		t.Errorf("refused changes reached Incus: %+v", f.puts)
	}
	// A refused key refuses the whole change; not_allowed wins.
	r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpConfigSet,
		Set: map[string]string{"limits.cpu": "x", "raw.lxc": "y", "user.ok": "fine"}})
	if r.Code != proto.CodeNotAllowed || len(r.FieldErrors) != 2 || len(f.puts) != 0 {
		t.Errorf("mixed: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpConfigSet}); r.Code != CodeInvalid {
		t.Errorf("empty change: %+v", r)
	}
}

func TestIncusDiskResize(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	resize := func(guest, disk, size string) proto.ManageResponse {
		return d.manage(ctx, incusGuestOf(guest, "container"), proto.ManageRequest{Op: proto.OpDiskResize, Disk: disk, Size: size})
	}
	// lab/db's own root disk: 20 GiB + 8 GiB.
	r := resize("lab/db", "root", "+8G")
	if !r.OK || len(f.puts) != 1 || f.puts[0].Devices["root"]["size"] != "28GiB" || f.puts[0].Devices["root"]["pool"] != "fast" {
		t.Fatalf("grow: %+v %+v", r, f.puts)
	}
	if len(r.Changes) != 1 || r.Changes[0].Key != "device.root" || !strings.Contains(r.Changes[0].Old, "size=20GiB") || !strings.Contains(r.Changes[0].New, "size=28GiB") {
		t.Errorf("changes: %+v", r.Changes)
	}
	// vm1's root disk comes from the profile without size= (10 GiB): it
	// becomes the instance's own device.
	r = resize("vm1", "root", "16GiB")
	if !r.OK || len(f.puts) != 2 || f.puts[1].Devices["root"]["size"] != "16GiB" || f.puts[1].Devices["root"]["path"] != "/" {
		t.Fatalf("vm default size: %+v %+v", r, f.puts)
	}
	if r := resize("lab/db", "root", "28G"); !r.OK || len(f.puts) != 2 {
		t.Errorf("same size: %+v", r)
	}
	for _, tc := range []struct {
		guest, disk, size, code string
	}{
		{"lab/db", "root", "10G", proto.CodeInvalidValue}, // shrinking
		{"lab/db", "root", "-1G", proto.CodeInvalidValue},
		{"lab/db", "root", "lots", proto.CodeInvalidValue},
		{"lab/db", "root", "+8iB", proto.CodeInvalidValue},
		{"lab/db", "root", "", proto.CodeInvalidValue},
		{"web", "root", "+1G", proto.CodeInvalidValue}, // ZFS container without a limit
		{"web", "data", "+1G", proto.CodeInvalidValue}, // a custom volume
		{"web", "share", "+1G", proto.CodeNotAllowed},  // a host path
		{"web", "eth0", "+1G", proto.CodeNotFound},     // not a disk
		{"web", "nope", "+1G", proto.CodeNotFound},
	} {
		if r := resize(tc.guest, tc.disk, tc.size); r.Code != tc.code {
			t.Errorf("%s %s %q: %+v", tc.guest, tc.disk, tc.size, r)
		}
	}
	if len(f.puts) != 2 {
		t.Errorf("refused resizes reached Incus: %d", len(f.puts))
	}
	// A pool's volume.size is the size of a root disk without size=.
	f.mu.Lock()
	f.instances["ct1"].Devices = api.DevicesMap{"root": {"type": "disk", "path": "/", "pool": "fast"}}
	f.expand(f.instances["ct1"])
	f.mu.Unlock()
	if r := resize("ct1", "root", "+4G"); !r.OK || f.puts[2].Devices["root"]["size"] != "24GiB" {
		t.Errorf("pool volume.size: %+v", r)
	}
}

func TestIncusParseSize(t *testing.T) {
	for _, tc := range []struct {
		in  string
		n   uint64
		rel bool
	}{
		{"+8G", 8 << 30, true}, {"40G", 40 << 30, false}, {"40GiB", 40 << 30, false}, {"1.5T", 3 << 39, false},
		{"20GB", 20e9, false}, {"512M", 512 << 20, false}, {"1048576", 1 << 20, false}, {"+100MiB", 100 << 20, true}, {"2kB", 2000, false},
	} {
		n, rel, err := incusParseSize(tc.in)
		if err != nil || n != tc.n || rel != tc.rel {
			t.Errorf("%q: %d %v %v", tc.in, n, rel, err)
		}
	}
	for _, bad := range []string{"", "G", "+", "-8G", "8X", "8 GiBB", "0", "0.1", "1e9", "99999999999T"} {
		if _, _, err := incusParseSize(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	for n, want := range map[uint64]string{48 << 30: "48GiB", 1536 << 20: "1536MiB", 1000: "1000B"} {
		if got := incusSizeString(n); got != want {
			t.Errorf("%d: %s", n, got)
		}
	}
}

func TestIncusDeviceString(t *testing.T) {
	for _, s := range []string{
		"type=nic,name=eth0,network=incusbr0",
		"type=nic,nictype=bridged,parent=br-lan,vlan.tagged=10,20,30",
		"type=disk,path=/,pool=default,size=20GiB",
		"type=disk,path=/srv/a b,pool=default,source=data",
	} {
		dev, err := incusParseDevice(s)
		if err != nil || incusDeviceString(dev) != s {
			t.Errorf("%q: %v %v", s, dev, err)
		}
	}
	dev, err := incusParseDevice("pool=default,path=/,type=disk")
	if err != nil || incusDeviceString(dev) != "type=disk,path=/,pool=default" {
		t.Errorf("order: %v %v", dev, err)
	}
	for _, bad := range []string{"", ",type=nic", "type=nic,,network=x", "network=x", "type=nic,=x", "type=nic,type=disk", "type="} {
		if _, err := incusParseDevice(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestIncusChoices(t *testing.T) {
	_, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	r := d.manage(context.Background(), nil, proto.ManageRequest{Op: proto.OpChoices, Platform: "incus"})
	if !r.OK || r.Choices == nil {
		t.Fatalf("choices: %+v", r)
	}
	c := r.Choices
	// Usable pools only (no bucket pool, no unavailable one); thick LVM.
	if len(c.Storages) != 2 || !reflect.DeepEqual(c.Storages[0], proto.ChoiceStorage{ID: "default", Type: "zfs", Content: []string{"images", "rootdir"}, AvailBytes: 900 << 30, TotalBytes: 1000 << 30, Thin: true}) ||
		c.Storages[1].ID != "fast" || c.Storages[1].Thin || c.Storages[1].TotalBytes != 0 {
		t.Errorf("storages: %+v", c.Storages)
	}
	if got := strings.Join(c.Bridges, ","); got != "br-lan,incusbr0,ovn1" {
		t.Errorf("bridges: %s", got)
	}
	if got := strings.Join(c.Profiles, ","); got != "big,default,gpu" {
		t.Errorf("profiles: %s", got)
	}
	if len(c.Images) != 3 || c.Images[0].Aliases[0] != "debian/13" || c.Images[0].Description != "Debian trixie amd64" || c.Images[0].SizeBytes != 98<<20 ||
		c.Images[1].Type != "virtual-machine" || len(c.Images[2].Aliases) != 0 || c.Platform != "incus" {
		t.Errorf("images: %+v", c.Images)
	}
}

func TestIncusCreate(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	f.setHold(make(chan struct{}))
	r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Platform: "incus", Kind: "container", Name: "app1",
		Image: "images:debian/13/cloud", Profiles: []string{"default", "big"}, Start: true,
		Set: map[string]string{"limits.cpu": "2", "security.nesting": "true", "device.root": "type=disk,path=/,pool=default,size=12GiB", "description": "App"}})
	if !r.OK || r.Task == nil || !strings.HasPrefix(r.Task.ID, "incus:") || r.NewID != "app1" {
		t.Fatalf("create: %+v", r)
	}
	p := f.posts[0]
	if p.Name != "app1" || p.Type != api.InstanceTypeContainer || !p.Start || strings.Join(p.Profiles, ",") != "default,big" ||
		!reflect.DeepEqual(p.Source, api.InstanceSource{Type: "image", Mode: "pull", Server: "https://images.linuxcontainers.org", Protocol: "simplestreams", Alias: "debian/13/cloud"}) {
		t.Errorf("post: %+v", p)
	}
	if p.Config["limits.cpu"] != "2" || p.Config["security.nesting"] != "true" || p.Devices["root"]["size"] != "12GiB" || p.Description != "App" {
		t.Errorf("post config: %+v", p.InstancePut)
	}
	// The task runs, with the image download's progress.
	ts := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
	if !ts.OK || ts.TaskStatus.Status != "running" || ts.TaskStatus.Message != "rootfs: 42% (12.30MB/s)" || ts.TaskStatus.Type != "Creating instance" ||
		ts.TaskStatus.GuestID != "app1" || ts.TaskStatus.Ended != nil {
		t.Errorf("running task: %+v", ts.TaskStatus)
	}
	f.setHold(nil)
	uuid := strings.TrimPrefix(r.Task.ID, "incus:")
	f.waitOp(uuid)
	ts = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
	if !ts.OK || ts.TaskStatus.Status != "ok" || ts.TaskStatus.Message != "OK" || ts.TaskStatus.Ended == nil {
		t.Errorf("finished task: %+v", ts.TaskStatus)
	}
	// Incus forgets the operation; the agent still knows how it ended.
	waitFor(t, func() bool { st, ok := d.tasks.get(r.Task.ID); return ok && st.Status == "ok" })
	f.forget(uuid)
	ts = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
	if !ts.OK || ts.TaskStatus.Status != "ok" || ts.TaskStatus.GuestID != "app1" {
		t.Errorf("forgotten task: %+v", ts)
	}

	// Incus forgets an operation that still runs (it restarted, say): the
	// task ends as an error instead of running forever.
	f.setHold(make(chan struct{}))
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Name: "app2", Image: "images:debian/13"})
	if !r.OK || r.Task == nil {
		t.Fatalf("create app2: %+v", r)
	}
	f.forget(strings.TrimPrefix(r.Task.ID, "incus:"))
	waitFor(t, func() bool { st, _ := d.tasks.get(r.Task.ID); return st.Status == "error" })
	if ts := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID}); ts.TaskStatus == nil || ts.TaskStatus.Status != "error" ||
		ts.TaskStatus.Message != "Incus no longer knows this operation" || ts.TaskStatus.Ended == nil {
		t.Errorf("lost task: %+v", ts.TaskStatus)
	}
	f.setHold(nil)

	// A VM from a local image (alias, or a fingerprint prefix).
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "nix", Image: "nixos/26.05"})
	if !r.OK || f.posts[2].Source.Fingerprint != f.images[1].Fingerprint || f.posts[2].Source.Server != "" || f.posts[2].Source.Alias != "" ||
		f.posts[2].Type != api.InstanceTypeVM || f.posts[2].Profiles != nil {
		t.Errorf("local alias: %+v %+v", r, f.posts[2])
	}
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Name: "c2", Image: "local:9c8b7a6f5e4d9c8b"})
	if !r.OK || f.posts[3].Source.Fingerprint != f.images[2].Fingerprint {
		t.Errorf("fingerprint: %+v %+v", r, f.posts[3])
	}

	for _, tc := range []struct {
		req   proto.ManageRequest
		code  string
		field string
	}{
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "ubuntu:24.04"}, proto.CodeNotAllowed, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "https://evil.example/img"}, proto.CodeNotAllowed, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "docker:alpine"}, proto.CodeNotAllowed, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "images:../etc"}, proto.CodeInvalidValue, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "images:"}, proto.CodeInvalidValue, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: ""}, proto.CodeInvalidValue, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "nixos/26.05"}, proto.CodeInvalidValue, "image"}, // a VM image
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "nope/1"}, proto.CodeInvalidValue, "image"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "9c8b"}, proto.CodeInvalidValue, "image"}, // prefix too short
		{proto.ManageRequest{Kind: "pod", Name: "x", Image: "debian/13"}, proto.CodeInvalidValue, "kind"},
		{proto.ManageRequest{Kind: "container", Name: "", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "-x", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "x-", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "1234", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "a_b", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "lab/x", Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: strings.Repeat("a", 64), Image: "debian/13"}, proto.CodeInvalidValue, "name"},
		{proto.ManageRequest{Kind: "container", Name: "web", Image: "debian/13"}, proto.CodeExists, "name"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Profiles: []string{"nope"}}, proto.CodeInvalidValue, "profiles"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Profiles: []string{"default", "default"}}, proto.CodeInvalidValue, "profiles"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Profiles: []string{"../x"}}, proto.CodeInvalidValue, "profiles"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Set: map[string]string{"security.privileged": "true"}}, proto.CodeNotAllowed, "security.privileged"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Set: map[string]string{"raw.lxc": "x"}}, proto.CodeNotAllowed, "raw.lxc"},
		{proto.ManageRequest{Kind: "container", Name: "x", Image: "debian/13", Set: map[string]string{"device.h": "type=disk,source=/,path=/host"}}, proto.CodeNotAllowed, "device.h"},
		{proto.ManageRequest{Kind: "vm", Name: "x", Image: "nixos/26.05", Set: map[string]string{"security.nesting": "true"}}, proto.CodeNotAllowed, "security.nesting"},
	} {
		tc.req.Op = proto.OpCreate
		if r := d.manage(ctx, nil, tc.req); r.OK || r.Code != tc.code || r.FieldErrors[tc.field] == "" {
			t.Errorf("%+v: %+v", tc.req, r)
		}
	}
	if len(f.posts) != 4 {
		t.Errorf("refused creates reached Incus: %d", len(f.posts))
	}
}

func TestIncusCloneDelete(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	// Copy onto another pool: the root disk (from the profile) gets it.
	r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpClone, Name: "web2", Storage: "fast"})
	if !r.OK || r.Task == nil || r.NewID != "web2" {
		t.Fatalf("clone: %+v", r)
	}
	p := f.posts[0]
	if p.Source.Type != "copy" || p.Source.Source != "web" || p.Name != "web2" || len(p.Devices) != 1 ||
		p.Devices["root"]["pool"] != "fast" || p.Devices["root"]["path"] != "/" || p.Profiles != nil {
		t.Errorf("clone post: %+v", p)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	// In a project: the new id carries the project.
	r = d.manage(ctx, incusGuestOf("lab/db", "container"), proto.ManageRequest{Op: proto.OpClone, Name: "db2"})
	if !r.OK || r.NewID != "lab/db2" || len(f.posts[1].Devices) != 0 {
		t.Errorf("project clone: %+v %+v", r, f.posts[1])
	}
	for _, tc := range []struct {
		req  proto.ManageRequest
		code string
	}{
		{proto.ManageRequest{Name: "web2"}, proto.CodeExists},
		{proto.ManageRequest{Name: "x", Storage: "nope"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Name: "x", Storage: "../x"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Name: "bad name"}, proto.CodeInvalidValue},
	} {
		tc.req.Op = proto.OpClone
		if r := d.manage(ctx, incusGuestOf("web", "container"), tc.req); r.Code != tc.code {
			t.Errorf("%+v: %+v", tc.req, r)
		}
	}

	// Delete: running and protected guests stay.
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpDelete}); r.Code != proto.CodeGuestRunning {
		t.Errorf("running: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("vm1", "vm"), proto.ManageRequest{Op: proto.OpDelete}); r.Code != proto.CodeProtected {
		t.Errorf("protected: %+v", r)
	}
	if len(f.deletes) != 0 {
		t.Fatalf("deleted: %v", f.deletes)
	}
	r = d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpDelete})
	if !r.OK || r.Task == nil || len(f.deletes) != 1 || f.deletes[0] != "ct1" {
		t.Fatalf("delete: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	// A failed operation: task.status says why.
	f.mu.Lock()
	f.failNext = "Failed deleting instance \"db2\" in project \"lab\": dataset is busy"
	f.mu.Unlock()
	r = d.manage(ctx, incusGuestOf("lab/db2", "container"), proto.ManageRequest{Op: proto.OpDelete})
	if !r.OK || r.Task == nil {
		t.Fatalf("delete db2: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	ts := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
	if ts.TaskStatus == nil || ts.TaskStatus.Status != "error" || !strings.Contains(ts.TaskStatus.Message, "dataset is busy") || ts.TaskStatus.GuestID != "lab/db2" {
		t.Errorf("failed task: %+v", ts.TaskStatus)
	}
}

func TestIncusTaskStatusAndUnsupported(t *testing.T) {
	_, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	for _, id := range []string{"", "incus:", "incus:../x", "UPID:pve1:00001:00002:6ACB9A27:vzdump::root@pam:", "incus:00000000-0000-4000-8000-00000000000G"} {
		if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: id}); r.Code != proto.CodeInvalidValue {
			t.Errorf("task %q: %+v", id, r)
		}
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: "incus:00000000-0000-4000-8000-000000000999"}); r.Code != proto.CodeNotFound {
		t.Errorf("unknown task: %+v", r)
	}
	for _, op := range []string{proto.OpDiskMove, proto.OpTemplate, proto.OpFirewallGet,
		proto.OpHASet, proto.OpReplicationAdd, proto.OpContentList, proto.OpApplianceList, proto.OpMigrate, proto.OpBackupUpdate} {
		if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: op}); r.Code != CodeUnsupported {
			t.Errorf("%s: %+v", op, r)
		}
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpConfigGet}); r.Code != CodeInvalid {
		t.Errorf("guest op without a guest: %+v", r)
	}
}

// TestIncusManageBroker runs manage through the broker: the guest must be
// in the inventory, changes take the guest lock.
func TestIncusManageBroker(t *testing.T) {
	_, sock := newFakeIncus(t)
	inv := &proto.Report{Incus: &proto.Platform{Guests: []proto.Guest{{ID: "web", Kind: "container", State: "running"}}}}
	b := NewBroker(&agent.Config{}, func() *proto.Report { return inv }, nil)
	b.drivers[proto.PlatformIncus] = &incusDriver{socket: sock}
	ctx := context.Background()
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpConfigGet, Platform: "incus", GuestID: "web"}); !r.OK || r.Config.Values["limits.cpu"] != "2" {
		t.Errorf("config.get: %+v", r)
	}
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpConfigGet, Platform: "incus", GuestID: "vm1"}); r.Code != CodeUnknownGuest {
		t.Errorf("guest not in the inventory: %+v", r)
	}
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpChoices, Platform: "incus"}); !r.OK {
		t.Errorf("choices: %+v", r)
	}
	unlock, _ := b.lockGuest(ctx, "incus", "web")
	lctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if r := b.Manage(lctx, proto.ManageRequest{Op: proto.OpConfigSet, Platform: "incus", GuestID: "web", Set: map[string]string{"limits.cpu": "3"}}); r.Code != CodeBusy {
		t.Errorf("locked guest: %+v", r)
	}
	unlock()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
