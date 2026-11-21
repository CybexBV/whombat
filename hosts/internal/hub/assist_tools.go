package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"rackoon/internal/assist"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// ---- the assistant's tools (ASSIST.md 4) ------------------------------------------------
//
// The CLIs call them through the runner's MCP server; they run here, with
// the hub's checks: the assistant's settings, then the host's own switches
// (hub and agent.toml), as for people.

// maxToolText bounds what one tool returns to the AI.
const maxToolText = 96 << 10

func schema(props string, required ...string) json.RawMessage {
	req, _ := json.Marshal(required)
	if len(required) == 0 {
		req = []byte("[]")
	}
	return json.RawMessage(`{"type":"object","properties":{` + props + `},"required":` + string(req) + `,"additionalProperties":false}`)
}

const hostProp = `"host":{"type":"string","description":"The host: its id or host name (see list_hosts)."}`

// assistToolDefs are the tools as the CLIs see them.
func assistToolDefs() []assist.ToolDef {
	return []assist.ToolDef{
		{Name: "list_hosts", Description: "List the monitored hosts: id, name, status, OS, platforms, open alerts, and what you may do on each (diagnose, run_command, guest_action).",
			InputSchema: schema(``)},
		{Name: "get_host", Description: "A host's current state as Rackoon's agent reports it: facts, CPU, memory, load, file systems, disks with SMART, RAID / Unraid arrays, ZFS pools, sensors, fans, UPS, system health (updates, failed units, time sync), network, guests (VMs and containers), collector errors, hints and open alerts.",
			InputSchema: schema(hostProp, "host")},
		{Name: "list_alerts", Description: "Alerts, most severe first: open ones by default, or recently resolved ones.",
			InputSchema: schema(`"host":{"type":"string","description":"Only this host (id or name)."},"state":{"type":"string","enum":["open","resolved"]},"limit":{"type":"integer","minimum":1,"maximum":200}`)},
		{Name: "get_metrics", Description: "History of a host's metrics: average, maximum (with time) and up to 60 points per series. Without series, lists the series the host has (cpu_pct, mem_pct, load1, swap_pct, net_rx_bps, disk.<dev>.*, temp.<sensor>, fs.<mount>.used_pct, ...).",
			InputSchema: schema(hostProp+`,"series":{"type":"array","items":{"type":"string"},"maxItems":12},"range":{"type":"string","enum":["1h","6h","24h","7d","30d","90d"]}`, "host")},
		{Name: "diagnose", Description: "Run one read-only check on a host through its agent and get its output. check \"list\" returns the checks this host offers with their arguments (system, processes, ports, services, service, logs, disks, smart, raid, unraid, zfs, network, sensors, docker, docker_logs, incus, libvirt, pve, ups, updates). Arguments are strings, e.g. {\"check\":\"logs\",\"args\":{\"grep\":\"sdc\",\"since\":\"2h\"}}.",
			InputSchema: schema(hostProp+`,"check":{"type":"string"},"args":{"type":"object","additionalProperties":{"type":"string"}}`, "host", "check")},
		{Name: "run_command", Description: "Run a shell command as root on a host (/bin/sh -c, no stdin) and get its exit code and output. Only where the host allows its host shell and your access level allows changes; with access \"ask\" the admin approves each command first. Prefer diagnose for reading. Explain in reason why it is needed.",
			InputSchema: schema(hostProp+`,"command":{"type":"string"},"reason":{"type":"string","description":"One sentence for the admin: why this command."},"timeout_s":{"type":"integer","minimum":1,"maximum":1800}`, "host", "command", "reason")},
		{Name: "guest_action", Description: "Start, stop or restart a VM or container on a host (actions: start, stop, shutdown, reboot, restart, force_stop, pause, resume, snapshot_create). Only where the host allows power actions and your access level allows changes; with access \"ask\" the admin approves first.",
			InputSchema: schema(hostProp+`,"guest":{"type":"string","description":"The guest: \"platform:id\" (e.g. \"docker:nginx\", \"pve:101\") or its name."},"action":{"type":"string"},"reason":{"type":"string"}`, "host", "guest", "action", "reason")},
		{Name: "finish", Description: "Record your conclusion when the investigation is complete: a short summary (cause, what you did, what is left for the admin) and whether the problem is resolved. Call it once, at the end.",
			InputSchema: schema(`"summary":{"type":"string"},"resolved":{"type":"boolean"}`, "summary", "resolved")},
	}
}

