package collect

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Parsers of unRAID's own files (docs/MANAGE.md 2.6). Each is checked
// against BlackBox's real 7.3.1 files in testdata/unraid-7.3.1.

// kib converts emhttp's 1 KiB block counts (disks.ini size, fsSize,
// fsUsed, fsFree; shares.ini used, free) to bytes.
func kib(s string) uint64 {
	n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return n * 1024
}

func iniInt(m map[string]string, k string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(m[k]), 10, 64)
	return n
}

// unraidDiskStatus maps a disks.ini status to the report's word; "" means
// the slot is empty (no disk assigned) and is left out. A parity slot
// DISK_NP_DSBL has no disk (parity "not installed"); a data slot
// DISK_NP_DSBL lost its disk and is emulated.
func unraidDiskStatus(raw, slot string) string {
	switch raw {
	case "DISK_OK":
		return "ok"
	case "DISK_NP", "":
		return ""
	case "DISK_NP_DSBL":
		if slot == proto.UnraidSlotParity {
			return ""
		}
		return "emulated"
	case "DISK_NP_MISSING":
		return "missing"
	case "DISK_DSBL":
		return "disabled"
	case "DISK_DSBL_NEW", "DISK_NEW":
		return "new"
	case "DISK_INVALID":
		return "invalid"
	case "DISK_WRONG":
		return "wrong"
	}
	return "invalid"
}

// unraidModelSerial splits a disks.ini id ("ST10000NE0008-2PL103_ZS5028CY",
// "WDC_WDS200T1R0A-68A4W0_22425T450313") into model and serial: the serial
// is the last "_" part.
func unraidModelSerial(id string) (model, serial string) {
	i := strings.LastIndexByte(id, '_')
	if i <= 0 || i == len(id)-1 {
		return strings.ReplaceAll(id, "_", " "), ""
	}
	return strings.ReplaceAll(id[:i], "_", " "), id[i+1:]
}

// unraidDisk builds a device from its disks.ini section.
func unraidDiskOf(name string, kv map[string]string, slot string) (proto.UnraidDisk, bool) {
	raw := kv["status"]
	if slot == proto.UnraidSlotFlash && raw == "" {
		raw = "DISK_OK"
	}
	st := unraidDiskStatus(raw, slot)
	if st == "" {
		return proto.UnraidDisk{}, false
	}
	d := proto.UnraidDisk{Name: name, Slot: slot, Device: kv["device"], Status: st, StatusRaw: raw, SizeBytes: kib(kv["size"])}
	if id := kv["id"]; id != "" {
		d.Model, d.Serial = unraidModelSerial(id)
	} else if id := kv["idSb"]; id != "" {
		d.Model, d.Serial = unraidModelSerial(id)
	}
	if fs := kv["fsType"]; fs != "" && fs != "auto" && fs != "-" {
		d.FSType = fs
	}
	if kv["fsStatus"] == "Mounted" {
		if size := kib(kv["fsSize"]); size > 0 {
			used, free := kib(kv["fsUsed"]), kib(kv["fsFree"])
			d.UsedBytes, d.FreeBytes = &used, &free
		}
	}
	if t, err := strconv.ParseFloat(kv["temp"], 64); err == nil {
		d.TempC = &t
	}
	d.SpunDown = kv["spundown"] == "1"
	if n, err := strconv.ParseUint(kv["numErrors"], 10, 64); err == nil {
		d.Errors = n
	}
	switch kv["rotational"] {
	case "1":
		d.Rotational = ptr(true)
	case "0":
		d.Rotational = ptr(false)
	}
	return d, true
}

// unraidSection is a disks.ini section with its index.
type unraidSection struct {
	name string
	idx  int
	kv   map[string]string
}

func unraidSections(disks map[string]map[string]string) []unraidSection {
	var out []unraidSection
	for sec, kv := range disks {
		if sec == "" {
			continue
		}
		name := kv["name"]
		if name == "" {
			name = sec
		}
		idx, err := strconv.Atoi(kv["idx"])
		if err != nil {
			idx = 1 << 20
		}
		out = append(out, unraidSection{name: name, idx: idx, kv: kv})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].idx != out[j].idx {
			return out[i].idx < out[j].idx
		}
		return out[i].name < out[j].name
	})
	return out
}

