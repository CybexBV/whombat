package hub

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

// ---- the guest this Whombat runs in (IU-02) --------------------------------------
//
// Agents report each guest's network card addresses (Guest.MACs). The hub
// reads its own machine's (/sys/class/net/*/address, at start and every
// 10 minutes; --self-macs overrides them) and marks a guest with one of
// them as Self: that guest is the Whombat itself. Its server says
// hosts_this_whombat, and changing the guest is refused with 409
// self_guest, so a tap on the phone cannot switch off the Whombat it is
// made with. What stays allowed is the list of contracts 0.83.0
// (HOST_SELF_GUEST_ALLOWED): reads and consoles, start and resume,
// snapshots taken and deleted, backups (made, changed, deleted, restored
// as a new guest), a copy, replication and stopping a task.

// selfRefresh is how often the hub reads its own MACs again.
const selfRefresh = 10 * time.Minute

// selfMessage is the refusal's text (contracts' hosts error words).
const selfMessage = "That’s this Whombat itself."

var macRe = regexp.MustCompile(`^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

// normMAC lower-cases an address; "" when it is not a usable one (all
// zero, malformed).
func normMAC(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if !macRe.MatchString(s) || s == "00:00:00:00:00:00" {
		return ""
	}
	return s
}

// sysNetDir is where the hub reads its own interfaces (tests change it).
var sysNetDir = "/sys/class/net"

// readSelfMACs reads the machine's interface addresses, loopback and
// all-zero ones left out.
func readSelfMACs() []string {
	entries, err := os.ReadDir(sysNetDir)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Name() == "lo" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(sysNetDir, e.Name(), "address"))
		if err != nil {
			continue
		}
		if m := normMAC(string(b)); m != "" {
			seen[m] = true
		}
	}
	out := make([]string, 0, len(seen))
	for m := range seen {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// ParseSelfMACs reads --self-macs (a comma list); invalid entries are
// dropped.
func ParseSelfMACs(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if m := normMAC(p); m != "" && !slices.Contains(out, m) {
			out = append(out, m)
		}
	}
	return out
}

// refreshSelfMACs sets the hub's own MACs: the configured ones, else the
// machine's.
func (h *Hub) refreshSelfMACs(context.Context) {
	macs := h.cfg.SelfMACs
	if len(macs) == 0 {
		macs = readSelfMACs()
	}
	set := make(map[string]bool, len(macs))
	for _, m := range macs {
		set[m] = true
	}
	h.selfMACs.Store(&set)
}

// annotateReport bounds the parts of a report sanitizeReport leaves to
// this file (the MACs, the Incus host view) and marks the guest the hub
// runs in. Called after sanitizeReport, before the report is stored.
func (h *Hub) annotateReport(r *proto.Report) {
	if r.Incus != nil {
		sanitizeIncus(r.Incus.Incus)
	}
	var self map[string]bool
	if p := h.selfMACs.Load(); p != nil {
		self = *p
	}
	for _, pg := range r.AllGuests() {
		g := pg.Guest
		var macs []string
		for _, m := range g.MACs {
			if m = normMAC(m); m != "" && len(macs) < 16 && !slices.Contains(macs, m) {
				macs = append(macs, m)
			}
		}
		g.MACs = macs
		clampStr(&g.SnapshotSchedule, maxLabel)
		g.Self = false
		for _, m := range macs {
			if self[m] {
				g.Self = true
				break
			}
		}
	}
	sanitizePlace(r.BackupPlace)
	if r.BackupPlace != nil && serverIsSelf(r, self) {
		r.BackupPlace.Supported, r.BackupPlace.Reason = false, proto.PlaceSelf
	}
}

// serverIsSelf reports whether a server is the machine this Whombat runs
// on, or runs it as a guest: its backups must not live there.
func serverIsSelf(r *proto.Report, self map[string]bool) bool {
	if r == nil {
		return false
	}
	if model.HostsThisWhombat(r) {
		return true
	}
	for _, n := range r.Net {
		if m := normMAC(n.MAC); m != "" && self[m] {
			return true
		}
	}
	return false
}

// isSelfServer is serverIsSelf with the hub's own addresses.
func (h *Hub) isSelfServer(r *proto.Report) bool {
	var self map[string]bool
	if p := h.selfMACs.Load(); p != nil {
		self = *p
	}
	return serverIsSelf(r, self)
}

// sanitizePlace bounds the backup place of a report.
func sanitizePlace(bp *proto.BackupPlace) {
	if bp == nil {
		return
	}
	clampStr(&bp.Reason, 32)
	clampStr(&bp.Platform, 16)
	clampStr(&bp.Root, maxLabel)
	if len(bp.Addresses) > 16 {
		bp.Addresses = bp.Addresses[:16]
	}
	if len(bp.Clients) > 64 {
		bp.Clients = bp.Clients[:64]
	}
	for i := range bp.Clients {
		c := &bp.Clients[i]
		clampStr(&c.Client, 64)
		clampStr(&c.Image, maxLabel)
		clampStr(&c.Cleanup.LastError, 300)
	}
}

// selfAllowedActions are the power and snapshot actions allowed on the
// self guest.
var selfAllowedActions = map[string]bool{proto.ActionStart: true, proto.ActionResume: true,
	proto.ActionSnapshotCreate: true, proto.ActionSnapshotDelete: true}

// selfAllowedOps are the manage changes allowed on the self guest (reads
// always are; backup.restore only as a new guest).
var selfAllowedOps = map[string]bool{proto.OpBackupCreate: true, proto.OpBackupUpdate: true, proto.OpBackupDelete: true,
	proto.OpClone: true, proto.OpReplicationAdd: true, proto.OpReplicationDelete: true, proto.OpTaskStop: true}

func selfRefused() *apiError {
	return apiErr(http.StatusConflict, proto.CodeSelfGuest, selfMessage)
}

// selfActionRefusal refuses an action on the self guest outside the allow
// list (nil: allowed).
func selfActionRefusal(g proto.PlatformGuest, action string) *apiError {
	if g.Guest == nil || !g.Self || selfAllowedActions[action] {
		return nil
	}
	return selfRefused()
}

// selfManageRefusal refuses a manage change of the self guest outside the
// allow list. gid is the route's guest ("" for host routes); overwrite is
// the guest a backup is restored over ("" for a new guest).
func selfManageRefusal(st *model.ServerState, op, gid, overwrite string) *apiError {
	if selfAllowedOps[op] {
		return nil
	}
	for _, id := range []string{gid, overwrite} {
		if id == "" || id == model.HostGuestID {
			continue
		}
		if g, ok := findGuest(st, id); ok && g.Self {
			return selfRefused()
		}
	}
	return nil
}

// isSelfGuest reports whether a hub guest id is the self guest of a
// server.
func isSelfGuest(st *model.ServerState, gid string) bool {
	g, ok := findGuest(st, gid)
	return ok && g.Self
}
