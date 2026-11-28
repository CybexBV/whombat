package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Slug turns a host name into a server id: lower case letters, digits and
// dashes, at most 63 characters.
func Slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 63 {
		out = strings.Trim(out[:63], "-")
	}
	return out
}

// installCommand is the one-line installer. It starts with a space: bash
// with HISTCONTROL=ignorespace or ignoreboth (the Debian and Ubuntu
// default) keeps it out of the shell history. The token is single use and
// expires after an hour; a token that is not pre-approved still needs an
// admin's approval. control ("" = none) is passed on as --control.
//
// Headless, the script comes from the agent listener (the address agents
// dial), with its key pinned; otherwise from the UI origin.
func (h *Hub) installCommand(r *http.Request, token, control string) (string, error) {
	tail := " | sudo sh -s -- --token " + token
	if control != "" {
		tail += " --control " + control
	}
	if !h.cfg.Headless {
		return " curl -fsSL " + h.requestOrigin(r) + "/install.sh" + tail, nil
	}
	base, err := h.agentInstallBase()
	if err != nil {
		return "", err
	}
	return " " + fetchCommand(h.listenerPin()) + " " + base + "/install.sh" + tail, nil
}

// agentInstallBase is the agent listener as an https origin, from the
// agents' URL (https://10.100.1.5:8443).
func (h *Hub) agentInstallBase() (string, error) {
	au, err := h.agentURL(nil)
	if err != nil {
		return "", err
	}
	if au == "" {
		return "", errors.New("no agent URL: start the hub with --agent-url")
	}
	return "https://" + strings.TrimPrefix(au, "wss://"), nil
}

// enrollmentBody is POST /enrollments' optional body (Whombat's Add a
// server, SI-06/SI-07). Absent or {}: an enrollment an admin approves.
type enrollmentBody struct {
	Approve bool    `json:"approve"`
	Control *string `json:"control"`
	Name    *string `json:"name"`
	Group   *string `json:"group"`
}

// settings checks the body and returns what is stored with the token.
func (b enrollmentBody) settings() (store.EnrollSettings, error) {
	set := store.EnrollSettings{Approve: b.Approve}
	if b.Control != nil {
		if _, ok := proto.ControlSwitches(*b.Control); !ok {
			return set, apiErr(http.StatusBadRequest, "invalid_control", "control must be watch, operate or full.")
		}
		set.Control = *b.Control
	}
	if b.Name != nil {
		set.Name = cleanText(*b.Name, 63)
		if Slug(set.Name) == "" {
			return set, apiErr(http.StatusBadRequest, "invalid_name", "Give the server a name (letters, digits, dashes).")
		}
	}
	if b.Group != nil {
		set.Group = cleanText(*b.Group, 64)
		if strings.EqualFold(set.Group, model.AllGroup) {
			return set, apiErr(http.StatusBadRequest, "invalid_group", `"All" is reserved.`)
		}
	}
	return set, nil
}

// grantsAccess reports whether a control level turns on more than the
// defaults (read-only checks).
func grantsAccess(control string) bool {
	return control == proto.ControlOperate || control == proto.ControlFull
}

// decodeOptionalJSON decodes a body that may be absent or empty.
func decodeOptionalJSON(r *http.Request, v any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return apiErr(http.StatusBadRequest, "bad_request", "Could not read the body.")
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: "+err.Error())
	}
	return nil
}

