package model

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Guest is the guest object (API.md 2.3). The key set depends on the
// platform: Docker has last_exit and no vcpu / I/O / snapshots; Proxmox adds
// vmid, node and last_backup.
type Guest struct {
	ID            string
	Name          string
	Platform      string
	Kind          string
	Image         string
	State         string
	VCPU          *int
	CPUPct        *float64
	MemoryUsedMB  *int64
	MemoryLimitMB *int64
	DiskReadMBs   *float64
	DiskWriteMBs  *float64
	NetRxMbps     *float64
	NetTxMbps     *float64
	Snapshots     *int
	UptimeS       *int64
	LastExit      *Time
	Console       GuestConsole
	VMID          *int
	Node          *string
	LastBackup    *LastBackup
	// Optional keys, written only when known (host health additions).
	Addresses []string
	Lock      string
	Restarts  *int
	ExitCode  *int
	OOMKilled bool
	Project   string
	// Labels: the container's labels Whombat reads (`whombat.service`).
	Labels          map[string]string
	UpdateAvailable *bool
	DiskUsedGB      *float64
	Processes       *int
	// ImageID: the id of the image a container runs, when its agent says it.
	ImageID string
	// Proxmox management additions (docs/MANAGE.md), written when known.
	Tags           []string
	PendingChanges int
	GuestAgent     string
	OldestSnapshot *Time
	BackupJob      *bool
	HAState        string
	// Self: the guest is the machine this Whombat runs in (IU-02).
	Self bool
	// unRAID additions (docs/MANAGE.md 2.6), written when known: autostart
	// (Docker on unRAID, libvirt), the web page link and whether a
	// dockerMan template exists (Docker on unRAID).
	Autostart *bool
	WebUI     string
	Template  *bool
	// libvirt (libvirt.go): the newest snapshot (LastBackup: the newest
	// Whombat backup).
	LastSnapshot *Time
	// App: a Docker container Compose started, which Whombat can update
	// (docs/MANAGE.md 2.11); only agents that can update apps say so.
	App *GuestApp
}

// GuestApp is a Compose app's update state: its service, its version and the
// newer image's when known, why it can't be updated, whether an update runs
// now, and how the last one went. NewDigest (the newer image's registry
// digest) and ConfigHash (Compose's hash of the service's settings) are
// what an update sends back as `expect`, when the agent says them.
type GuestApp struct {
	Service    string   `json:"service"`
	Version    *string  `json:"version"`
	NewVersion *string  `json:"new_version"`
	Blocked    *string  `json:"blocked"`
	Updating   bool     `json:"updating"`
	Last       *AppLast `json:"last"`
	NewDigest  *string  `json:"new_digest,omitempty"`
	ConfigHash *string  `json:"config_hash,omitempty"`
}

// AppLast is a Compose app's last update: updated, current (nothing newer),
// rolled_back, held (a new major version waits for the person) or failed.
type AppLast struct {
	Status string  `json:"status"`
	Reason *string `json:"reason"`
	From   *string `json:"from"`
	To     *string `json:"to"`
	At     *Time   `json:"at"`
}

func optText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func buildGuestApp(a *proto.GuestApp) *GuestApp {
	if a == nil {
		return nil
	}
	out := &GuestApp{Service: a.Service, Version: optText(a.Version), NewVersion: optText(a.NewVersion),
		Blocked: optText(a.Blocked), Updating: a.Updating, NewDigest: optText(a.NewDigest), ConfigHash: optText(a.ConfigHash)}
	if l := a.Last; l != nil {
		out.Last = &AppLast{Status: l.Status, Reason: optText(l.Reason), From: optText(l.From), To: optText(l.To), At: T(l.Finished)}
	}
	return out
}

// GuestConsole is the guest's console capability.
type GuestConsole struct {
	Available       bool              `json:"available"`
	Protocols       []string          `json:"protocols"`
	DefaultProtocol *string           `json:"default_protocol"`
	Resolution      *string           `json:"resolution"`
	Unavailable     map[string]string `json:"unavailable,omitempty"`
	docker          bool
}

