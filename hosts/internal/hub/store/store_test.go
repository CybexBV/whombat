package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/checks"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

var ctx = context.Background()

func TestBackfillDedupe(t *testing.T) {
	s := openTest(t)
	base := int64(1_800_000_000)
	var batch []Sample
	for i := 0; i < 10; i++ {
		batch = append(batch, Sample{TS: base + int64(i)*10, Values: map[string]float64{"cpu_pct": float64(i), "mem_pct": 50}})
	}
	n, minTS, err := s.InsertSamples(ctx, "basalt", batch)
	if err != nil || n != 20 || minTS != base {
		t.Fatalf("insert: n=%d min=%d err=%v", n, minTS, err)
	}
	// The same samples again (a backfill overlapping what the hub already has)
	// plus two new ones: only the new ones are stored, existing values win.
	again := append([]Sample{}, batch...)
	again[0] = Sample{TS: base, Values: map[string]float64{"cpu_pct": 99}}
	again = append(again, Sample{TS: base + 100, Values: map[string]float64{"cpu_pct": 1, "mem_pct": 2}})
	n, _, err = s.InsertSamples(ctx, "basalt", again)
	if err != nil || n != 2 {
		t.Fatalf("re-insert: n=%d err=%v", n, err)
	}
	var cnt int
	var v float64
	s.r.QueryRow(`SELECT COUNT(*) FROM metrics_raw`).Scan(&cnt)
	s.r.QueryRow(`SELECT value FROM metrics_raw WHERE ts = ? AND series_id = (SELECT id FROM series WHERE name='cpu_pct')`, base).Scan(&v)
	if cnt != 22 || v != 0 {
		t.Fatalf("rows=%d first value=%v", cnt, v)
	}
	// NaN values are dropped.
	n, _, _ = s.InsertSamples(ctx, "basalt", []Sample{{TS: base + 200, Values: map[string]float64{"cpu_pct": math.NaN()}}})
	if n != 0 {
		t.Error("NaN stored")
	}
}

// seed writes raw 10 s samples for [from, to) with value f(ts).
func seed(t *testing.T, s *Store, server, name string, from, to int64, f func(ts int64) float64) {
	t.Helper()
	var batch []Sample
	for ts := from; ts < to; ts += 10 {
		batch = append(batch, Sample{TS: ts, Values: map[string]float64{name: f(ts)}})
		if len(batch) == 2000 {
			if _, _, err := s.InsertSamples(ctx, server, batch); err != nil {
				t.Fatal(err)
			}
			batch = nil
		}
	}
	if _, _, err := s.InsertSamples(ctx, server, batch); err != nil {
		t.Fatal(err)
	}
}

func TestRollupKeepsAvgMaxCount(t *testing.T) {
	s := openTest(t)
	now := time.Unix(1_800_000_000-1_800_000_000%900, 0) // aligned to 15 min
	from := now.Add(-2 * time.Hour).Unix()
	// Constant 20% with one 10 s spike to 97% (shorter than any bucket).
	spike := now.Add(-37 * time.Minute).Unix()
	spike -= spike % 10
	seed(t, s, "h", "cpu_pct", from, now.Unix(), func(ts int64) float64 {
		if ts == spike {
			return 97
		}
		return 20
	})
	if err := s.Rollup(ctx, from, now.Unix()); err != nil {
		t.Fatal(err)
	}
	var avg, max float64
	var count int64
	m := spike - spike%60
	s.r.QueryRow(`SELECT avg, max, count FROM metrics_1m WHERE ts = ?`, m).Scan(&avg, &max, &count)
	if count != 6 || max != 97 || math.Abs(avg-(20*5+97)/6.0) > 1e-9 {
		t.Errorf("1m bucket: avg=%v max=%v count=%v", avg, max, count)
	}
	q := spike - spike%900
	s.r.QueryRow(`SELECT avg, max, count FROM metrics_15m WHERE ts = ?`, q).Scan(&avg, &max, &count)
	if count != 90 || max != 97 || math.Abs(avg-(20*89+97)/90.0) > 1e-9 {
		t.Errorf("15m bucket: avg=%v max=%v count=%v", avg, max, count)
	}
	// Rollup is idempotent.
	if err := s.Rollup(ctx, from, now.Unix()); err != nil {
		t.Fatal(err)
	}
	s.r.QueryRow(`SELECT count FROM metrics_15m WHERE ts = ?`, q).Scan(&count)
	if count != 90 {
		t.Errorf("rollup not idempotent: count=%d", count)
	}

	// Peak over 24h (served from the 1 min tier) is the true maximum, not the
	// maximum of the plotted averages.
	res, err := s.QueryMetrics(ctx, "h", []string{"cpu_pct"}, Ranges["24h"], now)
	if err != nil {
		t.Fatal(err)
	}
	sm := res.Summary["cpu_pct"]
	if sm == nil || sm.Max != 97 {
		t.Fatalf("summary = %+v", sm)
	}
	if sm.MaxAt.Unix() != m {
		t.Errorf("max_at = %v, want start of the 1 min bucket %v", sm.MaxAt, time.Unix(m, 0).UTC())
	}
	var plottedMax float64
	for _, v := range res.Series["cpu_pct"] {
		if v != nil && *v > plottedMax {
			plottedMax = *v
		}
	}
	if plottedMax >= 97 || plottedMax < 20 {
		t.Errorf("plotted max %v should be an average below the spike", plottedMax)
	}
	// 1h is served from raw samples: exact max_at.
	res, _ = s.QueryMetrics(ctx, "h", []string{"cpu_pct"}, Ranges["1h"], now)
	if sm := res.Summary["cpu_pct"]; sm == nil || sm.Max != 97 || sm.MaxAt.Unix() != spike {
		t.Errorf("1h summary = %+v", sm)
	}
}