func (h *Hub) apiCreateEnrollment(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req enrollmentBody
	if err := decodeOptionalJSON(r, &req); err != nil {
		return err
	}
	set, err := req.settings()
	if err != nil {
		return err
	}
	if grantsAccess(set.Control) {
		// The server is added with consoles and power on: like turning a
		// switch on (apiPatchServer), confirm the user first.
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	token := randToken(32)
	cmd, err := h.installCommand(r, token, set.Control)
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "no_agent_url", "The hub does not know the address agents reach it at: "+err.Error()+".")
	}
	winCmd, err := h.installCommandWindows(r, token, set.Control)
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "no_agent_url", "The hub does not know the address agents reach it at: "+err.Error()+".")
	}
	id := newID("en_")
	now := h.now()
	exp := now.Add(h.cfg.EnrollmentTTL)
	if err := h.store.CreateEnrollment(r.Context(), id, sha(token), p.user.Username, now, exp, set); err != nil {
		return err
	}
	details := map[string]string{"enrollment_id": id}
	if set.Approve {
		details["approve"] = "true"
	}
	if set.Control != "" {
		details["control"] = set.Control
	}
	if set.Name != "" {
		details["name"] = set.Name
	}
	if set.Group != "" {
		details["group"] = set.Group
	}
	h.auditReq(r, p, store.AuditRecord{Event: "enrollment.created", Outcome: "ok", Details: details})
	out := map[string]any{
		"id": id, "token": token, "expires_at": exp.UTC().Format(time.RFC3339), "install_command": cmd,
		"ca_sha256": h.ca.Pin, "approve": set.Approve, "control": sp(set.Control), "name": sp(set.Name),
	}
	if winCmd != "" {
		// A Windows PC's line, and how to remove its agent again; absent
		// while the hub has no Windows build.
		out["install_command_windows"], out["uninstall_command_windows"] = winCmd, WindowsUninstallLine
	}
	if au, err := h.agentURL(r); err == nil && au != "" {
		out["agent_url"] = au
	}
	if h.cfg.Headless {
		base, _ := h.agentInstallBase()
		out["install_url"], out["tls_pin"] = base+"/install.sh", h.listenerPin()
	}
	writeJSON(w, r, http.StatusCreated, out)
	return nil
}

type enrollmentJSON struct {
	ID           string  `json:"id"`
	State        string  `json:"state"`
	Hostname     *string `json:"hostname"`
	OS           *string `json:"os"`
	Address      *string `json:"address"`
	AgentVersion *string `json:"agent_version"`
	RequestedAt  *string `json:"requested_at"`
	CreatedAt    string  `json:"created_at"`
	ExpiresAt    string  `json:"expires_at"`
	ServerID     *string `json:"server_id"`
	Approve      bool    `json:"approve"`
	Control      *string `json:"control"`
	Name         *string `json:"name"`
}

