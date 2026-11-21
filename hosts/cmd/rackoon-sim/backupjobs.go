package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated backup jobs on shale (docs/MANAGE.md 2.3, backupjob.*): two
// seeded jobs, changes checked like the agent does, coverage of the
// guests (Guest.BackupJob) recomputed after every change, and runs as
// vzdump tasks.

var (
	simScheduleRe = regexp.MustCompile(`^[A-Za-z0-9 :,.*/~-]{1,128}$`)
	simClockRe    = regexp.MustCompile(`^(?:(mon|tue|wed|thu|fri|sat|sun) )?([01]?[0-9]|2[0-3]):([0-5][0-9])$`)
	simNodes      = []string{simNode, "schist", "slate"}
	// simPools: pool -> the tag whose guests are in it.
	simPools = map[string]string{"prod": "prod"}
)

// seedJobs are shale's jobs: everything but the lab guests every night,
// and the databases once more on local disk.
func seedJobs() []proto.BackupJob {
	return []proto.BackupJob{
		{ID: "backup-5a1e0001-0c3b", Enabled: true, Schedule: "00:00", Storage: "pbs-01", Selection: proto.BackupSelectAll,
			Exclude: []string{"107", "119", "120"}, Mode: "snapshot", Keep: &proto.BackupKeep{Last: 7, Daily: 14, Weekly: 8, Monthly: 6},
			NotesTemplate: "{{guestname}}"},
		{ID: "backup-5a1e0002-7d41", Enabled: true, Schedule: "sat 03:30", Storage: "local", Selection: proto.BackupSelectGuests,
			Guests: []string{"103", "113"}, Mode: "snapshot", Compress: "zstd", Comment: "Databases also on local disk"},
	}
}

// simJobDigest is the digest of a job as stored.
func simJobDigest(j proto.BackupJob) string {
	j.Digest, j.NextRun = "", nil
	b, _ := json.Marshal(j)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// simNextRun is the next time a daily or weekly "[ddd ]HH:MM" schedule
// runs (nil for other schedules).
func simNextRun(schedule string, now time.Time) *time.Time {
	m := simClockRe.FindStringSubmatch(schedule)
	if m == nil {
		return nil
	}
	h, _ := strconv.Atoi(m[2])
	mi, _ := strconv.Atoi(m[3])
	now = now.UTC()
	for d := 0; d <= 7; d++ {
		t := time.Date(now.Year(), now.Month(), now.Day()+d, h, mi, 0, 0, time.UTC)
		if t.After(now) && (m[1] == "" || strings.ToLower(t.Weekday().String()[:3]) == m[1]) {
			return &t
		}
	}
	return nil
}

func (a *simAgent) backupJobs(m *manageState, req proto.ManageRequest) proto.ManageResponse {
	if m.jobs == nil {
		m.jobs = seedJobs()
	}
	idx := slices.IndexFunc(m.jobs, func(j proto.BackupJob) bool { return j.ID == req.JobID })
	if req.Op != proto.OpBackupJobList && req.Op != proto.OpBackupJobCreate && idx < 0 {
		return fail(proto.CodeNotFound, "there is no backup job "+req.JobID)
	}
	switch req.Op {
	case proto.OpBackupJobList:
		out := make([]proto.BackupJob, 0, len(m.jobs))
		for _, j := range m.jobs {
			j.Digest = simJobDigest(j)
			if j.Enabled {
				j.NextRun = simNextRun(j.Schedule, time.Now())
			}
			out = append(out, j)
		}
		return proto.ManageResponse{OK: true, BackupJobs: out}
	case proto.OpBackupJobCreate, proto.OpBackupJobUpdate:
		cur := proto.BackupJob{Enabled: true, Mode: "snapshot"}
		if idx >= 0 {
			cur = m.jobs[idx]
			if req.Digest != "" && req.Digest != simJobDigest(cur) {
				return fail(proto.CodeDigestMismatch, "the backup job changed since it was read")
			}
		}
		next, refused := a.applyJob(cur, req.BackupJob, idx < 0)
		if refused != nil {
			return *refused
		}
		changes := jobChanges(cur, next)
		if idx < 0 {
			next.ID = fmt.Sprintf("backup-%08x-%04x", rand.Uint32(), rand.Uint32()&0xffff)
			m.jobs = append(m.jobs, next)
		} else {
			m.jobs[idx] = next
		}
		a.coverage(m)
		if idx < 0 {
			return proto.ManageResponse{OK: true, JobID: next.ID, Changes: changes}
		}
		return proto.ManageResponse{OK: true, Changes: changes}
	case proto.OpBackupJobDelete:
		m.jobs = slices.Delete(m.jobs, idx, idx+1)
		a.coverage(m)
		return proto.ManageResponse{OK: true}
	case proto.OpBackupJobRun:
		j := m.jobs[idx]
		if j.Node != "" && j.Node != simNode {
			return fail("unsupported", "this job runs on "+j.Node+" only; run it from that server")
		}
		var ids []string
		for _, g := range a.host.GuestSpecs(proto.PlatformPVE) {
			if !g.Template && simCovers(j, g) {
				ids = append(ids, g.ID)
			}
		}
		if len(ids) == 0 {
			return fail("unsupported", "none of this job's guests are on "+simNode+"; run it from the server they are on")
		}
		lines := []string{"INFO: starting new backup job: vzdump " + strings.Join(ids, " ") + " --storage " + j.Storage + " --mode " + j.Mode}
		for _, id := range ids {
			lines = append(lines, "INFO: Starting Backup of VM "+id, "INFO: Finished Backup of VM "+id)
		}
		lines = append(lines, "INFO: Backup job finished successfully")
		t := m.startTask("vzdump", "", time.Duration(2+len(ids)/4)*time.Second, lines, "", func() {
			now := time.Now()
			for _, id := range ids {
				a.host.UpdateGuest(proto.PlatformPVE, id, func(s *fakefleet.GuestSpec) {
					s.Backup, s.BackupAgeDays = "ok", 0
					if list, ok := m.backups[id]; ok {
						m.backups[id] = append([]proto.BackupVolume{newBackup(j.Storage, s, now, "", false)}, list...)
					}
				})
			}
		})
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}
	}
	return fail("unsupported", "The simulator does not have this operation.")
}

