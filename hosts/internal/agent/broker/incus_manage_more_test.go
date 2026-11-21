package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/proto"
)

// fakeExtensions are the API extensions the fake Incus announces (the
// client checks some before it sends a request).
var fakeExtensions = []string{"storage", "resources", "network", "instances", "projects", "container_backup",
	"container_backup_override_pool", "backup_override_name", "backup_compression_algorithm", "operations_get_query_all_projects",
	"instance_pool_move", "instance_project_move", "network_leases", "instance_all_projects", "image_force_refresh",
	"storage_api_volume_snapshots", "container_only_migration", "image_types"}

func volKey(project, pool, name string) string {
	if project == "" {
		project = "default"
	}
	return project + "|" + pool + "|" + name
}

// fakeBackupFile is what the fake's export holds: enough of the instance
// to import it again.
type fakeBackupFile struct {
	Type     string         `json:"type"`
	Config   api.ConfigMap  `json:"config"`
	Devices  api.DevicesMap `json:"devices"`
	Profiles []string       `json:"profiles"`
}

// serveMore answers the parts of the API the newer Incus operations use
// (projects, backups, profiles, volumes, images, leases, logs,
// operations, rename and move). It is called with f.mu held and reports
// whether it answered.
func (f *fakeIncus) serveMore(w http.ResponseWriter, r *http.Request, project, path string) bool {
	switch {
	case path == "/1.0/projects" && r.URL.Query().Get("recursion") == "1":
		var ps []api.Project
		for _, p := range f.projects {
			ps = append(ps, api.Project{Name: p, ProjectPut: api.ProjectPut{Config: map[string]string{"features.networks": "false"}}})
		}
		fakeSync(w, "", ps)
	case path == "/1.0/projects":
		var urls []string
		for _, p := range f.projects {
			urls = append(urls, "/1.0/projects/"+p)
		}
		fakeSync(w, "", urls)
	case strings.HasPrefix(path, "/1.0/projects/"):
		name := strings.TrimPrefix(path, "/1.0/projects/")
		if !slices.Contains(f.projects, name) {
			fakeError(w, 404, "Project not found")
		} else {
			fakeSync(w, "", api.Project{Name: name})
		}
	case path == "/1.0/operations":
		running := []api.Operation{}
		for _, op := range f.ops {
			running = append(running, op.op)
		}
		running = append(running, api.Operation{ID: "00000000-0000-4000-8000-0000000000ee", Class: "websocket", Description: "Executing command",
			StatusCode: api.Running, CreatedAt: time.Now()})
		fakeSync(w, "", map[string][]api.Operation{"running": running})
	case path == "/1.0/instances" && r.Method == http.MethodGet:
		var all []api.Instance
		for _, k := range slices.Sorted(maps.Keys(f.instances)) {
			all = append(all, *f.instances[k])
		}
		fakeSync(w, "", all)
	case path == "/1.0/instances" && r.Method == http.MethodPost && r.Header.Get("Content-Type") == "application/octet-stream":
		// Import a backup.
		raw, err := io.ReadAll(r.Body)
		var bf fakeBackupFile
		if err == nil {
			err = json.Unmarshal(raw, &bf)
		}
		if err != nil {
			fakeError(w, 400, "not a backup: "+fmt.Sprint(err))
			return true
		}
		name, pool := r.Header.Get("X-Incus-name"), r.Header.Get("X-Incus-pool")
		if f.instances[fakeKey(project, name)] != nil {
			fakeError(w, 409, "Instance "+name+" already exists")
			return true
		}
		devs := maps.Clone(bf.Devices)
		if pool != "" {
			devs["root"] = map[string]string{"type": "disk", "path": "/", "pool": pool}
		}
		f.async(w, f.newOp("Restoring backup", project, name, func() error {
			f.add(project, name, bf.Type, "Stopped", bf.Profiles, bf.Config, devs, "")
			return nil
		}))
	case strings.HasPrefix(path, "/1.0/instances/") && strings.Contains(strings.TrimPrefix(path, "/1.0/instances/"), "/"):
		rest := strings.Split(strings.TrimPrefix(path, "/1.0/instances/"), "/")
		key := fakeKey(project, rest[0])
		in := f.instances[key]
		if in == nil {
			fakeError(w, 404, "Instance not found")
			return true
		}
		f.serveInstanceSub(w, r, project, key, in, rest[1:])
	case strings.HasPrefix(path, "/1.0/instances/") && r.Method == http.MethodPost:
		name := strings.TrimPrefix(path, "/1.0/instances/")
		key := fakeKey(project, name)
		in := f.instances[key]
		if in == nil {
			fakeError(w, 404, "Instance not found")
			return true
		}
		var req api.InstancePost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fakeError(w, 400, err.Error())
			return true
		}
		if !req.Migration {
			if f.instances[fakeKey(project, req.Name)] != nil {
				fakeError(w, 409, "Name already in use")
				return true
			}
			f.async(w, f.newOp("Renaming instance", project, name, func() error {
				delete(f.instances, key)
				in.Name = req.Name
				f.instances[fakeKey(project, req.Name)] = in
				return nil
			}))
			return true
		}
		f.async(w, f.newOp("Moving instance", project, name, func() error {
			if req.Pool != "" {
				root := maps.Clone(in.ExpandedDevices["root"])
				root["pool"] = req.Pool
				in.Devices["root"] = root
				f.expand(in)
			}
			if req.Project != "" {
				delete(f.instances, key)
				in.Project = req.Project
				f.instances[fakeKey(req.Project, in.Name)] = in
			}
			return nil
		}))
	case path == "/1.0/profiles" && r.Method == http.MethodPost:
		var req api.ProfilesPost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fakeError(w, 400, err.Error())
			return true
		}
		if _, ok := f.profiles[req.Name]; ok {
			fakeError(w, 409, "Profile already exists")
			return true
		}
		f.profiles[req.Name] = req.ProfilePut
		fakeSync(w, "", nil)
	case strings.HasPrefix(path, "/1.0/profiles/"):
		f.serveProfile(w, r, strings.TrimPrefix(path, "/1.0/profiles/"))
	case strings.HasPrefix(path, "/1.0/networks/") && strings.HasSuffix(path, "/leases"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/1.0/networks/"), "/leases")
		l, ok := f.leases[name]
		if !ok {
			fakeError(w, 404, "Network not found")
			return true
		}
		fakeSync(w, "", l)
	case path == "/1.0/images" && r.Method == http.MethodPost:
		var req api.ImagesPost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Source == nil {
			fakeError(w, 400, "bad image request")
			return true
		}
		for _, a := range req.Aliases {
			for _, im := range f.images {
				for _, b := range im.Aliases {
					if b.Name == a.Name {
						fakeError(w, 409, "Alias already exists")
						return true
					}
				}
			}
		}
		f.nimages++
		fp := strings.Repeat(fmt.Sprintf("%04x", 0xa000+f.nimages), 16)
		typ := req.Source.ImageType
		if req.Source.Type == "instance" || req.Source.Type == "snapshot" {
			src, _, _ := strings.Cut(req.Source.Name, "/")
			if in := f.instances[fakeKey(project, src)]; in != nil {
				typ = in.Type
			}
		}
		op := f.newOp("Creating image", project, "", func() error {
			im := api.Image{Fingerprint: fp, Type: typ, Size: 50 << 20, ImagePut: api.ImagePut{Properties: req.Properties, AutoUpdate: req.AutoUpdate}}
			for _, a := range req.Aliases {
				im.Aliases = append(im.Aliases, api.ImageAlias{Name: a.Name})
			}
			f.images = append(f.images, im)
			return nil
		})
		op.op.Resources = map[string][]string{}
		op.result = map[string]any{"fingerprint": fp, "size": "52428800"}
		f.posts = append(f.posts, api.InstancesPost{Name: "image:" + req.Source.Type + ":" + req.Source.Name + ":" + req.Source.Alias})
		f.async(w, op)
	case strings.HasPrefix(path, "/1.0/images/aliases/"):
		alias := strings.TrimPrefix(path, "/1.0/images/aliases/")
		for _, im := range f.images {
			for _, a := range im.Aliases {
				if a.Name == alias {
					fakeSync(w, "", api.ImageAliasesEntry{Name: alias, Target: im.Fingerprint})
					return true
				}
			}
		}
		fakeError(w, 404, "Image alias not found")
	case strings.HasPrefix(path, "/1.0/images/"):
		rest := strings.TrimPrefix(path, "/1.0/images/")
		fp, sub, _ := strings.Cut(rest, "/")
		idx := slices.IndexFunc(f.images, func(im api.Image) bool { return im.Fingerprint == fp })
		if idx < 0 {
			fakeError(w, 404, "Image not found")
			return true
		}
		switch {
		case sub == "refresh" && r.Method == http.MethodPost:
			f.async(w, f.newOp("Refreshing image", project, "", func() error { return nil }))
		case sub == "" && r.Method == http.MethodDelete:
			f.async(w, f.newOp("Deleting image", project, "", func() error {
				f.images = slices.DeleteFunc(f.images, func(im api.Image) bool { return im.Fingerprint == fp })
				return nil
			}))
		default:
			fakeSync(w, "", f.images[idx])
		}
	default:
		return false
	}
	return true
}

