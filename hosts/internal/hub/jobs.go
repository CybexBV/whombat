package hub

import (
	"context"
	"fmt"
	"math"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
	"rackoon/internal/wire"
)

// StartJobs runs the background jobs until ctx is done: offline watchdog and
// heartbeat alerts, console re-authorization, rollups, retention,
// persistence of the latest reports and the platform tasks of manage
// requests.
func (h *Hub) StartJobs(ctx context.Context) {
	every := func(d time.Duration, f func(context.Context)) {
		h.bg.Add(1)
		go func() {
			defer h.bg.Done()
			t := time.NewTicker(d)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					f(ctx)
				}
			}
		}()
	}
	every(2*time.Second, h.watchdog)
	every(h.cfg.ReauthorizeInterval, h.reauthorizeConsoles)
	every(30*time.Second, h.rollup)
	every(time.Minute, func(ctx context.Context) { h.persist(ctx, false) })
	every(time.Hour, h.retention)
	every(12*time.Hour, h.renewListenerCert)
	every(30*time.Second, func(ctx context.Context) {
		h.expireAcks(ctx)
		h.evaluateHubAlerts(ctx)
	})
	every(time.Minute, h.heartbeat)
	every(15*time.Minute, h.forecastVolumes)
	every(h.cfg.TaskPollInterval, h.pollTasks)
	every(selfRefresh, h.refreshSelfMACs)
	every(addrInterval, h.refreshAddrs)
	h.bg.Add(1)
	go func() {
		defer h.bg.Done()
		h.notify.run(ctx)
	}()
	if h.assist != nil {
		h.bg.Add(1)
		go func() {
			defer h.bg.Done()
			h.assist.run(ctx)
		}()
	}
	h.bg.Add(1)
	go func() {
		defer h.bg.Done()
		h.runChecks(ctx)
	}()
	h.bg.Add(1)
	go func() {
		defer h.bg.Done()
		h.runAgentUpdates(ctx)
	}()
	h.bg.Add(1)
	go func() {
		defer h.bg.Done()
		// First rollup and retention shortly after start.
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
		h.rollup(ctx)
		h.retention(ctx)
		h.forecastVolumes(ctx)
	}()
}

// forecastVolumes fits the used-% history of the last 7 days of every
// volume and keeps the days until full for those that are filling up
// (disk.full_soon, the forecast hint and the storage section).
func (h *Hub) forecastVolumes(ctx context.Context) {
	now := h.now()
	type item struct {
		id   string
		vols []proto.Volume
	}
	var items []item
	h.mu.RLock()
	for id, s := range h.servers {
		if s.report != nil {
			items = append(items, item{id, s.report.Volumes()})
		}
	}
	h.mu.RUnlock()
	for _, it := range items {
		if len(it.vols) == 0 {
			continue
		}
		names := make([]string, 0, len(it.vols))
		for _, v := range it.vols {
			names = append(names, proto.VolumeSeries(v.Entity))
		}
		res, err := h.store.QueryMetrics(ctx, it.id, names, store.Ranges["7d"], now)
		if err != nil {
			h.log.Error("forecast", "server", it.id, "err", err)
			continue
		}
		ends := res.Grid.Ends()
		out := map[string]float64{}
		for _, v := range it.vols {
			var pts []rules.Point
			for i, x := range res.Series[proto.VolumeSeries(v.Entity)] {
				if x != nil {
					pts = append(pts, rules.Point{T: ends[i], V: *x})
				}
			}
			if days, ok := rules.Forecast(pts); ok {
				out[v.Entity] = days
			}
		}
		h.mu.Lock()
		if s, ok := h.servers[it.id]; ok {
			s.forecast = out
		}
		h.mu.Unlock()
	}
}