// MarshalJSON renders {"available": false} for Docker.
func (c GuestConsole) MarshalJSON() ([]byte, error) {
	if c.docker {
		return []byte(`{"available":false}`), nil
	}
	type plain GuestConsole
	if c.Protocols == nil {
		c.Protocols = []string{}
	}
	return json.Marshal(plain(c))
}

// LastBackup is a Proxmox guest's latest backup.
type LastBackup struct {
	Result string `json:"result"`
	At     Time   `json:"at"`
}

type kv struct {
	k string
	v any
}

// MarshalJSON writes the platform-specific key set in fixture order.
func (g Guest) MarshalJSON() ([]byte, error) {
	f := []kv{
		{"id", g.ID}, {"name", g.Name}, {"platform", g.Platform}, {"kind", g.Kind}, {"image", g.Image},
		{"state", g.State},
	}
	docker := g.Platform == proto.PlatformDocker
	if !docker {
		f = append(f, kv{"vcpu", g.VCPU})
	}
	f = append(f, kv{"cpu_pct", g.CPUPct}, kv{"memory_used_mb", g.MemoryUsedMB}, kv{"memory_limit_mb", g.MemoryLimitMB})
	if !docker {
		f = append(f, kv{"disk_read_mbs", g.DiskReadMBs}, kv{"disk_write_mbs", g.DiskWriteMBs},
			kv{"net_rx_mbps", g.NetRxMbps}, kv{"net_tx_mbps", g.NetTxMbps}, kv{"snapshots", g.Snapshots})
	}
	f = append(f, kv{"uptime_s", g.UptimeS})
	if docker {
		f = append(f, kv{"last_exit", g.LastExit})
	}
	f = append(f, kv{"console", g.Console})
	if g.Platform == proto.PlatformPVE {
		f = append(f, kv{"vmid", g.VMID}, kv{"node", g.Node}, kv{"last_backup", g.LastBackup})
	}
	if len(g.Addresses) > 0 {
		f = append(f, kv{"addresses", g.Addresses})
	}
	if g.Lock != "" {
		f = append(f, kv{"lock", g.Lock})
	}
	if g.Restarts != nil {
		f = append(f, kv{"restarts", g.Restarts})
	}
	if g.ExitCode != nil {
		f = append(f, kv{"exit_code", g.ExitCode})
	}
	if g.OOMKilled {
		f = append(f, kv{"oom_killed", true})
	}
	if g.Project != "" {
		f = append(f, kv{"project", g.Project})
	}
	if len(g.Labels) > 0 {
		f = append(f, kv{"labels", g.Labels})
	}
	if g.UpdateAvailable != nil {
		f = append(f, kv{"update_available", g.UpdateAvailable})
	}
	if g.App != nil {
		f = append(f, kv{"app", g.App})
	}
	if g.ImageID != "" {
		f = append(f, kv{"image_id", g.ImageID})
	}
	if g.DiskUsedGB != nil {
		f = append(f, kv{"disk_used_gb", g.DiskUsedGB})
	}
	if g.Processes != nil {
		f = append(f, kv{"processes", g.Processes})
	}
	if len(g.Tags) > 0 {
		f = append(f, kv{"tags", g.Tags})
	}
	if g.PendingChanges > 0 {
		f = append(f, kv{"pending_changes", g.PendingChanges})
	}
	if g.GuestAgent != "" {
		f = append(f, kv{"guest_agent", g.GuestAgent})
	}
	if g.OldestSnapshot != nil {
		f = append(f, kv{"oldest_snapshot", g.OldestSnapshot})
	}
	if g.BackupJob != nil {
		f = append(f, kv{"backup_job", g.BackupJob})
	}
	if g.HAState != "" {
		f = append(f, kv{"ha_state", g.HAState})
	}
	if g.Self {
		f = append(f, kv{"self", true})
	}
	if g.Autostart != nil {
		f = append(f, kv{"autostart", g.Autostart})
	}
	if g.WebUI != "" {
		f = append(f, kv{"web_ui", g.WebUI})
	}
	if g.Template != nil {
		f = append(f, kv{"template", g.Template})
	}
	f = append(f, libvirtGuestKV(g)...)
	var b bytes.Buffer
	b.WriteByte('{')
	for i, x := range f {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Quote(x.k))
		b.WriteByte(':')
		vb, err := json.Marshal(x.v)
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// GuestID is the hub's guest id: "platform:ID".
func GuestID(platform, id string) string { return platform + ":" + id }

// SplitGuestID splits "platform:ID".
func SplitGuestID(gid string) (platform, id string, ok bool) {
	p, id, ok := strings.Cut(gid, ":")
	if !ok || p == "" || id == "" {
		return "", "", false
	}
	return p, id, true
}

func mbps(bps *float64) *float64 {
	if bps == nil || math.IsNaN(*bps) || math.IsInf(*bps, 0) {
		return nil
	}
	return ptr(r1(*bps * 8 / 1e6))
}

func mbs(bps *float64) *float64 {
	if bps == nil || math.IsNaN(*bps) || math.IsInf(*bps, 0) {
		return nil
	}
	return ptr(r1(*bps / 1e6))
}

func mib(b *uint64) *int64 {
	if b == nil {
		return nil
	}
	return ptr(int64(math.Round(float64(*b) / rules.MiB)))
}

// BuildGuest maps a reported guest.
func BuildGuest(pg proto.PlatformGuest, now time.Time) Guest {
	g := pg.Guest
	running := g.State == proto.StateRunning || g.State == proto.StateUnhealthy
	out := Guest{
		ID: GuestID(pg.Platform, g.ID), Name: g.Name, Platform: pg.Platform, Kind: g.Kind, Image: g.Image, State: g.State,
	}
	if out.Name == "" {
		out.Name = g.ID
	}
	if pg.Platform != proto.PlatformDocker {
		if g.VCPU > 0 {
			out.VCPU = ptr(g.VCPU)
		}
		if g.SnapshotsCount != nil {
			out.Snapshots = ptr(*g.SnapshotsCount)
		}
	}
	if running {
		out.CPUPct = r1p(g.CPUPct)
		out.MemoryUsedMB = mib(g.MemUsedBytes)
		switch {
		case g.MemLimitBytes != nil:
			out.MemoryLimitMB = mib(g.MemLimitBytes)
		case g.Kind == "vm" && g.MemConfigBytes > 0:
			out.MemoryLimitMB = mib(&g.MemConfigBytes)
		}
		if pg.Platform != proto.PlatformDocker {
			out.DiskReadMBs, out.DiskWriteMBs = mbs(g.DiskReadBps), mbs(g.DiskWriteBps)
			out.NetRxMbps, out.NetTxMbps = mbps(g.NetRxBps), mbps(g.NetTxBps)
		}
		if g.StartedAt != nil && !g.StartedAt.IsZero() {
			up := int64(now.Sub(*g.StartedAt) / time.Second)
			if up < 0 {
				up = 0
			}
			out.UptimeS = &up
		}
	} else if pg.Platform == proto.PlatformDocker && g.FinishedAt != nil {
		out.LastExit = T(*g.FinishedAt)
	}
	out.Console = buildConsole(pg.Platform, g, running)
	out.Addresses, out.Lock, out.Restarts, out.ExitCode = g.Addresses, g.Lock, g.RestartCount, g.ExitCode
	out.OOMKilled, out.Project, out.UpdateAvailable = g.OOMKilled, g.Project, g.UpdateAvailable
	if pg.Platform == proto.PlatformDocker {
		out.App = buildGuestApp(g.App)
		out.ImageID = g.ImageID
	}
	if g.WhombatService {
		out.Labels = map[string]string{"whombat.service": "1"}
	}
	if g.DiskUsedBytes != nil {
		out.DiskUsedGB = ptr(r1(float64(*g.DiskUsedBytes) / rules.GB))
	}
	if running {
		out.Processes = g.Processes
	}
	out.Tags, out.PendingChanges, out.GuestAgent, out.HAState = g.Tags, g.PendingChanges, g.GuestAgent, g.HAState
	if g.OldestSnapshot != nil {
		out.OldestSnapshot = T(*g.OldestSnapshot)
	}
	out.BackupJob = g.BackupJob
	out.Self = g.Self
	out.Autostart, out.WebUI = g.Autostart, g.WebUI
	if pg.Platform == proto.PlatformDocker && g.Autostart != nil {
		// Docker on unRAID: the unRAID collector set autostart, so whether
		// a template exists is known too.
		out.Template = ptr(g.UnraidTemplate)
	}
	libvirtGuestExtras(&out, pg)
	if pg.Platform == proto.PlatformPVE {
		if g.VMID > 0 {
			out.VMID = ptr(g.VMID)
		} else if n, err := strconv.Atoi(g.ID); err == nil {
			out.VMID = &n
		}
		out.Node = strp(g.Node)
		if g.LastBackup != nil {
			out.LastBackup = &LastBackup{Result: g.LastBackup.Result, At: Time(g.LastBackup.At)}
		}
	}
	return out
}

func buildConsole(platform string, g *proto.Guest, running bool) GuestConsole {
	if platform == proto.PlatformDocker && len(g.Console.Protocols) == 0 {
		return GuestConsole{docker: true} // agents before shell / logs: no console
	}
	c := GuestConsole{Protocols: append([]string{}, g.Console.Protocols...), Unavailable: g.Console.Unavailable}
	c.Available = len(c.Protocols) > 0
	if c.Available {
		d := g.Console.Default
		if d == "" || !contains(c.Protocols, d) {
			d = c.Protocols[0]
		}
		c.DefaultProtocol = &d
	}
	if running {
		c.Resolution = strp(g.Console.Resolution)
	}
	return c
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// GuestSort orders guests for tables: running (and unhealthy) by CPU
// descending, then stopped, each tie broken by name.
func GuestSort(gs []Guest, key string, desc bool) {
	sort.SliceStable(gs, func(i, j int) bool { return guestLess(gs[i], gs[j], key, desc) })
}

// guestLess is GuestSort's order of two guests for a sort key: name, state,
// or a value (memory; cpu and anything else) with live guests first.
func guestLess(a, b Guest, key string, desc bool) bool {
	la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name)
	switch key {
	case "name":
		if desc {
			return la > lb
		}
		return la < lb
	case "state":
		if a.State != b.State {
			return (a.State < b.State) != desc
		}
		return la < lb
	}
	if al, bl := a.State != proto.StateStopped, b.State != proto.StateStopped; al != bl {
		return al
	}
	if va, vb := guestValue(a, key), guestValue(b, key); va != vb {
		if desc {
			return va > vb
		}
		return va < vb
	}
	return la < lb
}

// guestValue is the sortable value of a guest: memory used for "memory",
// else CPU; -1 when unknown.
func guestValue(g Guest, key string) float64 {
	switch key {
	case "memory":
		if g.MemoryUsedMB != nil {
			return float64(*g.MemoryUsedMB)
		}
	default:
		if g.CPUPct != nil {
			return *g.CPUPct
		}
	}
	return -1
}

// sortKey parses a sort parameter: the key with an optional "-" / "+"
// direction prefix; cpu (the default) and memory are descending by default.
func sortKey(s string) (key string, desc bool) {
	switch {
	case s == "":
		return "cpu", true
	case strings.HasPrefix(s, "-"):
		return s[1:], true
	case strings.HasPrefix(s, "+"):
		return s[1:], false
	}
	return s, s == "cpu" || s == "memory"
}

// pageWindow resolves an offset cursor and a page size (def by default, at
// most 500) over n items: the window [off, end) and the next cursor.
func pageWindow(n, limit, def int, cursor string) (off, end int, next *string) {
	if limit <= 0 {
		limit = def
	}
	if limit > 500 {
		limit = 500
	}
	if cursor != "" {
		if b, err := base64.RawURLEncoding.DecodeString(cursor); err == nil {
			off, _ = strconv.Atoi(string(b))
		}
	}
	if off < 0 || off > n {
		off = n
	}
	end = min(off+limit, n)
	if end < n {
		c := base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(end)))
		next = &c
	}
	return off, end, next
}