// serveInstanceSub answers /1.0/instances/<n>/{backups,snapshots,logs}.
func (f *fakeIncus) serveInstanceSub(w http.ResponseWriter, r *http.Request, project, key string, in *api.Instance, rest []string) {
	switch {
	case rest[0] == "backups" && len(rest) == 1 && r.Method == http.MethodGet:
		fakeSync(w, "", nonNilBackups(f.backups[key]))
	case rest[0] == "backups" && len(rest) == 1 && r.Method == http.MethodPost:
		var req api.InstanceBackupsPost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fakeError(w, 400, err.Error())
			return
		}
		f.posts = append(f.posts, api.InstancesPost{Name: "backup:" + req.Name + ":" + req.CompressionAlgorithm + ":" + strconv.FormatBool(req.InstanceOnly)})
		f.async(w, f.newOp("Backing up instance", project, in.Name, func() error {
			f.backups[key] = append(f.backups[key], api.InstanceBackup{Name: req.Name, CreatedAt: time.Now().UTC(), ExpiresAt: req.ExpiresAt,
				InstanceOnly: req.InstanceOnly, OptimizedStorage: req.OptimizedStorage})
			return nil
		}))
	case rest[0] == "backups" && len(rest) >= 2:
		idx := slices.IndexFunc(f.backups[key], func(b api.InstanceBackup) bool { return b.Name == rest[1] })
		if idx < 0 {
			fakeError(w, 404, "Backup not found")
			return
		}
		switch {
		case len(rest) == 3 && rest[2] == "export":
			b, _ := json.Marshal(fakeBackupFile{Type: in.Type, Config: in.Config, Devices: in.Devices, Profiles: in.Profiles})
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(b)
		case r.Method == http.MethodDelete:
			f.async(w, f.newOp("Deleting backup", project, in.Name, func() error {
				f.backups[key] = slices.Delete(f.backups[key], idx, idx+1)
				return nil
			}))
		default:
			fakeSync(w, "", f.backups[key][idx])
		}
	case rest[0] == "snapshots" && len(rest) == 2:
		if !slices.Contains(f.snapshots[key], rest[1]) {
			fakeError(w, 404, "Snapshot not found")
			return
		}
		fakeSync(w, "", api.InstanceSnapshot{Name: rest[1]})
	case rest[0] == "logs" && len(rest) == 2:
		if in.Name == "ct1" {
			fakeError(w, 404, "Log not found")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		for i := 1; i <= 600; i++ {
			fmt.Fprintf(w, "%s line %d\x1b[0m\tend\n", rest[1], i)
		}
	default:
		f.t.Errorf("unexpected %s %s", r.Method, r.URL)
		fakeError(w, 404, "not found")
	}
}