// toolCall runs one tool for an investigation and records it in the
// transcript.
func (a *assistant) toolCall(ctx context.Context, tc assist.ToolCall) assist.ToolResult {
	inv, err := a.inv(ctx, tc.Session)
	if err != nil {
		return assist.ToolResult{Text: "Unknown investigation.", IsError: true}
	}
	a.mu.Lock()
	stopping := inv.stopping
	a.mu.Unlock()
	if stopping {
		return assist.ToolResult{Text: "The admin stopped this investigation. Do not call more tools.", IsError: true}
	}
	var args map[string]any
	if err := json.Unmarshal(tc.Args, &args); err != nil || args == nil {
		args = map[string]any{}
	}
	toolID := newID("tc_")
	title, server := a.describeTool(tc.Name, args)
	a.addEvent(inv, "tool", map[string]any{"tool_id": toolID, "tool": tc.Name, "title": title, "server": server, "input": args})
	start := time.Now()
	text, isErr := a.runTool(ctx, inv, toolID, tc.Name, args)
	out, cut := clip(text, maxEventOutput, false)
	a.addEvent(inv, "tool_result", map[string]any{"tool_id": toolID, "ok": !isErr, "output": out, "truncated": cut,
		"duration_ms": time.Since(start).Milliseconds()})
	if t, c := clip(text, maxToolText, false); c {
		text = t + "\n[output truncated: narrow the request]"
	}
	return assist.ToolResult{Text: text, IsError: isErr}
}

func argStr(args map[string]any, k string) string {
	switch v := args[k].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return fmt.Sprint(v)
	case bool:
		return fmt.Sprint(v)
	}
	return ""
}

func argInt(args map[string]any, k string) int {
	if v, ok := args[k].(float64); ok && !math.IsNaN(v) {
		return int(v)
	}
	return 0
}

// describeTool is the transcript's one-line description of a call and
// the server it is about (the UI shows the host next to it).
func (a *assistant) describeTool(name string, args map[string]any) (string, any) {
	var server any
	if st := a.findHost(argStr(args, "host")); st != nil {
		server = st.ID
	}
	var t string
	switch name {
	case "list_hosts":
		t = "List the hosts"
	case "get_host":
		t = "Host state"
	case "list_alerts":
		t = "Alerts"
	case "get_metrics":
		t = "Metrics history"
	case "diagnose":
		check := argStr(args, "check")
		t = "Check " + check
		if m, ok := args["args"].(map[string]any); ok && len(m) > 0 {
			var parts []string
			for k, v := range m {
				parts = append(parts, k+"="+fmt.Sprint(v))
			}
			sort.Strings(parts)
			t += " " + strings.Join(parts, " ")
		}
	case "run_command":
		t = "Run `" + cleanText(argStr(args, "command"), 120) + "`"
	case "guest_action":
		t = strings.ReplaceAll(argStr(args, "action"), "_", " ") + " " + argStr(args, "guest")
	case "finish":
		t = "Conclusion"
	default:
		t = name
	}
	return cleanText(t, 200), server
}

// findHost resolves a server id or host name (case-insensitive).
func (a *assistant) findHost(ref string) *model.ServerState {
	if ref == "" {
		return nil
	}
	if st, ok := a.h.snapshotOne(ref); ok {
		return st
	}
	for _, st := range a.h.snapshot() {
		if strings.EqualFold(st.Hostname, ref) || strings.EqualFold(st.ID, ref) {
			return st
		}
	}
	short := strings.ToLower(strings.SplitN(ref, ".", 2)[0])
	for _, st := range a.h.snapshot() {
		if strings.ToLower(strings.SplitN(st.Hostname, ".", 2)[0]) == short {
			return st
		}
	}
	return nil
}