func TestBackfillRecomputesRollups(t *testing.T) {
	s := openTest(t)
	now := time.Unix(1_800_000_000-1_800_000_000%900, 0)
	from := now.Add(-time.Hour).Unix()
	seed(t, s, "h", "cpu_pct", from, now.Unix(), func(int64) float64 { return 10 })
	s.Rollup(ctx, from, now.Unix())
	// A gap filled later by backfill: rollup the affected window again.
	gapFrom := now.Add(-30 * time.Minute).Unix()
	s.w.Exec(`DELETE FROM metrics_raw WHERE ts >= ? AND ts < ?`, gapFrom, gapFrom+300)
	s.w.Exec(`DELETE FROM metrics_1m`)
	s.w.Exec(`DELETE FROM metrics_15m`)
	s.Rollup(ctx, from, now.Unix())
	var count int64
	s.r.QueryRow(`SELECT SUM(count) FROM metrics_1m`).Scan(&count)
	if count != 360-30 {
		t.Fatalf("count before backfill = %d", count)
	}
	var bf []Sample
	for ts := gapFrom; ts < gapFrom+300; ts += 10 {
		bf = append(bf, Sample{TS: ts, Values: map[string]float64{"cpu_pct": 10}})
	}
	_, minTS, _ := s.InsertSamples(ctx, "h", bf)
	s.Rollup(ctx, minTS, now.Unix())
	s.r.QueryRow(`SELECT SUM(count) FROM metrics_1m`).Scan(&count)
	if count != 360 {
		t.Errorf("count after backfill = %d", count)
	}
	s.r.QueryRow(`SELECT SUM(count) FROM metrics_15m`).Scan(&count)
	if count != 360 {
		t.Errorf("15m count after backfill = %d", count)
	}
}