func nonNilBackups(b []api.InstanceBackup) []api.InstanceBackup {
	if b == nil {
		return []api.InstanceBackup{}
	}
	return b
}

// serveProfile answers GET / PUT / DELETE /1.0/profiles/<name>.
func (f *fakeIncus) serveProfile(w http.ResponseWriter, r *http.Request, name string) {
	p, ok := f.profiles[name]
	if !ok {
		fakeError(w, 404, "Profile not found")
		return
	}
	etag := fmt.Sprintf("profile-%s-%d", name, f.pversions[name])
	switch r.Method {
	case http.MethodGet:
		var used []string
		for _, k := range slices.Sorted(maps.Keys(f.instances)) {
			in := f.instances[k]
			if slices.Contains(in.Profiles, name) {
				u := "/1.0/instances/" + in.Name
				if in.Project != "" && in.Project != "default" {
					u += "?project=" + in.Project
				}
				used = append(used, u)
			}
		}
		fakeSync(w, etag, api.Profile{Name: name, ProfilePut: p, UsedBy: used})
	case http.MethodPut:
		if m := strings.Trim(r.Header.Get("If-Match"), `"`); m != "" && m != etag {
			fakeError(w, 412, "ETag doesn't match")
			return
		}
		var put api.ProfilePut
		if err := json.NewDecoder(r.Body).Decode(&put); err != nil {
			fakeError(w, 400, err.Error())
			return
		}
		f.profiles[name] = put
		f.pversions[name]++
		for _, in := range f.instances {
			f.expand(in)
		}
		fakeSync(w, "", nil)
	case http.MethodDelete:
		delete(f.profiles, name)
		fakeSync(w, "", nil)
	}
}

