package model

import (
	"fmt"
	"math"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Hint kinds of the Proxmox guest and storage hints (docs/MANAGE.md 3).
// The guest kinds are routine: one hint per kind and host lists the guests
// (like guests.unhealthy), so twenty guests without a backup job add one
// row, not twenty.
const (
	HintNoBackupJob       = "guest.no_backup_job"
	HintBackupOld         = "guest.backup_old"
	HintSnapshotOld       = "guest.snapshot_old"
	HintPendingChanges    = "guest.pending_changes"
	HintAgentDown         = "guest.agent_down"
	HintStorageOvercommit = "storage.overcommit"
)

// Thresholds of the guest hints.
const (
	BackupOldAge   = 8 * 24 * time.Hour  // last good backup of a covered guest older than this
	SnapshotOldAge = 30 * 24 * time.Hour // oldest snapshot older than this
)

// pveHints are the hints of a Proxmox node's guests and storages.
func pveHints(r *proto.Report, open []rules.Alert, now time.Time) []rules.Hint {
	pve := r.PVE
	if pve == nil {
		return nil
	}
	var noJob, old, snaps, pending, agent []string
	var lastJob *proto.PVEBackupJob
	if pve.Backups != nil {
		lastJob = pve.Backups.LastJob
	}
	backupFailed := coveredBy(open, "vzdump", rules.RuleBackupFailed)
	for i := range pve.Guests {
		g := &pve.Guests[i]
		name := g.Name
		if name == "" {
			name = g.ID
		}
		if g.BackupJob != nil && !*g.BackupJob {
			noJob = append(noJob, name)
		}
		if g.BackupJob != nil && *g.BackupJob && !backupFailed {
			lb := g.LastBackup
			switch {
			case lb != nil && lb.Result == "error":
				old = append(old, name+" (failed)")
			case lb != nil && now.Sub(lb.At) > BackupOldAge:
				old = append(old, name+" ("+daysAgo(now.Sub(lb.At))+")")
			case lb == nil && lastJob != nil && g.StartedAt != nil && g.StartedAt.Before(lastJob.At):
				// The guest ran before the last job did, so the job could
				// have backed it up.
				old = append(old, name+" (none)")
			}
		}
		if g.OldestSnapshot != nil && now.Sub(*g.OldestSnapshot) > SnapshotOldAge {
			snaps = append(snaps, name+" ("+daysAgo(now.Sub(*g.OldestSnapshot))+")")
		}
		if g.PendingChanges > 0 {
			pending = append(pending, name+" ("+plural(g.PendingChanges, "change", "changes")+")")
		}
		if g.Kind == "vm" && g.GuestAgent == "not_running" && (g.State == proto.StateRunning || g.State == proto.StateUnhealthy) {
			agent = append(agent, name)
		}
	}
	var out []rules.Hint
	add := func(kind, severity string, guests []string, title string) {
		if len(guests) > 0 {
			out = append(out, rules.Hint{Kind: kind, Severity: severity, Entity: proto.PlatformPVE, Link: rules.LinkGuests,
				Title: title, Detail: nameList(guests)})
		}
	}
	add(HintBackupOld, rules.HintWarning, old, plural(len(old), "machine needs", "machines need")+" a backup")
	add(HintNoBackupJob, rules.HintInfo, noJob, plural(len(noJob), "machine isn’t", "machines aren’t")+" in a backup plan")
	add(HintAgentDown, rules.HintInfo, agent, plural(len(agent), "machine doesn’t", "machines don’t")+" report what’s inside")
	add(HintPendingChanges, rules.HintInfo, pending, plural(len(pending), "machine needs", "machines need")+" a restart to apply changes")
	add(HintSnapshotOld, rules.HintInfo, snaps, plural(len(snaps), "machine has", "machines have")+" snapshots older than 30 days")

	// Thin storages that promise more than they have (the volumes fill as
	// guests write); the space alert covers the storage once it is full.
	for _, s := range pve.Storages {
		entity := "storage:" + s.ID
		if !s.Thin || s.TotalBytes == 0 || s.ProvisionedBytes <= s.TotalBytes || coveredBy(open, entity, rules.RuleSpaceHigh) {
			continue
		}
		out = append(out, rules.Hint{Kind: HintStorageOvercommit, Severity: rules.HintInfo, Entity: entity, Link: rules.LinkStorage,
			Title: "Storage “" + s.ID + "” has promised more space than it has",
			Detail: fmt.Sprintf("Its machines may grow to %s; it holds %s (%s)", rules.FormatStorageGB(float64(s.ProvisionedBytes)/rules.GB),
				rules.FormatStorageGB(float64(s.TotalBytes)/rules.GB), rules.FormatPct(float64(s.ProvisionedBytes)/float64(s.TotalBytes)*100))})
	}
	return out
}

// coveredBy reports whether an open alert of one of the rules concerns the
// entity (the hint is then left out).
func coveredBy(open []rules.Alert, entity string, ruleIDs ...string) bool {
	for _, a := range open {
		if a.Entity != entity || a.State == rules.AlertResolved {
			continue
		}
		for _, id := range ruleIDs {
			if a.Rule == id {
				return true
			}
		}
	}
	return false
}

// nameList joins the first rules.UnhealthyNames entries, then "…".
func nameList(l []string) string {
	if len(l) > rules.UnhealthyNames {
		return strings.Join(l[:rules.UnhealthyNames], ", ") + ", …"
	}
	return strings.Join(l, ", ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// daysAgo is an age in whole days ("12 days").
func daysAgo(d time.Duration) string {
	return plural(int(math.Floor(d.Hours()/24)), "day", "days")
}