func TestResolutionPerRange(t *testing.T) {
	s := openTest(t)
	now := time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)
	want := map[string]struct {
		step   int64
		points int
		tier   Tier
	}{
		"1h": {60, 60, TierRaw}, "6h": {300, 72, TierRaw}, "24h": {900, 96, Tier1m},
		"7d": {7200, 84, Tier1m}, "30d": {21600, 120, Tier15m},
	}
	for name, w := range want {
		spec := Ranges[name]
		if spec.Step != w.step || spec.Points != w.points || spec.Tier != w.tier {
			t.Errorf("%s: %+v", name, spec)
		}
		if int64(spec.Dur/time.Second) != spec.Step*int64(spec.Points) {
			t.Errorf("%s: points x step != range", name)
		}
		res, err := s.QueryMetrics(ctx, "x", []string{"cpu_pct"}, spec, now.Add(7*time.Minute+13*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		ends := res.Grid.Ends()
		if len(ends) != w.points || len(res.Series["cpu_pct"]) != w.points {
			t.Errorf("%s: %d points", name, len(ends))
		}
		asOf := now.Add(7*time.Minute + 13*time.Second)
		if last := ends[len(ends)-1]; !last.Equal(asOf) {
			t.Errorf("%s: last timestamp %v must be as_of (partial current bucket)", name, last)
		}
		for i, e := range ends[:len(ends)-1] {
			if e.Unix()%w.step != 0 || (i > 0 && e.Sub(ends[i-1]) != time.Duration(w.step)*time.Second) {
				t.Errorf("%s: timestamp %d (%v) not step-aligned", name, i, e)
				break
			}
		}
		if res.Summary["cpu_pct"] != nil {
			t.Errorf("%s: summary of unknown series must be null", name)
		}
	}
	// The 24h fixture grid: as_of 14:00 -> first 14:15 the day before.
	g := GridFor(now, 24*time.Hour, 96)
	if e := g.Ends(); e[0] != time.Date(2026, 10, 10, 14, 15, 0, 0, time.UTC) || e[95] != now {
		t.Errorf("24h grid = %v .. %v", e[0], e[95])
	}
}

func TestTiersGiveIdenticalAverages(t *testing.T) {
	s := openTest(t)
	now := time.Unix(1_800_000_000-1_800_000_000%21600, 0)
	from := now.Add(-26 * time.Hour).Unix()
	seed(t, s, "h", "cpu_pct", from, now.Unix(), func(ts int64) float64 {
		return 40 + 30*math.Sin(float64(ts)/3000) + float64(ts%7)
	})
	s.Rollup(ctx, from, now.Unix())
	ids, _ := s.SeriesNames(ctx, "h")
	id := ids["cpu_pct"]
	g := GridFor(now, 24*time.Hour, 96)
	raw, _ := s.Buckets(ctx, TierRaw, []int64{id}, g.Start, g.Step, g.N)
	m1, _ := s.Buckets(ctx, Tier1m, []int64{id}, g.Start, g.Step, g.N)
	m15, _ := s.Buckets(ctx, Tier15m, []int64{id}, g.Start, g.Step, g.N)
	for i := range raw[id] {
		r, a, b := raw[id][i], m1[id][i], m15[id][i]
		if r.Count != a.Count || r.Count != b.Count || r.Max != a.Max || r.Max != b.Max ||
			math.Abs(r.Avg()-a.Avg()) > 1e-9 || math.Abs(r.Avg()-b.Avg()) > 1e-9 {
			t.Fatalf("bucket %d: raw %+v 1m %+v 15m %+v", i, r, a, b)
		}
	}
}

func TestRetention(t *testing.T) {
	s := openTest(t)
	now := time.Unix(1_800_000_000, 0)
	old := now.Add(-25 * time.Hour).Unix()
	s.InsertSamples(ctx, "h", []Sample{{TS: old, Values: map[string]float64{"cpu_pct": 1}}, {TS: now.Unix() - 10, Values: map[string]float64{"cpu_pct": 2}}})
	s.Rollup(ctx, old, now.Unix())
	if err := s.Retention(ctx, now); err != nil {
		t.Fatal(err)
	}
	var raw, m1 int
	s.r.QueryRow(`SELECT COUNT(*) FROM metrics_raw`).Scan(&raw)
	s.r.QueryRow(`SELECT COUNT(*) FROM metrics_1m`).Scan(&m1)
	if raw != 1 || m1 != 2 {
		t.Errorf("raw=%d 1m=%d", raw, m1)
	}
}

func TestAuditAppendOnly(t *testing.T) {
	s := openTest(t)
	rec := AuditRecord{ID: "au_1", At: time.Now(), User: "john", Event: "console.opened", Outcome: "ok", Details: map[string]string{"session_id": "cs_1"}}
	if err := s.AppendAudit(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := s.w.Exec(`UPDATE audit SET user = 'mallory'`); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Errorf("update allowed: %v", err)
	}
	if _, err := s.w.Exec(`DELETE FROM audit`); err == nil {
		t.Error("delete of a young record allowed")
	}
	for i := 2; i <= 5; i++ {
		s.AppendAudit(ctx, AuditRecord{ID: "au_" + string(rune('0'+i)), At: time.Now(), Event: "action.requested", Outcome: "ok"})
	}
	page, next, err := s.ListAudit(ctx, 3, 0, AuditFilter{})
	if err != nil || len(page) != 3 || next == 0 || page[0].ID != "au_5" {
		t.Fatalf("page1 = %d next=%d err=%v", len(page), next, err)
	}
	page2, next2, _ := s.ListAudit(ctx, 3, next, AuditFilter{})
	if len(page2) != 2 || next2 != 0 || page2[1].ID != "au_1" || page2[1].Details["session_id"] != "cs_1" {
		t.Fatalf("page2 = %+v next=%d", page2, next2)
	}
	f, _, _ := s.ListAudit(ctx, 10, 0, AuditFilter{Event: "console."})
	if len(f) != 1 {
		t.Errorf("prefix filter: %d", len(f))
	}
}

func TestEnrollmentSingleUse(t *testing.T) {
	s := openTest(t)
	now := time.Now()
	if err := s.CreateEnrollment(ctx, "en_1", []byte("hash"), "john", now, now.Add(time.Hour), EnrollSettings{}); err != nil {
		t.Fatal(err)
	}
	e, err := s.ClaimEnrollment(ctx, []byte("hash"), now, EnrollRequest{Hostname: "thetitan"}, []byte("poll"))
	if err != nil || e.State != EnrollPending || e.Hostname != "thetitan" {
		t.Fatalf("claim: %+v %v", e, err)
	}
	if _, err := s.ClaimEnrollment(ctx, []byte("hash"), now, EnrollRequest{}, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("second claim: %v", err)
	}
	s.CreateEnrollment(ctx, "en_2", []byte("hash2"), "john", now.Add(-2*time.Hour), now.Add(-time.Hour), EnrollSettings{})
	if _, err := s.ClaimEnrollment(ctx, []byte("hash2"), now, EnrollRequest{}, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired claim: %v", err)
	}
	srv := Server{ID: "thetitan", Hostname: "thetitan", Group: "Lab", CertSerial: "01", CertNotAfter: now.Add(time.Hour), CreatedAt: now}
	if err := s.ApproveEnrollment(ctx, "en_1", srv, []byte("PEM"), "john", now); err != nil {
		t.Fatal(err)
	}
	if err := s.ApproveEnrollment(ctx, "en_1", srv, []byte("PEM"), "john", now); !errors.Is(err, ErrNotFound) {
		t.Errorf("double approve: %v", err)
	}
	got, _ := s.GetServer(ctx, "thetitan")
	if got.RCConsole || got.RCPower || got.Group != "Lab" {
		t.Errorf("new server = %+v (remote control must be off)", got)
	}

	// Whombat's settings ride along, and the server gets the switches it is
	// approved with.
	set := EnrollSettings{Approve: true, Control: "operate", Name: "pve-03", Group: "Rack"}
	if err := s.CreateEnrollment(ctx, "en_3", []byte("hash3"), "john", now, now.Add(time.Hour), set); err != nil {
		t.Fatal(err)
	}
	e, err = s.ClaimEnrollment(ctx, []byte("hash3"), now, EnrollRequest{Hostname: "pve"}, []byte("poll"))
	if err != nil || e.EnrollSettings != set {
		t.Fatalf("claim with settings: %+v %v", e, err)
	}
	srv = Server{ID: "pve-03", Hostname: "pve", Group: "Rack", CertSerial: "02", CertNotAfter: now.Add(time.Hour), CreatedAt: now,
		RCConsole: true, RCPower: true, RCDiagnose: true}
	if err := s.ApproveEnrollment(ctx, "en_3", srv, []byte("PEM"), "john", now); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetServer(ctx, "pve-03")
	if !got.RCConsole || !got.RCPower || got.RCHostShell || got.RCHostPower || got.RCManage || !got.RCDiagnose {
		t.Errorf("approved switches = %+v", got)
	}
	if list, _ := s.ListEnrollments(ctx, EnrollApproved); len(list) != 2 || list[0].EnrollSettings != set && list[1].EnrollSettings != set {
		t.Errorf("list = %+v", list)
	}
}

func TestAlertsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hub.db")
	openHub := func() *Store {
		t.Helper()
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}
	s := openHub()
	now := time.Now().Truncate(time.Millisecond).UTC()
	a := rules.Alert{ID: "al_1", Server: "basalt", Key: "disk.wear_high:nvme1n1", Rule: rules.RuleWearHigh, Entity: "nvme1n1",
		Severity: "warning", Text: rules.Text{Title: "nvme1n1 wear at 78%", Detail: "936 of 1,200 TBW written", Code: "disk.wear_high.tbw",
			Params: map[string]any{"device": "nvme1n1", "pct": 78.1, "ratedTbw": 1200.0, "customLimit": false,
				"count": 2, "exactCount": int64(9007199254740993), "names": []string{"one", "two"}}},
		State: rules.AlertOpen, OpenedAt: now}
	if err := s.InsertAlert(ctx, a); err != nil {
		t.Fatal(err)
	}
	// Only one open alert per key.
	b := a
	b.ID = "al_2"
	if err := s.InsertAlert(ctx, b); err == nil {
		t.Error("duplicate open key accepted")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openHub()
	open, err := s.ListAlerts(ctx, rules.AlertOpen, 0)
	if err != nil || len(open) != 1 || !a.Text.Equal(open[0].Text) {
		t.Fatalf("reopened alerts = %+v, err = %v", open, err)
	}
	if open[0].Params["exactCount"] != int64(9007199254740993) {
		t.Fatalf("large integer lost precision: %v", open[0].Params)
	}
	r := now.Add(time.Minute)
	a.State, a.ResolvedAt = rules.AlertResolved, &r
	a.Code = "disk.wear_high.written"
	a.Params = map[string]any{"device": "nvme1n1", "pct": 79.4, "writtenTb": 950.0}
	if err := s.UpdateAlert(ctx, a); err != nil {
		t.Fatal(err)
	}
	all, err := s.QueryAlerts(ctx, AlertFilter{State: rules.AlertResolved})
	if err != nil || len(all) != 1 || all[0].State != rules.AlertResolved || !all[0].ResolvedAt.Equal(r) || !all[0].Text.Equal(a.Text) {
		t.Errorf("alerts = %+v, err = %v", all, err)
	}
}

func TestMalformedAlertParamsKeepEnglishText(t *testing.T) {
	s := openTest(t)
	a := rules.Alert{
		ID: "al_1", Server: "server-1", Key: "disk.wear_high:nvme1n1", Rule: rules.RuleWearHigh,
		Entity: "nvme1n1", Severity: "warning", State: rules.AlertOpen, OpenedAt: time.Now(), StatusNote: "disk wear",
		Text: rules.Text{
			Title: "nvme1n1 wear at 78%", Detail: "936 of 1,200 TBW written",
			Code: "disk.wear_high.tbw", Params: map[string]any{"pct": 78},
		},
	}
	if err := s.InsertAlert(ctx, a); err != nil {
		t.Fatal(err)
	}
	b := a
	b.ID, b.Key, b.Entity = "al_2", "disk.wear_high:nvme2n1", "nvme2n1"
	if err := s.InsertAlert(ctx, b); err != nil {
		t.Fatal(err)
	}
	check := func(alerts []rules.Alert, err error) {
		t.Helper()
		if err != nil || len(alerts) != 2 {
			t.Fatalf("alerts = %+v, err = %v", alerts, err)
		}
		for _, alert := range alerts {
			if alert.ID == a.ID {
				if alert.Params != nil || alert.Code != "" || alert.Title != a.Title || alert.Detail != a.Detail || alert.StatusNote != a.StatusNote {
					t.Errorf("corrupted alert did not keep its English text: %+v", alert)
				}
			} else if !alert.Text.Equal(b.Text) {
				t.Errorf("valid alert lost its text or params: %+v", alert)
			}
		}
	}
	for _, raw := range []string{`{"pct":`, `{"pct":78} trailing data`} {
		if _, err := s.w.ExecContext(ctx, `UPDATE alerts SET params = ? WHERE id = ?`, raw, a.ID); err != nil {
			t.Fatal(err)
		}
		check(s.ListAlerts(ctx, rules.AlertOpen, 0))
		check(s.QueryAlerts(ctx, AlertFilter{State: rules.AlertOpen}))
	}
}

// The hourly retention once asked for records older than 365 days while
// the trigger protects anything younger than 366 days: one record in that
// day aborted the whole delete, forever. The store clamps the cut-off.
func TestAuditRetentionNeverHitsTheTrigger(t *testing.T) {
	s := openTest(t)
	now := time.Now()
	day := 24 * time.Hour
	for i, age := range []time.Duration{10 * day, 365*day + 12*time.Hour, 366*day + 6*time.Hour, 400 * day} {
		rec := AuditRecord{ID: "au_" + string(rune('a'+i)), At: now.Add(-age), Event: "auth.login", Outcome: "ok"}
		if err := s.AppendAudit(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	// Asking for the old 365-day cut-off must not fail and must keep every
	// record younger than 367 days.
	if err := s.DeleteAuditBefore(ctx, now.Add(-365*day), now); err != nil {
		t.Fatalf("retention failed: %v", err)
	}
	var ids []string
	rows, err := s.r.Query(`SELECT id FROM audit ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if strings.Join(ids, ",") != "au_a,au_b,au_c" {
		t.Fatalf("kept %v, want the three records younger than 367 days", ids)
	}
}

// Opening a database from an older schema migrates it and keeps a snapshot
// of the version before (at most three snapshots).
func TestMigrationKeepsSnapshot(t *testing.T) {
	strict := append([]string(nil), migrations...)
	path := filepath.Join(t.TempDir(), "hub.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	for i := 0; i < 5; i++ {
		// A newer build with one more migration opens the database.
		strict = append(strict, fmt.Sprintf("CREATE TABLE test_migration_%d (x INTEGER)", i))
		s, err := open(path, strict, additiveMigrations)
		if err != nil {
			t.Fatal(err)
		}
		s.Close()
		time.Sleep(5 * time.Millisecond)
	}
	m, _ := filepath.Glob(path + ".pre-v*.bak")
	if len(m) != 3 {
		t.Fatalf("snapshots: %v", m)
	}
}

func TestAdditiveMigrationsAllowRollback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hub.db")
	openHub := func(strict []string, additive []additiveMigration) *Store {
		t.Helper()
		s, err := open(path, strict, additive)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}
	writeOldCheck := func(s *Store, id, name string, at time.Time) {
		t.Helper()
		if _, err := s.w.ExecContext(ctx, `INSERT INTO checks(id, name, kind, created_by, created_at)
			VALUES (?, ?, 'http', 'john', ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`, id, name, ms(at)); err != nil {
			t.Fatal(err)
		}
	}

	const previousVersion = 14
	at := time.Date(2026, 11, 21, 9, 30, 0, 0, time.UTC)
	changedAt := at.Add(time.Hour)
	rollbackAt := at.Add(2 * time.Hour)
	old := openHub(migrations[:previousVersion], nil)
	writeOldCheck(old, "ck_1", "Website", at)
	if _, err := old.w.ExecContext(ctx, `INSERT INTO alerts(id, server_id, key, rule, entity, severity, title, detail, state, opened_at)
		VALUES ('al_legacy', 'basalt', 'disk.space_high:fs:/', 'disk.space_high', 'fs:/', 'warning', 'Disk full', '', 'open', ?)`, ms(at)); err != nil {
		t.Fatal(err)
	}
	old.Close()

	upgraded := openHub(migrations, additiveMigrations)
	alerts, err := upgraded.ListAlerts(ctx, rules.AlertOpen, 0)
	if err != nil || len(alerts) != 1 || alerts[0].Title != "Disk full" || alerts[0].Code != "" || alerts[0].Params != nil {
		t.Fatalf("migrated alerts: %+v, %v", alerts, err)
	}
	var v int
	if err := upgraded.r.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v != previousVersion {
		t.Fatalf("user_version = %d (%v), want %d", v, err, previousVersion)
	}
	checks, err := upgraded.ListChecks(ctx)
	if err != nil || len(checks) != 1 || !checks[0].ProbeChangedAt.Equal(at) {
		t.Fatalf("migrated checks: %+v, %v", checks, err)
	}
	var storedAt int64
	if err := upgraded.r.QueryRowContext(ctx, `SELECT probe_changed_at FROM checks WHERE id = 'ck_1'`).Scan(&storedAt); err != nil || storedAt != ms(at) {
		t.Fatalf("backfilled probe time = %d (%v), want %d", storedAt, err, ms(at))
	}
	check := checks[0]
	check.Owner, check.ProbeRev, check.ProbeChangedAt = "whombat:connection:example", "abc", changedAt
	// Ownership is set on creation, so set it here before the rollback.
	if _, err := upgraded.w.ExecContext(ctx, `UPDATE checks SET owner = ? WHERE id = ?`, check.Owner, check.ID); err != nil {
		t.Fatal(err)
	}
	if err := upgraded.PutCheck(ctx, check); err != nil {
		t.Fatal(err)
	}
	appliedAt := func(s *Store, m additiveMigration) int64 {
		t.Helper()
		var recorded int64
		if err := s.r.QueryRowContext(ctx, `SELECT applied_at FROM additive_migrations WHERE id = ?`, m.id).Scan(&recorded); err != nil || recorded <= 0 {
			t.Fatalf("applied %s at %d: %v", m.id, recorded, err)
		}
		return recorded
	}
	firstApplied := make(map[string]int64)
	for _, m := range additiveMigrations {
		firstApplied[m.id] = appliedAt(upgraded, m)
	}
	upgraded.Close()

	// The previous hub opens the same file, using only its strict list.
	rolledBack := openHub(migrations[:previousVersion], nil)
	var name string
	if err := rolledBack.r.QueryRowContext(ctx, `SELECT name FROM checks WHERE id = 'ck_1'`).Scan(&name); err != nil || name != "Website" {
		t.Fatalf("old read = %q, %v", name, err)
	}
	writeOldCheck(rolledBack, "ck_1", "Website renamed", rollbackAt)
	writeOldCheck(rolledBack, "ck_2", "Another website", rollbackAt)
	rolledBack.Close()

	upgraded = openHub(migrations, additiveMigrations)
	for _, m := range additiveMigrations {
		if got := appliedAt(upgraded, m); got != firstApplied[m.id] {
			t.Fatalf("migration %s ran again: %d, was %d", m.id, got, firstApplied[m.id])
		}
	}
	checks, err = upgraded.ListChecks(ctx)
	if err != nil || len(checks) != 2 {
		t.Fatalf("checks after rollback: %+v, %v", checks, err)
	}
	if got := checks[0]; got.ID != "ck_2" || got.Owner != "" || got.ProbeRev != "" || !got.ProbeChangedAt.Equal(rollbackAt) {
		t.Fatalf("check created during rollback: %+v", got)
	}
	if got := checks[1]; got.ID != "ck_1" || got.Name != "Website renamed" || got.Owner != check.Owner ||
		got.ProbeRev != check.ProbeRev || !got.ProbeChangedAt.Equal(changedAt) {
		t.Fatalf("check updated during rollback: %+v", got)
	}
}

func TestAddressLookupSurvivesHubRollback(t *testing.T) {
	const previousVersion = 14
	path := filepath.Join(t.TempDir(), "hub.db")
	previousHub := func() *Store {
		t.Helper()
		s, err := open(path, migrations[:previousVersion], nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}

	// Include a row saved with the original address-lookup encoding.
	previous := previousHub()
	if _, err := previous.w.ExecContext(ctx, `INSERT INTO checks(id, name, kind, target, runner, interval_s, timeout_s, options, created_by, created_at)
		VALUES ('ck_existing', 'Existing lookup', 'dns', 'localhost.', 'hub', 60, 2, '{"dns_type":"any"}', 'john', ?)`, ms(time.Now())); err != nil {
		t.Fatal(err)
	}
	previous.Close()

	current, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { current.Close() })
	if err := current.PutCheck(ctx, Check{
		ID: "ck_new", Name: "New lookup", Kind: proto.CheckDNS, Target: "localhost.", Runner: "hub",
		IntervalS: 60, TimeoutS: 2, Options: CheckOptions{DNSType: "any"}, Enabled: true, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	saved, err := current.ListChecks(ctx)
	if err != nil || len(saved) != 2 {
		t.Fatalf("saved checks: %+v, %v", saved, err)
	}
	for _, c := range saved {
		if c.Options.DNSType != "any" {
			t.Fatalf("current hub lost the dual-family lookup: %+v", c)
		}
	}
	current.Close()

	rolledBack := previousHub()
	for _, c := range saved {
		// Read only the columns and DNS options the previous hub knew.
		var raw string
		var spec proto.CheckSpec
		if err := rolledBack.r.QueryRowContext(ctx, `SELECT id, kind, target, interval_s, timeout_s, options FROM checks WHERE id = ?`, c.ID).
			Scan(&spec.ID, &spec.Kind, &spec.Target, &spec.IntervalS, &spec.TimeoutS, &raw); err != nil {
			t.Fatal(err)
		}
		var options struct {
			DNSType   string `json:"dns_type"`
			DNSServer string `json:"dns_server"`
			Expect    string `json:"expect"`
		}
		if err := json.Unmarshal([]byte(raw), &options); err != nil {
			t.Fatal(err)
		}
		spec.DNSType, spec.DNSServer, spec.Expect = options.DNSType, options.DNSServer, options.Expect
		if spec.DNSType != "" && spec.DNSType != "A" {
			t.Errorf("%s: old hub would send record type %q", c.ID, spec.DNSType)
		}
		// Run validates the same spec a deployed agent receives.
		result := checks.Run(ctx, spec)
		if !result.OK || len(result.Answer) == 0 {
			t.Fatalf("%s: old lookup failed: %+v", c.ID, result)
		}
		for _, answer := range result.Answer {
			if address, err := netip.ParseAddr(answer); err != nil || !address.Is4() {
				t.Fatalf("%s: got a non-A answer %q", c.ID, answer)
			}
		}
	}
}

// TestManageSwitchMigration upgrades a database of the previous schema:
// existing servers get the Manage switch off, and it can be turned on.
func TestManageSwitchMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hub.db")
	s, err := open(path, migrations[:9], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.w.ExecContext(ctx, `INSERT INTO servers(id, hostname, grp, location, rc_console, rc_power, cert_serial,
		cert_not_after, machine_id, created_at, agent_version, address, rc_host_power) VALUES ('pve-02', 'pve-02', 'Lab', '', 1, 1, 'ab', 0, 'm', 0, '', '', 1)`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var v int
	if err := s.r.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v); err != nil || v != SchemaVersion() {
		t.Fatalf("user_version = %d (%v), want %d", v, err, SchemaVersion())
	}
	sv, err := s.GetServer(ctx, "pve-02")
	if err != nil || sv.RCManage || !sv.RCConsole || !sv.RCHostPower {
		t.Fatalf("migrated server = %+v, %v", sv, err)
	}
	on := true
	if sv, err = s.UpdateServer(ctx, "pve-02", ServerSettings{Manage: &on}); err != nil || !sv.RCManage || !sv.RCPower {
		t.Fatalf("manage on = %+v, %v", sv, err)
	}
	if list, err := s.ListServers(ctx); err != nil || len(list) != 1 || !list[0].RCManage {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestMaintenanceWindows(t *testing.T) {
	ams, _ := time.LoadLocation("Europe/Amsterdam")
	// Weekly on Tuesday and Wednesday 23:00-01:00 Amsterdam time.
	m := Maintenance{StartsAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Weekdays: []int{2, 3}, StartMinute: 23 * 60,
		DurationMin: 120, TZ: "Europe/Amsterdam"}
	at := func(d, h, min int) time.Time { return time.Date(2026, 10, d, h, min, 0, 0, ams) } // Oct 13 2026 is a Tuesday
	cases := []struct {
		t    time.Time
		want bool
	}{
		{at(13, 22, 59), false}, {at(13, 23, 0), true}, {at(14, 0, 30), true}, {at(14, 1, 0), false},
		{at(14, 23, 30), true}, {at(15, 0, 59), true}, {at(15, 23, 30), false}, {at(12, 23, 30), false},
	}
	for _, c := range cases {
		if got, _ := m.ActiveAt(c.t); got != c.want {
			t.Errorf("%v: active=%v want %v", c.t, got, c.want)
		}
	}
	if _, end := m.ActiveAt(at(14, 0, 30)); !end.Equal(at(14, 1, 0)) {
		t.Errorf("end %v", end)
	}
	if n := m.Next(at(13, 12, 0)); !n.Equal(at(13, 23, 0)) {
		t.Errorf("next %v", n)
	}
	one := Maintenance{StartsAt: at(13, 10, 0), EndsAt: at(13, 12, 0)}
	if a, _ := one.ActiveAt(at(13, 11, 0)); !a {
		t.Error("one-off not active inside")
	}
	if a, _ := one.ActiveAt(at(13, 12, 0)); a {
		t.Error("one-off active at its end")
	}
	s := openTest(t)
	m.ID, m.Scope, m.Target, m.CreatedBy, m.CreatedAt = "mw_1", ScopeGroup, "Production", "john", time.Now()
	if err := s.PutMaintenance(ctx, m); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListMaintenance(ctx)
	if err != nil || len(list) != 1 || len(list[0].Weekdays) != 2 || list[0].TZ != "Europe/Amsterdam" {
		t.Fatalf("list %+v %v", list, err)
	}
}

func TestRetentionDropsEmptySeries(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	now := time.Now()
	old := now.Add(-100 * 24 * time.Hour).Unix()
	if _, _, err := s.InsertSamples(ctx, "guest:a|docker:x", []Sample{{TS: old, Values: map[string]float64{"cpu_pct": 1}}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.InsertSamples(ctx, "a", []Sample{{TS: now.Unix(), Values: map[string]float64{"cpu_pct": 2}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Retention(ctx, now); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.SeriesNames(ctx, "guest:a|docker:x"); len(n) != 0 {
		t.Fatalf("empty series kept: %v", n)
	}
	if n, _ := s.SeriesNames(ctx, "a"); len(n) != 1 {
		t.Fatalf("live series dropped: %v", n)
	}
	// The cache was cleared: a new sample recreates the series and is kept.
	if _, _, err := s.InsertSamples(ctx, "guest:a|docker:x", []Sample{{TS: now.Unix(), Values: map[string]float64{"cpu_pct": 3}}}); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.SeriesNames(ctx, "guest:a|docker:x"); len(n) != 1 {
		t.Fatalf("series not recreated: %v", n)
	}
}
