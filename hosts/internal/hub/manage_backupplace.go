package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- backup places (docs/MANAGE.md 2.10, docs/REST-API.md "Backup places") ---------

// placeRoutes set up a server as a backup place for Whombats, share an
// Unraid folder over NFS for another server's backups, and add that
// folder to Proxmox VE as a storage. They answer when the agent is done
// (it may pull an image first), 200 with the operation's own body.
var placeRoutes = []manageRoute{
	{method: "POST", path: "/backup-place/ensure", op: proto.OpPlaceEnsure},
	{method: "PUT", path: "/backup-place/{client}/cleanup", op: proto.OpPlaceCleanup},
	{method: "DELETE", path: "/backup-place/{client}", op: proto.OpPlaceRemove},
	{method: "POST", path: "/backup-place/nfs", op: proto.OpPlaceNFS},
	{method: "POST", path: "/proxmox/storages", op: proto.OpStorageAdd},
}

// placeOps are the operations of placeRoutes.
var placeOps = map[string]bool{}

func init() {
	for _, rt := range placeRoutes {
		placeOps[rt.op] = true
	}
	manageRoutes = append(manageRoutes, placeRoutes...)
}

// placeBody is the body of every place route; decodePlaceBody allows only
// the route's fields.
type placeBody struct {
	Client             string   `json:"client"`
	RestPassword       string   `json:"rest_password"`
	Port               int      `json:"port"`
	Location           string   `json:"location"`
	RepositoryPassword string   `json:"repository_password"`
	KeepWithinDays     int      `json:"keep_within_days"`
	KeepDailyDays      int      `json:"keep_daily_days"`
	KeepWeeklyDays     int      `json:"keep_weekly_days"`
	KeepMonthlyMonths  int      `json:"keep_monthly_months"`
	LimitBytes         int64    `json:"limit_bytes"`
	DeleteData         bool     `json:"delete_data"`
	Confirm            bool     `json:"confirm"`
	Name               string   `json:"name"`
	Clients            []string `json:"clients"`
	Storage            string   `json:"storage"`
	Type               string   `json:"type"`
	Server             string   `json:"server"`
	Export             string   `json:"export"`
	Content            []string `json:"content"`
}

// placeFields are the body fields of each operation.
var placeFields = map[string][]string{
	proto.OpPlaceEnsure:  {"client", "rest_password", "port", "location"},
	proto.OpPlaceCleanup: {"repository_password", "keep_within_days", "keep_daily_days", "keep_weekly_days", "keep_monthly_months", "limit_bytes"},
	proto.OpPlaceRemove:  {"delete_data", "confirm"},
	proto.OpPlaceNFS:     {"name", "clients"},
	proto.OpStorageAdd:   {"storage", "type", "server", "export", "content"},
}

