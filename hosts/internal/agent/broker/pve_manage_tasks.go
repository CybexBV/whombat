package broker

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Choices, tasks, firewall, HA and replication on Proxmox VE
// (docs/MANAGE.md 2.3).

// ---- choices ----------------------------------------------------------------------

// thinStorage reports whether volumes on a storage take space as they are
// written (file storages: qcow2).
func thinStorage(typ string, sparse bool) bool {
	switch typ {
	case "lvmthin", "rbd", "dir", "nfs", "cifs":
		return true
	case "zfspool":
		return sparse
	}
	return false
}

func (r *pveReq) choices(ctx context.Context) (proto.ManageResponse, error) {
	info, err := r.nodeInfo(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	ch := &proto.Choices{Platform: proto.PlatformPVE, Node: r.node, Storages: []proto.ChoiceStorage{}, Bridges: []string{}}
	ch.Bridges = append(ch.Bridges, info.bridges...)

	// The storage configuration has "sparse" (zfspool); without it no
	// storage counts as thin except by type.
	var cfgs []struct {
		Storage string   `json:"storage"`
		Sparse  pveValue `json:"sparse"`
	}
	_ = r.api.get(ctx, "/storage", nil, &cfgs)
	sparse := map[string]bool{}
	for _, c := range cfgs {
		sparse[c.Storage] = c.Sparse.bool()
	}
	ids := make([]string, 0, len(info.storages))
	for id, s := range info.storages {
		if s.usable() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		s := info.storages[id]
		ch.Storages = append(ch.Storages, proto.ChoiceStorage{ID: id, Type: s.Type, Content: s.contents(),
			AvailBytes: s.Avail.uint(), TotalBytes: s.Total.uint(), Shared: s.Shared.bool(), Thin: thinStorage(s.Type, sparse[id])})
	}
	for _, content := range []string{"iso", "vztmpl"} {
		for _, s := range info.withContent(content) {
			items, err := r.content(ctx, s.ID, url.Values{"content": {content}})
			if err != nil {
				continue // an unreachable storage offers nothing
			}
			vols := storageVolumes(s.ID, content, items)
			if content == "iso" {
				ch.ISOs = append(ch.ISOs, vols...)
			} else {
				ch.CTTemplates = append(ch.CTTemplates, vols...)
			}
		}
	}

	var res []struct {
		VMID     pveValue `json:"vmid"`
		Name     string   `json:"name"`
		Type     string   `json:"type"`
		Node     string   `json:"node"`
		Template pveValue `json:"template"`
		MaxDisk  pveValue `json:"maxdisk"`
	}
	if err := r.api.get(ctx, "/cluster/resources", url.Values{"type": {"vm"}}, &res); err != nil {
		return proto.ManageResponse{}, err
	}
	for _, g := range res {
		if !g.Template.bool() || g.Node != r.node {
			continue
		}
		kind := "vm"
		if g.Type == "lxc" {
			kind = "container"
		}
		ch.Templates = append(ch.Templates, proto.TemplateGuest{ID: string(g.VMID), Name: g.Name, Kind: kind, Node: g.Node, DiskBytes: g.MaxDisk.uint()})
	}
	sort.Slice(ch.Templates, func(i, j int) bool { return ch.Templates[i].ID < ch.Templates[j].ID })

	var next pveValue
	if err := r.api.get(ctx, "/cluster/nextid", nil, &next); err == nil {
		ch.NextID = next.int()
	}
	var cpus []struct {
		Name string `json:"name"`
	}
	if err := r.api.get(ctx, r.nodePath()+"/capabilities/qemu/cpu", nil, &cpus); err == nil {
		for _, c := range cpus {
			ch.CPUTypes = append(ch.CPUTypes, c.Name)
		}
		sort.Strings(ch.CPUTypes)
	}
	if cluster, nodes, err := r.cluster(ctx); err == nil {
		ch.Cluster, ch.Nodes = cluster, nodes
	}
	// content.download needs Sys.AccessNetwork on this node (provisioned
	// on PVE 8.3 and later).
	var perms map[string]map[string]pveValue
	if err := r.api.get(ctx, "/access/permissions", url.Values{"path": {"/nodes/" + r.node}}, &perms); err == nil {
		_, ch.Download = perms["/nodes/"+r.node]["Sys.AccessNetwork"]
	}
	return proto.ManageResponse{OK: true, Choices: ch}, nil
}

// ---- tasks ------------------------------------------------------------------------

// pveTaskEntry is an entry of /nodes/{node}/tasks (and .../status).
type pveTaskEntry struct {
	UPID       string   `json:"upid"`
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	User       string   `json:"user"`
	StartTime  int64    `json:"starttime"`
	EndTime    int64    `json:"endtime"`
	Status     string   `json:"status"`     // list: exit status; status: running | stopped
	ExitStatus string   `json:"exitstatus"` // status only
	PID        pveValue `json:"pid"`
}

// taskState normalizes an exit status: ok, warning ("WARNINGS: n") or
// error (the error text).
func taskState(exit string) string {
	switch {
	case exit == "OK":
		return "ok"
	case strings.HasPrefix(exit, "WARNINGS"):
		return "warning"
	}
	return "error"
}

func (t pveTaskEntry) status() proto.TaskStatus {
	ts := proto.TaskStatus{ID: t.UPID, Type: t.Type, User: t.User, Started: time.Unix(t.StartTime, 0).UTC()}
	if vmidRe.MatchString(t.ID) {
		ts.GuestID = t.ID
	}
	if t.EndTime == 0 || t.Status == "" || t.Status == "running" {
		ts.Status = "running"
		return ts
	}
	end := time.Unix(t.EndTime, 0).UTC()
	ts.Ended, ts.Status, ts.Message = &end, taskState(t.Status), t.Status
	return ts
}

func (r *pveReq) taskList(ctx context.Context) (proto.ManageResponse, error) {
	q := url.Values{"limit": {"50"}, "source": {"all"}}
	if r.g != nil {
		q.Set("vmid", r.g.ID)
	}
	var items []pveTaskEntry
	if err := r.api.get(ctx, r.nodePath()+"/tasks", q, &items); err != nil {
		return proto.ManageResponse{}, err
	}
	out := make([]proto.TaskStatus, 0, len(items))
	for _, t := range items {
		out = append(out, t.status())
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
	return proto.ManageResponse{OK: true, Tasks: out}, nil
}

// upid validates the request's task id: a UPID of this node.
func (r *pveReq) upid() (pveUPID, error) {
	u, ok := parseUPID(r.req.Task)
	if !ok {
		return u, fieldErr(CodeInvalid, "task", "not a Proxmox VE task id")
	}
	if u.Node != r.node {
		return u, codeErr(CodeUnsupported, "the task runs on node "+u.Node+"; open it through that node's agent")
	}
	return u, nil
}

func (r *pveReq) taskPath() string {
	return r.nodePath() + "/tasks/" + url.PathEscape(r.req.Task)
}

// taskLogLimit is the most log lines one task.status returns.
const taskLogLimit = 500

func (r *pveReq) taskStatus(ctx context.Context) (proto.ManageResponse, error) {
	u, err := r.upid()
	if err != nil {
		return proto.ManageResponse{}, err
	}
	var st pveTaskEntry
	if err := r.api.get(ctx, r.taskPath()+"/status", nil, &st); err != nil {
		return proto.ManageResponse{}, err
	}
	ts := proto.TaskStatus{ID: r.req.Task, Type: u.Type, User: u.User, Started: u.Start}
	if vmidRe.MatchString(u.ID) {
		ts.GuestID = u.ID
	}
	if st.Status == "running" {
		ts.Status = "running"
	} else {
		ts.Status, ts.Message = taskState(st.ExitStatus), st.ExitStatus
		ts.Ended = r.taskEnd(ctx, u)
	}
	if r.req.LogStart >= 0 {
		start := r.req.LogStart
		var lines []struct {
			N int    `json:"n"`
			T string `json:"t"`
		}
		q := url.Values{"start": {strconv.Itoa(start)}, "limit": {strconv.Itoa(taskLogLimit)}}
		if err := r.api.get(ctx, r.taskPath()+"/log", q, &lines); err != nil {
			return proto.ManageResponse{}, err
		}
		// PVE answers an empty log with one line "no content".
		if start == 0 && len(lines) == 1 && lines[0].T == "no content" {
			lines = nil
		}
		ts.LogNext = start
		for _, l := range lines {
			ts.Log = append(ts.Log, l.T)
			if l.N > ts.LogNext {
				ts.LogNext = l.N // n is the 1-based line number: the next start
			}
		}
		if ts.Status == "running" && len(ts.Log) > 0 {
			ts.Message = ts.Log[len(ts.Log)-1]
		}
	}
	return proto.ManageResponse{OK: true, TaskStatus: &ts}, nil
}

// taskEnd looks up when a finished task ended (the status call does not
// say); nil when it is not found.
func (r *pveReq) taskEnd(ctx context.Context, u pveUPID) *time.Time {
	q := url.Values{"source": {"all"}, "typefilter": {u.Type}, "since": {strconv.FormatInt(u.Start.Unix(), 10)}, "limit": {"50"}}
	if vmidRe.MatchString(u.ID) {
		q.Set("vmid", u.ID)
	}
	var items []pveTaskEntry
	if err := r.api.get(ctx, r.nodePath()+"/tasks", q, &items); err != nil {
		return nil
	}
	for _, t := range items {
		if t.UPID == r.req.Task && t.EndTime > 0 {
			end := time.Unix(t.EndTime, 0).UTC()
			return &end
		}
	}
	return nil
}

func (r *pveReq) taskStop(ctx context.Context) (proto.ManageResponse, error) {
	if _, err := r.upid(); err != nil {
		return proto.ManageResponse{}, err
	}
	if err := r.api.delete(ctx, r.taskPath(), nil, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// ---- firewall ---------------------------------------------------------------------

func (r *pveReq) firewallPath() string { return r.guestPath() + "/firewall" }

// pveRule is an entry of .../firewall/rules.
type pveRule struct {
	Pos     int      `json:"pos"`
	Type    string   `json:"type"`
	Action  string   `json:"action"`
	Enable  pveValue `json:"enable"`
	Macro   string   `json:"macro"`
	Proto   string   `json:"proto"`
	Source  string   `json:"source"`
	Dest    string   `json:"dest"`
	SPort   string   `json:"sport"`
	DPort   string   `json:"dport"`
	Iface   string   `json:"iface"`
	Log     string   `json:"log"`
	Comment string   `json:"comment"`
	Digest  string   `json:"digest"`
}

func (r *pveReq) securityGroups(ctx context.Context) ([]string, error) {
	var groups []struct {
		Group string `json:"group"`
	}
	if err := r.api.get(ctx, "/cluster/firewall/groups", nil, &groups); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(groups))
	for _, g := range groups {
		out = append(out, g.Group)
	}
	sort.Strings(out)
	return out, nil
}

func (r *pveReq) firewallGet(ctx context.Context) (proto.ManageResponse, error) {
	var opts map[string]pveValue
	if err := r.api.get(ctx, r.firewallPath()+"/options", nil, &opts); err != nil {
		return proto.ManageResponse{}, err
	}
	var rules []pveRule
	if err := r.api.get(ctx, r.firewallPath()+"/rules", nil, &rules); err != nil {
		return proto.ManageResponse{}, err
	}
	fw := &proto.GuestFirewall{Options: map[string]string{}, OptionsDigest: string(opts["digest"]), Rules: []proto.FirewallRule{}}
	for k, v := range opts {
		if _, ok := pveFirewallOptions[k]; ok {
			fw.Options[k] = string(v)
		}
	}
	for _, x := range rules {
		fw.Rules = append(fw.Rules, proto.FirewallRule{Pos: x.Pos, Type: x.Type, Action: x.Action, Enable: x.Enable.bool(),
			Macro: x.Macro, Proto: x.Proto, Source: x.Source, Dest: x.Dest, SPort: x.SPort, DPort: x.DPort,
			Iface: x.Iface, Log: x.Log, Comment: x.Comment})
		if fw.RulesDigest == "" {
			fw.RulesDigest = x.Digest
		}
	}
	sort.SliceStable(fw.Rules, func(i, j int) bool { return fw.Rules[i].Pos < fw.Rules[j].Pos })
	groups, err := r.securityGroups(ctx)
	if err != nil && apiStatus(err) != http.StatusForbidden {
		return proto.ManageResponse{}, err
	}
	fw.Groups = groups
	var cluster struct {
		Enable pveValue `json:"enable"`
	}
	if err := r.api.get(ctx, "/cluster/firewall/options", nil, &cluster); err != nil && apiStatus(err) != http.StatusForbidden {
		return proto.ManageResponse{}, err
	}
	fw.ClusterEnabled = cluster.Enable.bool()
	return proto.ManageResponse{OK: true, Firewall: fw}, nil
}

func (r *pveReq) firewallOptions(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	if len(req.Set)+len(req.Delete) == 0 {
		return proto.ManageResponse{}, codeErr(CodeInvalid, "nothing to change")
	}
	params := url.Values{}
	for _, k := range sortedKeys(req.Set) {
		if err := checkFirewallOption(k, req.Set[k]); err != nil {
			return proto.ManageResponse{}, err
		}
		params.Set(k, req.Set[k])
	}
	for _, k := range req.Delete {
		if _, ok := pveFirewallOptions[k]; !ok {
			return proto.ManageResponse{}, fieldErr(proto.CodeNotAllowed, k, "not a firewall option Whombat changes")
		}
		if _, ok := req.Set[k]; ok {
			return proto.ManageResponse{}, fieldErr(CodeInvalid, k, "the key is named more than once")
		}
	}
	if len(req.Delete) > 0 {
		params.Set("delete", strings.Join(slices.Sorted(slices.Values(req.Delete)), ","))
	}
	if req.Digest != "" {
		params.Set("digest", req.Digest)
	}
	if err := r.api.put(ctx, r.firewallPath()+"/options", params, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// ruleParams are a rule's API parameters; for an update, empty optional
// fields are deleted.
func ruleParams(x *proto.FirewallRule, update bool) url.Values {
	p := url.Values{"type": {x.Type}, "action": {x.Action}, "enable": {boolParam(x.Enable)}}
	var del []string
	for _, f := range []struct{ key, v string }{{"macro", x.Macro}, {"proto", x.Proto}, {"source", x.Source},
		{"dest", x.Dest}, {"sport", x.SPort}, {"dport", x.DPort}, {"iface", x.Iface}, {"log", x.Log}, {"comment", x.Comment}} {
		switch {
		case f.v != "":
			p.Set(f.key, f.v)
		case update:
			del = append(del, f.key)
		}
	}
	if len(del) > 0 {
		p.Set("delete", strings.Join(del, ","))
	}
	return p
}

// checkRule validates the request's rule.
func (r *pveReq) checkRule(ctx context.Context) error {
	x := r.req.Rule
	if x == nil {
		return fieldErr(CodeInvalid, "rule", "a rule is required")
	}
	var groups []string
	if x.Type == "group" {
		var err error
		if groups, err = r.securityGroups(ctx); err != nil {
			return err
		}
	}
	return checkFirewallRule(x, groups)
}

// rulePos validates a rule position.
func rulePos(p *int, key string) (string, error) {
	if p == nil || *p < 0 || *p > 9999 {
		return "", fieldErr(CodeInvalid, key, "a rule position (0-9999) is required")
	}
	return strconv.Itoa(*p), nil
}

func (r *pveReq) firewallRuleAdd(ctx context.Context) (proto.ManageResponse, error) {
	if err := r.checkRule(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	params := ruleParams(r.req.Rule, false)
	if r.req.Rule.Pos > 0 {
		pos, err := rulePos(&r.req.Rule.Pos, "pos")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		params.Set("pos", pos)
	}
	if r.req.Digest != "" {
		params.Set("digest", r.req.Digest)
	}
	if err := r.api.post(ctx, r.firewallPath()+"/rules", params, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

func (r *pveReq) firewallRuleUpdate(ctx context.Context) (proto.ManageResponse, error) {
	pos, err := rulePos(r.req.Pos, "pos")
	if err != nil {
		return proto.ManageResponse{}, err
	}
	var params url.Values
	if r.req.MoveTo != nil {
		to, err := rulePos(r.req.MoveTo, "move_to")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		params = url.Values{"moveto": {to}}
	} else {
		if err := r.checkRule(ctx); err != nil {
			return proto.ManageResponse{}, err
		}
		params = ruleParams(r.req.Rule, true)
	}
	if r.req.Digest != "" {
		params.Set("digest", r.req.Digest)
	}
	if err := r.api.put(ctx, r.firewallPath()+"/rules/"+pos, params, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

func (r *pveReq) firewallRuleDelete(ctx context.Context) (proto.ManageResponse, error) {
	pos, err := rulePos(r.req.Pos, "pos")
	if err != nil {
		return proto.ManageResponse{}, err
	}
	q := url.Values{}
	if r.req.Digest != "" {
		q.Set("digest", r.req.Digest)
	}
	if err := r.api.delete(ctx, r.firewallPath()+"/rules/"+pos, q, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// ---- HA ---------------------------------------------------------------------------

// haSID is the guest's HA resource id.
func (r *pveReq) haSID() string {
	if r.vm() {
		return "vm:" + r.g.ID
	}
	return "ct:" + r.g.ID
}

type pveHAResource struct {
	State       string `json:"state"`
	MaxRestart  *int   `json:"max_restart"`
	MaxRelocate *int   `json:"max_relocate"`
	Comment     string `json:"comment"`
}

// haResource returns the guest's HA resource (nil: none).
func (r *pveReq) haResource(ctx context.Context) (*pveHAResource, error) {
	var res pveHAResource
	if err := r.api.get(ctx, "/cluster/ha/resources/"+url.PathEscape(r.haSID()), nil, &res); err != nil {
		if apiStatus(err) == http.StatusNotFound || strings.Contains(err.Error(), "no such resource") {
			return nil, nil
		}
		return nil, err
	}
	return &res, nil
}

// haState is the guest's HA settings and the HA manager's state of it
// (nil: not an HA resource, or unreadable).
func (r *pveReq) haState(ctx context.Context) *proto.HAState {
	res, err := r.haResource(ctx)
	if err != nil || res == nil {
		return nil
	}
	hs := &proto.HAState{HASettings: proto.HASettings{State: res.State, MaxRestart: res.MaxRestart, MaxRelocate: res.MaxRelocate, Comment: res.Comment}}
	var status []struct {
		Type  string `json:"type"`
		SID   string `json:"sid"`
		State string `json:"state"`
	}
	if r.api.get(ctx, "/cluster/ha/status/current", nil, &status) == nil {
		for _, s := range status {
			if s.Type == "service" && s.SID == r.haSID() {
				hs.Status = s.State
			}
		}
	}
	return hs
}

// haManager runs ha-manager as root (its API needs Sys.Console on /,
// which the manage token does not have).
func (r *pveReq) haManager(ctx context.Context, args ...string) error {
	if _, err := r.run(ctx, append([]string{"ha-manager"}, args...)...); err != nil {
		msg := err.Error()
		if strings.Contains(msg, "no such resource") {
			return codeErr(proto.CodeNotFound, msg)
		}
		return codeErr(CodePlatformError, msg)
	}
	return nil
}

func (r *pveReq) haSet(ctx context.Context) (proto.ManageResponse, error) {
	if _, err := r.requireCluster(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	ha := r.req.HA
	switch {
	case ha == nil:
		return proto.ManageResponse{}, fieldErr(CodeInvalid, "ha", "HA settings are required")
	case !slices.Contains(haStates, ha.State):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "state", "must be one of "+strings.Join(haStates, ", "))
	case ha.MaxRestart != nil && (*ha.MaxRestart < 0 || *ha.MaxRestart > 10):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "max_restart", "must be 0-10")
	case ha.MaxRelocate != nil && (*ha.MaxRelocate < 0 || *ha.MaxRelocate > 10):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "max_relocate", "must be 0-10")
	case len(ha.Comment) > 4096 || checkText("comment", ha.Comment, false) != nil:
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "comment", "must be one line of text")
	}
	cur, err := r.haResource(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	verb := "add"
	if cur != nil {
		verb = "set"
	}
	// --key=value: a value starting with "-" stays a value.
	args := []string{verb, r.haSID(), "--state=" + ha.State}
	if ha.MaxRestart != nil {
		args = append(args, "--max_restart="+strconv.Itoa(*ha.MaxRestart))
	}
	if ha.MaxRelocate != nil {
		args = append(args, "--max_relocate="+strconv.Itoa(*ha.MaxRelocate))
	}
	switch {
	case ha.Comment != "":
		args = append(args, "--comment="+ha.Comment)
	case cur != nil && cur.Comment != "":
		args = append(args, "--delete=comment")
	}
	if err := r.haManager(ctx, args...); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

func (r *pveReq) haRemove(ctx context.Context) (proto.ManageResponse, error) {
	if _, err := r.requireCluster(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	cur, err := r.haResource(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if cur == nil {
		return proto.ManageResponse{}, codeErr(proto.CodeNotFound, "the guest is not an HA resource")
	}
	if err := r.haManager(ctx, "remove", r.haSID()); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// ---- replication ------------------------------------------------------------------

type pveReplJob struct {
	ID       string   `json:"id"`
	Guest    pveValue `json:"guest"`
	Target   string   `json:"target"`
	Schedule string   `json:"schedule"`
	Rate     pveValue `json:"rate"`
	Comment  string   `json:"comment"`
	Disable  pveValue `json:"disable"`
	JobNum   pveValue `json:"jobnum"`
}

// guestJobs returns the guest's replication jobs (configuration).
func (r *pveReq) guestJobs(ctx context.Context) ([]pveReplJob, error) {
	var all []pveReplJob
	if err := r.api.get(ctx, "/cluster/replication", nil, &all); err != nil {
		return nil, err
	}
	var out []pveReplJob
	for _, j := range all {
		if string(j.Guest) == r.g.ID || strings.HasPrefix(j.ID, r.g.ID+"-") {
			out = append(out, j)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// replicationJobs is the guest's jobs with their state (nil when
// unreadable).
func (r *pveReq) replicationJobs(ctx context.Context) []proto.ReplicationJob {
	jobs, err := r.guestJobs(ctx)
	if err != nil || len(jobs) == 0 {
		return nil
	}
	var state []struct {
		ID       string `json:"id"`
		LastSync int64  `json:"last_sync"`
		Error    string `json:"error"`
	}
	_ = r.api.get(ctx, r.nodePath()+"/replication", url.Values{"guest": {r.g.ID}}, &state)
	out := make([]proto.ReplicationJob, 0, len(jobs))
	for _, j := range jobs {
		rj := proto.ReplicationJob{ID: j.ID, Target: j.Target, Schedule: j.Schedule, Rate: string(j.Rate), Comment: j.Comment, Disabled: j.Disable.bool()}
		for _, s := range state {
			if s.ID != j.ID {
				continue
			}
			if s.LastSync > 0 {
				t := time.Unix(s.LastSync, 0).UTC()
				rj.LastSync = &t
			}
			rj.Error = firstLine(s.Error, 500)
		}
		out = append(out, rj)
	}
	return out
}

func (r *pveReq) replicationAdd(ctx context.Context) (proto.ManageResponse, error) {
	req := r.req
	nodes, err := r.requireCluster(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if !slices.Contains(nodes, req.Target) {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "target", "must be another node of the cluster")
	}
	schedule := req.Schedule
	if schedule == "" {
		schedule = "*/15"
	}
	switch {
	case !scheduleRe.MatchString(schedule):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "schedule", "invalid schedule")
	case req.Rate != "" && !rateRe.MatchString(req.Rate):
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "rate", "must be a number of MB/s")
	case len(req.Comment) > 4096 || checkText("comment", req.Comment, false) != nil:
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "comment", "must be one line of text")
	}
	jobs, err := r.guestJobs(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	used := map[int]bool{}
	for _, j := range jobs {
		if m := replicationRe.FindStringSubmatch(j.ID); m != nil {
			n, _ := strconv.Atoi(m[2])
			used[n] = true
		}
	}
	n := 0
	for used[n] {
		n++
	}
	params := url.Values{"id": {r.g.ID + "-" + strconv.Itoa(n)}, "type": {"local"}, "target": {req.Target}, "schedule": {schedule}}
	if req.Rate != "" {
		params.Set("rate", req.Rate)
	}
	if req.Comment != "" {
		params.Set("comment", req.Comment)
	}
	if err := r.api.post(ctx, "/cluster/replication", params, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

func (r *pveReq) replicationDelete(ctx context.Context) (proto.ManageResponse, error) {
	if _, err := r.requireCluster(ctx); err != nil {
		return proto.ManageResponse{}, err
	}
	m := replicationRe.FindStringSubmatch(r.req.JobID)
	if m == nil || m[1] != r.g.ID {
		return proto.ManageResponse{}, fieldErr(proto.CodeInvalidValue, "job", "not a replication job of this guest")
	}
	if err := r.api.delete(ctx, "/cluster/replication/"+url.PathEscape(r.req.JobID), nil, nil); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}
