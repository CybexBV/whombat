package device

import (
	"encoding/json"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// A manager builds one release.UpdateFailureDetail and sends it in its facts and, converted, in its device reports.
func TestUpdateFailureReportConverts(t *testing.T) {
	target := int64(49)
	d := release.UpdateFailureDetail{Stage: release.UpdateJournalStateStaged, Code: "schema_incompatible",
		Reasons: []string{"candidate_cannot_read_schema"}, Release: "pve-20260928.5",
		Schema: &release.UpdateFailureSchema{Database: 48, Target: &target, CandidateWrites: 49,
			CandidateReads: release.IntRange{Min: 49, Max: 49}},
		FailedChecks: []string{}, At: 1790000000}
	r := UpdateFailureReport(d)
	candidate, failure := "pve-20260928.5", "schema_incompatible"
	p := UpdateProgressRequest{Sequence: 1, State: release.UpdateJournalStateFailed, Current: "pve-20260928.4",
		Candidate: &candidate, Failure: &failure, FailedChecks: []string{}, FailureDetail: &r, At: 1790000000}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(p)
	got, err := ParseUpdateProgressRequest(raw)
	if err != nil || got.FailureDetail == nil || got.FailureDetail.Schema.CandidateReads.Min != 49 {
		t.Fatalf("%v %+v", err, got)
	}
	// Strict in a device body: a message never rides along.
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["failureDetail"].(map[string]any)["message"] = "free text"
	raw, _ = json.Marshal(m)
	if _, err := ParseUpdateProgressRequest(raw); err == nil {
		t.Fatal("accepted a failure detail with a message")
	}
}
