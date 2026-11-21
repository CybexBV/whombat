package rules

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestUnraidHints(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	old := now.Add(-40 * 24 * time.Hour)
	u := &proto.Unraid{
		Array: proto.UnraidArray{State: proto.UnraidArrayStarted,
			Parity: proto.UnraidParity{State: "idle", Disks: 1,
				Last:    &proto.UnraidParityRun{At: old, Errors: 12, Result: "errors"},
				History: []proto.UnraidParityRun{{At: old, Errors: 12, Result: "errors"}}},
			Disks: []proto.UnraidDisk{{Name: "parity"}, {Name: "disk1", Errors: 3}, {Name: "disk2", Errors: 1}}},
		Pools:   []proto.UnraidPool{{Name: "cache", SizeBytes: 1000, UsedBytes: 950, FreeBytes: 50}, {Name: "fast", SizeBytes: 1000, UsedBytes: 100, FreeBytes: 900}},
		Plugins: []proto.UnraidPlugin{{Name: "tailscale", Update: "2"}, {Name: "ud"}},
		Notifications: []proto.UnraidNotification{{ID: "a", Importance: "alert", Subject: "Disk 1 is hot"},
			{ID: "w", Importance: "warning", Event: "Docker image almost full"}, {ID: "n", Importance: "normal", Subject: "Hello"}},
		OSUpdate: "7.3.3",
	}
	yes, no := true, false
	r := &proto.Report{Unraid: u, Docker: &proto.Platform{Guests: []proto.Guest{
		{ID: "plex", Name: "plex", UpdateAvailable: &yes}, {ID: "sonarr", Name: "sonarr", UpdateAvailable: &no}, {ID: "radarr", Name: "radarr", UpdateAvailable: &yes}}}}
	got := map[string][]Hint{}
	for _, h := range unraidHints(r, nil, now) {
		got[h.Kind] = append(got[h.Kind], h)
	}
	check := func(kind string, n int, sev, title, detail, entity string) {
		t.Helper()
		hs := got[kind]
		if len(hs) != n {
			t.Errorf("%s: %+v", kind, hs)
			return
		}
		h := hs[0]
		if h.Severity != sev || (title != "" && h.Title != title) || (detail != "" && h.Detail != detail) || (entity != "" && h.Entity != entity) {
			t.Errorf("%s: %+v", kind, h)
		}
	}
	check(HintUnraidParityErrors, 1, HintWarning, "The last parity check found 12 errors", "", "raid:unraid")
	check(HintUnraidParityOld, 1, HintInfo, "Parity not checked lately", "Last checked 7 Sep 2026", "")
	check(HintUnraidDiskErrors, 1, HintWarning, "2 disks have read or write errors", "disk1 (3 errors), disk2 (1 error)", "")
	check(HintUnraidPoolFull, 1, HintWarning, "Storage “cache” 95% full", "", "pool:cache")
	check(HintUnraidPlugins, 1, HintInfo, "1 plugin update", "tailscale", "")
	check(HintUnraidNotification, 2, HintWarning, "Disk 1 is hot", "", "a")
	if hs := got[HintUnraidNotification]; len(hs) == 2 && (hs[1].Entity != "w" || hs[1].Severity != HintInfo || hs[1].Title != "Docker image almost full") {
		t.Errorf("warning notification: %+v", hs[1])
	}
	check(HintUnraidOSUpdate, 1, HintInfo, "Unraid 7.3.3 has come out", "", "")
	check(HintDockerUpdate, 1, HintInfo, "2 apps have an update", "plex, radarr", "docker")
	if len(got[HintUnraidArrayStopped]) != 0 {
		t.Error("array stopped while started")
	}

	// Stopped, no parity disk, never checked: only the stopped array.
	u.Array.State, u.Array.Parity = proto.UnraidArrayStopped, proto.UnraidParity{State: "idle"}
	u.Array.Disks, u.Pools, u.Plugins, u.Notifications, u.OSUpdate = nil, nil, nil, nil, ""
	r.Docker = nil
	hs := unraidHints(r, nil, now)
	if len(hs) != 1 || hs[0].Kind != HintUnraidArrayStopped || hs[0].Severity != HintWarning || hs[0].Link != LinkArray {
		t.Errorf("stopped: %+v", hs)
	}
	// A parity disk never checked, started.
	u.Array.State, u.Array.Parity.Disks = proto.UnraidArrayStarted, 1
	if hs := unraidHints(r, nil, now); len(hs) != 1 || hs[0].Kind != HintUnraidParityOld || hs[0].Title != "Parity never checked" {
		t.Errorf("never: %+v", hs)
	}
	// An open space alert on the pool's mount covers the pool hint.
	u.Pools = []proto.UnraidPool{{Name: "cache", SizeBytes: 1000, UsedBytes: 950, FreeBytes: 50}}
	open := []Alert{{Rule: RuleSpaceHigh, Entity: "fs:/mnt/cache", State: AlertOpen}}
	for _, h := range unraidHints(r, open, now) {
		if h.Kind == HintUnraidPoolFull {
			t.Errorf("pool hint under an alert: %+v", h)
		}
	}
	// Not unRAID: nothing; docker.image_updates elsewhere stays.
	if hs := unraidHints(&proto.Report{}, nil, now); hs != nil {
		t.Errorf("not unRAID: %+v", hs)
	}
}

func TestUnraidRAIDLink(t *testing.T) {
	r := &proto.Report{RAID: []proto.RAIDArray{{Name: "unraid", Level: "unraid", State: "degraded", Devices: 2, Active: 1},
		{Name: "md0", Level: "raid1", State: "degraded", Devices: 2, Active: 1}}}
	for _, c := range healthConditions(r) {
		if c.Rule != RuleRAIDDegraded {
			continue
		}
		want := LinkStorage
		if c.Entity == "raid:unraid" {
			want = LinkArray
		}
		if c.Link != want {
			t.Errorf("%s link %q", c.Entity, c.Link)
		}
	}
}