// serveVolume answers /1.0/storage-pools/<pool>/volumes/custom[/<name>].
func (f *fakeIncus) serveVolume(w http.ResponseWriter, r *http.Request, project, pool string, rest []string) {
	if len(rest) == 0 {
		if r.Method != http.MethodPost {
			fakeError(w, 405, "not allowed")
			return
		}
		var req api.StorageVolumesPost
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fakeError(w, 400, err.Error())
			return
		}
		k := volKey(project, pool, req.Name)
		if f.vols[k] != nil {
			fakeError(w, 409, "Volume already exists")
			return
		}
		f.vols[k] = &api.StorageVolume{Name: req.Name, Type: "custom", ContentType: req.ContentType, Project: project, StorageVolumePut: req.StorageVolumePut}
		fakeSync(w, "", nil)
		return
	}
	k := volKey(project, pool, rest[0])
	v := f.vols[k]
	if v == nil {
		fakeError(w, 404, "Storage volume not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		fakeSync(w, "vol-"+v.Config["size"], v)
	case http.MethodPut, http.MethodPatch:
		if m := strings.Trim(r.Header.Get("If-Match"), `"`); m != "" && m != "vol-"+v.Config["size"] {
			fakeError(w, 412, "ETag doesn't match")
			return
		}
		var put api.StorageVolumePut
		if err := json.NewDecoder(r.Body).Decode(&put); err != nil {
			fakeError(w, 400, err.Error())
			return
		}
		v.StorageVolumePut = put
		fakeSync(w, "", nil)
	case http.MethodDelete:
		delete(f.vols, k)
		fakeSync(w, "", nil)
	}
}

// ---- tests ---------------------------------------------------------------------------

func TestIncusChoicesProject(t *testing.T) {
	_, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	r := d.manage(context.Background(), nil, proto.ManageRequest{Op: proto.OpChoices, Project: "lab"})
	if !r.OK || strings.Join(r.Choices.Projects, ",") != "default,lab" || r.Choices.Project != "lab" || len(r.Choices.RemoteImages) < 30 {
		t.Fatalf("choices: %+v", r.Choices)
	}
	ri := r.Choices.RemoteImages
	if ri[0] != (proto.RemoteImage{Alias: "debian/13", Description: "Debian 13 (trixie)", Type: "container"}) || ri[1].Alias != "debian/13/cloud" {
		t.Errorf("remote images: %+v", ri[:2])
	}
	if r := d.manage(context.Background(), nil, proto.ManageRequest{Op: proto.OpChoices, Project: "nope"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("unknown project: %+v", r)
	}
	if r := d.manage(context.Background(), nil, proto.ManageRequest{Op: proto.OpChoices, Project: "../x"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("bad project: %+v", r)
	}
}

func TestIncusCreateInProject(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "cloudy", Image: "images:debian/13/cloud",
		Project: "lab", Pool: "fast", Network: "br-lan", CloudInit: "#cloud-config\npackages: [htop]\n", Set: map[string]string{"limits.cpu": "2"}})
	if !r.OK || r.NewID != "lab/cloudy" {
		t.Fatalf("create: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	in := f.instances["lab/cloudy"]
	post := f.posts[len(f.posts)-1]
	f.mu.Unlock()
	if in == nil || in.Config["cloud-init.user-data"] != "#cloud-config\npackages: [htop]\n" ||
		incusDeviceString(post.Devices["root"]) != "type=disk,path=/,pool=fast" ||
		incusDeviceString(post.Devices["eth0"]) != "type=nic,name=eth0,nictype=bridged,parent=br-lan" {
		t.Errorf("created: %+v %+v", in, post)
	}
	for _, tc := range []struct {
		req   proto.ManageRequest
		field string
	}{
		{proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "a", Image: "images:x", Project: "nope"}, "project"},
		{proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "a", Image: "images:x", Pool: "nope"}, "device.root"},
		{proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "a", Image: "images:x", Network: "nope"}, "device.eth0"},
		{proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "a", Image: "images:x", CloudInit: strings.Repeat("x", 65<<10)}, "cloud_init"},
	} {
		if r := d.manage(ctx, nil, tc.req); r.OK || r.FieldErrors[tc.field] == "" {
			t.Errorf("%s: %+v", tc.field, r)
		}
	}
}

func TestIncusCloneIntoProject(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	r := d.manage(context.Background(), incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpClone, Name: "ct2", Project: "lab", InstanceOnly: true})
	if !r.OK || r.NewID != "lab/ct2" {
		t.Fatalf("clone: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	post := f.posts[len(f.posts)-1]
	f.mu.Unlock()
	if post.Source.Project != "default" || !post.Source.InstanceOnly || post.Source.Source != "ct1" {
		t.Errorf("clone source: %+v", post.Source)
	}
}

func TestIncusConfigSetDevicesAndProfiles(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	r := d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpConfigSet,
		Devices:  map[string]map[string]string{"media": {"type": "disk", "pool": "default", "source": "media", "path": "/media"}},
		Profiles: []string{"default", "big"}})
	if !r.OK || len(r.Changes) != 2 || r.Changes[0].Key != "device.media" || r.Changes[1] != (proto.ConfigChange{Key: "profiles", Old: "default", New: "default, big"}) {
		t.Fatalf("config.set: %+v", r)
	}
	f.mu.Lock()
	put := f.puts[len(f.puts)-1]
	f.mu.Unlock()
	if put.Devices["media"]["source"] != "media" || strings.Join(put.Profiles, ",") != "default,big" {
		t.Errorf("put: %+v", put)
	}
	// Removing through devices: nil.
	r = d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpConfigSet,
		Devices: map[string]map[string]string{"media": nil}})
	if !r.OK || len(r.Changes) != 1 || r.Changes[0].New != "" {
		t.Errorf("remove device: %+v", r)
	}
	for _, req := range []proto.ManageRequest{
		{Op: proto.OpConfigSet, Profiles: []string{"nope"}},
		{Op: proto.OpConfigSet, Profiles: []string{"big", "big"}},
		{Op: proto.OpConfigSet, Devices: map[string]map[string]string{"x": {}}},
		{Op: proto.OpConfigSet, Set: map[string]string{"device.x": "type=nic,network=incusbr0"}, Devices: map[string]map[string]string{"x": nil}},
	} {
		if r := d.manage(ctx, incusGuestOf("ct1", "container"), req); r.OK || r.Code != proto.CodeInvalidValue {
			t.Errorf("%+v: %+v", req, r)
		}
	}
}

