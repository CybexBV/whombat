package daemon

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/backupclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// buildStatus assembles status.report (CT-37, local-ipc.md): runtime-owned facts from the runtime's
// `GET /facts`, backup from the backup service status, update from the journal, health from the
// local health check, storage from /persist, clock sync from systemd-timesyncd.
func buildStatus(cfg *config.Config, st *update.State, facts *local.RuntimeFacts, bk *local.BackupServiceStatus,
	ev health.Evidence, free, total int64) device.StatusReportRequest {
	r := st.Record
	out := device.StatusReportRequest{
		Release: r.Current, ManagerVersion: cfg.ManagerVersion, UptimeS: uptime(cfg.Host.UptimePath),
		Update:         device.StatusReportRequestUpdate{State: r.State, Candidate: r.Candidate, Attempt: r.Attempt, Failure: r.Failure},
		SessionsActive: min(facts.ActiveSessions, 10000),
		RecoveryKit:    local.RecoveryKitState(facts.Recovery.Enrolled, facts.Recovery.KitVerified),
		ClockSynced:    exists(cfg.Host.TimeSyncedPath),
	}
	// The failure's structured detail and the running runtime's version (MG-46): codes, ids and numbers.
	if d := update.FailureDetail(st); d != nil {
		r := device.UpdateFailureReport(*d)
		out.Update.FailureDetail = &r
	}
	// Why a staged update waits (MG-53): e.g. `checkpoint`, a box that needs a backup destination for a migration.
	out.Update.Waiting = update.WaitingReport(st)
	if st.Current != nil && st.Current.RuntimeVersion != "" {
		v := st.Current.RuntimeVersion
		out.RuntimeVersion = &v
	}
	level := func(ok, reachable bool) device.HealthLevel {
		switch {
		case ok:
			return device.HealthLevelOk
		case reachable:
			return device.HealthLevelDegraded
		}
		return device.HealthLevelDown
	}
	runtime := level(ev.OK, ev.RuntimeReachable && ev.ProcessActive)
	db := level(ev.DB && ev.Access == "read-write", ev.DB)
	out.Health = device.StatusReportRequestHealth{
		Runtime: runtime, Database: db,
		Runner:          runtime, // the runtime's health covers its runner; no separate runner probe (gap)
		SessionEndpoint: level(ev.SessionListening, ev.RuntimeReachable),
		Relay: map[string]device.HealthLevel{"connected": device.HealthLevelOk, "connecting": device.HealthLevelDegraded,
			"backoff": device.HealthLevelDegraded, "stopped": device.HealthLevelDown}[facts.Relay],
		Backup: "unconfigured",
	}
	if out.Health.Relay == "" {
		out.Health.Relay = device.HealthLevelDown
	}
	if bk != nil {
		out.Health.Backup = map[string]string{"protected": "ok", "stale": "stale", "pending": "stale", "failing": "failing", "unprotected": "unconfigured"}[bk.State]
		if out.Health.Backup == "" {
			out.Health.Backup = "unconfigured"
		}
		if bk.LastSuccess != nil {
			if t, err := time.Parse(time.RFC3339Nano, bk.LastSuccess.At); err == nil {
				at := t.Unix()
				out.LastBackupAt = &at
			}
		}
	}
	if total > 0 {
		out.Storage = device.StatusReportRequestStorage{PersistUsedPct: min(100, max(0, (total-free)*100/total)), PersistFreeBytes: free}
	}
	return out
}