// watchdog marks servers offline after the heartbeat timeout, drops silent
// connections and evaluates agent.heartbeat_missing.
func (h *Hub) watchdog(ctx context.Context) {
	h.lastWatchdog.Store(time.Now().UnixNano())
	now := h.now()
	type item struct {
		id        string
		lastFrame time.Time
		created   time.Time
		conn      *AgentConn
		goneOff   bool
	}
	var items []item
	h.mu.Lock()
	for id, s := range h.servers {
		off := s.lastFrame.IsZero() || now.Sub(s.lastFrame) >= h.cfg.HeartbeatTimeout
		it := item{id: id, lastFrame: s.lastFrame, created: s.meta.CreatedAt, conn: s.conn}
		if off && !s.offline {
			s.offline = true
			it.goneOff = true
		}
		items = append(items, it)
	}
	h.mu.Unlock()
	h.nudgeRenewals(now)
	h.settleHold()
	alertsOn := now.Sub(h.startedAt) >= h.cfg.StartupAlertGrace
	for _, it := range items {
		if it.goneOff {
			h.log.Warn("server offline: no heartbeat", "server", it.id, "last_seen", it.lastFrame)
			h.bus.Publish("server.offline", map[string]any{"id": it.id, "at": it.lastFrame.UTC().Format(time.RFC3339)})
			h.publishServerUpdated(it.id)
			if it.conn != nil {
				it.conn.Close()
			}
		}
		if !alertsOn {
			continue
		}
		var conds []rules.Condition
		switch {
		case it.lastFrame.IsZero():
			if now.Sub(it.created) >= h.cfg.HeartbeatTimeout {
				c, _ := rules.HeartbeatConditionWith(time.Time{}, now, h.cfg.HeartbeatTimeout)
				c.Since = it.created
				conds = append(conds, c)
			}
		default:
			if c, missing := rules.HeartbeatConditionWith(it.lastFrame, now, h.cfg.HeartbeatTimeout); missing {
				conds = append(conds, c)
			}
		}
		// While the hub reconnects (hold.go) a missing server's alert waits; it
		// opens after the hold if the server is still missing. A server that is
		// back closes its alert at once, also one opened before the hold.
		if len(conds) > 0 && h.heartbeatHeld(it.id) {
			continue
		}
		h.applyAlerts(ctx, h.alerts.Evaluate(it.id, conds, onlyHeartbeat, now))
	}
}

// rollup recomputes the rollup tiers for recent and backfilled samples.
func (h *Hub) rollup(ctx context.Context) {
	now := h.now().Unix()
	h.rollupMu.Lock()
	from := h.rollupFrom
	if lb := now - 180; lb < from {
		from = lb
	}
	h.rollupFrom = math.MaxInt64
	h.rollupMu.Unlock()
	if err := h.store.Rollup(ctx, from, now+60); err != nil {
		h.log.Error("rollup", "err", err)
		h.markRollupDirty(from)
		return
	}
	_ = h.store.SetMeta(ctx, "rollup_done", fmt.Sprint(now))
	h.seriesCache.invalidate()
}

// retention prunes metrics, sessions, enrollments, alerts and audit.
func (h *Hub) retention(ctx context.Context) {
	now := h.now()
	if err := h.store.Retention(ctx, now); err != nil {
		h.log.Error("metrics retention", "err", err)
	}
	if err := h.store.DeleteExpiredSessions(ctx, now); err != nil {
		h.log.Error("session cleanup", "err", err)
	}
	if _, err := h.store.ExpireEnrollments(ctx, now); err != nil {
		h.log.Error("enrollment expiry", "err", err)
	}
	if err := h.store.DeleteResolvedAlertsBefore(ctx, now.Add(-90*24*time.Hour)); err != nil {
		h.log.Error("alert retention", "err", err)
	}
	if err := h.store.DeleteEndedMaintenance(ctx, now.Add(-24*time.Hour)); err != nil {
		h.log.Error("maintenance cleanup", "err", err)
	} else if err := h.reloadMaintenance(ctx); err != nil {
		h.log.Error("maintenance reload", "err", err)
	}
	if err := h.store.PruneDeliveries(ctx, now); err != nil {
		h.log.Error("delivery log retention", "err", err)
	}
	if err := h.store.DeleteExpiredTokens(ctx, now); err != nil {
		h.log.Error("token expiry", "err", err)
	}
	if err := h.store.DeleteAuditBefore(ctx, now.Add(-store.AuditMinAge-24*time.Hour), now); err != nil {
		h.log.Error("audit retention", "err", err)
	}
	h.ceremonies.prune()
	h.limits.prune()
	if err := h.store.Upkeep(ctx); err != nil {
		h.log.Error("database upkeep", "err", err)
	}
}