func jsonText(v any) string {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err.Error()
	}
	return string(b)
}

// assistPerms is what the assistant may do on a host now, with reasons.
type assistPerms struct {
	Diagnose          bool   `json:"diagnose"`
	DiagnoseReason    string `json:"diagnose_reason,omitempty"`
	RunCommand        string `json:"run_command"` // yes | with approval | no
	RunCommandReason  string `json:"run_command_reason,omitempty"`
	GuestAction       string `json:"guest_action"`
	GuestActionReason string `json:"guest_action_reason,omitempty"`
}

func (a *assistant) permsFor(st *model.ServerState, access string) assistPerms {
	var pol proto.Policy
	if st.Report != nil {
		pol = st.Report.Policy
	}
	online := st.Online(a.h.now())
	var p assistPerms
	switch {
	case !online:
		p.DiagnoseReason = "the host is offline"
	case !st.RCDiagnose:
		p.DiagnoseReason = model.ReasonHubDiag
	case !pol.Diagnose:
		p.DiagnoseReason = model.ReasonAgentDiag
	default:
		p.Diagnose = true
	}
	level := "yes"
	if access == accessAsk {
		level = "with approval"
	}
	change := func(hub, agent bool, hubReason, agentReason string) (string, string) {
		switch {
		case access == accessRead:
			return "no", "the assistant's access level is read only"
		case !online:
			return "no", "the host is offline"
		case !hub:
			return "no", hubReason
		case !agent:
			return "no", agentReason
		}
		return level, ""
	}
	p.RunCommand, p.RunCommandReason = change(st.RCHostShell, pol.HostShell, model.ReasonHubShell, model.ReasonAgentShell)
	p.GuestAction, p.GuestActionReason = change(st.RCPower, pol.Power, model.ReasonHubPower, model.ReasonAgentPower)
	return p
}

func (a *assistant) runTool(ctx context.Context, inv *liveInv, toolID, name string, args map[string]any) (string, bool) {
	access := a.getSettings().Access
	switch name {
	case "list_hosts":
		return a.toolListHosts(access), false
	case "list_alerts":
		return a.toolListAlerts(ctx, args)
	case "finish":
		summary := cleanText(argStr(args, "summary"), 4000)
		if summary == "" {
			return "Give a summary.", true
		}
		resolved, _ := args["resolved"].(bool)
		a.mu.Lock()
		inv.finishing = true
		inv.row.Summary, inv.row.Resolved = summary, &resolved
		a.mu.Unlock()
		a.save(inv)
		a.addEvent(inv, "summary", map[string]any{"text": summary, "resolved": resolved})
		return "Recorded. End your turn now with a short closing message (no more tool calls).", false
	}
	st := a.findHost(argStr(args, "host"))
	if st == nil {
		return "No such host: use an id or a host name from list_hosts.", true
	}
	switch name {
	case "get_host":
		return a.toolGetHost(st, access), false
	case "get_metrics":
		return a.toolMetrics(ctx, st, args)
	case "diagnose":
		return a.toolDiagnose(ctx, inv, st, args)
	case "run_command":
		return a.toolRunCommand(ctx, inv, toolID, st, args, access)
	case "guest_action":
		return a.toolGuestAction(ctx, inv, toolID, st, args, access)
	}
	return "Unknown tool " + name + ".", true
}