var trailingDigits = regexp.MustCompile(`^(.*?)(\d+)$`)

// unraidPoolOf finds the pool a type=Cache section belongs to: the pool
// of that name, else the pool whose name the section's name continues
// with digits ("apps2" of "apps"), the longest one first.
func unraidPoolOf(name string, pools []string) string {
	for _, p := range pools {
		if p == name {
			return p
		}
	}
	best := ""
	for _, p := range pools {
		if strings.HasPrefix(name, p) && len(p) > len(best) {
			if rest := name[len(p):]; rest != "" && strings.Trim(rest, "0123456789") == "" {
				best = p
			}
		}
	}
	if best == "" {
		if m := trailingDigits.FindStringSubmatch(name); m != nil {
			return m[1]
		}
		return name
	}
	return best
}

// unraidStorage builds the array's disks, the pools and the flash from
// disks.ini; poolNames are the pools of /boot/config/pools (nil: the
// type=Cache sections that carry a file system), poolStatus monitor.ini's
// [poolsstatus].
func unraidStorage(disks map[string]map[string]string, poolNames []string, poolStatus map[string]string) (array []proto.UnraidDisk, pools []proto.UnraidPool, flash *proto.UnraidDisk) {
	secs := unraidSections(disks)
	if len(poolNames) == 0 {
		for _, s := range secs {
			if s.kv["type"] == "Cache" && (s.kv["fsType"] != "" || s.kv["nameOrig"] != "") {
				poolNames = append(poolNames, s.name)
			}
		}
	}
	byPool := map[string]*proto.UnraidPool{}
	var order []string
	for _, s := range secs {
		switch s.kv["type"] {
		case "Parity":
			if d, ok := unraidDiskOf(s.name, s.kv, proto.UnraidSlotParity); ok {
				array = append(array, d)
			}
		case "Data":
			if d, ok := unraidDiskOf(s.name, s.kv, proto.UnraidSlotData); ok {
				array = append(array, d)
			}
		case "Flash":
			if d, ok := unraidDiskOf(s.name, s.kv, proto.UnraidSlotFlash); ok {
				flash = &d
			}
		case "Cache":
			name := unraidPoolOf(s.name, poolNames)
			p := byPool[name]
			if p == nil {
				p = &proto.UnraidPool{Name: name, Disks: []proto.UnraidDisk{}}
				byPool[name] = p
				order = append(order, name)
			}
			if s.name == name {
				p.FSType = s.kv["fsType"]
				if p.FSType == "auto" || p.FSType == "-" {
					p.FSType = ""
				}
				p.Profile = s.kv["fsProfile"]
				if p.Profile == "" && iniInt(s.kv, "devices") <= 1 {
					p.Profile = "single"
				}
				p.SizeBytes, p.UsedBytes, p.FreeBytes = kib(s.kv["fsSize"]), kib(s.kv["fsUsed"]), kib(s.kv["fsFree"])
				p.Status = poolStatus[name]
			}
			if d, ok := unraidDiskOf(s.name, s.kv, proto.UnraidSlotPool); ok {
				d.Pool = name
				p.Disks = append(p.Disks, d)
			}
		}
	}
	for _, name := range order {
		pools = append(pools, *byPool[name])
	}
	return array, pools, flash
}

// unraidArrayState maps var.ini's mdState and fsState to started |
// stopped | starting | stopping | invalid.
func unraidArrayState(v map[string]string) string {
	md := strings.ToUpper(v["mdState"])
	fs := strings.ToLower(v["fsState"])
	switch {
	case strings.HasPrefix(fs, "stopping"):
		return proto.UnraidArrayStopping
	case strings.HasPrefix(fs, "starting") || strings.HasPrefix(fs, "mounting") || strings.HasPrefix(fs, "copying"):
		return proto.UnraidArrayStarting
	case md == "STARTED":
		return proto.UnraidArrayStarted
	case strings.HasPrefix(md, "ERROR") || (v["configValid"] != "" && v["configValid"] != "yes"):
		return proto.UnraidArrayInvalid
	}
	return proto.UnraidArrayStopped
}

// ---- parity -------------------------------------------------------------------------

