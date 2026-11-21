package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated Incus management (docs/MANAGE.md 2.5): basalt answers the
// Incus operations from an in-memory state (configurations with digests,
// devices and profiles, create, copy, rename, move, publish, delete,
// backups with restore as a new instance, tasks, the instance log,
// network leases, profiles, custom volumes and images) and runs long
// operations as tasks "incus:<uuid>". Changes show in the next report.

const incusNode = "basalt"

// incusSim is basalt's Incus state.
type incusSim struct {
	mu       sync.Mutex
	configs  map[string]*incusSimConfig // guest id -> configuration
	backups  map[string][]proto.BackupVolume
	tasks    map[string]*simTask
	newIDs   map[string]string // task -> what it made (an image fingerprint)
	profiles map[string]*proto.IncusProfile
}

type incusSimConfig struct {
	values   map[string]string
	profiles []string
	version  int
}

func (c *incusSimConfig) digest() string {
	sum := sha256.Sum256([]byte(fmt.Sprint(c.version, c.values, c.profiles)))
	return hex.EncodeToString(sum[:8])
}

var incState = &incusSim{configs: map[string]*incusSimConfig{}, backups: map[string][]proto.BackupVolume{}, tasks: map[string]*simTask{},
	newIDs: map[string]string{}, profiles: map[string]*proto.IncusProfile{
		"default": {Name: "default", Project: "default", Description: "Default Incus profile", Config: map[string]string{},
			Devices: map[string]map[string]string{"eth0": {"type": "nic", "network": "incusbr0", "name": "eth0"},
				"root": {"type": "disk", "path": "/", "pool": "default"}}},
		"big": {Name: "big", Project: "default", Description: "8 CPUs, 16 GiB", Config: map[string]string{"limits.cpu": "8", "limits.memory": "16GiB"},
			Devices: map[string]map[string]string{}},
		"gpu": {Name: "gpu", Project: "default", Description: "The NVIDIA card", Config: map[string]string{},
			Devices: map[string]map[string]string{"gpu0": {"type": "gpu", "gputype": "physical"}}, Restricted: []string{"device.gpu0"}},
	}}