// GuestListQuery filters and pages the guest list.
type GuestListQuery struct {
	Platform string // docker | incus | libvirt | pve ("" = all)
	Kind     string // vm | container ("" = all)
	Q        string // case-insensitive substring of name, id or image
	Sort     string // cpu (default) | memory | name | state; prefix "-" / "+" for direction
	Limit    int    // default 50, max 500
	Cursor   string
}

// GuestList is the body of GET /servers/{id}/guests.
type GuestList struct {
	Items      []Guest `json:"guests"`
	Total      int     `json:"total"`
	NextCursor *string `json:"next_cursor"`
}

// ListGuests filters, sorts and pages the guests of a report.
func ListGuests(r *proto.Report, q GuestListQuery, now time.Time) GuestList {
	var all []Guest
	if r != nil {
		needle := strings.ToLower(q.Q)
		for _, pg := range r.AllGuests() {
			if q.Platform != "" && pg.Platform != q.Platform {
				continue
			}
			if q.Kind != "" && pg.Kind != q.Kind {
				continue
			}
			if needle != "" && !strings.Contains(strings.ToLower(pg.Name+" "+pg.ID+" "+pg.Image), needle) {
				continue
			}
			all = append(all, BuildGuest(pg, now))
		}
	}
	key, desc := sortKey(q.Sort)
	GuestSort(all, key, desc)
	off, end, next := pageWindow(len(all), q.Limit, 50, q.Cursor)
	out := GuestList{Items: all[off:end], Total: len(all), NextCursor: next}
	if out.Items == nil {
		out.Items = []Guest{}
	}
	return out
}

