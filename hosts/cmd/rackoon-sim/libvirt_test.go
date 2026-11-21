package main

import (
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

func TestKVMLabManage(t *testing.T) {
	simLatency = 0
	a := &simAgent{o: options{manage: true}, host: fakefleet.KVMLab(), early: make(chan struct{}, 4)}
	call := func(req proto.ManageRequest) proto.ManageResponse {
		t.Helper()
		req.Platform = proto.PlatformLibvirt
		return a.manage(req)
	}
	r := call(proto.ManageRequest{Op: proto.OpConfigGet, GuestID: "web"})
	if !r.OK || r.Config.Values["vcpus"] != "2" || r.Config.Values["net0"] != "model=virtio,network=default,mac=52:54:00:6b:1e:01,link=up" {
		t.Fatalf("config.get: %+v", r)
	}
	if r := call(proto.ManageRequest{Op: proto.OpConfigGet, GuestID: "nope"}); r.Code != "unknown_guest" {
		t.Errorf("unknown VM: %+v", r)
	}
	if r := call(proto.ManageRequest{Op: proto.OpCreate, Name: "deb", OSVariant: "debian13", DiskGB: 16, ISO: "default/debian-13.1.0-amd64-netinst.iso", Start: true}); !r.OK || r.NewID != "deb" {
		t.Fatalf("create: %+v", r)
	}
	if r := call(proto.ManageRequest{Op: proto.OpBackupList, GuestID: "web"}); len(r.Backups) != 1 || r.Backups[0].Notes != "nightly" {
		t.Errorf("backups: %+v", r)
	}
	if r := call(proto.ManageRequest{Op: proto.OpNetworkLeases, Network: "default"}); len(r.Leases) != 2 || r.Leases[0].GuestID != "web" {
		t.Errorf("leases: %+v", r)
	}
	rep := a.sample(time.Now())
	var deb *proto.Guest
	for i, g := range rep.Libvirt.Guests {
		if g.ID == "deb" {
			deb = &rep.Libvirt.Guests[i]
		}
	}
	if deb == nil || deb.State != proto.StateRunning || deb.VCPU != 2 || deb.MemConfigBytes != 2<<30 {
		t.Errorf("deb in the report: %+v", deb)
	}
	det := rep.Libvirt.Libvirt
	if det == nil || len(det.Pools) != 1 || det.BackupsDir == "" || !det.Firmware.TPM {
		t.Errorf("detail: %+v", det)
	}
	var web proto.Guest
	for _, g := range rep.Libvirt.Guests {
		if g.ID == "web" {
			web = g
		}
	}
	if web.LastBackup == nil || web.CPUPct == nil {
		t.Errorf("web: %+v", web)
	}
	// Other hosts don't simulate libvirt.
	b := &simAgent{o: options{manage: true}, host: fakefleet.Fleet()[0], early: make(chan struct{}, 1)}
	if r := b.manage(proto.ManageRequest{Op: proto.OpChoices, Platform: proto.PlatformLibvirt}); r.Code != "unsupported" {
		t.Errorf("basalt: %+v", r)
	}
}
