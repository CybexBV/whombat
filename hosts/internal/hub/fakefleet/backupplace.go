package fakefleet

import (
	"time"

	"rackoon/internal/proto"
)

// blackbox as a backup place (docs/MANAGE.md 2.10): it keeps the backups
// of one Whombat (PlaceClient) on port 8747 in the share whombat-backups,
// cleared a day ago, and can share folders over NFS. Its locations are
// built from its shares with the report. The images are the agent's
// pinned ones.

// PlaceClient is the Whombat whose backups blackbox keeps.
const PlaceClient = "whombat-home-4hxx"

// The pinned images (internal/agent/broker/backupplace.go).
const (
	PlaceRestImage    = "restic/rest-server@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5"
	PlaceCleanupImage = "restic/restic@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76"
)

// placeGuests are a client's two containers.
func placeGuests(client string) []GuestSpec {
	srv := dk("whombat-backup-"+client, PlaceRestImage, 0.1, 18, 0, 6*86400)
	cl := dk("whombat-backup-"+client+"-cleanup", PlaceCleanupImage, 0, 2, 0, 6*86400)
	on := true
	srv.UnraidTemplate, srv.Autostart = true, &on
	cl.UnraidTemplate, cl.Autostart = true, &on
	return []GuestSpec{srv, cl}
}

// PlaceClientSpec is a client as a fresh setup in a location leaves it
// (with the kit user).
func PlaceClientSpec(client string, port int, location string) proto.BackupPlaceClient {
	used := uint64(0)
	kit := true
	return proto.BackupPlaceClient{Client: client, Location: location, Port: port, Running: true, Image: PlaceRestImage, UsedBytes: &used,
		Kit: &kit}
}

func blackboxPlace() *proto.BackupPlace {
	free, total := uint64(1_900_000_000_000), uint64(2_000_000_000_000)
	used := uint64(123_456_789_000)
	last := Ref.Add(-26 * time.Hour).UTC()
	ok := true
	c := PlaceClientSpec(PlaceClient, proto.PlaceFirstPort, proto.PlaceShareName)
	c.UsedBytes = &used
	c.Cleanup = proto.BackupPlaceCleanup{Set: true, Running: true, KeepWithinDays: 90, LastRunAt: &last, LastOK: &ok}
	// Set up before REST servers had the kit user: an ensure adds it.
	noKit := false
	c.Kit = &noKit
	return &proto.BackupPlace{Supported: true, Platform: proto.PlacePlatformUnraid, Root: "/mnt/user/" + proto.PlaceShareName,
		FreeBytes: &free, TotalBytes: &total, Addresses: []string{"10.30.0.40"}, NFS: true, Clients: []proto.BackupPlaceClient{c}}
}

// PlaceState returns a copy of the host's backup place (nil: none).
func (h *Host) PlaceState() *proto.BackupPlace {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.placeCopy()
}

// placeCopy is PlaceState for callers that hold h.mu (Report).
func (h *Host) placeCopy() *proto.BackupPlace {
	if h.BackupPlace == nil {
		return nil
	}
	bp := *h.BackupPlace
	bp.Addresses = append([]string(nil), h.BackupPlace.Addresses...)
	bp.Clients = append([]proto.BackupPlaceClient(nil), h.BackupPlace.Clients...)
	return &bp
}

// UpdatePlace changes the host's backup place in place; false when it
// has none.
func (h *Host) UpdatePlace(f func(bp *proto.BackupPlace)) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.BackupPlace == nil {
		return false
	}
	f(h.BackupPlace)
	return true
}

// PlaceGuests returns a client's two container specs (for a simulated
// setup).
func PlaceGuests(client string) []GuestSpec { return placeGuests(client) }
