package hub

import (
	"context"
	"net/http"
	"sort"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Guest history and chart annotations.

// Guest series, sampled once a minute from the reports.
const (
	GuestSeriesCPU   = "cpu_pct"
	GuestSeriesMem   = "mem_mb"
	GuestSeriesNetRx = "net_rx_mbps"
	GuestSeriesNetTx = "net_tx_mbps"
	GuestSeriesRead  = "disk_read_mbs"
	GuestSeriesWrite = "disk_write_mbs"
	guestSampleEvery = time.Minute
	maxGuestHistory  = 300 // guests per server with history (running ones, busiest first)
)

// guestSamples stores the history of a server's running guests once a
// minute (ts is the report's sample time).
func (h *Hub) guestSamples(ctx context.Context, id string, r *proto.Report, ts int64) {
	h.mu.Lock()
	s, ok := h.servers[id]
	if !ok || ts-s.guestSampleTS < int64(guestSampleEvery/time.Second) {
		h.mu.Unlock()
		return
	}
	s.guestSampleTS = ts
	h.mu.Unlock()
	type item struct {
		owner string
		cpu   float64
		vals  map[string]float64
	}
	var items []item
	for _, g := range r.AllGuests() {
		if g.State != proto.StateRunning && g.State != proto.StateUnhealthy {
			continue
		}
		v := map[string]float64{}
		if g.CPUPct != nil {
			v[GuestSeriesCPU] = round1(*g.CPUPct)
		}
		if g.MemUsedBytes != nil {
			v[GuestSeriesMem] = float64(*g.MemUsedBytes / (1 << 20))
		}
		add := func(name string, p *float64, scale float64) {
			if p != nil {
				v[name] = round1(*p * scale)
			}
		}
		add(GuestSeriesNetRx, g.NetRxBps, 8/1e6)
		add(GuestSeriesNetTx, g.NetTxBps, 8/1e6)
		add(GuestSeriesRead, g.DiskReadBps, 1/1e6)
		add(GuestSeriesWrite, g.DiskWriteBps, 1/1e6)
		if len(v) == 0 {
			continue
		}
		items = append(items, item{store.GuestSeriesOwner(id, model.GuestID(g.Platform, g.ID)), v[GuestSeriesCPU], v})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].cpu > items[j].cpu })
	if len(items) > maxGuestHistory {
		items = items[:maxGuestHistory]
	}
	owners := map[string][]store.Sample{}
	for _, it := range items {
		owners[it.owner] = []store.Sample{{TS: ts, Values: it.vals}}
	}
	if _, err := h.store.InsertMany(ctx, owners); err != nil {
		h.log.Error("guest samples", "server", id, "err", err)
	}
}

func round1(f float64) float64 {
	if f < 0 {
		return -float64(int64(-f*10+0.5)) / 10
	}
	return float64(int64(f*10+0.5)) / 10
}

func (h *Hub) apiGuestMetrics(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	gid := r.PathValue("guestId")
	if _, _, ok := model.SplitGuestID(gid); !ok || len(gid) > 300 {
		return errNotFound
	}
	return h.writeMetrics(w, r, store.GuestSeriesOwner(st.ID, gid), st.ID, map[string]any{"guest": gid})
}

// Annotation is a marker on the charts: an alert that opened, a reboot, an
// action someone took.
type Annotation struct {
	At       string  `json:"at"`
	Kind     string  `json:"kind"` // alert | reboot | action | agent
	Severity *string `json:"severity,omitempty"`
	Text     string  `json:"text"`
}

// annotationEvents are the audited events worth a marker.
var annotationEvents = map[string]string{
	"action.finished": "action",
	"agent.updated":   "agent",
}

func (h *Hub) apiAnnotations(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	spec, end, err := h.metricsWindow(r)
	if err != nil {
		return err
	}
	from := end.Add(-spec.Dur)
	out := []Annotation{}
	alerts, err := h.store.QueryAlerts(r.Context(), store.AlertFilter{Servers: []string{st.ID}, Since: from, Until: end, Limit: 200})
	if err != nil {
		return err
	}
	for _, a := range alerts {
		sev := a.Severity
		out = append(out, Annotation{At: a.OpenedAt.UTC().Format(time.RFC3339), Kind: "alert", Severity: &sev, Text: a.Title})
	}
	if st.Report != nil {
		if b := st.Report.Host.BootTime; !b.IsZero() && b.After(from) && b.Before(end) {
			out = append(out, Annotation{At: b.UTC().Format(time.RFC3339), Kind: "reboot", Text: "Host booted"})
		}
	}
	recs, _, err := h.store.ListAudit(r.Context(), 500, 0, store.AuditFilter{Server: st.ID, Since: from})
	if err != nil {
		return err
	}
	for _, rec := range recs {
		if rec.At.After(end) || rec.Outcome != "ok" {
			continue
		}
		kind, ok := annotationEvents[rec.Event]
		if !ok {
			continue
		}
		out = append(out, Annotation{At: rec.At.UTC().Format(time.RFC3339), Kind: kind, Text: annotationText(rec, st.Report)})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	if len(out) > 200 {
		out = out[len(out)-200:]
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// actionWords are the past tense of the actions for annotations.
var actionWords = map[string]string{
	"start": "started", "stop": "stopped", "force_stop": "force-stopped", "shutdown": "shut down", "reboot": "rebooted",
	"restart": "restarted", "pause": "paused", "resume": "resumed", "snapshot_create": "snapshotted",
	"snapshot_restore": "rolled back to a snapshot", "host_reboot": "rebooted", "host_shutdown": "shut down",
}

func annotationText(rec store.AuditRecord, r *proto.Report) string {
	if rec.Event == "agent.updated" {
		if v := rec.Details["version"]; v != "" {
			return "Agent updated to " + v
		}
		return "Agent updated"
	}
	act := rec.Details["action"]
	word := actionWords[act]
	if word == "" {
		word = act
	}
	if rec.Guest == "" || rec.Guest == model.HostGuestID {
		return "Host " + word + " by " + rec.User
	}
	name := rec.Guest
	if platform, id, ok := model.SplitGuestID(rec.Guest); ok {
		name = id
		if r != nil {
			if g := r.FindGuest(platform, id); g != nil && g.Name != "" {
				name = g.Name
			}
		}
	}
	if act == "snapshot_delete" {
		return "Snapshot of " + name + " deleted by " + rec.User
	}
	return name + " " + word + " by " + rec.User
}
