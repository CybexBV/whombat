package itest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

func httpDo(t *testing.T, method, url, user, pass string, body []byte) int {
	t.Helper()
	req, _ := http.NewRequest(method, url, bytes.NewReader(body))
	req.SetBasicAuth(user, pass)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func firstFile(t *testing.T, dir string) string {
	t.Helper()
	var found string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && found == "" {
			found = p
		}
		return nil
	})
	if found == "" {
		t.Fatalf("no file under %s", dir)
	}
	return found
}

// The appliance's credential can't delete or overwrite anything retained, whatever tool it uses.
func TestAppendOnlyRefusesDeletionAndOverwrite(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	res := w.Checkpoint()
	d, _ := stateDest(w)
	repo := w.Cfg.Repo(d)
	ctx := context.Background()
	repoDir := filepath.Join(w.Rest.DataDir, w.RepoPath)
	base := w.Rest.URL + "/" + w.RepoPath

	// 1. restic forget --prune with the appliance credential.
	_, err := repo.Run(ctx, nil, "forget", "--prune", res.Summary.SnapshotID)
	if err == nil {
		t.Fatal("forget --prune succeeded with the append-only credential")
	}
	t.Logf("forget --prune (appliance): %v", err)
	_, err = repo.Run(ctx, nil, "forget", "--keep-last", "0", "--keep-within", "0s")
	t.Logf("forget --keep-within 0s (appliance): %v", err)
	snaps, err := repo.Snapshots(ctx, "")
	if err != nil || len(snaps) != 1 {
		t.Fatalf("snapshot gone after deletion attempts: %v %v", snaps, err)
	}

	// 2. Raw DELETE of every object type except locks.
	pack := firstFile(t, filepath.Join(repoDir, "data"))
	for _, rel := range []string{
		"data/" + filepath.Base(pack),
		"snapshots/" + res.Summary.SnapshotID,
		"keys/" + filepath.Base(firstFile(t, filepath.Join(repoDir, "keys"))),
		"index/" + filepath.Base(firstFile(t, filepath.Join(repoDir, "index"))),
	} {
		if code := httpDo(t, http.MethodDelete, base+"/"+rel, w.RestUser, w.RestPass, nil); code != http.StatusForbidden {
			t.Fatalf("DELETE %s: HTTP %d, want 403", rel, code)
		}
	}
	if code := httpDo(t, http.MethodDelete, base+"/config", w.RestUser, w.RestPass, nil); code != http.StatusForbidden && code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE config: HTTP %d", code)
	}

	// 3. Overwrite: POST different bytes to an existing name (and the config).
	for _, rel := range []string{"data/" + filepath.Base(pack), "snapshots/" + res.Summary.SnapshotID, "config"} {
		code := httpDo(t, http.MethodPost, base+"/"+rel, w.RestUser, w.RestPass, []byte("overwritten by a compromised appliance"))
		if code != http.StatusForbidden {
			t.Fatalf("POST (overwrite) %s: HTTP %d, want 403", rel, code)
		}
	}
	// A new object whose name doesn't match its content is refused too (upload verification).
	if code := httpDo(t, http.MethodPost, base+"/data/"+strings.Repeat("ab", 32), w.RestUser, w.RestPass, []byte("junk")); code != http.StatusBadRequest {
		t.Fatalf("mismatched upload: HTTP %d, want 400", code)
	}

	// 4. restic key remove (key rotation needs the maintenance side).
	pw2 := filepath.Join(t.TempDir(), "pw2")
	_ = os.WriteFile(pw2, []byte("second-key"), 0o600)
	if _, err := repo.Run(ctx, nil, "key", "add", "--new-password-file", pw2); err != nil {
		t.Fatalf("key add (append) failed: %v", err)
	}
	out, _ := repo.Run(ctx, nil, "key", "list", "--json")
	var firstKey string
	if i := bytes.Index(out, []byte(`"id":"`)); i >= 0 {
		firstKey = string(out[i+6 : i+6+64])
	}
	var ids []string
	for _, part := range strings.Split(string(out), `"id":"`)[1:] {
		ids = append(ids, part[:64])
	}
	var other string
	for _, id := range ids {
		if id != firstKey {
			other = id
		}
	}
	if _, err := repo.Run(ctx, nil, "key", "remove", other); err == nil {
		t.Fatal("key remove succeeded with the append-only credential")
	}

	// Everything still verifies with every byte read.
	if _, err := repo.Check(ctx, "all"); err != nil {
		t.Fatalf("check after attacks: %v", err)
	}
}

