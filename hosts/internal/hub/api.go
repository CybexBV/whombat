package hub

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

const (
	viewer   = store.RoleViewer
	operator = store.RoleOperator
	admin    = store.RoleAdmin
	anyone   = ""
)

// UIHandler serves the REST API, the console WebSocket, install.sh, agent
// downloads and the single-page UI. Headless (docs/WHOMBAT.md) it serves
// only the data routes: no UI, sign-in, users, tokens, notification
// channels or assistant, and install.sh and the downloads only on the
// agent listener.
func (h *Hub) UIHandler() http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern, role string, f handlerFunc) { mux.Handle(pattern, h.route(role, f)) }

	if !h.cfg.Headless {
		h.authRoutes(handle)
	}
	h.dataRoutes(handle)
	if !h.cfg.Headless {
		handle("GET /api/v1/channels", admin, h.apiChannels)
		handle("POST /api/v1/channels", admin, h.apiCreateChannel)
		handle("POST /api/v1/channels/test", admin, h.apiTestChannel)
		handle("PATCH /api/v1/channels/{id}", admin, h.apiPatchChannel)
		handle("DELETE /api/v1/channels/{id}", admin, h.apiDeleteChannel)
		handle("POST /api/v1/channels/{id}/test", admin, h.apiTestChannel)
		handle("GET /api/v1/deliveries", admin, h.apiDeliveries)
		handle("GET /api/v1/notification-settings", admin, h.apiNotifySettings)
		handle("PUT /api/v1/notification-settings", admin, h.apiNotifySettings)
		h.assistRoutes(handle)
	}

	mux.Handle("/api/", h.route(anyone, func(w http.ResponseWriter, r *http.Request, p *principal) error {
		return errNotFound
	}))
	mux.HandleFunc("GET /healthz", h.serveHealth)
	// Prometheus scrape (API tokens, or the service token; no session cookie).
	mux.HandleFunc("GET /metrics", h.serveMetrics)
	// Heartbeat pings from cron jobs (the token is the credential).
	mux.HandleFunc("/ping/{token}", h.servePing)
	mux.HandleFunc("/ping/{token}/{what}", h.servePing)
	if h.cfg.Headless {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			writeProblem(w, errNotFound)
		})
		return h.securityHeaders(h.logRequests(mux))
	}
	// Signed links in notifications (no session, no CSRF: the link is the
	// credential for one alert).
	mux.HandleFunc("POST /api/v1/alerts/{id}/ack-link", h.serveAckLink)
	mux.HandleFunc("GET /install.sh", h.installScript(false))
	mux.HandleFunc("GET /download/{name}", h.serveDownload)
	mux.Handle("/", h.staticHandler())
	return h.securityHeaders(h.logRequests(mux))
}

