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

// spunDownDisksFor returns the names of any backing disks of mount that are
// currently spun down. It reads only RAM/sysfs metadata and non-waking standby
// queries so sleeping drives are never spun up.
func (r *Runner) spunDownDisksFor(ctx context.Context, mount string, target mountInfo) []string {
	spun := map[string]bool{}

	// 1. Unraid's emhttp state in RAM (/var/local/emhttp/disks.ini) knows every
	// array and pool disk's spin state without touching any drive.
	if r.isUnraid() {
		r.checkUnraidSpunDown(mount, spun)
	}

	// 2. Check the latest inventory report for backing disks and Standby flags.
	var backing []string
	var hdds map[string]bool
	if r.inventory != nil {
		if rep := r.inventory(); rep != nil {
			hdds = make(map[string]bool, len(rep.Disks))
			for _, d := range rep.Disks {
				if d.Type == "hdd" {
					hdds[d.Device] = true
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
				r.checkUnraidReportSpunDown(mount, backingSet, rep.Unraid, spun)
			}
		}
	}

	// 3. Live non-waking standby check for rotational backing disks not already
	// marked spun down (smartctl -n standby / hdparm -C).
	if r.checkStandby != nil {
		checked := map[string]bool{}
		for _, dev := range backing {
			if dev == "" || checked[dev] || spun[dev] {
				continue
			}
			checked[dev] = true
			if !r.isRotational(dev, hdds) {
				continue
			}
			pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			asleep := r.checkStandby(pctx, dev)
			cancel()
			if asleep {
				spun[dev] = true
			}
		}
	}

	if len(spun) == 0 {
		return nil
	}
	out := make([]string, 0, len(spun))
	for k := range spun {
		out = append(out, k)
	}
	return out
}

func (r *Runner) isRotational(dev string, hdds map[string]bool) bool {
	if hdds != nil {
		if h, ok := hdds[dev]; ok {
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

// checkUnraidSpunDown reads /var/local/emhttp/disks.ini (in tmpfs) and records
// any spun-down disk that backs mount.
func (r *Runner) checkUnraidSpunDown(mount string, spun map[string]bool) {
	b, err := os.ReadFile(r.hostPath("/var/local/emhttp/disks.ini"))
	if err != nil {
		return
	}
	secs := parseSimpleINI(b)
	for sec, kv := range secs {
		if sec == "" || kv["spundown"] != "1" {
			continue
		}
		name := kv["name"]
		if name == "" {
			name = sec
		}
		typ := kv["type"]
		if unraidDiskBacksMount(mount, name, typ, "") {
			spun[name] = true
		}
	}
}

func (r *Runner) checkUnraidReportSpunDown(mount string, backingSet map[string]bool, u *proto.Unraid, spun map[string]bool) {
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
		}
	}
	for _, p := range u.Pools {
		for _, d := range p.Disks {
			if !d.SpunDown {
				continue
			}
			if unraidDiskBacksMount(mount, d.Name, "Cache", p.Name) || (d.Device != "" && backingSet[d.Device]) {
				spun[d.Name] = true
			}
		}
	}
	if u.Flash != nil && u.Flash.SpunDown {
		if unraidDiskBacksMount(mount, u.Flash.Name, "Flash", "") || (u.Flash.Device != "" && backingSet[u.Flash.Device]) {
			spun[u.Flash.Name] = true
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

// hostDiskStandby checks whether a block device (e.g. "sda") is in ATA standby
// or sleep without waking it, using smartctl -n standby and falling back to
// hdparm -C.
func hostDiskStandby(ctx context.Context, dev string) bool {
	if dev == "" || strings.ContainsAny(dev, "/\\ \t\n\r") {
		return false
	}
	devPath := "/dev/" + dev
	if path, err := lookTool("smartctl"); err == nil {
		out, _ := exec.CommandContext(ctx, path, "--json=c", "-i", "-n", "standby", devPath).CombinedOutput()
		if standbyFromSmartctl(out) {
			return true
		}
		if len(out) > 0 {
			return false
		}
	}
	if path, err := lookTool("hdparm"); err == nil {
		out, err := exec.CommandContext(ctx, path, "-C", devPath).CombinedOutput()
		if err == nil {
			s := strings.ToLower(string(out))
			if strings.Contains(s, "standby") || strings.Contains(s, "sleeping") {
				return true
			}
		}
	}
	return false
}

func standbyFromSmartctl(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	var j struct {
		Smartctl struct {
			ExitStatus int `json:"exit_status"`
			Messages   []struct {
				String string `json:"string"`
			} `json:"messages"`
		} `json:"smartctl"`
	}
	if err := json.Unmarshal(b, &j); err != nil {
		s := strings.ToUpper(string(b))
		return strings.Contains(s, "STANDBY") || strings.Contains(s, "SLEEP")
	}
	for _, m := range j.Smartctl.Messages {
		s := strings.ToUpper(m.String)
		if strings.Contains(s, "STANDBY") || strings.Contains(s, "SLEEP") {
			return true
		}
	}
	return false
}
