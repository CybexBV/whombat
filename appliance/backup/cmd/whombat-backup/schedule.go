package main

import (
	"context"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/clearing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// backupDue is the 15-minute timer's question (BK-37, Whombat backup-options.md BKO-02): the person's policy, the
// last success and failure, and whether the newest checkpoint went to another destination.
func backupDue(cfg *state.Config, now time.Time) (bool, string) {
	d, err := state.LoadDestination(cfg)
	if err != nil || d == nil {
		return true, "no destination: the run says so" // `run` answers unprotected (exit 2) as before
	}
	st, err := state.LoadStatus(cfg)
	if err != nil {
		st = &state.Status{}
	}
	in := state.DueInput{Now: now}
	if st.LastSuccess != nil {
		t := st.LastSuccess.At
		in.LastSuccess = &t
	}
	if st.LastFailure != nil && st.LastAttemptOK != nil && !*st.LastAttemptOK {
		t := st.LastFailure.At
		in.LastFailure = &t
	}
	if last, err := state.LastChain(cfg); err == nil && last != nil && last.Repository != d.Repository {
		in.DestinationChanged = true
	}
	return state.LoadPolicy(cfg).Due(in)
}

// drillDue: the weekly restore check is on and the last one is 6½ days old.
func drillDue(cfg *state.Config, now time.Time) bool {
	var last *time.Time
	if st, err := state.LoadStatus(cfg); err == nil && st.Recoverability.LastDrill != nil {
		t := st.Recoverability.LastDrill.At
		last = &t
	}
	return state.LoadPolicy(cfg).DrillDue(now, last)
}

// clearOldBackups is the box's own clearing after a scheduled backup (internal/clearing): where this Whombat's key
// may delete, at most once a day, the person's windows and then the space limit.
func clearOldBackups(ctx context.Context, cfg *state.Config) {
	d, err := state.LoadDestination(cfg)
	if err != nil || !clearing.Due(cfg, d, time.Now()) {
		return
	}
	repo := cfg.Repo(d)
	rec := clearing.Run(ctx, cfg, d, repo, clearing.Size(d, repo), time.Now())
	switch {
	case !rec.OK:
		logf("clearing old backups: %s", rec.Error)
	case rec.OverLimit:
		logf("cleared old backups (%d steps): still over the space limit with only the last days left", len(rec.Steps))
	default:
		logf("cleared old backups (%d steps)", len(rec.Steps))
	}
	_, _ = state.UpdateStatus(cfg, nil)
}