// authRoutes are sign-in, passkeys, single sign-on, kiosk links, API
// tokens and users (not headless).
func (h *Hub) authRoutes(handle func(pattern, role string, f handlerFunc)) {
	handle("GET /api/v1/auth/state", anyone, h.apiAuthState)
	handle("POST /api/v1/auth/setup", anyone, h.apiSetup)
	handle("POST /api/v1/auth/login", anyone, h.apiLogin)
	handle("POST /api/v1/auth/logout", anyone, h.apiLogout)
	handle("POST /api/v1/auth/password", viewer, h.apiChangePassword)
	handle("POST /api/v1/auth/passkey/register/begin", viewer, h.apiPasskeyRegisterBegin)
	handle("POST /api/v1/auth/passkey/register/finish", viewer, h.apiPasskeyRegisterFinish)
	handle("POST /api/v1/auth/passkey/login/begin", anyone, h.apiPasskeyLoginBegin)
	handle("POST /api/v1/auth/passkey/login/finish", anyone, h.apiPasskeyLoginFinish)
	handle("GET /api/v1/auth/passkeys", viewer, h.apiPasskeyList)
	handle("DELETE /api/v1/auth/passkeys/{id}", viewer, h.apiPasskeyDelete)
	handle("POST /api/v1/auth/reauth", viewer, h.apiReauth)
	handle("POST /api/v1/auth/passkey/reauth/begin", viewer, h.apiPasskeyReauthBegin)
	handle("POST /api/v1/auth/passkey/reauth/finish", viewer, h.apiPasskeyReauthFinish)
	handle("POST /api/v1/auth/kiosk", anyone, h.apiKiosk)
	handle("GET /api/v1/tokens", viewer, h.apiTokens)
	handle("POST /api/v1/tokens", viewer, h.apiCreateToken)
	handle("DELETE /api/v1/tokens/{id}", viewer, h.apiDeleteToken)
	handle("GET /api/v1/auth/oidc/start", anyone, h.apiOIDCStart)
	handle("GET /api/v1/auth/oidc/callback", anyone, h.apiOIDCCallback)
	handle("GET /api/v1/users", admin, h.apiUsers)
	handle("POST /api/v1/users", admin, h.apiCreateUser)
	handle("PATCH /api/v1/users/{id}", admin, h.apiPatchUser)
	handle("DELETE /api/v1/users/{id}", admin, h.apiDeleteUser)
	handle("GET /api/v1/users/{id}/sessions", admin, h.apiUserSessions)
	handle("DELETE /api/v1/users/{id}/sessions", admin, h.apiRevokeUserSessions)
	handle("DELETE /api/v1/users/{id}/sessions/{sid}", admin, h.apiRevokeUserSessions)
}