func (a *assistant) toolListHosts(access string) string {
	now := a.h.now()
	type hostJSON struct {
		ID         string      `json:"id"`
		Name       string      `json:"name"`
		Status     string      `json:"status"`
		Group      string      `json:"group,omitempty"`
		OS         string      `json:"os,omitempty"`
		Address    string      `json:"address,omitempty"`
		Platforms  []string    `json:"platforms,omitempty"`
		Guests     int         `json:"guests"`
		OpenAlerts int         `json:"open_alerts"`
		Parent     string      `json:"runs_on,omitempty"`
		Assistant  assistPerms `json:"assistant_may"`
	}
	var out []hostJSON
	for _, st := range a.h.snapshot() {
		fs := model.BuildFleetServer(st, now)
		h := hostJSON{ID: st.ID, Name: st.Hostname, Status: fs.Status, Group: st.Group, Address: st.Address,
			OpenAlerts: len(st.Open), Parent: st.Parent, Assistant: a.permsFor(st, access)}
		if r := st.Report; r != nil {
			h.OS = r.Host.OSPretty
			for _, p := range []struct {
				name string
				on   bool
			}{{"docker", r.Docker != nil}, {"incus", r.Incus != nil}, {"libvirt", r.Libvirt != nil}, {"proxmox", r.PVE != nil}} {
				if p.on {
					h.Platforms = append(h.Platforms, p.name)
				}
			}
			h.Guests = len(r.AllGuests())
			for _, a := range r.RAID {
				if a.Level == "unraid" {
					h.Platforms = append(h.Platforms, "unraid")
				}
			}
		}
		out = append(out, h)
	}
	return jsonText(map[string]any{"access_level": access, "hosts": out})
}

func (a *assistant) toolListAlerts(ctx context.Context, args map[string]any) (string, bool) {
	var host *model.ServerState
	if ref := argStr(args, "host"); ref != "" {
		if host = a.findHost(ref); host == nil {
			return "No such host.", true
		}
	}
	limit := argInt(args, "limit")
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var list []rules.Alert
	if argStr(args, "state") == "resolved" {
		l, err := a.h.store.ListAlerts(ctx, rules.AlertResolved, 500)
		if err != nil {
			return err.Error(), true
		}
		list = l
	} else {
		list = a.h.alerts.AllOpen()
	}
	var out []model.Alert
	for _, al := range list {
		if host != nil && al.Server != host.ID {
			continue
		}
		out = append(out, a.h.buildAlert(al))
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		return "No alerts.", false
	}
	return jsonText(out), false
}

// toolGetHost is a host's report, compacted for the AI.
func (a *assistant) toolGetHost(st *model.ServerState, access string) string {
	now := a.h.now()
	out := map[string]any{"id": st.ID, "name": st.Hostname, "status": model.BuildFleetServer(st, now).Status,
		"last_seen": st.LastSeen.UTC().Format(time.RFC3339), "agent_version": st.AgentVersion, "group": st.Group,
		"assistant_may": a.permsFor(st, access)}
	if st.Parent != "" {
		out["runs_on"] = st.Parent
	}
	var alerts []model.Alert
	for _, al := range st.Open {
		alerts = append(alerts, model.BuildAlertFor(al, st, now))
	}
	out["open_alerts"] = alerts
	d := model.BuildDetail(st, now, model.DetailInput{Range: "24h", RoleRank: store.RoleRank(store.RoleAdmin), HubVersion: Version})
	out["hints"] = d.Hints
	r := st.Report
	if r == nil {
		out["report"] = "The agent has not reported yet."
		return jsonText(out)
	}
	out["report_at"] = st.ReportAt.UTC().Format(time.RFC3339)
	out["host"] = r.Host
	out["cpu"] = r.CPU
	out["memory"] = r.Memory
	out["pressure"] = r.Pressure
	out["filesystems"] = r.Filesystems
	out["disks"] = r.Disks
	out["pools"] = r.Pools
	out["raid"] = r.RAID
	out["sensors"] = r.Sensors
	out["fans"] = r.Fans
	out["ups"] = r.UPS
	out["gpus"] = r.GPUs
	out["system"] = r.System
	out["network"] = r.Net
	var failing []proto.CollectorStatus
	for _, c := range r.Collectors {
		if c.Error != "" {
			failing = append(failing, c)
		}
	}
	out["collector_errors"] = failing
	type guestJSON struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Kind    string   `json:"kind"`
		State   string   `json:"state"`
		Image   string   `json:"image,omitempty"`
		CPUPct  *float64 `json:"cpu_pct,omitempty"`
		MemMiB  *uint64  `json:"mem_used_mib,omitempty"`
		Health  string   `json:"health,omitempty"`
		Restart *int     `json:"restarts,omitempty"`
	}
	var guests []guestJSON
	for _, g := range r.AllGuests() {
		if len(guests) >= 300 {
			break
		}
		j := guestJSON{ID: g.Platform + ":" + g.Guest.ID, Name: g.Guest.Name, Kind: g.Guest.Kind, State: g.Guest.State,
			Image: g.Guest.Image, CPUPct: g.Guest.CPUPct, Health: g.Guest.HealthCheckText, Restart: g.Guest.RestartCount}
		if m := g.Guest.MemUsedBytes; m != nil {
			v := *m >> 20
			j.MemMiB = &v
		}
		guests = append(guests, j)
	}
	out["guests"] = guests
	platforms := map[string]any{}
	for name, p := range map[string]*proto.Platform{"docker": r.Docker, "incus": r.Incus, "libvirt": r.Libvirt} {
		if p != nil {
			platforms[name] = map[string]any{"version": p.Version, "error": p.Error, "warnings": p.Warnings}
		}
	}
	if r.PVE != nil {
		platforms["proxmox"] = map[string]any{"node": r.PVE.Node, "error": r.PVE.Error, "cluster": r.PVE.Cluster,
			"storages": r.PVE.Storages, "backups": r.PVE.Backups, "replication": r.PVE.Replication, "ceph": r.PVE.Ceph}
	}
	out["platforms"] = platforms
	return jsonText(out)
}