var (
	simIncusName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,62}$`)
	simIncusID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

func simUUID() string {
	return fmt.Sprintf("%08x-%04x-4%03x-8%03x-%012x", rand.Uint32(), rand.N(1<<16), rand.N(1<<12), rand.N(1<<12), rand.Uint64()&(1<<48-1))
}

// startTask runs an Incus operation for dur, then onDone.
func (s *incusSim) startTask(typ, guest string, dur time.Duration, lines []string, onDone func()) *simTask {
	t := &simTask{id: "incus:" + simUUID(), typ: typ, guest: guest, started: time.Now(), dur: dur, lines: lines}
	s.tasks[t.id] = t
	time.AfterFunc(dur, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if t.stopped == nil && onDone != nil {
			onDone()
		}
	})
	return t
}

func (s *incusSim) config(g *fakefleet.GuestSpec) *incusSimConfig {
	if c := s.configs[g.ID]; c != nil {
		return c
	}
	c := &incusSimConfig{profiles: []string{"default"}, values: map[string]string{
		"limits.cpu": fmt.Sprint(max(g.VCPU, 1)), "boot.autostart": "true",
		"device.eth0": "type=nic,name=eth0,network=incusbr0", "device.root": "type=disk,path=/,pool=default"}}
	if g.MemLimMB > 0 {
		c.values["limits.memory"] = fmt.Sprintf("%dMiB", g.MemLimMB)
	}
	if !g.NoSchedule {
		c.values["snapshots.schedule"] = "@daily"
	}
	if g.ID == "git-mirror" {
		c.values["device.git"] = "type=disk,path=/srv/git,pool=default,source=git-data"
	}
	if g.ID == "dev-shell" {
		c.values["raw.lxc"] = "lxc.mount.auto=proc:rw"
	}
	s.configs[g.ID] = c
	return c
}

// incusManage answers an Incus request of basalt.
func (a *simAgent) incusManage(req proto.ManageRequest) proto.ManageResponse {
	if simLatency > 0 {
		time.Sleep(simLatency + rand.N(2*simLatency))
	}
	var g *fakefleet.GuestSpec
	if req.GuestID != "" {
		spec, ok := a.host.FindGuest(proto.PlatformIncus, req.GuestID)
		if !ok {
			return fail("unknown_guest", "No such guest on this host.")
		}
		g = &spec
	}
	s := incState
	s.mu.Lock()
	defer s.mu.Unlock()
	resp := a.incusOp(s, g, req)
	if resp.OK && !strings.HasSuffix(req.Op, ".get") && !strings.HasSuffix(req.Op, ".list") && req.Op != proto.OpChoices &&
		req.Op != proto.OpTaskStatus && req.Op != proto.OpNetworkLeases {
		select {
		case a.early <- struct{}{}:
		default:
		}
	}
	return resp
}

func (a *simAgent) incusOp(s *incusSim, g *fakefleet.GuestSpec, req proto.ManageRequest) proto.ManageResponse {
	needGuest := []string{proto.OpConfigGet, proto.OpConfigSet, proto.OpDiskResize, proto.OpClone, proto.OpDelete, proto.OpRename,
		proto.OpMove, proto.OpPublish, proto.OpLogGet, proto.OpBackupList, proto.OpBackupCreate}
	if g == nil && slices.Contains(needGuest, req.Op) {
		return fail("invalid_request", "this operation needs a guest")
	}
	h := a.host
	running := g != nil && g.State != proto.StateStopped
	switch req.Op {
	case proto.OpConfigGet:
		return proto.ManageResponse{OK: true, Config: incusConfigOf(g, s.config(g))}
	case proto.OpConfigSet:
		return a.incusConfigSet(s, g, req)
	case proto.OpDiskResize:
		c := s.config(g)
		if req.Disk != "root" {
			return invalid("disk", "only the root disk can be resized here")
		}
		old := c.values["device.root"]
		c.values["device.root"] = "type=disk,path=/,pool=default,size=" + strings.TrimPrefix(req.Size, "+") + "iB"
		c.version++
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "device.root", Old: old, New: c.values["device.root"]}}}
	case proto.OpChoices:
		return proto.ManageResponse{OK: true, Choices: a.incusChoices(s, req.Project)}
	case proto.OpCreate:
		if !simIncusName.MatchString(req.Name) {
			return invalid("name", "1 to 63 letters, digits and '-'")
		}
		id := incusSimID(req.Project, req.Name)
		if _, ok := h.FindGuest(proto.PlatformIncus, id); ok {
			return fail(proto.CodeExists, "an instance named "+req.Name+" exists")
		}
		kind, image := req.Kind, strings.TrimPrefix(strings.TrimPrefix(req.Image, "images:"), "local:")
		t := s.startTask("Creating instance", id, 6*time.Second, []string{"Retrieving image: 30%", "Retrieving image: 100%", "Creating the instance"}, func() {
			spec := fakefleet.GuestSpec{Platform: proto.PlatformIncus, ID: id, Name: req.Name, Kind: kind, Image: image, State: proto.StateStopped, VCPU: 2,
				MemLimMB: 2048, Snapshots: ptrInt(0)}
			if kind == "vm" {
				spec.Protocols, spec.Default, spec.MemCfgGiB = []string{proto.ProtoSPICE, proto.ProtoSerial}, proto.ProtoSPICE, 2
			} else {
				spec.Protocols, spec.Default = []string{proto.ProtoShell, proto.ProtoTTY}, proto.ProtoShell
			}
			if req.Start {
				spec.State, spec.Started = proto.StateRunning, ptrTime(time.Now())
			}
			h.AddGuest(spec)
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: id}
	case proto.OpClone:
		if !simIncusName.MatchString(req.Name) {
			return invalid("name", "1 to 63 letters, digits and '-'")
		}
		project := req.Project
		if project == "" {
			project, _, _ = strings.Cut(g.ID, "/")
			if !strings.Contains(g.ID, "/") {
				project = ""
			}
		}
		id := incusSimID(project, req.Name)
		if _, ok := h.FindGuest(proto.PlatformIncus, id); ok {
			return fail(proto.CodeExists, "an instance named "+req.Name+" exists")
		}
		src := *g
		t := s.startTask("Creating instance", id, 5*time.Second, []string{"Copying the instance"}, func() {
			spec := src
			spec.ID, spec.Name, spec.State, spec.Started, spec.MAC, spec.Extra = id, req.Name, proto.StateStopped, nil, "", false
			h.AddGuest(spec)
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: id}
	case proto.OpDelete, proto.OpRename, proto.OpMove:
		if running {
			return fail(proto.CodeGuestRunning, "stop the guest first")
		}
		switch req.Op {
		case proto.OpDelete:
			t := s.startTask("Deleting instance", g.ID, 2*time.Second, []string{"Deleting the instance"}, func() { h.RemoveGuest(proto.PlatformIncus, g.ID) })
			return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
		case proto.OpRename:
			if !simIncusName.MatchString(req.Name) {
				return invalid("name", "1 to 63 letters, digits and '-', starting with a letter")
			}
			project, _, _ := strings.Cut(g.ID, "/")
			if !strings.Contains(g.ID, "/") {
				project = ""
			}
			id := incusSimID(project, req.Name)
			if _, ok := h.FindGuest(proto.PlatformIncus, id); ok {
				return fail(proto.CodeExists, "an instance named "+req.Name+" exists")
			}
			h.UpdateGuest(proto.PlatformIncus, g.ID, func(sp *fakefleet.GuestSpec) { sp.ID, sp.Name = id, req.Name })
			if c := s.configs[g.ID]; c != nil {
				s.configs[id] = c
				delete(s.configs, g.ID)
			}
			return proto.ManageResponse{OK: true, NewID: id}
		default:
			_, name, ok := strings.Cut(g.ID, "/")
			if !ok {
				name = g.ID
			}
			id := g.ID
			if req.Project != "" {
				id = incusSimID(req.Project, name)
			}
			t := s.startTask("Moving instance", id, 5*time.Second, []string{"Copying the instance", "Deleting the original"}, func() {
				h.UpdateGuest(proto.PlatformIncus, g.ID, func(sp *fakefleet.GuestSpec) { sp.ID = id })
			})
			return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: id}
		}
	case proto.OpPublish:
		if req.Snapshot == "" && running {
			return fail(proto.CodeGuestRunning, "stop the guest, or make the image from a snapshot")
		}
		fp := hex.EncodeToString(func() []byte { b := sha256.Sum256([]byte(g.ID + time.Now().String())); return b[:] }())
		var t *simTask
		t = s.startTask("Creating image", g.ID, 6*time.Second, []string{"Exporting: 40%", "Exporting: 100%", "Compressing"}, func() {
			s.newIDs[t.id] = fp
			now := time.Now().UTC()
			im := proto.IncusImageInfo{Fingerprint: fp, Description: req.Description, Type: map[string]string{"vm": "virtual-machine"}[g.Kind],
				Architecture: "x86_64", SizeBytes: 380 << 20, UploadedAt: &now, Project: "default"}
			if im.Type == "" {
				im.Type = "container"
			}
			if req.Alias != "" {
				im.Aliases = []string{req.Alias}
			}
			h.UpdateIncus(func(d *proto.IncusDetail) { d.Images = append(d.Images, im) })
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpLogGet:
		file := "lxc.log"
		if g.Kind == "vm" {
			file = "qemu.log"
		}
		lines := []string{"lxc " + g.ID + " 20261017081500.123 INFO     start - ../src/lxc/start.c:lxc_start:2200 - Started \"/sbin/init\"",
			"lxc " + g.ID + " 20261017081500.456 WARN     cgfsng - ../src/lxc/cgroups/cgfsng.c - No such file or directory"}
		if g.Kind == "vm" {
			lines = []string{"qemu-system-x86_64: warning: host doesn't support requested feature: CPUID.80000001H:ECX.svm [bit 2]"}
		}
		return proto.ManageResponse{OK: true, Log: &proto.GuestLog{File: file, Lines: lines}}
	case proto.OpBackupList:
		return proto.ManageResponse{OK: true, Backups: s.backupsOf(g)}
	case proto.OpBackupCreate:
		name := req.Name
		if name == "" {
			name = "whombat-" + time.Now().UTC().Format("20060102-1504")
		}
		for _, b := range s.backupsOf(g) {
			if b.Volume == name {
				return fail(proto.CodeExists, "the guest has a backup named "+name)
			}
		}
		exp := time.Now().Add(7 * 24 * time.Hour).UTC()
		if req.ExpiresAt != nil {
			exp = req.ExpiresAt.UTC()
		}
		gid := g.ID
		t := s.startTask("Backing up instance", gid, 8*time.Second, []string{"Backing up: 25%", "Backing up: 80%", "Compressing"}, func() {
			s.backups[gid] = append([]proto.BackupVolume{{Volume: name, Storage: "incus", GuestID: gid, Kind: g.Kind, SizeBytes: 1200 << 20,
				Created: time.Now().UTC(), Format: "tar", Notes: "expires " + exp.Format(time.RFC3339), ExpiresAt: &exp}}, s.backups[gid]...)
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpBackupDelete:
		if g == nil {
			return invalid("guest", "name the guest whose backup this is")
		}
		bs := s.backupsOf(g)
		i := slices.IndexFunc(bs, func(b proto.BackupVolume) bool { return b.Volume == req.Volume })
		if i < 0 {
			return fail(proto.CodeNotFound, "the guest has no backup "+req.Volume)
		}
		s.backups[g.ID] = slices.Delete(bs, i, i+1)
		return proto.ManageResponse{OK: true}
	case proto.OpBackupRestore:
		if g == nil {
			return invalid("guest", "name the guest whose backup to restore")
		}
		if !slices.ContainsFunc(s.backupsOf(g), func(b proto.BackupVolume) bool { return b.Volume == req.Volume }) {
			return fail(proto.CodeNotFound, "the guest has no backup "+req.Volume)
		}
		name := req.Name
		if name == "" {
			_, n, ok := strings.Cut(g.ID, "/")
			if !ok {
				n = g.ID
			}
			name = n + "-restored"
		}
		project, _, _ := strings.Cut(g.ID, "/")
		if !strings.Contains(g.ID, "/") {
			project = ""
		}
		id := incusSimID(project, name)
		if _, ok := h.FindGuest(proto.PlatformIncus, id); ok {
			return fail(proto.CodeExists, "an instance named "+name+" exists")
		}
		src := *g
		t := s.startTask("Restoring a backup", id, 8*time.Second, []string{"Copying the backup: 30%", "Copying the backup: 100%", "Unpacking the backup"}, func() {
			spec := src
			spec.ID, spec.Name, spec.State, spec.Started, spec.MAC, spec.Extra = id, name, proto.StateStopped, nil, "", false
			if req.Start {
				spec.State, spec.Started = proto.StateRunning, ptrTime(time.Now())
			}
			h.AddGuest(spec)
		})
		s.newIDs[t.id] = id
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: id}
	case proto.OpTaskList:
		var out []proto.TaskStatus
		for _, t := range s.tasks {
			if g == nil || t.guest == g.ID {
				out = append(out, s.taskStatus(t, -1))
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
		return proto.ManageResponse{OK: true, Tasks: out}
	case proto.OpTaskStatus, proto.OpTaskStop:
		t := s.tasks[req.Task]
		if t == nil {
			return fail(proto.CodeNotFound, "Incus has no operation "+req.Task)
		}
		if req.Op == proto.OpTaskStop {
			if t.stopped == nil && time.Now().Before(t.started.Add(t.dur)) {
				now := time.Now()
				t.stopped = &now
			}
			return proto.ManageResponse{OK: true}
		}
		st := s.taskStatus(t, req.LogStart)
		return proto.ManageResponse{OK: true, TaskStatus: &st}
	case proto.OpNetworkLeases:
		if req.Network != "incusbr0" {
			return fail(proto.CodeNotFound, "Network not found")
		}
		out := []proto.IncusLease{{Hostname: "incusbr0.gw", Address: "10.62.52.1", Type: "gateway"}}
		for i, sp := range h.GuestSpecs(proto.PlatformIncus) {
			if sp.State == proto.StateStopped || sp.Extra {
				continue
			}
			mac := fmt.Sprintf("10:66:6a:%02x:%02x:%02x", 0x10, 0, i+1)
			out = append(out, proto.IncusLease{Hostname: sp.ID, Address: fmt.Sprintf("10.62.52.%d", 20+i), HWAddr: mac, Type: "dynamic", GuestID: sp.ID})
		}
		return proto.ManageResponse{OK: true, Leases: out}
	case proto.OpProfileGet, proto.OpProfileCreate, proto.OpProfileUpdate, proto.OpProfileDelete:
		return a.incusProfiles(s, req)
	case proto.OpVolumeCreate, proto.OpVolumeResize, proto.OpVolumeDelete:
		return a.incusVolumes(req)
	case proto.OpImageDownload:
		alias := strings.TrimPrefix(req.Alias, "images:")
		var t *simTask
		fp := hex.EncodeToString(func() []byte { b := sha256.Sum256([]byte(alias + req.ImageType + time.Now().String())); return b[:] }())
		t = s.startTask("Downloading image", "", 7*time.Second, []string{"rootfs: 20% (31.2MB/s)", "rootfs: 75% (33.0MB/s)", "Unpacking"}, func() {
			s.newIDs[t.id] = fp
			now := time.Now().UTC()
			im := proto.IncusImageInfo{Fingerprint: fp, Description: alias, Type: req.ImageType, Architecture: "x86_64", SizeBytes: 150 << 20,
				UploadedAt: &now, AutoUpdate: req.AutoUpdate == nil || *req.AutoUpdate, Cached: false, Project: "default"}
			h.UpdateIncus(func(d *proto.IncusDetail) {
				taken := false
				for _, x := range d.Images {
					taken = taken || slices.Contains(x.Aliases, alias)
				}
				if !taken {
					im.Aliases = []string{alias}
				}
				d.Images = append(d.Images, im)
			})
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpImageRefresh, proto.OpImageDelete:
		view := h.IncusView()
		i := slices.IndexFunc(view.Images, func(im proto.IncusImageInfo) bool {
			return strings.HasPrefix(im.Fingerprint, strings.ToLower(req.Fingerprint))
		})
		if i < 0 {
			return fail(proto.CodeNotFound, "the image store has no image "+req.Fingerprint)
		}
		fp := view.Images[i].Fingerprint
		if req.Op == proto.OpImageRefresh {
			t := s.startTask("Refreshing image", "", 3*time.Second, []string{"Checking for a newer image"}, nil)
			return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
		}
		h.UpdateIncus(func(d *proto.IncusDetail) {
			d.Images = slices.DeleteFunc(d.Images, func(im proto.IncusImageInfo) bool { return im.Fingerprint == fp })
		})
		return proto.ManageResponse{OK: true}
	}
	return fail("unsupported", "Incus guests cannot do this through Whombat")
}

func ptrInt(n int) *int { return &n }

func incusSimID(project, name string) string {
	if project != "" && project != "default" {
		return project + "/" + name
	}
	return name
}

func (s *incusSim) taskStatus(t *simTask, start int) proto.TaskStatus {
	st := t.status(start)
	st.User = ""
	if st.Status == "running" {
		st.Cancellable = true
	}
	if st.Status == "ok" {
		st.NewID = s.newIDs[t.id]
	}
	return st
}

func (s *incusSim) backupsOf(g *fakefleet.GuestSpec) []proto.BackupVolume {
	if _, ok := s.backups[g.ID]; !ok && g.IncusBackup != nil {
		exp := g.IncusBackup.Add(7 * 24 * time.Hour)
		s.backups[g.ID] = []proto.BackupVolume{{Volume: "whombat-" + g.IncusBackup.Format("20060102-1504"), Storage: "incus", GuestID: g.ID,
			Kind: g.Kind, SizeBytes: 4300 << 20, Created: *g.IncusBackup, Format: "tar", Notes: "expires " + exp.Format(time.RFC3339), ExpiresAt: &exp}}
	}
	return append([]proto.BackupVolume{}, s.backups[g.ID]...)
}

// incusConfigOf is config.get's answer.
func incusConfigOf(g *fakefleet.GuestSpec, c *incusSimConfig) *proto.GuestConfig {
	cfg := &proto.GuestConfig{Platform: proto.PlatformIncus, Kind: g.Kind, Digest: c.digest(), Running: g.State != proto.StateStopped,
		Values: maps.Clone(c.values), Profiles: slices.Clone(c.profiles), Inherited: []string{"device.eth0", "device.root"}}
	for k := range c.values {
		if strings.HasPrefix(k, "raw.") {
			cfg.Restricted = append(cfg.Restricted, k)
		}
	}
	for _, k := range slices.Sorted(maps.Keys(c.values)) {
		if !strings.HasPrefix(k, "device.") || !strings.Contains(c.values[k], "type=disk") {
			continue
		}
		d := proto.GuestDisk{Key: strings.TrimPrefix(k, "device."), Storage: "default", Media: "disk"}
		for _, item := range strings.Split(c.values[k], ",") {
			kk, v, _ := strings.Cut(item, "=")
			switch kk {
			case "path":
				d.Path, d.Boot = v, v == "/"
			case "source":
				d.Volume = v
			case "pool":
				d.Storage = v
			}
		}
		if d.Path == "/" {
			d.SizeBytes = 10 << 30
		}
		cfg.Disks = append(cfg.Disks, d)
	}
	return cfg
}

func (a *simAgent) incusConfigSet(s *incusSim, g *fakefleet.GuestSpec, req proto.ManageRequest) proto.ManageResponse {
	c := s.config(g)
	if req.Digest != "" && req.Digest != c.digest() {
		return fail(proto.CodeDigestMismatch, "the configuration changed since it was read")
	}
	set := maps.Clone(req.Set)
	if set == nil {
		set = map[string]string{}
	}
	del := slices.Clone(req.Delete)
	for name, dev := range req.Devices {
		if dev == nil {
			del = append(del, "device."+name)
			continue
		}
		var parts []string
		for _, k := range slices.Sorted(maps.Keys(dev)) {
			parts = append(parts, k+"="+dev[k])
		}
		set["device."+name] = strings.Join(parts, ",")
	}
	var changes []proto.ConfigChange
	for _, k := range slices.Sorted(maps.Keys(set)) {
		if strings.HasPrefix(k, "raw.") || k == "security.privileged" {
			return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: k + ": this key is not changed through Whombat", FieldErrors: map[string]string{k: "not changed through Whombat"}}
		}
		if set[k] != c.values[k] {
			changes = append(changes, proto.ConfigChange{Key: k, Old: c.values[k], New: set[k]})
			c.values[k] = set[k]
		}
	}
	for _, k := range del {
		if old, ok := c.values[k]; ok {
			changes = append(changes, proto.ConfigChange{Key: k, Old: old})
			delete(c.values, k)
		}
	}
	if len(req.Profiles) > 0 && !slices.Equal(req.Profiles, c.profiles) {
		for _, p := range req.Profiles {
			if s.profiles[p] == nil {
				return invalid("profiles", "there is no profile "+p)
			}
		}
		changes = append(changes, proto.ConfigChange{Key: "profiles", Old: strings.Join(c.profiles, ", "), New: strings.Join(req.Profiles, ", ")})
		c.profiles = slices.Clone(req.Profiles)
	}
	if len(changes) > 0 {
		c.version++
		_, sched := c.values["snapshots.schedule"]
		a.host.UpdateGuest(proto.PlatformIncus, g.ID, func(sp *fakefleet.GuestSpec) {
			sp.NoSchedule = !sched
			var n int
			if _, err := fmt.Sscan(c.values["limits.cpu"], &n); err == nil && n > 0 {
				sp.VCPU = n
			}
		})
	}
	return proto.ManageResponse{OK: true, Changes: changes}
}

func (a *simAgent) incusChoices(s *incusSim, project string) *proto.Choices {
	view := a.host.IncusView()
	out := &proto.Choices{Platform: proto.PlatformIncus, Storages: []proto.ChoiceStorage{}, Bridges: []string{}, Project: "default",
		RemoteImages: []proto.RemoteImage{{Alias: "debian/13", Description: "Debian 13 (trixie)", Type: "container"},
			{Alias: "debian/13/cloud", Description: "Debian 13 (trixie) with cloud-init", Type: "virtual-machine"},
			{Alias: "ubuntu/24.04", Description: "Ubuntu 24.04 LTS (noble)", Type: "container"},
			{Alias: "alpine/3.22", Description: "Alpine 3.22", Type: "container"},
			{Alias: "nixos/25.05", Description: "NixOS 25.05", Type: "virtual-machine"}}}
	if project != "" {
		out.Project = project
	}
	for _, p := range view.Projects {
		out.Projects = append(out.Projects, p.Name)
	}
	for _, p := range view.Pools {
		cs := proto.ChoiceStorage{ID: p.Name, Type: p.Driver, Content: []string{"images", "rootdir"}, Thin: true}
		if p.TotalBytes != nil && p.UsedBytes != nil {
			cs.TotalBytes, cs.AvailBytes = *p.TotalBytes, *p.TotalBytes-*p.UsedBytes
		}
		out.Storages = append(out.Storages, cs)
	}
	for _, n := range view.Networks {
		out.Bridges = append(out.Bridges, n.Name)
	}
	out.Profiles = slices.Sorted(maps.Keys(s.profiles))
	for _, im := range view.Images {
		out.Images = append(out.Images, proto.IncusImage{Fingerprint: im.Fingerprint, Aliases: im.Aliases, Description: im.Description,
			Type: im.Type, SizeBytes: im.SizeBytes})
	}
	return out
}

func (a *simAgent) incusProfiles(s *incusSim, req proto.ManageRequest) proto.ManageResponse {
	usedBy := func(name string) []string {
		var out []string
		for _, sp := range a.host.GuestSpecs(proto.PlatformIncus) {
			profs := []string{"default"}
			if c := s.configs[sp.ID]; c != nil {
				profs = c.profiles
			}
			if slices.Contains(profs, name) {
				out = append(out, sp.ID)
			}
		}
		return out
	}
	sync := func() {
		var list []proto.IncusProfileInfo // counted before taking the host's lock
		for _, n := range slices.Sorted(maps.Keys(s.profiles)) {
			list = append(list, proto.IncusProfileInfo{Name: n, Project: "default", Description: s.profiles[n].Description, UsedBy: len(usedBy(n))})
		}
		a.host.UpdateIncus(func(d *proto.IncusDetail) { d.Profiles = list })
	}
	name := req.Profile
	if req.Op == proto.OpProfileCreate {
		name = req.Name
	}
	p := s.profiles[name]
	switch req.Op {
	case proto.OpProfileGet:
		if p == nil {
			return fail(proto.CodeNotFound, "Profile not found")
		}
		out := *p
		out.UsedBy = usedBy(name)
		out.Digest = fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint(p.Config, p.Devices, p.Description))))[:16]
		return proto.ManageResponse{OK: true, Profile: &out}
	case proto.OpProfileCreate:
		if !simIncusID.MatchString(name) {
			return invalid("name", "letters, digits, '.', '_' and '-'")
		}
		if p != nil {
			return fail(proto.CodeExists, "a profile named "+name+" exists")
		}
		np := &proto.IncusProfile{Name: name, Project: "default", Description: req.Description, Config: map[string]string{}, Devices: map[string]map[string]string{}}
		if src := s.profiles[req.CopyFrom]; src != nil {
			np.Config, np.Devices, np.Restricted = maps.Clone(src.Config), maps.Clone(src.Devices), slices.Clone(src.Restricted)
		}
		s.profiles[name] = np
		sync()
		return proto.ManageResponse{OK: true}
	case proto.OpProfileUpdate:
		if p == nil {
			return fail(proto.CodeNotFound, "Profile not found")
		}
		var changes []proto.ConfigChange
		for _, k := range slices.Sorted(maps.Keys(req.Set)) {
			if strings.HasPrefix(k, "raw.") {
				return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: k + ": not changed through Whombat"}
			}
			changes = append(changes, proto.ConfigChange{Key: k, Old: p.Config[k], New: req.Set[k]})
			p.Config[k] = req.Set[k]
		}
		for _, k := range req.Delete {
			changes = append(changes, proto.ConfigChange{Key: k, Old: p.Config[k]})
			delete(p.Config, k)
		}
		for n, dev := range req.Devices {
			if slices.Contains(p.Restricted, "device."+n) {
				return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "device." + n + ": not changed through Whombat"}
			}
			changes = append(changes, proto.ConfigChange{Key: "device." + n, New: fmt.Sprint(dev)})
			if dev == nil {
				delete(p.Devices, n)
			} else {
				p.Devices[n] = dev
			}
		}
		if req.Description != "" && req.Description != p.Description {
			changes = append(changes, proto.ConfigChange{Key: "description", Old: p.Description, New: req.Description})
			p.Description = req.Description
		}
		sync()
		return proto.ManageResponse{OK: true, Changes: changes}
	default:
		switch {
		case p == nil:
			return fail(proto.CodeNotFound, "Profile not found")
		case name == "default":
			return fail(proto.CodeNotAllowed, "the default profile cannot be deleted")
		case len(usedBy(name)) > 0:
			return fail(proto.CodeInUse, "the profile is still used")
		}
		delete(s.profiles, name)
		sync()
		return proto.ManageResponse{OK: true}
	}
}

func (a *simAgent) incusVolumes(req proto.ManageRequest) proto.ManageResponse {
	view := a.host.IncusView()
	if !slices.ContainsFunc(view.Pools, func(p proto.IncusPool) bool { return p.Name == req.Pool }) {
		return invalid("pool", "there is no storage pool "+req.Pool)
	}
	project := req.Project
	if project == "" {
		project = "default"
	}
	name := req.Volume
	if req.Op == proto.OpVolumeCreate {
		name = req.Name
	}
	i := slices.IndexFunc(view.Volumes, func(v proto.IncusVolume) bool { return v.Pool == req.Pool && v.Name == name && v.Project == project })
	size := func(s string) (uint64, bool) {
		var n float64
		var unit string
		if _, err := fmt.Sscanf(strings.TrimPrefix(s, "+"), "%f%s", &n, &unit); err != nil || n <= 0 {
			return 0, false
		}
		m := map[string]float64{"GiB": 1 << 30, "G": 1 << 30, "GB": 1e9, "MiB": 1 << 20, "M": 1 << 20, "TiB": 1 << 40, "T": 1 << 40}[unit]
		return uint64(n * m), m > 0
	}
	switch req.Op {
	case proto.OpVolumeCreate:
		if !simIncusID.MatchString(name) {
			return invalid("name", "letters, digits, '.', '_' and '-'")
		}
		if i >= 0 {
			return fail(proto.CodeExists, "pool "+req.Pool+" has a volume named "+name)
		}
		n, ok := size(req.Size)
		if !ok || strings.HasPrefix(req.Size, "+") {
			return invalid("size", "give the size, such as 20GiB")
		}
		ct := req.ContentType
		if ct == "" {
			ct = "filesystem"
		}
		a.host.UpdateIncus(func(d *proto.IncusDetail) {
			d.Volumes = append(d.Volumes, proto.IncusVolume{Pool: req.Pool, Name: name, Project: project, ContentType: ct, SizeBytes: &n, Description: req.Description})
			for j := range d.Pools {
				if d.Pools[j].Name == req.Pool {
					d.Pools[j].Volumes++
				}
			}
		})
		return proto.ManageResponse{OK: true}
	case proto.OpVolumeResize:
		if i < 0 {
			return fail(proto.CodeNotFound, "Storage volume not found")
		}
		n, ok := size(req.Size)
		cur := uint64(0)
		if view.Volumes[i].SizeBytes != nil {
			cur = *view.Volumes[i].SizeBytes
		}
		if strings.HasPrefix(req.Size, "+") {
			n += cur
		}
		if !ok || n < cur {
			return invalid("size", "volumes only grow")
		}
		a.host.UpdateIncus(func(d *proto.IncusDetail) { d.Volumes[i].SizeBytes = &n })
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "size", Old: fmt.Sprintf("%dGiB", cur>>30), New: fmt.Sprintf("%dGiB", n>>30)}}}
	default:
		if i < 0 {
			return fail(proto.CodeNotFound, "Storage volume not found")
		}
		if len(view.Volumes[i].UsedBy) > 0 {
			return fail(proto.CodeInUse, "the volume is attached to "+strings.Join(view.Volumes[i].UsedBy, ", ")+"; detach it first")
		}
		a.host.UpdateIncus(func(d *proto.IncusDetail) {
			d.Volumes = slices.Delete(d.Volumes, i, i+1)
			for j := range d.Pools {
				if d.Pools[j].Name == req.Pool {
					d.Pools[j].Volumes--
				}
			}
		})
		return proto.ManageResponse{OK: true}
	}
}