func TestIncusRenameMovePublish(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	// Running guests are refused.
	for _, op := range []string{proto.OpRename, proto.OpMove} {
		if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: op, Name: "web2", Pool: "fast"}); r.Code != proto.CodeGuestRunning {
			t.Errorf("%s running: %+v", op, r)
		}
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpPublish}); r.Code != proto.CodeGuestRunning {
		t.Errorf("publish running: %+v", r)
	}
	// Bad names, taken names.
	for _, name := range []string{"1abc", "a_b", "abc-", strings.Repeat("a", 64)} {
		if r := d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpRename, Name: name}); r.FieldErrors["name"] == "" {
			t.Errorf("rename %q: %+v", name, r)
		}
	}
	if r := d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpRename, Name: "vm1"}); r.Code != proto.CodeExists {
		t.Errorf("rename taken: %+v", r)
	}
	r := d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpRename, Name: "ct9"})
	if !r.OK || r.NewID != "ct9" {
		t.Fatalf("rename: %+v", r)
	}
	f.mu.Lock()
	if f.instances["ct9"] == nil || f.instances["ct1"] != nil {
		t.Errorf("renamed: %v", slices.Collect(maps.Keys(f.instances)))
	}
	f.mu.Unlock()

	// Move to a pool and into a project.
	if r := d.manage(ctx, incusGuestOf("ct9", "container"), proto.ManageRequest{Op: proto.OpMove}); r.FieldErrors["pool"] == "" {
		t.Errorf("move without a target: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("ct9", "container"), proto.ManageRequest{Op: proto.OpMove, Pool: "nope"}); r.FieldErrors["pool"] == "" {
		t.Errorf("move to no pool: %+v", r)
	}
	r = d.manage(ctx, incusGuestOf("ct9", "container"), proto.ManageRequest{Op: proto.OpMove, Pool: "fast", Project: "lab"})
	if !r.OK || r.NewID != "lab/ct9" {
		t.Fatalf("move: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	moved := f.instances["lab/ct9"]
	f.mu.Unlock()
	if moved == nil || moved.ExpandedDevices["root"]["pool"] != "fast" {
		t.Errorf("moved: %+v", moved)
	}

	// Publish a snapshot of the running web; the fingerprint comes with
	// the task.
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpPublish, Snapshot: "nope"}); r.Code != proto.CodeNotFound {
		t.Errorf("publish unknown snapshot: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpPublish, Snapshot: "snap0", Alias: "debian/13"}); r.Code != proto.CodeExists {
		t.Errorf("publish taken alias: %+v", r)
	}
	r = d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpPublish, Snapshot: "snap0", Alias: "web/2026-10", Description: "Web front end"})
	if !r.OK || r.Task == nil {
		t.Fatalf("publish: %+v", r)
	}
	uuid := strings.TrimPrefix(r.Task.ID, "incus:")
	f.waitOp(uuid)
	ts := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
	if !ts.OK || ts.TaskStatus.Status != "ok" || len(ts.TaskStatus.NewID) != 64 {
		t.Errorf("publish task: %+v", ts.TaskStatus)
	}
	f.mu.Lock()
	last := f.images[len(f.images)-1]
	f.mu.Unlock()
	if last.Aliases[0].Name != "web/2026-10" || last.Properties["description"] != "Web front end" || last.Fingerprint != ts.TaskStatus.NewID {
		t.Errorf("image: %+v", last)
	}
}

