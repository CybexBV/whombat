package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- managing guests (docs/MANAGE.md) -------------------------------------------

// manageRoute is one route of the manage API: method and path below
// /api/v1/servers/{id}, the operation, whether it needs an admin with a
// recent sign-in, and the body fields or query parameters it reads. GET
// routes read (200 with the agent's answer, audited as manage.viewed);
// every other route changes something (manage.requested, then
// manage.finished).
type manageRoute struct {
	method, path string
	op           string
	admin        bool
	body         []string // JSON body fields (nil: no body)
	query        []string // query parameters
}

// manageRoutes is docs/MANAGE.md 3.1; web/src/api/manage.ts calls exactly
// these. manage_incus.go adds the Incus routes and fields at start.
var manageRoutes = []manageRoute{
	{method: "GET", path: "/guests/{guestId}/config", op: proto.OpConfigGet},
	{method: "PUT", path: "/guests/{guestId}/config", op: proto.OpConfigSet, body: []string{"digest", "set", "delete", "revert", "confirm"}},
	{method: "POST", path: "/guests/{guestId}/disks/{disk}/resize", op: proto.OpDiskResize, body: []string{"size"}},
	{method: "POST", path: "/guests/{guestId}/disks/{disk}/move", op: proto.OpDiskMove, body: []string{"storage", "delete_source"}},
	{method: "GET", path: "/manage/choices", op: proto.OpChoices, query: []string{"platform"}},
	{method: "POST", path: "/guests", op: proto.OpCreate, admin: true,
		body: []string{"platform", "kind", "new_id", "name", "set", "start", "image", "profiles"}},
	{method: "POST", path: "/guests/{guestId}/clone", op: proto.OpClone, admin: true, body: []string{"new_id", "name", "full", "storage"}},
	{method: "POST", path: "/guests/{guestId}/template", op: proto.OpTemplate, admin: true, body: []string{"confirm"}},
	{method: "POST", path: "/guests/{guestId}/migrate", op: proto.OpMigrate, admin: true, body: []string{"target", "storage", "digest", "confirm"}},
	{method: "DELETE", path: "/guests/{guestId}", op: proto.OpDelete, admin: true, query: []string{"confirm_name", "purge"}},
	{method: "GET", path: "/guests/{guestId}/backups", op: proto.OpBackupList},
	{method: "POST", path: "/guests/{guestId}/backups", op: proto.OpBackupCreate, body: []string{"storage", "mode", "compress", "notes", "protected"}},
	{method: "POST", path: "/backups/restore", op: proto.OpBackupRestore, admin: true,
		body: []string{"platform", "volume", "new_id", "guest", "storage", "start", "unique", "isolate", "confirm"}},
	{method: "PATCH", path: "/backups", op: proto.OpBackupUpdate, body: []string{"platform", "volume", "notes", "protected"}},
	{method: "DELETE", path: "/backups", op: proto.OpBackupDelete, admin: true, query: []string{"platform", "volume"}},
	{method: "GET", path: "/storage/{storage}/content", op: proto.OpContentList, query: []string{"platform", "content"}},
	{method: "POST", path: "/storage/{storage}/download", op: proto.OpContentDownload, admin: true,
		body: []string{"platform", "content", "url", "filename", "checksum", "checksum_algorithm"}},
	{method: "DELETE", path: "/storage/content", op: proto.OpContentDelete, admin: true, query: []string{"platform", "volume"}},
	{method: "GET", path: "/appliances", op: proto.OpApplianceList, query: []string{"platform"}},
	{method: "POST", path: "/storage/{storage}/appliances", op: proto.OpApplianceDownload, admin: true, body: []string{"platform", "template"}},
	{method: "GET", path: "/guests/{guestId}/tasks", op: proto.OpTaskList},
	{method: "GET", path: "/tasks", op: proto.OpTaskList, query: []string{"platform"}},
	{method: "GET", path: "/tasks/{task}", op: proto.OpTaskStatus, query: []string{"platform", "log_start"}},
	{method: "DELETE", path: "/tasks/{task}", op: proto.OpTaskStop, query: []string{"platform"}},
	{method: "GET", path: "/guests/{guestId}/firewall", op: proto.OpFirewallGet},
	{method: "PUT", path: "/guests/{guestId}/firewall/options", op: proto.OpFirewallOptions, body: []string{"digest", "set", "delete"}},
	{method: "POST", path: "/guests/{guestId}/firewall/rules", op: proto.OpFirewallRuleAdd, body: []string{"rule"}},
	{method: "PUT", path: "/guests/{guestId}/firewall/rules/{pos}", op: proto.OpFirewallRuleUpdate, body: []string{"digest", "rule", "move_to"}},
	{method: "DELETE", path: "/guests/{guestId}/firewall/rules/{pos}", op: proto.OpFirewallRuleDelete, query: []string{"digest"}},
	{method: "PUT", path: "/guests/{guestId}/ha", op: proto.OpHASet, admin: true, body: []string{"state", "max_restart", "max_relocate", "comment"}},
	{method: "DELETE", path: "/guests/{guestId}/ha", op: proto.OpHARemove, admin: true},
	{method: "POST", path: "/guests/{guestId}/replication", op: proto.OpReplicationAdd, body: []string{"target", "schedule", "rate", "comment"}},
	{method: "DELETE", path: "/guests/{guestId}/replication/{job}", op: proto.OpReplicationDelete},
	{method: "GET", path: "/backup-jobs", op: proto.OpBackupJobList},
	{method: "POST", path: "/backup-jobs", op: proto.OpBackupJobCreate, admin: true, body: backupJobFields},
	{method: "PUT", path: "/backup-jobs/{job}", op: proto.OpBackupJobUpdate, admin: true, body: append(slices.Clone(backupJobFields), "digest")},
	{method: "DELETE", path: "/backup-jobs/{job}", op: proto.OpBackupJobDelete, admin: true, query: []string{"confirm"}},
	{method: "POST", path: "/backup-jobs/{job}/run", op: proto.OpBackupJobRun, body: []string{}},
}

