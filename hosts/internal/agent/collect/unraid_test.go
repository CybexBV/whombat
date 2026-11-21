package collect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// blackbox is a copy of BlackBox's real unRAID 7.3.1 files (read-only
// copies, serials, GUIDs, the CSRF token, user lists and template
// secrets taken out; plugin files cut after their <PLUGIN> tag).
const blackbox = "testdata/unraid-7.3.1"

func collectBlackbox(t *testing.T, root string) *proto.Unraid {
	t.Helper()
	u := newUnraidCollector(fsRoot(root), nil)
	d, _, err := u.collect()
	if err != nil && !isPartial(err) {
		t.Fatal(err)
	}
	if d == nil {
		t.Fatal("no detail")
	}
	return d
}

func TestUnraidBlackbox(t *testing.T) {
	d := collectBlackbox(t, blackbox)
	if d.Version != "7.3.1" || d.Name != "BlackBox" || d.License != "Pro" || d.OSUpdate != "7.3.3" {
		t.Errorf("identity: %q %q %q update %q", d.Version, d.Name, d.License, d.OSUpdate)
	}
	a := d.Array
	if a.State != "started" || a.StateRaw != "STARTED" || a.StartOnBoot || !a.ConfigValid || a.MoverRunning {
		t.Errorf("array: %+v", a)
	}
	// The two parity slots have no disk (parity not installed, as
	// unRAID's Main page shows it); disk2-22 are empty slots: md's
	// mdNumDisabled=2 / mdNumInvalid=2 count the parity slots, the report
	// does not.
	if len(a.Disks) != 1 || a.Disabled != 0 || a.Invalid != 0 || a.Missing != 0 {
		t.Fatalf("array disks %+v (disabled %d invalid %d)", a.Disks, a.Disabled, a.Invalid)
	}
	d1 := a.Disks[0]
	if d1.Name != "disk1" || d1.Slot != "data" || d1.Device != "sdi" || d1.Status != "ok" || d1.StatusRaw != "DISK_OK" ||
		d1.SizeBytes != 1953513560*1024 || d1.FSType != "xfs" || d1.TempC == nil || *d1.TempC != 31 || d1.SpunDown ||
		d1.Rotational == nil || *d1.Rotational || d1.Model != "WDC WDS200T1R0A-68A4W0" || d1.Serial == "" {
		t.Errorf("disk1: %+v", d1)
	}
	if d1.UsedBytes == nil || *d1.UsedBytes != 13646588*1024 || *d1.FreeBytes != 1938913108*1024 {
		t.Errorf("disk1 use: %v %v", d1.UsedBytes, d1.FreeBytes)
	}
	if a.SizeBytes != 1952559696*1024 || a.UsedBytes != 13646588*1024 || a.FreeBytes != 1938913108*1024 {
		t.Errorf("array size %d used %d free %d", a.SizeBytes, a.UsedBytes, a.FreeBytes)
	}

	// Parity: none installed, no check since the reboot (sbSynced 0): the
	// history's newest line is the last check (cancelled after 52 s).
	p := a.Parity
	if p.State != "idle" || p.Disks != 0 || p.Pct != nil || p.Schedule != "" || len(p.History) != 8 {
		t.Errorf("parity: %+v", p)
	}
	at := func(s string) time.Time {
		loc, _ := time.LoadLocation("Europe/Amsterdam")
		v, err := time.ParseInLocation("2006-01-02 15:04:05", s, loc)
		if err != nil {
			t.Fatal(err)
		}
		return v.UTC()
	}
	if p.Last == nil || !p.Last.At.Equal(at("2024-07-10 20:32:54")) || p.Last.Result != "cancelled" || p.Last.Action != "check" ||
		p.Last.DurationS == nil || *p.Last.DurationS != 52 || p.Last.SpeedMBs != nil {
		t.Errorf("last: %+v", p.Last)
	}
	old := p.History[len(p.History)-1] // 2023 Jun 30 13:17:38, the parity sync
	if !old.At.Equal(at("2023-06-30 13:17:38")) || old.Action != "sync" || old.Result != "ok" || old.SpeedMBs == nil || *old.SpeedMBs != 354.4 {
		t.Errorf("oldest: %+v", old)
	}
	if h := p.History[5]; h.Errors != 1 || h.Result != "errors" { // 2023 Jul 18: 1 error
		t.Errorf("history[5]: %+v", h)
	}
	if h := p.History[2]; h.Action != "rebuild" { // 2023 Nov 19 recon D1 D2
		t.Errorf("history[2]: %+v", h)
	}

	// Pools by their configuration files, in slot order.
	if len(d.Pools) != 3 {
		t.Fatalf("pools: %+v", d.Pools)
	}
	apps, data, storage := d.Pools[0], d.Pools[1], d.Pools[2]
	if apps.Name != "apps" || apps.FSType != "luks:btrfs" || apps.Profile != "raid10" || apps.Status != "ONLINE" || len(apps.Disks) != 4 ||
		apps.SizeBytes != 1953490352*1024 || apps.UsedBytes != 38192080*1024 || apps.FreeBytes != 1913922272*1024 {
		t.Errorf("apps: %+v", apps)
	}
	if apps.Disks[1].Name != "apps2" || apps.Disks[1].Pool != "apps" || apps.Disks[1].Slot != "pool" || apps.Disks[1].UsedBytes != nil ||
		apps.Disks[0].UsedBytes == nil || apps.Disks[1].Device != "sdc" {
		t.Errorf("apps disks: %+v", apps.Disks)
	}
	if data.Name != "data" || data.Profile != "raid6" || len(data.Disks) != 9 || storage.Name != "storage" || storage.Profile != "raid1" || len(storage.Disks) != 2 {
		t.Errorf("data %s %s %d, storage %s %s %d", data.Name, data.Profile, len(data.Disks), storage.Name, storage.Profile, len(storage.Disks))
	}
	if r := data.Disks[0].Rotational; r == nil || !*r {
		t.Errorf("data disk rotational: %v", r)
	}
	if f := d.Flash; f == nil || f.Name != "flash" || f.Slot != "flash" || f.Device != "sda" || f.FSType != "vfat" || f.UsedBytes == nil ||
		*f.UsedBytes != 2155936*1024 || f.TempC != nil {
		t.Errorf("flash: %+v", d.Flash)
	}

	// Shares.
	if len(d.Shares) != 17 {
		t.Fatalf("shares: %d", len(d.Shares))
	}
	sh := map[string]proto.UnraidShare{}
	for _, s := range d.Shares {
		sh[s.Name] = s
	}
	if m := sh["Media"]; m.Primary != "data" || m.Secondary != "" || m.MoverAction != "" || m.SMB != "private" || m.NFS || !m.Encrypted ||
		m.UsedBytes != 21790528028*1024 || m.FreeBytes != 46588457604*1024 {
		t.Errorf("Media: %+v", m)
	}
	if m := sh["appdata"]; m.Primary != "apps" || m.SMB != "" {
		t.Errorf("appdata: %+v", m)
	}
	var arrayShares int
	for _, s := range d.Shares {
		if s.Primary == "array" {
			arrayShares++
		}
	}
	if arrayShares != 2 { // two shares with useCache="no"
		t.Errorf("array shares: %d", arrayShares)
	}

	// Plugins: eleven installed (unRAID itself left out), none newer.
	if len(d.Plugins) != 11 {
		t.Fatalf("plugins: %+v", d.Plugins)
	}
	pl := map[string]proto.UnraidPlugin{}
	for _, x := range d.Plugins {
		pl[x.File] = x
		if x.Update != "" {
			t.Errorf("update for %s: %s", x.File, x.Update)
		}
	}
	if x := pl["tailscale.plg"]; x.Name != "tailscale" || x.Version != "2026.10.08.2310" || x.Author == "" {
		t.Errorf("tailscale: %+v", x)
	}
	if x := pl["community.applications.plg"]; x.Name != "community.applications" || x.Version != "2026.07.21" || x.Author != "Lime Technology" ||
		x.SupportURL != "https://forums.unraid.net/topic/38582-plug-in-community-applications" {
		t.Errorf("community.applications: %+v", x)
	}
	if x := pl["unassigned.devices-plus.plg"]; x.Version != "2025.08.05a" {
		t.Errorf("unassigned.devices-plus: %+v", x)
	}
	if d.PluginsCheckedAt.IsZero() {
		t.Error("plugins checked at")
	}

	// Notifications: newest first.
	if d.NotificationsUnread != 5 || len(d.Notifications) != 5 {
		t.Fatalf("notifications: %d %+v", d.NotificationsUnread, d.Notifications)
	}
	n := d.Notifications
	if n[0].ID != "Unraid_Parity_check_1792210000" || n[0].Importance != "alert" || n[0].Description != `Duration: 5 hours, 10 minutes "see the log"` ||
		n[1].Importance != "warning" || n[2].Event != "System - Unraid [7.3.3]" || n[2].Importance != "normal" ||
		!n[4].At.Equal(time.Unix(1788135003, 0).UTC()) || n[4].Subject != "Notice [BLACKBOX] - Version update 2026.08.29.1446" {
		t.Errorf("notifications: %+v", n)
	}

	if !d.Docker.Enabled || d.Docker.ImageUsedPct == nil || *d.Docker.ImageUsedPct != 78 || !d.VMs.Enabled {
		t.Errorf("services: %+v %+v", d.Docker, d.VMs)
	}
	if !d.Encrypted || d.KeyfilePresent || d.LANAddress != "10.100.0.40" {
		t.Errorf("encrypted %v keyfile %v lan %q", d.Encrypted, d.KeyfilePresent, d.LANAddress)
	}
}