func TestIncusLog(t *testing.T) {
	_, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	r := d.manage(ctx, incusGuestOf("vm1", "vm"), proto.ManageRequest{Op: proto.OpLogGet, Lines: 3})
	if !r.OK || r.Log.File != "qemu.log" || len(r.Log.Lines) != 3 || r.Log.Lines[2] != "qemu.log line 600[0m end" {
		t.Errorf("log: %+v", r.Log)
	}
	r = d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpLogGet})
	if !r.OK || r.Log.File != "lxc.log" || len(r.Log.Lines) != 500 || r.Log.Lines[0] != "lxc.log line 101[0m end" {
		t.Errorf("log default: %s %d %q", r.Log.File, len(r.Log.Lines), r.Log.Lines[0])
	}
	if r := d.manage(ctx, incusGuestOf("ct1", "container"), proto.ManageRequest{Op: proto.OpLogGet}); !r.OK || len(r.Log.Lines) != 0 {
		t.Errorf("no log yet: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpLogGet, Lines: 2001}); r.FieldErrors["lines"] == "" {
		t.Errorf("too many lines: %+v", r)
	}
	if got := tailLines(strings.NewReader("a\nb\nc\nd\n"), 2); strings.Join(got, ",") != "c,d" {
		t.Errorf("tail: %v", got)
	}
}

func TestIncusBackups(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()
	dir := t.TempDir()
	saved := incusBackupsDir
	incusBackupsDir = dir
	defer func() { incusBackupsDir = saved }()

	exp := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupCreate, Name: "nightly", ExpiresAt: &exp, InstanceOnly: true, Compress: "gzip"})
	if !r.OK || r.Task == nil {
		t.Fatalf("backup.create: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	if p := f.posts[len(f.posts)-1].Name; p != "backup:nightly:gzip:true" {
		t.Errorf("backup post: %s", p)
	}
	f.mu.Unlock()
	// The default name and compression.
	r = d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupCreate})
	if !r.OK {
		t.Fatalf("backup.create default: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	for _, req := range []proto.ManageRequest{
		{Op: proto.OpBackupCreate, Name: "nightly"},
		{Op: proto.OpBackupCreate, Name: "a/b"},
		{Op: proto.OpBackupCreate, Compression: "lzo"},
		{Op: proto.OpBackupCreate, ExpiresAt: &time.Time{}},
	} {
		if r := d.manage(ctx, incusGuestOf("web", "container"), req); r.OK {
			t.Errorf("%+v accepted", req)
		}
	}
	os.MkdirAll(filepath.Join(dir, "web"), 0o755)
	os.WriteFile(filepath.Join(dir, "web", "nightly"), make([]byte, 1234), 0o644)
	r = d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupList})
	if !r.OK || len(r.Backups) != 2 {
		t.Fatalf("backup.list: %+v", r)
	}
	var nightly proto.BackupVolume
	for _, b := range r.Backups {
		if b.Volume == "nightly" {
			nightly = b
		} else if !strings.HasPrefix(b.Volume, "whombat-") || b.ExpiresAt == nil || b.ExpiresAt.Sub(time.Now()) < 6*24*time.Hour {
			t.Errorf("default backup: %+v", b)
		}
	}
	if nightly.Storage != "incus" || nightly.Format != "tar" || nightly.SizeBytes != 1234 || nightly.ExpiresAt == nil || !nightly.ExpiresAt.Equal(exp) ||
		nightly.Notes != "expires "+exp.Format(time.RFC3339) || nightly.GuestID != "web" {
		t.Errorf("nightly: %+v", nightly)
	}

	// Restore as a new instance onto another pool, started.
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupRestore, Volume: "nope"}); r.Code != proto.CodeNotFound {
		t.Errorf("restore unknown backup: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupRestore, Volume: "nightly", Name: "vm1"}); r.Code != proto.CodeExists {
		t.Errorf("restore over an existing name: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpBackupRestore, Volume: "nightly"}); r.FieldErrors["guest"] == "" {
		t.Errorf("restore without the guest: %+v", r)
	}
	r = d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupRestore, Volume: "nightly", Storage: "fast"})
	if !r.OK || r.NewID != "web-restored" || r.Task == nil {
		t.Fatalf("restore: %+v", r)
	}
	var st proto.TaskStatus
	waitFor(t, func() bool {
		ts := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
		if ts.TaskStatus != nil {
			st = *ts.TaskStatus
		}
		return ts.OK && ts.TaskStatus.Status != "running"
	})
	if st.Status != "ok" || st.NewID != "web-restored" || st.GuestID != "web-restored" || st.Ended == nil {
		t.Errorf("restore task: %+v", st)
	}
	f.mu.Lock()
	restored := f.instances["web-restored"]
	f.mu.Unlock()
	if restored == nil || restored.ExpandedDevices["root"]["pool"] != "fast" || restored.Config["limits.cpu"] != "2" {
		t.Errorf("restored: %+v", restored)
	}
	// It shows in task.list (kept by the agent) with the guest.
	tl := d.manage(ctx, &proto.Guest{ID: "web-restored"}, proto.ManageRequest{Op: proto.OpTaskList})
	if !tl.OK || !slices.ContainsFunc(tl.Tasks, func(t proto.TaskStatus) bool { return t.ID == r.Task.ID && t.NewID == "web-restored" }) {
		t.Errorf("task.list of the restored guest: %+v", tl.Tasks)
	}

	// Delete.
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpBackupDelete, Volume: "nightly"}); r.FieldErrors["guest"] == "" {
		t.Errorf("delete without the guest: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupDelete, Volume: "nightly"}); !r.OK {
		t.Errorf("backup.delete: %+v", r)
	}
	if r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupDelete, Volume: "nightly"}); r.Code != proto.CodeNotFound {
		t.Errorf("backup.delete again: %+v", r)
	}
}