// applyJob checks a create or update and returns the job it makes.
func (a *simAgent) applyJob(cur proto.BackupJob, s *proto.BackupJobSpec, create bool) (proto.BackupJob, *proto.ManageResponse) {
	refuse := func(field, msg string) (proto.BackupJob, *proto.ManageResponse) {
		r := invalid(field, msg)
		return cur, &r
	}
	if s == nil {
		r := fail("invalid_request", "the backup job is required")
		return cur, &r
	}
	j := cur
	j.Guests, j.Exclude = slices.Clone(cur.Guests), slices.Clone(cur.Exclude)
	if s.Enabled != nil {
		j.Enabled = *s.Enabled
	}
	if s.Schedule != nil {
		if !simScheduleRe.MatchString(*s.Schedule) {
			return refuse("schedule", "value does not match the regex pattern")
		}
		j.Schedule = *s.Schedule
	}
	if s.Storage != nil {
		if !storageOffers(*s.Storage, "backup") {
			return refuse("storage", *s.Storage+" does not hold backups")
		}
		j.Storage = *s.Storage
	}
	if s.Node != nil {
		if !slices.Contains(simNodes, *s.Node) {
			return refuse("node", *s.Node+" is not a node of this cluster")
		}
		j.Node = *s.Node
	}
	if s.Mode != nil {
		if !slices.Contains([]string{"snapshot", "suspend", "stop"}, *s.Mode) {
			return refuse("mode", "must be snapshot, suspend or stop")
		}
		j.Mode = *s.Mode
	}
	if s.Compress != nil {
		if !slices.Contains([]string{"zstd", "lzo", "gzip", "0"}, *s.Compress) {
			return refuse("compress", "must be zstd, lzo, gzip or 0")
		}
		j.Compress = *s.Compress
	}
	if s.Keep != nil {
		k := *s.Keep
		j.Keep = &k
	}
	if s.NotesTemplate != nil {
		j.NotesTemplate = *s.NotesTemplate
	}
	if s.Comment != nil {
		j.Comment = *s.Comment
	}
	if s.Selection != nil {
		if !slices.Contains([]string{proto.BackupSelectAll, proto.BackupSelectGuests, proto.BackupSelectPool}, *s.Selection) {
			return refuse("selection", "must be all, guests or pool")
		}
		if *s.Selection != j.Selection {
			j.Guests, j.Exclude, j.Pool = nil, nil, ""
		}
		j.Selection = *s.Selection
	}
	for field, ids := range map[string][]string{"guests": s.Guests, "exclude": s.Exclude} {
		for _, id := range ids {
			if _, ok := a.host.FindGuest(proto.PlatformPVE, id); !ok && !slices.Contains(cur.Guests, id) && !slices.Contains(cur.Exclude, id) {
				return refuse(field, "there is no guest "+id+" in this cluster")
			}
		}
	}
	switch {
	case s.Guests != nil && j.Selection != proto.BackupSelectGuests:
		return refuse("guests", "guests go with selection guests")
	case s.Exclude != nil && j.Selection != proto.BackupSelectAll:
		return refuse("exclude", "exclude goes with selection all")
	case s.Pool != nil && j.Selection != proto.BackupSelectPool:
		return refuse("pool", "pool goes with selection pool")
	}
	if s.Guests != nil {
		j.Guests = sortedIDs(s.Guests)
	}
	if s.Exclude != nil {
		j.Exclude = sortedIDs(s.Exclude)
	}
	if s.Pool != nil {
		if _, ok := simPools[*s.Pool]; !ok {
			return refuse("pool", "there is no pool "+*s.Pool)
		}
		j.Pool = *s.Pool
	}
	for _, f := range s.Clear {
		switch f {
		case "node":
			j.Node = ""
		case "compress":
			j.Compress = ""
		case "keep":
			j.Keep = nil
		case "notes_template":
			j.NotesTemplate = ""
		case "comment":
			j.Comment = ""
		case "exclude":
			j.Exclude = nil
		default:
			return refuse(f, "cannot be removed")
		}
	}
	switch {
	case create && (j.Schedule == "" || j.Storage == "" || j.Selection == ""):
		return refuse("schedule", "a job needs a schedule, a storage and a selection")
	case j.Selection == proto.BackupSelectGuests && len(j.Guests) == 0:
		return refuse("guests", "choose the guests to back up")
	case j.Selection == proto.BackupSelectPool && j.Pool == "":
		return refuse("pool", "choose the pool to back up")
	}
	return j, nil
}