// FleetGuest is a guest of the fleet-wide list (GET /guests): the guest
// object plus the server it runs on.
type FleetGuest struct {
	Server       string
	ServerOnline bool // false: the server is offline, the guest comes from its last report
	Guest
}

// MarshalJSON writes "server" and "server_online" first, then the guest's
// own keys.
func (g FleetGuest) MarshalJSON() ([]byte, error) {
	gb, err := g.Guest.MarshalJSON()
	if err != nil {
		return nil, err
	}
	srv, err := json.Marshal(g.Server)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.Grow(len(gb) + len(srv) + 32)
	b.WriteString(`{"server":`)
	b.Write(srv)
	b.WriteString(`,"server_online":`)
	b.WriteString(strconv.FormatBool(g.ServerOnline))
	if len(gb) > 2 { // the guest object has keys: splice them in
		b.WriteByte(',')
		b.Write(gb[1:])
	} else {
		b.WriteByte('}')
	}
	return b.Bytes(), nil
}

// FleetGuestQuery filters, sorts and pages the fleet-wide guest list.
type FleetGuestQuery struct {
	Q        string // case-insensitive substring of name, id or image ("" = every guest)
	State    string // running | stopped | unhealthy ("" = all)
	Platform string // docker | incus | libvirt | pve ("" = all)
	Kind     string // vm | container ("" = all)
	Server   string // server id ("" = all)
	Tag      string // a guest tag, case-insensitive exact ("" = all)
	Sort     string // cpu (default) | memory | name | state | server; prefix "-" / "+" for direction
	Limit    int    // default 100, max 500
	Cursor   string
}