// manageBody is a request body: the request's own fields, the
// confirmation, and for ha.set the HA settings at the top level.
type manageBody struct {
	proto.ManageRequest
	Confirm     bool   `json:"confirm"`
	State       string `json:"state"`
	MaxRestart  *int   `json:"max_restart"`
	MaxRelocate *int   `json:"max_relocate"`
}

// manageHandler serves one manage route. The router only needs a session:
// role, switches and re-authentication are checked here, and refusals are
// audited like those of consoles and actions.
func (h *Hub) manageHandler(rt manageRoute) handlerFunc {
	if unraidOps[rt.op] {
		return h.unraidManageHandler(rt) // manage_unraid.go
	}
	if packageOps[rt.op] {
		return h.packagesManageHandler(rt) // manage_packages.go
	}
	if appOps[rt.op] {
		return h.appsManageHandler(rt) // manage_apps.go
	}
	if placeOps[rt.op] {
		return h.placeHandler(rt) // manage_backupplace.go
	}
	read := rt.method == http.MethodGet
	guestOp := strings.Contains(rt.path, "{guestId}")
	return func(w http.ResponseWriter, r *http.Request, p *principal) error {
		serverID := r.PathValue("id")
		req, confirm, confirmName, err := parseManage(rt, r)
		if err != nil {
			return err
		}
		gid := model.HostGuestID
		if guestOp {
			gid = r.PathValue("guestId")
			platform, id, ok := model.SplitGuestID(gid)
			if !ok {
				return errGuestNotFound
			}
			req.Platform, req.GuestID = platform, id
		}
		if req.Platform == "" && isHostTask(req.Task) {
			req.Platform = proto.PlatformHost // a package or app task (manage_packages.go, manage_apps.go)
		}
		if req.Isolate != nil && req.Platform != proto.PlatformPVE {
			return invalidFields(map[string]string{"isolate": "Only a Proxmox VE restore (platform pve) can be isolated."})
		}
		if h.libvirtRequest(rt, serverID, &req, guestOp) {
			return h.libvirtManage(w, r, p, rt, req, confirm, confirmName, gid) // manage_libvirt.go
		}
		if fe := validateManage(&req, guestOp); len(fe) > 0 {
			return invalidFields(fe)
		}
		event := "manage.requested"
		if read {
			event = "manage.denied"
		}
		details := manageDetails(req)
		deny := func(e *apiError) error { return h.deny(r, p, event, serverID, gid, "", e, details) }
		if rt.admin {
			// Creating, deleting and restoring guests, downloads and HA:
			// admins with a recent sign-in.
			if p.rank() < store.RoleRank(admin) {
				return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
			}
			if err := h.requireReauth(p); err != nil {
				return err
			}
		}
		if h.throttled(p) {
			return rateLimited(10 * time.Minute)
		}
		t, e := h.remotePrecheck(p, serverID, gid, needManage)
		if e != nil {
			return deny(e)
		}
		// An agent from before isolated restores would restore the backup as
		// it is, with its network and start at boot: never send it one.
		if req.Isolate != nil && !agentCan(t.st.Report, proto.CapRestoreIsolate) {
			return deny(apiErr(http.StatusConflict, "agent_outdated",
				"This server's agent can't restore a copy cut off from the network yet; it gets a newer one by itself."))
		}
		if guestOp && req.Platform != proto.PlatformPVE && req.Platform != proto.PlatformIncus &&
			!(req.Op == proto.OpTaskList && req.Platform == proto.PlatformDocker) { // a container's updates on unRAID
			return apiErr(http.StatusNotImplemented, "unsupported", "Whombat manages Proxmox VE, Incus and libvirt guests only.")
		}
		if req.Platform == "" {
			req.Platform = proto.PlatformIncus
			if t.st.Report != nil && t.st.Report.PVE != nil {
				req.Platform = proto.PlatformPVE
			} else if defaultUnraidPlatform(t.st.Report) {
				req.Platform = proto.PlatformUnraid
			}
		}
		if isBackupJobOp(req.Op) && req.Platform != proto.PlatformPVE {
			return apiErr(http.StatusNotImplemented, "unsupported", "Backup jobs are a Proxmox VE feature, and this server does not run it.")
		}
		if e := incusRouteCheck(req, t); e != nil {
			return e
		}
		// The guest a change is about: the route's, or the one a backup is
		// restored over. On Incus the guest of a restore or a backup
		// deletion names whose backup it is (a restore always makes a new
		// instance).
		target, overwrite := gid, ""
		if (req.Op == proto.OpBackupRestore || req.Op == proto.OpBackupDelete) && req.GuestID != "" && !guestOp {
			platform, id, ok := model.SplitGuestID(req.GuestID)
			if !ok || platform != req.Platform {
				return invalidFields(map[string]string{"guest": "Give a guest of this platform (\"pve:100\")."})
			}
			if _, ok := findGuest(t.st, req.GuestID); !ok {
				return errGuestNotFound
			}
			details["guest"] = req.GuestID
			if req.Op == proto.OpBackupRestore && req.Platform != proto.PlatformIncus {
				target, overwrite = req.GuestID, req.GuestID
			}
			req.GuestID = id
		}
		if e := manageConfirm(req, confirm, confirmName, t.g); e != nil {
			return deny(e)
		}
		if !read {
			// The guest this Whombat runs in (selfguest.go).
			routeGuest := ""
			if guestOp {
				routeGuest = gid
			}
			if e := selfManageRefusal(t.st, req.Op, routeGuest, overwrite); e != nil {
				return deny(e)
			}
		}
		if read {
			return h.manageRead(w, r, p, t, gid, req)
		}
		return h.manageChange(w, r, p, t, target, req, details)
	}
}