func sortedIDs(ids []string) []string {
	out := slices.Clone(ids)
	slices.SortFunc(out, func(a, b string) int { x, _ := strconv.Atoi(a); y, _ := strconv.Atoi(b); return x - y })
	return slices.Compact(out)
}

// jobChanges lists what differs between two jobs (as the agent reports it).
func jobChanges(a, b proto.BackupJob) []proto.ConfigChange {
	keep := func(k *proto.BackupKeep) string {
		if k == nil {
			return ""
		}
		b, _ := json.Marshal(k)
		return string(b)
	}
	var out []proto.ConfigChange
	for _, f := range []struct{ key, old, new string }{
		{"enabled", strconv.FormatBool(a.Enabled), strconv.FormatBool(b.Enabled)}, {"schedule", a.Schedule, b.Schedule},
		{"storage", a.Storage, b.Storage}, {"node", a.Node, b.Node}, {"mode", a.Mode, b.Mode}, {"compress", a.Compress, b.Compress},
		{"keep", keep(a.Keep), keep(b.Keep)}, {"notes_template", a.NotesTemplate, b.NotesTemplate}, {"comment", a.Comment, b.Comment},
		{"selection", a.Selection, b.Selection}, {"guests", strings.Join(a.Guests, ","), strings.Join(b.Guests, ",")},
		{"exclude", strings.Join(a.Exclude, ","), strings.Join(b.Exclude, ",")}, {"pool", a.Pool, b.Pool},
	} {
		if f.old != f.new {
			out = append(out, proto.ConfigChange{Key: f.key, Old: f.old, New: f.new})
		}
	}
	return out
}

// simCovers reports whether a job backs up a guest on shale.
func simCovers(j proto.BackupJob, g fakefleet.GuestSpec) bool {
	if !j.Enabled || (j.Node != "" && j.Node != simNode) {
		return false
	}
	switch j.Selection {
	case proto.BackupSelectAll:
		return !slices.Contains(j.Exclude, g.ID)
	case proto.BackupSelectPool:
		return slices.Contains(g.Tags, simPools[j.Pool])
	}
	return slices.Contains(j.Guests, g.ID)
}

// coverage recomputes Guest.BackupJob of shale's guests from the jobs.
func (a *simAgent) coverage(m *manageState) {
	for _, g := range a.host.GuestSpecs(proto.PlatformPVE) {
		if g.Template {
			continue
		}
		covered := slices.ContainsFunc(m.jobs, func(j proto.BackupJob) bool { return simCovers(j, g) })
		a.host.UpdateGuest(proto.PlatformPVE, g.ID, func(s *fakefleet.GuestSpec) { s.BackupJob = &covered })
	}
}