func TestIncusTasksListStop(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock, inv: func() *proto.Report {
		end := time.Now().Add(-time.Hour)
		old := time.Now().Add(-72 * time.Hour)
		return &proto.Report{Incus: &proto.Platform{Tasks: []proto.PVETask{
			{UPID: "00000000-0000-4000-8000-0000000000f1", Type: "Starting instance", ID: "web", Start: end.Add(-time.Minute), End: &end, Status: "boom"},
			{UPID: "00000000-0000-4000-8000-0000000000f2", Type: "Old", ID: "web", Start: old, End: &old, Status: "old"},
		}}}
	}}
	ctx := context.Background()
	f.setHold(make(chan struct{}))
	r := d.manage(ctx, incusGuestOf("web", "container"), proto.ManageRequest{Op: proto.OpBackupCreate, Name: "b1"})
	if !r.OK || r.Task == nil {
		t.Fatalf("backup: %+v", r)
	}
	f.mu.Lock()
	f.ops[strings.TrimPrefix(r.Task.ID, "incus:")].op.MayCancel = true
	f.mu.Unlock()
	tl := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskList})
	if !tl.OK || len(tl.Tasks) != 2 || tl.Tasks[0].ID != r.Task.ID || !tl.Tasks[0].Cancellable || tl.Tasks[0].Status != "running" ||
		tl.Tasks[1].Message != "boom" || tl.Tasks[1].Status != "error" {
		t.Errorf("task.list: %+v", tl.Tasks)
	}
	if tl := d.manage(ctx, incusGuestOf("vm1", "vm"), proto.ManageRequest{Op: proto.OpTaskList}); !tl.OK || len(tl.Tasks) != 0 {
		t.Errorf("task.list of vm1: %+v", tl.Tasks)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStop, Task: "incus:00000000-0000-4000-8000-000000000999"}); r.Code != proto.CodeNotFound {
		t.Errorf("stop unknown: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskStop, Task: r.Task.ID}); !r.OK {
		t.Errorf("task.stop: %+v", r)
	}
	f.setHold(nil)
}