// dataRoutes are servers, guests, alerts, maintenance, events,
// enrollments, consoles, actions, manage, checks, diagnostics and the
// audit log: what the UI and, headless, the Whombat server use.
func (h *Hub) dataRoutes(handle func(pattern, role string, f handlerFunc)) {
	// Read.
	handle("GET /api/v1/fleet", viewer, h.apiFleet)
	handle("GET /api/v1/fleet/series", viewer, h.apiFleetSeries)
	handle("GET /api/v1/servers", viewer, h.apiServers)
	handle("GET /api/v1/servers/{id}", viewer, h.apiServer)
	handle("GET /api/v1/servers/{id}/metrics", viewer, h.apiMetrics)
	handle("GET /api/v1/servers/{id}/annotations", viewer, h.apiAnnotations)
	handle("GET /api/v1/servers/{id}/guests/{guestId}/metrics", viewer, h.apiGuestMetrics)
	handle("GET /api/v1/servers/{id}/guests", viewer, h.apiGuests)
	handle("GET /api/v1/servers/{id}/guests/{guestId}", viewer, h.apiGuest)
	handle("GET /api/v1/guests", viewer, h.apiSearchGuests)
	handle("GET /api/v1/alerts", viewer, h.apiAlerts)
	handle("POST /api/v1/alerts/{id}/ack", viewer, h.apiAckAlert)
	handle("DELETE /api/v1/alerts/{id}/ack", viewer, h.apiUnackAlert)
	handle("GET /api/v1/servers/{id}/watch", viewer, h.apiWatch)
	handle("PUT /api/v1/servers/{id}/watch", operator, h.apiPutWatch)
	handle("GET /api/v1/maintenance", viewer, h.apiMaintenance)
	handle("POST /api/v1/maintenance", operator, h.apiCreateMaintenance)
	handle("DELETE /api/v1/maintenance/{id}", operator, h.apiDeleteMaintenance)
	handle("GET /api/v1/events", viewer, h.apiEvents)
	handle("GET /api/v1/groups", viewer, h.apiGroups)

	// Admin.
	handle("POST /api/v1/enrollments", admin, h.apiCreateEnrollment)
	handle("GET /api/v1/enrollments", admin, h.apiListEnrollments)
	handle("POST /api/v1/enrollments/{id}/approve", admin, h.apiApproveEnrollment)
	handle("POST /api/v1/enrollments/{id}/reject", admin, h.apiRejectEnrollment)
	handle("GET /api/v1/agent-install.sh", admin, h.apiAgentInstallScript)
	handle("GET /api/v1/servers/{id}/settings", admin, h.apiServerSettings)
	handle("PATCH /api/v1/servers/{id}", admin, h.apiPatchServer)
	handle("DELETE /api/v1/servers/{id}", admin, h.apiDeleteServer)
	handle("GET /api/v1/agents", admin, h.apiAgents)
	handle("GET /api/v1/audit", admin, h.apiAudit)
	handle("GET /api/v1/audit/export", admin, h.apiAuditExport)
	handle("GET /api/v1/hub", admin, h.apiHubInfo)
	handle("GET /api/v1/hub/backup", admin, h.apiHubBackup)
	handle("POST /api/v1/hub/restore", admin, h.apiHubRestore)
	handle("POST /api/v1/hub/agents/move", admin, h.apiMoveAgents)

	// Console, actions, screens (role checks inside: denials are audited).
	handle("POST /api/v1/servers/{id}/guests/{guestId}/console-sessions", viewer, h.apiCreateConsole)
	handle("GET /api/v1/console/{sid}", viewer, h.apiConsoleWS)
	handle("GET /api/v1/console-sessions", admin, h.apiListConsoles)
	handle("DELETE /api/v1/console-sessions/{sid}", viewer, h.apiDeleteConsole)
	handle("POST /api/v1/servers/{id}/guests/{guestId}/actions", viewer, h.apiAction)
	handle("GET /api/v1/servers/{id}/guests/{guestId}/thumbnail", viewer, h.apiThumbnail)
	handle("GET /api/v1/servers/{id}/guests/{guestId}/screenshot", viewer, h.apiScreenshot)
	handle("GET /api/v1/servers/{id}/guests/{guestId}/snapshots", viewer, h.apiSnapshots)
	handle("POST /api/v1/servers/{id}/console-sessions", viewer, h.apiCreateConsole)
	handle("POST /api/v1/servers/{id}/actions", viewer, h.apiAction)
	handle("GET /api/v1/servers/{id}/inspect/{kind}", viewer, h.apiInspect)
	handle("POST /api/v1/agents/update", admin, h.apiUpdateAgents)
	handle("GET /api/v1/agents/settings", admin, h.apiAgentSettings)
	handle("PATCH /api/v1/agents/settings", admin, h.apiPatchAgentSettings)
	// Managing guests (docs/MANAGE.md; role, switches and re-authentication
	// checked inside).
	for _, rt := range manageRoutes {
		handle(rt.method+" /api/v1/servers/{id}"+rt.path, viewer, h.manageHandler(rt))
	}
	// Diagnostics and commands (docs/WHOMBAT.md; role and switches inside).
	handle("GET /api/v1/servers/{id}/diagnose", viewer, h.apiDiagnoseList)
	handle("POST /api/v1/servers/{id}/diagnose", viewer, h.apiDiagnose)
	handle("GET /api/v1/servers/{id}/disk-usage", viewer, h.apiDiskUsageList)
	handle("POST /api/v1/servers/{id}/disk-usage", viewer, h.apiDiskUsage)
	handle("POST /api/v1/servers/{id}/exec", viewer, h.apiExec)
	handle("POST /api/v1/servers/{id}/screen", viewer, h.apiScreen)
	handle("GET /api/v1/checks", viewer, h.apiChecks)
	handle("GET /api/v1/checks/{id}", viewer, h.apiGetCheck)
	handle("POST /api/v1/checks", admin, h.apiCreateCheck)
	handle("PATCH /api/v1/checks/{id}", admin, h.apiPatchCheck)
	handle("DELETE /api/v1/checks/{id}", admin, h.apiDeleteCheck)
}

func rangeParam(r *http.Request) (store.RangeSpec, error) {
	name := r.URL.Query().Get("range")
	if name == "" {
		name = "24h"
	}
	spec, ok := store.Ranges[name]
	if !ok {
		return spec, apiErr(http.StatusBadRequest, "invalid_range", "range must be one of 1h, 6h, 24h, 7d, 30d, 90d.")
	}
	return spec, nil
}