// Retention runs on the customer's side with a separate credential against a full-access instance;
// the appliance never holds it. forget --keep-within + prune work on a repository the append-only
// instance keeps writing to; an attacker's snapshots with backdated/future times don't push out the
// legitimate ones under --keep-within (restic's documented append-only guidance).
func TestMaintenanceCredentialForgetPrune(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint()
	w.Checkpoint()
	d, _ := stateDest(w)
	app := w.Cfg.Repo(d)
	ctx := context.Background()
	// An attacker with the appliance credential and the password adds snapshots with chosen times in the
	// same group as the real checkpoints (same host and paths).
	staging := w.Cfg.StagingDir()
	paths := []string{"db", "manifest", "files/home", "files/workspaces", "files/credentials", "files/hermes", "files/agent",
		"files/secrets"}
	for _, p := range paths {
		WriteFile(t, filepath.Join(staging, p, "junk"), "junk")
	}
	for _, ts := range []string{"2099-01-01 00:00:00", "2001-01-01 00:00:00"} {
		if _, err := app.Backup(ctx, restic.BackupOptions{Dir: staging, Paths: paths, Host: w.Cfg.ApplianceID,
			Tags: []string{"whombat-checkpoint"}, Time: mustTime(ts)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{"db", "manifest", "files"} {
		_ = os.RemoveAll(filepath.Join(staging, p))
	}
	maintUser, maintPass := "maintainer", Rand(12)
	m := w.StartMaintenance(maintUser, maintPass)
	maint := restic.Repo{Binary: w.Tools.Restic, Repository: m.Repo(w.RepoPath), PasswordFile: app.PasswordFile,
		RESTUser: maintUser, RESTPassword: maintPass, NoCache: true}
	// The appliance credential is not valid on the maintenance instance.
	bad := maint
	bad.RESTUser, bad.RESTPassword = w.RestUser, w.RestPass
	if _, err := bad.Snapshots(ctx, ""); err == nil {
		t.Fatal("appliance credential accepted by the maintenance instance")
	}
	out, err := maint.Run(ctx, nil, "forget", "--keep-within", "30d", "--prune")
	if err != nil {
		t.Fatalf("maintenance forget/prune: %v", err)
	}
	t.Logf("maintenance forget --keep-within 30d --prune:\n%s", lastLines(string(out), 12))
	snaps, _ := maint.Snapshots(ctx, "")
	legit := 0
	for _, s := range snaps {
		if s.Tag("ck:") != "" {
			legit++
		}
	}
	// Both real checkpoints kept; the future-dated one is kept too (duration policies never remove
	// future snapshots), the 2001 one removed.
	if legit != 2 || len(snaps) != 3 {
		t.Fatalf("after keep-within: %d snapshots, %d checkpoints", len(snaps), legit)
	}
	if _, err := maint.Check(ctx, "all"); err != nil {
		t.Fatalf("check after prune: %v", err)
	}
	// The appliance keeps backing up to the pruned repository.
	w.Checkpoint()
	// keep-last would have removed a legitimate checkpoint in favour of the attacker's future snapshot.
	out, err = maint.Run(ctx, nil, "forget", "--keep-last", "1", "--dry-run", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var groups []struct {
		Keep   []restic.Snapshot `json:"keep"`
		Remove []restic.Snapshot `json:"remove"`
	}
	if err := json.Unmarshal(out, &groups); err != nil || len(groups) == 0 {
		t.Fatalf("dry run json: %v %s", err, out)
	}
	removedReal := 0
	for _, s := range groups[0].Remove {
		if s.Tag("ck:") != "" {
			removedReal++
		}
	}
	if len(groups[0].Keep) != 1 || groups[0].Keep[0].Time.Year() != 2099 || removedReal != 3 {
		t.Fatalf("keep-last dry run: keep %v, %d real removed", groups[0].Keep, removedReal)
	}
	t.Logf("keep-last 1 (dry run, not applied) would keep only the attacker's 2099 snapshot and remove all %d real checkpoints", removedReal)
}

func mustTime(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04:05", s, time.Local)
	if err != nil {
		panic(err)
	}
	return t
}

func lastLines(s string, n int) string {
	l := strings.Split(strings.TrimSpace(s), "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, "\n")
}