// GuestCounts counts guests by state.
type GuestCounts struct {
	All       int `json:"all"`
	Running   int `json:"running"`
	Stopped   int `json:"stopped"`
	Unhealthy int `json:"unhealthy"`
}

// FleetGuestList is the body of GET /guests. Counts, Platforms and Tags
// cover the guests matching Q and Server, before the state, platform, kind
// and tag filters; Total counts the guests left after every filter.
type FleetGuestList struct {
	Items      []FleetGuest   `json:"guests"`
	Total      int            `json:"total"`
	NextCursor *string        `json:"next_cursor"`
	Counts     GuestCounts    `json:"counts"`
	Platforms  map[string]int `json:"platforms"`
	// Tags: tag (lower case) -> guests carrying it.
	Tags map[string]int `json:"tags"`
}

// guestState maps a reported state onto the list's three states: anything
// but running and unhealthy counts as stopped.
func guestState(s string) string {
	if s == proto.StateRunning || s == proto.StateUnhealthy {
		return s
	}
	return proto.StateStopped
}

// guestRank ranks a guest for a query: 0 exact name, 1 name prefix, 2 other
// name match, 3 id or image match, -1 no match. Without a query every guest
// ranks 0.
func guestRank(pg proto.PlatformGuest, needle string) int {
	if needle == "" {
		return 0
	}
	name := pg.Name
	if name == "" {
		name = pg.ID
	}
	ln := strings.ToLower(name)
	switch {
	case ln == needle:
		return 0
	case strings.HasPrefix(ln, needle):
		return 1
	case strings.Contains(ln, needle):
		return 2
	case strings.Contains(strings.ToLower(pg.ID+" "+pg.Image), needle):
		return 3
	}
	return -1
}

