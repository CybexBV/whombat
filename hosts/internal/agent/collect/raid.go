package collect

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// raidCollector reports Linux md arrays (/proc/mdstat + sysfs) and the
// Unraid array (emhttp's var.ini / disks.ini) every 30 s. Absent when
// the host has neither.
type raidCollector struct {
	root fsRoot
	c    *collector

	mu     sync.Mutex
	arrays []proto.RAIDArray
}

func newRAIDCollector(root fsRoot, c *collector) *raidCollector {
	return &raidCollector{root: root, c: c}
}

func (x *raidCollector) run(ctx context.Context) error {
	var arrays []proto.RAIDArray
	var errs []string
	if b, err := x.root.read("/proc/mdstat"); err == nil {
		for _, md := range parseMdstat(b) {
			arrays = append(arrays, mdArray(x.root, md))
		}
	}
	if x.root.exists("/var/local/emhttp/var.ini") {
		a, err := unraidArray(x.root)
		if err != nil {
			errs = append(errs, err.Error())
		} else if a != nil {
			arrays = append(arrays, *a)
		}
	}
	if x.c != nil {
		x.c.raidSub.setAbsent(len(arrays) == 0 && len(errs) == 0)
	}
	x.mu.Lock()
	x.arrays = arrays
	x.mu.Unlock()
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func (x *raidCollector) snapshot() []proto.RAIDArray {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.arrays == nil {
		return nil
	}
	out := make([]proto.RAIDArray, len(x.arrays))
	for i, a := range x.arrays {
		a.Members = append([]string(nil), a.Members...)
		a.Failed = append([]string(nil), a.Failed...)
		a.SyncPct = copyPtr(a.SyncPct)
		a.LastCheckErrors = copyPtr(a.LastCheckErrors)
		out[i] = a
	}
	return out
}

// ---- Linux md -----------------------------------------------------------------------

// mdstatArray is one array of /proc/mdstat.
type mdstatArray struct {
	Name       string
	Active     bool // "active" (vs "inactive")
	Level      string
	Members    []mdMember
	Blocks     uint64 // 1 KiB blocks
	Want, Have int    // [2/1]
	Slots      string // "U_"
	SyncPct    *float64
	SyncKind   string // resync | recovery | check | repair | reshape
}

type mdMember struct {
	Name  string
	Slot  int
	Flags string // F (faulty), S (spare), W (write-mostly), J (journal), R (replacement)
}

var (
	mdHeadRE   = regexp.MustCompile(`^(md\S+)\s*:\s*(active|inactive)(?:\s+\((?:auto-)?read-only\))?\s*(.*)$`)
	mdMemberRE = regexp.MustCompile(`^(\S+?)\[(\d+)\]((?:\([A-Z]\))*)$`)
	mdStatusRE = regexp.MustCompile(`(\d+) blocks.*\[(\d+)/(\d+)\]\s+\[([U_]+)\]`)
	mdBlocksRE = regexp.MustCompile(`^(\d+) blocks`)
	mdSyncRE   = regexp.MustCompile(`(resync|recovery|check|repair|reshape)\s*=\s*([0-9.]+)%`)
)

// parseMdstat parses /proc/mdstat:
//
//	md127 : active raid1 nvme0n1p2[0] nvme1n1p2[1]
//	      33520640 blocks super 1.2 [2/2] [UU]
//	      [=>...................]  recovery =  8.5% (2850816/33520640) finish=2.5min speed=203629K/sec
func parseMdstat(b []byte) []mdstatArray {
	var out []mdstatArray
	var cur *mdstatArray
	scanLines(b, func(line string) {
		t := strings.TrimSpace(line)
		if m := mdHeadRE.FindStringSubmatch(t); m != nil {
			out = append(out, mdstatArray{Name: m[1], Active: m[2] == "active"})
			cur = &out[len(out)-1]
			rest := strings.Fields(m[3])
			for _, w := range rest {
				if mm := mdMemberRE.FindStringSubmatch(w); mm != nil {
					slot, _ := strconv.Atoi(mm[2])
					flags := strings.NewReplacer("(", "", ")", "").Replace(mm[3])
					cur.Members = append(cur.Members, mdMember{Name: mm[1], Slot: slot, Flags: flags})
				} else if cur.Level == "" && len(cur.Members) == 0 {
					cur.Level = w
				}
			}
			return
		}
		if cur == nil || t == "" {
			if t == "" {
				cur = nil
			}
			return
		}
		if m := mdStatusRE.FindStringSubmatch(t); m != nil {
			cur.Blocks, _ = strconv.ParseUint(m[1], 10, 64)
			cur.Want, _ = strconv.Atoi(m[2])
			cur.Have, _ = strconv.Atoi(m[3])
			cur.Slots = m[4]
		} else if m := mdBlocksRE.FindStringSubmatch(t); m != nil && cur.Blocks == 0 {
			cur.Blocks, _ = strconv.ParseUint(m[1], 10, 64)
		}
		if m := mdSyncRE.FindStringSubmatch(t); m != nil {
			cur.SyncKind = m[1]
			if v, err := strconv.ParseFloat(m[2], 64); err == nil {
				cur.SyncPct = &v
			}
		}
	})
	return out
}

// mdArray builds the report entry from mdstat and /sys/block/<md>/md.
func mdArray(r fsRoot, md mdstatArray) proto.RAIDArray {
	sys := "/sys/block/" + md.Name + "/md/"
	a := proto.RAIDArray{Name: md.Name, Level: md.Level, SizeBytes: md.Blocks * 1024}
	if lvl := r.readString(sys + "level"); lvl != "" {
		a.Level = lvl
	}
	if v, ok := r.readInt(sys + "raid_disks"); ok {
		a.Devices = int(v)
	} else {
		a.Devices = md.Want
	}
	if sz, ok := r.readInt("/sys/block/" + md.Name + "/size"); ok && sz > 0 {
		a.SizeBytes = uint64(sz) * 512
	}
	for _, m := range md.Members {
		a.Members = append(a.Members, m.Name)
		if strings.Contains(m.Flags, "F") {
			a.Failed = append(a.Failed, m.Name)
		}
	}
	// Slots without a member ("_" with nobody in it) are missing devices.
	occupied := map[int]bool{}
	for _, m := range md.Members {
		if !strings.Contains(m.Flags, "S") { // a faulty member is already listed
			occupied[m.Slot] = true
		}
	}
	for i, c := range md.Slots {
		if c == '_' && !occupied[i] {
			a.Failed = append(a.Failed, fmt.Sprintf("missing (slot %d)", i))
		}
	}
	degraded := 0
	if v, ok := r.readInt(sys + "degraded"); ok {
		degraded = int(v)
	} else if md.Want > 0 {
		degraded = md.Want - md.Have
	}
	a.Active = a.Devices - degraded
	if md.Slots != "" {
		a.Active = strings.Count(md.Slots, "U")
	}
	arrayState := r.readString(sys + "array_state")
	action := r.readString(sys + "sync_action")
	if action == "" || action == "idle" {
		action = md.SyncKind
	}
	switch action {
	case "recovery":
		action = "recover"
	}
	a.State = mdState(md.Active, arrayState, action, a.Level, a.Devices, degraded)
	if md.SyncPct != nil {
		a.SyncPct = ptr(round1(*md.SyncPct))
	} else if p, ok := parseSyncCompleted(r.readString(sys + "sync_completed")); ok && action != "" && action != "idle" {
		a.SyncPct = ptr(p)
	}
	return a
}

// mdState maps md's view to clean | degraded | resyncing | recovering |
// checking | failed | inactive.
func mdState(active bool, arrayState, action, level string, devices, degraded int) string {
	switch {
	case !active || arrayState == "inactive" || arrayState == "clear":
		return "inactive"
	case arrayState == "broken" || degraded > mdTolerance(level, devices):
		return "failed"
	case action == "recover":
		return "recovering"
	case action == "resync" || action == "reshape":
		return "resyncing"
	case action == "check" || action == "repair":
		return "checking"
	case degraded > 0:
		return "degraded"
	}
	return "clean"
}

// mdTolerance is how many members an array of this level can lose.
func mdTolerance(level string, devices int) int {
	switch level {
	case "raid1":
		return max(devices-1, 0)
	case "raid4", "raid5":
		return 1
	case "raid6":
		return 2
	case "raid10":
		return 1 // at least one; more only in lucky positions
	}
	return 0 // raid0, linear, multipath
}

// parseSyncCompleted parses sync_completed ("2850816 / 33520640" sectors).
func parseSyncCompleted(s string) (float64, bool) {
	a, b, ok := strings.Cut(s, "/")
	if !ok {
		return 0, false
	}
	done, err1 := strconv.ParseFloat(strings.TrimSpace(a), 64)
	total, err2 := strconv.ParseFloat(strings.TrimSpace(b), 64)
	if err1 != nil || err2 != nil || total <= 0 {
		return 0, false
	}
	return round1(done / total * 100), true
}

// ---- Unraid ----------------------------------------------------------------------------

// parseINI parses emhttp's ini files: key="value" lines, optionally in
// ["section"] blocks. Keys outside a section go to "".
func parseINI(b []byte) map[string]map[string]string {
	out := map[string]map[string]string{"": {}}
	sec := ""
	scanLines(b, func(line string) {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, ";") || strings.HasPrefix(t, "#") {
			return
		}
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			sec = strings.Trim(t[1:len(t)-1], `"'`)
			if out[sec] == nil {
				out[sec] = map[string]string{}
			}
			return
		}
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			return
		}
		out[sec][strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"`)
	})
	return out
}

