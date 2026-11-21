package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"math/rand/v2"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated guest management (docs/MANAGE.md): the Proxmox node shale
// answers every manage operation from an in-memory state (configurations
// with digests and values that wait for a restart, disks, choices, create,
// clone, template and delete, backups, ISO images and templates, firewall,
// HA and replication) and runs long operations as tasks whose log grows
// with the clock. Changes show in the next report. Other hosts answer
// "unsupported". It follows web/dev/fixtures/manage.ts; backup jobs are
// in backupjobs.go.

const (
	simNode    = "shale"
	simTaskUsr = "whombat-manage@pve!agent-shale"
	masked     = "**********"
	gibF       = float64(1 << 30)
)

// simConfig is a guest's configuration.
type simConfig struct {
	kind          string
	values        map[string]string
	pending       map[string]string
	pendingDelete []string
}

func (c *simConfig) digest() string {
	b, _ := json.Marshal([]any{c.values, c.pending, c.pendingDelete})
	sum := sha1.Sum(b)
	return hex.EncodeToString(sum[:])
}

// simTask is a running or finished platform task.
type simTask struct {
	id, typ, guest string
	started        time.Time
	dur            time.Duration
	lines          []string
	err            string
	stopped        *time.Time
}

// simFirewall is a guest's firewall.
type simFirewall struct {
	options map[string]string
	rules   []proto.FirewallRule
}

// manageState is shale's state.
type manageState struct {
	mu        sync.Mutex
	configs   map[string]*simConfig // vmid -> configuration
	tasks     map[string]*simTask
	backups   map[string][]proto.BackupVolume // vmid -> backups (seeded on first use)
	content   []proto.StorageVolume           // ISO images, templates and import files
	firewalls map[string]*simFirewall
	repl      map[string][]proto.ReplicationJob
	jobs      []proto.BackupJob // backup jobs (seeded on first use, backupjobs.go)
}

// mgState is shale's state (the simulator runs one shale).
var mgState = newManageState()

func newManageState() *manageState {
	at := func(s string) time.Time { t, _ := time.Parse(time.RFC3339, s); return t }
	return &manageState{configs: map[string]*simConfig{}, tasks: map[string]*simTask{}, backups: map[string][]proto.BackupVolume{},
		firewalls: map[string]*simFirewall{}, repl: map[string][]proto.ReplicationJob{"103": {{ID: "103-0", Target: "schist", Schedule: "*/15"}}},
		content: []proto.StorageVolume{
			{Volume: "local:iso/debian-13.1.0-amd64-netinst.iso", Storage: "local", Content: "iso", Name: "debian-13.1.0-amd64-netinst.iso", SizeBytes: 754 << 20, Created: at("2026-09-21T08:12:00Z")},
			{Volume: "local:iso/ubuntu-24.04.3-live-server-amd64.iso", Storage: "local", Content: "iso", Name: "ubuntu-24.04.3-live-server-amd64.iso", SizeBytes: 3100 << 20, Created: at("2026-08-30T19:40:00Z")},
			{Volume: "local:iso/virtio-win-0.1.271.iso", Storage: "local", Content: "iso", Name: "virtio-win-0.1.271.iso", SizeBytes: 693 << 20, Created: at("2026-06-02T10:05:00Z")},
			{Volume: "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst", Storage: "local", Content: "vztmpl", Name: "debian-13-standard_13.1-1_amd64.tar.zst", SizeBytes: 124 << 20, Created: at("2026-09-10T07:00:00Z")},
			{Volume: "local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz", Storage: "local", Content: "vztmpl", Name: "alpine-3.22-default_20250617_amd64.tar.xz", SizeBytes: 3 << 20, Created: at("2026-07-01T07:00:00Z")},
		}}
}

// simLatency is the least time an answer takes (the API round trip).
var simLatency = 150 * time.Millisecond

var simStorages = []proto.ChoiceStorage{
	{ID: "local", Type: "dir", Content: []string{"iso", "vztmpl", "backup", "import", "snippets"}, AvailBytes: 53 << 30, TotalBytes: 94 << 30},
	{ID: "local-zfs", Type: "zfspool", Content: []string{"images", "rootdir"}, AvailBytes: 351 << 30, TotalBytes: 380 << 30, Thin: true},
	{ID: "vmdata", Type: "zfspool", Content: []string{"images", "rootdir"}, AvailBytes: 650 << 30, TotalBytes: 3840 << 30, Thin: true},
	{ID: "bulk", Type: "zfspool", Content: []string{"images", "rootdir"}, AvailBytes: 4610 << 30, TotalBytes: 7680 << 30, Thin: true},
	{ID: "pbs-01", Type: "pbs", Content: []string{"backup"}, AvailBytes: 4800 << 30, TotalBytes: 16000 << 30, Shared: true},
}

func storageOffers(id, content string) bool {
	for _, s := range simStorages {
		if s.ID == id {
			return slices.Contains(s.Content, content)
		}
	}
	return false
}

// manage answers a manage request.
func (a *simAgent) manage(req proto.ManageRequest) proto.ManageResponse {
	if !a.o.manage {
		return proto.ManageResponse{Code: "remote_control_disabled", Message: "Managing guests is disabled in agent.toml."}
	}
	if resp, ok := a.managePlace(req); ok {
		return resp // backup places (backupplace.go)
	}
	if resp, ok := a.managePackages(req); ok {
		return resp // operating-system updates on every host (packages.go)
	}
	if a.host.ID == incusNode && req.Platform == proto.PlatformIncus {
		return a.incusManage(req) // incus.go
	}
	if resp, ok := a.manageUnraid(req); ok {
		return resp // blackbox (unraid.go)
	}
	if resp, ok := a.manageLibvirt(req); ok {
		return resp // kvm-lab (libvirt.go)
	}
	if a.host.ID != simNode || req.Platform != proto.PlatformPVE {
		return proto.ManageResponse{Code: "unsupported", Message: "The simulator manages the Proxmox VE guests of shale, the Incus guests of basalt and the Unraid server blackbox only."}
	}
	if simLatency > 0 {
		time.Sleep(simLatency + rand.N(2*simLatency))
	}
	m := mgState
	var g *fakefleet.GuestSpec
	if req.GuestID != "" {
		spec, ok := a.host.FindGuest(proto.PlatformPVE, req.GuestID)
		if !ok {
			return proto.ManageResponse{Code: "unknown_guest", Message: "No such guest on this host."}
		}
		g = &spec
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	resp := a.manageOp(m, g, req)
	if resp.OK && req.Op != proto.OpConfigGet && !strings.HasSuffix(req.Op, ".list") && req.Op != proto.OpChoices &&
		req.Op != proto.OpTaskStatus && req.Op != proto.OpFirewallGet {
		select { // report the change soon
		case a.early <- struct{}{}:
		default:
		}
	}
	return resp
}

func fail(code, msg string) proto.ManageResponse {
	return proto.ManageResponse{Code: code, Message: msg}
}

func invalid(field, msg string) proto.ManageResponse {
	return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "Parameter verification failed.", FieldErrors: map[string]string{field: msg}}
}