// copyTree copies a test tree so a test can change it.
func copyTree(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func TestUnraidRunningCheckUpdatesSchedule(t *testing.T) {
	root := copyTree(t, blackbox)
	set := func(p string, edit func(string) string) {
		b, err := os.ReadFile(filepath.Join(root, p))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, p), []byte(edit(string(b))), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A parity check with corrections at 25 %, 1 GiB in the last 10 s, 3
	// errors so far.
	set("var/local/emhttp/var.ini", func(s string) string {
		return strings.NewReplacer(`mdResync="0"`, `mdResync="1953513560"`, `mdResyncPos="0"`, `mdResyncPos="488378390"`,
			`mdResyncDb="0"`, `mdResyncDb="1048576"`, `mdResyncDt="0"`, `mdResyncDt="10"`, `mdResyncCorr="0"`, `mdResyncCorr="1"`,
			`mdResyncAction="check"`, `mdResyncAction="check P"`, `sbSyncErrs="0"`, `sbSyncErrs="3"`,
			`shareMoverActive="no"`, `shareMoverActive="yes"`).Replace(s)
	})
	// A monthly schedule, a newer plugin and a disabled disk.
	set("boot/config/plugins/dynamix/dynamix.cfg", func(s string) string {
		return s + "[parity]\nmode=\"3\"\ndotm=\"1\"\nhour=\"30 0\"\nwrite=\"NOCORRECT\"\n"
	})
	set("tmp/plugins/tailscale.plg", func(s string) string { return strings.ReplaceAll(s, "2026.10.08.2310", "2026.10.15.0900") })
	set("var/local/emhttp/disks.ini", func(s string) string {
		i := strings.Index(s, `["disk1"]`)
		return s[:i] + strings.Replace(s[i:], `status="DISK_OK"`, `status="DISK_DSBL"`, 1)
	})
	d := collectBlackbox(t, root)
	p := d.Array.Parity
	if p.State != "running" || p.Action != "correct" || p.Pct == nil || *p.Pct != 25 || p.SpeedMBs == nil || *p.SpeedMBs != 107.4 ||
		p.ETAS == nil || *p.ETAS != 13972 || p.Errors != 3 || p.Last == nil || p.Last.Result != "cancelled" {
		t.Errorf("running: %+v", p)
	}
	if p.Schedule != "Monthly, day 1 at 00:30, no corrections" {
		t.Errorf("schedule %q", p.Schedule)
	}
	if !d.Array.MoverRunning || d.Array.Disabled != 1 || d.Array.Disks[0].Status != "disabled" {
		t.Errorf("array: %+v", d.Array)
	}
	for _, x := range d.Plugins {
		if x.File == "tailscale.plg" && x.Update != "2026.10.15.0900" {
			t.Errorf("tailscale update %q", x.Update)
		}
	}
	// Paused: md stops (mdResync 0) and keeps its position.
	set("var/local/emhttp/var.ini", func(s string) string {
		return strings.Replace(s, `mdResync="1953513560"`, `mdResync="0"`, 1)
	})
	if p := collectBlackbox(t, root).Array.Parity; p.State != "paused" || p.SpeedMBs != nil || p.Pct == nil {
		t.Errorf("paused: %+v", p)
	}
	// unRAID's update check ignored 7.3.3.
	if err := os.WriteFile(filepath.Join(root, "tmp/unraidcheck/ignored.json"), []byte(`{"updateOsIgnoredReleases":["7.3.3"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if d := collectBlackbox(t, root); d.OSUpdate != "" {
		t.Errorf("ignored release reported: %q", d.OSUpdate)
	}
	// Stopped and not able to start.
	set("var/local/emhttp/var.ini", func(s string) string {
		return strings.NewReplacer(`mdState="STARTED"`, `mdState="STOPPED"`, `fsState="Started"`, `fsState="Stopped"`).Replace(s)
	})
	if a := collectBlackbox(t, root).Array; a.State != "stopped" {
		t.Errorf("stopped: %q", a.State)
	}
}

func TestParitySchedule(t *testing.T) {
	for _, c := range []struct {
		in   map[string]string
		want string
	}{
		{map[string]string{"mode": "0"}, ""},
		{map[string]string{"mode": "1", "hour": "0 3", "write": ""}, "Daily at 03:00, with corrections"},
		{map[string]string{"mode": "2", "day": "0", "hour": "30 1", "write": "NOCORRECT"}, "Weekly on Sunday at 01:30, no corrections"},
		{map[string]string{"mode": "3", "dotm": "28-31", "hour": "0 2", "write": "NOCORRECT", "cumulative": "1"}, "Monthly, last day at 02:00, no corrections, in parts"},
		{map[string]string{"mode": "4", "month": "4", "dotm": "1", "hour": "0 4", "write": "NOCORRECT"}, "Yearly, April day 1 at 04:00, no corrections"},
		{map[string]string{"mode": "5", "day": "1,4", "dotm": "W1", "month": "1,7", "hour": "0 5", "write": "NOCORRECT"}, "Custom, Monday, Thursday, first week of January, July at 05:00, no corrections"},
	} {
		if got := paritySchedule(c.in); got != c.want {
			t.Errorf("%v: %q, want %q", c.in, got, c.want)
		}
	}
}

func TestUnraidDiskStatusAndIDs(t *testing.T) {
	for raw, want := range map[string]string{"DISK_OK": "ok", "DISK_DSBL": "disabled", "DISK_NP_MISSING": "missing", "DISK_INVALID": "invalid",
		"DISK_WRONG": "wrong", "DISK_NEW": "new", "DISK_DSBL_NEW": "new", "DISK_NP": "", "DISK_SOMETHING": "invalid"} {
		if got := unraidDiskStatus(raw, "data"); got != want {
			t.Errorf("%s: %q", raw, got)
		}
	}
	if unraidDiskStatus("DISK_NP_DSBL", "parity") != "" || unraidDiskStatus("DISK_NP_DSBL", "data") != "emulated" {
		t.Error("DISK_NP_DSBL")
	}
	if m, s := unraidModelSerial("ST10000NE0008-2PL103_ZS5028CY"); m != "ST10000NE0008-2PL103" || s != "ZS5028CY" {
		t.Errorf("%q %q", m, s)
	}
	if unraidPoolOf("apps2", []string{"apps", "app"}) != "apps" || unraidPoolOf("cache10", []string{"cache", "cache1"}) != "cache1" ||
		unraidPoolOf("data", []string{"data", "data2"}) != "data" {
		t.Error("pool membership")
	}
}

func TestPlgHeaderAndVersions(t *testing.T) {
	h, ok := parsePlgHeader([]byte(`<?xml version='1.0'?>
<!DOCTYPE PLUGIN [
<!ENTITY name "x.y">
<!ENTITY ver "2026.10.12">
<!ENTITY version "&ver;b">
]>
<PLUGIN name="&name;" author='Me &amp; you' version="&version;" support="https://x/&name;" icon="a>b">`))
	if !ok || h.Name != "x.y" || h.Version != "2026.10.12b" || h.Author != "Me & you" || h.Support != "https://x/x.y" {
		t.Errorf("%+v %v", h, ok)
	}
	if _, ok := parsePlgHeader([]byte("not a plugin")); ok {
		t.Error("garbage parsed")
	}
	for _, c := range [][2]string{{"2026.10.12", "2026.9.30"}, {"2026.08.29.1446", "2026.08.06.0154"}, {"7.3.3", "7.3.1"}, {"2025.08.05a", "2025.08.05"}} {
		if !versionNewer(c[0], c[1]) || versionNewer(c[1], c[0]) {
			t.Errorf("%s vs %s", c[0], c[1])
		}
	}
	if versionNewer("2026.10.12", "2026.10.12") {
		t.Error("equal versions")
	}
}

func TestDockerManImageKeyAndUpdate(t *testing.T) {
	for in, want := range map[string]string{
		"lscr.io/linuxserver/sonarr":           "lscr.io/linuxserver/sonarr:latest",
		"lscr.io/linuxserver/radarr:latest":    "lscr.io/linuxserver/radarr:latest",
		"redis":                                "library/redis:latest",
		"registry:5000/team/app:1.2":           "registry:5000/team/app:1.2",
		"docker.io/redis:6.2-alpine@sha256:2d": "docker.io/redis:2d",
		"sha256:abcdef":                        "",
	} {
		if got := dockerManImageKey(in); got != want {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
	st := parseUpdateStatus(readTestdata(t, "unraid-7.3.1/var/lib/docker/unraid-update-status.json"))
	if u := dockerManUpdate(st, "ghcr.io/immich-app/immich-server:release"); u == nil || !*u {
		t.Errorf("immich-server: %v", u)
	}
	if u := dockerManUpdate(st, "lscr.io/linuxserver/sonarr"); u == nil || *u {
		t.Errorf("sonarr: %v", u)
	}
	if u := dockerManUpdate(st, "lscr.io/linuxserver/overseerr:latest"); u != nil {
		t.Errorf("overseerr (undef): %v", *u)
	}
	if u := dockerManUpdate(st, "nginx"); u != nil {
		t.Errorf("unknown image: %v", *u)
	}
}

func TestUnraidEnrichDocker(t *testing.T) {
	u := newUnraidCollector(fsRoot(blackbox), nil)
	if err := u.run(t.Context()); err != nil && !isPartial(err) {
		t.Fatal(err)
	}
	p := &proto.Platform{Guests: []proto.Guest{
		{ID: "plex", Image: "lscr.io/linuxserver/plex"},
		{ID: "sonarr", Image: "lscr.io/linuxserver/sonarr"},
		{ID: "immich_server", Image: "ghcr.io/immich-app/immich-server:release"},
		{ID: "overseerr", Image: "lscr.io/linuxserver/overseerr:latest", Addresses: []string{"10.100.1.50"}},
	}}
	yes := true
	p.Guests[3].UpdateAvailable = &yes // the agent's own registry check, kept when dockerMan does not know
	extras := map[string]dockerExtra{
		"plex":   {image: "lscr.io/linuxserver/plex", networkMode: "host"},
		"sonarr": {image: "lscr.io/linuxserver/sonarr", networkMode: "bridge", ports: []dockerPort{{PrivatePort: 8989, PublicPort: 18989, Type: "tcp"}}},
		"overseerr": {image: "lscr.io/linuxserver/overseerr:latest", networkMode: "br0",
			webUI: "http://[IP]:[PORT:5055]"},
	}
	u.enrichDocker(p, extras, []string{"192.0.2.1"})
	g := map[string]proto.Guest{}
	for _, x := range p.Guests {
		g[x.ID] = x
	}
	if x := g["plex"]; x.Autostart == nil || !*x.Autostart || !x.UnraidTemplate || x.WebUI != "http://10.100.0.40:32400/web/index.html" ||
		x.UpdateAvailable == nil || *x.UpdateAvailable {
		t.Errorf("plex: %+v", x)
	}
	if x := g["sonarr"]; x.WebUI != "http://10.100.0.40:18989/system/status" {
		t.Errorf("sonarr: %+v", x)
	}
	if x := g["immich_server"]; x.Autostart == nil || *x.Autostart || x.UnraidTemplate || x.WebUI != "" || x.UpdateAvailable == nil || !*x.UpdateAvailable {
		t.Errorf("immich_server: %+v", x)
	}
	// A macvlan container: its own address; dockerMan's label wins.
	if x := g["overseerr"]; x.WebUI != "http://10.100.1.50:5055" || x.UpdateAvailable == nil || !*x.UpdateAvailable {
		t.Errorf("overseerr: %+v", x)
	}
}

func TestResolveWebUI(t *testing.T) {
	if got := resolveWebUI("http://nas.local:8080/", "10.0.0.2", "bridge", nil, nil); got != "http://nas.local:8080/" {
		t.Errorf("own URL: %q", got)
	}
	if got := resolveWebUI("http://[IP]:[PORT:80]", "", "bridge", nil, nil); got != "" {
		t.Errorf("no address: %q", got)
	}
	if got := resolveWebUI("javascript:[IP]", "10.0.0.2", "host", nil, nil); got != "" {
		t.Errorf("not http: %q", got)
	}
	if got := resolveWebUI("https://[IP]:[PORT:443]/", "fd00::2", "host", nil, nil); got != "https://[fd00::2]:443/" {
		t.Errorf("IPv6: %q", got)
	}
}

func TestUnraidAbsentElsewhere(t *testing.T) {
	u := newUnraidCollector(fsRoot(t.TempDir()), nil)
	if err := u.run(t.Context()); err != nil {
		t.Fatal(err)
	}
	if u.snapshot(&proto.Report{}) != nil {
		t.Error("detail on a host without unRAID")
	}
}