func tsp(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func (h *Hub) apiListEnrollments(w http.ResponseWriter, r *http.Request, p *principal) error {
	state := r.URL.Query().Get("state")
	switch state {
	case "":
		state = store.EnrollPending
	case "all":
		state = ""
	case store.EnrollPending, store.EnrollIssued, store.EnrollApproved, store.EnrollRejected, store.EnrollExpired:
	default:
		return apiErr(http.StatusBadRequest, "invalid_state", "Unknown enrollment state.")
	}
	list, err := h.store.ListEnrollments(r.Context(), state)
	if err != nil {
		return err
	}
	out := []enrollmentJSON{}
	for _, e := range list {
		addr := e.Address
		if addr == "" {
			addr = e.RemoteAddr
		}
		out = append(out, enrollmentJSON{ID: e.ID, State: e.State, Hostname: sp(e.Hostname), OS: sp(e.OS), Address: sp(addr),
			AgentVersion: sp(e.AgentVersion), RequestedAt: tsp(e.RequestedAt), CreatedAt: e.CreatedAt.UTC().Format(time.RFC3339),
			ExpiresAt: e.ExpiresAt.UTC().Format(time.RFC3339), ServerID: sp(e.ServerID), Approve: e.Approve,
			Control: sp(e.Control), Name: sp(e.Name)})
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// approveAs makes a pending enrollment the server id: its CSR signed, the
// switches of the enrollment's control level (else the defaults: only the
// read-only checks), the server registered and announced. Errors:
// store.ErrConflict (the id is taken), store.ErrNotFound (no longer
// pending), errInvalidCSR.
func (h *Hub) approveAs(ctx context.Context, e store.Enrollment, id, group, by string) error {
	now := h.now()
	iss, err := h.ca.SignClient(e.CSR, id, now)
	if err != nil {
		return fmt.Errorf("%w: %v", errInvalidCSR, err)
	}
	srv := store.Server{ID: id, Hostname: e.Hostname, Group: group, CertSerial: iss.Serial, CertNotAfter: iss.NotAfter,
		MachineID: e.MachineID, CreatedAt: now, AgentVersion: e.AgentVersion, Address: e.Address,
		RCDiagnose: true} // the column's default: the assistant's read-only checks are on
	if sw, ok := proto.ControlSwitches(e.Control); ok {
		srv.RCConsole, srv.RCPower, srv.RCHostShell = sw["console"], sw["power"], sw["host_shell"]
		srv.RCHostPower, srv.RCManage, srv.RCDiagnose = sw["host_power"], sw["manage"], sw["diagnose"]
	}
	if srv.Hostname == "" {
		srv.Hostname = id
	}
	if err := h.store.ApproveEnrollment(ctx, e.ID, srv, iss.PEM, by, now); err != nil {
		return err
	}
	h.mu.Lock()
	h.servers[id] = &srvState{meta: srv, guestStates: map[string]string{}, offline: true}
	h.mu.Unlock()
	h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "enrollment.approved",
		map[string]string{"id": e.ID, "server_id": id, "hostname": e.Hostname})
	h.bus.Publish("server.settings_changed", map[string]string{"id": id})
	h.publishServerUpdated(id)
	return nil
}

var errInvalidCSR = errors.New("invalid CSR")

// approvalDetails are the audit details of an approval.
func approvalDetails(e store.Enrollment, group string) map[string]string {
	d := map[string]string{"enrollment_id": e.ID, "group": group, "hostname": e.Hostname}
	if e.Control != "" {
		d["control"] = e.Control
	}
	return d
}

// maxNameSuffix bounds the -2, -3, ... a pre-approved server's name gets
// when it is taken.
const maxNameSuffix = 99

// autoApprove approves a pre-approved enrollment the moment its agent asks
// (SI-07): named after the token's name, else the host name; a taken name
// gets -2, -3, ... (never a takeover of the existing server). The token's
// creator is the approver.
func (h *Hub) autoApprove(ctx context.Context, e store.Enrollment, clientIP string) (string, error) {
	base := Slug(e.Name)
	if base == "" {
		base = Slug(e.Hostname)
	}
	if base == "" {
		base = "server"
	}
	group := e.Group
	if group == "" {
		group = "Ungrouped"
	}
	for n := 1; n <= maxNameSuffix; n++ {
		id := base
		if n > 1 {
			sfx := "-" + strconv.Itoa(n)
			id = strings.TrimRight(base[:min(len(base), 63-len(sfx))], "-") + sfx
		}
		h.mu.RLock()
		_, taken := h.servers[id]
		h.mu.RUnlock()
		if taken {
			continue
		}
		switch err := h.approveAs(ctx, e, id, group, e.CreatedBy); {
		case errors.Is(err, store.ErrConflict):
			continue
		case err != nil:
			return "", err
		}
		d := approvalDetails(e, group)
		d["auto"] = "true"
		h.auditSystem(ctx, store.AuditRecord{Event: "enrollment.approved", Outcome: "ok", User: e.CreatedBy, Role: store.RoleAdmin,
			ClientIP: clientIP, Server: id, Details: d})
		h.log.Info("enrollment approved (pre-approved)", "server", id, "group", group, "control", e.Control, "by", e.CreatedBy)
		return id, nil
	}
	return "", fmt.Errorf("the names %s to %s-%d are all taken", base, base, maxNameSuffix)
}

func (h *Hub) apiApproveEnrollment(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req struct {
		Group string `json:"group"`
		Name  string `json:"name"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
	}
	e, err := h.store.GetEnrollment(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if e.State != store.EnrollPending {
		return apiErr(http.StatusConflict, "not_pending", "This enrollment is "+e.State+".")
	}
	if !e.RequestedAt.IsZero() && h.now().Sub(e.RequestedAt) > h.cfg.EnrollmentTTL {
		return apiErr(http.StatusConflict, "not_pending", "This enrollment request expired. Run the installer again with a new token.")
	}
	name := req.Name
	if name == "" {
		name = e.Name
	}
	if name == "" {
		name = e.Hostname
	}
	id := Slug(name)
	if id == "" {
		return apiErr(http.StatusBadRequest, "invalid_name", "Give the server a name (letters, digits, dashes).")
	}
	group := cleanText(req.Group, 64)
	if group == "" {
		group = e.Group
	}
	if group == "" {
		group = "Ungrouped"
	}
	if strings.EqualFold(group, model.AllGroup) {
		return apiErr(http.StatusBadRequest, "invalid_group", `"All" is reserved.`)
	}
	if grantsAccess(e.Control) {
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	switch err := h.approveAs(r.Context(), e, id, group, p.user.Username); {
	case errors.Is(err, errInvalidCSR):
		return apiErr(http.StatusBadRequest, "invalid_csr", err.Error())
	case errors.Is(err, store.ErrConflict):
		return apiErr(http.StatusConflict, "server_exists", "A server named "+id+" already exists. Choose another name or delete it first.")
	case errors.Is(err, store.ErrNotFound):
		return apiErr(http.StatusConflict, "not_pending", "This enrollment is no longer pending.")
	case err != nil:
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "enrollment.approved", Outcome: "ok", Server: id, Details: approvalDetails(e, group)})
	h.log.Info("enrollment approved", "server", id, "group", group, "control", e.Control, "by", p.user.Username)
	writeJSON(w, r, http.StatusOK, map[string]string{"server_id": id})
	return nil
}

func (h *Hub) apiRejectEnrollment(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	if err := h.store.RejectEnrollment(r.Context(), id, p.user.Username, h.now()); errors.Is(err, store.ErrNotFound) {
		return apiErr(http.StatusConflict, "not_pending", "This enrollment cannot be rejected.")
	} else if err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "enrollment.rejected", Outcome: "ok", Details: map[string]string{"enrollment_id": id}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type rcJSON struct {
	Console   bool `json:"console"`
	Power     bool `json:"power"`
	HostShell bool `json:"host_shell"`
	HostPower bool `json:"host_power"`
	Manage    bool `json:"manage"`
	Diagnose  bool `json:"diagnose"`
}

type settingsJSON struct {
	ID            string  `json:"id"`
	Group         string  `json:"group"`
	Location      *string `json:"location"`
	RemoteControl rcJSON  `json:"remote_control"`
	AgentPolicy   rcJSON  `json:"agent_policy"`
	// Parent is the host this one runs on: "" = detected, "-" = none.
	Parent         string  `json:"parent"`
	DetectedParent *string `json:"detected_parent"`
}

func settingsOf(st *model.ServerState) settingsJSON {
	s := settingsJSON{ID: st.ID, Group: st.Group, Location: sp(st.Location),
		RemoteControl: rcJSON{Console: st.RCConsole, Power: st.RCPower, HostShell: st.RCHostShell, HostPower: st.RCHostPower, Manage: st.RCManage,
			Diagnose: st.RCDiagnose},
		Parent: st.ParentSetting, DetectedParent: sp(st.DetectedParent)}
	if st.Report != nil {
		pol := st.Report.Policy
		s.AgentPolicy = rcJSON{Console: pol.Console, Power: pol.Power, HostShell: pol.HostShell, HostPower: pol.HostPower,
			Manage: pol.Manage, Diagnose: pol.Diagnose}
	}
	return s
}

func (h *Hub) apiServerSettings(w http.ResponseWriter, r *http.Request, p *principal) error {
	st, err := h.server(r.PathValue("id"))
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, settingsOf(st))
	return nil
}

func (h *Hub) apiPatchServer(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	before, err := h.server(id)
	if err != nil {
		return err
	}
	var req struct {
		Group         *string `json:"group"`
		Location      *string `json:"location"`
		Parent        *string `json:"parent"`
		RemoteControl *struct {
			Console   *bool `json:"console"`
			Power     *bool `json:"power"`
			HostShell *bool `json:"host_shell"`
			HostPower *bool `json:"host_power"`
			Manage    *bool `json:"manage"`
			Diagnose  *bool `json:"diagnose"`
		} `json:"remote_control"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if rc := req.RemoteControl; rc != nil {
		turnsOn := func(v *bool, was bool) bool { return v != nil && *v && !was }
		if turnsOn(rc.Console, before.RCConsole) || turnsOn(rc.Power, before.RCPower) ||
			turnsOn(rc.HostShell, before.RCHostShell) || turnsOn(rc.HostPower, before.RCHostPower) ||
			turnsOn(rc.Manage, before.RCManage) || turnsOn(rc.Diagnose, before.RCDiagnose) {
			// Granting remote access is the action an attacker with a
			// stolen session wants: confirm the user first.
			if err := h.requireReauth(p); err != nil {
				return err
			}
		}
	}
	if req.Parent != nil {
		v := strings.TrimSpace(*req.Parent)
		if v != "" && v != "-" {
			if v == id {
				return apiErr(http.StatusBadRequest, "invalid_parent", "A host cannot run on itself.")
			}
			if _, ok := h.snapshotOne(v); !ok {
				return apiErr(http.StatusBadRequest, "invalid_parent", "No server "+v+".")
			}
		}
		req.Parent = &v
	}
	if req.Group != nil {
		g := cleanText(*req.Group, 64)
		if g == "" || strings.EqualFold(g, model.AllGroup) {
			return apiErr(http.StatusBadRequest, "invalid_group", "Give a group name other than \"All\".")
		}
		req.Group = &g
	}
	if req.Location != nil {
		l := cleanText(*req.Location, 128)
		req.Location = &l
	}
	upd := store.ServerSettings{Group: req.Group, Location: req.Location, Parent: req.Parent}
	if rc := req.RemoteControl; rc != nil {
		upd.Console, upd.Power, upd.HostShell, upd.HostPower = rc.Console, rc.Power, rc.HostShell, rc.HostPower
		upd.Manage, upd.Diagnose = rc.Manage, rc.Diagnose
	}
	srv, err := h.store.UpdateServer(r.Context(), id, upd)
	if errors.Is(err, store.ErrNotFound) {
		return apiErr(http.StatusNotFound, "server_not_found", "No such server.")
	}
	if err != nil {
		return err
	}
	h.mu.Lock()
	if s, ok := h.servers[id]; ok {
		s.meta.Group, s.meta.Location, s.meta.RCConsole, s.meta.RCPower = srv.Group, srv.Location, srv.RCConsole, srv.RCPower
		s.meta.RCHostShell, s.meta.RCHostPower, s.meta.Parent = srv.RCHostShell, srv.RCHostPower, srv.Parent
		s.meta.RCManage, s.meta.RCDiagnose = srv.RCManage, srv.RCDiagnose
	}
	h.mu.Unlock()
	toggle := func(capability string, was, now bool) {
		if was == now {
			return
		}
		ev := "remote_control.disabled"
		if now {
			ev = "remote_control.enabled"
		}
		h.auditReq(r, p, store.AuditRecord{Event: ev, Outcome: "ok", Server: id, Details: map[string]string{"capability": capability}})
	}
	toggle("console", before.RCConsole, srv.RCConsole)
	toggle("power", before.RCPower, srv.RCPower)
	toggle("host_shell", before.RCHostShell, srv.RCHostShell)
	toggle("host_power", before.RCHostPower, srv.RCHostPower)
	toggle("manage", before.RCManage, srv.RCManage)
	toggle("diagnose", before.RCDiagnose, srv.RCDiagnose)
	if req.Group != nil && *req.Group != before.Group || req.Location != nil && *req.Location != before.Location ||
		req.Parent != nil && *req.Parent != before.ParentSetting {
		h.auditReq(r, p, store.AuditRecord{Event: "server.updated", Outcome: "ok", Server: id,
			Details: map[string]string{"group": srv.Group, "location": srv.Location, "parent": srv.Parent}})
	}
	if before.RCConsole && !srv.RCConsole {
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.platform != proto.PlatformHost },
			"remote_control_disabled")
	}
	if before.RCHostShell && !srv.RCHostShell {
		h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id && cs.platform == proto.PlatformHost },
			"remote_control_disabled")
	}
	h.seriesCache.invalidateAll()
	h.bus.Publish("server.settings_changed", map[string]string{"id": id})
	h.publishServerUpdated(id)
	st, err := h.server(id)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, settingsOf(st))
	return nil
}

