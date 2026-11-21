// Package itest is the integration harness: a real rest-server (append-only and maintenance instances on
// one data directory), a throwaway PostgreSQL database on the shared development server, a fake runtime
// admin socket, and an appliance "world" (persist layout, seeded database, repositories with unpushed
// and uncommitted work).
//
// Environment: WB_TEST_PG (admin DSN, default postgres://whombat:whombat@127.0.0.1:55432/postgres),
// WB_REST_SERVER (rest-server binary), WB_PG_BIN (directory with pg_dump/pg_restore/initdb/pg_ctl),
// RESTIC (restic binary). Missing tools skip the test with the reason (never a pass).
package itest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/fakeruntime"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
)

// Tools are the external binaries.
type Tools struct {
	Restic     string
	RestServer string
	PGBin      string
	AdminDSN   string
}

func lookFirst(env string, cands ...string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	for _, c := range cands {
		if strings.Contains(c, "/") {
			if _, err := os.Stat(c); err == nil {
				return c
			}
			continue
		}
		if p, err := exec.LookPath(c); err == nil {
			return p
		}
	}
	return ""
}

// NeedTools returns the tools or skips.
func NeedTools(t testing.TB) Tools {
	t.Helper()
	home, _ := os.UserHomeDir()
	tl := Tools{
		Restic:     lookFirst("RESTIC", "restic"),
		RestServer: lookFirst("WB_REST_SERVER", "rest-server", filepath.Join(home, ".cache/wb-tmp/bk-bin/rest-server")),
		AdminDSN:   os.Getenv("WB_TEST_PG"),
	}
	if d := os.Getenv("WB_PG_BIN"); d != "" {
		tl.PGBin = d
	} else if p, err := exec.LookPath("pg_dump"); err == nil {
		tl.PGBin = filepath.Dir(p)
	} else if _, err := os.Stat(filepath.Join(home, ".cache/wb-tmp/bk-pg17/bin/pg_dump")); err == nil {
		tl.PGBin = filepath.Join(home, ".cache/wb-tmp/bk-pg17/bin")
	}
	if tl.AdminDSN == "" {
		tl.AdminDSN = "postgres://whombat:whombat@127.0.0.1:55432/postgres?sslmode=disable"
	}
	var miss []string
	if tl.Restic == "" {
		miss = append(miss, "restic")
	}
	if tl.RestServer == "" {
		miss = append(miss, "rest-server (WB_REST_SERVER)")
	}
	if tl.PGBin == "" {
		miss = append(miss, "pg_dump (WB_PG_BIN)")
	}
	if len(miss) > 0 {
		t.Skipf("missing tools: %s (see backup/scripts/test-tools.sh)", strings.Join(miss, ", "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, tl.AdminDSN)
	if err != nil {
		t.Skipf("PostgreSQL not reachable at WB_TEST_PG: %v", err)
	}
	conn.Close(ctx)
	return tl
}

// Rand returns n random hex bytes.
func Rand(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// FreePort finds a free TCP port.
func FreePort(t testing.TB) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// RestServer is one rest-server process.
type RestServer struct {
	URL     string // http://127.0.0.1:port
	DataDir string
	cmd     *exec.Cmd
}

// Repo returns the restic repository string for a path on the server.
func (r *RestServer) Repo(path string) string {
	return "rest:" + r.URL + "/" + strings.Trim(path, "/") + "/"
}

// StartRestServer starts rest-server on dataDir with users (name → password).
func StartRestServer(t testing.TB, tl Tools, dataDir string, appendOnly bool, users map[string]string) *RestServer {
	t.Helper()
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	htdir := t.TempDir()
	var ht strings.Builder
	for u, p := range users {
		h, err := bcrypt.GenerateFromPassword([]byte(p), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&ht, "%s:%s\n", u, h)
	}
	htpath := filepath.Join(htdir, "htpasswd")
	if err := os.WriteFile(htpath, []byte(ht.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	port := FreePort(t)
	args := []string{"--path", dataDir, "--listen", fmt.Sprintf("127.0.0.1:%d", port), "--htpasswd-file", htpath}
	if appendOnly {
		args = append(args, "--append-only")
	}
	cmd := exec.Command(tl.RestServer, args...)
	logf, _ := os.Create(filepath.Join(htdir, "rest-server.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	rs := &RestServer{URL: fmt.Sprintf("http://127.0.0.1:%d", port), DataDir: dataDir, cmd: cmd}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(rs.URL + "/")
		if err == nil {
			resp.Body.Close()
			return rs
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("rest-server didn't start")
	return nil
}

// DB is a throwaway database.
type DB struct {
	Name string
	DSN  string // key=value DSN
}

// CreateDB creates whombat_bk_test_<random> and drops it at cleanup (only what it created).
func CreateDB(t testing.TB, tl Tools, suffix string) DB {
	t.Helper()
	name := "whombat_bk_test_" + Rand(4) + suffix
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, tl.AdminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "create database "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), tl.AdminDSN)
		if err == nil {
			_, _ = c.Exec(context.Background(), "drop database if exists "+pgx.Identifier{name}.Sanitize()+" with (force)")
			c.Close(context.Background())
		}
	})
	cfg, _ := pgx.ParseConfig(tl.AdminDSN)
	return DB{Name: name, DSN: fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, name)}
}

// Exec runs SQL in a database.
func Exec(t testing.TB, dsn, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// Git runs git in dir (test setup; not hardened).
func Git(t testing.TB, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// WriteFile writes a file, creating parents.
func WriteFile(t testing.TB, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// World is one simulated appliance.
type World struct {
	T         testing.TB
	Tools     Tools
	Dir       string
	Cfg       *state.Config
	DB        DB
	Runtime   *fakeruntime.Runtime
	Rest      *RestServer // append-only instance
	Maint     *RestServer // maintenance instance (no append-only) on the same data directory
	RestUser  string
	RestPass  string
	RepoPath  string
	RemoteDir string // the "upstream" bare repository of the workspace repo
}

// NewWorld builds an appliance with a seeded database and workspaces, a destination (not configured
// yet) and a fake runtime.
func NewWorld(t testing.TB) *World {
	tl := NeedTools(t)
	dir := t.TempDir()
	w := &World{T: t, Tools: tl, Dir: dir, RestUser: "appliance", RestPass: Rand(12), RepoPath: "appliance"}
	w.DB = CreateDB(t, tl, "")
	rt, err := fakeruntime.Start(filepath.Join(dir, "admin.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	w.Runtime = rt
	persist := filepath.Join(dir, "persist")
	w.Cfg = &state.Config{ApplianceID: "apl-test-" + Rand(3), Persist: persist, RuntimeSocket: rt.Socket,
		PGDSN: w.DB.DSN, PGBin: tl.PGBin, Restic: tl.Restic, QuiesceTimeoutMs: 10_000, LeaseMs: 3_000,
		ReserveBytes: 1 << 20, RuntimeUID: os.Getuid(), ManagerUID: -1, BackupUID: os.Getuid()}
	w.Cfg.Defaults()
	w.seedDB()
	w.seedFiles()
	data := filepath.Join(dir, "rest-data")
	w.Rest = StartRestServer(t, tl, data, true, map[string]string{w.RestUser: w.RestPass})
	return w
}

// StartMaintenance starts the separate full-access instance (the customer's prune side).
func (w *World) StartMaintenance(user, pass string) *RestServer {
	w.Maint = StartRestServer(w.T, w.Tools, w.Rest.DataDir, false, map[string]string{user: pass})
	return w.Maint
}

func (w *World) seedDB() {
	t := w.T
	Exec(t, w.DB.DSN, `
		create schema whombat_meta;
		create table whombat_meta.schema_versions (version int primary key, tag text not null);
		insert into whombat_meta.schema_versions values (27, '0026_x'), (28, '0027_feedback');
		create table messages (id bigserial primary key, body text not null, created_at timestamptz default now());
		create table attachments (id bigserial primary key, sha256 text, blob_key text, state text not null);
		create table memory (id bigserial primary key, agent text, fact text);
		create table events (id bigserial primary key, burrow text, seq int, hash text);
		create table pairs (id bigserial primary key, n int unique not null);
		insert into messages(body) select 'message ' || g from generate_series(1, 250) g;
		insert into memory(agent, fact) values ('banjo', 'prefers small commits'), ('banjo', 'tabs');
		insert into events(burrow, seq, hash) select 'b1', g, md5(g::text) from generate_series(1, 40) g;
	`)
}

// Blob stores content in the attachments store and a ready row.
func (w *World) Blob(content string) string {
	sum := sha256hex(content)
	key := fmt.Sprintf("sha256/%s/%s/%s", sum[:2], sum[2:4], sum)
	WriteFile(w.T, filepath.Join(w.Cfg.Layout().Home(), "files", key), content)
	Exec(w.T, w.DB.DSN, `insert into attachments(sha256, blob_key, state) values ($1, $2, 'ready')`, sum, key)
	return key
}

// skillMD is a skill version's SKILL.md in the runtime's skill store.
const skillMD = "---\nname: demo\ndescription: A skill the backup tests carry.\n---\n\nDo the demo.\n"

// SkillVersionFile is that file, relative to WHOMBAT_HOME: the store keeps each version's files under the folder's
// content hash, sha256 over each file's `path NUL sha256 LF` (Whombat skill-store.md SST-04, `skills/<sha256>/`).
var SkillVersionFile = filepath.Join("skills", sha256hex("SKILL.md\x00"+sha256hex(skillMD)+"\n"), "SKILL.md")

func (w *World) seedFiles() {
	t := w.T
	l := w.Cfg.Layout()
	for i := 0; i < 5; i++ {
		w.Blob(fmt.Sprintf("attachment %d %s", i, Rand(8)))
	}
	WriteFile(t, filepath.Join(l.Home(), "files", ".staging", "partial-upload"), "in flight")
	WriteFile(t, filepath.Join(l.Home(), SkillVersionFile), skillMD)
	WriteFile(t, filepath.Join(l.Home(), "logs", "server.log"), "log line\n")
	WriteFile(t, filepath.Join(l.Credentials(), "acct1", "codex", "auth.json"), `{"refresh":"dev-only"}`)
	WriteFile(t, filepath.Join(l.Secrets(), "master.key"), "dev-master-key-"+Rand(8))

	// An upstream repository, a clone with an unpushed commit, an uncommitted change, a staged change,
	// an untracked file, an ignored .env (kept) and an ignored node_modules (a cache: excluded).
	w.RemoteDir = filepath.Join(w.Dir, "upstream.git")
	Git(t, w.Dir, "init", "-q", "--bare", "-b", "main", w.RemoteDir)
	repo := filepath.Join(l.Workspaces(), "b1", "proj")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	Git(t, repo, "init", "-q", "-b", "main")
	WriteFile(t, filepath.Join(repo, "README.md"), "hello\n")
	WriteFile(t, filepath.Join(repo, ".gitignore"), "node_modules/\n.env\n")
	WriteFile(t, filepath.Join(repo, "src", "app.js"), "console.log(1)\n")
	Git(t, repo, "add", ".")
	Git(t, repo, "commit", "-q", "-m", "initial")
	Git(t, repo, "remote", "add", "origin", w.RemoteDir)
	Git(t, repo, "push", "-q", "origin", "main")
	WriteFile(t, filepath.Join(repo, "src", "feature.js"), "export const f = 1\n")
	Git(t, repo, "add", ".")
	Git(t, repo, "commit", "-q", "-m", "unpushed feature")
	WriteFile(t, filepath.Join(repo, "README.md"), "hello\nuncommitted edit\n")
	WriteFile(t, filepath.Join(repo, "staged.txt"), "staged\n")
	Git(t, repo, "add", "staged.txt")
	WriteFile(t, filepath.Join(repo, "notes-untracked.txt"), "untracked work\n")
	WriteFile(t, filepath.Join(repo, ".env"), "SECRET=kept\n")
	WriteFile(t, filepath.Join(repo, "node_modules", "left-pad", "index.js"), "module.exports=1\n")
	Git(t, repo, "stash", "list")
	// A worktree of a separate workspace repo (the runner's layout: .repos/<repo>/<branch>.git + worktree).
	wsRepo := filepath.Join(l.Workspaces(), "b1", ".repos", "proj", "feat.git")
	Git(t, w.Dir, "clone", "-q", "--bare", w.RemoteDir, wsRepo)
	wt := filepath.Join(l.Workspaces(), "b1", "proj-wt", "feat")
	Git(t, wsRepo, "worktree", "add", "-q", "-b", "feat", wt, "main")
	WriteFile(t, filepath.Join(wt, "wt-change.txt"), "worktree commit\n")
	Git(t, wt, "add", ".")
	Git(t, wt, "commit", "-q", "-m", "worktree unpushed")
	WriteFile(t, filepath.Join(wt, "wt-untracked.txt"), "untracked in worktree\n")
	WriteFile(t, filepath.Join(l.Workspaces(), ".scratch", "turn-1", "tmp.txt"), "scratch")
	w.seedHermes()
}

// HermesFiles are the files of the seeded Hermes home (BK-36, NX-466), relative to WHOMBAT_HERMES_ROOT, that a restore
// brings back: the person's (Hermes's own layout) and the outsiders' profile beside it; HermesTransient are those it
// leaves out (the runner's locks and transfers, Hermes's logs).
var (
	HermesFiles = map[string]string{
		"memories/MEMORY.md":                  "Mara deploys on Fridays\n§\nThe site is in ~/site\n",
		"memories/USER.md":                    "Mara\n",
		"state.db":                            "SQLite format 3\x00 sessions of Mara",
		"state.db-wal":                        "a write-ahead log a turn left",
		"sessions/s-1.json":                   `{"id":"s-1"}`,
		"skills/ops/deploy/SKILL.md":          "---\nname: deploy\n---\nbuilt in\n",
		"skills/mine/x/SKILL.md":              "---\nname: x\n---\nlearned with Mara\n",
		"profiles/_feedback/state.db":         "SQLite format 3\x00 assessments",
		"profiles/_feedback/memories/USER.md": "",
		"pending/sessions.json":               `{"queued":["s-0"]}`,
	}
	HermesTransient = []string{"locks/hermes-profile.lock", "transfers/t-1.tgz", "check/config.yaml",
		"signin/half.json", "logs/agent.log", "profiles/_feedback/logs/agent.log"}
	// AgentFiles are the agent's home's (NX-465, NX-466) that a restore brings back; AgentTransient its cache.
	AgentFiles = map[string]string{
		"site/index.html": "<h1>Mara's site</h1>",
		".local/bin/tool": "#!/bin/sh\necho installed in the home\n",
		"notes/plan.md":   "the plan\n",
	}
	AgentTransient = []string{".cache/pip/http/x", ".cache/ms-playwright/chromium/y"}
)

func (w *World) seedHermes() {
	l := w.Cfg.Layout()
	for rel, content := range HermesFiles {
		WriteFile(w.T, filepath.Join(l.Hermes(), rel), content)
	}
	for _, rel := range HermesTransient {
		WriteFile(w.T, filepath.Join(l.Hermes(), rel), "transient")
	}
	for rel, content := range AgentFiles {
		WriteFile(w.T, filepath.Join(l.AgentHome(), rel), content)
	}
	for _, rel := range AgentTransient {
		WriteFile(w.T, filepath.Join(l.AgentHome(), rel), "cache")
	}
}

// Configure configures the append-only destination.
func (w *World) Configure() *state.Destination {
	w.T.Helper()
	d, err := dest.Configure(context.Background(), w.Cfg, dest.Request{Repository: w.Rest.Repo(w.RepoPath),
		RESTUser: w.RestUser, RESTPassword: w.RestPass, AllowInit: true})
	if err != nil {
		w.T.Fatal(err)
	}
	return d.Destination
}

// Runner returns a checkpoint runner with the in-process copy driver (the quiesced-copy fallback).
func (w *World) Runner() *checkpoint.Runner {
	return &checkpoint.Runner{Cfg: w.Cfg, Runtime: runtimeadmin.New(w.Runtime.Socket), Poll: 50 * time.Millisecond,
		Snap: &snap.Local{Driver: snap.Copy{Reserve: w.Cfg.ReserveBytes}, Sources: w.Cfg.Layout().Sources(),
			FilesDir: filepath.Join(w.Cfg.StagingDir(), "files")},
		Log: func(f string, a ...any) { w.T.Logf(f, a...) }}
}

// Checkpoint takes one checkpoint or fails the test.
func (w *World) Checkpoint() *checkpoint.Result {
	w.T.Helper()
	res, err := w.Runner().Run(context.Background(), checkpoint.Options{Reason: "test"})
	if err != nil {
		w.T.Fatalf("checkpoint: %v", err)
	}
	return res
}

func stateDest(w *World) (*state.Destination, error) { return state.LoadDestination(w.Cfg) }

// Material returns the kit's backup section of this appliance.
func (w *World) Material() (*kit.Material, error) { return dest.Material(w.Cfg) }
