package model

import (
	"fmt"
	"maps"
	"math"
	"strconv"
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
	var oldNames, backupStates, backupAges, snapNames, snapAges, pendingNames, changeCounts []string
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
			var state, age, detail string
			switch {
			case lb != nil && lb.Result == "error":
				state, detail = "failed", "failed"
			case lb != nil && now.Sub(lb.At) > BackupOldAge:
				d := now.Sub(lb.At)
				state, age, detail = "old", strconv.Itoa(wholeDays(d)), daysAgo(d)
			case lb == nil && lastJob != nil && g.StartedAt != nil && g.StartedAt.Before(lastJob.At):
				// The guest ran before the last job did, so the job could
				// have backed it up.
				state, detail = "none", "none"
			}
			if state != "" {
				old = append(old, name+" ("+detail+")")
				oldNames = append(oldNames, name)
				backupStates = append(backupStates, state)
				backupAges = append(backupAges, age)
			}
		}
		if g.OldestSnapshot != nil && now.Sub(*g.OldestSnapshot) > SnapshotOldAge {
			d := now.Sub(*g.OldestSnapshot)
			snaps = append(snaps, name+" ("+daysAgo(d)+")")
			snapNames = append(snapNames, name)
			snapAges = append(snapAges, strconv.Itoa(wholeDays(d)))
		}
		if g.PendingChanges > 0 {
			pending = append(pending, name+" ("+plural(g.PendingChanges, "change", "changes")+")")
			pendingNames = append(pendingNames, name)
			changeCounts = append(changeCounts, strconv.Itoa(g.PendingChanges))
		}
		if g.Kind == "vm" && g.GuestAgent == "not_running" && (g.State == proto.StateRunning || g.State == proto.StateUnhealthy) {
			agent = append(agent, name)
		}
	}
	var out []rules.Hint
	shown := func(values []string) []string { return values[:min(len(values), rules.UnhealthyNames)] }
	add := func(kind, severity, title string, details, names []string, extra map[string]any) {
		if len(names) > 0 {
			params := map[string]any{"count": len(names), "names": shown(names)}
			maps.Copy(params, extra)
			out = append(out, rules.Hint{Kind: kind, Severity: severity, Entity: proto.PlatformPVE, Link: rules.LinkGuests,
				Title: title, Detail: nameList(details), Code: kind, Params: params})
		}
	}
	add(HintBackupOld, rules.HintWarning, plural(len(old), "machine needs", "machines need")+" a backup", old, oldNames,
		map[string]any{"backupStates": shown(backupStates), "agesDays": shown(backupAges)})
	add(HintNoBackupJob, rules.HintInfo, plural(len(noJob), "machine isn’t", "machines aren’t")+" in a backup plan", noJob, noJob, nil)
	add(HintAgentDown, rules.HintInfo, plural(len(agent), "machine doesn’t", "machines don’t")+" report what’s inside", agent, agent, nil)
	add(HintPendingChanges, rules.HintInfo, plural(len(pending), "machine needs", "machines need")+" a restart to apply changes", pending, pendingNames,
		map[string]any{"changeCounts": shown(changeCounts)})
	add(HintSnapshotOld, rules.HintInfo, plural(len(snaps), "machine has", "machines have")+" snapshots older than 30 days", snaps, snapNames,
		map[string]any{"agesDays": shown(snapAges), "days": int(SnapshotOldAge / (24 * time.Hour))})

	// Thin storages that promise more than they have (the volumes fill as
	// guests write); the space alert covers the storage once it is full.
	for _, s := range pve.Storages {
		entity := "storage:" + s.ID
		if !s.Thin || s.TotalBytes == 0 || s.ProvisionedBytes <= s.TotalBytes || coveredBy(open, entity, rules.RuleSpaceHigh) {
			continue
		}
		out = append(out, rules.Hint{Kind: HintStorageOvercommit, Severity: rules.HintInfo, Entity: entity, Link: rules.LinkStorage,
			Code: HintStorageOvercommit, Params: map[string]any{"name": s.ID, "provisionedGB": float64(s.ProvisionedBytes) / rules.GB,
				"totalGB": float64(s.TotalBytes) / rules.GB, "pct": float64(s.ProvisionedBytes) / float64(s.TotalBytes) * 100},
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
	return plural(wholeDays(d), "day", "days")
}

func wholeDays(d time.Duration) int { return int(math.Floor(d.Hours() / 24)) }
