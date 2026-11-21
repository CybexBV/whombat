package broker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Scheduled backup jobs on Proxmox VE (docs/MANAGE.md 2.3). Jobs are read
// with the manage token (GET /cluster/backup needs Sys.Audit). Creating,
// changing and deleting a job needs Sys.Modify on /, which would let the
// token change the node's own settings, so those run `pvesh` as root,
// with every value checked first. Running a job is vzdump through the
// API, like backup.create.

var (
	pveJobIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)
	pvePoolRe  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_/-]{0,99}$`)
	// pveshFieldRe is a line of pvesh's parameter error ("schedule: value
	// does not match the regex pattern").
	pveshFieldRe = regexp.MustCompile(`^([a-z][a-z0-9_-]*): (.+)$`)

	jobCompress = []string{"zstd", "lzo", "gzip", "0"}
	// jobClearable are the fields an update may remove, and their PVE keys.
	jobClearable = map[string]string{"node": "node", "compress": "compress", "keep": "prune-backups",
		"notes_template": "notes-template", "comment": "comment", "exclude": "exclude"}
	// jobFieldOf maps PVE parameter names to the request's field names.
	jobFieldOf = map[string]string{"prune-backups": "keep", "notes-template": "notes_template", "vmid": "guests",
		"all": "selection", "id": "job"}
	// keepKeys are prune-backups' keys in PVE's order.
	keepKeys = []string{"keep-last", "keep-hourly", "keep-daily", "keep-weekly", "keep-monthly", "keep-yearly"}
)

const (
	maxJobGuests = 1000
	maxJobText   = 1024
	maxKeepCount = 10000
)

// pvePool is an entry of /pools.
type pvePool struct {
	PoolID string `json:"poolid"`
}

// pveJob is an entry of /cluster/backup: its fields as Proxmox VE returned
// them (for the digest) and the job Whombat reads from them.
type pveJob struct {
	raw     map[string]any
	job     proto.BackupJob
	dumpdir bool // writes to a directory instead of a storage (root-only option)
}

// jobText is a field of a job as text (PVE returns "1" or 1, "zstd").
func jobText(m map[string]any, key string) string {
	switch v := m[key].(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case bool:
		if v {
			return "1"
		}
		return "0"
	}
	return ""
}

func jobTrue(s string) bool { return s != "" && s != "0" && s != "false" }

// jobVMIDs splits a vmid list ("101,118"), keeping valid ids only, sorted.
func jobVMIDs(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\t' }) {
		if vmidRe.MatchString(f) && !slices.Contains(out, f) {
			out = append(out, f)
		}
	}
	sortVMIDs(out)
	return out
}

func sortVMIDs(ids []string) {
	sort.Slice(ids, func(i, j int) bool {
		a, _ := strconv.Atoi(ids[i])
		b, _ := strconv.Atoi(ids[j])
		return a < b
	})
}

// jobKeep reads prune-backups: an object (PVE 8 and later) or a
// property string. keep-all keeps every backup: every count 0.
func jobKeep(v any) *proto.BackupKeep {
	vals := map[string]string{}
	switch x := v.(type) {
	case map[string]any:
		for k := range x {
			vals[k] = jobText(x, k)
		}
	case string:
		for _, item := range strings.Split(x, ",") {
			if k, val, ok := strings.Cut(strings.TrimSpace(item), "="); ok {
				vals[k] = val
			}
		}
	default:
		return nil
	}
	if len(vals) == 0 {
		return nil
	}
	n := func(k string) int { i, _ := strconv.Atoi(vals[k]); return max(i, 0) }
	k := &proto.BackupKeep{Last: n("keep-last"), Hourly: n("keep-hourly"), Daily: n("keep-daily"), Weekly: n("keep-weekly"),
		Monthly: n("keep-monthly"), Yearly: n("keep-yearly")}
	if jobTrue(vals["keep-all"]) {
		return &proto.BackupKeep{}
	}
	return k
}

// keepParam is prune-backups for a retention ("keep-last=7,keep-daily=14";
// every count 0: keep-all=1).
func keepParam(k proto.BackupKeep) string {
	var parts []string
	for i, n := range []int{k.Last, k.Hourly, k.Daily, k.Weekly, k.Monthly, k.Yearly} {
		if n > 0 {
			parts = append(parts, keepKeys[i]+"="+strconv.Itoa(n))
		}
	}
	if len(parts) == 0 {
		return "keep-all=1"
	}
	return strings.Join(parts, ",")
}

// keepText is a retention for the change list ("last 7, daily 14").
func keepText(k *proto.BackupKeep) string {
	if k == nil {
		return ""
	}
	var parts []string
	for i, n := range []int{k.Last, k.Hourly, k.Daily, k.Weekly, k.Monthly, k.Yearly} {
		if n > 0 {
			parts = append(parts, strings.TrimPrefix(keepKeys[i], "keep-")+" "+strconv.Itoa(n))
		}
	}
	if len(parts) == 0 {
		return "all"
	}
	return strings.Join(parts, ", ")
}

// parseJob reads one job of /cluster/backup.
func parseJob(raw json.RawMessage) (pveJob, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return pveJob{}, err
	}
	// The digest covers the job as stored: next-run is computed from the
	// clock and left out. encoding/json sorts the keys.
	stored := map[string]any{}
	for k, v := range m {
		if k != "next-run" {
			stored[k] = v
		}
	}
	b, _ := json.Marshal(stored)
	sum := sha256.Sum256(b)
	j := proto.BackupJob{ID: jobText(m, "id"), Enabled: true, Schedule: jobText(m, "schedule"), Storage: jobText(m, "storage"),
		Node: jobText(m, "node"), Mode: jobText(m, "mode"), Compress: jobText(m, "compress"),
		NotesTemplate: jobText(m, "notes-template"), Comment: jobText(m, "comment"), Digest: hex.EncodeToString(sum[:])}
	if v, ok := m["enabled"]; ok && v != nil {
		j.Enabled = jobTrue(jobText(m, "enabled"))
	}
	if j.Mode == "" {
		j.Mode = "snapshot"
	}
	if j.Compress == "1" {
		j.Compress = "lzo" // vzdump's old "1"
	}
	exclude := jobVMIDs(jobText(m, "exclude"))
	pool := jobText(m, "pool")
	switch {
	case jobTrue(jobText(m, "all")) || (len(exclude) > 0 && pool == ""):
		j.Selection, j.Exclude = proto.BackupSelectAll, exclude
	case pool != "":
		j.Selection, j.Pool = proto.BackupSelectPool, pool
	default:
		j.Selection, j.Guests = proto.BackupSelectGuests, jobVMIDs(jobText(m, "vmid"))
	}
	j.Keep = jobKeep(m["prune-backups"])
	if n, err := strconv.ParseInt(jobText(m, "next-run"), 10, 64); err == nil && n > 0 && j.Enabled {
		t := time.Unix(n, 0).UTC()
		j.NextRun = &t
	}
	return pveJob{raw: m, job: j, dumpdir: jobText(m, "dumpdir") != ""}, nil
}

// backupJobs reads the cluster's vzdump jobs.
func (r *pveReq) backupJobs(ctx context.Context) ([]pveJob, error) {
	var list []json.RawMessage
	if err := r.api.get(ctx, "/cluster/backup", nil, &list); err != nil {
		return nil, err
	}
	out := make([]pveJob, 0, len(list))
	for _, raw := range list {
		j, err := parseJob(raw)
		if err != nil {
			return nil, codeErr(CodePlatformError, "Proxmox VE returned a backup job Whombat cannot read: "+err.Error())
		}
		// Older vzdump.cron jobs have no type; other job types are not
		// backups.
		if t := jobText(j.raw, "type"); (t != "" && t != "vzdump") || !pveJobIDRe.MatchString(j.job.ID) {
			continue
		}
		out = append(out, j)
	}
	return out, nil
}

// backupJob finds the request's job.
func (r *pveReq) backupJob(ctx context.Context) (pveJob, error) {
	if !pveJobIDRe.MatchString(r.req.JobID) {
		return pveJob{}, fieldErr(proto.CodeInvalidValue, "job", "not a backup job id")
	}
	jobs, err := r.backupJobs(ctx)
	if err != nil {
		return pveJob{}, err
	}
	for _, j := range jobs {
		if j.job.ID == r.req.JobID {
			return j, nil
		}
	}
	return pveJob{}, codeErr(proto.CodeNotFound, "there is no backup job "+r.req.JobID)
}

func (r *pveReq) backupJobList(ctx context.Context) (proto.ManageResponse, error) {
	jobs, err := r.backupJobs(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	out := make([]proto.BackupJob, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, j.job)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return proto.ManageResponse{OK: true, BackupJobs: out}, nil
}

// clusterGuests returns the cluster's guests: vmid -> node.
func (r *pveReq) clusterGuests(ctx context.Context) (map[string]string, error) {
	var res []struct {
		VMID pveValue `json:"vmid"`
		Node string   `json:"node"`
	}
	if err := r.api.get(ctx, "/cluster/resources", url.Values{"type": {"vm"}}, &res); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(res))
	for _, g := range res {
		out[string(g.VMID)] = g.Node
	}
	return out, nil
}

// clusterNodes returns every node of the cluster, this one included.
func (r *pveReq) clusterNodes(ctx context.Context) ([]string, error) {
	_, others, err := r.cluster(ctx)
	if err != nil {
		return nil, err
	}
	return append([]string{r.node}, others...), nil
}

// jobDraft is a backup job request checked against the node: the pvesh
// arguments, the deleted keys and what changes.
type jobDraft struct {
	params  map[string]string // PVE key -> value
	del     []string          // PVE keys to remove
	changes []proto.ConfigChange
}

func (d *jobDraft) change(key, old, new, pveKey, value string) {
	if old == new {
		return
	}
	d.changes = append(d.changes, proto.ConfigChange{Key: key, Old: old, New: new})
	if pveKey != "" {
		d.params[pveKey] = value
	}
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// draftJob checks a create (cur nil) or an update of cur and returns what
// to send. Every value is checked before anything runs.
func (r *pveReq) draftJob(ctx context.Context, spec *proto.BackupJobSpec, cur *proto.BackupJob) (*jobDraft, error) {
	if spec == nil {
		return nil, codeErr(CodeInvalid, "the backup job is required")
	}
	create := cur == nil
	if create {
		cur = &proto.BackupJob{Enabled: true}
	}
	// An empty text removes the value (a new job just leaves it out).
	s := *spec
	spec = &s
	spec.Clear = slices.Clone(spec.Clear)
	for f, p := range map[string]**string{"node": &spec.Node, "compress": &spec.Compress,
		"notes_template": &spec.NotesTemplate, "comment": &spec.Comment} {
		if *p != nil && **p == "" {
			*p = nil
			if !create && !slices.Contains(spec.Clear, f) {
				spec.Clear = append(spec.Clear, f)
			}
		}
	}
	clear := map[string]bool{}
	for _, f := range spec.Clear {
		switch {
		case create:
			return nil, fieldErr(proto.CodeInvalidValue, f, "a new job has nothing to remove")
		case jobClearable[f] == "":
			return nil, fieldErr(proto.CodeInvalidValue, f, "cannot be removed")
		}
		clear[f] = true
	}
	set := map[string]bool{"node": spec.Node != nil, "compress": spec.Compress != nil, "keep": spec.Keep != nil,
		"notes_template": spec.NotesTemplate != nil, "comment": spec.Comment != nil, "exclude": spec.Exclude != nil}
	for f := range clear {
		if set[f] {
			return nil, fieldErr(proto.CodeInvalidValue, f, "is set and removed at once")
		}
	}

	// Values on their own.
	if spec.Schedule != nil && !scheduleRe.MatchString(*spec.Schedule) {
		return nil, fieldErr(proto.CodeInvalidValue, "schedule", `must be a Proxmox VE schedule such as "04:00" or "sat 02:30"`)
	}
	if spec.Mode != nil && !slices.Contains(backupModes, *spec.Mode) {
		return nil, fieldErr(proto.CodeInvalidValue, "mode", "must be snapshot, suspend or stop")
	}
	if spec.Compress != nil && !slices.Contains(jobCompress, *spec.Compress) {
		return nil, fieldErr(proto.CodeInvalidValue, "compress", "must be zstd, lzo, gzip or 0")
	}
	if k := spec.Keep; k != nil {
		for _, n := range []int{k.Last, k.Hourly, k.Daily, k.Weekly, k.Monthly, k.Yearly} {
			if n < 0 || n > maxKeepCount {
				return nil, fieldErr(proto.CodeInvalidValue, "keep", "counts are from 0 to 10000")
			}
		}
	}
	for _, f := range []struct {
		key string
		v   *string
	}{{"notes_template", spec.NotesTemplate}, {"comment", spec.Comment}} {
		if f.v != nil && (len(*f.v) > maxJobText || checkText(f.key, *f.v, false) != nil) {
			return nil, fieldErr(proto.CodeInvalidValue, f.key, "must be one line of at most 1024 characters")
		}
	}
	if spec.Pool != nil && !pvePoolRe.MatchString(*spec.Pool) {
		return nil, fieldErr(proto.CodeInvalidValue, "pool", "not a pool name")
	}
	if spec.Selection != nil && !slices.Contains([]string{proto.BackupSelectAll, proto.BackupSelectGuests, proto.BackupSelectPool}, *spec.Selection) {
		return nil, fieldErr(proto.CodeInvalidValue, "selection", "must be all, guests or pool")
	}
	for _, f := range []struct {
		key string
		ids []string
	}{{"guests", spec.Guests}, {"exclude", spec.Exclude}} {
		if len(f.ids) > maxJobGuests {
			return nil, fieldErr(proto.CodeInvalidValue, f.key, "at most 1000 guests")
		}
		for _, id := range f.ids {
			if !vmidRe.MatchString(id) {
				return nil, fieldErr(proto.CodeInvalidValue, f.key, id+" is not a guest id")
			}
		}
	}

	// What the job becomes.
	sel := cur.Selection
	if spec.Selection != nil {
		sel = *spec.Selection
	}
	switch {
	case create && spec.Selection == nil:
		return nil, fieldErr(proto.CodeInvalidValue, "selection", "choose all, guests or pool")
	case create && spec.Schedule == nil:
		return nil, fieldErr(proto.CodeInvalidValue, "schedule", "a job needs a schedule")
	case create && spec.Storage == nil:
		return nil, fieldErr(proto.CodeInvalidValue, "storage", "a job needs a backup storage")
	case spec.Guests != nil && sel != proto.BackupSelectGuests:
		return nil, fieldErr(proto.CodeInvalidValue, "guests", "guests go with selection guests")
	case spec.Exclude != nil && sel != proto.BackupSelectAll:
		return nil, fieldErr(proto.CodeInvalidValue, "exclude", "exclude goes with selection all")
	case spec.Pool != nil && sel != proto.BackupSelectPool:
		return nil, fieldErr(proto.CodeInvalidValue, "pool", "pool goes with selection pool")
	case sel == proto.BackupSelectGuests && cur.Selection != sel && len(spec.Guests) == 0,
		sel == proto.BackupSelectGuests && spec.Guests != nil && len(spec.Guests) == 0:
		return nil, fieldErr(proto.CodeInvalidValue, "guests", "choose the guests to back up")
	case sel == proto.BackupSelectPool && cur.Selection != sel && spec.Pool == nil:
		return nil, fieldErr(proto.CodeInvalidValue, "pool", "choose the pool to back up")
	}

	// Values against the node and the cluster.
	storage := cur.Storage
	if spec.Storage != nil {
		info, err := r.nodeInfo(ctx)
		if err != nil {
			return nil, err
		}
		if err := info.storageFor(*spec.Storage, "backup"); err != nil {
			_, msg := errCode(err, "")
			return nil, fieldErr(proto.CodeInvalidValue, "storage", msg)
		}
		storage = *spec.Storage
	}
	if spec.Node != nil {
		nodes, err := r.clusterNodes(ctx)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(nodes, *spec.Node) {
			return nil, fieldErr(proto.CodeInvalidValue, "node", *spec.Node+" is not a node of this cluster")
		}
	}
	if spec.Guests != nil || spec.Exclude != nil {
		guests, err := r.clusterGuests(ctx)
		if err != nil {
			return nil, err
		}
		// Ids the job has already may belong to guests deleted since.
		for _, f := range []struct {
			key      string
			ids, had []string
		}{{"guests", spec.Guests, cur.Guests}, {"exclude", spec.Exclude, cur.Exclude}} {
			for _, id := range f.ids {
				if _, ok := guests[id]; !ok && !slices.Contains(f.had, id) {
					return nil, fieldErr(proto.CodeInvalidValue, f.key, "there is no guest "+id+" in this cluster")
				}
			}
		}
	}
	if spec.Pool != nil {
		var pools []pvePool
		// Without Pool.Audit on a pool PVE hides it; PVE checks it again.
		if err := r.api.get(ctx, "/pools", nil, &pools); err == nil {
			if !slices.ContainsFunc(pools, func(p pvePool) bool { return p.PoolID == *spec.Pool }) {
				return nil, fieldErr(proto.CodeInvalidValue, "pool", "there is no pool "+*spec.Pool)
			}
		} else if apiStatus(err) != http.StatusForbidden {
			return nil, err
		}
	}

	d := &jobDraft{params: map[string]string{}}
	if spec.Enabled != nil {
		d.change("enabled", boolText(cur.Enabled), boolText(*spec.Enabled), "enabled", boolParam(*spec.Enabled))
	}
	for _, f := range []struct {
		key, pveKey string
		old         string
		v           *string
	}{{"schedule", "schedule", cur.Schedule, spec.Schedule}, {"storage", "storage", cur.Storage, spec.Storage},
		{"node", "node", cur.Node, spec.Node}, {"mode", "mode", cur.Mode, spec.Mode},
		{"compress", "compress", cur.Compress, spec.Compress},
		{"notes_template", "notes-template", cur.NotesTemplate, spec.NotesTemplate}, {"comment", "comment", cur.Comment, spec.Comment}} {
		if f.v != nil {
			d.change(f.key, f.old, *f.v, f.pveKey, *f.v)
		}
	}
	if create && spec.Mode == nil {
		d.change("mode", "", "snapshot", "mode", "snapshot")
	}
	if create && spec.Compress == nil {
		// Like Proxmox VE's own dialog: zstd, except on a Proxmox Backup
		// Server (it compresses itself).
		if info, err := r.nodeInfo(ctx); err == nil && info.storages[storage].Type != "pbs" {
			d.change("compress", "", "zstd", "compress", "zstd")
		}
	}
	if spec.Keep != nil && keepText(spec.Keep) != keepText(cur.Keep) {
		d.change("keep", keepText(cur.Keep), keepText(spec.Keep), "prune-backups", keepParam(*spec.Keep))
	}

	// The selection: PVE drops the other selection's keys itself.
	list := func(ids []string) string {
		ids = slices.Clone(ids)
		sortVMIDs(ids)
		return strings.Join(slices.Compact(ids), ",")
	}
	d.change("selection", cur.Selection, sel, "", "")
	switch sel {
	case proto.BackupSelectAll:
		if cur.Selection != sel {
			d.params["all"] = "1"
		}
		if spec.Exclude != nil && len(spec.Exclude) == 0 && len(cur.Exclude) > 0 {
			clear["exclude"] = true
		} else if spec.Exclude != nil {
			d.change("exclude", list(cur.Exclude), list(spec.Exclude), "exclude", list(spec.Exclude))
		}
	case proto.BackupSelectGuests:
		if spec.Guests != nil {
			d.change("guests", list(cur.Guests), list(spec.Guests), "vmid", list(spec.Guests))
		}
	case proto.BackupSelectPool:
		if spec.Pool != nil {
			d.change("pool", cur.Pool, *spec.Pool, "pool", *spec.Pool)
		}
	}
	if cur.Selection != sel && sel == proto.BackupSelectGuests {
		d.params["vmid"] = list(spec.Guests)
	}
	if cur.Selection != sel && sel == proto.BackupSelectPool {
		d.params["pool"] = *spec.Pool
	}

	for _, f := range slices.Sorted(maps.Keys(clear)) {
		var old string
		switch f {
		case "node":
			old = cur.Node
		case "compress":
			old = cur.Compress
		case "keep":
			old = keepText(cur.Keep)
		case "notes_template":
			old = cur.NotesTemplate
		case "comment":
			old = cur.Comment
		case "exclude":
			old = list(cur.Exclude)
		}
		if old == "" {
			continue // not set
		}
		d.changes = append(d.changes, proto.ConfigChange{Key: f, Old: old})
		d.del = append(d.del, jobClearable[f])
	}
	return d, nil
}

// pvesh runs pvesh as root and maps its errors (docs/MANAGE.md 2.3):
// parameter errors to invalid_value with the fields, "already exists" to
// exists, a missing job to not_found, a held lock to locked.
func (r *pveReq) pvesh(ctx context.Context, argv ...string) error {
	_, err := r.run(ctx, append([]string{"pvesh"}, argv...)...)
	if err == nil {
		return nil
	}
	msg := err.Error()
	var ce *cmdError
	if errors.As(err, &ce) && strings.HasPrefix(ce.msg, "400 Parameter verification failed") {
		fe := &fieldsError{code: proto.CodeInvalidValue, fields: map[string]string{}}
		for _, line := range strings.Split(ce.stderr, "\n") {
			m := pveshFieldRe.FindStringSubmatch(strings.TrimSpace(line))
			if m == nil {
				continue
			}
			key := m[1]
			if f, ok := jobFieldOf[key]; ok {
				key = f
			}
			if _, dup := fe.fields[key]; !dup {
				fe.fields[key] = firstLine(m[2], 500)
			}
		}
		if len(fe.fields) > 0 {
			keys := sortedKeys(fe.fields)
			fe.msg = keys[0] + ": " + fe.fields[keys[0]]
			return fe
		}
	}
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "already exists"):
		return codeErr(proto.CodeExists, msg)
	case strings.Contains(low, "no such vzdump job") || strings.Contains(low, "no such job"):
		return codeErr(proto.CodeNotFound, msg)
	case strings.Contains(low, "can't lock file") || strings.Contains(low, "got lock request timeout") || strings.Contains(low, "cfs-lock"):
		return codeErr(proto.CodeLocked, msg)
	}
	return codeErr(CodePlatformError, msg)
}

// pveshArgs are --key=value arguments, sorted (a value starting with "-"
// stays a value).
func pveshArgs(params map[string]string, del []string) []string {
	var out []string
	for _, k := range sortedKeys(params) {
		out = append(out, "--"+k+"="+params[k])
	}
	if len(del) > 0 {
		out = append(out, "--delete="+strings.Join(del, ","))
	}
	return out
}

// newJobID is an id like Proxmox VE's own dialog makes
// ("backup-dc316015-ac2c").
func newJobID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	h := hex.EncodeToString(b[:])
	return "backup-" + h[:8] + "-" + h[8:]
}

func (r *pveReq) backupJobCreate(ctx context.Context) (proto.ManageResponse, error) {
	d, err := r.draftJob(ctx, r.req.BackupJob, nil)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	jobs, err := r.backupJobs(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	id := newJobID()
	for slices.ContainsFunc(jobs, func(j pveJob) bool { return j.job.ID == id }) {
		id = newJobID()
	}
	args := append([]string{"create", "/cluster/backup", "--id=" + id}, pveshArgs(d.params, nil)...)
	if err := r.pvesh(ctx, args...); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true, JobID: id, Changes: d.changes}, nil
}

func (r *pveReq) backupJobUpdate(ctx context.Context) (proto.ManageResponse, error) {
	j, err := r.backupJob(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if r.req.Digest != "" && r.req.Digest != j.job.Digest {
		return proto.ManageResponse{}, codeErr(proto.CodeDigestMismatch, "the backup job changed since it was read")
	}
	d, err := r.draftJob(ctx, r.req.BackupJob, &j.job)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if len(d.changes) == 0 {
		return proto.ManageResponse{OK: true}, nil
	}
	args := append([]string{"set", "/cluster/backup/" + j.job.ID}, pveshArgs(d.params, d.del)...)
	if err := r.pvesh(ctx, args...); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true, Changes: d.changes}, nil
}

func (r *pveReq) backupJobDelete(ctx context.Context) (proto.ManageResponse, error) {
	j, err := r.backupJob(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if err := r.pvesh(ctx, "delete", "/cluster/backup/"+j.job.ID); err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true}, nil
}

// backupJobRun backs up the job's guests on this node now: vzdump with the
// job's selection, storage, mode, compression and notes. A job with its
// own retention runs without pruning: prune-backups through the API needs
// Datastore.Allocate (which would let the token change storage
// definitions); the job's next scheduled run prunes as usual.
func (r *pveReq) backupJobRun(ctx context.Context) (proto.ManageResponse, error) {
	pj, err := r.backupJob(ctx)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	j := pj.job
	switch {
	case j.Node != "" && j.Node != r.node:
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "this job runs on "+j.Node+" only; run it from that server")
	case pj.dumpdir || j.Storage == "":
		return proto.ManageResponse{}, codeErr(proto.CodeNotAllowed, "this job has no backup storage; give it one first")
	}
	params := url.Values{"storage": {j.Storage}, "mode": {j.Mode}}
	switch j.Selection {
	case proto.BackupSelectAll:
		params.Set("all", "1")
		if len(j.Exclude) > 0 {
			params.Set("exclude", strings.Join(j.Exclude, ","))
		}
	case proto.BackupSelectPool:
		params.Set("pool", j.Pool)
	default:
		guests, err := r.clusterGuests(ctx)
		if err != nil {
			return proto.ManageResponse{}, err
		}
		local := slices.ContainsFunc(j.Guests, func(id string) bool { return guests[id] == r.node })
		if !local {
			return proto.ManageResponse{}, codeErr(CodeUnsupported, "none of this job's guests are on "+r.node+"; run it from the server they are on")
		}
		params.Set("vmid", strings.Join(j.Guests, ","))
	}
	if j.Compress != "" {
		params.Set("compress", j.Compress)
	}
	if j.NotesTemplate != "" {
		params.Set("notes-template", j.NotesTemplate)
	}
	if j.Keep != nil {
		params.Set("remove", "0")
	}
	var upid string
	if err := r.api.post(ctx, r.nodePath()+"/vzdump", params, &upid); err != nil {
		return proto.ManageResponse{}, err
	}
	resp := taskAnswer(upid)
	if resp.Task == nil {
		return proto.ManageResponse{}, codeErr(CodePlatformError, fmt.Sprintf("Proxmox VE started no backup on %s", r.node))
	}
	return resp, nil
}
