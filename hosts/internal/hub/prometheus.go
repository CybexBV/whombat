package hub

// GET /metrics: the fleet's latest values in the Prometheus text format
// (exposition format 0.0.4, every metric a gauge), for Prometheus,
// VictoriaMetrics or Grafana Agent. It is authenticated with an API token
// only ("Authorization: Bearer rk_…", any role); a session cookie is not
// accepted. Values come from each host's latest report and are left out
// while the host is offline (rackoon_server_up is 0 then), so a scrape
// never presents stale numbers as current.

import (
	"bytes"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

type promFamily struct {
	name, help string
	lines      []string
}

// promSet collects samples grouped by metric family (the format requires
// a family's samples to be contiguous).
type promSet struct {
	fams []*promFamily
	idx  map[string]*promFamily
}

var promEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`)

// promValue formats a sample value (Go's shortest form; NaN and ±Inf as
// Prometheus spells them).
func promValue(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// add records one sample; labels are name, value pairs.
func (s *promSet) add(name, help string, v float64, labels ...string) {
	f := s.idx[name]
	if f == nil {
		f = &promFamily{name: name, help: help}
		s.idx[name] = f
		s.fams = append(s.fams, f)
	}
	var b strings.Builder
	b.WriteString(name)
	if len(labels) > 0 {
		b.WriteByte('{')
		for i := 0; i+1 < len(labels); i += 2 {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(labels[i])
			b.WriteString(`="`)
			b.WriteString(promEscaper.Replace(labels[i+1]))
			b.WriteByte('"')
		}
		b.WriteByte('}')
	}
	b.WriteByte(' ')
	b.WriteString(promValue(v))
	f.lines = append(f.lines, b.String())
}

func (s *promSet) write(buf *bytes.Buffer) {
	for _, f := range s.fams {
		buf.WriteString("# HELP " + f.name + " " + f.help + "\n# TYPE " + f.name + " gauge\n")
		for _, l := range f.lines {
			buf.WriteString(l)
			buf.WriteByte('\n')
		}
	}
}

