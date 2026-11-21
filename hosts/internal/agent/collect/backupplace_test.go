package collect

import (
	"testing"

	"rackoon/internal/proto"
)

// TestPlaceLocationsBlackbox builds the backup locations from BlackBox's
// real shares.ini, sec.ini and sec_nfs.ini (Unraid 7.3.1).
func TestPlaceLocationsBlackbox(t *testing.T) {
	d := collectBlackbox(t, blackbox)
	p := &placeCollector{last: &proto.BackupPlace{Supported: true, Platform: proto.PlacePlatformUnraid, Root: proto.PlaceRootUnraid,
		Clients: []proto.BackupPlaceClient{{Client: "whombat-home-4hxx", Location: proto.PlaceShareName}}}}
	bp := p.snapshot([]string{"10.100.0.40"}, d)
	locs := bp.Locations
	if len(locs) != 17 { // the dedicated share and every share but system
		t.Fatalf("locations: %d %+v", len(locs), locs)
	}
	ded := locs[0]
	if ded.ID != "whombat-backups" || ded.Name != "whombat-backups" || !ded.IsNew || ded.Primary != "array" || ded.Path != "/mnt/user/whombat-backups" ||
		ded.SMB != "" || ded.NFS || ded.FreeBytes == nil || *ded.FreeBytes != 1938913108*1024 {
		t.Errorf("dedicated = %+v", ded)
	}
	byID := map[string]proto.BackupPlaceLocation{}
	for _, l := range locs {
		byID[l.ID] = l
	}
	if _, ok := byID["system"]; ok {
		t.Error("system is offered")
	}
	m := byID["Media"]
	if m.Name != "Media" || m.IsNew || m.Path != "/mnt/user/Media/whombat" || m.SMB != "private" || m.Primary != "data" ||
		m.FreeBytes == nil || *m.FreeBytes != 46588457604*1024 {
		t.Errorf("Media = %+v", m)
	}
	if a := byID["appdata"]; a.Path != "/mnt/user/appdata/whombat" || a.Primary != "apps" || a.SMB != "" {
		t.Errorf("appdata = %+v", a)
	}
	if !byID["PVE-Backup"].NFS || byID["Media"].NFS {
		t.Errorf("NFS: %+v %+v", byID["PVE-Backup"], byID["Media"])
	}
	// Once the share is there, it is one location, with its own settings.
	d.Shares = append(d.Shares, proto.UnraidShare{Name: "whombat-backups", Primary: "apps", FreeBytes: 5})
	locs = proto.PlaceLocations(bp, d, nil)
	if len(locs) != 17 || locs[0].IsNew || locs[0].Primary != "apps" || *locs[0].FreeBytes != 5 {
		t.Errorf("existing dedicated = %+v", locs[0])
	}
}