// parseParityLog parses /boot/config/parity-checks.log, one finished
// operation per line, oldest first:
//
//	2023 Jun 30 13:17:38|5644|354429108|0|0|check P Q|1953513560
//
// date | duration (s) | speed (bytes/s, older lines "123.4 MB/s") |
// exit status (0 ok, -4 cancelled) | errors | action | size (KiB). The
// answer is newest first.
func parseParityLog(b []byte, loc *time.Location) []proto.UnraidParityRun {
	if loc == nil {
		loc = time.Local
	}
	var out []proto.UnraidParityRun
	scanLines(b, func(line string) {
		f := strings.Split(strings.TrimSpace(line), "|")
		if len(f) < 5 {
			return
		}
		at, err := time.ParseInLocation("2006 Jan 2 15:04:05", strings.Join(strings.Fields(f[0]), " "), loc)
		if err != nil {
			return
		}
		run := proto.UnraidParityRun{At: at.UTC()}
		if d, err := strconv.ParseInt(strings.TrimSpace(f[1]), 10, 64); err == nil && d > 0 {
			run.DurationS = &d
		}
		run.SpeedMBs = parseParitySpeed(f[2])
		status := strings.TrimSpace(f[3])
		errs, _ := strconv.ParseUint(strings.TrimSpace(f[4]), 10, 64)
		run.Errors = errs
		switch status {
		case "0":
			run.Result = "ok"
			if errs > 0 {
				run.Result = "errors"
			}
		case "-4":
			run.Result = "cancelled"
		default:
			run.Result = "failed"
		}
		if len(f) > 5 {
			run.Action = parityLogAction(f[5])
		}
		out = append(out, run)
	})
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// parseParitySpeed reads a speed in bytes/s (or an old "123.4 MB/s").
func parseParitySpeed(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "0" {
		return nil
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		if n <= 0 {
			return nil
		}
		return ptr(round1(n / 1e6))
	}
	f := strings.Fields(s)
	if len(f) != 2 {
		return nil
	}
	n, err := strconv.ParseFloat(f[0], 64)
	if err != nil || n <= 0 {
		return nil
	}
	switch strings.ToUpper(strings.TrimSuffix(f[1], "/s")) {
	case "KB":
		n /= 1000
	case "GB":
		n *= 1000
	case "MB":
	default:
		return nil
	}
	return ptr(round1(n))
}

// parityLogAction maps md's action words ("check P Q", "check",
// "recon P", "recon D1", "clear") to check | read_check | sync | rebuild |
// clear.
func parityLogAction(s string) string {
	w := strings.Fields(s)
	if len(w) == 0 {
		return ""
	}
	switch w[0] {
	case "check":
		if len(w) > 1 {
			return "check"
		}
		return "read_check"
	case "recon":
		if len(w) > 1 && (w[1] == "P" || w[1] == "Q") {
			return "sync"
		}
		return "rebuild"
	case "clear":
		return "clear"
	}
	return ""
}

// unraidParity builds the parity state from var.ini, the history and the
// schedule.
func unraidParity(v map[string]string, history []proto.UnraidParityRun, parityDisks int, schedule string) proto.UnraidParity {
	p := proto.UnraidParity{State: "idle", Disks: parityDisks, Schedule: schedule}
	if len(history) > 10 {
		history = history[:10]
	}
	p.History = history
	pos, size := iniInt(v, "mdResyncPos"), iniInt(v, "mdResyncSize")
	if pos > 0 {
		p.State = "running"
		if iniInt(v, "mdResync") == 0 {
			p.State = "paused"
		}
		w := strings.Fields(v["mdResyncAction"])
		if len(w) > 0 {
			switch w[0] {
			case "check":
				p.Action = "check"
				if v["mdResyncCorr"] == "1" && len(w) > 1 {
					p.Action = "correct"
				}
			case "recon":
				p.Action = "rebuild"
			case "clear":
				p.Action = "clear"
			}
		}
		if size > 0 {
			p.Pct = ptr(round1(clamp(float64(pos)/float64(size)*100, 0, 100)))
		}
		db, dt := iniInt(v, "mdResyncDb"), iniInt(v, "mdResyncDt")
		if db > 0 && dt > 0 && p.State == "running" {
			p.SpeedMBs = ptr(round1(float64(db) * 1024 / float64(dt) / 1e6))
			if size > pos {
				eta := int64(float64(size-pos) * float64(dt) / float64(db))
				p.ETAS = &eta
			}
		}
		if n := iniInt(v, "sbSyncErrs"); n > 0 {
			p.Errors = uint64(n)
		}
		if len(history) > 0 {
			last := history[0]
			p.Last = &last
		}
		return p
	}
	// The last operation: md's superblock (sbSynced: start, sbSynced2:
	// end, sbSyncErrs, sbSyncExit) when it has one, the history's newest
	// line otherwise (md forgets after a reboot); the history line has the
	// speed and the action, so it wins when it is the same run.
	start, end := iniInt(v, "sbSynced"), iniInt(v, "sbSynced2")
	var fromVar *proto.UnraidParityRun
	if end > 0 || start > 0 {
		at := end
		if at <= 0 {
			at = start
		}
		run := proto.UnraidParityRun{At: time.Unix(at, 0).UTC(), Result: "ok"}
		if end > 0 && start > 0 && end >= start {
			d := end - start
			run.DurationS = &d
		}
		if n := iniInt(v, "sbSyncErrs"); n > 0 {
			run.Errors = uint64(n)
			run.Result = "errors"
		}
		switch x := iniInt(v, "sbSyncExit"); {
		case x == -4:
			run.Result = "cancelled"
		case x != 0:
			run.Result = "failed"
		}
		fromVar = &run
	}
	switch {
	case len(history) > 0 && (fromVar == nil || absDur(history[0].At.Sub(fromVar.At)) < 10*time.Minute):
		last := history[0]
		p.Last = &last
	case fromVar != nil:
		p.Last = fromVar
	}
	return p
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

var weekdays = []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}
var monthNames = []string{"", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// paritySchedule renders dynamix.cfg's [parity] section (the Scheduler
// page: mode 0 disabled, 1 daily, 2 weekly, 3 monthly, 4 yearly, 5
// custom; hour "M H"; day, dotm, month; write NOCORRECT or "") in plain
// words: "Monthly, day 1 at 00:30, no corrections". "" when disabled.
func paritySchedule(p map[string]string) string {
	mode, err := strconv.Atoi(p["mode"])
	if err != nil || mode <= 0 || mode > 5 {
		return ""
	}
	at := ""
	if f := strings.Fields(p["hour"]); len(f) == 2 {
		m, err1 := strconv.Atoi(f[0])
		h, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil {
			at = fmt.Sprintf(" at %02d:%02d", h, m)
		}
	}
	day := func(s string) string {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 && n < 7 {
			return weekdays[n]
		}
		return ""
	}
	dotm := func(s string) string {
		switch s {
		case "28-31":
			return "last day"
		case "", "*":
			return ""
		}
		return "day " + s
	}
	var s string
	switch mode {
	case 1:
		s = "Daily" + at
	case 2:
		s = "Weekly"
		if d := day(p["day"]); d != "" {
			s += " on " + d
		}
		s += at
	case 3:
		s = "Monthly"
		if d := dotm(p["dotm"]); d != "" {
			s += ", " + d
		}
		s += at
	case 4:
		s = "Yearly"
		if n, err := strconv.Atoi(p["month"]); err == nil && n >= 1 && n <= 12 {
			s += ", " + monthNames[n]
		}
		if d := dotm(p["dotm"]); d != "" {
			s += " " + d
		}
		s += at
	case 5:
		var days []string
		for _, d := range strings.Split(p["day"], ",") {
			if w := day(strings.TrimSpace(d)); w != "" {
				days = append(days, w)
			}
		}
		s = "Custom"
		if len(days) > 0 {
			s += ", " + strings.Join(days, ", ")
		}
		switch p["dotm"] {
		case "W1":
			s += ", first week"
		case "W2":
			s += ", second week"
		case "W3":
			s += ", third week"
		case "W4":
			s += ", fourth week"
		case "WL":
			s += ", last week"
		}
		var months []string
		for _, m := range strings.Split(p["month"], ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(m)); err == nil && n >= 1 && n <= 12 {
				months = append(months, monthNames[n])
			}
		}
		if len(months) > 0 && len(months) < 12 {
			s += " of " + strings.Join(months, ", ")
		}
		s += at
	}
	if p["write"] == "NOCORRECT" {
		s += ", no corrections"
	} else {
		s += ", with corrections"
	}
	if p["cumulative"] == "1" {
		s += ", in parts"
	}
	return s
}

// ---- shares -------------------------------------------------------------------------

// unraidShares builds the user shares from shares.ini (allocation and
// sizes), sec.ini (SMB) and sec_nfs.ini (NFS). Primary and secondary
// storage follow unRAID 7: useCache no = the array only; only = the pool
// only; yes = pool, then the array (or cachePool2), the mover moving to
// the secondary; prefer = the same storages, the mover moving to the
// pool.
func unraidShares(shares, smb, nfs map[string]map[string]string) []proto.UnraidShare {
	var names []string
	for sec := range shares {
		if sec != "" {
			names = append(names, sec)
		}
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	var out []proto.UnraidShare
	for _, sec := range names {
		kv := shares[sec]
		name := kv["name"]
		if name == "" {
			name = sec
		}
		s := proto.UnraidShare{Name: name, Comment: kv["comment"], UsedBytes: kib(kv["used"]), FreeBytes: kib(kv["free"]), Primary: "array"}
		pool, pool2 := kv["cachePool"], kv["cachePool2"]
		second := "array"
		if pool2 != "" {
			second = pool2
		}
		switch kv["useCache"] {
		case "only":
			if pool != "" {
				s.Primary = pool
			}
		case "yes":
			if pool != "" {
				s.Primary, s.Secondary = pool, second
				s.MoverAction = "to_pool"
				if second == "array" {
					s.MoverAction = "to_array"
				}
			}
		case "prefer":
			if pool != "" {
				s.Primary, s.Secondary, s.MoverAction = pool, second, "to_pool"
			}
		}
		if sm := smb[name]; sm != nil {
			if ex := sm["export"]; ex != "" && ex != "-" {
				s.SMB = sm["security"]
				if s.SMB == "" {
					s.SMB = "public"
				}
			}
		}
		if nf := nfs[name]; nf != nil {
			if ex := nf["export"]; ex != "" && ex != "-" {
				s.NFS = true
			}
		}
		if ls := kv["luksStatus"]; ls != "" && ls != "0" {
			s.Encrypted = true
		}
		out = append(out, s)
	}
	return out
}

// ---- plugins ------------------------------------------------------------------------

// plgHeader is the <PLUGIN> tag of a plugin file.
type plgHeader struct {
	Name, Author, Version, Support, URL string
}

var (
	plgEntityRe = regexp.MustCompile(`<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>`)
	plgEntRefRe = regexp.MustCompile(`&([A-Za-z_][\w.-]*);`)
	plgAttrRe   = regexp.MustCompile(`([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')`)
)

// parsePlgHeader reads the <PLUGIN ...> tag of a .plg file, resolving the
// DOCTYPE's entities (&name;, &version; ...; nested ones too). Only the
// head of the file is needed.
func parsePlgHeader(b []byte) (plgHeader, bool) {
	ents := map[string]string{"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'"}
	for _, m := range plgEntityRe.FindAllSubmatch(b, -1) {
		v := string(m[2])
		if len(m[3]) > 0 {
			v = string(m[3])
		}
		ents[string(m[1])] = v
	}
	resolve := func(s string) string {
		for i := 0; i < 8 && strings.Contains(s, "&"); i++ {
			n := plgEntRefRe.ReplaceAllStringFunc(s, func(ref string) string {
				if v, ok := ents[ref[1:len(ref)-1]]; ok {
					return v
				}
				return ref
			})
			if n == s {
				break
			}
			s = n
		}
		return s
	}
	start := bytes.Index(b, []byte("<PLUGIN"))
	if start < 0 {
		return plgHeader{}, false
	}
	// The tag ends at the first '>' outside quotes.
	tag := b[start+len("<PLUGIN"):]
	end, quote := -1, byte(0)
	for i, c := range tag {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			end = i
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		return plgHeader{}, false
	}
	attrs := map[string]string{}
	for _, m := range plgAttrRe.FindAllSubmatch(tag[:end], -1) {
		v := string(m[2])
		if len(m[3]) > 0 {
			v = string(m[3])
		}
		attrs[string(m[1])] = resolve(v)
	}
	h := plgHeader{Name: attrs["name"], Author: attrs["author"], Version: attrs["version"], Support: attrs["support"], URL: attrs["pluginURL"]}
	return h, h.Version != "" || h.Name != ""
}

// versionNewer reports whether a is a newer version than b
// (compareVersions: "2026.10.12" > "2026.9.30", "2026.08.29.1446" >
// "2026.08.06.0154", "7.3.3" > "7.3.1").
func versionNewer(a, b string) bool {
	return compareVersions(a, b) > 0
}

// ---- notifications ------------------------------------------------------------------

// parseNotify reads one notification file of unRAID's notify script:
// key=value lines, string values quoted with \" and \\ escaped.
func parseNotify(id string, b []byte) (proto.UnraidNotification, bool) {
	n := proto.UnraidNotification{ID: id}
	ok := false
	scanLines(b, func(line string) {
		k, v, found := strings.Cut(line, "=")
		if !found {
			return
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
			v = unescapeNotify(v[1 : len(v)-1])
		}
		switch strings.TrimSpace(k) {
		case "timestamp":
			if t, err := strconv.ParseInt(v, 10, 64); err == nil {
				n.At, ok = time.Unix(t, 0).UTC(), true
			}
		case "event":
			n.Event = v
		case "subject":
			n.Subject = v
		case "description":
			n.Description = v
		case "importance":
			n.Importance = v
		}
	})
	switch n.Importance {
	case "alert", "warning", "normal":
	default:
		n.Importance = "normal"
	}
	n.Event, n.Subject, n.Description = truncate(n.Event, 200), truncate(n.Subject, 300), truncate(n.Description, 1000)
	return n, ok
}

// unescapeNotify undoes PHP's stripslashes (what the notify script's
// readers do).
func unescapeNotify(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// ---- unRAID's update check ----------------------------------------------------------

// unraidOSUpdate reads unRAID's own update check (/tmp/unraidcheck/
// result.json: isNewer and version) and leaves out a release the owner
// chose to ignore (ignored.json updateOsIgnoredReleases).
func unraidOSUpdate(result, ignored []byte, current string) string {
	var r struct {
		Version string `json:"version"`
		IsNewer bool   `json:"isNewer"`
	}
	if json.Unmarshal(result, &r) != nil || !r.IsNewer || r.Version == "" || !versionNewer(r.Version, current) {
		return ""
	}
	var ig struct {
		Releases []string `json:"updateOsIgnoredReleases"`
	}
	if len(ignored) > 0 && json.Unmarshal(ignored, &ig) == nil {
		for _, v := range ig.Releases {
			if v == r.Version {
				return ""
			}
		}
	}
	return r.Version
}

// ---- dockerMan ----------------------------------------------------------------------

// parseAutostart reads dockerMan's /var/lib/docker/unraid-autostart: one
// container per line, "name" or "name wait-seconds", in start order.
func parseAutostart(b []byte) map[string]bool {
	out := map[string]bool{}
	scanLines(b, func(line string) {
		if f := strings.Fields(line); len(f) > 0 {
			out[f[0]] = true
		}
	})
	return out
}

// unraidUpdateEntry is one image of dockerMan's unraid-update-status.json.
type unraidUpdateEntry struct {
	Local  *string `json:"local"`
	Remote *string `json:"remote"`
	Status string  `json:"status"`
}

func parseUpdateStatus(b []byte) map[string]unraidUpdateEntry {
	out := map[string]unraidUpdateEntry{}
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

// dockerManImageKey is dockerMan's key for an image (DockerUtil::
// ensureImageTag): "library/" before names without a registry path,
// ":latest" when there is no tag.
var dockerManSplitRe = regexp.MustCompile(`^((?:.+/)*)([^/:]+)((?::[^:/]*)*)$`)

func dockerManImageKey(image string) string {
	if strings.HasPrefix(image, "sha256:") {
		return ""
	}
	if !strings.Contains(image, "/") {
		image = "library/" + image
	}
	m := dockerManSplitRe.FindStringSubmatch(image)
	if m == nil {
		return image + ":latest"
	}
	tag := ""
	if m[3] != "" {
		parts := strings.Split(m[3], ":")
		tag = parts[len(parts)-1]
	}
	if tag == "" {
		tag = "latest"
	}
	return strings.TrimSpace(m[1]+m[2]) + ":" + strings.TrimSpace(tag)
}

// dockerManUpdate is dockerMan's answer for an image (DockerUpdate::
// getUpdateStatus): nil = unknown ("undef" or not checked), else whether
// a newer image exists (local digest differs from the registry's).
func dockerManUpdate(st map[string]unraidUpdateEntry, image string) *bool {
	key := dockerManImageKey(image)
	e, ok := st[key]
	if key == "" || !ok || e.Status == "undef" {
		return nil
	}
	l, r := "", ""
	if e.Local != nil {
		l = *e.Local
	}
	if e.Remote != nil {
		r = *e.Remote
	}
	if l == "" && r == "" {
		return nil
	}
	return ptr(l != r)
}

// dockerTemplate is what a dockerMan user template says about its
// container.
type dockerTemplate struct {
	Name    string
	WebUI   string
	Network string
	MyIP    string
}

var (
	tmplNameRe    = regexp.MustCompile(`(?s)<Name>\s*(.*?)\s*</Name>`)
	tmplWebUIRe   = regexp.MustCompile(`(?s)<WebUI>\s*(.*?)\s*</WebUI>`)
	tmplNetworkRe = regexp.MustCompile(`(?s)<Network>\s*(.*?)\s*</Network>`)
	tmplMyIPRe    = regexp.MustCompile(`(?s)<MyIP>\s*(.*?)\s*</MyIP>`)
)

// parseDockerTemplate reads a dockerMan user template (my-<name>.xml): the
// first <Name>, <WebUI>, <Network> and <MyIP> (XML entities decoded).
func parseDockerTemplate(b []byte) (dockerTemplate, bool) {
	get := func(re *regexp.Regexp) string {
		if m := re.FindSubmatch(b); m != nil {
			return xmlText(string(m[1]))
		}
		return ""
	}
	t := dockerTemplate{Name: get(tmplNameRe), WebUI: get(tmplWebUIRe), Network: get(tmplNetworkRe), MyIP: get(tmplMyIPRe)}
	return t, t.Name != ""
}

func xmlText(s string) string {
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'", "&amp;", "&").Replace(strings.TrimSpace(s))
}

var (
	webUIPortRe = regexp.MustCompile(`\[PORT:(\d+)\]`)
)

// dockerPort is a published container port (/containers/json Ports).
type dockerPort struct {
	IP          string `json:"IP"`
	PrivatePort int    `json:"PrivatePort"`
	PublicPort  int    `json:"PublicPort"`
	Type        string `json:"Type"`
}

// resolveWebUI fills dockerMan's placeholders like its own page does
// (DockerTemplates::getControlURL): [IP] is the server's LAN address for
// host-network containers or published ports, else the container's own
// address (macvlan / ipvlan networks); [PORT:n] the host port published
// for container port n, else n. A URL without placeholders is the owner's
// own and stays as it is.
func resolveWebUI(tmpl, lanIP, networkMode string, ports []dockerPort, addrs []string) string {
	if tmpl == "" {
		return ""
	}
	if !strings.Contains(tmpl, "[IP]") && !webUIPortRe.MatchString(tmpl) {
		return tmpl
	}
	ip := lanIP
	published := false
	for _, p := range ports {
		if p.PublicPort > 0 {
			published = true
		}
	}
	if networkMode != "host" && !published && len(addrs) > 0 {
		ip = addrs[0]
	}
	if ip == "" {
		return ""
	}
	if strings.Contains(ip, ":") && !strings.HasPrefix(ip, "[") {
		ip = "[" + ip + "]"
	}
	out := strings.ReplaceAll(tmpl, "[IP]", ip)
	out = webUIPortRe.ReplaceAllStringFunc(out, func(m string) string {
		n, _ := strconv.Atoi(webUIPortRe.FindStringSubmatch(m)[1])
		for _, p := range ports {
			if p.PrivatePort == n && p.PublicPort > 0 {
				return strconv.Itoa(p.PublicPort)
			}
		}
		return strconv.Itoa(n)
	})
	if !strings.HasPrefix(out, "http://") && !strings.HasPrefix(out, "https://") {
		return ""
	}
	return out
}
