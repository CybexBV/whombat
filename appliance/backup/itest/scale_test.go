package itest

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
)

// Measurement, not a gate (WB_SCALE_MB=1024 go test ./itest -run TestScaleMeasurement -v): checkpoint duration,
// writes-paused time with the copy driver, and drill RTO for N MB of incompressible workspace files plus
// WB_SCALE_ROWS message rows. Numbers are for this host and dataset only; no SLA is derived from them.
func TestScaleMeasurement(t *testing.T) {
	mb, _ := strconv.Atoi(os.Getenv("WB_SCALE_MB"))
	if mb <= 0 {
		t.Skip("set WB_SCALE_MB to run the measurement")
	}
	rows, _ := strconv.Atoi(os.Getenv("WB_SCALE_ROWS"))
	if rows <= 0 {
		rows = 200000
	}
	w := NewWorld(t)
	w.Cfg.QuiesceTimeoutMs = 600_000
	w.Configure()
	dir := filepath.Join(w.Cfg.Layout().Workspaces(), "b1", "data")
	_ = os.MkdirAll(dir, 0o755)
	buf := make([]byte, 1<<20)
	for i := 0; i < mb; i++ {
		_, _ = rand.Read(buf)
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("blob-%05d.bin", i)), buf, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	Exec(t, w.DB.DSN, fmt.Sprintf(`insert into messages(body) select repeat(md5(g::text), 8) from generate_series(1, %d) g`, rows))
	r := w.Runner()
	if os.Getenv("WB_SCALE_NOCLONE") != "" {
		r.Snap.(*snap.Local).Driver = snap.Copy{Reserve: w.Cfg.ReserveBytes, NoClone: true}
	}
	run := func() *checkpoint.Result {
		res, err := r.Run(context.Background(), checkpoint.Options{Reason: "test"})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	t0 := time.Now()
	res := run()
	first := time.Since(t0)
	// Incremental: 1% of the files change.
	for i := 0; i < mb/100+1; i++ {
		_, _ = rand.Read(buf)
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("blob-%05d.bin", i)), buf, 0o644)
	}
	t1 := time.Now()
	res2 := run()
	second := time.Since(t1)
	rep, err := drill.Run(context.Background(), w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_s", CheckData: "", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill: %v %v", err, rep.Failed())
	}
	t.Logf("SCALE (noclone=%v) %d MB files + %d rows: first checkpoint %s (writes paused %d ms, %d bytes added), incremental %s (paused %d ms, %d bytes added); drill RTO %.1fs, backup age %.1fs",
		os.Getenv("WB_SCALE_NOCLONE") != "", mb, rows, first.Round(time.Millisecond), res.Manifest.Quiesce.HeldMs, res.Summary.DataAddedPacked,
		second.Round(time.Millisecond), res2.Manifest.Quiesce.HeldMs, res2.Summary.DataAddedPacked, rep.RTOSeconds, rep.BackupAgeSeconds)
	for _, c := range rep.Checks {
		t.Logf("  %-14s %6d ms %s", c.Name, c.DurationMs, c.Detail)
	}
}