var placeExportRe = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,250}$`)

func decodePlaceBody(r *http.Request, op string) (placeBody, error) {
	var b placeBody
	if r.Body == nil {
		return b, nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		return b, apiErr(http.StatusBadRequest, "bad_request", "Could not read the body.")
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return b, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return b, apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: "+err.Error())
	}
	for k := range fields {
		if !slices.Contains(placeFields[op], k) {
			return b, apiErr(http.StatusBadRequest, "bad_request", fmt.Sprintf("Invalid JSON body: unknown field %q", k))
		}
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return b, apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: "+err.Error())
	}
	return b, nil
}

// placeInvalid is 422 invalid with the fields that failed.
func placeInvalid(fe map[string]string) *apiError {
	e := apiErr(http.StatusUnprocessableEntity, "invalid", "Check the marked fields.")
	if len(fe) == 1 {
		for k, v := range fe {
			e.Detail = k + ": " + v
		}
	}
	e.Fields = fe
	return e
}

// placeUnsupported is 409 unsupported with the reason.
func placeUnsupported(reason, detail string) *apiError {
	e := apiErr(http.StatusConflict, "unsupported", detail)
	e.Extra = map[string]any{"reason": reason}
	return e
}

func ipv4(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil && !strings.Contains(s, ":")
}

// placeRequest checks the body and builds the agent's request.
func placeRequest(op, client string, b placeBody) (proto.ManageRequest, map[string]string) {
	fe := map[string]string{}
	req := proto.ManageRequest{Op: op, Platform: proto.PlatformHost}
	pr := &proto.PlaceRequest{Client: client}
	checkClient := func() {
		switch {
		case pr.Client == proto.PlaceKitUser:
			fe["client"] = "“kit” is a name the backup app keeps for itself."
		case !proto.ValidPlaceClient(pr.Client):
			fe["client"] = "The name is 3 to 63 lower-case letters, digits and dashes, starting with a letter or digit."
		}
	}
	switch op {
	case proto.OpPlaceEnsure:
		pr.Client, pr.RestPassword, pr.Port, pr.Location = b.Client, b.RestPassword, b.Port, b.Location
		checkClient()
		if b.Location != "" && !proto.ValidPlaceLocation(b.Location) {
			fe["location"] = "Give one of the server's backup locations (backup_place.locations[].id)."
		}
		if n := len(b.RestPassword); n < proto.PlaceRestPasswordMin || n > proto.PlaceRestPasswordMax || !printable(b.RestPassword) {
			fe["rest_password"] = fmt.Sprintf("The password is %d to %d printable ASCII characters.", proto.PlaceRestPasswordMin, proto.PlaceRestPasswordMax)
		}
		if b.Port != 0 && (b.Port < 1024 || b.Port > 65535) {
			fe["port"] = "The port is 0 (keep it or choose one) or a number from 1024 to 65535."
		}
	case proto.OpPlaceCleanup:
		pr.RepositoryPassword, pr.KeepWithinDays = b.RepositoryPassword, b.KeepWithinDays
		pr.KeepDailyDays, pr.KeepWeeklyDays, pr.KeepMonthlyMonths, pr.LimitBytes = b.KeepDailyDays, b.KeepWeeklyDays, b.KeepMonthlyMonths, b.LimitBytes
		checkClient()
		if b.RepositoryPassword == "" || len(b.RepositoryPassword) > proto.PlaceRepoPasswordMax || strings.ContainsAny(b.RepositoryPassword, "\r\n\x00") {
			fe["repository_password"] = "Give the repository password (one line)."
		}
		minDays := proto.PlaceKeepDaysMin
		if b.KeepDailyDays >= 7 {
			minDays = proto.PlaceKeepDaysMinWithDaily
		}
		if d := b.KeepWithinDays; d != 0 && (d < minDays || d > proto.PlaceKeepDaysMax) {
			fe["keep_within_days"] = fmt.Sprintf("Keep backups from %d to %d days.", minDays, proto.PlaceKeepDaysMax)
		}
		if b.KeepDailyDays < 0 || b.KeepDailyDays > proto.PlaceKeepDaysMax || b.KeepWeeklyDays < 0 ||
			b.KeepWeeklyDays > proto.PlaceKeepDaysMax || b.KeepMonthlyMonths < 0 || b.KeepMonthlyMonths > 240 {
			fe["keep_daily_days"] = "Keep one a day, a week or a month for 0 to 3650 days (months: 0 to 240)."
		}
		if b.LimitBytes != 0 && b.LimitBytes < 1_000_000_000 {
			fe["limit_bytes"] = "The limit is 0 (none) or at least 1 GB."
		}
	case proto.OpPlaceRemove:
		pr.DeleteData = b.DeleteData
		checkClient()
	case proto.OpPlaceNFS:
		pr.Client, pr.Name, pr.Clients = "", b.Name, b.Clients
		if !proto.PlaceShareRe.MatchString(b.Name) || b.Name == proto.PlaceShareName {
			fe["name"] = "The share is called whombat-… (lower-case letters, digits and dashes)."
		}
		if len(b.Clients) == 0 || len(b.Clients) > proto.PlaceNFSClientsMax {
			fe["clients"] = fmt.Sprintf("Give 1 to %d IPv4 addresses.", proto.PlaceNFSClientsMax)
		}
		for _, c := range b.Clients {
			if !ipv4(c) {
				fe["clients"] = "Give IPv4 addresses (\"10.100.1.5\")."
			}
		}
	case proto.OpStorageAdd:
		req.Platform, pr = proto.PlatformPVE, nil
		s := &proto.PVEStorageSpec{Storage: b.Storage, Type: b.Type, Server: b.Server, Export: b.Export, Content: b.Content}
		req.PVEStorage = s
		if !proto.PVEStorageIDRe.MatchString(s.Storage) {
			fe["storage"] = "A storage name is lower-case letters, digits, '-', '_' and '.', starting with a letter."
		}
		if s.Type != "nfs" {
			fe["type"] = "type is nfs."
		}
		if !ipv4(s.Server) {
			fe["server"] = "Give the NFS server's IPv4 address."
		}
		if !placeExportRe.MatchString(s.Export) || strings.Contains(s.Export, "..") {
			fe["export"] = "Give the exported folder (\"/mnt/user/whombat-pve-01\")."
		}
		if len(s.Content) == 0 || len(s.Content) > 4 {
			fe["content"] = "Say what the storage holds ([\"backup\"])."
		}
		for _, c := range s.Content {
			if !slices.Contains([]string{"backup", "iso", "vztmpl", "snippets"}, c) {
				fe["content"] = "A storage holds backup, iso, vztmpl or snippets."
			}
		}
	}
	req.Place = pr
	return req, fe
}

func printable(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// placeDetails are the audit details: what, never a password.
func placeDetails(req proto.ManageRequest) map[string]string {
	d := map[string]string{"op": req.Op}
	if p := req.Place; p != nil {
		if p.Client != "" {
			d["client"] = p.Client
		}
		if p.Port != 0 {
			d["port"] = strconv.Itoa(p.Port)
		}
		if p.Location != "" {
			d["location"] = cleanText(p.Location, 64)
		}
		if p.KeepWithinDays != 0 {
			d["keep_within_days"] = strconv.Itoa(p.KeepWithinDays)
		}
		if p.KeepDailyDays != 0 || p.KeepWeeklyDays != 0 || p.KeepMonthlyMonths != 0 {
			d["keep"] = fmt.Sprintf("daily %d d, weekly %d d, monthly %d m", p.KeepDailyDays, p.KeepWeeklyDays, p.KeepMonthlyMonths)
		}
		if p.LimitBytes != 0 {
			d["limit_bytes"] = strconv.FormatInt(p.LimitBytes, 10)
		}
		if p.DeleteData {
			d["delete_data"] = "true"
		}
		if p.Name != "" {
			d["name"] = p.Name
			d["clients"] = cleanText(strings.Join(p.Clients, ", "), 300)
		}
	}
	if s := req.PVEStorage; s != nil {
		d["storage"], d["server"], d["export"] = cleanText(s.Storage, 64), cleanText(s.Server, 64), cleanText(s.Export, 256)
		d["content"] = cleanText(strings.Join(s.Content, ","), 64)
	}
	return d
}

// placeHandler serves one place route: the manage switches on both
// sides, never on the server this Whombat runs on (except removing a
// place and adding a Proxmox VE storage), deleting the backups only by an
// admin with a recent sign-in who confirms; every call audited.
func (h *Hub) placeHandler(rt manageRoute) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, p *principal) error {
		serverID := r.PathValue("id")
		b, err := decodePlaceBody(r, rt.op)
		if err != nil {
			return err
		}
		req, fe := placeRequest(rt.op, r.PathValue("client"), b)
		if len(fe) > 0 {
			return placeInvalid(fe)
		}
		gid := model.HostGuestID
		details := placeDetails(req)
		deny := func(e *apiError) error { return h.deny(r, p, "manage.requested", serverID, gid, "", e, details) }
		if req.Place != nil && req.Place.DeleteData {
			if p.rank() < store.RoleRank(admin) {
				return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
			}
			if err := h.requireReauth(p); err != nil {
				return err
			}
			if !b.Confirm {
				return deny(apiErr(http.StatusBadRequest, "confirm_required",
					"Deleting the backups can’t be undone: send \"confirm\": true."))
			}
		}
		if h.throttled(p) {
			return rateLimited(10 * time.Minute)
		}
		t, e := h.remotePrecheck(p, serverID, gid, needManage)
		if e != nil {
			return deny(e)
		}
		rep := t.st.Report
		switch rt.op {
		case proto.OpPlaceEnsure, proto.OpPlaceCleanup, proto.OpPlaceNFS:
			if h.isSelfServer(rep) {
				return deny(apiErr(http.StatusConflict, proto.PlaceSelf, selfMessage))
			}
		}
		wait := time.Duration(0)
		if rt.op == proto.OpPlaceEnsure && b.Location != "" {
			moving, e := placeLocationCheck(rep, b.Client, b.Location)
			if e != nil {
				return deny(e)
			}
			if moving {
				wait = proto.PlaceMoveWait + 15*time.Second
			}
		}
		switch {
		case rt.op == proto.OpPlaceNFS && !model.IsUnraid(rep):
			return placeUnsupported(proto.PlaceNotUnraid, "Only Unraid servers share a folder for backups this way.")
		case rt.op == proto.OpStorageAdd && (rep == nil || rep.PVE == nil):
			return placeUnsupported("not_proxmox", "This server doesn’t run Proxmox VE.")
		}
		return h.placeChange(w, r, p, t, req, details, wait)
	}
}

// placeLocationCheck checks an ensure's location against the server's
// report: the agent must know locations (an older one would put the
// backups in the dedicated share whatever was asked) and list this one.
// moving: the client is in the report somewhere else (or somewhere the
// report doesn't name), so the ensure may move its backups.
func placeLocationCheck(rep *proto.Report, client, location string) (moving bool, e *apiError) {
	if rep == nil || rep.BackupPlace == nil || len(rep.BackupPlace.Locations) == 0 {
		return false, placeUnsupported("agent_too_old", "Whombat’s helper on this server is too old to choose where backups go; it updates itself soon.")
	}
	known := false
	for _, l := range rep.BackupPlace.Locations {
		known = known || l.ID == location
	}
	if !known {
		return false, placeInvalid(map[string]string{"location": "This server has no such place for backups."})
	}
	for _, c := range rep.BackupPlace.Clients {
		if c.Client == client {
			return c.Location != location, nil
		}
	}
	return false, nil
}

// placeChange audits, asks the agent (waiting up to wait, 0 = the usual)
// and answers with the operation's body.
func (h *Hub) placeChange(w http.ResponseWriter, r *http.Request, p *principal, t remoteTarget, req proto.ManageRequest,
	details map[string]string, wait time.Duration) error {
	serverID := t.st.ID
	if h.closing.Load() {
		return apiErr(http.StatusServiceUnavailable, "shutting_down", "The hub is shutting down.")
	}
	key := serverID + "|backup-place"
	if !h.actions.begin(key, req.Op) {
		return apiErr(http.StatusConflict, "action_in_progress", "Whombat is already changing this server’s backup place.")
	}
	defer h.actions.end(key)
	auditID, err := h.auditReq(r, p, store.AuditRecord{Event: "manage.requested", Outcome: "ok", Server: serverID,
		Platform: req.Platform, Details: details})
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; changes are disabled.")
	}
	start := time.Now()
	// It goes on when the caller goes away: its outcome is audited either
	// way.
	resp, err := t.conn.ManageWithin(context.WithoutCancel(r.Context()), req, wait)
	fin := func(outcome, code string, extra map[string]string) {
		dur := float64(int64(time.Since(start).Seconds()*10)) / 10
		_, _ = h.audit(context.WithoutCancel(r.Context()), store.AuditRecord{Event: "manage.finished", Outcome: outcome, Code: code,
			User: p.user.Username, Role: p.user.Role, ClientIP: clientIP(r), UserAgent: cleanText(r.UserAgent(), 256),
			Server: serverID, Platform: req.Platform, DurationS: &dur,
			Details: mergeDetails(details, extra, map[string]string{"requested_audit_id": auditID})})
		h.log.Info("manage", "server", serverID, "op", req.Op, "outcome", outcome, "code", code)
	}
	if err != nil {
		e := manageAgentError(err)
		fin("error", e.Code, nil)
		return e
	}
	if !resp.OK {
		e := placeProblem(resp)
		fin("error", e.Code, map[string]string{"error": cleanText(e.Detail, 300)})
		return e
	}
	res := proto.PlaceResult{}
	if resp.Place != nil {
		res = *resp.Place
	}
	addrs := nonNil(res.Addresses)
	if len(addrs) == 0 && t.st.Report != nil && t.st.Report.BackupPlace != nil {
		addrs = nonNil(t.st.Report.BackupPlace.Addresses)
	}
	var body any
	extra := map[string]string{}
	switch req.Op {
	case proto.OpPlaceEnsure:
		body = map[string]any{"client": res.Client, "port": res.Port, "addresses": addrs, "path": cleanText(res.Path, 512),
			"created": res.Created, "location": cleanText(res.Location, 64), "moved": res.Moved, "kit": res.Kit}
		extra["port"], extra["created"] = strconv.Itoa(res.Port), strconv.FormatBool(res.Created)
		if res.Location != "" {
			extra["location"], extra["moved"] = cleanText(res.Location, 64), strconv.FormatBool(res.Moved)
		}
	case proto.OpPlaceCleanup:
		body = map[string]any{"set": res.Set}
	case proto.OpPlaceRemove:
		body = map[string]any{"removed": res.Removed}
	case proto.OpPlaceNFS:
		body = map[string]any{"export": cleanText(res.Export, 512), "addresses": addrs}
	case proto.OpStorageAdd:
		body = map[string]any{"storage": req.PVEStorage.Storage}
	}
	fin("ok", "", extra)
	writeJSON(w, r, http.StatusOK, body)
	return nil
}

// placeProblem turns an agent refusal into the routes' problems: 422
// invalid, 409 unsupported (with the reason), 404, 409 exists or busy,
// 403 when manage is off in the agent, else 502 agent_error with the
// agent's sentence.
func placeProblem(resp proto.ManageResponse) *apiError {
	msg := cleanText(resp.Message, 512)
	switch resp.Code {
	case proto.CodeInvalidValue, "invalid_request":
		fe := map[string]string{}
		for k, v := range resp.FieldErrors {
			if len(fe) < 16 {
				fe[cleanText(k, 64)] = cleanText(v, 300)
			}
		}
		e := placeInvalid(fe)
		if len(fe) == 0 && msg != "" {
			e.Detail = msg
		}
		return e
	case "unsupported":
		reason := ""
		if resp.Place != nil {
			reason = cleanText(resp.Place.Reason, 32)
		}
		if reason == "" && msg == "unknown operation" {
			// An agent from before backup places.
			return placeUnsupported("agent_too_old", "Whombat’s helper on this server is too old for this; it updates itself soon.")
		}
		if reason == "" {
			reason = "unsupported"
		}
		if msg == "" {
			msg = "This server can’t do this."
		}
		return placeUnsupported(reason, msg)
	case proto.CodeNotFound:
		return apiErr(http.StatusNotFound, "not_found", msg)
	case proto.CodeExists:
		return apiErr(http.StatusConflict, "exists", msg)
	case "busy":
		return apiErr(http.StatusConflict, "busy", msg)
	case "timeout":
		return apiErr(http.StatusGatewayTimeout, "timeout", msg)
	case "remote_control_disabled", proto.CodeNotAllowed, "inventory_unavailable":
		return manageProblem(resp)
	}
	if msg == "" {
		msg = "The server couldn’t do this."
	}
	return apiErr(http.StatusBadGateway, "agent_error", msg)
}
