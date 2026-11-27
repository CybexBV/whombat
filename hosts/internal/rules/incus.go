package rules

import (
	"fmt"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Incus hints (IU-08): instances without snapshots or backups, full
// storage pools, Incus' own warnings. Whombat maps each kind to its way
// out (the Snapshots tab, Storage, System).
const (
	HintIncusNoSnapshots = "incus.no_snapshots"
	HintIncusPoolFull    = "incus.pool_full"
	HintIncusWarning     = "incus.warning"
)

// Thresholds of the Incus hints.
const (
	IncusBackupMaxAge   = 30 * 24 * time.Hour // a backup this recent counts as a plan
	IncusNewInstanceAge = 24 * time.Hour      // younger instances are not reported yet
	IncusPoolFullPct    = 85.0                // info from here
	IncusPoolWarnPct    = 95.0                // warning from here
)

// incusHints are the Incus hints of a report. The guests without
// snapshots are one hint per host (like the Proxmox guest hints), with
// their hub ids in Guests.
func incusHints(r *proto.Report, now time.Time) []Hint {
	p := r.Incus
	if p == nil {
		return nil
	}
	var out []Hint
	var names, ids []string
	for i := range p.Guests {
		g := &p.Guests[i]
		// CreatedAt says the agent reports schedules and backups (older
		// agents do not: no hint then).
		if g.State != proto.StateRunning || g.SnapshotSchedule != "" || g.CreatedAt == nil {
			continue
		}
		// An instance in another project than default ("ci/job-1") belongs
		// to the tool that made that project (CI jobs, agents' sandboxes):
		// people keep their own machines in default.
		if strings.Contains(g.ID, "/") {
			continue
		}
		if g.LastBackup != nil && now.Sub(g.LastBackup.At) < IncusBackupMaxAge {
			continue
		}
		if now.Sub(*g.CreatedAt) < IncusNewInstanceAge {
			continue
		}
		name := g.Name
		if name == "" {
			name = g.ID
		}
		names = append(names, name)
		ids = append(ids, proto.PlatformIncus+":"+g.ID)
	}
	if n := len(names); n > 0 {
		title := "1 machine isn’t backed up"
		if n > 1 {
			title = fmt.Sprintf("%d machines aren’t backed up", n)
		}
		d := names
		if n > UnhealthyNames {
			d = names[:UnhealthyNames]
		}
		detail := strings.Join(d, ", ")
		if n > UnhealthyNames {
			detail += ", …"
		}
		detail += " · no scheduled snapshots, no backup in 30 days"
		out = append(out, Hint{Kind: HintIncusNoSnapshots, Severity: HintInfo, Entity: proto.PlatformIncus, Link: LinkGuests,
			Code: HintIncusNoSnapshots, Params: map[string]any{"count": n, "names": d, "days": int(IncusBackupMaxAge / (24 * time.Hour))},
			Title: title, Detail: detail, Guests: ids})
	}
	if d := p.Incus; d != nil {
		for _, pool := range d.Pools {
			if pool.UsedBytes == nil || pool.TotalBytes == nil || *pool.TotalBytes == 0 {
				continue
			}
			pct := float64(*pool.UsedBytes) / float64(*pool.TotalBytes) * 100
			if pct < IncusPoolFullPct-eps {
				continue
			}
			sev := HintInfo
			if pct >= IncusPoolWarnPct-eps {
				sev = HintWarning
			}
			out = append(out, Hint{Kind: HintIncusPoolFull, Severity: sev, Entity: "incus-pool:" + pool.Name, Link: LinkStorage,
				Code: HintIncusPoolFull, Params: map[string]any{"name": pool.Name, "pct": pct,
					"usedGB": float64(*pool.UsedBytes) / GB, "totalGB": float64(*pool.TotalBytes) / GB},
				Title:  "Storage “" + pool.Name + "” " + FormatPct(pct) + " full",
				Detail: FormatStorageGB(float64(*pool.UsedBytes)/GB) + " of " + FormatStorageGB(float64(*pool.TotalBytes)/GB) + " used"})
		}
	}
	if n := len(p.Warnings); n > 0 {
		d := p.Warnings[0].Message
		if n > 1 {
			d += fmt.Sprintf(" (+%d more)", n-1)
		}
		title := "Incus has 1 warning"
		if n > 1 {
			title = fmt.Sprintf("Incus has %d warnings", n)
		}
		out = append(out, Hint{Kind: HintIncusWarning, Severity: HintInfo, Entity: proto.PlatformIncus, Link: LinkSystem, Title: title, Detail: d,
			Code: HintIncusWarning, Params: map[string]any{"count": n, "message": p.Warnings[0].Message}})
	}
	return out
}
