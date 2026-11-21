package hub

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"slices"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

// ---- backup jobs (docs/MANAGE.md 3.1, docs/REST-API.md "Manage") -------------

// backupJobFields are the body fields of backupjob.create and
// backupjob.update (update also takes digest).
var backupJobFields = []string{"enabled", "schedule", "storage", "node", "selection", "guests", "exclude", "pool", "mode",
	"compress", "keep", "notes_template", "comment"}

var (
	backupJobIDRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)
	backupScheduleRe = regexp.MustCompile(`^[A-Za-z0-9 :,.*/~-]{1,128}$`)
	backupPoolRe     = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_/-]{0,99}$`)
	pveVMIDRe        = regexp.MustCompile(`^[1-9][0-9]{2,8}$`)
	// backupJobClearable may be null (or "", []) in an update: the job
	// loses the setting.
	backupJobClearable = []string{"node", "compress", "keep", "notes_template", "comment", "exclude"}
)

func isBackupJobOp(op string) bool {
	switch op {
	case proto.OpBackupJobList, proto.OpBackupJobCreate, proto.OpBackupJobUpdate, proto.OpBackupJobDelete, proto.OpBackupJobRun:
		return true
	}
	return false
}

// backupJobJSON is a backup job as the hub answers it: hub guest ids,
// null for what is not set.
type backupJobJSON struct {
	ID            string            `json:"id"`
	Enabled       bool              `json:"enabled"`
	Schedule      string            `json:"schedule"`
	Storage       string            `json:"storage"`
	Node          *string           `json:"node"`
	Selection     string            `json:"selection"`
	Guests        []string          `json:"guests"`
	Exclude       []string          `json:"exclude"`
	Pool          *string           `json:"pool"`
	Mode          string            `json:"mode"`
	Compress      *string           `json:"compress"`
	Keep          *proto.BackupKeep `json:"keep"`
	NotesTemplate *string           `json:"notes_template"`
	Comment       *string           `json:"comment"`
	NextRun       *time.Time        `json:"next_run"`
	Digest        string            `json:"digest"`
}

func optText(s string, max int) *string {
	if s == "" {
		return nil
	}
	s = cleanText(s, max)
	return &s
}

func hubGuestIDs(vmids []string) []string {
	out := make([]string, 0, len(vmids))
	for _, id := range vmids {
		if pveVMIDRe.MatchString(id) {
			out = append(out, model.GuestID(proto.PlatformPVE, id))
		}
	}
	return out
}

func backupJobAnswer(j proto.BackupJob) backupJobJSON {
	out := backupJobJSON{ID: cleanText(j.ID, 100), Enabled: j.Enabled, Schedule: cleanText(j.Schedule, 128),
		Storage: cleanText(j.Storage, 100), Node: optText(j.Node, 100), Selection: j.Selection,
		Guests: hubGuestIDs(j.Guests), Exclude: hubGuestIDs(j.Exclude), Pool: optText(j.Pool, 100), Mode: j.Mode,
		Compress: optText(j.Compress, 16), Keep: j.Keep, NotesTemplate: optText(j.NotesTemplate, 1024),
		Comment: optText(j.Comment, 1024), Digest: cleanText(j.Digest, 128)}
	if j.NextRun != nil {
		t := j.NextRun.UTC()
		out.NextRun = &t
	}
	return out
}

// decodeBackupJob reads the body of backupjob.create and backupjob.update:
// the job (update: the fields to change; null, "" or [] removes a
// clearable setting), with guest ids turned into vmids, and the digest.
func decodeBackupJob(r *http.Request, update bool) (*proto.BackupJobSpec, string, error) {
	spec := &proto.BackupJobSpec{}
	allowed := backupJobFields
	if update {
		allowed = append(slices.Clone(allowed), "digest")
	}
	var raw []byte
	if r.Body != nil {
		var err error
		if raw, err = io.ReadAll(io.LimitReader(r.Body, 1<<20)); err != nil {
			return nil, "", apiErr(http.StatusBadRequest, "bad_request", "Could not read the body.")
		}
	}
	fields := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, "", apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: a JSON object is required.")
		}
	}
	for k := range fields {
		if !slices.Contains(allowed, k) {
			return nil, "", apiErr(http.StatusBadRequest, "bad_request", "Invalid JSON body: unknown field \""+k+"\"")
		}
	}
	fe := map[string]string{}
	clear := func(f string) {
		if update && !slices.Contains(spec.Clear, f) {
			spec.Clear = append(spec.Clear, f)
		}
	}
	text := func(f string, target **string) {
		v, ok := fields[f]
		if !ok {
			return
		}
		if string(bytes.TrimSpace(v)) == "null" {
			if slices.Contains(backupJobClearable, f) {
				clear(f)
			} else if update {
				fe[f] = f + " cannot be removed."
			}
			return
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			fe[f] = f + " is text."
			return
		}
		if s == "" && slices.Contains(backupJobClearable, f) {
			clear(f)
			return
		}
		*target = &s
	}
	text("schedule", &spec.Schedule)
	text("storage", &spec.Storage)
	text("node", &spec.Node)
	text("selection", &spec.Selection)
	text("pool", &spec.Pool)
	text("mode", &spec.Mode)
	text("compress", &spec.Compress)
	text("notes_template", &spec.NotesTemplate)
	text("comment", &spec.Comment)
	digest := ""
	if v, ok := fields["digest"]; ok && string(bytes.TrimSpace(v)) != "null" {
		if err := json.Unmarshal(v, &digest); err != nil {
			fe["digest"] = "Not a digest."
		}
	}

	if v, ok := fields["enabled"]; ok && string(bytes.TrimSpace(v)) != "null" {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			fe["enabled"] = "enabled is true or false."
		} else {
			spec.Enabled = &b
		}
	}
	guests := func(f string) []string {
		v, ok := fields[f]
		if !ok || string(bytes.TrimSpace(v)) == "null" {
			if ok && f == "exclude" {
				clear(f)
			}
			return nil
		}
		var ids []string
		if err := json.Unmarshal(v, &ids); err != nil {
			fe[f] = f + " is a list of guest ids (\"pve:101\")."
			return nil
		}
		if len(ids) > 1000 {
			fe[f] = "At most 1000 guests."
			return nil
		}
		out := []string{}
		for _, gid := range ids {
			platform, id, ok := model.SplitGuestID(gid)
			if !ok || platform != proto.PlatformPVE || !pveVMIDRe.MatchString(id) {
				fe[f] = "Give Proxmox VE guests as \"pve:101\"."
				return nil
			}
			if !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
		return out
	}
	spec.Guests = guests("guests")
	if spec.Exclude = guests("exclude"); spec.Exclude != nil && len(spec.Exclude) == 0 {
		spec.Exclude = nil
		clear("exclude")
	}
	if _, ok := fields["guests"]; ok && spec.Guests != nil && len(spec.Guests) == 0 && fe["guests"] == "" {
		fe["guests"] = "Choose at least one guest."
	}
	if v, ok := fields["keep"]; ok && string(bytes.TrimSpace(v)) == "null" {
		clear("keep")
	} else if ok {
		var k proto.BackupKeep
		dec := json.NewDecoder(bytes.NewReader(v))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&k); err != nil {
			fe["keep"] = "keep has last, hourly, daily, weekly, monthly and yearly counts."
		} else {
			for _, n := range []int{k.Last, k.Hourly, k.Daily, k.Weekly, k.Monthly, k.Yearly} {
				if n < 0 || n > 10000 {
					fe["keep"] = "Counts are from 0 to 10000."
				}
			}
			spec.Keep = &k
		}
	}

	// Values that can never be valid; the agent checks them against the
	// node (storages, guests, nodes, pools).
	bad := func(ok bool, f, msg string) {
		if !ok && fe[f] == "" {
			fe[f] = msg
		}
	}
	if !update {
		bad(spec.Schedule != nil, "schedule", "Choose when the job runs.")
		bad(spec.Storage != nil, "storage", "Choose a backup storage.")
		bad(spec.Selection != nil, "selection", "Choose all, guests or pool.")
	}
	if p := spec.Schedule; p != nil {
		bad(backupScheduleRe.MatchString(*p), "schedule", "The schedule is a Proxmox VE schedule such as \"04:00\" or \"sat 02:30\".")
	}
	for _, f := range []struct {
		name string
		v    *string
	}{{"storage", spec.Storage}, {"node", spec.Node}} {
		if f.v != nil {
			bad(manageIDRe.MatchString(*f.v), f.name, "Not a "+f.name+".")
		}
	}
	if p := spec.Pool; p != nil {
		bad(backupPoolRe.MatchString(*p), "pool", "Not a pool.")
	}
	if p := spec.Selection; p != nil {
		bad(slices.Contains([]string{proto.BackupSelectAll, proto.BackupSelectGuests, proto.BackupSelectPool}, *p), "selection",
			"selection is all, guests or pool.")
		bad(*p != proto.BackupSelectGuests || update || len(spec.Guests) > 0, "guests", "Choose at least one guest.")
		bad(*p != proto.BackupSelectPool || update || spec.Pool != nil, "pool", "Choose a pool.")
	}
	if p := spec.Mode; p != nil {
		bad(slices.Contains([]string{"snapshot", "suspend", "stop"}, *p), "mode", "mode is snapshot, suspend or stop.")
	}
	if p := spec.Compress; p != nil {
		bad(slices.Contains([]string{"zstd", "lzo", "gzip", "0"}, *p), "compress", "compress is zstd, lzo, gzip or 0 (none).")
	}
	for _, f := range []struct {
		name string
		v    *string
	}{{"notes_template", spec.NotesTemplate}, {"comment", spec.Comment}} {
		if f.v != nil {
			bad(manageText(*f.v, 1024, false), f.name, "One line of up to 1024 characters.")
		}
	}
	bad(manageText(digest, 128, false), "digest", "Not a digest.")
	if len(fe) > 0 {
		return nil, "", invalidFields(fe)
	}
	return spec, digest, nil
}

// backupJobKeys are the fields a backup job request names, for the audit
// log (values stay out, like configuration values).
func backupJobKeys(s *proto.BackupJobSpec) []string {
	var keys []string
	for f, set := range map[string]bool{"enabled": s.Enabled != nil, "schedule": s.Schedule != nil, "storage": s.Storage != nil,
		"node": s.Node != nil, "selection": s.Selection != nil, "guests": s.Guests != nil, "exclude": s.Exclude != nil,
		"pool": s.Pool != nil, "mode": s.Mode != nil, "compress": s.Compress != nil, "keep": s.Keep != nil,
		"notes_template": s.NotesTemplate != nil, "comment": s.Comment != nil} {
		if set {
			keys = append(keys, f)
		}
	}
	return append(keys, s.Clear...)
}
