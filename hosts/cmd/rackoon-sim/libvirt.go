package main

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/broker/lvfake"
	"rackoon/internal/proto"
)

// Simulated libvirt (docs/MANAGE.md 2.8): kvm-lab (rackoon-sim --libvirt)
// answers libvirt's manage operations with the agent's own libvirt
// manager over an in-memory libvirt (package lvfake), so configurations,
// new disks, creates, clones, backups, restores, volumes, ISO downloads,
// leases and the QEMU log behave as on a real host. Its report lists the
// in-memory domains (with the fake fleet's numbers where a VM is one of
// the seeded ones) and libvirt's host view.

type libvirtSimState struct {
	once sync.Once
	fake *lvfake.Fake
	mgr  interface {
		Manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse
	}
}

// lvSims are the hosts with a simulated libvirt (kvm-lab).
var lvSims sync.Map // host id -> *libvirtSimState

const lvImages = "/var/lib/libvirt/images"

func lvSimDomain(name, uuid, mac string, vcpus, memMiB int, extra string) string {
	return fmt.Sprintf(`<domain type='kvm'><name>%s</name><uuid>%s</uuid>
<memory unit='KiB'>%d</memory><currentMemory unit='KiB'>%d</currentMemory><vcpu placement='static'>%d</vcpu>
<os%s><type arch='x86_64' machine='pc-q35-10.0'>hvm</type><boot dev='hd'/></os><features><acpi/><apic/></features>
<cpu mode='host-passthrough' check='none' migratable='on'/><on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>
<devices><emulator>/usr/bin/qemu-system-x86_64</emulator>
<disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='%s/%s.qcow2'/><target dev='vda' bus='virtio'/></disk>
<disk type='file' device='cdrom'><driver name='qemu' type='raw'/><target dev='sda' bus='sata'/><readonly/></disk>
<interface type='network'><mac address='%s'/><source network='default'/><model type='virtio'/></interface>
<graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/><video><model type='virtio'/></video>%s</devices></domain>`,
		name, uuid, memMiB<<10, memMiB<<10, vcpus, map[bool]string{true: " firmware='efi'", false: ""}[strings.Contains(extra, "tpm")],
		lvImages, name, mac, extra)
}

// libvirtSim returns kvm-lab's in-memory libvirt (nil for other hosts).
func (a *simAgent) libvirtSim() *libvirtSimState {
	if a.host.LibvirtDetail == nil || a.host.Unraid != nil {
		return nil
	}
	v, _ := lvSims.LoadOrStore(a.host.ID, &libvirtSimState{})
	s := v.(*libvirtSimState)
	s.once.Do(func() {
		f := lvfake.New()
		f.BackupTime = 20 * time.Second
		f.AddDisk(lvImages+"/web.qcow2", "qcow2", 32<<30, 6<<30)
		f.AddDisk(lvImages+"/win11.qcow2", "qcow2", 64<<30, 21<<30)
		f.AddDisk(lvImages+"/lab.qcow2", "qcow2", 20<<30, 2<<30)
		f.AddFile(lvImages+"/debian-13.1.0-amd64-netinst.iso", make([]byte, 4096))
		f.AddFile(lvImages+"/Win11_24H2_English_x64.iso", make([]byte, 4096))
		f.AddFile(lvImages+"/virtio-win-0.1.271.iso", make([]byte, 4096))
		for _, d := range []struct {
			xml     string
			running bool
		}{
			{lvSimDomain("web", "6b1e0001-2222-4333-8444-555555555501", "52:54:00:6b:1e:01", 2, 4096, ""), true},
			{lvSimDomain("win11", "6b1e0002-2222-4333-8444-555555555502", "52:54:00:6b:1e:02", 4, 8192,
				"<tpm model='tpm-crb'><backend type='emulator' version='2.0'/></tpm>"), true},
			{lvSimDomain("lab", "6b1e0003-2222-4333-8444-555555555503", "52:54:00:6b:1e:03", 2, 2048, ""), false},
		} {
			_ = f.AddDomain(d.xml, d.running)
		}
		f.SetSnapshots("win11", 2)
		f.AddLease("default", "52:54:00:6b:1e:01", "192.168.122.21", "web")
		f.AddLease("default", "52:54:00:6b:1e:02", "192.168.122.22", "DESKTOP-WIN11")
		f.AddFile("/var/log/libvirt/qemu/web.log", []byte("2026-10-05 09:12:01.204+0000: starting up libvirt version: 11.3.0, qemu version: 10.0.13\n"+
			"LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin HOME=/var/lib/libvirt/qemu/domain-1-web /usr/bin/qemu-system-x86_64 -name guest=web\n"+
			"char device redirected to /dev/pts/1 (label charserial0)\n"))
		// A backup of web from yesterday.
		dir := lvImages + "/.whombat-backups/web/" + time.Now().Add(-30*time.Hour).UTC().Format("20060102-150405")
		f.AddDisk(dir+"/vda.qcow2", "qcow2", 32<<30, 6<<30)
		f.AddFile(dir+"/domain.xml", []byte(lvSimDomain("web", "6b1e0001-2222-4333-8444-555555555501", "52:54:00:6b:1e:01", 2, 4096, "")))
		f.AddFile(dir+"/backup.json", []byte(fmt.Sprintf(`{"name":"web","uuid":"6b1e0001-2222-4333-8444-555555555501","created":%d,"running":true,`+
			`"notes":"nightly","disks":[{"target":"vda","file":"vda.qcow2","format":"qcow2","size":%d,"source":"%s/web.qcow2"}]}`,
			time.Now().Add(-30*time.Hour).Unix(), 32<<30, lvImages)))
		s.fake = f
		s.mgr = broker.NewLibvirtManager(func() (broker.LibvirtConn, error) { return f, nil }, f, "")
	})
	return s
}