func (h *Hub) apiDeleteServer(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	h.mu.RLock()
	_, ok := h.servers[id]
	h.mu.RUnlock()
	if !ok {
		return apiErr(http.StatusNotFound, "server_not_found", "No such server.")
	}
	// The database first: if it fails the server stays (and stays revocable)
	// instead of vanishing from memory with its certificate still valid.
	if err := h.store.DeleteServer(r.Context(), id); err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	h.mu.Lock()
	s, ok := h.servers[id]
	delete(h.servers, id)
	h.mu.Unlock()
	if !ok {
		return apiErr(http.StatusNotFound, "server_not_found", "No such server.")
	}
	h.consoles.closeWhere(func(cs *consoleSession) bool { return cs.server == id }, "revoked")
	if s.conn != nil {
		s.conn.Close()
	}
	for _, a := range h.alerts.Forget(id, h.now()) {
		h.bus.Publish("alert.resolved", model.BuildAlert(a))
	}
	h.watch.forget(id)
	h.auditReq(r, p, store.AuditRecord{Event: "server.deleted", Outcome: "ok", Server: id,
		Details: map[string]string{"cert_serial": s.meta.CertSerial}})
	h.log.Info("server deleted, certificate revoked", "server", id, "by", p.user.Username)
	h.seriesCache.invalidateAll()
	h.bus.Publish("server.deleted", map[string]string{"id": id})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h *Hub) apiAgents(w http.ResponseWriter, r *http.Request, p *principal) error {
	snap := h.snapshot()
	man, manErr := h.manifest()
	h.mu.RLock()
	certs := map[string]time.Time{}
	for id, s := range h.servers {
		certs[id] = s.meta.CertNotAfter
	}
	h.mu.RUnlock()
	out := []map[string]any{}
	for _, st := range snap {
		var collectors []model.Collector
		version := st.AgentVersion
		if st.Report != nil {
			for _, c := range st.Report.Collectors {
				e := c.Error
				collectors = append(collectors, model.Collector{Name: c.Name, OK: c.OK, Error: sp(e)})
			}
			if st.Report.Agent.Version != "" {
				version = st.Report.Agent.Version
			}
		}
		if collectors == nil {
			collectors = []model.Collector{}
		}
		set := settingsOf(st)
		item := map[string]any{
			"server_id": st.ID, "hostname": st.Hostname, "group": st.Group, "location": sp(st.Location),
			"version": sp(version), "connected": st.Connected,
			"status": st.Status(h.now()), "last_seen": tsp(st.LastSeen), "address": sp(st.Address),
			"clock_skew_s": st.ClockSkewS, "collectors": collectors, "remote_control": set.RemoteControl,
			"agent_policy": set.AgentPolicy, "cert_expires_at": tsp(certs[st.ID]),
			"update": h.updateInfoFor(st, man, manErr), "arch": archOf(st), "install": installOf(st),
			"helper": h.helperInfoFor(st, man, manErr), // Macs only: Whombat Helper's update
		}
		if st.Via != "" {
			item["via"] = st.Via
		}
		out = append(out, item)
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func archOf(st *model.ServerState) *string {
	if st.Report == nil {
		return nil
	}
	return sp(st.Report.Agent.Arch)
}

func installOf(st *model.ServerState) *string {
	if st.Report == nil {
		return nil
	}
	return sp(st.Report.Agent.Install)
}
