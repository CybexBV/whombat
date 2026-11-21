package update

import (
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/health"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// What leaves the box about an update (MG-46, MG-47): the structured failure detail (contracts UpdateFailureDetail)
// for control's device reports and the runtime's facts, and why a staged candidate waits. Codes, ids and numbers
// only — the device report allowlist (contracts device/status.ts): a Failure's Message, the runtime's reasons and
// paths stay in the journal.

// identRe is the contracts' Ident; anything else is left out of a detail.
var identRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// idents keeps the values that are contract idents (at most 8, the detail's limit).
func idents(vs ...string) []string {
	out := []string{}
	for _, v := range vs {
		if identRe.MatchString(v) && len(out) < 8 {
			out = append(out, v)
		}
	}
	return out
}

// liveFloors are the live schema's floors a candidate's exit-0 schema check reported (Whombat MD-12: `target` is the
// database's own schema then, for `current` and `newer_compatible`); nil when it reported none, another schema, or
// floors that can't be a schema's (0 < readers ≤ writers ≤ the database's schema, MG-51): the tuples decide then.
func liveFloors(s *proto.Schema) *release.SchemaFloors {
	if s.Exit != proto.SchemaExitOK || s.Target == nil || s.Target.Version != s.DatabaseVersion {
		return nil
	}
	if t := s.Target; t.Readers <= 0 || t.Readers > t.Writers || t.Writers > s.DatabaseVersion {
		return nil
	}
	return &release.SchemaFloors{Readers: int64(s.Target.Readers), Writers: int64(s.Target.Writers)}
}

// failureSchema is the schema side of a schema_incompatible failure: the live schema, the one the candidate was
// judged at when it must migrate and reported that schema's floors (CheckMigratingActivation; none otherwise: a
// runtime before MD-12 is judged at the live schema, as on 2026-09-28), and the candidate's own schema and reads.
func failureSchema(s *proto.Schema, candidate *release.ReleaseTuple) *release.UpdateFailureSchema {
	fs := &release.UpdateFailureSchema{Database: int64(s.DatabaseVersion), CandidateWrites: candidate.Runtime.SchemaWrites,
		CandidateReads: candidate.Runtime.SchemaReads}
	if s.Exit == proto.SchemaExitMigrationRequired && s.Target != nil {
		t := int64(s.Target.Version)
		fs.Target = &t
	}
	return fs
}

// refusalReason names why the candidate's own schema check refused the database (exit 11 or 12), in the activation
// check's words where there are some.
func refusalReason(s *proto.Schema) string {
	switch {
	case s.Exit == proto.SchemaExitReadOnly:
		return "candidate_read_only"
	case s.Verdict == "newer_incompatible":
		return "candidate_cannot_read_schema"
	case identRe.MatchString(s.Verdict):
		return s.Verdict // foreign, postgres_unsupported, …
	}
	return "schema_refused"
}

// failedChecks names the failed health checks of a verification (the contract's check names).
func failedChecks(ev health.Evidence, host bool) []string {
	out := []string{}
	for _, h := range contractEvidence(ev, host) {
		if !h.Ok && len(out) < 8 {
			out = append(out, h.Check)
		}
	}
	return out
}

var rollbackAccesses = map[string]bool{release.RollbackAccessReadWrite: true, release.RollbackAccessReadOnly: true, release.RollbackAccessNone: true}

// healthChecks are the contract's check names (HEALTH_CHECKS): a detail with another name wouldn't validate, and the
// whole report would be dropped.
var healthChecks = map[string]bool{"runtime": true, "database": true, "session_endpoint": true, "runner": true, "relay_control": true,
	"boot": true, "manager": true}

func checkNames(cs []string) []string {
	out := []string{}
	for _, c := range cs {
		if healthChecks[c] && len(out) < 8 {
			out = append(out, c)
		}
	}
	return out
}

// FailureDetail is the structured detail of the failure the journal reports (the record's failure code: the
// candidate's failure, a rollback in progress, or the last failure while not healthy); nil without one, or for a
// failure recorded before the detail existed with no candidate to name.
func FailureDetail(st *State) *release.UpdateFailureDetail {
	var f *Failure
	id := ""
	if c := st.Candidate; c != nil {
		id, f = c.Tuple.ReleaseID, c.Failure
		if rb := c.Rollback; f == nil && rb != nil {
			f = &Failure{Stage: st.Phase, Code: rb.Code, At: rb.Started, FailedChecks: rb.FailedChecks, RollbackAccess: rb.KGAccess}
			if rb.StepFailures > 0 {
				f.Reasons = []string{"rollback_retrying"} // the way back itself keeps failing (MG-55)
			}
		}
	} else if st.Phase != Healthy {
		f = st.LastFailure
	}
	if f == nil || !identRe.MatchString(f.Code) {
		return nil
	}
	if f.Release != "" {
		id = f.Release
	}
	stage := f.Stage
	if stage == "" {
		stage = st.Phase
	}
	if !trust.ValidReleaseID(id) || !slices.Contains(release.UpdateJournalStateValues, stage) {
		return nil
	}
	d := &release.UpdateFailureDetail{Stage: stage, Code: f.Code, Reasons: idents(f.Reasons...), Release: id,
		FailedChecks: checkNames(f.FailedChecks), At: max(f.At.Unix(), 0)}
	if f.Schema != nil {
		s := *f.Schema
		d.Schema = &s
	}
	access := f.RollbackAccess
	if access == "" {
		access = f.KnownGoodAccess
	}
	if rollbackAccesses[access] {
		d.RollbackAccess = &access
	}
	return d
}

// Waiting is why a staged candidate hasn't activated yet: the reason (a hold, the owner's approval, another component's
// maintenance lock, the maintenance window, a checkpoint it needs, update metadata, or running work at the safe
// boundary), since when it waits, and the running work by kind.
type Waiting struct {
	Reason   release.UpdateWaitReason
	Since    time.Time
	Blockers []WaitBlocker
}

// WaitBlocker counts the running items of one kind the safe boundary waits for.
type WaitBlocker struct {
	Kind  string
	Count int64
}

// WaitingReport is WaitingOf for control's device reports (MG-53, contracts UpdateWaitingReport): the reason and since
// when, no blockers (what runs on the box stays there); nil when nothing waits. An update waiting for the owner's
// approval is reported as a hold: control hears that the box holds it, not why (the owner's business), and control's
// contracts before 4.2 refuse `owner` (Whombat ask-before-updating.md).
func WaitingReport(st *State) *device.UpdateWaitingReport {
	w := WaitingOf(st)
	if w == nil {
		return nil
	}
	reason := w.Reason
	if reason == release.UpdateWaitReasonOwner {
		reason = release.UpdateWaitReasonHold
	}
	return &device.UpdateWaitingReport{Reason: reason, Since: max(w.Since.Unix(), 0)}
}

// WaitingOf reports why the candidate waits (nil when it doesn't: no candidate, not staged or waiting, or nothing
// holds it).
func WaitingOf(st *State) *Waiting {
	c := st.Candidate
	if c == nil || c.Deferral == nil || (st.Phase != Staged && st.Phase != WaitingForSafeBoundary) {
		return nil
	}
	d := c.Deferral
	reason := release.UpdateWaitReason(d.Waiting)
	if d.Waiting == "" && len(d.Blockers) > 0 {
		reason = release.UpdateWaitReasonBoundary
	}
	if !slices.Contains(release.UpdateWaitReasonValues, reason) {
		return nil
	}
	w := &Waiting{Reason: reason, Since: d.Since, Blockers: []WaitBlocker{}}
	counts := map[string]int64{}
	for _, b := range d.Blockers {
		k := b.Kind
		if !identRe.MatchString(k) {
			k = "other"
		}
		counts[k]++
	}
	for k, n := range counts {
		w.Blockers = append(w.Blockers, WaitBlocker{Kind: k, Count: n})
	}
	sort.Slice(w.Blockers, func(i, j int) bool { return w.Blockers[i].Kind < w.Blockers[j].Kind })
	if len(w.Blockers) > 16 {
		w.Blockers = w.Blockers[:16]
	}
	return w
}