// reportPersistEvery is how often a server's latest report is written to
// the database (it only serves a hub restart; last_seen is written every
// minute). Rewriting every report of every server each minute was steady
// write load for nothing.
const reportPersistEvery = 5 * time.Minute

// persist writes the last-seen time of changed servers, and their latest
// report when it is older than reportPersistEvery in the database (all:
// everything, at shutdown).
func (h *Hub) persist(ctx context.Context, all bool) {
	type item struct {
		id, version, addr, hostname string
		lastFrame, reportAt         time.Time
		blob                        []byte
	}
	var items []item
	now := h.now()
	h.mu.Lock()
	for id, s := range h.servers {
		if !s.dirty && !all {
			continue
		}
		it := item{id: id, version: s.meta.AgentVersion, addr: s.meta.Address, hostname: s.meta.Hostname,
			lastFrame: s.lastFrame, reportAt: s.reportAt}
		if s.report != nil && (all || now.Sub(s.reportSavedAt) >= reportPersistEvery) {
			if b, err := wire.Marshal(s.report); err == nil {
				it.blob = b
				s.reportSavedAt = now
			}
		}
		s.dirty = false
		items = append(items, it)
	}
	h.mu.Unlock()
	for _, it := range items {
		if !it.lastFrame.IsZero() {
			if err := h.store.UpdateServerSeen(ctx, it.id, it.lastFrame, it.version, it.addr, it.hostname); err != nil {
				h.log.Error("persist last seen", "server", it.id, "err", err)
			}
		}
		if it.blob != nil {
			if err := h.store.SaveReport(ctx, it.id, it.reportAt, it.blob); err != nil {
				h.log.Error("persist report", "server", it.id, "err", err)
			}
		}
	}
}

// renewListenerCert reissues the agent listener certificate when it is
// within 30 days of expiry (the CA decides) and serves the new one.
func (h *Hub) renewListenerCert(ctx context.Context) {
	before := h.listenerCert.notAfter()
	if err := h.listenerCert.renew(); err != nil {
		h.log.Error("agent listener certificate", "err", err)
		return
	}
	if after := h.listenerCert.notAfter(); !after.Equal(before) {
		h.log.Info("agent listener certificate renewed", "not_after", after)
	}
}

// renewalNudge is when the hub closes a connection whose client certificate
// is about to expire: one day after the agent's own renewal window opened
// (RenewBefore, 10 days), so agents that renew by themselves never see it.
const renewalNudge = 9 * 24 * time.Hour

// nudgeRenewals closes agent connections that were established before their
// certificate's renewal window opened; the reconnect's handshake renews it.
// Agents from before the agent-side renewal timer need this to avoid
// expiring on a long-lived connection. A connection made inside the window
// already offered a renewal and is left alone (no reconnect loop).
func (h *Hub) nudgeRenewals(now time.Time) {
	var stale []*AgentConn
	h.mu.RLock()
	for _, s := range h.servers {
		c := s.conn
		if c == nil || s.meta.CertNotAfter.IsZero() {
			continue
		}
		due := s.meta.CertNotAfter.Add(-renewalNudge)
		if now.After(due) && c.connectedAt.Before(due) && c.serial == s.meta.CertSerial {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range stale {
		h.log.Info("closing the agent connection so it renews its certificate", "server", c.ServerID)
		c.Close()
	}
}
