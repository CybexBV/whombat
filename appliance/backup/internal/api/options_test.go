package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// The policy (BK-37): the recommended one until set; a set one is strict and comes back as written.
func TestPolicyRoutes(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	code, p := call(t, hc, "GET", "/v1/policy", "")
	if code != 200 || p["frequency"] != "6h" || p["weeklyCheck"] != true {
		t.Fatalf("default: %d %v", code, p)
	}
	body := `{"v":1,"frequency":"hourly","timeZone":"Europe/Amsterdam","keep":{"allDays":2,"dailyDays":14,"weeklyWeeks":8,"monthlyMonths":12},"limitBytes":50000000000,"weeklyCheck":false}`
	if code, p := call(t, hc, "PUT", "/v1/policy", body); code != 200 || p["frequency"] != "hourly" {
		t.Fatalf("put: %d %v", code, p)
	}
	if got := state.LoadPolicy(c); got.Frequency != "hourly" || got.WeeklyCheck || got.LimitBytes == nil {
		t.Fatalf("saved: %+v", got)
	}
	for _, bad := range []string{
		`{"v":1,"frequency":"weekly","timeZone":"UTC","keep":{"allDays":2,"dailyDays":0,"weeklyWeeks":0,"monthlyMonths":0},"limitBytes":null,"weeklyCheck":true}`,
		`{"v":1,"frequency":"6h","timeZone":"Mars/Base","keep":{"allDays":2,"dailyDays":0,"weeklyWeeks":0,"monthlyMonths":0},"limitBytes":null,"weeklyCheck":true}`,
		`{"v":1,"frequency":"6h","timeZone":"UTC","keep":{"allDays":0,"dailyDays":0,"weeklyWeeks":0,"monthlyMonths":0},"limitBytes":null,"weeklyCheck":true}`,
		`{"v":1,"frequency":"6h","timeZone":"UTC","keep":{"allDays":2,"dailyDays":0,"weeklyWeeks":0,"monthlyMonths":0},"limitBytes":5,"weeklyCheck":true}`,
		`{"v":1,"frequency":"6h","timeZone":"UTC","keep":{"allDays":2,"dailyDays":0,"weeklyWeeks":0,"monthlyMonths":0},"limitBytes":null,"weeklyCheck":true,"extra":1}`,
	} {
		if code, _ := call(t, hc, "PUT", "/v1/policy", bad); code != 400 {
			t.Fatalf("%s: %d", bad, code)
		}
	}
	other, _ := serve(t, os.Getuid()+1)
	if code, _ := call(t, other, "PUT", "/v1/policy", body); code != 403 {
		t.Fatalf("another uid: %d", code)
	}
}

// Where a restore is: none on a box that never restored; a check request needs a destination.
func TestRestoreStateAndDrillRequest(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	code, st := call(t, hc, "GET", "/v1/quarantine", "")
	if code != 200 || st["phase"] != "none" {
		t.Fatalf("%d %v", code, st)
	}
	if code, _ := call(t, hc, "POST", "/v1/drills", `{"checkpointId":"ck-1","own":true}`); code != 412 {
		t.Fatalf("unprotected drill: %d", code)
	}
	if err := state.SaveDestination(c, &state.Destination{Kind: "rest", Repository: "rest:http://10.0.0.2:8000/x/", RepositoryID: "r"}); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, hc, "POST", "/v1/drills", `{"checkpointId":"ck-1","own":false}`); code != 202 {
		t.Fatalf("drill: %d", code)
	}
	if _, err := os.Stat(filepath.Join(c.StateDir, "drill-request.json")); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, hc, "POST", "/v1/drills", `{"checkpointId":"../x"}`); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	// A restore that failed is said once its marker was archived.
	_ = state.WriteJSON(filepath.Join(c.StateDir, "restore-result.json"), map[string]any{"at": time.Now().UTC(), "ok": false, "checkpointId": "ck-1", "reason": "newer", "error": "made by a newer Whombat"}, 0o644)
	if _, st := call(t, hc, "GET", "/v1/quarantine", ""); st["phase"] != "failed" || st["error"] != "made by a newer Whombat" {
		t.Fatalf("%v", st)
	}
}