// manageRead asks the agent and answers with its part of the response.
func (h *Hub) manageRead(w http.ResponseWriter, r *http.Request, p *principal, t remoteTarget, gid string, req proto.ManageRequest) error {
	serverID := t.st.ID
	// Like inspect views: audited once per user, guest (or host) and view
	// every 10 minutes (the UI polls tasks).
	if h.limits.screens.take(p.key() + "|" + serverID + "|" + req.Op + "|" + gid) {
		h.auditReq(r, p, store.AuditRecord{Event: "manage.viewed", Outcome: "ok", Server: serverID, Guest: guestOrEmpty(gid),
			Platform: req.Platform, Details: map[string]string{"view": req.Op}})
	}
	resp, err := t.conn.Manage(r.Context(), req)
	if err != nil {
		return manageAgentError(err)
	}
	if !resp.OK {
		return manageProblem(resp)
	}
	if req.Op == proto.OpChoices && resp.Choices != nil {
		resp.Choices.RestoreIsolate = req.Platform == proto.PlatformPVE && agentCan(t.st.Report, proto.CapRestoreIsolate)
	}
	body, e := manageAnswer(req.Op, resp)
	if e != nil {
		return e
	}
	writeJSON(w, r, http.StatusOK, body)
	return nil
}

// manageChange audits, sends the change and answers: 200 when it is done,
// 202 when the platform still works on it (a task the hub then follows).
func (h *Hub) manageChange(w http.ResponseWriter, r *http.Request, p *principal, t remoteTarget, target string,
	req proto.ManageRequest, details map[string]string) error {
	serverID := t.st.ID
	if h.closing.Load() {
		return apiErr(http.StatusServiceUnavailable, "shutting_down", "The hub is shutting down.")
	}
	// One change per guest at a time, shared with power actions. A task
	// that keeps running on the platform does not hold it (Proxmox locks
	// the guest itself).
	key := ""
	if target != model.HostGuestID {
		key = serverID + "|" + target
		if !h.actions.begin(key, req.Op) {
			return apiErr(http.StatusConflict, "action_in_progress", "Another action on this guest is still running.")
		}
	}
	end := func() {
		if key != "" {
			h.actions.end(key)
			key = ""
		}
	}
	defer end()
	guest := guestOrEmpty(target)
	auditID, err := h.auditReq(r, p, store.AuditRecord{Event: "manage.requested", Outcome: "ok", Server: serverID, Guest: guest,
		Platform: req.Platform, Details: details})
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; changes are disabled.")
	}
	start := time.Now()
	// The change goes on when the browser goes away: its outcome is
	// audited either way.
	resp, err := t.conn.Manage(context.WithoutCancel(r.Context()), req)
	end()
	fin := func(outcome, code string, extra map[string]string) {
		dur := float64(int64(time.Since(start).Seconds()*10)) / 10
		_, _ = h.audit(context.WithoutCancel(r.Context()), store.AuditRecord{Event: "manage.finished", Outcome: outcome, Code: code,
			User: p.user.Username, Role: p.user.Role, ClientIP: clientIP(r), UserAgent: cleanText(r.UserAgent(), 256),
			Server: serverID, Guest: guest, Platform: req.Platform, DurationS: &dur,
			Details: mergeDetails(details, extra, map[string]string{"requested_audit_id": auditID})})
		h.log.Info("manage", "server", serverID, "guest", guest, "op", req.Op, "outcome", outcome, "code", code)
	}
	if err != nil {
		e := manageAgentError(err)
		fin("error", e.Code, nil)
		return e
	}
	if !resp.OK {
		e := manageProblem(resp)
		fin("error", e.Code, map[string]string{"error": cleanText(e.Detail, 300)})
		return e
	}
	out := map[string]any{"ok": true, "audit_id": auditID}
	extra := map[string]string{}
	if len(resp.Changes) > 0 {
		out["changes"] = resp.Changes
		extra["changes"] = changesText(resp.Changes)
	}
	switch req.Op {
	case proto.OpBackupJobCreate:
		// The new job's id; its settings are in the audit log.
		delete(out, "changes")
		job := cleanText(resp.JobID, 100)
		out["id"], extra["job"] = job, job
	case proto.OpBackupJobUpdate:
		out["changes"] = nonNil(resp.Changes)
	}
	if resp.NewID != "" {
		newID := incusTaskNewID(req.Platform, req.Op, resp.NewID)
		out["new_id"] = newID
		extra["new_id"] = newID
		if guest == "" && !incusImageOps[req.Op] {
			guest = newID
		}
	}
	if resp.Task != nil && resp.Task.ID != "" {
		task := cleanText(resp.Task.ID, 256)
		out["task"] = map[string]string{"id": task}
		h.tasks.add(&taskWatch{server: serverID, guest: guest, platform: req.Platform, op: req.Op, task: task,
			user: p.user.Username, role: p.user.Role, ip: clientIP(r), ua: cleanText(r.UserAgent(), 256),
			details: mergeDetails(details, extra, map[string]string{"requested_audit_id": auditID, "task": task}),
			started: start, next: time.Now().Add(h.cfg.TaskPollInterval)})
		h.log.Info("manage task started", "server", serverID, "guest", guest, "op", req.Op, "task", task)
		writeJSON(w, r, http.StatusAccepted, out)
		return nil
	}
	fin("ok", "", extra)
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// parseManage builds the request from the route: path values, query
// parameters and the body (only the route's fields; unknown ones are
// refused).
func parseManage(rt manageRoute, r *http.Request) (req proto.ManageRequest, confirm bool, confirmName string, err error) {
	if rt.op == proto.OpBackupJobCreate || rt.op == proto.OpBackupJobUpdate {
		if req.BackupJob, req.Digest, err = decodeBackupJob(r, rt.op == proto.OpBackupJobUpdate); err != nil {
			return req, false, "", err
		}
	} else if rt.body != nil {
		b, err := decodeManageBody(r, rt.body)
		if err != nil {
			return req, false, "", err
		}
		req, confirm = b.ManageRequest, b.Confirm
		if rt.op == proto.OpHASet {
			req.HA = &proto.HASettings{State: b.State, MaxRestart: b.MaxRestart, MaxRelocate: b.MaxRelocate, Comment: req.Comment}
			req.Comment = ""
		}
	}
	req.Op = rt.op
	fe := map[string]string{}
	q := r.URL.Query()
	for _, name := range rt.query {
		v := q.Get(name)
		switch name {
		case "platform":
			req.Platform = v
		case "content":
			req.Content = v
		case "volume":
			req.Volume = v
		case "digest":
			req.Digest = v
		case "confirm_name":
			confirmName = v
		case "confirm":
			switch v {
			case "", "0", "false":
			case "1", "true":
				confirm = true
			default:
				fe["confirm"] = "confirm is 1 or 0."
			}
		case "purge":
			switch v {
			case "", "0", "false":
			case "1", "true":
				req.Purge = true
			default:
				fe["purge"] = "purge is 1 or 0."
			}
		case "log_start":
			if v != "" {
				n, err := strconv.Atoi(v)
				if err != nil || n < -1 {
					fe["log_start"] = "log_start is a line number, or -1 for no log."
				}
				req.LogStart = n
			}
		}
	}
	if v := r.PathValue("disk"); v != "" {
		req.Disk = v
	}
	if v := r.PathValue("storage"); v != "" {
		req.Storage = v
	}
	if v := r.PathValue("task"); v != "" {
		req.Task = v
	}
	if v := r.PathValue("job"); v != "" {
		req.JobID = v
	}
	parseIncusManage(rt, r, &req, fe)
	if v := r.PathValue("pos"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 9999 {
			fe["pos"] = "The rule position is a number from 0."
		}
		req.Pos = &n
	}
	if len(fe) > 0 {
		return req, false, "", invalidFields(fe)
	}
	return req, confirm, confirmName, nil
}

