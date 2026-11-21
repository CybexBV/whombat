package itest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/peek"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// peekWorld is a world with peeks set up: a throwaway role stands for the runtime's (dropped at the end with every
// database of its own prefix), the test's group for the runtime's group.
func peekWorld(t *testing.T) (w *World, roleDSN func(db string) string) {
	t.Helper()
	w = NewWorld(t)
	w.Configure()
	role, pass := "whombat_bk_test_rt_"+Rand(3), Rand(10)
	prefix := "whombat_bk_test_pk" + Rand(3) + "_"
	Exec(t, w.Tools.AdminDSN, fmt.Sprintf("create role %s login password '%s'", pgx.Identifier{role}.Sanitize(), pass))
	t.Cleanup(func() {
		ctx := context.Background()
		c, err := pgx.Connect(ctx, w.Tools.AdminDSN)
		if err != nil {
			return
		}
		defer c.Close(ctx)
		rows, _ := c.Query(ctx, "select datname from pg_database where starts_with(datname, $1)", prefix)
		var dbs []string
		for rows.Next() {
			var n string
			_ = rows.Scan(&n)
			dbs = append(dbs, n)
		}
		rows.Close()
		for _, n := range dbs {
			_, _ = c.Exec(ctx, "drop database if exists "+pgx.Identifier{n}.Sanitize()+" with (force)")
		}
		_, _ = c.Exec(ctx, "drop role if exists "+pgx.Identifier{role}.Sanitize())
	})
	w.Cfg.Peek = &state.PeekConfig{RuntimeRole: role, GID: os.Getgid(), DBPrefix: prefix}
	w.Cfg.Defaults()
	cfg, _ := pgx.ParseConfig(w.Tools.AdminDSN)
	return w, func(db string) string {
		return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable", cfg.Host, cfg.Port, role, pass, db)
	}
}

func waitPeek(t *testing.T, call func(string, string, any) (int, map[string]any), id string, want ...string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for {
		code, p := call("GET", "/v1/peeks/"+id, nil)
		if code != 200 {
			t.Fatalf("get %s: %d %v", id, code, p)
		}
		for _, s := range want {
			if p["state"] == s {
				return p
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("peek %s stayed %v", id, p)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// A backup opened for reading: its database in a temporary database the runtime's role can only read, its runtime
// sources under their names in a directory the runtime's group can only read; one at a time; closed on request,
// its database and files gone.
func TestPeekOpensABackupForReading(t *testing.T) {
	w, roleDSN := peekWorld(t)
	ctx := context.Background()
	blob := w.Blob("the photo from yesterday's chat")
	ck := w.Checkpoint()
	Exec(t, w.DB.DSN, `insert into messages(body) values ('written after the backup')`)
	call := apiClient(t, w.Cfg)

	code, a := call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID, "own": true})
	if code != 202 || a["id"] == nil {
		t.Fatalf("open: %d %v", code, a)
	}
	id := a["id"].(string)
	if code, b := call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID}); code != 409 {
		t.Fatalf("a second peek: %d %v", code, b)
	}
	p := waitPeek(t, call, id, peek.Ready, peek.Failed)
	if p["state"] != peek.Ready || p["checkpointId"] != ck.Manifest.ID || p["expiresAt"] == nil || p["error"] != nil {
		t.Fatalf("peek %v", p)
	}
	db, root := p["database"].(string), p["root"].(string)

	// The database: the checkpoint's rows, readable by the runtime's role, nothing else.
	conn, err := pgx.Connect(ctx, roleDSN(db))
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := conn.QueryRow(ctx, "select count(*) from messages").Scan(&n); err != nil || n != 250 {
		t.Fatalf("messages: %d %v", n, err)
	}
	var key string
	if err := conn.QueryRow(ctx, "select blob_key from attachments where blob_key = $1", blob).Scan(&key); err != nil {
		t.Fatalf("the attachment's row: %v", err)
	}
	for _, q := range []string{"insert into messages(body) values ('x')", "create table mine (x int)", "create temp table t (x int)",
		"set default_transaction_read_only = off; delete from messages"} {
		if _, err := conn.Exec(ctx, q); err == nil {
			t.Fatalf("the runtime's role could %q", q)
		}
	}
	conn.Close(ctx)

	// The root: the runtime sources under their names, readable by the group, nothing writable by it.
	for _, rel := range []string{filepath.Join("home", "files", blob), filepath.Join("hermes", "memories", "MEMORY.md"),
		filepath.Join("agent", "notes", "plan.md")} {
		fi, err := os.Stat(filepath.Join(root, rel))
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		if fi.Mode().Perm()&0o040 == 0 || fi.Mode().Perm()&0o022 != 0 {
			t.Fatalf("%s mode %v", rel, fi.Mode())
		}
	}
	ents, _ := os.ReadDir(root)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	if got := strings.Join(names, ","); got != "agent,hermes,home,workspaces" {
		t.Fatalf("root holds %s", got)
	}
	_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err == nil && e.IsDir() {
			if fi, _ := e.Info(); fi.Mode().Perm() != 0o750 {
				t.Fatalf("%s mode %v", p, fi.Mode())
			}
		}
		return nil
	})

	if code, c := call("DELETE", "/v1/peeks/"+id, nil); code != 200 || c["state"] != peek.Closed || c["database"] != nil {
		t.Fatalf("close: %d %v", code, c)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("the root stayed: %v", err)
	}
	if exists(t, w, db) {
		t.Fatal("the database stayed")
	}
	if code, _ := call("GET", "/v1/peeks/nope", nil); code != 404 {
		t.Fatalf("unknown peek: %d", code)
	}
	if code, _ := call("POST", "/v1/peeks", map[string]any{"checkpointId": "ck-20200101T000000Z-000000"}); code != 404 {
		t.Fatalf("unknown backup: %d", code)
	}
	if code, b := call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID, "own": false}); code != 404 {
		t.Fatalf("an own backup asked for as the earlier Whombat's: %d %v", code, b)
	}
}