func (a *assistant) toolMetrics(ctx context.Context, st *model.ServerState, args map[string]any) (string, bool) {
	rng := argStr(args, "range")
	if rng == "" {
		rng = "24h"
	}
	spec, ok := store.Ranges[rng]
	if !ok {
		return "range must be one of 1h, 6h, 24h, 7d, 30d, 90d.", true
	}
	var names []string
	if l, ok := args["series"].([]any); ok {
		for _, v := range l {
			if s, ok := v.(string); ok && s != "" && len(names) < 12 {
				names = append(names, s)
			}
		}
	}
	if len(names) == 0 {
		ids, err := a.h.store.SeriesNames(ctx, st.ID)
		if err != nil {
			return err.Error(), true
		}
		var all []string
		for n := range ids {
			all = append(all, n)
		}
		sort.Strings(all)
		return "Series of " + st.Hostname + ": " + strings.Join(all, ", "), false
	}
	res, err := a.h.store.QueryMetrics(ctx, st.ID, names, spec, a.h.now())
	if err != nil {
		return err.Error(), true
	}
	ends := res.Grid.Ends()
	type seriesJSON struct {
		Avg    *float64 `json:"avg"`
		Max    *float64 `json:"max"`
		MaxAt  string   `json:"max_at,omitempty"`
		Points [][2]any `json:"points"`
	}
	out := map[string]any{"host": st.Hostname, "range": rng}
	series := map[string]seriesJSON{}
	for _, n := range names {
		var sj seriesJSON
		if s := res.Summary[n]; s != nil {
			avg, mx := s.Avg, s.Max
			sj.Avg, sj.Max = &avg, &mx
			if !s.MaxAt.IsZero() {
				sj.MaxAt = s.MaxAt.UTC().Format(time.RFC3339)
			}
		}
		vals := res.Series[n]
		step := max(1, (len(vals)+59)/60)
		for i := 0; i < len(vals); i += step {
			var sum float64
			var cnt int
			for j := i; j < min(i+step, len(vals)); j++ {
				if vals[j] != nil {
					sum += *vals[j]
					cnt++
				}
			}
			if cnt == 0 {
				continue
			}
			end := min(i+step, len(vals)) - 1
			sj.Points = append(sj.Points, [2]any{ends[end].UTC().Format(time.RFC3339), math.Round(sum/float64(cnt)*100) / 100})
		}
		series[n] = sj
	}
	out["series"] = series
	return jsonText(out), false
}

