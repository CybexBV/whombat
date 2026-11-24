package hub

import (
	"context"
	"math"
	"regexp"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Clock skew beyond this is corrected on sample timestamps.
const skewCorrectThreshold = 30.0

func notHeartbeat(r string) bool  { return r != rules.RuleHeartbeatMissing }
func onlyHeartbeat(r string) bool { return r == rules.RuleHeartbeatMissing }

// sampleTime converts an agent timestamp to hub time: corrected by the
// measured skew when it exceeds 30 s; ok is false for timestamps outside the
// raw retention or in the future.
func (h *Hub) sampleTime(id string, t time.Time) (int64, bool) {
	h.mu.RLock()
	var skew float64
	if s, ok := h.servers[id]; ok && s.skew != nil {
		skew = *s.skew
	}
	h.mu.RUnlock()
	if math.Abs(skew) > skewCorrectThreshold {
		t = t.Add(-time.Duration(skew * float64(time.Second)))
	}
	now := h.now()
	if t.IsZero() || t.After(now.Add(2*time.Minute)) || t.Before(now.Add(-store.RawRetention+30*time.Minute)) {
		return 0, false
	}
	return t.Unix(), true
}

// seriesName accepts the series names agents may send (proto.Series and
// the volume series); backfill names outside it are dropped.
var seriesName = regexp.MustCompile(`^(cpu_pct|mem_pct|guest_disk_io_mbs|guest_net_mbps|load1|swap_pct|net_rx_mbps|net_tx_mbps|disk_read_mbs|disk_write_mbs|temp_max_c|temp_[a-z0-9_]{1,40}_c|vol_pct:(fs|pool|storage):[^\x00-\x1f]{1,200})$`)

// ingestReport stores a report: samples, latest state, alerts and events.
func (h *Hub) ingestReport(ctx context.Context, id string, r *proto.Report) {
	sanitizeReport(r)
	h.annotateReport(r)
	now := h.now()
	ts, ok := h.sampleTime(id, r.At)
	if !ok {
		ts = now.Unix()
	}
	h.mu.RLock()
	_, exists := h.servers[id]
	h.mu.RUnlock()
	if !exists { // deleted while connected: do not create orphan series
		return
	}
	if _, _, err := h.store.InsertSamples(ctx, id, []store.Sample{{TS: ts, Values: r.Series()}}); err != nil {
		h.log.Error("store samples", "server", id, "err", err)
	}
	h.guestSamples(ctx, id, r, ts)

	type change struct{ guest, state string }
	var changes []change
	var stopped []string
	var policyOff, hostShellOff bool
	h.mu.Lock()
	s, exists := h.servers[id]
	if !exists {
		h.mu.Unlock()
		return
	}
	prev := s.report
	if !s.reportAt.IsZero() && now.Sub(s.reportAt) >= h.cfg.HeartbeatTimeout {
		s.reportGapAt = s.reportAt.Add(h.cfg.HeartbeatTimeout)
	}
	s.report, s.reportAt, s.dirty = r, now, true
	s.memo.Observe(r, now)
	s.macHelperOff = model.HelperOffSince(s.macHelperOff, r, now)
	conds := append(rules.HostConditionsWithLimits(r, h.watch.limitsFor(id)), s.memo.Conditions(now)...)
	for _, v := range r.Volumes() {
		if days, ok := s.forecast[v.Entity]; ok {
			if c, ok := rules.FullSoonCondition(v.Entity, v.Label, days); ok {
				conds = append(conds, c)
			}
		}
	}
	if len(r.Host.Addresses) > 0 {
		s.meta.Address = cleanText(r.Host.Addresses[0], 64)
	}
	if v := cleanText(r.Agent.Version, 32); v != "" {
		s.meta.AgentVersion = v
	}
	dockerSeen := r.Docker != nil && r.Docker.Error == ""
	libvirtSeen := r.Libvirt != nil && r.Libvirt.Error == ""
	seen := map[string]bool{}
	unreadStops := map[string]bool{}
	for _, g := range r.AllGuests() {
		gid := model.GuestID(g.Platform, g.ID)
		seen[gid] = true
		if guestStopUnread(g) {
			unreadStops[g.Platform+"/"+g.ID] = true
		}
		switch g.Platform {
		case proto.PlatformDocker:
			if dockerSeen {
				if c, ok := rules.GuestStoppedCondition(g, false); ok && !s.plannedStop(gid, *g.FinishedAt) {
					conds = append(conds, c)
				}
			}
		case proto.PlatformLibvirt:
			if libvirtSeen {
				if c, ok := s.libvirtStoppedCondition(g, gid, now); ok {
					conds = append(conds, c)
				}
			}
		}
		if old, ok := s.guestStates[gid]; ok && old != g.State {
			changes = append(changes, change{gid, g.State})
			if g.State == proto.StateStopped {
				stopped = append(stopped, gid)
			}
		}
		s.guestStates[gid] = g.State
	}
	for gid := range s.guestStates {
		if !seen[gid] {
			delete(s.guestStates, gid)
			stopped = append(stopped, gid)
		}
	}
	for gid := range s.guestStops {
		platform, _, _ := strings.Cut(gid, ":")
		observed := (platform == proto.PlatformDocker && dockerSeen) || (platform == proto.PlatformLibvirt && libvirtSeen)
		if observed && !seen[gid] {
			delete(s.guestStops, gid)
		}
	}
	if libvirtSeen {
		for gid := range s.libvirtCrashes {
			if !seen[gid] {
				delete(s.libvirtCrashes, gid)
			}
		}
	}
	var policyChanged bool
	if prev != nil {
		policyOff = prev.Policy.Console && !r.Policy.Console
		hostShellOff = prev.Policy.HostShell && !r.Policy.HostShell
		policyChanged = prev.Policy != r.Policy
	}
	h.mu.Unlock()
	if policyChanged {
		// The agent's agent.toml changed (a reload or restart): record it, the
		// hub toggles alone do not tell the whole story.
		onOff := func(b bool) string {
			if b {
				return "on"
			}
			return "off"
		}
		pol := r.Policy
		h.auditSystem(ctx, store.AuditRecord{Event: "agent.policy_changed", Outcome: "ok", User: "agent", Server: id,
			Details: map[string]string{"console": onOff(pol.Console), "power": onOff(pol.Power), "host_shell": onOff(pol.HostShell),
				"host_power": onOff(pol.HostPower), "update": onOff(pol.Update), "manage": onOff(pol.Manage)}})
	}

	managed := func(rule, entity string) bool {
		if rule != rules.RuleGuestStopped {
			return notHeartbeat(rule)
		}
		if strings.HasPrefix(entity, "libvirt/") {
			return libvirtSeen && !unreadStops[entity]
		}
		return dockerSeen && !unreadStops[entity]
	}
	h.applyAlerts(ctx, h.alerts.EvaluateScoped(id, conds, managed, now))
	for _, cr := range r.Checks {
		h.checkResult(ctx, id, cr)
	}
	for _, c := range changes {
		h.bus.Publish("guest.state_changed", map[string]string{"server": id, "id": c.guest, "state": c.state})
	}
	for _, gid := range stopped {
		gid := gid
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.guest == gid }, "guest_stopped")
	}
	if policyOff {
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.platform != proto.PlatformHost },
			"remote_control_disabled")
	}
	if hostShellOff {
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.platform == proto.PlatformHost },
			"remote_control_disabled")
	}
	h.publishServerUpdated(id)
}