func exists(t *testing.T, w *World, db string) bool {
	ctx := context.Background()
	c, err := pgx.Connect(ctx, w.Tools.AdminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	var ok bool
	if err := c.QueryRow(ctx, "select exists (select 1 from pg_database where datname = $1)", db).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// The room is checked first: a backup that doesn't fit is refused with the bytes it needs, before anything is made.
// A peek closes itself at its time, and one left from an earlier boot is closed by the sweep.
func TestPeekRoomExpiryAndBoot(t *testing.T) {
	w, _ := peekWorld(t)
	ck := w.Checkpoint()
	call := apiClient(t, w.Cfg)

	reserve := w.Cfg.ReserveBytes
	w.Cfg.ReserveBytes = 1 << 60
	code, a := call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID})
	e, _ := a["error"].(map[string]any)
	if code != 507 || e["code"] != "no_space" || e["needBytes"].(float64) < float64(int64(1)<<60) || e["freeBytes"] == nil ||
		!strings.Contains(e["message"].(string), "room") {
		t.Fatalf("no room: %d %v", code, a)
	}
	if ents, _ := os.ReadDir(w.Cfg.Peek.Dir); hasPeekDir(ents) {
		t.Fatal("a refused peek left a directory")
	}
	w.Cfg.ReserveBytes = reserve

	w.Cfg.Peek.TTLMs = 1500
	code, a = call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID})
	if code != 202 {
		t.Fatalf("open: %d %v", code, a)
	}
	id := a["id"].(string)
	p := waitPeek(t, call, id, peek.Ready, peek.Failed)
	if p["state"] != peek.Ready {
		t.Fatalf("%v", p)
	}
	db := p["database"].(string)
	p = waitPeek(t, call, id, peek.Closed)
	if exists(t, w, db) {
		t.Fatal("the database outlived the peek's time")
	}

	// A peek of an earlier boot: the sweep at boot closes it.
	w.Cfg.Peek.TTLMs = 3_600_000
	code, a = call("POST", "/v1/peeks", map[string]any{"checkpointId": ck.Manifest.ID})
	if code != 202 {
		t.Fatalf("open: %d %v", code, a)
	}
	id = a["id"].(string)
	p = waitPeek(t, call, id, peek.Ready)
	db, root := p["database"].(string), p["root"].(string)
	rec := filepath.Join(w.Cfg.Peek.Dir, "peek.json")
	b, err := os.ReadFile(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rec, []byte(strings.Replace(string(b), `"bootId": "`, `"bootId": "an-earlier-boot-`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	peek.Sweep(context.Background(), w.Cfg)
	if exists(t, w, db) {
		t.Fatal("the sweep left an earlier boot's database")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("the sweep left an earlier boot's root: %v", err)
	}
	if _, p := call("GET", "/v1/peeks/"+id, nil); p["state"] != peek.Closed {
		t.Fatalf("after the sweep: %v", p)
	}

	// One whose opening process is gone (the backup service restarted half way) ends failed, saying why.
	var r map[string]any
	b, _ = os.ReadFile(rec)
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	r["state"], r["pid"] = peek.Opening, 2147483646
	b, _ = json.Marshal(r)
	if err := os.WriteFile(rec, b, 0o600); err != nil {
		t.Fatal(err)
	}
	peek.Sweep(context.Background(), w.Cfg)
	if _, p := call("GET", "/v1/peeks/"+id, nil); p["state"] != peek.Failed || !strings.Contains(fmt.Sprint(p["error"]), "restarted") {
		t.Fatalf("a half-open peek after the sweep: %v", p)
	}
}

func hasPeekDir(ents []os.DirEntry) bool {
	for _, e := range ents {
		if e.IsDir() && strings.HasPrefix(e.Name(), "pk-") {
			return true
		}
	}
	return false
}