// unraidDisk is an array slot of disks.ini.
type unraidDisk struct {
	Name, Type, Status, Device string
	Idx                        int
}

// unraidArray builds the Unraid array from /var/local/emhttp/var.ini and
// disks.ini. Array slots are the Parity and Data disks; empty slots
// (DISK_NP, and parity slots DISK_NP_DSBL without a disk: parity "not
// installed") are left out; disabled, invalid, wrong or missing disks are
// failed members. md's own counters (mdNumDisabled, mdNumInvalid) are not
// used: they count the parity slots without a disk too, which made an
// array without parity look failed (HS-56).
func unraidArray(r fsRoot) (*proto.RAIDArray, error) {
	vb, err := r.read("/var/local/emhttp/var.ini")
	if err != nil {
		return nil, err
	}
	db, err := r.read("/var/local/emhttp/disks.ini")
	if err != nil {
		return nil, fmt.Errorf("unraid: %w", err)
	}
	return buildUnraidArray(parseINI(vb)[""], parseINI(db)), nil
}

func buildUnraidArray(v map[string]string, disksINI map[string]map[string]string) *proto.RAIDArray {
	num := func(k string) int64 {
		n, _ := strconv.ParseInt(v[k], 10, 64)
		return n
	}
	var disks []unraidDisk
	for sec, kv := range disksINI {
		if sec == "" {
			continue
		}
		typ := kv["type"]
		if typ != "Parity" && typ != "Data" {
			continue
		}
		name := kv["name"]
		if name == "" {
			name = sec
		}
		idx, _ := strconv.Atoi(kv["idx"])
		disks = append(disks, unraidDisk{Name: name, Type: typ, Status: kv["status"], Device: kv["device"], Idx: idx})
	}
	sort.Slice(disks, func(i, j int) bool { return disks[i].Idx < disks[j].Idx })

	a := &proto.RAIDArray{Name: "unraid", Level: "unraid"}
	parity := 0
	for _, d := range disks {
		if d.Status == "DISK_NP" || d.Status == "" && d.Device == "" || d.Type == "Parity" && d.Status == "DISK_NP_DSBL" && d.Device == "" {
			continue // empty slot
		}
		a.Devices++
		if d.Type == "Parity" {
			parity++
		}
		a.Members = append(a.Members, d.Name)
		switch d.Status {
		case "DISK_OK", "DISK_NEW":
			a.Active++
		case "DISK_INVALID", "DISK_DSBL", "DISK_DSBL_NEW", "DISK_WRONG", "DISK_NP_DSBL", "DISK_NP_MISSING", "DISK_EMULATED":
			a.Failed = append(a.Failed, d.Name)
		default:
			a.Active++
		}
	}
	// Size: sum of the data disks' sizes is not in these files reliably;
	// the array size comes from the filesystems (/mnt/diskN).

	state := strings.ToUpper(v["mdState"])
	resyncing := num("mdResync") > 0 && num("mdResyncPos") > 0
	action := strings.ToLower(v["mdResyncAction"])
	bad := len(a.Failed)
	switch {
	case state == "STOPPED" || state == "":
		a.State = "stopped"
	case strings.HasPrefix(state, "ERROR"):
		a.State = "failed"
	case state != "STARTED":
		a.State = "inactive"
	case bad > parity:
		a.State = "failed"
	case resyncing && strings.HasPrefix(action, "check"):
		a.State = "checking"
	case resyncing && strings.HasPrefix(action, "recon"):
		a.State = "recovering"
	case resyncing:
		a.State = "resyncing"
	case bad > 0:
		a.State = "degraded"
	default:
		a.State = "clean"
	}
	if resyncing {
		if size := num("mdResyncSize"); size > 0 {
			a.SyncPct = ptr(round1(clamp(float64(num("mdResyncPos"))/float64(size)*100, 0, 100)))
		}
	}
	// The last parity check: sbSynced is when it started, sbSynced2 when it
	// ended (0 while one runs); sbSyncErrs its error count.
	end := num("sbSynced2")
	if end <= 0 {
		end = num("sbSynced")
	}
	if end > 0 {
		a.LastCheck = time.Unix(end, 0).UTC()
		if _, ok := v["sbSyncErrs"]; ok {
			errs := uint64(max(num("sbSyncErrs"), 0))
			a.LastCheckErrors = &errs
		}
	}
	return a
}

// isUnraid reports whether the host runs Unraid.
func isUnraid(r fsRoot) bool { return r.exists("/etc/unraid-version") }