// ingestBackfill stores buffered samples (duplicates are ignored) and marks
// the rollups for recomputation.
func (h *Hub) ingestBackfill(ctx context.Context, id string, samples []proto.Sample) {
	if len(samples) > 5000 {
		samples = samples[:5000]
	}
	h.mu.RLock()
	_, exists := h.servers[id]
	h.mu.RUnlock()
	if !exists {
		return
	}
	batch := make([]store.Sample, 0, len(samples))
	dropped := 0
	for _, sm := range samples {
		ts, ok := h.sampleTime(id, sm.At)
		if !ok || len(sm.Values) > 256 {
			continue
		}
		vals := make(map[string]float64, len(sm.Values))
		for k, v := range sm.Values {
			if !seriesName.MatchString(k) {
				dropped++
				continue
			}
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				vals[k] = v
			}
		}
		batch = append(batch, store.Sample{TS: ts, Values: vals})
	}
	if dropped > 0 {
		h.log.Warn("backfill: unknown series names dropped", "server", id, "values", dropped)
	}
	// Small transactions: the single writer connection also serves the
	// audit log and sessions, which must not wait for a large backfill.
	var total int
	minTS := int64(math.MaxInt64)
	for len(batch) > 0 {
		chunk := batch[:min(len(batch), 250)]
		batch = batch[len(chunk):]
		n, m, err := h.store.InsertSamples(ctx, id, chunk)
		if err != nil {
			h.log.Error("store backfill", "server", id, "err", err)
			return
		}
		total += n
		minTS = min(minTS, m)
	}
	if total > 0 {
		h.markRollupDirty(minTS)
	}
	h.log.Info("backfill", "server", id, "samples", len(samples), "new_values", total)
}