// A released restore keeps the time it had while it waited for the answers (the runtime knows a restore by it across
// the release); the release takes the runtime's optional body, refuses another restore's checkpoint and ignores the
// rest; a later failed attempt is what the state says after.
func TestReleaseKeepsTheRestoresSince(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	began := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	m := quarantine.Marker{Kind: quarantine.Kind, Phase: quarantine.PhaseQuarantined, Since: began, Items: []quarantine.Item{}}
	m.Restored.CheckpointID = "ck-7"
	m.OldAppliance.ApplianceID = "apl-old"
	if err := state.WriteJSON(quarantine.Path(c), m, 0o644); err != nil {
		t.Fatal(err)
	}
	// The app's restore wrote its result when the backup was in place, a little after it began.
	_ = state.WriteJSON(filepath.Join(c.StateDir, "restore-result.json"), map[string]any{"at": began.Add(5 * time.Minute), "ok": true, "checkpointId": "ck-7"}, 0o644)
	_, st := call(t, hc, "GET", "/v1/quarantine", "")
	if st["phase"] != "checking" || st["since"] != began.Format(time.RFC3339) {
		t.Fatalf("checking: %v", st)
	}
	if code, _ := call(t, hc, "POST", "/v1/quarantine/release", `{"oldWhombat":"gone","checkpointId":"ck-other"}`); code != 409 {
		t.Fatalf("another restore's checkpoint: %d", code)
	}
	if code, _ := call(t, hc, "POST", "/v1/quarantine/release", `not json`); code != 400 {
		t.Fatalf("a body that isn't JSON: %d", code)
	}
	code, st := call(t, hc, "POST", "/v1/quarantine/release", `{"oldWhombat":"lost","checkpointId":"ck-7","later":true}`)
	if code != 200 || st["phase"] != "released" || st["since"] != began.Format(time.RFC3339) || st["oldApplianceId"] != "apl-old" {
		t.Fatalf("released: %d %v", code, st)
	}
	if rel := quarantine.LastReleased(c); rel == nil || rel.ReleasedAt == nil || rel.Since != began {
		t.Fatalf("archived %+v", rel)
	}
	// A later attempt that failed is what the state says now.
	_ = state.WriteJSON(filepath.Join(c.StateDir, "restore-result.json"), map[string]any{"at": time.Now().UTC().Add(time.Minute), "ok": false, "checkpointId": "ck-8", "error": "Whombat couldn’t reach “the NAS”.\nTry again."}, 0o644)
	if _, st := call(t, hc, "GET", "/v1/quarantine", ""); st["phase"] != "failed" || st["error"] != "Whombat couldn’t reach “the NAS”. Try again." {
		t.Fatalf("failed after: %v", st)
	}
}

// A release without a body, as older runtimes send it, still works.
func TestReleaseWithoutABody(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	m := quarantine.Marker{Kind: quarantine.Kind, Phase: quarantine.PhaseQuarantined, Since: time.Now().UTC(), Items: []quarantine.Item{}}
	if err := state.WriteJSON(quarantine.Path(c), m, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, st := call(t, hc, "POST", "/v1/quarantine/release", ""); code != 200 || st["phase"] != "released" {
		t.Fatalf("%d %v", code, st)
	}
}

// A failed restore says its reason and the person's sentence where the runtime reads them, never the technical detail:
// a power cut is `interrupted`; a restore that stopped part-way says so in plain words, or the words of its own
// attempt, never the marker's technical error.
func TestFailedRestoreSaysItsReasonNotItsDetail(t *testing.T) {
	hc, c := serve(t, os.Getuid())
	plain := "This Whombat restarted before the restore finished, so it was put back as it was. Try again."
	_ = state.WriteJSON(quarantine.ResultPath(c), quarantine.Result{At: time.Now().UTC(), CheckpointID: "ck-1",
		Reason: quarantine.ReasonInterrupted, Error: plain, Detail: "pg_restore: exit status 1 at /persist/x"}, 0o644)
	_, st := call(t, hc, "GET", "/v1/quarantine", "")
	if st["phase"] != "failed" || st["reason"] != "interrupted" || st["error"] != plain {
		t.Fatalf("interrupted: %v", st)
	}
	if _, ok := st["detail"]; ok {
		t.Fatalf("the detail is in the state: %v", st)
	}

	// The undo of a cut restore failed too: the marker keeps the box in quarantine with technical words.
	began := time.Now().UTC().Add(time.Minute)
	m := quarantine.Marker{Kind: quarantine.Kind, Phase: quarantine.PhaseRestoring, Since: began,
		Error: "putting this Whombat back as it was before the restore failed: rename /persist/home: EBUSY", Items: []quarantine.Item{}}
	if err := state.WriteJSON(quarantine.Path(c), m, 0o644); err != nil {
		t.Fatal(err)
	}
	_, st = call(t, hc, "GET", "/v1/quarantine", "")
	if st["phase"] != "failed" || st["reason"] != "failed" || st["error"] != stoppedPartWay {
		t.Fatalf("an earlier attempt's words, or the marker's: %v", st)
	}
	again := "This Whombat restarted before the restore finished, and putting it back as it was didn't finish either."
	_ = state.WriteJSON(quarantine.ResultPath(c), quarantine.Result{At: began.Add(time.Second), CheckpointID: "ck-1",
		Reason: quarantine.ReasonInterrupted, Error: again, Detail: "rename /persist/home: EBUSY"}, 0o644)
	_, st = call(t, hc, "GET", "/v1/quarantine", "")
	if st["phase"] != "failed" || st["reason"] != "interrupted" || st["error"] != again {
		t.Fatalf("this attempt's words: %v", st)
	}

	// Nothing failed: no reason.
	_ = os.Remove(quarantine.Path(c))
	_ = state.WriteJSON(quarantine.ResultPath(c), quarantine.Result{At: time.Now().UTC(), OK: true, CheckpointID: "ck-1"}, 0o644)
	if _, st := call(t, hc, "GET", "/v1/quarantine", ""); st["phase"] != "released" || st["reason"] != nil || st["error"] != nil {
		t.Fatalf("ok: %v", st)
	}
}
