package hub

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// Diagnostics and commands for the Whombat server's tools (docs/WHOMBAT.md
// "Diagnose and exec"): the agent's read-only checks (docs/ASSIST.md 3.1)
// and one root command, which the assistant used as its own tools.
//
//	GET  /servers/{id}/diagnose   the checks this host can run (operator, diagnose switch)
//	POST /servers/{id}/diagnose   run one check {check, args} (operator, diagnose switch)
//	POST /servers/{id}/exec       run one command {command, timeout_s} (admin, host shell switches)

const needDiagnose = "diagnose"

// apiDiagnoseList is GET /servers/{id}/diagnose.
func (h *Hub) apiDiagnoseList(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID := r.PathValue("id")
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	t, e := h.remotePrecheck(p, serverID, model.HostGuestID, needDiagnose)
	if e != nil {
		return h.deny(r, p, "diagnose.denied", serverID, model.HostGuestID, "", e, map[string]string{"check": proto.DiagnoseList})
	}
	resp, err := t.conn.Diagnose(r.Context(), proto.DiagnoseRequest{Check: proto.DiagnoseList})
	if err != nil {
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}
	if resp.Code != "" {
		return diagnoseProblem(resp.Code, resp.Message)
	}
	checks := resp.Checks
	if checks == nil {
		checks = []proto.DiagnoseCheck{}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"server": serverID, "checks": checks})
	return nil
}