// decodeManageBody decodes a JSON object with only the allowed fields
// (an empty body is an empty object).
func decodeManageBody(r *http.Request, allowed []string) (manageBody, error) {
	var b manageBody
	if r.Body == nil {
		return b, nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
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
		if !slices.Contains(allowed, k) {
			return b, apiErr(http.StatusBadRequest, "bad_request", fmt.Sprintf("Invalid JSON body: unknown field %q", k))
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return b, apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: "+err.Error())
	}
	return b, nil
}

// invalidFields is 400 invalid_value with the fields that failed.
func invalidFields(fe map[string]string) *apiError {
	e := apiErr(http.StatusBadRequest, "invalid_value", "Check the marked fields.")
	if len(fe) == 1 {
		for k, v := range fe {
			e.Detail = k + ": " + v
		}
	}
	e.Fields = fe
	return e
}

// ---- validation ------------------------------------------------------------------

// Cheap checks before a request goes to the agent. The agent checks every
// key and value against its own allowlist (docs/MANAGE.md 2.4); these only
// refuse what can never be valid.
var (
	manageKeyRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	manageNameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$`)
	manageIDRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`) // storages, nodes, profiles, disks, devices
	manageVolumeRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}:[!-~]{1,400}$`)
	manageSizeRe   = regexp.MustCompile(`^\+?[0-9]{1,9}(\.[0-9]{1,3})?[KMGT]?$`)
	manageTaskRe   = regexp.MustCompile(`^(UPID:[!-~]{1,250}|incus:[0-9A-Za-z-]{1,64}|unraid:[0-9a-f]{16}|libvirt:[0-9a-f]{16}|pkg:[0-9a-f]{16}|app:[0-9a-f]{16})$`)
	manageFileRe   = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$`)
	manageTmplRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+-]{0,254}$`)
	manageWordRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_+-]{0,63}$`) // firewall actions, macros, protocols
	manageJobRe    = regexp.MustCompile(`^[0-9]{1,9}-[0-9]{1,4}$`)
	manageRateRe   = regexp.MustCompile(`^[0-9]{1,6}(\.[0-9]{1,2})?$`)
	manageHexRe    = regexp.MustCompile(`^[0-9A-Fa-f]{32,128}$`)
	unusedKeyRe    = regexp.MustCompile(`^unused[0-9]+$`)

	firewallOptionKeys = []string{"enable", "dhcp", "ndp", "radv", "macfilter", "ipfilter", "policy_in", "policy_out",
		"log_level_in", "log_level_out"}
	downloadExt = map[string][]string{
		"iso":    {".iso", ".img"},
		"vztmpl": {".tar.gz", ".tar.xz", ".tar.zst"},
		"import": {".ova", ".qcow2", ".vmdk", ".raw", ".img"},
	}
)

// restoreMarkerRe and pveTagRe: an isolated restore's marker and tag.
var (
	restoreMarkerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	pveTagRe        = regexp.MustCompile(`^[a-z0-9_][a-z0-9_.+-]{0,63}$`)
)