func (h *Hub) apiFleet(w http.ResponseWriter, r *http.Request, p *principal) error {
	if _, err := rangeParam(r); err != nil {
		return err
	}
	pending, _ := h.store.CountEnrollments(r.Context(), store.EnrollPending)
	writeJSON(w, r, http.StatusOK, model.BuildFleet(h.snapshot(), r.URL.Query().Get("group"), h.now(), pending, Version,
		h.alerts.Open("")...))
	return nil
}

// serverListEntry is a GET /servers item with the caller's remote-control
// permissions on it (the fleet-wide guest list offers power actions).
type serverListEntry struct {
	model.ServerListItem
	RemoteControl model.RemoteControl `json:"remote_control"`
}

func (h *Hub) apiServers(w http.ResponseWriter, r *http.Request, p *principal) error {
	states := h.snapshot()
	list := model.BuildServerList(states, h.now())
	insecure := h.consoleTransport(r) != nil
	out := make([]serverListEntry, 0, len(list))
	for i, it := range list {
		e := serverListEntry{ServerListItem: it}
		if i < len(states) && states[i].ID == it.ID {
			e.RemoteControl = model.Perms(states[i], p.rank())
			reason := model.ReasonInsecure
			if insecure && e.RemoteControl.Console {
				e.RemoteControl.Console, e.RemoteControl.ConsoleReason = false, &reason
			}
			if insecure && e.RemoteControl.HostShell {
				e.RemoteControl.HostShell, e.RemoteControl.HostShellReason = false, &reason
			}
		}
		out = append(out, e)
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) apiGroups(w http.ResponseWriter, r *http.Request, p *principal) error {
	out := []string{}
	for _, g := range model.Groups(h.snapshot())[1:] {
		out = append(out, g.Name)
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) server(id string) (*model.ServerState, error) {
	st, ok := h.snapshotOne(id)
	if !ok {
		return nil, apiErr(http.StatusNotFound, "server_not_found", "No server "+strconv.Quote(id)+".")
	}
	return st, nil
}

// nodeAgents maps Proxmox node names to enrolled servers.
func (h *Hub) nodeAgents() map[string]model.NodeAgent {
	out := map[string]model.NodeAgent{}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for id, s := range h.servers {
		if s.report != nil && s.report.PVE != nil && s.report.PVE.Node != "" {
			out[s.report.PVE.Node] = model.NodeAgent{ServerID: id, Connected: s.conn != nil}
		}
	}
	return out
}

func (h *Hub) apiServer(w http.ResponseWriter, r *http.Request, p *principal) error {
	spec, err := rangeParam(r)
	if err != nil {
		return err
	}
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	now := h.now()
	var names []string
	if st.Report != nil {
		for _, s := range st.Report.Sensors {
			names = append(names, proto.SensorSeries(s.ID))
		}
	}
	max, err := h.store.MaxOverRange(r.Context(), st.ID, names, spec, now)
	if err != nil {
		return err
	}
	d := model.BuildDetail(st, now, model.DetailInput{Range: spec.Name, SensorMax: max, RoleRank: p.rank(),
		NodeAgents: h.nodeAgents(), HubVersion: Version, InsecureTransport: h.consoleTransport(r) != nil})
	if !st.ReportAt.IsZero() {
		first, err := h.store.FirstMetricAt(r.Context(), st.ID, proto.SeriesCPU)
		if err != nil {
			return err
		}
		if first.IsZero() || first.After(st.ReportAt) {
			first = st.ReportAt
		}
		d.Server.FirstReportAt = model.T(first)
	}
	if d.MacOS != nil {
		// Whombat Helper: the hub's build and how this Mac's follows it.
		man, manErr := h.manifest()
		if manErr == nil {
			f, _ := man.helper()
			d.MacOS.Helper.Latest = sp(f.Version)
		}
		d.MacOS.Helper.Update = h.helperInfoFor(st, man, manErr)
	}
	writeJSON(w, r, http.StatusOK, d)
	return nil
}

type metricsSummary struct {
	Avg   float64 `json:"avg"`
	Max   float64 `json:"max"`
	MaxAt *string `json:"max_at"`
}

// metricsWindow is the range of a metrics query: ?range=, or a custom
// window ?from=&to= (RFC 3339; to defaults to now). end is the grid's end.
func (h *Hub) metricsWindow(r *http.Request) (spec store.RangeSpec, end time.Time, err error) {
	now := h.now()
	q := r.URL.Query()
	if q.Get("from") == "" {
		spec, err = rangeParam(r)
		return spec, now, err
	}
	bad := apiErr(http.StatusBadRequest, "invalid_range", "from and to must be RFC 3339 times at least 10 minutes apart within the last 90 days.")
	from, err := time.Parse(time.RFC3339, q.Get("from"))
	if err != nil {
		return spec, now, bad
	}
	end = now
	if t := q.Get("to"); t != "" {
		if end, err = time.Parse(time.RFC3339, t); err != nil {
			return spec, now, bad
		}
		if end.After(now) {
			end = now
		}
	}
	if spec, err = store.CustomRange(from, end, now); err != nil {
		return spec, now, bad
	}
	return spec, end, nil
}

func (h *Hub) apiMetrics(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	return h.writeMetrics(w, r, st.ID, st.ID, nil)
}

// writeMetrics answers a metrics query for a series owner (a server, a
// guest); key is the "server" value of the answer.
func (h *Hub) writeMetrics(w http.ResponseWriter, r *http.Request, owner, key string, extra map[string]any) error {
	spec, end, err := h.metricsWindow(r)
	if err != nil {
		return err
	}
	var names []string
	if s := r.URL.Query().Get("series"); s != "" {
		for _, n := range strings.Split(s, ",") {
			if n = strings.TrimSpace(n); n != "" && len(names) < 64 {
				names = append(names, n)
			}
		}
	}
	res, err := h.store.QueryMetrics(r.Context(), owner, names, spec, end)
	if err != nil {
		return err
	}
	ts := []string{}
	for _, t := range res.Grid.Ends() {
		ts = append(ts, t.Format(time.RFC3339))
	}
	sum := map[string]*metricsSummary{}
	for n, s := range res.Summary {
		if s == nil {
			sum[n] = nil
			continue
		}
		ms := &metricsSummary{Avg: s.Avg, Max: s.Max}
		if !s.MaxAt.IsZero() {
			v := s.MaxAt.UTC().Format(time.RFC3339)
			ms.MaxAt = &v
		}
		sum[n] = ms
	}
	out := map[string]any{
		"server": key, "range": spec.Name, "step_seconds": spec.Step, "points": spec.Points,
		"as_of": end.UTC().Format(time.RFC3339), "timestamps": ts, "series": res.Series, "summary": sum,
	}
	for k, v := range extra {
		out[k] = v
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) apiGuests(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	gq := model.GuestListQuery{Platform: q.Get("platform"), Kind: q.Get("kind"), Q: q.Get("q"), Sort: q.Get("sort"),
		Limit: limit, Cursor: q.Get("cursor")}
	switch gq.Platform {
	case "", proto.PlatformDocker, proto.PlatformIncus, proto.PlatformLibvirt, proto.PlatformPVE:
	case "vm", "ct": // the UI's Proxmox tab names
		gq.Platform, gq.Kind = proto.PlatformPVE, map[string]string{"vm": "vm", "ct": "container"}[gq.Platform]
	default:
		return apiErr(http.StatusBadRequest, "invalid_platform", "platform must be docker, incus, libvirt or pve.")
	}
	if gq.Kind != "" && gq.Kind != "vm" && gq.Kind != "container" {
		return apiErr(http.StatusBadRequest, "invalid_kind", "kind must be vm or container.")
	}
	writeJSON(w, r, http.StatusOK, model.ListGuests(st.Report, gq, h.now()))
	return nil
}

func (h *Hub) apiSearchGuests(w http.ResponseWriter, r *http.Request, p *principal) error {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	gq := model.FleetGuestQuery{Q: q.Get("q"), State: q.Get("state"), Platform: q.Get("platform"), Kind: q.Get("kind"),
		Server: q.Get("server"), Tag: q.Get("tag"), Sort: q.Get("sort"), Limit: limit, Cursor: q.Get("cursor")}
	switch gq.State {
	case "", proto.StateRunning, proto.StateStopped, proto.StateUnhealthy:
	default:
		return apiErr(http.StatusBadRequest, "invalid_state", "state must be running, stopped or unhealthy.")
	}
	switch gq.Platform {
	case "", proto.PlatformDocker, proto.PlatformIncus, proto.PlatformLibvirt, proto.PlatformPVE:
	default:
		return apiErr(http.StatusBadRequest, "invalid_platform", "platform must be docker, incus, libvirt or pve.")
	}
	if gq.Kind != "" && gq.Kind != "vm" && gq.Kind != "container" {
		return apiErr(http.StatusBadRequest, "invalid_kind", "kind must be vm or container.")
	}
	writeJSON(w, r, http.StatusOK, model.SearchGuests(h.snapshot(), gq, h.now()))
	return nil
}

// findTemplate resolves a Proxmox template ("pve:9000") of a server's
// latest report as a stopped guest.
func findTemplate(st *model.ServerState, gid string) (proto.PlatformGuest, bool) {
	platform, id, ok := model.SplitGuestID(gid)
	if !ok || platform != proto.PlatformPVE || st.Report == nil || st.Report.PVE == nil {
		return proto.PlatformGuest{}, false
	}
	for _, t := range st.Report.PVE.Templates {
		if t.ID == id {
			vmid, _ := strconv.Atoi(t.ID)
			return proto.PlatformGuest{Platform: platform, Guest: &proto.Guest{ID: t.ID, Name: t.Name, Kind: t.Kind,
				State: proto.StateStopped, VMID: vmid, Node: t.Node}}, true
		}
	}
	return proto.PlatformGuest{}, false
}

// findGuest resolves a guest id of a server's latest report.
func findGuest(st *model.ServerState, gid string) (proto.PlatformGuest, bool) {
	platform, id, ok := model.SplitGuestID(gid)
	if !ok || st.Report == nil {
		return proto.PlatformGuest{}, false
	}
	g := st.Report.FindGuest(platform, id)
	if g == nil {
		return proto.PlatformGuest{}, false
	}
	return proto.PlatformGuest{Platform: platform, Guest: g}, true
}

var errGuestNotFound = apiErr(http.StatusNotFound, "guest_not_found", "No such guest on this server.")

func (h *Hub) apiGuest(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	g, ok := findGuest(st, r.PathValue("guestId"))
	if !ok {
		return errGuestNotFound
	}
	writeJSON(w, r, http.StatusOK, model.BuildGuest(g, h.now()))
	return nil
}

// apiEvents is the Server-Sent Events stream.
func (h *Hub) apiEvents(w http.ResponseWriter, r *http.Request, p *principal) error {
	fl, ok := w.(http.Flusher)
	if !ok {
		return apiErr(500, "internal", "Streaming unsupported.")
	}
	var last uint64
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		last, _ = strconv.ParseUint(v, 10, 64)
	} else if v := r.URL.Query().Get("last_event_id"); v != "" {
		last, _ = strconv.ParseUint(v, 10, 64)
	}
	sub, backlog, gap := h.bus.Subscribe(p.user.ID, p.rank(), last)
	defer h.bus.Unsubscribe(sub)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	write := func(ev Event) bool {
		if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.ID, ev.Name, ev.Data); err != nil {
			return false
		}
		return true
	}
	fmt.Fprint(w, "retry: 5000\n\n")
	if gap {
		fmt.Fprintf(w, "id: %d\nevent: resync\ndata: {}\n\n", h.bus.LastID())
	}
	for _, ev := range backlog {
		if !write(ev) {
			return nil
		}
	}
	fl.Flush()
	keep := time.NewTicker(20 * time.Second)
	defer keep.Stop()
	sessHash := p.tokenHsh
	for {
		select {
		case <-r.Context().Done():
			return nil
		case <-sub.Done():
			return nil
		case ev := <-sub.C:
			if !write(ev) {
				return nil
			}
			// Drain what is queued, then flush once.
		drain:
			for n := 0; n < 64; n++ {
				select {
				case ev := <-sub.C:
					if !write(ev) {
						return nil
					}
				default:
					break drain
				}
			}
			fl.Flush()
		case <-keep.C:
			// End the stream when the session was signed out (or the token
			// deleted).
			if p.service != nil {
				if !h.svc.current(p.tokenHsh) {
					return nil
				}
			} else if p.token != nil {
				if _, err := h.store.GetToken(r.Context(), p.token.ID); err != nil {
					return nil
				}
			} else if se, err := h.store.GetSession(r.Context(), sessHash); err != nil || !se.Live(h.now()) {
				return nil
			}
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return nil
			}
			fl.Flush()
		}
	}
}