func (a *assistant) toolDiagnose(ctx context.Context, inv *liveInv, st *model.ServerState, args map[string]any) (string, bool) {
	p := a.permsFor(st, accessRead)
	if !p.Diagnose {
		return "Diagnostics are not available on " + st.Hostname + ": " + p.DiagnoseReason + ".", true
	}
	conn := a.h.conn(st.ID)
	if conn == nil {
		return st.Hostname + "'s agent is not connected.", true
	}
	req := proto.DiagnoseRequest{Check: argStr(args, "check"), Args: map[string]string{}}
	if m, ok := args["args"].(map[string]any); ok {
		for k, v := range m {
			req.Args[k] = fmt.Sprint(v)
		}
	}
	if req.Check == "" {
		return "Name a check (check \"list\" lists them).", true
	}
	resp, err := conn.Diagnose(ctx, req)
	if err != nil {
		return st.Hostname + "'s agent did not answer: " + err.Error(), true
	}
	if req.Check == proto.DiagnoseList && resp.Code == "" {
		return jsonText(resp.Checks), false
	}
	var b strings.Builder
	if len(resp.Commands) > 0 {
		b.WriteString("Ran: " + strings.Join(resp.Commands, "; ") + "\n\n")
	}
	b.WriteString(resp.Output)
	if resp.Truncated {
		b.WriteString("\n[the agent truncated the output]")
	}
	switch resp.Code {
	case "":
		return b.String(), false
	case "remote_control_disabled":
		return "Diagnostics are turned off in " + st.Hostname + "'s agent.toml ([remote_control] diagnose).", true
	default:
		msg := resp.Code
		if resp.Message != "" {
			msg += ": " + resp.Message
		}
		if resp.Output != "" {
			msg += "\n\n" + b.String()
		}
		return msg, true
	}
}

// approve asks the admin (access "ask") and tells whether to go ahead; a
// refusal is the text for the AI.
func (a *assistant) approve(ctx context.Context, inv *liveInv, toolID, server, action, command, reason, access string) (bool, string) {
	if access != accessAsk {
		return true, ""
	}
	d := a.requestApproval(ctx, inv, toolID, server, action, command, cleanText(reason, 500))
	switch {
	case d.Approve:
		return true, ""
	case d.Expired:
		return false, "Nobody approved this in time (or the investigation was stopped). It did not run."
	}
	msg := "The admin declined this. It did not run."
	if d.Reply != "" {
		msg += " Their reply: " + d.Reply
	}
	return false, msg
}

func (a *assistant) toolRunCommand(ctx context.Context, inv *liveInv, toolID string, st *model.ServerState, args map[string]any, access string) (string, bool) {
	p := a.permsFor(st, access)
	if p.RunCommand == "no" {
		return "You may not run commands on " + st.Hostname + ": " + p.RunCommandReason + ". Use diagnose, or tell the admin what to run.", true
	}
	command := argStr(args, "command")
	if command == "" || len(command) > 16<<10 || strings.ContainsRune(command, 0) {
		return "Give a command (at most 16 KiB).", true
	}
	timeout := argInt(args, "timeout_s")
	if timeout <= 0 {
		timeout = 120
	}
	timeout = min(timeout, 1800)
	if ok, why := a.approve(ctx, inv, toolID, st.ID, "command", command, argStr(args, "reason"), access); !ok {
		return why, true
	}
	conn := a.h.conn(st.ID)
	if conn == nil {
		return st.Hostname + "'s agent is not connected.", true
	}
	resp, err := conn.Exec(ctx, proto.ExecRequest{Command: command, TimeoutS: timeout})
	rec := store.AuditRecord{Event: "assistant.command", Outcome: "ok", User: "assistant (" + inv.row.CreatedBy + ")", Server: st.ID,
		Details: map[string]string{"investigation": inv.row.ID, "command": cleanText(command, 500), "exit_code": fmt.Sprint(resp.ExitCode)}}
	if err != nil || resp.Code != "" {
		rec.Outcome = "error"
	}
	a.h.auditSystem(context.Background(), rec)
	if err != nil {
		return st.Hostname + "'s agent did not answer: " + err.Error(), true
	}
	if resp.Code != "" {
		if resp.Code == "remote_control_disabled" {
			return "The host shell is turned off in " + st.Hostname + "'s agent.toml.", true
		}
		return resp.Code + ": " + resp.Message, true
	}
	head := fmt.Sprintf("exit code %d · %.1f s", resp.ExitCode, float64(resp.DurationMs)/1000)
	if resp.TimedOut {
		head += " · killed after the timeout"
	}
	if resp.Truncated {
		head += " · only the end of the output is kept"
	}
	return head + "\n\n" + resp.Output, resp.ExitCode != 0 || resp.TimedOut
}