func TestIncusLeasesProfilesVolumesImages(t *testing.T) {
	f, sock := newFakeIncus(t)
	d := &incusDriver{socket: sock}
	ctx := context.Background()

	// Leases with the instance that holds each address.
	r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpNetworkLeases, Network: "incusbr0"})
	if !r.OK || len(r.Leases) != 3 || r.Leases[1].GuestID != "web" || r.Leases[1].HWAddr != "10:66:6a:00:00:01" || r.Leases[2].GuestID != "" {
		t.Errorf("leases: %+v", r.Leases)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpNetworkLeases, Network: "nope"}); r.Code != proto.CodeNotFound {
		t.Errorf("leases of no network: %+v", r)
	}

	// Profiles.
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileGet, Profile: "default"})
	if !r.OK || r.Profile.Digest != "profile-default-0" || strings.Join(r.Profile.UsedBy, ",") != "ct1,lab/db,vm1,web" || len(r.Profile.Restricted) != 0 {
		t.Errorf("profile.get: %+v", r.Profile)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileGet, Profile: "gpu"}); !r.OK || strings.Join(r.Profile.Restricted, ",") != "device.gpu0" {
		t.Errorf("gpu profile: %+v", r.Profile)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileCreate, Name: "default"}); r.Code != proto.CodeExists {
		t.Errorf("create taken: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileCreate, Name: "gpu2", CopyFrom: "gpu"}); !r.OK {
		t.Errorf("copy: %+v", r)
	}
	f.mu.Lock()
	if f.profiles["gpu2"].Devices["gpu0"]["gputype"] != "physical" {
		t.Errorf("copied profile: %+v", f.profiles["gpu2"])
	}
	f.mu.Unlock()
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileCreate, Name: "small", Description: "Small"}); !r.OK {
		t.Errorf("create: %+v", r)
	}
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileUpdate, Profile: "small", Digest: "profile-small-0",
		Set: map[string]string{"limits.memory": "1GiB", "security.nesting": "true"}, Description: "Small ones",
		Devices: map[string]map[string]string{"eth0": {"type": "nic", "network": "incusbr0"}}})
	if !r.OK || len(r.Changes) != 4 {
		t.Fatalf("profile.update: %+v", r)
	}
	f.mu.Lock()
	small := f.profiles["small"]
	f.mu.Unlock()
	if small.Config["limits.memory"] != "1GiB" || small.Description != "Small ones" || small.Devices["eth0"]["network"] != "incusbr0" {
		t.Errorf("small: %+v", small)
	}
	for _, req := range []proto.ManageRequest{
		{Op: proto.OpProfileUpdate, Profile: "small", Digest: "profile-small-0", Set: map[string]string{"limits.cpu": "2"}}, // stale
		{Op: proto.OpProfileUpdate, Profile: "small", Set: map[string]string{"raw.lxc": "x"}},
		{Op: proto.OpProfileUpdate, Profile: "gpu", Devices: map[string]map[string]string{"gpu0": nil}},
		{Op: proto.OpProfileUpdate, Profile: "small", Devices: map[string]map[string]string{"host": {"type": "disk", "source": "/srv", "path": "/srv"}}},
	} {
		if r := d.manage(ctx, nil, req); r.OK {
			t.Errorf("%+v accepted", req)
		}
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "default"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("delete default: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "big"}); r.Code != proto.CodeInUse {
		t.Errorf("delete used: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "small"}); !r.OK {
		t.Errorf("delete: %+v", r)
	}

	// Volumes.
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "cache", Size: "+1G"}); r.FieldErrors["size"] == "" {
		t.Errorf("relative create size: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "nope", Name: "cache", Size: "10GiB"}); r.Code != proto.CodeNotFound {
		t.Errorf("create on no pool: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "cache", Size: "10GiB", ContentType: "iso"}); r.FieldErrors["content_type"] == "" {
		t.Errorf("iso volume: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "cache", Size: "10GiB", Project: "lab", ContentType: "block"}); !r.OK {
		t.Fatalf("volume.create: %+v", r)
	}
	f.mu.Lock()
	v := f.vols[volKey("lab", "default", "cache")]
	f.mu.Unlock()
	if v == nil || v.Config["size"] != "10GiB" || v.ContentType != "block" {
		t.Errorf("volume: %+v", v)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "cache", Size: "10GiB", Project: "lab"}); r.Code != proto.CodeExists {
		t.Errorf("create taken: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeResize, Pool: "default", Volume: "cache", Size: "5GiB", Project: "lab"}); r.FieldErrors["size"] == "" {
		t.Errorf("shrink: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeResize, Pool: "default", Volume: "cache", Size: "+2G", Project: "lab"}); !r.OK ||
		r.Changes[0] != (proto.ConfigChange{Key: "size", Old: "10GiB", New: "12GiB"}) {
		t.Errorf("grow: %+v", r)
	}
	f.mu.Lock()
	v.UsedBy = []string{"/1.0/instances/db?project=lab"}
	f.mu.Unlock()
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "default", Volume: "cache", Project: "lab"}); r.Code != proto.CodeInUse {
		t.Errorf("delete attached: %+v", r)
	}
	f.mu.Lock()
	v.UsedBy = nil
	f.mu.Unlock()
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "default", Volume: "cache", Project: "lab"}); !r.OK {
		t.Errorf("volume.delete: %+v", r)
	}

	// Images: download (an alias that is taken locally stays off the new
	// image), refresh and delete by fingerprint prefix.
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDownload, Alias: "debian/13", ImageType: "kvm"}); r.FieldErrors["type"] == "" {
		t.Errorf("bad type: %+v", r)
	}
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDownload, Alias: "images:debian/13", ImageType: "virtual-machine"})
	if !r.OK || r.Task == nil {
		t.Fatalf("download: %+v", r)
	}
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	dl := f.images[len(f.images)-1]
	post := f.posts[len(f.posts)-1].Name
	f.mu.Unlock()
	if len(dl.Aliases) != 0 || dl.Type != "virtual-machine" || !dl.AutoUpdate || post != "image:image::debian/13" {
		t.Errorf("downloaded: %+v %s", dl, post)
	}
	r = d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDownload, Alias: "alpine/3.22", ImageType: "container", AutoUpdate: new(bool)})
	f.waitOp(strings.TrimPrefix(r.Task.ID, "incus:"))
	f.mu.Lock()
	dl = f.images[len(f.images)-1]
	f.mu.Unlock()
	if dl.Aliases[0].Name != "alpine/3.22" || dl.AutoUpdate {
		t.Errorf("alpine: %+v", dl)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageRefresh, Fingerprint: dl.Fingerprint[:12]}); !r.OK {
		t.Errorf("refresh: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDelete, Fingerprint: "0000000000ab"}); r.Code != proto.CodeNotFound {
		t.Errorf("delete unknown: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDelete, Fingerprint: "../etc"}); r.FieldErrors["fingerprint"] == "" {
		t.Errorf("delete bad: %+v", r)
	}
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDelete, Fingerprint: dl.Fingerprint}); !r.OK {
		t.Errorf("delete: %+v", r)
	}
}