// manageText reports whether s is valid UTF-8 of at most max bytes without
// control characters (newlines and tabs allowed when multiline).
func manageText(s string, max int, multiline bool) bool {
	if len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// validateManage checks a request's values; the answer maps fields to
// messages (empty: valid).
func validateManage(req *proto.ManageRequest, guestOp bool) map[string]string {
	fe := map[string]string{}
	bad := func(ok bool, field, msg string) {
		if !ok && fe[field] == "" {
			fe[field] = msg
		}
	}
	oneOf := func(v string, allowed ...string) bool { return slices.Contains(allowed, v) }
	op := req.Op
	if !guestOp {
		// host: the package and app tasks (manage_packages.go, manage_apps.go).
		hostTasks := op == proto.OpTaskList || ((op == proto.OpTaskStatus || op == proto.OpTaskStop) && isHostTask(req.Task))
		bad(oneOf(req.Platform, "", proto.PlatformPVE, proto.PlatformIncus, proto.PlatformUnraid) || (hostTasks && req.Platform == proto.PlatformHost),
			"platform", "platform is pve, incus, unraid or, for package and app tasks, host.")
		bad(!isHostTask(req.Task) || req.Platform == proto.PlatformHost, "platform", "A package or app task's platform is host.")
	}
	bad(manageText(req.Digest, 128, false) && !strings.ContainsRune(req.Digest, ' '), "digest", "Not a digest.")

	// Configuration keys and values.
	if n := len(req.Set) + len(req.Delete) + len(req.Revert); n > 300 {
		fe["set"] = "Too many keys in one change."
	}
	for k, v := range req.Set {
		switch {
		case !manageKeyRe.MatchString(k):
			bad(false, k, "Not a configuration key.")
		case op == proto.OpFirewallOptions && !slices.Contains(firewallOptionKeys, k):
			bad(false, k, "Not a firewall option.")
		case !manageText(v, 65536, true):
			bad(false, k, "The value has control characters or is too long.")
		}
	}
	for _, list := range [][]string{req.Delete, req.Revert} {
		for _, k := range list {
			bad(manageKeyRe.MatchString(k), k, "Not a configuration key.")
			if _, set := req.Set[k]; set {
				bad(false, k, "A key cannot be set and removed at once.")
			}
		}
	}
	if op == proto.OpFirewallOptions {
		for _, k := range req.Delete {
			bad(slices.Contains(firewallOptionKeys, k), k, "Not a firewall option.")
		}
	}

	switch op {
	case proto.OpDiskResize, proto.OpDiskMove:
		bad(manageIDRe.MatchString(req.Disk), "disk", "Not a disk.")
	}
	if op == proto.OpDiskResize {
		bad(manageSizeRe.MatchString(req.Size), "size", "The size is \"+8G\" (grow by) or the new total (\"40G\").")
	}
	needStorage := op == proto.OpDiskMove || (op == proto.OpBackupCreate && req.Platform != proto.PlatformIncus) || op == proto.OpContentList ||
		op == proto.OpContentDownload || op == proto.OpApplianceDownload
	bad(req.Storage != "" || !needStorage, "storage", "Choose a storage.")
	bad(req.Storage == "" || manageIDRe.MatchString(req.Storage), "storage", "Not a storage.")

	// New guests: create, clone, restore.
	if op == proto.OpCreate {
		bad(oneOf(req.Kind, "vm", "container"), "kind", "kind is vm or container.")
	}
	bad(req.NewID == 0 || (req.NewID >= 100 && req.NewID <= 999999999), "new_id", "The id is a number from 100 to 999999999.")
	bad(req.Name == "" || manageNameRe.MatchString(req.Name) || incusNameOp(req), "name",
		"Names are up to 63 letters, digits, dots and dashes, starting with a letter or digit.")
	if req.Platform == proto.PlatformIncus {
		bad(req.NewID == 0, "new_id", "Incus instances have no numeric id.")
		bad(req.Name != "" || (op != proto.OpCreate && op != proto.OpClone), "name", "Give the instance a name.")
		bad(req.Image != "" || op != proto.OpCreate, "image", "Choose an image.")
	}
	bad(manageText(req.Image, 255, false) && !strings.ContainsRune(req.Image, ' '), "image", "Not an image.")
	bad(len(req.Profiles) <= 16, "profiles", "At most 16 profiles.")
	for _, pr := range req.Profiles {
		bad(manageIDRe.MatchString(pr), "profiles", "Not a profile name.")
	}
	if op == proto.OpBackupRestore {
		bad(req.NewID == 0 || req.GuestID == "", "new_id", "Restore as a new guest (new_id) or over a guest (guest), not both.")
	}
	if iso := req.Isolate; iso != nil {
		bad(op == proto.OpBackupRestore && req.Platform == proto.PlatformPVE, "isolate",
			"Only a Proxmox VE restore can be isolated.")
		bad(req.NewID != 0 && req.GuestID == "" && !req.Start, "isolate", "An isolated restore makes a new guest (new_id) that doesn't start.")
		bad(manageNameRe.MatchString(iso.Name) && !strings.Contains(iso.Name, "."), "isolate.name", "The copy's name is a host name.")
		bad(restoreMarkerRe.MatchString(iso.Marker), "isolate.marker", "The marker is one word of letters, digits, '-' and '_'.")
		bad(iso.Tag == "" || pveTagRe.MatchString(iso.Tag), "isolate.tag", "Not a Proxmox VE tag.")
	}

	// Backups and storage content.
	needVolume := op == proto.OpBackupRestore || op == proto.OpBackupUpdate || op == proto.OpBackupDelete || op == proto.OpContentDelete
	bad(req.Volume != "" || !needVolume, "volume", "Choose a volume.")
	if req.Platform == proto.PlatformIncus { // a backup or custom volume name
		bad(req.Volume == "" || incusNameRe.MatchString(req.Volume), "volume", "Not a backup or volume name.")
	} else {
		bad(req.Volume == "" || manageVolumeRe.MatchString(req.Volume), "volume", "Not a volume (\"storage:path\").")
	}
	bad(oneOf(req.Mode, "", "snapshot", "suspend", "stop"), "mode", "mode is snapshot, suspend or stop.")
	bad(oneOf(req.Compress, "", "zstd", "lzo", "gzip", "none"), "compress", "compress is zstd, lzo, gzip or none.")
	bad(manageText(req.Notes, 1024, true), "notes", "Notes are up to 1024 characters.")
	if op == proto.OpContentList || op == proto.OpContentDownload {
		bad(oneOf(req.Content, "iso", "vztmpl", "import"), "content", "content is iso, vztmpl or import.")
	}
	if op == proto.OpContentDownload {
		bad(validDownloadURL(req.URL), "url", "Give an http:// or https:// address without a user name or password.")
		ok := manageFileRe.MatchString(req.Filename)
		if ok {
			ok = slices.ContainsFunc(downloadExt[req.Content], func(ext string) bool { return strings.HasSuffix(strings.ToLower(req.Filename), ext) })
		}
		bad(ok, "filename", "File names are letters, digits, '.', '_' and '-' and end in "+strings.Join(downloadExt[req.Content], ", ")+".")
		bad(oneOf(req.ChecksumAlgorithm, "", "md5", "sha1", "sha224", "sha256", "sha384", "sha512"), "checksum_algorithm",
			"checksum_algorithm is md5, sha1, sha224, sha256, sha384 or sha512.")
		bad((req.Checksum == "") == (req.ChecksumAlgorithm == ""), "checksum", "Give the checksum together with its algorithm.")
		bad(req.Checksum == "" || manageHexRe.MatchString(req.Checksum), "checksum", "The checksum is hexadecimal.")
	}
	if op == proto.OpApplianceDownload {
		bad(manageTmplRe.MatchString(req.Template), "template", "Choose a template.")
	}

	// Tasks.
	if op == proto.OpTaskStatus || op == proto.OpTaskStop {
		bad(manageTaskRe.MatchString(req.Task), "task", "Not a task id.")
	}

	// Firewall.
	if req.MoveTo != nil {
		bad(*req.MoveTo >= 0 && *req.MoveTo <= 9999, "move_to", "The position is a number from 0.")
	}
	switch op {
	case proto.OpFirewallRuleAdd:
		bad(req.Rule != nil, "rule", "Give the rule.")
	case proto.OpFirewallRuleUpdate:
		bad(req.Rule != nil || req.MoveTo != nil, "rule", "Give the rule or move_to.")
	}
	if ru := req.Rule; ru != nil {
		bad(oneOf(ru.Type, "in", "out", "group"), "rule.type", "type is in, out or group.")
		bad(manageWordRe.MatchString(ru.Action), "rule.action", "Choose ACCEPT, DROP, REJECT or a security group.")
		bad(ru.Macro == "" || manageWordRe.MatchString(ru.Macro), "rule.macro", "Not a macro.")
		bad(ru.Proto == "" || manageWordRe.MatchString(ru.Proto), "rule.proto", "Not a protocol.")
		bad(ru.Pos >= 0 && ru.Pos <= 9999, "rule.pos", "The position is a number from 0.")
		for field, v := range map[string]string{"rule.source": ru.Source, "rule.dest": ru.Dest, "rule.sport": ru.SPort,
			"rule.dport": ru.DPort, "rule.iface": ru.Iface, "rule.log": ru.Log} {
			bad(manageText(v, 512, false), field, "The value has control characters or is too long.")
		}
		bad(manageText(ru.Comment, 512, false), "rule.comment", "Comments are one line of up to 512 characters.")
	}

	// HA and replication.
	if ha := req.HA; ha != nil {
		bad(oneOf(ha.State, "started", "stopped", "ignored", "disabled"), "state", "state is started, stopped, ignored or disabled.")
		bad(ha.MaxRestart == nil || (*ha.MaxRestart >= 0 && *ha.MaxRestart <= 10), "max_restart", "From 0 to 10.")
		bad(ha.MaxRelocate == nil || (*ha.MaxRelocate >= 0 && *ha.MaxRelocate <= 10), "max_relocate", "From 0 to 10.")
		bad(manageText(ha.Comment, 512, false), "comment", "Comments are one line of up to 512 characters.")
	}
	if op == proto.OpMigrate {
		bad(manageIDRe.MatchString(req.Target), "target", "Choose the node to move the guest to.")
	}
	if op == proto.OpReplicationAdd {
		bad(manageIDRe.MatchString(req.Target), "target", "Choose the node to replicate to.")
		bad(manageText(req.Schedule, 128, false), "schedule", "Not a schedule.")
		bad(req.Rate == "" || manageRateRe.MatchString(req.Rate), "rate", "The rate is in MB/s (\"50\").")
		bad(manageText(req.Comment, 512, false), "comment", "Comments are one line of up to 512 characters.")
	}
	if op == proto.OpReplicationDelete {
		bad(manageJobRe.MatchString(req.JobID), "job", "Not a replication job (\"100-0\").")
	}
	switch op {
	case proto.OpBackupJobUpdate, proto.OpBackupJobDelete, proto.OpBackupJobRun:
		bad(backupJobIDRe.MatchString(req.JobID), "job", "Not a backup job id.")
	}
	validateIncus(req, bad)
	return fe
}

// validDownloadURL accepts http(s) URLs with a host and without
// credentials.
func validDownloadURL(s string) bool {
	if s == "" || len(s) > 2048 || !manageText(s, 2048, false) || strings.ContainsAny(s, " \\") {
		return false
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

// manageConfirm applies the confirmation rules (docs/MANAGE.md 1): deleting
// an unused disk, converting to a template and restoring over a guest need
// "confirm": true, deleting a guest its name.
func manageConfirm(req proto.ManageRequest, confirm bool, confirmName string, g proto.PlatformGuest) *apiError {
	need := func(detail string) *apiError { return apiErr(http.StatusBadRequest, "confirm_required", detail) }
	if e := incusConfirm(req, confirm); e != nil {
		return e
	}
	switch req.Op {
	case proto.OpConfigSet:
		for _, k := range req.Delete {
			if unusedKeyRe.MatchString(k) && !confirm {
				return need("Deleting an unused disk destroys its volume: send \"confirm\": true.")
			}
		}
	case proto.OpTemplate:
		if !confirm {
			return need("Converting a guest to a template cannot be undone: send \"confirm\": true.")
		}
	case proto.OpMigrate:
		if !confirm {
			return need("Moving a guest to another node takes a while, and restarts a running container: send \"confirm\": true.")
		}
	case proto.OpBackupRestore:
		if req.GuestID != "" && req.Platform != proto.PlatformIncus && !confirm {
			return need("Restoring over a guest replaces its disks: send \"confirm\": true.")
		}
	case proto.OpBackupJobDelete:
		if !confirm {
			return need("Deleting a backup job stops its scheduled backups: send confirm=1.")
		}
	case proto.OpDelete:
		name := g.Name
		if name == "" {
			name = g.ID
		}
		if confirmName != name {
			return need("Send the guest's name as confirm_name to delete it.")
		}
	}
	return nil
}

// ---- answers and audit -----------------------------------------------------------

// manageStatus maps agent codes to HTTP statuses (docs/MANAGE.md 3).
var manageStatus = map[string]int{
	proto.CodeInvalidValue: http.StatusBadRequest, "invalid_request": http.StatusBadRequest,
	proto.CodeNotAllowed: http.StatusForbidden, "remote_control_disabled": http.StatusForbidden,
	"unknown_guest": http.StatusNotFound, proto.CodeNotFound: http.StatusNotFound,
	proto.CodeDigestMismatch: http.StatusConflict, proto.CodeLocked: http.StatusConflict, proto.CodeGuestRunning: http.StatusConflict,
	proto.CodeProtected: http.StatusConflict, proto.CodeExists: http.StatusConflict, "busy": http.StatusConflict,
	proto.CodeInUse: http.StatusConflict, proto.CodeSelfGuest: http.StatusConflict,
	"guest_not_running": http.StatusConflict, "unsupported": http.StatusNotImplemented, "unsupported_action": http.StatusNotImplemented,
	"platform_error": http.StatusBadGateway, "inventory_unavailable": http.StatusServiceUnavailable, "timeout": http.StatusGatewayTimeout,
}

// manageMessages are shown when the agent gave no message of its own.
var manageMessages = map[string]string{
	proto.CodeDigestMismatch:  "The configuration changed since it was loaded. Review it again.",
	proto.CodeLocked:          "The guest is locked by another operation.",
	proto.CodeGuestRunning:    "Stop the guest first.",
	proto.CodeProtected:       "Protection is set: turn it off first.",
	proto.CodeExists:          "This id or name is taken.",
	proto.CodeInUse:           "Something still uses it.",
	proto.CodeNotAllowed:      "Whombat does not change this: use the platform's own interface.",
	"remote_control_disabled": model.ReasonAgentMgmt + ".",
	"busy":                    "Another action on this guest is still running.",
	"unsupported":             "This cannot be done through Whombat on this host.",
	"inventory_unavailable":   "The agent has not read its guests yet; try again in a moment.",
	"timeout":                 "The host did not answer in time.",
}

// manageProblem turns an agent refusal into a problem with the agent's
// code, its message and its field errors.
func manageProblem(resp proto.ManageResponse) *apiError {
	code := resp.Code
	status, ok := manageStatus[code]
	if !ok {
		status = http.StatusBadGateway
		if code == "" {
			code = "agent_error"
		}
	}
	msg := resp.Message
	if msg == "" {
		msg = manageMessages[code]
	}
	if msg == "" {
		msg = "The agent could not do this."
	}
	e := apiErr(status, code, msg)
	if len(resp.FieldErrors) > 0 {
		e.Fields = map[string]string{}
		for k, v := range resp.FieldErrors {
			if len(e.Fields) == 64 {
				break
			}
			e.Fields[cleanText(k, 128)] = cleanText(v, 512)
		}
	}
	return e
}

// manageAgentError is the problem for an agent that did not answer.
func manageAgentError(err error) *apiError {
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return apiErr(http.StatusGatewayTimeout, "timeout", "The agent did not answer in time.")
	}
	return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
}

// manageAnswer is the JSON of a read: the response part of the operation.
func manageAnswer(op string, resp proto.ManageResponse) (any, *apiError) {
	empty := apiErr(http.StatusBadGateway, "agent_error", "The agent sent an empty answer.")
	switch op {
	case proto.OpConfigGet:
		c := resp.Config
		if c == nil {
			return nil, empty
		}
		if c.Values == nil {
			c.Values = map[string]string{}
		}
		return c, nil
	case proto.OpChoices:
		c := resp.Choices
		if c == nil {
			return nil, empty
		}
		c.Storages, c.Bridges = nonNil(c.Storages), nonNil(c.Bridges)
		return c, nil
	case proto.OpBackupList:
		return map[string]any{"items": nonNil(resp.Backups)}, nil
	case proto.OpContentList:
		return map[string]any{"items": nonNil(resp.Content)}, nil
	case proto.OpApplianceList:
		return map[string]any{"items": nonNil(resp.Appliances)}, nil
	case proto.OpTaskList:
		for i := range resp.Tasks {
			packageResultArrays(&resp.Tasks[i])
			appResultArrays(&resp.Tasks[i])
		}
		return map[string]any{"items": nonNil(resp.Tasks)}, nil
	case proto.OpBackupJobList:
		items := make([]backupJobJSON, 0, len(resp.BackupJobs))
		for _, j := range resp.BackupJobs {
			items = append(items, backupJobAnswer(j))
		}
		return map[string]any{"items": items}, nil
	case proto.OpTaskStatus:
		if resp.TaskStatus == nil {
			return nil, empty
		}
		packageResultArrays(resp.TaskStatus)
		appResultArrays(resp.TaskStatus)
		return resp.TaskStatus, nil
	case proto.OpFirewallGet:
		f := resp.Firewall
		if f == nil {
			return nil, empty
		}
		if f.Options == nil {
			f.Options = map[string]string{}
		}
		f.Rules = nonNil(f.Rules)
		return f, nil
	}
	if body, ok := incusAnswer(op, resp); ok {
		return body, nil
	}
	return nil, empty
}

// manageDetails are the audit details of a request: the operation and its
// target fields, never values (secrets stay out of the audit log).
func manageDetails(req proto.ManageRequest) map[string]string {
	d := map[string]string{"op": req.Op}
	put := func(k, v string) {
		if v != "" {
			d[k] = cleanText(v, 300)
		}
	}
	put("disk", req.Disk)
	put("size", req.Size)
	put("storage", req.Storage)
	if req.NewID > 0 {
		d["new_id"] = strconv.Itoa(req.NewID)
	}
	put("name", req.Name)
	put("kind", req.Kind)
	put("image", req.Image)
	put("volume", req.Volume)
	put("url", auditURL(req.URL))
	put("filename", req.Filename)
	put("content", req.Content)
	put("template", req.Template)
	put("task", req.Task)
	put("target", req.Target)
	put("job", req.JobID)
	if req.Pos != nil {
		d["pos"] = strconv.Itoa(*req.Pos)
	}
	if req.HA != nil {
		put("state", req.HA.State)
	}
	if req.Purge {
		d["purge"] = "true"
	}
	incusDetails(req, put)
	// Changed keys without their values; the agent's answer has the
	// values (masked) for manage.finished.
	var keys []string
	for k := range req.Set {
		keys = append(keys, k)
	}
	keys = append(append(keys, req.Delete...), req.Revert...)
	keys = append(keys, incusDeviceKeys(req)...)
	if j := req.BackupJob; j != nil {
		if j.Storage != nil {
			put("storage", *j.Storage)
		}
		keys = append(keys, backupJobKeys(j)...)
	}
	if len(keys) > 0 {
		sort.Strings(keys)
		put("keys", strings.Join(slices.Compact(keys), ", "))
	}
	return d
}

// mergeDetails merges audit details into a new map (later maps win).
func mergeDetails(maps ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// auditURL is a download address without its query and fragment (signed
// links carry credentials there).
func auditURL(s string) string {
	u, err := url.Parse(s)
	if err != nil || s == "" {
		return ""
	}
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String()
}

// secretKeys are configuration keys whose values are never written to the
// audit log or the hub log.
var secretKeys = map[string]bool{"cipassword": true, "password": true}

const maskedValue = "**********"

// changesText renders config changes for the audit log ("key: old → new;
// …", at most 2000 bytes), secrets masked.
func changesText(changes []proto.ConfigChange) string {
	value := func(key, v string) string {
		if v == "" {
			return v
		}
		if secretKeys[key] || v == maskedValue {
			return maskedValue
		}
		v = strings.NewReplacer("\n", " ", "\r", " ", "\t", " ").Replace(v)
		return cleanText(v, 200)
	}
	var b strings.Builder
	for i, c := range changes {
		if i > 0 {
			b.WriteString("; ")
		}
		key := cleanText(c.Key, 128)
		b.WriteString(key + ": " + value(key, c.Old) + " → " + value(key, c.New))
		if c.Pending {
			b.WriteString(" (pending)")
		}
	}
	s := b.String()
	if len(s) > 2000 {
		cut := 1997
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = s[:cut] + "…"
	}
	return s
}

// ---- task watcher ----------------------------------------------------------------

// taskWatchMax is how long the hub follows a platform task.
const taskWatchMax = 24 * time.Hour

// taskWatcher holds the platform tasks the hub started and follows until
// they end (manage.finished, SSE task.finished). It does not survive a
// restart.
type taskWatcher struct {
	mu sync.Mutex
	m  map[string]*taskWatch // server|task -> watch
}

type taskWatch struct {
	server, guest, platform, op, task string
	user, role, ip, ua                string
	details                           map[string]string // manage.finished details so far
	newID                             string            // what the finished task made, when it said (TaskStatus.NewID)
	started                           time.Time
	next                              time.Time // next poll
	busy                              bool      // a poll is running
}

func newTaskWatcher() *taskWatcher { return &taskWatcher{m: map[string]*taskWatch{}} }

func (tw *taskWatcher) add(w *taskWatch) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	tw.m[w.server+"|"+w.task] = w
}

// pollTasks asks the agents about the tasks that are due (a job, every
// TaskPollInterval).
func (h *Hub) pollTasks(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	now := time.Now()
	var due []*taskWatch
	h.tasks.mu.Lock()
	for _, w := range h.tasks.m {
		if !w.busy && !now.Before(w.next) {
			w.busy = true
			due = append(due, w)
		}
	}
	h.tasks.mu.Unlock()
	for _, w := range due {
		h.bg.Add(1)
		go func() {
			defer h.bg.Done()
			h.pollTask(ctx, w)
		}()
	}
}

// pollTask asks once about a task; it finishes the task when it ended,
// vanished or ran too long.
func (h *Hub) pollTask(ctx context.Context, w *taskWatch) {
	wait := h.cfg.TaskPollInterval
	defer func() {
		h.tasks.mu.Lock()
		w.busy, w.next = false, time.Now().Add(wait)
		h.tasks.mu.Unlock()
	}()
	if time.Since(w.started) > taskWatchMax {
		h.finishTask(w, "warning", "Whombat stopped following this task after 24 hours.", "timeout")
		return
	}
	conn := h.conn(w.server)
	if conn == nil {
		wait = 5 * h.cfg.TaskPollInterval
		return
	}
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := conn.Manage(pctx, proto.ManageRequest{Op: proto.OpTaskStatus, Platform: w.platform, Task: w.task, LogStart: -1})
	switch {
	case err != nil:
		return // the agent went away or is slow: ask again
	case !resp.OK && resp.Code == proto.CodeNotFound:
		h.finishTask(w, "warning", "The host no longer knows this task; its result is unknown.", proto.CodeNotFound)
		return
	case !resp.OK || resp.TaskStatus == nil:
		return
	}
	st := resp.TaskStatus
	w.newID = incusTaskNewID(w.platform, w.op, st.NewID)
	if st.Status != "running" && st.Packages != nil {
		h.tasks.mu.Lock()
		w.details = mergeDetails(w.details, packageTaskDetails(st))
		h.tasks.mu.Unlock()
	}
	if st.Status != "running" && len(st.Apps) > 0 {
		h.tasks.mu.Lock()
		w.details = mergeDetails(w.details, appTaskDetails(st))
		h.tasks.mu.Unlock()
	}
	switch st.Status {
	case "running":
	case "ok", "warning":
		h.finishTask(w, st.Status, cleanText(st.Message, 512), "")
	default:
		// A package task says why it didn't do its work (busy: the package
		// lock stayed held; timeout: its limit).
		code := "task_failed"
		if c := cleanText(st.Code, 32); c != "" {
			code = c
		}
		h.finishTask(w, "error", cleanText(st.Message, 512), code)
	}
}

// finishTask writes manage.finished and publishes task.finished.
func (h *Hub) finishTask(w *taskWatch, result, message, code string) {
	h.tasks.mu.Lock()
	delete(h.tasks.m, w.server+"|"+w.task)
	h.tasks.mu.Unlock()
	outcome := "ok"
	if code != "" {
		outcome = "error"
	}
	d := mergeDetails(w.details, map[string]string{"result": result})
	if message != "" && result != "ok" {
		d["message"] = cleanText(message, 300)
	}
	if w.newID != "" {
		d["new_id"] = w.newID
	}
	dur := float64(int64(time.Since(w.started).Seconds()*10)) / 10
	_, _ = h.audit(context.Background(), store.AuditRecord{Event: "manage.finished", Outcome: outcome, Code: code,
		User: w.user, Role: w.role, ClientIP: w.ip, UserAgent: w.ua, Server: w.server, Guest: w.guest, Platform: w.platform,
		DurationS: &dur, Details: d})
	h.log.Info("manage task finished", "server", w.server, "guest", w.guest, "op", w.op, "result", result)
	var guest any
	if w.guest != "" {
		guest = w.guest
	}
	ev := map[string]any{"server": w.server, "guest": guest, "task": w.task, "op": w.op, "result": result, "message": message}
	if w.newID != "" {
		ev["new_id"] = w.newID
	}
	if code != "" {
		ev["code"] = code // task_failed, busy, timeout, not_found
	}
	h.bus.Publish("task.finished", ev)
}
