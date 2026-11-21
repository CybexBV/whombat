package proto

import "testing"

func TestPlaceLocationsLinuxAndPools(t *testing.T) {
	free := uint64(42)
	locs := PlaceLocations(&BackupPlace{Platform: PlacePlatformLinux, FreeBytes: &free}, nil, func(string) bool { return false })
	if len(locs) != 1 || locs[0].ID != "srv" || locs[0].Name != "this server" || locs[0].Path != "/srv/whombat-backups" ||
		!locs[0].IsNew || locs[0].FreeBytes != &free {
		t.Errorf("linux = %+v", locs)
	}
	// Unraid without array disks: a new share goes on the first pool.
	u := &Unraid{Pools: []UnraidPool{{Name: "zcache", FreeBytes: 1}, {Name: "apps", FreeBytes: 7}},
		Shares: []UnraidShare{{Name: "system"}, {Name: "bad/name"}, {Name: "Backups", SMB: "public", NFS: true, Primary: "zcache", FreeBytes: 3}}}
	locs = PlaceLocations(&BackupPlace{Platform: PlacePlatformUnraid}, u, nil)
	if len(locs) != 2 || locs[0].Primary != "apps" || *locs[0].FreeBytes != 7 || !locs[0].IsNew ||
		locs[1].ID != "Backups" || locs[1].SMB != "public" || !locs[1].NFS || locs[1].Path != "/mnt/user/Backups/whombat" {
		t.Errorf("pools = %+v", locs)
	}
	// Without Unraid's report: only the dedicated share, space unknown.
	if locs = PlaceLocations(&BackupPlace{Platform: PlacePlatformUnraid}, nil, nil); len(locs) != 1 || locs[0].FreeBytes != nil {
		t.Errorf("no report = %+v", locs)
	}
	for id, ok := range map[string]bool{"Media": true, "PBS-Backup": true, "My Files": true, "": false, "../x": false, "a/b": false,
		".hidden": false, "x ": false, "a..b": false} {
		if ValidPlaceLocation(id) != ok {
			t.Errorf("ValidPlaceLocation(%q) = %v", id, !ok)
		}
	}
}
