package diskusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"rackoon/internal/proto"
)

type standbyState int

const (
	standbyUnknown standbyState = iota
	standbyAwake
	standbyAsleep
)

type standbyCheckResult struct {
	spun    []string
	unknown []string
}

// spunDownDisksFor returns the names of any backing disks of mount that are
// currently spun down, plus any rotational backing disks whose spin state could
// not be confirmed. It reads only RAM/sysfs metadata and non-waking standby
// queries so sleeping drives are never spun up.
func (r *Runner) spunDownDisksFor(ctx context.Context, mount string, target mountInfo) standbyCheckResult {
	spun := map[string]bool{}
	spunDevs := map[string]bool{}
	unraidAwake := map[string]bool{}
	unknown := map[string]bool{}

	// 1. Unraid's emhttp state in RAM (/var/local/emhttp/disks.ini) knows every
	// array and pool disk's spin state without touching any drive.
	if r.isUnraid() {
		r.checkUnraidSpunDown(mount, spun, spunDevs, unraidAwake)
	}

	// 2. Check the latest inventory report for backing disks and Standby flags.
	var backing []string
	var rotational map[string]bool
	if r.inventory != nil {
		if rep := r.inventory(); rep != nil {
			rotational = make(map[string]bool, len(rep.Disks))
			for _, d := range rep.Disks {
				if d.Type != "" {
					rotational[d.Device] = d.Type == "hdd"
				}
			}
			for _, fs := range rep.Filesystems {
				if filepath.Clean(fs.Mount) == mount {
					backing = append(backing, fs.Disks...)
				}
			}
			if target.FSType == "zfs" {
				pool, _, _ := strings.Cut(target.Source, "/")
				for _, p := range rep.Pools {
					if p.Name == pool {
						backing = append(backing, p.Disks...)
					}
				}
			}
			// Mark any backing disk that the SMART collector already saw in standby.
			backingSet := map[string]bool{}
			for _, b := range backing {
				backingSet[b] = true
			}
			for _, d := range rep.Disks {
				if backingSet[d.Device] && d.Standby {
					spun[d.Device] = true
				}
			}
			// Also cross-check Unraid report state in case disks.ini wasn't present
			// (for example in unit tests with a synthetic inventory).
			if rep.Unraid != nil {
				r.checkUnraidReportSpunDown(mount, backingSet, rep.Unraid, spun, spunDevs)
			}
		}
	}

	// 3. Fallback: derive backing physical disks from the mount's source (and
	// major:minor) via sysfs so partitions, LVM, dm-crypt and mdraid mounts are
	// checked even without a prior inventory report.
	for _, dev := range r.backingDisksFromSource(target) {
		backing = append(backing, dev)
	}

	// 4. Live non-waking standby check for rotational backing disks not already
	// marked spun down (smartctl -n standby / hdparm -C). If a rotational disk's
	// state cannot be determined, skip rather than walk and risk waking it.
	checked := map[string]bool{}
	for _, dev := range backing {
		if dev == "" || checked[dev] || spun[dev] || spunDevs[dev] {
			continue
		}
		checked[dev] = true
		if !r.isRotational(dev, rotational) {
			continue
		}
		state := standbyUnknown
		if r.checkStandby != nil {
			pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			state = r.checkStandby(pctx, dev)
			cancel()
		}
		switch state {
		case standbyAsleep:
			spun[dev] = true
		case standbyAwake:
		default:
			if !unraidAwake[dev] {
				unknown[dev] = true
			}
		}
	}

	var res standbyCheckResult
	if len(spun) > 0 {
		res.spun = make([]string, 0, len(spun))
		for k := range spun {
			res.spun = append(res.spun, k)
		}
	}
	if len(unknown) > 0 {
		res.unknown = make([]string, 0, len(unknown))
		for k := range unknown {
			res.unknown = append(res.unknown, k)
		}
	}
	return res
}

func (r *Runner) isRotational(dev string, rotational map[string]bool) bool {
	if rotational != nil {
		if h, ok := rotational[dev]; ok {
			return h
		}
	}
	if strings.HasPrefix(dev, "nvme") {
		return false
	}
	// Reading /sys/block/<dev>/queue/rotational reads kernel state only.
	b, err := os.ReadFile(r.hostPath(filepath.Join("/sys/block", dev, "queue/rotational")))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(b)) == "1"
}