func (a *assistant) toolGuestAction(ctx context.Context, inv *liveInv, toolID string, st *model.ServerState, args map[string]any, access string) (string, bool) {
	p := a.permsFor(st, access)
	if p.GuestAction == "no" {
		return "You may not change guests on " + st.Hostname + ": " + p.GuestActionReason + ".", true
	}
	action := argStr(args, "action")
	ref := argStr(args, "guest")
	g, ok := findGuest(st, ref)
	if !ok && st.Report != nil {
		var matches []proto.PlatformGuest
		for _, pg := range st.Report.AllGuests() {
			if strings.EqualFold(pg.Guest.Name, ref) || strings.EqualFold(pg.Guest.ID, ref) {
				matches = append(matches, pg)
			}
		}
		if len(matches) > 1 {
			return "Several guests are called " + ref + ": use \"platform:id\".", true
		}
		if len(matches) == 1 {
			g, ok = matches[0], true
		}
	}
	if !ok {
		return "No guest " + ref + " on " + st.Hostname + " (see get_host).", true
	}
	allowed := containerActions
	if g.Guest.Kind == "vm" {
		allowed = vmActions
	}
	if !allowed[action] || action == proto.ActionCtrlAltDel || action == proto.ActionSnapshotRestore || action == proto.ActionSnapshotDelete ||
		(g.Platform == proto.PlatformDocker && snapshotActions[action]) {
		var l []string
		for k := range allowed {
			if k != proto.ActionCtrlAltDel && k != proto.ActionSnapshotRestore && k != proto.ActionSnapshotDelete {
				l = append(l, k)
			}
		}
		sort.Strings(l)
		return "Action " + action + " does not apply to this guest; use one of " + strings.Join(l, ", ") + ".", true
	}
	if selfActionRefusal(g, action) != nil {
		return selfMessage + " " + action + " is refused for the guest the hosts service runs in.", true
	}
	gid := g.Platform + ":" + g.Guest.ID
	if ok, why := a.approve(ctx, inv, toolID, st.ID, "guest_action", action+" "+gid+" ("+g.Guest.Name+")", argStr(args, "reason"), access); !ok {
		return why, true
	}
	conn := a.h.conn(st.ID)
	if conn == nil {
		return st.Hostname + "'s agent is not connected.", true
	}
	key := st.ID + "|" + gid
	if !a.h.actions.begin(key, toolID) {
		return "Another action on this guest is still running.", true
	}
	defer a.h.actions.end(key)
	req := proto.ActionRequest{Platform: g.Platform, GuestID: g.Guest.ID, Action: action}
	if action == proto.ActionSnapshotCreate {
		req.Args = map[string]string{proto.ArgSnapshot: "rackoon-assistant-" + a.h.now().UTC().Format("20060102-150405")}
	}
	resp, err := conn.Action(ctx, req)
	rec := store.AuditRecord{Event: "assistant.action", Outcome: "ok", User: "assistant (" + inv.row.CreatedBy + ")", Server: st.ID,
		Guest: gid, Platform: g.Platform, Details: map[string]string{"investigation": inv.row.ID, "action": action}}
	if err != nil || !resp.OK {
		rec.Outcome = "error"
	}
	a.h.auditSystem(context.Background(), rec)
	if err != nil {
		return "The agent did not answer: " + err.Error(), true
	}
	if !resp.OK {
		return "The action failed: " + resp.Code + " " + resp.Message, true
	}
	a.h.bus.Publish("guest.state_changed", map[string]string{"server": st.ID, "id": gid, "state": resp.State})
	msg := "Done: " + action + " " + g.Guest.Name
	if resp.State != "" {
		msg += " · state " + resp.State
	}
	if resp.Noop {
		msg += " (it already was)"
	}
	return msg, false
}
