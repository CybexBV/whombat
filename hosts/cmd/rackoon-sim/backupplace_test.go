package main

import (
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

func TestSimBackupPlace(t *testing.T) {
	a := &simAgent{o: options{manage: true}, host: fakefleet.Blackbox(), early: make(chan struct{}, 1)}
	place := func(op string, p proto.PlaceRequest) proto.ManageResponse {
		return a.manage(proto.ManageRequest{Op: op, Platform: proto.PlatformHost, Place: &p})
	}
	r := place(proto.OpPlaceEnsure, proto.PlaceRequest{Client: "whombat-office-a1b2", RestPassword: "correct-horse-battery-staple"})
	if !r.OK || r.Place.Port != 8748 || !r.Place.Created {
		t.Fatalf("ensure = %+v", r)
	}
	rep := a.host.Report(time.Now(), 1, "sim")
	if len(rep.BackupPlace.Clients) != 2 || rep.FindGuest(proto.PlatformDocker, "whombat-backup-whombat-office-a1b2") == nil {
		t.Errorf("report = %+v", rep.BackupPlace)
	}
	if r.Place.Location != proto.PlaceShareName || r.Place.Path != "/mnt/user/whombat-backups/whombat-office-a1b2" || r.Place.Moved {
		t.Errorf("ensure location = %+v", r.Place)
	}
	// Another share moves it; the same one again doesn't.
	r = place(proto.OpPlaceEnsure, proto.PlaceRequest{Client: "whombat-office-a1b2", RestPassword: "correct-horse-battery-staple", Location: "Media"})
	if !r.OK || !r.Place.Moved || r.Place.Created || r.Place.Port != 8748 || r.Place.Path != "/mnt/user/Media/whombat/whombat-office-a1b2" {
		t.Errorf("move = %+v", r.Place)
	}
	if r = place(proto.OpPlaceEnsure, proto.PlaceRequest{Client: "whombat-office-a1b2", RestPassword: "correct-horse-battery-staple", Location: "Media"}); r.Place.Moved {
		t.Errorf("again = %+v", r.Place)
	}
	if r = place(proto.OpPlaceEnsure, proto.PlaceRequest{Client: "whombat-office-a1b2", RestPassword: "correct-horse-battery-staple", Location: "system"}); r.FieldErrors["location"] == "" {
		t.Errorf("system = %+v", r)
	}
	rep = a.host.Report(time.Now(), 1, "sim")
	if len(rep.BackupPlace.Locations) < 2 || rep.BackupPlace.Locations[0].ID != proto.PlaceShareName || rep.BackupPlace.Locations[0].IsNew {
		t.Errorf("locations = %+v", rep.BackupPlace.Locations)
	}
	for _, c := range rep.BackupPlace.Clients {
		if c.Client == "whombat-office-a1b2" && c.Location != "Media" {
			t.Errorf("client = %+v", c)
		}
	}
	if r = place(proto.OpPlaceCleanup, proto.PlaceRequest{Client: "whombat-office-a1b2", RepositoryPassword: "x"}); !r.OK || !r.Place.Set {
		t.Errorf("cleanup = %+v", r)
	}
	if r = place(proto.OpPlaceCleanup, proto.PlaceRequest{Client: "nobody", RepositoryPassword: "x"}); r.Code != proto.CodeNotFound {
		t.Errorf("cleanup of nobody = %+v", r)
	}
	if r = place(proto.OpPlaceNFS, proto.PlaceRequest{Name: "whombat-pve-01", Clients: []string{"10.100.1.5"}}); !r.OK || r.Place.Export != "/mnt/user/whombat-pve-01" {
		t.Errorf("nfs = %+v", r)
	}
	if r = place(proto.OpPlaceRemove, proto.PlaceRequest{Client: "whombat-office-a1b2"}); !r.OK || !r.Place.Removed {
		t.Errorf("remove = %+v", r)
	}
	if rep := a.host.Report(time.Now(), 2, "sim"); len(rep.BackupPlace.Clients) != 1 {
		t.Errorf("after remove = %+v", rep.BackupPlace)
	}
	shale := &simAgent{o: options{manage: true}, host: fakefleet.Fleet()[0], early: make(chan struct{}, 1)}
	for _, h := range fakefleet.Fleet() {
		if h.ID == simNode {
			shale.host = h
		}
	}
	add := func(export string) proto.ManageResponse {
		return shale.manage(proto.ManageRequest{Op: proto.OpStorageAdd, Platform: proto.PlatformPVE, PVEStorage: &proto.PVEStorageSpec{
			Storage: "blackbox-backup", Type: "nfs", Server: "10.30.0.40", Export: export, Content: []string{"backup"}}})
	}
	if r := add("/mnt/user/whombat-pve-01"); !r.OK {
		t.Errorf("storage = %+v", r)
	}
	if r := add("/mnt/user/whombat-pve-01"); !r.OK {
		t.Errorf("storage again = %+v", r)
	}
	if r := add("/mnt/user/other"); r.Code != proto.CodeExists {
		t.Errorf("storage taken = %+v", r)
	}
}