// backingDisksFromSource derives underlying physical block devices from a
// mount's source path and major:minor via sysfs (partition -> disk; LVM/dm/md
// -> member disks recursively). Reads only /dev symlinks and /sys metadata.
func (r *Runner) backingDisksFromSource(target mountInfo) []string {
	var seeds []string
	seenSeed := map[string]bool{}
	addSeed := func(name string) {
		if name == "" || name == "." || name == "/" || strings.Contains(name, "/") || seenSeed[name] {
			return
		}
		seenSeed[name] = true
		seeds = append(seeds, name)
	}

	if strings.HasPrefix(target.Source, "/dev/") {
		resolved := r.resolveDevPath(target.Source)
		base := filepath.Base(resolved)
		if strings.HasPrefix(resolved, "/dev/mapper/") {
			if dm := r.findDMByName(base); dm != "" {
				addSeed(dm)
			} else {
				addSeed(base)
			}
		} else {
			// Also handle /dev/<vg>/<lv> -> dm/name when /dev symlink isn't present.
			if rel := strings.TrimPrefix(resolved, "/dev/"); strings.Count(rel, "/") == 1 {
				vg, lv, _ := strings.Cut(rel, "/")
				dmName := strings.ReplaceAll(vg, "-", "--") + "-" + strings.ReplaceAll(lv, "-", "--")
				if dm := r.findDMByName(dmName); dm != "" {
					addSeed(dm)
				} else {
					addSeed(base)
				}
			} else {
				addSeed(base)
			}
		}
	}

	if target.MajMin != "" && !strings.HasPrefix(target.MajMin, "0:") {
		if link, err := os.Readlink(r.hostPath(filepath.Join("/sys/dev/block", target.MajMin))); err == nil {
			addSeed(filepath.Base(link))
		}
	}

	visited := map[string]bool{}
	found := map[string]bool{}
	var out []string
	var walk func(name string)
	walk = func(name string) {
		if name == "" || visited[name] {
			return
		}
		visited[name] = true

		// 1. Stacked devices (LVM/dm-*, dm-crypt, mdraid, multipath, bcache)
		// expose their underlying members in /sys/class/block/<dev>/slaves.
		if slaves := r.sysfsSlaves(name); len(slaves) > 0 {
			for _, s := range slaves {
				walk(s)
			}
			return
		}

		// 2. Partition -> parent disk via sysfs link, /sys/block/<parent>/<part>,
		// or Linux block naming fallback.
		if parent := r.sysfsPartitionParent(name); parent != "" && parent != name {
			walk(parent)
			return
		}

		// 3. Leaf block device: ignore virtual/non-disk leaves.
		if isVirtualLeafBlock(name) {
			return
		}
		if !found[name] {
			found[name] = true
			out = append(out, name)
		}
	}

	for _, s := range seeds {
		walk(s)
	}
	return out
}

func (r *Runner) resolveDevPath(devPath string) string {
	cur := filepath.Clean(devPath)
	for i := 0; i < 16; i++ {
		target, err := os.Readlink(r.hostPath(cur))
		if err != nil {
			return cur
		}
		if filepath.IsAbs(target) {
			cur = filepath.Clean(target)
		} else {
			cur = filepath.Clean(filepath.Join(filepath.Dir(cur), target))
		}
	}
	return cur
}

func (r *Runner) findDMByName(want string) string {
	ents, err := os.ReadDir(r.hostPath("/sys/block"))
	if err != nil {
		return ""
	}
	for _, e := range ents {
		name := e.Name()
		if !strings.HasPrefix(name, "dm-") {
			continue
		}
		b, err := os.ReadFile(r.hostPath(filepath.Join("/sys/block", name, "dm/name")))
		if err == nil && strings.TrimSpace(string(b)) == want {
			return name
		}
	}
	return ""
}

func (r *Runner) sysfsSlaves(name string) []string {
	for _, dir := range []string{
		filepath.Join("/sys/class/block", name, "slaves"),
		filepath.Join("/sys/block", name, "slaves"),
	} {
		ents, err := os.ReadDir(r.hostPath(dir))
		if err != nil || len(ents) == 0 {
			continue
		}
		out := make([]string, 0, len(ents))
		for _, e := range ents {
			if n := e.Name(); n != "" {
				out = append(out, n)
			}
		}
		return out
	}
	return nil
}