// simGuestOps need a guest.
var simGuestOps = []string{proto.OpConfigGet, proto.OpConfigSet, proto.OpDiskResize, proto.OpDiskMove, proto.OpClone, proto.OpTemplate, proto.OpMigrate,
	proto.OpDelete, proto.OpBackupList, proto.OpBackupCreate, proto.OpFirewallGet, proto.OpFirewallOptions, proto.OpFirewallRuleAdd,
	proto.OpFirewallRuleUpdate, proto.OpFirewallRuleDelete, proto.OpHASet, proto.OpHARemove, proto.OpReplicationAdd, proto.OpReplicationDelete}

func (a *simAgent) manageOp(m *manageState, g *fakefleet.GuestSpec, req proto.ManageRequest) proto.ManageResponse {
	var c *simConfig
	if g != nil {
		c = m.config(g)
	} else if slices.Contains(simGuestOps, req.Op) {
		return fail("invalid_request", "this operation needs a guest")
	}
	running := g != nil && g.State != proto.StateStopped
	switch req.Op {
	case proto.OpConfigGet:
		return proto.ManageResponse{OK: true, Config: configOf(g, c, m.repl[g.ID])}
	case proto.OpConfigSet:
		return a.configSet(g, c, running, req)
	case proto.OpDiskResize:
		return a.diskResize(m, g, c, req)
	case proto.OpDiskMove:
		cur, ok := c.values[req.Disk]
		if !ok {
			return fail(proto.CodeNotFound, req.Disk+" does not exist.")
		}
		want := "images"
		if c.kind == "container" {
			want = "rootdir"
		}
		if !storageOffers(req.Storage, want) {
			return invalid("storage", req.Storage+" does not hold guest disks.")
		}
		file, rest, _ := strings.Cut(cur, ",")
		_, vol, _ := strings.Cut(file, ":")
		t := m.startTask(map[bool]string{true: "qmmove", false: "move_volume"}[c.kind == "vm"], g.ID, 6*time.Second, []string{
			"create full clone of drive " + req.Disk + " (" + file + ")", "transferred 8.0 GiB of 64.0 GiB (12.50%)",
			"transferred 32.0 GiB of 64.0 GiB (50.00%)", "transferred 64.0 GiB of 64.0 GiB (100.00%)"}, "", func() {
			c.values[req.Disk] = strings.TrimSuffix(req.Storage+":"+vol+","+rest, ",")
			if !req.DeleteSource {
				c.values[nextUnused(c)] = file
			}
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpChoices:
		return proto.ManageResponse{OK: true, Choices: a.choices(m)}
	case proto.OpCreate:
		return a.create(m, req)
	case proto.OpClone:
		return a.clone(m, g, c, req)
	case proto.OpTemplate:
		if running {
			return fail(proto.CodeGuestRunning, "the guest is running")
		}
		t := m.startTask("qmtemplate", g.ID, 2*time.Second, []string{"converting disks of VM " + g.ID + " to base images"}, "", func() {
			a.host.UpdateGuest(proto.PlatformPVE, g.ID, func(s *fakefleet.GuestSpec) { s.Template, s.DiskGiB = true, 32 })
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpDelete:
		if running {
			return fail(proto.CodeGuestRunning, "the guest is running")
		}
		if c.values["protection"] == "1" {
			return fail(proto.CodeProtected, "protection is set: turn it off first")
		}
		t := m.startTask(map[bool]string{true: "qmdestroy", false: "vzdestroy"}[c.kind == "vm"], g.ID, 2*time.Second,
			[]string{"destroying guest " + g.ID, "Removing image: 100% complete...done."}, "", func() {
				a.host.RemoveGuest(proto.PlatformPVE, g.ID)
				delete(m.configs, g.ID)
				delete(m.firewalls, g.ID)
			})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpBackupList:
		return proto.ManageResponse{OK: true, Backups: append([]proto.BackupVolume(nil), m.backupsOf(g)...)}
	case proto.OpBackupCreate:
		if !storageOffers(req.Storage, "backup") {
			return invalid("storage", req.Storage+" does not hold backups.")
		}
		m.backupsOf(g)
		t := m.startTask("vzdump", g.ID, 5*time.Second, []string{"INFO: starting new backup job: vzdump " + g.ID + " --storage " + req.Storage,
			"INFO: Starting Backup of VM " + g.ID, "INFO: creating Proxmox Backup Server archive", "INFO: 52% (16.6 GiB of 32.0 GiB)",
			"INFO: 100% (32.0 GiB of 32.0 GiB)", "INFO: Finished Backup of VM " + g.ID}, "", func() {
			m.backups[g.ID] = append([]proto.BackupVolume{newBackup(req.Storage, g, time.Now(), req.Notes, req.Protected != nil && *req.Protected)}, m.backups[g.ID]...)
			a.host.UpdateGuest(proto.PlatformPVE, g.ID, func(s *fakefleet.GuestSpec) { s.Backup, s.BackupAgeDays = "ok", 0 })
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpBackupRestore:
		return a.restore(m, g, req)
	case proto.OpBackupUpdate, proto.OpBackupDelete:
		for vmid, list := range m.backups {
			for i := range list {
				if list[i].Volume != req.Volume {
					continue
				}
				if req.Op == proto.OpBackupUpdate {
					if req.Notes != "" || req.Protected == nil {
						list[i].Notes = req.Notes
					}
					if req.Protected != nil {
						list[i].Protected = *req.Protected
					}
					return proto.ManageResponse{OK: true}
				}
				if list[i].Protected {
					return fail(proto.CodeProtected, "the backup is protected")
				}
				m.backups[vmid] = append(list[:i], list[i+1:]...)
				return proto.ManageResponse{OK: true}
			}
		}
		return fail(proto.CodeNotFound, "no such backup")
	case proto.OpContentList:
		var out []proto.StorageVolume
		for _, v := range m.content {
			if v.Storage == req.Storage && v.Content == req.Content {
				out = append(out, v)
			}
		}
		return proto.ManageResponse{OK: true, Content: out}
	case proto.OpContentDownload:
		if !storageOffers(req.Storage, req.Content) {
			return invalid("storage", req.Storage+" does not hold "+req.Content+" content.")
		}
		vol := req.Storage + ":" + req.Content + "/" + req.Filename
		for _, v := range m.content {
			if v.Volume == vol {
				return fail(proto.CodeExists, "refusing to override existing file '"+req.Filename+"'")
			}
		}
		lines := []string{"downloading " + req.URL + " to " + vol, "7.50 MiB of 750.00 MiB (1.00%)", "375.00 MiB of 750.00 MiB (50.00%)",
			"750.00 MiB of 750.00 MiB (100.00%)", "download of '" + req.URL + "' finished"}
		failWith := ""
		if strings.Contains(req.URL, "fail") { // a way to see a failing task
			lines, failWith = lines[:2], "download failed: 404 Not Found"
		}
		t := m.startTask("download", "", 8*time.Second, lines, failWith,
			func() {
				m.content = append(m.content, proto.StorageVolume{Volume: vol, Storage: req.Storage, Content: req.Content, Name: req.Filename,
					SizeBytes: 750 << 20, Created: time.Now().UTC()})
			})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpContentDelete:
		for i, v := range m.content {
			if v.Volume == req.Volume {
				m.content = append(m.content[:i], m.content[i+1:]...)
				return proto.ManageResponse{OK: true}
			}
		}
		return fail(proto.CodeNotFound, "no such volume")
	case proto.OpApplianceList:
		return proto.ManageResponse{OK: true, Appliances: simAppliances}
	case proto.OpApplianceDownload:
		if !storageOffers(req.Storage, "vztmpl") {
			return invalid("storage", req.Storage+" does not hold container templates.")
		}
		i := slices.IndexFunc(simAppliances, func(x proto.Appliance) bool { return x.Template == req.Template })
		if i < 0 {
			return fail(proto.CodeNotFound, "no such template")
		}
		vol := req.Storage + ":vztmpl/" + req.Template
		t := m.startTask("download", "", 5*time.Second, []string{"starting template download from: http://download.proxmox.com/images/system/" + req.Template,
			"target file: /var/lib/vz/template/cache/" + req.Template, "download finished"}, "", func() {
			if !slices.ContainsFunc(m.content, func(v proto.StorageVolume) bool { return v.Volume == vol }) {
				m.content = append(m.content, proto.StorageVolume{Volume: vol, Storage: req.Storage, Content: "vztmpl", Name: req.Template,
					SizeBytes: 120 << 20, Created: time.Now().UTC()})
			}
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpTaskList:
		var out []proto.TaskStatus
		for _, t := range m.tasks {
			if g == nil || t.guest == g.ID {
				out = append(out, t.status(-1))
			}
		}
		if g != nil {
			day := time.Now().UTC().Truncate(24 * time.Hour)
			out = append(out,
				proto.TaskStatus{ID: fmt.Sprintf("UPID:shale:00001A2B:00C0FFEE:%08X:vzdump:%s:root@pam:", day.Add(6*time.Minute).Unix(), g.ID),
					Type: "vzdump", GuestID: g.ID, User: "root@pam", Started: day.Add(6 * time.Minute), Ended: ptrTime(day.Add(9 * time.Minute)), Status: "ok", Message: "OK"},
				proto.TaskStatus{ID: fmt.Sprintf("UPID:shale:00001A2C:00C0FFEF:%08X:qmstart:%s:root@pam:", day.Add(-72*time.Hour).Unix(), g.ID),
					Type: "qmstart", GuestID: g.ID, User: "root@pam", Started: day.Add(-72 * time.Hour), Ended: ptrTime(day.Add(-72*time.Hour + 2*time.Second)), Status: "ok", Message: "OK"})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
		return proto.ManageResponse{OK: true, Tasks: out}
	case proto.OpTaskStatus, proto.OpTaskStop:
		t, ok := m.tasks[req.Task]
		if !ok {
			return fail(proto.CodeNotFound, "no such task")
		}
		if req.Op == proto.OpTaskStop {
			if now := time.Now(); now.Before(t.started.Add(t.dur)) {
				t.stopped = &now
			}
			return proto.ManageResponse{OK: true}
		}
		st := t.status(req.LogStart)
		return proto.ManageResponse{OK: true, TaskStatus: &st}
	case proto.OpFirewallGet, proto.OpFirewallOptions, proto.OpFirewallRuleAdd, proto.OpFirewallRuleUpdate, proto.OpFirewallRuleDelete:
		return m.firewall(g, req)
	case proto.OpHASet, proto.OpHARemove:
		state := ""
		if req.HA != nil {
			state = req.HA.State
		}
		a.host.UpdateGuest(proto.PlatformPVE, g.ID, func(s *fakefleet.GuestSpec) { s.HAState = state })
		return proto.ManageResponse{OK: true}
	case proto.OpMigrate:
		if req.Target == simNode || !slices.Contains([]string{"schist", "slate"}, req.Target) {
			return invalid("target", "must be another node of the cluster")
		}
		if req.Digest != "" && req.Digest != c.digest() {
			return fail(proto.CodeDigestMismatch, "the configuration changed since it was read")
		}
		how := "offline"
		if running {
			how = map[bool]string{true: "online", false: "restart"}[g.Kind == "vm"]
		}
		// The simulated cluster's other nodes have no agent: the guest stays
		// on shale in the report.
		t := m.startTask("qmigrate", g.ID, 3*time.Second, []string{
			"starting migration of " + g.ID + " to node '" + req.Target + "' (" + how + ")", "migration finished successfully"}, "", nil)
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	case proto.OpReplicationAdd:
		if req.Target == simNode || !slices.Contains([]string{"schist", "slate"}, req.Target) {
			return invalid("target", "Replicate to another node of the cluster.")
		}
		n := 0
		for slices.ContainsFunc(m.repl[g.ID], func(j proto.ReplicationJob) bool { return j.ID == fmt.Sprintf("%s-%d", g.ID, n) }) {
			n++
		}
		schedule := req.Schedule
		if schedule == "" {
			schedule = "*/15"
		}
		m.repl[g.ID] = append(m.repl[g.ID], proto.ReplicationJob{ID: fmt.Sprintf("%s-%d", g.ID, n), Target: req.Target, Schedule: schedule,
			Rate: req.Rate, Comment: req.Comment})
		return proto.ManageResponse{OK: true}
	case proto.OpBackupJobList, proto.OpBackupJobCreate, proto.OpBackupJobUpdate, proto.OpBackupJobDelete, proto.OpBackupJobRun:
		return a.backupJobs(m, req)
	case proto.OpReplicationDelete:
		i := slices.IndexFunc(m.repl[g.ID], func(j proto.ReplicationJob) bool { return j.ID == req.JobID })
		if i < 0 {
			return fail(proto.CodeNotFound, "no such replication job")
		}
		m.repl[g.ID] = slices.Delete(m.repl[g.ID], i, i+1)
		return proto.ManageResponse{OK: true}
	}
	return fail("unsupported", "The simulator does not have this operation.")
}

func ptrTime(t time.Time) *time.Time { return &t }

// ---- configurations ---------------------------------------------------------------

// config is a guest's configuration, seeded from its spec on first use.
func (m *manageState) config(g *fakefleet.GuestSpec) *simConfig {
	if c, ok := m.configs[g.ID]; ok {
		return c
	}
	c := seedConfig(g)
	m.configs[g.ID] = c
	return c
}

func simMAC(n int) string {
	return fmt.Sprintf("BC:24:11:%02X:%02X:%02X", 0x30+n%0x40, n*7%256, n*13%256)
}

// seedConfig derives a configuration like the fixture's: hand-written
// extras for the interesting guests, the spec for the rest.
func seedConfig(g *fakefleet.GuestSpec) *simConfig {
	n := g.VMID
	c := &simConfig{kind: g.Kind, values: map[string]string{}, pending: map[string]string{}}
	v := c.values
	v["tags"] = strings.Join(g.Tags, ";")
	v["onboot"] = map[bool]string{true: "0", false: "1"}[g.State == proto.StateStopped]
	if g.Kind == "container" {
		mem := g.MemLimMB
		if mem == 0 {
			mem = 512
		}
		for k, x := range map[string]string{"arch": "amd64", "hostname": g.Name, "cores": strconv.Itoa(max(g.VCPU, 1)),
			"memory": strconv.FormatUint(mem, 10), "swap": "512", "ostype": "debian", "unprivileged": "1", "features": "nesting=1",
			"rootfs": fmt.Sprintf("local-zfs:subvol-%d-disk-0,size=8G", n),
			"net0":   fmt.Sprintf("name=eth0,bridge=vmbr0,firewall=1,hwaddr=%s,ip=dhcp,type=veth", simMAC(n))} {
			v[k] = x
		}
		if strings.HasPrefix(g.Image, "alpine") {
			v["ostype"] = "alpine"
		}
		switch n {
		case 200:
			v["description"] = "Grafana for the lab.\nDashboards in /var/lib/grafana."
		case 201:
			v["mp0"] = "vmdata:subvol-201-disk-1,mp=/data,size=20G"
		case 202:
			v["mp1"], v["lxc.cgroup2.devices.allow"] = "/mnt/backup/vaultwarden,mp=/backup", "c 10:200 rwm"
		}
		return c
	}
	mem := g.MemCfgGiB * 1024
	if mem == 0 {
		mem = 4096
	}
	for k, x := range map[string]string{"name": g.Name, "boot": "order=scsi0;ide2;net0", "cores": strconv.Itoa(max(g.VCPU, 1)),
		"sockets": "1", "cpu": "x86-64-v2-AES", "memory": strconv.FormatUint(mem, 10), "ostype": "l26", "scsihw": "virtio-scsi-single",
		"scsi0": fmt.Sprintf("local-zfs:vm-%d-disk-0,iothread=1,discard=on,size=64G", n), "ide2": "none,media=cdrom",
		"net0": fmt.Sprintf("virtio=%s,bridge=vmbr0,firewall=1", simMAC(n)), "agent": "1", "numa": "0",
		"smbios1": fmt.Sprintf("uuid=6f1c2a4e-0000-4000-8000-%012d", n), "vmgenid": fmt.Sprintf("0c6a7f2e-0000-4000-8000-%012d", n)} {
		v[k] = x
	}
	ovmf := func() {
		v["bios"], v["machine"] = "ovmf", "pc-q35-9.2+pve1"
		v["efidisk0"] = fmt.Sprintf("vmdata:vm-%d-disk-0,efitype=4m,pre-enrolled-keys=1,size=1M", n)
	}
	switch n {
	case 100:
		v["description"], v["balloon"] = "k3s worker node 2.", "8192"
	case 101, 107:
		ovmf()
		v["ostype"], v["cpu"] = "win11", "host"
		v["scsi0"] = fmt.Sprintf("vmdata:vm-%d-disk-1,cache=writeback,discard=on,size=256G", n)
		v["tpmstate0"] = fmt.Sprintf("vmdata:vm-%d-disk-2,size=4M,version=v2.0", n)
		v["net0"] = fmt.Sprintf("e1000e=%s,bridge=vmbr0", simMAC(n))
		v["ide2"] = "local:iso/virtio-win-0.1.271.iso,media=cdrom,size=709474K"
		if n == 101 {
			v["hostpci0"], v["balloon"] = "0000:01:00.0,pcie=1,x-vga=1", "0"
		}
	case 102:
		for k, x := range map[string]string{"ide0": "local-zfs:vm-102-cloudinit,media=cdrom", "ciuser": "ubuntu", "cipassword": masked,
			"sshkeys":   "ssh-ed25519%20AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheSimulatorOnly%20admin%40lab",
			"ipconfig0": "ip=10.20.0.52/24,gw=10.20.0.1", "nameserver": "10.20.0.1", "searchdomain": "lab.example"} {
			v[k] = x
		}
	case 103:
		v["protection"], v["scsi1"], v["unused0"] = "1", "vmdata:vm-103-disk-1,iothread=1,size=500G", "vmdata:vm-103-disk-2"
		v["args"], v["startup"] = "-cpu host,+invtsc", "order=1,up=60"
	case 104:
		if g.State != proto.StateStopped {
			c.pending["memory"] = "12288"
		}
	case 105:
		ovmf()
		v["ostype"], v["startup"], v["agent"] = "other", "order=0", "0"
		v["net1"] = fmt.Sprintf("virtio=%s,bridge=vmbr1,tag=20", simMAC(n+1))
		v["scsi0"] = "local-zfs:vm-105-disk-1,size=32G"
	case 106:
		ovmf()
		v["usb0"], v["scsi0"] = "host=10c4:ea60", "local-zfs:vm-106-disk-1,discard=on,size=32G"
	}
	return c
}

var (
	restrictedRe = regexp.MustCompile(`^(args|hookscript|hostpci\d+|usb\d+|parallel\d+|lxc\..*|dev\d+|smbios1|vmgenid|arch|unprivileged)$`)
	diskKeyRe    = regexp.MustCompile(`^(ide|sata|scsi|virtio|efidisk|tpmstate|unused|mp)\d+$|^rootfs$`)
	sizeRe       = regexp.MustCompile(`(?:^|,)size=([0-9.]+)([KMGT]?)`)
)

// restricted are the keys Whombat shows but does not change.
func restricted(c *simConfig) []string {
	var out []string
	for k, v := range c.values {
		if restrictedRe.MatchString(k) || (c.kind == "container" && k == "ostype") || (strings.HasPrefix(k, "mp") && strings.HasPrefix(v, "/")) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// sizeGiB is a disk value's size= in GiB (0: none).
func sizeGiB(v string) float64 {
	m := sizeRe.FindStringSubmatch(v)
	if m == nil {
		return 0
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	return f * map[string]float64{"": 1 / gibF, "K": 1.0 / (1 << 20), "M": 1.0 / 1024, "G": 1, "T": 1024}[m[2]]
}

func configOf(g *fakefleet.GuestSpec, c *simConfig, repl []proto.ReplicationJob) *proto.GuestConfig {
	out := &proto.GuestConfig{Platform: proto.PlatformPVE, Kind: c.kind, Digest: c.digest(), Running: g.State != proto.StateStopped,
		Values: map[string]string{}, Restricted: restricted(c), Replication: append([]proto.ReplicationJob(nil), repl...)}
	for k, v := range c.values {
		out.Values[k] = v
	}
	if len(c.pending) > 0 {
		out.Pending = map[string]string{}
		for k, v := range c.pending {
			out.Pending[k] = v
		}
	}
	out.PendingDelete = append(out.PendingDelete, c.pendingDelete...)
	var boot []string
	if _, order, ok := strings.Cut(c.values["boot"], "order="); ok {
		boot = strings.Split(order, ";")
	}
	for k, v := range c.values {
		if !diskKeyRe.MatchString(k) {
			continue
		}
		file, _, _ := strings.Cut(v, ",")
		d := proto.GuestDisk{Key: k, Media: "disk", Unused: strings.HasPrefix(k, "unused"), Boot: slices.Contains(boot, k)}
		if strings.Contains(v, "media=cdrom") {
			d.Media = "cdrom"
		}
		if storage, _, ok := strings.Cut(file, ":"); ok {
			d.Storage, d.Volume = storage, file
		}
		d.SizeBytes = uint64(sizeGiB(v) * gibF)
		if _, mp, ok := strings.Cut(v, "mp="); ok {
			d.Path, _, _ = strings.Cut(mp, ",")
		}
		out.Disks = append(out.Disks, d)
	}
	sort.Slice(out.Disks, func(i, j int) bool { return out.Disks[i].Key < out.Disks[j].Key })
	if g.HAState != "" {
		out.HA = &proto.HAState{HASettings: proto.HASettings{State: g.HAState}, Status: g.HAState}
	}
	return out
}

var (
	ctRestartRe = regexp.MustCompile(`^(rootfs|mp\d+|features|unprivileged|cmode|tty|console)$`)
	vmLiveRe    = regexp.MustCompile(`^(name|description|tags|onboot|startup|protection|balloon|cpulimit|cpuunits|net\d+|ide\d+|sata\d+|scsi\d+|virtio\d+|unused\d+)$`)
	resizeRe    = regexp.MustCompile(`^(\+)?([0-9]+(?:\.[0-9]+)?)G$`)
	portsRe     = regexp.MustCompile(`^[0-9]{1,5}([:,][0-9]{1,5})*$`)
)

// appliesLive reports whether a running guest takes a key at once; the
// rest waits for a restart.
func appliesLive(c *simConfig, key string) bool {
	if c.kind == "container" {
		return !ctRestartRe.MatchString(key)
	}
	return vmLiveRe.MatchString(key)
}

func nextUnused(c *simConfig) string {
	for i := 0; ; i++ {
		if _, ok := c.values[fmt.Sprintf("unused%d", i)]; !ok {
			return fmt.Sprintf("unused%d", i)
		}
	}
}

func (a *simAgent) configSet(g *fakefleet.GuestSpec, c *simConfig, running bool, req proto.ManageRequest) proto.ManageResponse {
	if req.Digest != "" && req.Digest != c.digest() {
		return fail(proto.CodeDigestMismatch, "detected modified configuration - file changed by other user? Try again.")
	}
	res := restricted(c)
	for _, k := range append(slices.Collect(maps.Keys(req.Set)), req.Delete...) {
		if slices.Contains(res, k) || restrictedRe.MatchString(k) || strings.HasPrefix(k, "raw.") {
			return fail(proto.CodeNotAllowed, k+" can only be changed in the platform's own interface.")
		}
		if v, ok := req.Set[k]; ok && (strings.HasPrefix(v, "/") || strings.Contains(v, "import-from=")) {
			return fail(proto.CodeNotAllowed, k+": host paths can only be set in the platform's own interface.")
		}
	}
	for _, k := range []string{"memory", "cores", "sockets", "balloon", "swap"} {
		if v, ok := req.Set[k]; ok {
			if n, err := strconv.Atoi(v); err != nil || n < 0 {
				return invalid(k, "value must be a positive integer")
			}
		}
	}
	mask := func(k, v string) string {
		if v != "" && (k == "cipassword" || k == "password") {
			return masked
		}
		return v
	}
	var changes []proto.ConfigChange
	for _, k := range req.Revert {
		if v, ok := c.pending[k]; ok {
			changes = append(changes, proto.ConfigChange{Key: k, Old: mask(k, v), New: mask(k, c.values[k])})
			delete(c.pending, k)
		}
		c.pendingDelete = slices.DeleteFunc(c.pendingDelete, func(x string) bool { return x == k })
	}
	for _, k := range slices.Sorted(maps.Keys(req.Set)) {
		v := mask(k, req.Set[k])
		old, ok := c.pending[k]
		if !ok {
			old = c.values[k]
		}
		if old == v && k != "cipassword" {
			continue
		}
		live := !running || appliesLive(c, k)
		if live {
			c.values[k] = v
			delete(c.pending, k)
		} else {
			c.pending[k] = v
		}
		changes = append(changes, proto.ConfigChange{Key: k, Old: mask(k, old), New: v, Pending: !live})
	}
	for _, k := range req.Delete {
		v, ok := c.values[k]
		if !ok {
			continue
		}
		live := !running || appliesLive(c, k)
		if live {
			delete(c.values, k)
			if diskKeyRe.MatchString(k) && !strings.HasPrefix(k, "unused") && !strings.Contains(v, "media=cdrom") && k != "efidisk0" && k != "tpmstate0" {
				file, _, _ := strings.Cut(v, ",")
				c.values[nextUnused(c)] = file // detached disks stay as unusedN
			}
		} else if !slices.Contains(c.pendingDelete, k) {
			c.pendingDelete = append(c.pendingDelete, k)
		}
		changes = append(changes, proto.ConfigChange{Key: k, Old: mask(k, v), Pending: !live})
	}
	a.reflect(g, c)
	return proto.ManageResponse{OK: true, Changes: changes}
}

// reflect copies what the report shows from a configuration to the
// guest's spec: name, CPUs, memory, tags, pending changes.
func (a *simAgent) reflect(g *fakefleet.GuestSpec, c *simConfig) {
	a.host.UpdateGuest(proto.PlatformPVE, g.ID, func(s *fakefleet.GuestSpec) {
		if n := c.values["name"] + c.values["hostname"]; n != "" {
			s.Name = n
		}
		if n, err := strconv.Atoi(c.values["cores"]); err == nil {
			sockets, _ := strconv.Atoi(c.values["sockets"])
			s.VCPU = n * max(sockets, 1)
		}
		if mb, err := strconv.ParseUint(c.values["memory"], 10, 64); err == nil {
			s.MemLimMB = mb
			if s.Kind == "vm" {
				s.MemCfgGiB = max(mb/1024, 1)
			}
		}
		s.Tags = nil
		for _, t := range strings.FieldsFunc(c.values["tags"], func(r rune) bool { return r == ';' || r == ',' }) {
			s.Tags = append(s.Tags, t)
		}
		s.PendingChanges = len(c.pending) + len(c.pendingDelete)
	})
}

func (a *simAgent) diskResize(m *manageState, g *fakefleet.GuestSpec, c *simConfig, req proto.ManageRequest) proto.ManageResponse {
	cur, ok := c.values[req.Disk]
	if !ok {
		return fail(proto.CodeNotFound, req.Disk+" does not exist.")
	}
	mt := resizeRe.FindStringSubmatch(req.Size)
	if mt == nil {
		return invalid("size", "The size is \"+NG\" or the new total \"NG\".")
	}
	now := sizeGiB(cur)
	n, _ := strconv.ParseFloat(mt[2], 64)
	next := n
	if mt[1] == "+" {
		next = now + n
	}
	if next < now {
		return invalid("size", "Disks can only grow.")
	}
	size := strconv.FormatFloat(next, 'f', -1, 64) + "G"
	t := m.startTask(map[bool]string{true: "qmresize", false: "resize"}[c.kind == "vm"], g.ID, 2500*time.Millisecond,
		[]string{"resizing " + req.Disk + " to " + size, "Image resized."}, "", func() { c.values[req.Disk] = withSize(cur, size) })
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
}

// withSize sets the size= item of a disk's property string.
func withSize(v, size string) string {
	items := strings.Split(v, ",")
	for i, it := range items {
		if strings.HasPrefix(it, "size=") {
			items[i] = "size=" + size
			return strings.Join(items, ",")
		}
	}
	return v + ",size=" + size
}

// ---- choices, create, clone, restore ----------------------------------------------

var simAppliances = []proto.Appliance{
	{Template: "debian-13-standard_13.1-1_amd64.tar.zst", Package: "debian-13-standard", Headline: "Debian 13 (standard)", OS: "debian-13", Version: "13.1-1", Section: "system"},
	{Template: "ubuntu-24.04-standard_24.04-2_amd64.tar.zst", Package: "ubuntu-24.04-standard", Headline: "Ubuntu 24.04 (standard)", OS: "ubuntu-24.04", Version: "24.04-2", Section: "system"},
	{Template: "alpine-3.22-default_20250617_amd64.tar.xz", Package: "alpine-3.22-default", Headline: "Alpine Linux 3.22 (default)", OS: "alpine", Version: "3.22-1", Section: "system"},
	{Template: "rockylinux-9-default_20240912_amd64.tar.xz", Package: "rockylinux-9-default", Headline: "Rocky Linux 9 (default)", OS: "rockylinux", Version: "9-1", Section: "system"},
	{Template: "debian-12-turnkey-nextcloud_18.1-1_amd64.tar.gz", Package: "turnkey-nextcloud", Headline: "TurnKey Nextcloud", Description: "Nextcloud on Debian 12 with Apache and MariaDB.", OS: "debian-12", Version: "18.1-1", Section: "turnkeylinux"},
}

// taken reports whether a vmid is used by a guest, a template or a task
// still creating one.
func (a *simAgent) taken(m *manageState, vmid int) bool {
	id := strconv.Itoa(vmid)
	if _, ok := m.configs[id]; ok {
		return true
	}
	if _, ok := a.host.FindGuest(proto.PlatformPVE, id); ok {
		return true
	}
	for _, t := range m.tasks {
		if t.guest == id && time.Now().Before(t.started.Add(t.dur)) {
			return true
		}
	}
	return false
}

// nextID is the first free vmid from 100.
func (a *simAgent) nextID(m *manageState) int {
	n := 100
	for a.taken(m, n) {
		n++
	}
	return n
}

// newVMID is the requested vmid (0: the next free one), or an error when
// it is taken.
func (a *simAgent) newVMID(m *manageState, want int) (int, *proto.ManageResponse) {
	if want == 0 {
		return a.nextID(m), nil
	}
	if a.taken(m, want) {
		r := fail(proto.CodeExists, fmt.Sprintf("unable to create VM %d: config file already exists", want))
		return 0, &r
	}
	return want, nil
}

func (a *simAgent) choices(m *manageState) *proto.Choices {
	c := &proto.Choices{Platform: proto.PlatformPVE, Node: simNode, Cluster: true, NextID: a.nextID(m),
		Storages: simStorages, Bridges: []string{"vmbr0", "vmbr1"}, Nodes: []string{"schist", "slate"}, Download: true,
		CPUTypes: []string{"x86-64-v2-AES", "x86-64-v3", "x86-64-v4", "host", "kvm64", "qemu64", "EPYC-Milan", "Skylake-Server"}}
	for _, v := range m.content {
		switch v.Content {
		case "iso":
			c.ISOs = append(c.ISOs, v)
		case "vztmpl":
			c.CTTemplates = append(c.CTTemplates, v)
		}
	}
	if r := a.host.Report(time.Now(), 0, simVersion); r.PVE != nil {
		c.Templates = r.PVE.Templates
	}
	return c
}

// newGuest is the spec of a created, cloned or restored guest.
func newGuest(vmid int, name, kind string, cores int, memMB uint64) fakefleet.GuestSpec {
	s := fakefleet.GuestSpec{Platform: proto.PlatformPVE, ID: strconv.Itoa(vmid), Name: name, Kind: kind, State: proto.StateStopped,
		VCPU: max(cores, 1), MemLimMB: memMB, MemCfgGiB: max(memMB/1024, 1), VMID: vmid, Image: "debian 13", Res: "1024x768"}
	no := false
	s.BackupJob = &no
	if kind == "vm" {
		s.Protocols, s.Default = []string{proto.ProtoVNC, proto.ProtoSerial}, proto.ProtoVNC
	} else {
		s.Protocols, s.Default, s.MemCfgGiB = []string{proto.ProtoShell, proto.ProtoTTY}, proto.ProtoShell, 0
	}
	return s
}

func (a *simAgent) create(m *manageState, req proto.ManageRequest) proto.ManageResponse {
	if req.Kind != "vm" && req.Kind != "container" {
		return invalid("kind", "kind is vm or container")
	}
	vmid, refused := a.newVMID(m, req.NewID)
	if refused != nil {
		return *refused
	}
	if req.Kind == "container" {
		if req.Set["ostemplate"] == "" {
			return invalid("ostemplate", "Choose a container template.")
		}
		if u, ok := req.Set["unprivileged"]; ok && u != "1" {
			return fail(proto.CodeNotAllowed, "Privileged containers are created in the platform's own interface.")
		}
	}
	c := &simConfig{kind: req.Kind, values: map[string]string{}, pending: map[string]string{}}
	disks := 0
	for _, k := range slices.Sorted(maps.Keys(req.Set)) {
		v := req.Set[k]
		switch k {
		case "password", "ssh-public-keys", "ostemplate":
			continue // create-only and never stored or shown
		case "cipassword":
			v = masked
		}
		if strings.HasPrefix(v, "/") || strings.Contains(v, "import-from=") {
			return fail(proto.CodeNotAllowed, k+": host paths can only be set in the platform's own interface.")
		}
		// New volumes ("local-zfs:32,iothread=1") get their names.
		if storage, rest, ok := strings.Cut(v, ":"); ok && diskKeyRe.MatchString(k) {
			size, opts, _ := strings.Cut(rest, ",")
			if _, err := strconv.ParseFloat(size, 64); err == nil {
				prefix := map[bool]string{true: "vm", false: "subvol"}[req.Kind == "vm"]
				items := []string{fmt.Sprintf("%s:%s-%d-disk-%d", storage, prefix, vmid, disks)}
				if opts != "" {
					items = append(items, opts)
				}
				v = strings.Join(append(items, "size="+size+"G"), ",")
				disks++
			}
		}
		c.values[k] = v
	}
	name := req.Name
	if name == "" {
		name = map[bool]string{true: "VM", false: "CT"}[req.Kind == "vm"] + strconv.Itoa(vmid)
	}
	if req.Kind == "vm" {
		c.values["name"] = name
	} else {
		c.values["hostname"], c.values["unprivileged"] = name, "1"
	}
	cores, _ := strconv.Atoi(c.values["cores"])
	mem, _ := strconv.ParseUint(c.values["memory"], 10, 64)
	if mem == 0 {
		mem = 2048
		c.values["memory"] = "2048"
	}
	spec := newGuest(vmid, name, req.Kind, cores, mem)
	if req.Start {
		spec.State = proto.StateRunning
	}
	typ := map[bool]string{true: "qmcreate", false: "vzcreate"}[req.Kind == "vm"]
	lines := []string{fmt.Sprintf("creating %s %d", map[bool]string{true: "VM", false: "container"}[req.Kind == "vm"], vmid)}
	if t := req.Set["ostemplate"]; t != "" {
		lines = append(lines, "extracting archive '"+t+"'", "Total bytes read: 524288000 (500MiB, 98MiB/s)")
	}
	for k, v := range c.values {
		if diskKeyRe.MatchString(k) && strings.Contains(v, "-disk-") {
			lines = append(lines, k+": successfully created disk '"+strings.Split(v, ",")[0]+"'")
		}
	}
	if req.Start {
		lines = append(lines, "starting guest "+strconv.Itoa(vmid))
	}
	t := m.startTask(typ, strconv.Itoa(vmid), 4*time.Second, lines, "", func() {
		m.configs[strconv.Itoa(vmid)] = c
		a.host.AddGuest(spec)
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: strconv.Itoa(vmid)}
}

func (a *simAgent) clone(m *manageState, g *fakefleet.GuestSpec, c *simConfig, req proto.ManageRequest) proto.ManageResponse {
	if !g.Template && !req.Full {
		return invalid("full", "Linked clones need a template: make a full clone.")
	}
	vmid, refused := a.newVMID(m, req.NewID)
	if refused != nil {
		return *refused
	}
	name := req.Name
	if name == "" {
		name = "Copy-of-" + g.Name
	}
	nc := &simConfig{kind: c.kind, values: map[string]string{}, pending: map[string]string{}}
	old := fmt.Sprintf("-%s-", g.ID)
	for k, v := range c.values {
		v = strings.ReplaceAll(v, old, fmt.Sprintf("-%d-", vmid))
		if req.Storage != "" && diskKeyRe.MatchString(k) && strings.Contains(v, "-disk-") {
			_, rest, _ := strings.Cut(v, ":")
			v = req.Storage + ":" + rest
		}
		nc.values[k] = v
	}
	if c.kind == "vm" {
		nc.values["name"] = name
	} else {
		nc.values["hostname"] = name
	}
	delete(nc.values, "protection")
	spec := *g
	spec.ID, spec.VMID, spec.Name, spec.State, spec.Template, spec.Started, spec.HAState = strconv.Itoa(vmid), vmid, name, proto.StateStopped, false, nil, ""
	spec.Tags = append([]string(nil), g.Tags...)
	no := false
	spec.BackupJob = &no
	lines := []string{fmt.Sprintf("create full clone of drive scsi0 (local-zfs:vm-%s-disk-0)", g.ID), "transferred 3.0 GiB of 32.0 GiB (9.38%)",
		"transferred 16.0 GiB of 32.0 GiB (50.00%)", "transferred 32.0 GiB of 32.0 GiB (100.00%)"}
	dur := 6 * time.Second
	if !req.Full {
		lines, dur = []string{"create linked clone of drive scsi0 (local-zfs:base-" + g.ID + "-disk-0)"}, 2*time.Second
	}
	t := m.startTask(map[bool]string{true: "qmclone", false: "vzclone"}[c.kind == "vm"], g.ID, dur, lines, "", func() {
		m.configs[strconv.Itoa(vmid)] = nc
		a.host.AddGuest(spec)
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: strconv.Itoa(vmid)}
}

// backupsOf seeds a guest's backups: the nightly job's last three on
// pbs-01, and a protected local one for some.
func (m *manageState) backupsOf(g *fakefleet.GuestSpec) []proto.BackupVolume {
	if b, ok := m.backups[g.ID]; ok {
		return b
	}
	var out []proto.BackupVolume
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(6 * time.Minute)
	for i := 0; i < 3; i++ {
		b := newBackup("pbs-01", g, day.AddDate(0, 0, -i-g.BackupAgeDays), "", false)
		b.Verified = "ok"
		if i == 0 {
			b.Verified = ""
		}
		out = append(out, b)
	}
	if g.VMID%3 == 0 {
		out = append(out, newBackup("local", g, day.AddDate(0, 0, -40), "Before the 26.05 upgrade", true))
	}
	m.backups[g.ID] = out
	return out
}

func newBackup(storage string, g *fakefleet.GuestSpec, at time.Time, notes string, protected bool) proto.BackupVolume {
	kind := map[bool]string{true: "vm", false: "ct"}[g.Kind == "vm"]
	b := proto.BackupVolume{Storage: storage, GuestID: g.ID, Kind: g.Kind, Created: at.UTC(), Notes: notes, Protected: protected,
		SizeBytes: uint64(8+g.VMID%20) << 30}
	if storage == "pbs-01" {
		b.Volume, b.Format = fmt.Sprintf("pbs-01:backup/%s/%s/%s", kind, g.ID, at.UTC().Format(time.RFC3339)), "pbs-"+kind
	} else {
		ext := map[bool]string{true: "vma.zst", false: "tar.zst"}[g.Kind == "vm"]
		typ := map[bool]string{true: "qemu", false: "lxc"}[g.Kind == "vm"]
		b.Volume, b.Format = fmt.Sprintf("%s:backup/vzdump-%s-%s-%s.%s", storage, typ, g.ID, at.UTC().Format("2006_01_02-15_04_05"), ext), ext
	}
	return b
}

func (a *simAgent) restore(m *manageState, g *fakefleet.GuestSpec, req proto.ManageRequest) proto.ManageResponse {
	var bv *proto.BackupVolume
	for _, list := range m.backups {
		for i := range list {
			if list[i].Volume == req.Volume {
				bv = &list[i]
			}
		}
	}
	if bv == nil {
		return fail(proto.CodeNotFound, "no such backup (list the guest's backups first)")
	}
	lines := []string{"restore image " + bv.Volume, "progress 25% (read 8589934592 bytes)", "progress 100% (read 34359738368 bytes)",
		"rescan volumes..."}
	if g != nil {
		if g.State != proto.StateStopped {
			return fail(proto.CodeGuestRunning, "the guest is running")
		}
		t := m.startTask(map[bool]string{true: "qmrestore", false: "vzrestore"}[g.Kind == "vm"], g.ID, 6*time.Second, lines, "", nil)
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	}
	src, ok := a.host.FindGuest(proto.PlatformPVE, bv.GuestID)
	vmid, refused := a.newVMID(m, req.NewID)
	if refused != nil {
		return *refused
	}
	spec := newGuest(vmid, "restored-"+bv.GuestID, bv.Kind, 2, 2048)
	var nc *simConfig
	if ok {
		spec = src
		spec.ID, spec.VMID, spec.Name, spec.State, spec.Started, spec.HAState = strconv.Itoa(vmid), vmid, src.Name+"-restored", proto.StateStopped, nil, ""
		no := false
		spec.BackupJob = &no
		nc = seedConfig(&spec)
	} else {
		nc = seedConfig(&spec)
	}
	if req.Start {
		spec.State = proto.StateRunning
	}
	t := m.startTask(map[bool]string{true: "qmrestore", false: "vzrestore"}[spec.Kind == "vm"], strconv.Itoa(vmid), 6*time.Second, lines, "", func() {
		m.configs[strconv.Itoa(vmid)] = nc
		a.host.AddGuest(spec)
	})
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}, NewID: strconv.Itoa(vmid)}
}

// ---- tasks -----------------------------------------------------------------------

// startTask starts a simulated task; onDone runs when it ends well.
func (m *manageState) startTask(typ, guest string, dur time.Duration, lines []string, failWith string, onDone func()) *simTask {
	now := time.Now()
	t := &simTask{id: fmt.Sprintf("UPID:%s:%08X:%08X:%08X:%s:%s:%s:", simNode, rand.Uint32(), rand.Uint32(), now.Unix(), typ, guest, simTaskUsr),
		typ: typ, guest: guest, started: now, dur: dur, lines: lines, err: failWith}
	m.tasks[t.id] = t
	time.AfterFunc(dur, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if t.stopped == nil && t.err == "" && onDone != nil {
			onDone()
		}
	})
	return t
}

// status is a task's state at the clock, with the log from line start on
// (-1: none).
func (t *simTask) status(start int) proto.TaskStatus {
	now := time.Now()
	end := t.started.Add(t.dur)
	if t.stopped != nil {
		end = *t.stopped
	}
	done := !now.Before(end)
	shown := len(t.lines)
	if !done {
		shown = max(1, int(float64(len(t.lines))*float64(now.Sub(t.started))/float64(t.dur)))
	}
	lines := append([]string(nil), t.lines[:min(shown, len(t.lines))]...)
	st := proto.TaskStatus{ID: t.id, Type: t.typ, GuestID: t.guest, User: simTaskUsr, Started: t.started.UTC(), Status: "running"}
	if len(lines) > 0 {
		st.Message = lines[len(lines)-1]
	}
	if done {
		e := end.UTC()
		st.Ended = &e
		switch {
		case t.stopped != nil:
			st.Status, st.Message = "error", "unexpected status"
			lines = append(lines, "received interrupt", "TASK ERROR: interrupted by signal")
		case t.err != "":
			st.Status, st.Message = "error", t.err
			lines = append(lines, "TASK ERROR: "+t.err)
		default:
			st.Status, st.Message = "ok", "OK"
			lines = append(lines, "TASK OK")
		}
	}
	if start >= 0 {
		if start < len(lines) {
			st.Log = lines[start:]
		}
		st.LogNext = len(lines)
	}
	return st
}

// ---- firewall --------------------------------------------------------------------

func (f *simFirewall) digests() (string, string) {
	o, _ := json.Marshal(f.options)
	r, _ := json.Marshal(f.rules)
	so, sr := sha1.Sum(o), sha1.Sum(r)
	return hex.EncodeToString(so[:8]), hex.EncodeToString(sr[:8])
}

func (m *manageState) firewall(g *fakefleet.GuestSpec, req proto.ManageRequest) proto.ManageResponse {
	f, ok := m.firewalls[g.ID]
	if !ok {
		f = &simFirewall{options: map[string]string{"enable": "0", "policy_in": "DROP", "policy_out": "ACCEPT"}}
		if g.Kind == "container" || g.VMID == 100 {
			f.options["enable"] = "1"
			f.rules = []proto.FirewallRule{
				{Pos: 0, Type: "in", Action: "ACCEPT", Enable: true, Macro: "SSH", Source: "10.20.0.0/24", Comment: "admin network"},
				{Pos: 1, Type: "in", Action: "ACCEPT", Enable: true, Proto: "tcp", DPort: "443"},
				{Pos: 2, Type: "group", Action: "monitoring", Enable: true},
			}
		}
		m.firewalls[g.ID] = f
	}
	od, rd := f.digests()
	switch req.Op {
	case proto.OpFirewallGet:
		return proto.ManageResponse{OK: true, Firewall: &proto.GuestFirewall{Options: f.options, OptionsDigest: od,
			Rules: append([]proto.FirewallRule(nil), f.rules...), RulesDigest: rd, Groups: []string{"monitoring", "web"}, ClusterEnabled: true}}
	case proto.OpFirewallOptions:
		if req.Digest != "" && req.Digest != od {
			return fail(proto.CodeDigestMismatch, "detected modified configuration - file changed by other user? Try again.")
		}
		for k, v := range req.Set {
			f.options[k] = v
		}
		for _, k := range req.Delete {
			delete(f.options, k)
		}
		return proto.ManageResponse{OK: true}
	}
	if req.Digest != "" && req.Digest != rd {
		return fail(proto.CodeDigestMismatch, "detected modified configuration - file changed by other user? Try again.")
	}
	if r := req.Rule; r != nil {
		if r.Type == "group" && r.Action != "monitoring" && r.Action != "web" {
			return invalid("action", "security group '"+r.Action+"' does not exist")
		}
		if r.DPort != "" && !portsRe.MatchString(r.DPort) {
			return invalid("dport", "invalid port '"+r.DPort+"'")
		}
	}
	pos := -1
	if req.Pos != nil {
		pos = *req.Pos
		if pos >= len(f.rules) {
			return fail(proto.CodeNotFound, "no rule at position "+strconv.Itoa(pos))
		}
	}
	switch req.Op {
	case proto.OpFirewallRuleAdd:
		at := min(max(req.Rule.Pos, 0), len(f.rules))
		f.rules = slices.Insert(f.rules, at, *req.Rule)
	case proto.OpFirewallRuleUpdate:
		if req.Rule != nil {
			f.rules[pos] = *req.Rule
		}
		if req.MoveTo != nil {
			r := f.rules[pos]
			f.rules = slices.Delete(f.rules, pos, pos+1)
			f.rules = slices.Insert(f.rules, min(*req.MoveTo, len(f.rules)), r)
		}
	case proto.OpFirewallRuleDelete:
		f.rules = slices.Delete(f.rules, pos, pos+1)
	}
	for i := range f.rules {
		f.rules[i].Pos = i
	}
	return proto.ManageResponse{OK: true}
}