// ---- fleet series ---------------------------------------------------------------

type seriesCache struct {
	mu sync.Mutex
	m  map[string]cachedSeries
}

type cachedSeries struct {
	at   time.Time
	body any
}

func newSeriesCache() *seriesCache { return &seriesCache{m: map[string]cachedSeries{}} }

func (c *seriesCache) get(key string, ttl time.Duration) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[key]
	if !ok || time.Since(v.at) > ttl {
		return nil, false
	}
	return v.body, true
}

func (c *seriesCache) put(key string, body any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > 256 {
		c.m = map[string]cachedSeries{}
	}
	c.m[key] = cachedSeries{at: time.Now(), body: body}
}

// invalidate drops short-range entries (new samples); long ranges keep
// their bucket-sized cache.
func (c *seriesCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		if strings.HasPrefix(k, "1h|") || strings.HasPrefix(k, "6h|") {
			delete(c.m, k)
		}
	}
}

func (c *seriesCache) invalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m = map[string]cachedSeries{}
}

func seriesTTL(rng string) time.Duration {
	switch rng {
	case "1h", "6h":
		return 5 * time.Second
	case "24h":
		return 30 * time.Second
	}
	return time.Minute
}

type seriesBlock struct {
	StepS      int64      `json:"step_s"`
	Timestamps []string   `json:"timestamps,omitempty"`
	CPU        []*float64 `json:"cpu_pct"`
	Mem        []*float64 `json:"mem_pct"`
	// Per server (the overview's metric switch): host network in + out
	// (Mb/s) and the hottest sensor (°C).
	Net  []*float64 `json:"net_mbps,omitempty"`
	Temp []*float64 `json:"temp_max_c,omitempty"`
}