func b01(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// serveMetrics is GET /metrics (API token only).
func (h *Hub) serveMetrics(w http.ResponseWriter, r *http.Request) {
	p, _ := h.authenticateService(r)
	if p == nil && !h.cfg.Headless {
		p = h.authenticateToken(r)
	}
	if p == nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="rackoon"`)
		writeProblem(w, apiErr(http.StatusUnauthorized, "unauthenticated", "Send an API token: Authorization: Bearer rk_…"))
		return
	}
	var buf bytes.Buffer
	h.promMetrics().write(&buf)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	b := buf.Bytes()
	if len(b) >= gzipMinSize && acceptsGzip(r) {
		if z := gzipBytes(b); z != nil {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			b = z
		}
	}
	_, _ = w.Write(b)
}

// promMetrics builds the exposition.
func (h *Hub) promMetrics() *promSet {
	s := &promSet{idx: map[string]*promFamily{}}
	now := h.now()
	snap := h.snapshot()
	sort.Slice(snap, func(i, j int) bool { return snap[i].ID < snap[j].ID })

	connected := 0
	for _, st := range snap {
		if st.Connected {
			connected++
		}
	}
	s.add("rackoon_hub_info", "The hub's version (always 1).", 1, "version", Version)
	s.add("rackoon_hub_servers", "Enrolled servers.", float64(len(snap)))
	s.add("rackoon_hub_agents_connected", "Agents connected now.", float64(connected))
	s.add("rackoon_hub_consoles_open", "Console sessions open now.", float64(h.consolesLive.Load()))

	for _, st := range snap {
		r := st.Report
		var osName, agent string
		if r != nil {
			osName, agent = r.Host.OSPretty, r.Agent.Version
		}
		if agent == "" {
			agent = st.AgentVersion
		}
		s.add("rackoon_server_info", "Server labels (always 1).", 1, "server", st.ID, "hostname", st.Hostname, "group", st.Group,
			"os", osName, "agent_version", agent)
	}
	for _, st := range snap {
		s.add("rackoon_server_up", "1 while the server's agent reports (online or warning), 0 when offline.", b01(st.Online(now)),
			"server", st.ID)
	}
	for _, st := range snap {
		if !st.LastSeen.IsZero() {
			s.add("rackoon_server_last_seen_timestamp_seconds", "When the agent was last heard from (unix seconds).",
				float64(st.LastSeen.Unix()), "server", st.ID)
		}
	}

	// Latest values of online servers.
	type host struct {
		id string
		r  *proto.Report
		v  map[string]float64 // the stored series values
	}
	var live []host
	for _, st := range snap {
		if st.Report != nil && st.Online(now) {
			live = append(live, host{st.ID, st.Report, st.Report.Series()})
		}
	}
	for _, x := range live {
		s.add("rackoon_server_cpu_usage_percent", "CPU in use, percent of all cores (I/O wait excluded).", x.v[proto.SeriesCPU], "server", x.id)
	}
	for _, x := range live {
		if v, ok := x.v[proto.SeriesMem]; ok {
			s.add("rackoon_server_memory_usage_percent", "Memory in use, percent.", v, "server", x.id)
		}
	}
	for _, x := range live {
		s.add("rackoon_server_load1", "1-minute load average.", x.r.CPU.Load[0], "server", x.id)
	}
	for _, x := range live {
		if v, ok := x.v[proto.SeriesSwap]; ok {
			s.add("rackoon_server_swap_usage_percent", "Swap in use, percent (servers with swap).", v, "server", x.id)
		}
	}
	for _, x := range live {
		for _, se := range x.r.Sensors {
			s.add("rackoon_server_temperature_celsius", "Temperature per sensor group.", se.TempC, "server", x.id, "sensor", se.ID,
				"label", se.Label)
		}
	}
	for _, x := range live {
		for _, se := range x.r.Sensors {
			if se.LimitC > 0 {
				s.add("rackoon_server_temperature_limit_celsius", "The sensor's limit (hwmon max/crit or the class default).",
					se.LimitC, "server", x.id, "sensor", se.ID)
			}
		}
	}
	vols := func(name, help string, f func(proto.Volume) float64) {
		for _, x := range live {
			for _, v := range x.r.Volumes() {
				s.add(name, help, f(v), "server", x.id, "volume", v.Entity, "label", v.Label)
			}
		}
	}
	vols("rackoon_server_volume_used_percent", "Used space per filesystem, pool or Proxmox storage, percent.",
		func(v proto.Volume) float64 { return math.Round(float64(v.Used)/float64(v.Total)*1000) / 10 })
	vols("rackoon_server_volume_used_bytes", "Used space per volume, bytes.", func(v proto.Volume) float64 { return float64(v.Used) })
	vols("rackoon_server_volume_size_bytes", "Size per volume, bytes.", func(v proto.Volume) float64 { return float64(v.Total) })

	type guestCount struct{ total, running int }
	counts := make([]map[string]*guestCount, len(live))
	for i, x := range live {
		counts[i] = map[string]*guestCount{}
		for _, g := range x.r.AllGuests() {
			c := counts[i][g.Platform]
			if c == nil {
				c = &guestCount{}
				counts[i][g.Platform] = c
			}
			c.total++
			if g.State == proto.StateRunning || g.State == proto.StateUnhealthy {
				c.running++
			}
		}
	}
	platforms := func(m map[string]*guestCount) []string {
		var out []string
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	for i, x := range live {
		for _, pl := range platforms(counts[i]) {
			s.add("rackoon_server_guests", "VMs and containers per platform.", float64(counts[i][pl].total), "server", x.id, "platform", pl)
		}
	}
	for i, x := range live {
		for _, pl := range platforms(counts[i]) {
			s.add("rackoon_server_guests_running", "Running VMs and containers per platform (unhealthy containers included).",
				float64(counts[i][pl].running), "server", x.id, "platform", pl)
		}
	}

	// Open alerts.
	sev := map[string]int{}
	perServer := map[string]map[string]int{}
	for _, a := range h.alerts.AllOpen() {
		sev[a.Severity]++
		if a.Server != "" {
			if perServer[a.Server] == nil {
				perServer[a.Server] = map[string]int{}
			}
			perServer[a.Server][a.Severity]++
		}
	}
	for _, sv := range []string{rules.SevCritical, rules.SevWarning} {
		s.add("rackoon_alerts_open", "Open alerts by severity (hub-level alerts included).", float64(sev[sv]), "severity", sv)
	}
	for _, st := range snap {
		for _, sv := range []string{rules.SevCritical, rules.SevWarning} {
			s.add("rackoon_server_alerts_open", "Open alerts of a server by severity.", float64(perServer[st.ID][sv]), "server", st.ID,
				"severity", sv)
		}
	}

	// Checks with a result.
	type checkRow struct {
		id, name, kind, runner string
		ok                     bool
		latency                *float64
		cert                   int64
	}
	var rows []checkRow
	h.checks.mu.RLock()
	for _, c := range h.checks.list {
		st := h.checks.stateFor(c)
		if !c.Enabled || st == nil || st.Result.At.IsZero() {
			continue
		}
		row := checkRow{id: c.ID, name: c.Name, kind: c.Kind, runner: c.Runner, ok: st.Result.OK, latency: st.Result.LatencyMs}
		if st.Result.CertNotAfter != nil {
			row.cert = st.Result.CertNotAfter.Unix()
		}
		rows = append(rows, row)
	}
	h.checks.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool { return rows[i].id < rows[j].id })
	for _, c := range rows {
		s.add("rackoon_check_up", "1 when the check's latest result passed.", b01(c.ok), "check", c.id, "name", c.name, "kind", c.kind,
			"runner", c.runner)
	}
	for _, c := range rows {
		if c.latency != nil {
			s.add("rackoon_check_latency_seconds", "Latency of the check's latest result.", *c.latency/1000, "check", c.id, "name", c.name)
		}
	}
	for _, c := range rows {
		if c.cert != 0 {
			s.add("rackoon_check_certificate_expiry_timestamp_seconds", "When the checked TLS certificate expires (unix seconds).",
				float64(c.cert), "check", c.id, "name", c.name)
		}
	}
	return s
}