func uptime(p string) int64 {
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	f, err := strconv.ParseFloat(strings.Fields(string(b) + " 0")[0], 64)
	if err != nil {
		return 0
	}
	return int64(f)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// statusLoop sends status.report periodically (only while Link is on, and only until control speaks Link: then remote
// help's support.heartbeat stands for it, link.go), and soon after every update transition (MG-61; it waits
// Waits.StatusSettle first, so the transitions of one step are reported once): control's device
// record (the admin panel, release/ship) otherwise kept showing an update's old state until the next report, up to
// control's 15 minutes after the box was Healthy. Without runtime facts (runtime down since the manager started)
// nothing is sent; the last known facts are reused while the runtime is down.
//
// A report control didn't answer (the network, control restarting) is sent again after Waits.StatusRetry, then ever
// less often up to the report interval: what it says (an update's outcome, remote help turned on or off) is what
// someone is waiting for, and the next periodic report would be minutes away. Each try reads the state again.
func (d *Daemon) statusLoop(ctx context.Context) {
	every := config.Seconds(d.Cfg.StatusReportSec, 5*time.Minute)
	retry := Backoff{Base: d.Waits.StatusRetry, Max: every}
	var last *local.RuntimeFacts
	wait := d.Waits.StatusFirst
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		case <-d.statusNow:
			select {
			case <-ctx.Done():
				return
			case <-time.After(d.Waits.StatusSettle):
			}
		}
		wait = jitter(every)
		if !d.linkActive() {
			continue // no reports without Link (LNK-03)
		}
		if d.linkNewPath() {
			// Control speaks Link: remote help's state goes as support.heartbeat, the rest isn't reported (LNK-31).
			wait = d.heartbeat(ctx, every)
			continue
		}
		if f, err := d.Runtime.RuntimeFacts(ctx); err == nil {
			last = f
			d.reachable(depRuntime)
		} else if ctx.Err() == nil {
			// Away while an activation restarts it, and for a few seconds at boot (MG-62).
			d.unreachable(depRuntime, "runtime facts unavailable for status.report", err, d.runtimeRestarting())
		}
		if last == nil {
			wait = min(wait, 15*time.Second) // just started: report as soon as the runtime answers
			continue
		}
		st, err := d.Engine.Load()
		if err != nil {
			continue
		}
		var bk *local.BackupServiceStatus
		if d.Cfg.BackupSocket != "" {
			if s, err := (backupclient.Client{Socket: d.Cfg.BackupSocket}).Status(ctx); err == nil {
				bk = s
			}
		}
		free, total := persistSpace(d.Cfg.StagingDir)
		ev := d.Engine.Health.Check(ctx, "")
		rep := buildStatus(d.Cfg, st, last, bk, ev, free, total)
		// Remote help (MG-119): only when the support service answers.
		var supportKey string
		rep.Support, supportKey = d.supportReport(ctx)
		err = rep.Validate()
		if sup := rep.Support; err != nil && sup != nil {
			// Remote help that doesn't validate must not cost the whole report.
			if rep.Support = nil; rep.Validate() == nil {
				d.warnOnce("status.report's remote help does not validate (sent without it)", err)
				err = nil
			} else {
				rep.Support = sup
			}
		}
		if err != nil && rep.Update.FailureDetail != nil {
			// A detail control wouldn't take must not cost the whole report (MG-46).
			d.warnOnce("status.report's failure detail does not validate (sent without it)", err)
			rep.Update.FailureDetail = nil
			err = rep.Validate()
		}
		if err != nil {
			d.warnOnce("status.report does not validate", err)
			continue
		}
		next, err := d.Control.Status(ctx, rep)
		if err != nil {
			if !errors.Is(err, controlapi.ErrUnavailable) {
				d.warnOnce("status.report failed", err)
			} else if ctx.Err() == nil {
				d.unreachable(depControl, "status.report failed", err, false) // MG-62
				wait = retry.Next()
			}
			continue
		}
		retry.Reset()
		d.reachable(depControl)
		d.clearErr("status.report failed")
		if supportKey != "" {
			d.supportTold.Store(&supportKey) // also when remote help didn't validate: control was told what could be
		}
		if next > 0 {
			wait = jitter(next)
		}
	}
}

func persistSpace(dir string) (free, total int64) {
	free, _ = tufclient.StatfsSpace{}.Free(dir)
	total, _ = tufclient.StatfsTotal(dir)
	return free, total
}