func avgSlice(aggs []store.Agg, n int) []*float64 {
	out := make([]*float64, n)
	for i := 0; i < n && i < len(aggs); i++ {
		if aggs[i].Count > 0 {
			v := float64(int64(aggs[i].Avg()*10+0.5)) / 10
			out[i] = &v
		}
	}
	return out
}

func ends(g store.Grid) []string {
	out := []string{}
	for _, t := range g.Ends() {
		out = append(out, t.Format(time.RFC3339))
	}
	return out
}

func (h *Hub) apiFleetSeries(w http.ResponseWriter, r *http.Request, p *principal) error {
	spec, err := rangeParam(r)
	if err != nil {
		return err
	}
	group := r.URL.Query().Get("group")
	key := spec.Name + "|" + strings.ToLower(group)
	if body, ok := h.seriesCache.get(key, seriesTTL(spec.Name)); ok {
		writeJSON(w, r, http.StatusOK, body)
		return nil
	}
	now := h.now()
	snap := h.snapshot()
	var ids []string
	memTotal := map[string]float64{}
	for _, s := range snap {
		if model.InGroup(s, group) {
			ids = append(ids, s.ID)
			memTotal[s.ID] = float64(rules.HostMemoryBytes(s.Report))
		}
	}
	spark := store.GridFor(now, spec.Dur, 60)
	heat := store.GridFor(now, spec.Dur, 48)
	ctx := r.Context()
	cpu, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesCPU, ids, spark)
	if err != nil {
		return err
	}
	mem, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesMem, ids, spark)
	if err != nil {
		return err
	}
	hcpu, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesCPU, ids, heat)
	if err != nil {
		return err
	}
	rx, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesNetRx, ids, spark)
	if err != nil {
		return err
	}
	tx, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesNetTx, ids, spark)
	if err != nil {
		return err
	}
	temp, err := h.store.GridQuery(ctx, spec.Tier, proto.SeriesTempMax, ids, spark)
	if err != nil {
		return err
	}
	servers := map[string]seriesBlock{}
	heatmap := map[string][]*float64{}
	for _, id := range ids {
		b := seriesBlock{StepS: spark.Step, CPU: avgSlice(cpu[id], spark.N), Mem: avgSlice(mem[id], spark.N)}
		if len(rx[id]) > 0 {
			r, t := avgSlice(rx[id], spark.N), avgSlice(tx[id], spark.N)
			b.Net = make([]*float64, spark.N)
			for i := range r {
				if r[i] != nil {
					v := *r[i]
					if t[i] != nil {
						v += *t[i]
					}
					v = float64(int64(v*10+0.5)) / 10
					b.Net[i] = &v
				}
			}
		}
		if len(temp[id]) > 0 {
			b.Temp = avgSlice(temp[id], spark.N)
		}
		servers[id] = b
		heatmap[id] = avgSlice(hcpu[id], heat.N)
	}
	// KPI series: CPU mean over servers with data in the bucket; memory
	// weighted by host RAM (sum used / sum total, like the KPI tile).
	kcpu, kmem := make([]*float64, spark.N), make([]*float64, spark.N)
	for i := 0; i < spark.N; i++ {
		var cs float64
		var cn int
		var mu, mt float64
		for _, id := range ids {
			if v := servers[id].CPU[i]; v != nil {
				cs += *v
				cn++
			}
			if v := servers[id].Mem[i]; v != nil && memTotal[id] > 0 {
				mu += *v / 100 * memTotal[id]
				mt += memTotal[id]
			}
		}
		if cn > 0 {
			v := float64(int64(cs/float64(cn)*10+0.5)) / 10
			kcpu[i] = &v
		}
		if mt > 0 {
			v := float64(int64(mu/mt*1000+0.5)) / 10
			kmem[i] = &v
		}
	}
	sort.Strings(ids)
	body := map[string]any{
		"range": spec.Name, "as_of": now.UTC().Format(time.RFC3339),
		"kpi":     seriesBlock{StepS: spark.Step, Timestamps: ends(spark), CPU: kcpu, Mem: kmem},
		"servers": servers,
		"heatmap": map[string]any{"buckets": heat.N, "bucket_s": heat.Step, "timestamps": ends(heat), "cpu_pct": heatmap},
	}
	h.seriesCache.put(key, body)
	writeJSON(w, r, http.StatusOK, body)
	return nil
}

// serveHealth answers GET /healthz: 200 "ok" when the database answers and
// the background jobs run, else 503 with the reason (deploy checks and
// external monitors use it).
func (h *Hub) serveHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if err := h.health(r.Context()); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintln(w, "unhealthy:", err)
		return
	}
	fmt.Fprintln(w, "ok")
}

// health reports why the hub is unhealthy (nil when healthy).
func (h *Hub) health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := h.store.Check(ctx); err != nil {
		return fmt.Errorf("database: %w", err)
	}
	if last := h.lastWatchdog.Load(); last != 0 && time.Since(time.Unix(0, last)) > 30*time.Second {
		return fmt.Errorf("background jobs stalled for %s", time.Since(time.Unix(0, last)).Round(time.Second))
	}
	return nil
}