func (r *Runner) sysfsPartitionParent(name string) string {
	// /sys/class/block/<part> symlinks to ../../devices/.../block/<disk>/<part>.
	if link, err := os.Readlink(r.hostPath(filepath.Join("/sys/class/block", name))); err == nil {
		parent := filepath.Base(filepath.Dir(filepath.Clean(link)))
		if parent != "" && parent != "block" && parent != "." && parent != "/" && parent != name {
			return parent
		}
	}
	// If /sys/block/<name> does not exist as a top-level disk, check /sys/block/<disk>/<name>.
	if _, err := os.Lstat(r.hostPath(filepath.Join("/sys/block", name))); err != nil {
		if ents, err := os.ReadDir(r.hostPath("/sys/block")); err == nil {
			for _, e := range ents {
				if _, err := os.Lstat(r.hostPath(filepath.Join("/sys/block", e.Name(), name))); err == nil {
					return e.Name()
				}
			}
		}
	}
	// Fallback: standard Linux partition naming when not a top-level /sys/block entry
	// (or explicitly marked as a partition in sysfs).
	if parent := partitionParentName(name); parent != "" {
		_, isTopDisk := os.Lstat(r.hostPath(filepath.Join("/sys/block", name)))
		_, hasPartFile := os.Lstat(r.hostPath(filepath.Join("/sys/class/block", name, "partition")))
		if isTopDisk != nil || hasPartFile == nil {
			return parent
		}
	}
	return ""
}

func partitionParentName(name string) string {
	for _, prefix := range []string{"nvme", "mmcblk", "md", "loop", "nbd"} {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		p := strings.LastIndexByte(name, 'p')
		if p <= len(prefix) || p >= len(name)-1 {
			continue
		}
		if name[p-1] < '0' || name[p-1] > '9' {
			continue
		}
		if allDigits(name[p+1:]) {
			return name[:p]
		}
	}
	for _, prefix := range []string{"xvd", "dasd", "sd", "hd", "vd"} {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		i := len(name)
		for i > len(prefix) && name[i-1] >= '0' && name[i-1] <= '9' {
			i--
		}
		if i == len(name) || i <= len(prefix) {
			continue
		}
		rest := name[len(prefix):i]
		if allLowerLetters(rest) {
			return name[:i]
		}
	}
	return ""
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func allLowerLetters(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'a' || s[i] > 'z' {
			return false
		}
	}
	return true
}