// manageLibvirt answers kvm-lab's libvirt operations.
func (a *simAgent) manageLibvirt(req proto.ManageRequest) (proto.ManageResponse, bool) {
	if req.Platform != proto.PlatformLibvirt && !strings.HasPrefix(req.Task, "libvirt:") {
		return proto.ManageResponse{}, false
	}
	s := a.libvirtSim()
	if s == nil {
		return proto.ManageResponse{Code: "unsupported", Message: "The simulator manages the libvirt VMs of kvm-lab only."}, true
	}
	if simLatency > 0 {
		time.Sleep(simLatency)
	}
	if req.Op == proto.OpGuestAutostart && req.On != nil {
		d, err := s.fake.DomainLookupByName(req.GuestID)
		if err != nil {
			return proto.ManageResponse{Code: "unknown_guest", Message: "No such guest on this host."}, true
		}
		_ = s.fake.DomainSetAutostart(d, map[bool]int32{true: 1, false: 0}[*req.On])
		a.reportSoon()
		return proto.ManageResponse{OK: true}, true
	}
	var g *proto.Guest
	if req.GuestID != "" {
		if _, err := s.fake.DomainLookupByName(req.GuestID); err == nil {
			g = &proto.Guest{ID: req.GuestID, Name: req.GuestID, Kind: "vm"}
		} else if req.Op != proto.OpBackupRestore && req.Op != proto.OpBackupDelete && req.Op != proto.OpBackupList {
			return proto.ManageResponse{Code: "unknown_guest", Message: "No such guest on this host."}, true
		}
	}
	resp := s.mgr.Manage(context.Background(), g, req)
	if resp.OK && req.Op != proto.OpConfigGet && req.Op != proto.OpChoices && !strings.HasSuffix(req.Op, ".list") && req.Op != proto.OpTaskStatus {
		a.reportSoon()
	}
	return resp, true
}

func (a *simAgent) reportSoon() {
	select {
	case a.early <- struct{}{}:
	default:
	}
}

// patchLibvirt puts kvm-lab's in-memory domains and libvirt's host view
// into its report.
func (a *simAgent) patchLibvirt(r *proto.Report) {
	s := a.libvirtSim()
	if s == nil || r.Libvirt == nil {
		return
	}
	specs := map[string]proto.Guest{}
	for _, g := range r.Libvirt.Guests {
		specs[g.ID] = g
	}
	var guests []proto.Guest
	for _, d := range s.fake.Domains() {
		g, ok := specs[d.Name]
		if ok {
			// Power actions change the fake fleet's state: libvirt follows.
			if (g.State == proto.StateRunning) != d.Running {
				_ = s.fake.SetRunning(d.Name, g.State == proto.StateRunning)
			}
		} else {
			g = proto.Guest{ID: d.Name, Name: d.Name, Kind: "vm", Image: "q35", State: proto.StateStopped,
				Console: proto.ConsoleCaps{Protocols: []string{proto.ProtoVNC}, Default: proto.ProtoVNC}}
			if d.Running {
				g.State = proto.StateRunning
			}
			if m := lvVCPURe.FindStringSubmatch(d.XML); m != nil {
				g.VCPU, _ = strconv.Atoi(m[1])
			}
			if m := lvMemRe.FindStringSubmatch(d.XML); m != nil {
				kib, _ := strconv.ParseUint(m[1], 10, 64)
				g.MemConfigBytes = kib << 10
			}
		}
		au := d.Autostart
		g.Autostart = &au
		n := d.Snapshots
		g.SnapshotsCount = &n
		g.LastBackup = nil
		guests = append(guests, g)
	}
	r.Libvirt.Guests = guests
	if det, err := broker.ReadLibvirtDetail(s.fake, s.fake, ""); err == nil {
		r.Libvirt.Libvirt = det
		times := broker.LibvirtBackupTimes(s.fake, det.BackupsDir)
		for i := range r.Libvirt.Guests {
			if at := times["name:"+r.Libvirt.Guests[i].ID]; at > 0 {
				r.Libvirt.Guests[i].LastBackup = &proto.BackupMark{Result: "ok", At: time.Unix(at, 0).UTC()}
			}
		}
	}
}

var (
	lvVCPURe = regexp.MustCompile(`<vcpu[^>]*>([0-9]+)</vcpu>`)
	lvMemRe  = regexp.MustCompile(`<memory unit='KiB'>([0-9]+)</memory>`)
)