// guestTags are a guest's tags in lower case, each once.
func guestTags(g *proto.Guest) []string {
	var out []string
	for _, t := range g.Tags {
		if t = strings.ToLower(strings.TrimSpace(t)); t != "" && !contains(out, t) {
			out = append(out, t)
		}
	}
	return out
}

// fleetGuestLess orders fleet guests: by server id for the "server" key
// (the default order within a server), else like GuestSort with the server
// id as the last tie-breaker.
func fleetGuestLess(a, b FleetGuest, key string, desc bool) bool {
	if key == "server" {
		if a.Server != b.Server {
			return (a.Server < b.Server) != desc
		}
		return guestLess(a.Guest, b.Guest, "cpu", true)
	}
	if guestLess(a.Guest, b.Guest, key, desc) {
		return true
	}
	if guestLess(b.Guest, a.Guest, key, desc) {
		return false
	}
	return a.Server < b.Server
}

// SearchGuests lists the guests of every server, offline servers from their
// last report. With a query, exact names rank first, then name prefixes,
// other name matches and id or image matches, each group in sort order;
// without one the sort key alone orders the list (default: running first by
// CPU, then stopped, ties by name and server).
func SearchGuests(states []*ServerState, q FleetGuestQuery, now time.Time) FleetGuestList {
	needle := strings.ToLower(strings.TrimSpace(q.Q))
	tag := strings.ToLower(strings.TrimSpace(q.Tag))
	out := FleetGuestList{Items: []FleetGuest{}, Platforms: map[string]int{}, Tags: map[string]int{}}
	type hit struct {
		FleetGuest
		rank int
	}
	var all []hit
	for _, s := range states {
		if s.Report == nil || (q.Server != "" && s.ID != q.Server) {
			continue
		}
		online := s.Online(now)
		for _, pg := range s.Report.AllGuests() {
			rank := guestRank(pg, needle)
			if rank < 0 {
				continue
			}
			state := guestState(pg.State)
			switch state {
			case proto.StateRunning:
				out.Counts.Running++
			case proto.StateUnhealthy:
				out.Counts.Unhealthy++
			default:
				out.Counts.Stopped++
			}
			out.Counts.All++
			out.Platforms[pg.Platform]++
			tagged := tag == ""
			for _, t := range guestTags(pg.Guest) {
				out.Tags[t]++
				tagged = tagged || t == tag
			}
			if (q.State != "" && state != q.State) || (q.Platform != "" && pg.Platform != q.Platform) ||
				(q.Kind != "" && pg.Kind != q.Kind) || !tagged {
				continue
			}
			all = append(all, hit{FleetGuest: FleetGuest{Server: s.ID, ServerOnline: online, Guest: BuildGuest(pg, now)}, rank: rank})
		}
	}
	key, desc := sortKey(q.Sort)
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].rank != all[j].rank {
			return all[i].rank < all[j].rank
		}
		return fleetGuestLess(all[i].FleetGuest, all[j].FleetGuest, key, desc)
	})
	off, end, next := pageWindow(len(all), q.Limit, 100, q.Cursor)
	for _, h := range all[off:end] {
		out.Items = append(out.Items, h.FleetGuest)
	}
	out.Total, out.NextCursor = len(all), next
	return out
}