func isVirtualLeafBlock(name string) bool {
	for _, prefix := range []string{"loop", "ram", "zram", "nbd", "sr", "fd", "nullb"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// checkUnraidSpunDown reads /var/local/emhttp/disks.ini (in tmpfs) and records
// any spun-down disk that backs mount, as well as devices explicitly known awake.
func (r *Runner) checkUnraidSpunDown(mount string, spun, spunDevs, awake map[string]bool) {
	b, err := os.ReadFile(r.hostPath("/var/local/emhttp/disks.ini"))
	if err != nil {
		return
	}
	secs := parseSimpleINI(b)
	for sec, kv := range secs {
		if sec == "" {
			continue
		}
		name := kv["name"]
		if name == "" {
			name = sec
		}
		typ := kv["type"]
		if !unraidDiskBacksMount(mount, name, typ, "") {
			continue
		}
		dev := kv["device"]
		switch kv["spundown"] {
		case "1":
			spun[name] = true
			if dev != "" {
				spunDevs[dev] = true
			}
		case "0":
			if dev != "" {
				awake[dev] = true
			}
		}
	}
}

func (r *Runner) checkUnraidReportSpunDown(mount string, backingSet map[string]bool, u *proto.Unraid, spun, spunDevs map[string]bool) {
	if u == nil {
		return
	}
	for _, d := range u.Array.Disks {
		if !d.SpunDown {
			continue
		}
		typ := "Data"
		if d.Slot == proto.UnraidSlotParity {
			typ = "Parity"
		}
		if unraidDiskBacksMount(mount, d.Name, typ, "") || (d.Device != "" && backingSet[d.Device]) {
			spun[d.Name] = true
			if d.Device != "" {
				spunDevs[d.Device] = true
			}
		}
	}
	for _, p := range u.Pools {
		for _, d := range p.Disks {
			if !d.SpunDown {
				continue
			}
			if unraidDiskBacksMount(mount, d.Name, "Cache", p.Name) || (d.Device != "" && backingSet[d.Device]) {
				spun[d.Name] = true
				if d.Device != "" {
					spunDevs[d.Device] = true
				}
			}
		}
	}
	if u.Flash != nil && u.Flash.SpunDown {
		if unraidDiskBacksMount(mount, u.Flash.Name, "Flash", "") || (u.Flash.Device != "" && backingSet[u.Flash.Device]) {
			spun[u.Flash.Name] = true
			if u.Flash.Device != "" {
				spunDevs[u.Flash.Device] = true
			}
		}
	}
}

// unraidDiskBacksMount reports whether an Unraid disk/pool slot backs mount.
func unraidDiskBacksMount(mount, diskName, diskType, poolName string) bool {
	switch {
	case mount == "/mnt/user" || strings.HasPrefix(mount, "/mnt/user/"):
		// Unraid's shfs user share spans all data disks and cache pools.
		return diskType == "Data" || diskType == "Cache"
	case mount == "/mnt/user0" || strings.HasPrefix(mount, "/mnt/user0/"):
		// user0 spans array data disks only.
		return diskType == "Data"
	case mount == "/boot":
		return diskType == "Flash"
	case strings.HasPrefix(mount, "/mnt/"):
		rest := strings.TrimPrefix(mount, "/mnt/")
		top, _, _ := strings.Cut(rest, "/")
		if top == "" {
			return false
		}
		if top == diskName {
			return true
		}
		if poolName != "" && top == poolName {
			return true
		}
		// Multi-disk cache pools in disks.ini name members "<pool>", "<pool>2", ...
		if diskType == "Cache" && strings.HasPrefix(diskName, top) {
			suffix := strings.TrimPrefix(diskName, top)
			if suffix != "" && strings.Trim(suffix, "0123456789") == "" {
				return true
			}
		}
	}
	return false
}

// parseSimpleINI parses emhttp's [section] key="value" ini files.
func parseSimpleINI(b []byte) map[string]map[string]string {
	out := map[string]map[string]string{"": {}}
	cur := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			cur = strings.Trim(strings.TrimSpace(line[1:len(line)-1]), `"`)
			if out[cur] == nil {
				out[cur] = map[string]string{}
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"`)
		out[cur][k] = v
	}
	return out
}

// hostDiskStandby checks whether a block device (e.g. "sda") is awake or in ATA
// standby/sleep without waking it, using smartctl -n standby and falling back to
// hdparm -C. Returns standbyUnknown if neither tool can confirm the drive state.
func hostDiskStandby(ctx context.Context, dev string) standbyState {
	if dev == "" || strings.ContainsAny(dev, "/\\ \t\n\r") {
		return standbyUnknown
	}
	devPath := "/dev/" + dev
	if path, err := lookTool("smartctl"); err == nil {
		out, cmdErr := exec.CommandContext(ctx, path, "--json=c", "-i", "-n", "standby", devPath).CombinedOutput()
		if st := standbyFromSmartctl(out, cmdErr); st != standbyUnknown {
			return st
		}
	}
	if path, err := lookTool("hdparm"); err == nil {
		out, err := exec.CommandContext(ctx, path, "-C", devPath).CombinedOutput()
		if err == nil {
			if st := standbyFromHdparm(out); st != standbyUnknown {
				return st
			}
		}
	}
	return standbyUnknown
}

func standbyFromSmartctl(b []byte, cmdErr error) standbyState {
	if len(b) == 0 {
		return standbyUnknown
	}
	var j struct {
		PowerMode string `json:"power_mode"`
		Smartctl  struct {
			ExitStatus int `json:"exit_status"`
			Messages   []struct {
				String string `json:"string"`
			} `json:"messages"`
		} `json:"smartctl"`
	}
	if err := json.Unmarshal(b, &j); err != nil {
		s := strings.ToUpper(string(b))
		if strings.Contains(s, "STANDBY") || strings.Contains(s, "SLEEP") {
			return standbyAsleep
		}
		return standbyUnknown
	}
	for _, m := range j.Smartctl.Messages {
		s := strings.ToUpper(m.String)
		if strings.Contains(s, "STANDBY") || strings.Contains(s, "SLEEP") {
			return standbyAsleep
		}
	}
	if pm := strings.ToUpper(j.PowerMode); pm != "" {
		if strings.Contains(pm, "STANDBY") || strings.Contains(pm, "SLEEP") {
			return standbyAsleep
		}
		if strings.Contains(pm, "ACTIVE") || strings.Contains(pm, "IDLE") {
			return standbyAwake
		}
	}
	if cmdErr == nil && j.Smartctl.ExitStatus == 0 {
		return standbyAwake
	}
	return standbyUnknown
}

func standbyFromHdparm(b []byte) standbyState {
	s := strings.ToLower(string(b))
	if strings.Contains(s, "standby") || strings.Contains(s, "sleeping") {
		return standbyAsleep
	}
	if strings.Contains(s, "unknown") {
		return standbyUnknown
	}
	if strings.Contains(s, "active/idle") || strings.Contains(s, "active") || strings.Contains(s, "idle") {
		return standbyAwake
	}
	return standbyUnknown
}