// ingestEvent handles an immediate agent notification.
func (h *Hub) ingestEvent(id string, ev proto.Event) {
	switch ev.Kind {
	case "guest.state_changed":
		gid := model.GuestID(cleanText(ev.Platform, 16), cleanText(ev.GuestID, 256))
		state := cleanText(ev.State, 16)
		switch state {
		case proto.StateRunning, proto.StateStopped, proto.StateUnhealthy:
		default:
			return
		}
		// Only guests of the latest inventory (bounded by the report).
		h.mu.Lock()
		s, ok := h.servers[id]
		if !ok {
			h.mu.Unlock()
			return
		}
		old, known := s.guestStates[gid]
		if !known {
			h.mu.Unlock()
			return
		}
		if ev.Platform == proto.PlatformLibvirt {
			s.noteLibvirtGuestEvent(gid, ev, h.now())
		}
		if old == state {
			h.mu.Unlock()
			return
		}
		s.guestStates[gid] = state
		h.mu.Unlock()
		h.bus.Publish("guest.state_changed", map[string]string{"server": id, "id": gid, "state": state})
		if state == proto.StateStopped {
			h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.guest == gid }, "guest_stopped")
		}
	case "collector.error":
		h.log.Info("agent collector error", "server", id, "platform", cleanText(ev.Platform, 16), "message", cleanText(ev.Message, 256))
	}
}

// applyAlerts persists alert transitions and publishes them.
func (h *Hub) applyAlerts(ctx context.Context, ch rules.Changes) {
	if ch.Empty() {
		return
	}
	for _, a := range ch.Opened {
		if err := h.store.InsertAlert(ctx, a); err != nil {
			h.log.Error("store alert", "alert", a.ID, "err", err)
		}
		h.log.Info("alert opened", "server", a.Server, "rule", a.Rule, "title", a.Title)
		h.bus.Publish("alert.opened", h.buildAlert(a))
	}
	for _, a := range ch.Updated {
		if err := h.store.UpdateAlert(ctx, a); err != nil {
			h.log.Error("update alert", "alert", a.ID, "err", err)
		}
	}
	// A severity rising within its rule ended the acknowledgement; every
	// change of severity is sent (HS-193).
	for _, id := range ch.AckEnded {
		if err := h.store.SetAlertAck(ctx, id, nil); err != nil {
			h.log.Error("end acknowledgement", "alert", id, "err", err)
		}
	}
	for _, a := range ch.Severity {
		h.log.Info("alert severity changed", "server", a.Server, "rule", a.Rule, "severity", a.Severity)
		h.bus.Publish("alert.updated", h.buildAlert(a))
	}
	for _, a := range ch.Resolved {
		if err := h.store.UpdateAlert(ctx, a); err != nil {
			h.log.Error("resolve alert", "alert", a.ID, "err", err)
		}
		h.log.Info("alert resolved", "server", a.Server, "rule", a.Rule)
		h.bus.Publish("alert.resolved", h.buildAlert(a))
	}
	servers := map[string]bool{}
	for _, l := range [][]rules.Alert{ch.Opened, ch.Resolved, ch.Severity} {
		for _, a := range l {
			servers[a.Server] = true
		}
	}
	for id := range servers {
		if id != "" {
			h.publishServerUpdated(id)
		}
	}
	if h.notify != nil {
		h.notify.alertsChanged(ch)
	}
}

// publishServerUpdated sends server.updated with the fleet-card fields.
func (h *Hub) publishServerUpdated(id string) {
	st, ok := h.snapshotOne(id)
	if !ok {
		return
	}
	fs := model.BuildFleetServer(st, h.now())
	h.bus.Publish("server.updated", map[string]any{"id": id, "status": fs.Status, "status_note": fs.StatusNote,
		"current": fs.Current, "last_seen": fs.LastSeen, "agent_connected": fs.AgentConnected})
}

func (h *Hub) markRollupDirty(ts int64) {
	h.rollupMu.Lock()
	if ts < h.rollupFrom {
		h.rollupFrom = ts
	}
	h.rollupMu.Unlock()
}
