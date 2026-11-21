package rules

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestLibvirtHints(t *testing.T) {
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	old, fresh := at.Add(-40*24*time.Hour), at.Add(-2*24*time.Hour)
	r := &proto.Report{At: at, Libvirt: &proto.Platform{
		Libvirt: &proto.LibvirtDetail{BackupsDir: "/var/lib/libvirt/images/.whombat-backups", Pools: []proto.LibvirtPool{
			{Name: "default", Active: true, Path: "/var/lib/libvirt/images", TotalBytes: 100e9, UsedBytes: 90e9, AvailBytes: 10e9},
			{Name: "big", Active: true, TotalBytes: 100e9, UsedBytes: 97e9, AvailBytes: 3e9},
			{Name: "ok", Active: true, TotalBytes: 100e9, UsedBytes: 10e9},
		}},
		Guests: []proto.Guest{
			{ID: "web", Name: "web", State: proto.StateRunning, LastBackup: &proto.BackupMark{Result: "ok", At: old}},
			{ID: "db", Name: "db", State: proto.StateRunning, LastSnapshot: &fresh},
			{ID: "lab", Name: "lab", State: proto.StateStopped},
			{ID: "ci", Name: "ci", State: proto.StateRunning, LastBackup: &proto.BackupMark{Result: "ok", At: fresh}},
		}}}
	h := libvirtHints(r, nil, time.Now())
	if len(h) != 3 {
		t.Fatalf("hints = %+v", h)
	}
	if h[0].Kind != HintLibvirtPoolFull || h[0].Severity != HintInfo || h[0].Title != "Storage “default” 90% full" || h[0].Link != LinkStorage ||
		h[1].Severity != HintWarning || h[1].Entity != "libvirt-pool:big" {
		t.Errorf("pool hints = %+v", h[:2])
	}
	if h[2].Kind != HintLibvirtNoBackup || h[2].Entity != "libvirt:web" || h[2].Title != "web has no recent backup" {
		t.Errorf("backup hint = %+v", h[2])
	}
	// The space alert covers a full pool; agents without the host view get
	// no backup hint.
	open := []Alert{{Rule: RuleSpaceHigh, Entity: "fs:/var/lib/libvirt/images", State: AlertOpen}}
	r.Libvirt.Guests[1].LastSnapshot = nil
	if h := libvirtHints(r, open, time.Now()); len(h) != 2 || h[0].Entity != "libvirt-pool:big" || h[1].Title != "2 machines have no recent backup" || h[1].Detail != "web, db" {
		t.Errorf("hints = %+v", h)
	}
	r.Libvirt.Libvirt = nil
	if h := libvirtHints(r, nil, time.Now()); len(h) != 0 {
		t.Errorf("old agent hints = %+v", h)
	}
}
