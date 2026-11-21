package rules

import (
	"fmt"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// libvirt hints (IU-13, brief §2.6): a storage pool filling up, and
// running VMs with neither a backup nor a snapshot for 30 days.

// Hint kinds.
const (
	HintLibvirtPoolFull = "libvirt.pool_full"
	HintLibvirtNoBackup = "libvirt.no_backup"
)

// Thresholds.
const (
	LibvirtPoolFullPct = 85.0
	LibvirtNoBackupAge = 30 * 24 * time.Hour
)

// libvirtHints: pools at or above 85 % (to Storage), and the running VMs
// without a backup or snapshot in 30 days (one hint per host; with one VM
// its entity is the guest, "libvirt:<name>", so the way out is its
// Backups tab). The backup hint needs an agent that reports its libvirt
// host view and a backups folder (older agents report no backups). Ages
// count from the report's time.
func libvirtHints(r *proto.Report, open []Alert, now time.Time) []Hint {
	p := r.Libvirt
	if p == nil {
		return nil
	}
	if !r.At.IsZero() {
		now = r.At
	}
	var out []Hint
	if d := p.Libvirt; d != nil {
		for _, pl := range d.Pools {
			if !pl.Active || pl.TotalBytes == 0 || alerted(open, "fs:"+pl.Path, RuleSpaceHigh) {
				continue
			}
			pct := float64(pl.UsedBytes) / float64(pl.TotalBytes) * 100
			if pct < LibvirtPoolFullPct-eps {
				continue
			}
			sev := HintInfo
			if pct >= 95-eps {
				sev = HintWarning
			}
			out = append(out, Hint{Kind: HintLibvirtPoolFull, Severity: sev, Entity: "libvirt-pool:" + pl.Name, Link: LinkStorage,
				Title:  fmt.Sprintf("Storage “%s” %s%% full", pl.Name, pct0(pct)),
				Detail: FormatStorageGB(float64(pl.AvailBytes)/1e9) + " free"})
		}
	}
	var names, ids []string
	for _, g := range p.Guests {
		if p.Libvirt == nil || p.Libvirt.BackupsDir == "" || g.State != proto.StateRunning {
			continue
		}
		recent := func(t *time.Time) bool { return t != nil && now.Sub(*t) < LibvirtNoBackupAge }
		var backup *time.Time
		if g.LastBackup != nil && g.LastBackup.Result == "ok" {
			backup = &g.LastBackup.At
		}
		if recent(backup) || recent(g.LastSnapshot) {
			continue
		}
		name := g.Name
		if name == "" {
			name = g.ID
		}
		names = append(names, name)
		ids = append(ids, g.ID)
	}
	if n := len(names); n > 0 {
		h := Hint{Kind: HintLibvirtNoBackup, Severity: HintInfo, Entity: proto.PlatformLibvirt, Link: LinkGuests,
			Title: plural(int64(n), "machine has", "machines have") + " no recent backup"}
		if n == 1 {
			h.Entity, h.Title = proto.PlatformLibvirt+":"+ids[0], names[0]+" has no recent backup"
		}
		h.Detail = strings.Join(firstN(names, UnhealthyNames), ", ")
		if n > UnhealthyNames {
			h.Detail += ", …"
		}
		if n == 1 {
			h.Detail = "No backup or snapshot in the last 30 days"
		}
		out = append(out, h)
	}
	return out
}