// apiDiagnose is POST /servers/{id}/diagnose {check, args}: the check's
// output (200 with ok false when the check ran and failed or timed out).
func (h *Hub) apiDiagnose(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID := r.PathValue("id")
	var req struct {
		Check string         `json:"check"`
		Args  map[string]any `json:"args"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	dr := proto.DiagnoseRequest{Check: strings.TrimSpace(req.Check), Args: map[string]string{}}
	if !manageWordRe.MatchString(dr.Check) || dr.Check == proto.DiagnoseList {
		return invalidFields(map[string]string{"check": "Name a check of GET /servers/{id}/diagnose."})
	}
	if len(req.Args) > 16 {
		return invalidFields(map[string]string{"args": "At most 16 arguments."})
	}
	for k, v := range req.Args {
		s := fmt.Sprint(v)
		if !manageKeyRe.MatchString(k) || !manageText(s, 1024, false) {
			return invalidFields(map[string]string{"args." + k: "Arguments are names with one line of text (at most 1024 characters)."})
		}
		dr.Args[k] = s
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	details := map[string]string{"check": dr.Check}
	if a := argsText(dr.Args); a != "" {
		details["args"] = a
	}
	t, e := h.remotePrecheck(p, serverID, model.HostGuestID, needDiagnose)
	if e != nil {
		return h.deny(r, p, "diagnose.denied", serverID, model.HostGuestID, "", e, details)
	}
	start := time.Now()
	resp, err := t.conn.Diagnose(r.Context(), dr)
	dur := float64(int64(time.Since(start).Seconds()*10)) / 10
	rec := store.AuditRecord{Event: "diagnose.ran", Outcome: "ok", Server: serverID, DurationS: &dur, Details: details}
	if err != nil {
		rec.Outcome, rec.Code = "error", "agent_error"
		h.auditReq(r, p, rec)
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}
	switch resp.Code {
	case "", "failed", "timeout":
	default:
		rec.Outcome, rec.Code = "error", resp.Code
		h.auditReq(r, p, rec)
		return diagnoseProblem(resp.Code, resp.Message)
	}
	if resp.Code != "" {
		rec.Outcome, rec.Code = "error", resp.Code
	}
	h.auditReq(r, p, rec)
	out := map[string]any{"server": serverID, "check": dr.Check, "ok": resp.Code == "", "commands": nonNil(resp.Commands),
		"output": resp.Output, "truncated": resp.Truncated}
	if resp.Code != "" {
		out["code"], out["message"] = resp.Code, resp.Message
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// diagnoseProblem maps the agent's diagnose codes to HTTP.
func diagnoseProblem(code, msg string) *apiError {
	switch code {
	case "invalid_request":
		if msg == "" {
			msg = "An argument is not valid."
		}
		return apiErr(http.StatusBadRequest, "invalid_request", msg)
	case "unsupported":
		if msg == "" {
			msg = "This host cannot run that check."
		}
		return apiErr(http.StatusNotFound, "unknown_check", msg)
	case "remote_control_disabled":
		return apiErr(http.StatusForbidden, "diagnose_disabled", model.ReasonAgentDiag+".")
	}
	if msg == "" {
		msg = "The agent could not run the check."
	}
	return apiErr(http.StatusBadGateway, "agent_error", msg)
}

// argsText is "k=v k=v" for the audit log (sorted, at most 300 characters).
func argsText(args map[string]string) string {
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, k+"="+args[k])
	}
	return cleanText(strings.Join(parts, " "), 300)
}

// apiExec is POST /servers/{id}/exec {command, timeout_s}: one shell
// command as root on the host, its exit code and output (the last 256 KiB).
// Needs an admin, the host shell switches on both sides and a recent
// sign-in (the service token counts); audited before it runs.
func (h *Hub) apiExec(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID := r.PathValue("id")
	var req struct {
		Command  string `json:"command"`
		TimeoutS int    `json:"timeout_s"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if strings.TrimSpace(req.Command) == "" || len(req.Command) > 16<<10 || strings.ContainsRune(req.Command, 0) {
		return invalidFields(map[string]string{"command": "Give a command of at most 16 KiB."})
	}
	if req.TimeoutS == 0 {
		req.TimeoutS = 120
	}
	if req.TimeoutS < 1 || req.TimeoutS > 1800 {
		return invalidFields(map[string]string{"timeout_s": "The timeout is 1 to 1800 seconds."})
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	details := map[string]string{"command": cleanText(req.Command, 500), "timeout_s": fmt.Sprint(req.TimeoutS)}
	if p.rank() < store.RoleRank(admin) {
		return h.deny(r, p, "exec.denied", serverID, model.HostGuestID, "", apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."), details)
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	t, e := h.remotePrecheck(p, serverID, model.HostGuestID, needHostShell)
	if e != nil {
		return h.deny(r, p, "exec.denied", serverID, model.HostGuestID, "", e, details)
	}
	if h.closing.Load() {
		return apiErr(http.StatusServiceUnavailable, "shutting_down", "The hub is shutting down.")
	}
	auditID, err := h.auditReq(r, p, store.AuditRecord{Event: "exec.requested", Outcome: "ok", Server: serverID, Details: details})
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; commands are disabled.")
	}
	// The command runs to its end when the caller goes away; its outcome is
	// audited either way.
	resp, err := t.conn.Exec(context.WithoutCancel(r.Context()), proto.ExecRequest{Command: req.Command, TimeoutS: req.TimeoutS})
	fin := store.AuditRecord{Event: "exec.finished", Outcome: "ok", Server: serverID,
		Details: mergeDetails(details, map[string]string{"requested_audit_id": auditID})}
	switch {
	case err != nil:
		fin.Outcome, fin.Code = "error", "agent_error"
	case resp.Code != "":
		fin.Outcome, fin.Code = "error", resp.Code
	default:
		dur := float64(resp.DurationMs/100) / 10
		fin.DurationS = &dur
		fin.Details["exit_code"] = fmt.Sprint(resp.ExitCode)
		if resp.TimedOut {
			fin.Details["timed_out"] = "true"
		}
		if resp.ExitCode != 0 || resp.TimedOut {
			fin.Outcome = "error"
		}
	}
	h.auditReq(r, p, fin)
	h.log.Info("exec", "server", serverID, "user", p.user.Username, "outcome", fin.Outcome, "code", fin.Code)
	if err != nil {
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}
	switch resp.Code {
	case "":
	case "remote_control_disabled":
		return apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonAgentShell+".")
	case "invalid_request":
		return invalidFields(map[string]string{"command": resp.Message})
	default:
		msg := resp.Message
		if msg == "" {
			msg = "The command could not be started."
		}
		return apiErr(http.StatusBadGateway, "agent_error", msg)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"server": serverID, "exit_code": resp.ExitCode, "timed_out": resp.TimedOut,
		"output": resp.Output, "truncated": resp.Truncated, "duration_ms": resp.DurationMs, "audit_id": auditID})
	return nil
}
