package itest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// A continuous writer standing in for the runtime's commit pipeline: each write inserts a row and writes
// its file, inside Begin/End (the fake runtime holds Begin while a backup barrier is up).
func startWriter(t *testing.T, w *World) (stop func() int64) {
	ctx, cancel := context.WithCancel(context.Background())
	var n atomic.Int64
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		conn, err := pgx.Connect(ctx, w.DB.DSN)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(context.Background())
		dir := filepath.Join(w.Cfg.Layout().Home(), "pairs")
		_ = os.MkdirAll(dir, 0o755)
		for i := 1; ctx.Err() == nil; i++ {
			if err := w.Runtime.Begin(ctx); err != nil {
				return
			}
			// file first, then the row (the runtime's own order for attachments), both inside one "write"
			_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%06d", i)), []byte("pair"), 0o644)
			_, err := conn.Exec(context.Background(), "insert into pairs(n) values ($1)", i)
			w.Runtime.End()
			if err != nil {
				t.Error(err)
				return
			}
			n.Add(1)
			time.Sleep(2 * time.Millisecond)
		}
	}()
	return func() int64 { cancel(); wg.Wait(); return n.Load() }
}

func TestRoundTripWithUnpushedAndUncommittedWork(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	stopWriter := startWriter(t, w)
	time.Sleep(150 * time.Millisecond)
	res := w.Checkpoint()
	written := stopWriter()
	m := res.Manifest
	t.Logf("checkpoint %s: method %s scope %s waited %d ms held %d ms; %d concurrent writes", m.ID, m.Quiesce.Method,
		m.Quiesce.Scope, m.Quiesce.WaitMs, m.Quiesce.HeldMs, written)
	if m.Quiesce.Method != "quiesced-copy" || m.Quiesce.Scope != "all" {
		t.Fatalf("quiesce %+v", m.Quiesce)
	}
	if w.Runtime.Barrier() {
		t.Fatal("runtime left in barrier")
	}
	if m.Database.SchemaVersion != 28 || m.Database.ReferencedBlobs != 5 {
		t.Fatalf("db facts %+v", m.Database)
	}
	// the repository inventory saw the work that exists nowhere else
	var proj, wt bool
	for _, r := range m.Repos {
		switch r.Path {
		case "files/workspaces/b1/proj":
			proj = true
			if r.UnpushedCount != 1 || r.ModifiedCount != 1 || r.StagedCount != 1 || r.UntrackedCount != 1 {
				t.Fatalf("proj inventory %+v", r)
			}
		case "files/workspaces/b1/proj-wt/feat":
			wt = true
			if r.Error != "" || r.UntrackedCount != 1 || r.Branch != "feat" {
				t.Fatalf("worktree inventory %+v", r)
			}
		}
	}
	if !proj || !wt {
		t.Fatalf("repos %+v", m.Repos)
	}
	// cache excluded, .env and scratch rules
	var ws *manifest.Source
	for i := range m.Sources {
		if m.Sources[i].Name == "workspaces" {
			ws = &m.Sources[i]
		}
	}
	joined := strings.Join(ws.Excluded, ",")
	if !strings.Contains(joined, "files/workspaces/b1/proj/node_modules") || !strings.Contains(joined, "files/workspaces/.scratch") {
		t.Fatalf("excluded %v", ws.Excluded)
	}

	st, _ := state.CurrentStatus(w.Cfg)
	if st.State != state.StateProtected || !st.Protected || st.LastSuccess == nil || st.Destination.AppendOnly != "verified" {
		t.Fatalf("status %+v", st)
	}

	// Drill into quarantine (a fresh database on the shared server; the drill makes it read-only).
	rep, err := drill.Run(context.Background(), w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN,
		DBPrefix: "whombat_bk_test_q", CheckData: "all", Keep: true, Log: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dropQuarantine(t, w, rep.QuarantineDSN) })
	for _, c := range rep.Checks {
		t.Logf("check %-14s ok=%v skipped=%v %s (%d ms)", c.Name, c.OK, c.Skipped, c.Detail, c.DurationMs)
	}
	if !rep.OK || len(rep.Failed()) > 0 {
		t.Fatalf("drill failed: %v", rep.Failed())
	}
	if s := rep.Skipped(); len(s) != 1 || s[0] != "audit-chain" {
		t.Fatalf("skipped %v", s)
	}
	t.Logf("DRILL: RTO %.2fs, backup age %.2fs", rep.RTOSeconds, rep.BackupAgeSeconds)

	root := keptRoot(t, w)
	proj2 := filepath.Join(root, "files/workspaces/b1/proj")
	if got := Git(t, proj2, "log", "--format=%s", "-1"); got != "unpushed feature" {
		t.Fatalf("head commit %q", got)
	}
	if b, _ := os.ReadFile(filepath.Join(proj2, "README.md")); !strings.Contains(string(b), "uncommitted edit") {
		t.Fatal("uncommitted change lost")
	}
	for _, f := range []string{"notes-untracked.txt", ".env", "staged.txt"} {
		if _, err := os.Stat(filepath.Join(proj2, f)); err != nil {
			t.Fatalf("%s lost: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(proj2, "node_modules")); err == nil {
		t.Fatal("cache node_modules was backed up")
	}
	for _, p := range []string{"files/home/files/.staging", "files/home/logs", "files/workspaces/.scratch"} {
		if _, err := os.Stat(filepath.Join(root, p)); err == nil {
			t.Fatalf("%s should be excluded", p)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "files/credentials/acct1/codex/auth.json")); len(b) == 0 {
		t.Fatal("credential home lost")
	}

	// Consistency: in the restored checkpoint every pairs row has its file and every file its row.
	rows := map[int]bool{}
	qdsn := rep.QuarantineDSN
	conn, err := pgx.Connect(context.Background(), qdsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	r, err := conn.Query(context.Background(), "select n from pairs")
	if err != nil {
		t.Fatal(err)
	}
	for r.Next() {
		var n int
		_ = r.Scan(&n)
		rows[n] = true
	}
	r.Close()
	files, _ := os.ReadDir(filepath.Join(root, "files/home/pairs"))
	fileSet := map[int]bool{}
	for _, f := range files {
		var n int
		fmt.Sscanf(f.Name(), "%d", &n)
		fileSet[n] = true
	}
	for n := range rows {
		if !fileSet[n] {
			t.Fatalf("row %d without its file", n)
		}
	}
	for n := range fileSet {
		if !rows[n] {
			t.Fatalf("file %d without its row", n)
		}
	}
	t.Logf("consistency: %d pairs in the checkpoint, %d written during the run", len(rows), written)
	// The quarantine database refuses writes.
	if _, err := conn.Exec(context.Background(), "insert into messages(body) values ('x')"); err == nil ||
		!strings.Contains(err.Error(), "read-only") {
		t.Fatalf("quarantine database accepted a write: %v", err)
	}
	st, _ = state.CurrentStatus(w.Cfg)
	if st.Recoverability.LastDrill == nil || !st.Recoverability.LastDrill.OK {
		t.Fatalf("drill not recorded: %+v", st.Recoverability)
	}
}

func keptRoot(t *testing.T, w *World) string {
	ents, err := os.ReadDir(w.Cfg.DrillDir())
	if err != nil || len(ents) == 0 {
		t.Fatalf("no kept drill: %v", err)
	}
	return filepath.Join(w.Cfg.DrillDir(), ents[len(ents)-1].Name(), "root")
}

func dropQuarantine(t *testing.T, w *World, dsn string) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || !strings.HasPrefix(cfg.Database, "whombat_bk_test_") {
		return
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, w.Tools.AdminDSN)
	if err != nil {
		return
	}
	defer conn.Close(ctx)
	_, _ = conn.Exec(ctx, "drop database if exists "+pgx.Identifier{cfg.Database}.Sanitize()+" with (force)")
}
