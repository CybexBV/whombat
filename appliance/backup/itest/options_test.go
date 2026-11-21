package itest

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/api"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// apiClient serves the API for cfg on a private socket, the caller being the runtime.
func apiClient(t *testing.T, cfg *state.Config) func(method, path string, body any) (int, map[string]any) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "api.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	s := &api.Server{Cfg: cfg, RuntimeUID: os.Getuid(), ManagerUID: -1}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	hc := &http.Client{Timeout: 5 * time.Minute, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	return func(method, path string, body any) (int, map[string]any) {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, "http://backup"+path, strings.NewReader(string(b)))
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
}

// The list of backups (BK-38): every checkpoint with why and how much, the manifests cached after the first read,
// the restore checks per backup; then the box's own disk's backups found, copied and removed.
func TestListAndLocalLeftover(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	// As on Home: backups to the box's own disk first, then a place (a new repository, the same password).
	if _, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: listing.LocalRepositoryPath(w.Cfg), AllowInit: true, AllowLocal: true}); err != nil {
		t.Fatal(err)
	}
	early := w.Checkpoint()
	w.Checkpoint()
	w.Configure()
	first := w.Checkpoint()
	second := w.Checkpoint()
	call := apiClient(t, w.Cfg)

	code, res := call("GET", "/v1/checkpoints", nil)
	if code != 200 {
		t.Fatalf("list: %d %v", code, res)
	}
	cps := res["checkpoints"].([]any)
	if len(cps) != 2 {
		t.Fatalf("checkpoints %v", cps)
	}
	newest := cps[0].(map[string]any)
	if newest["id"] != second.Manifest.ID || newest["own"] != true || newest["reason"] != "test" || newest["bytesAdded"] == nil {
		t.Fatalf("newest %v", newest)
	}
	covered := map[string]bool{}
	for _, id := range newest["covered"].([]any) {
		covered[id.(string)] = true
	}
	if !covered["database"] || !covered["attachments"] || covered["identity"] || covered["servers"] {
		t.Fatalf("what the newest holds: %v", newest["covered"])
	}
	ents, _ := os.ReadDir(filepath.Join(w.Cfg.StateDir, "manifests"))
	if len(ents) < 2 {
		t.Fatalf("cached manifests %d", len(ents))
	}
	if err := listing.RecordCheck(w.Cfg, first.Manifest.ID, time.Now(), true); err != nil {
		t.Fatal(err)
	}
	_, res = call("GET", "/v1/checkpoints", nil)
	older := res["checkpoints"].([]any)[1].(map[string]any)
	if ck, _ := older["check"].(map[string]any); ck == nil || ck["ok"] != true {
		t.Fatalf("check %v", older)
	}
	if l, _ := res["local"].(map[string]any); l == nil || l["count"].(float64) != 2 {
		t.Fatalf("local %v", res["local"])
	}
	code, res = call("POST", "/v1/local/copy", map[string]any{})
	if code != 200 || res["copied"].(float64) != 2 {
		t.Fatalf("copy: %d %v", code, res)
	}
	if _, err := os.Stat(listing.LocalRepositoryPath(w.Cfg)); !os.IsNotExist(err) {
		t.Fatalf("the local repository stays: %v", err)
	}
	_, res = call("GET", "/v1/checkpoints", nil)
	all := res["checkpoints"].([]any)
	if len(all) != 4 || all[3].(map[string]any)["id"] != early.Manifest.ID || res["local"] != nil {
		t.Fatalf("after the copy: %v local %v", all, res["local"])
	}
	d, _ := state.LoadDestination(w.Cfg)
	if snaps, _ := w.Cfg.Repo(d).Snapshots(ctx, manifest.TagProduct); len(snaps) != 4 {
		t.Fatalf("snapshots %d", len(snaps))
	}
}

// Bringing a Whombat back starts with adopt (BK-39): a fresh box joins the old one's repository with the kit's
// backup section and lists the old box's backups as not its own; a box with backups of its own is refused.
func TestAdoptListsTheOldBoxsBackups(t *testing.T) {
	old := NewWorld(t)
	old.Configure()
	ck := old.Checkpoint()
	mat, err := old.Material()
	if err != nil {
		t.Fatal(err)
	}
	cfg := &state.Config{ApplianceID: "apl-new", Persist: filepath.Join(t.TempDir(), "persist"), PGBin: old.Tools.PGBin,
		Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	call := apiClient(t, cfg)
	code, res := call("POST", "/v1/adopt", map[string]any{"material": mat})
	if code != 200 || res["oldApplianceId"] != old.Cfg.ApplianceID {
		t.Fatalf("adopt: %d %v", code, res)
	}
	cps := res["checkpoints"].([]any)
	if len(cps) != 1 || cps[0].(map[string]any)["id"] != ck.Manifest.ID || cps[0].(map[string]any)["own"] != false {
		t.Fatalf("checkpoints %v", cps)
	}
	if _, err := os.Stat(filepath.Join(cfg.StateDir, "keys", "adopted-head.json")); err != nil && mat.Head != nil {
		t.Fatal(err)
	}
	// The old box itself can't adopt: it has backups of its own.
	if code, _ := apiClient(t, old.Cfg)("POST", "/v1/adopt", map[string]any{"material": mat}); code != 409 {
		t.Fatalf("own box: %d", code)
	}
	// Unless the person chose to replace what is on it: bringing a Whombat back stays possible later.
	if code, res := apiClient(t, old.Cfg)("POST", "/v1/adopt", map[string]any{"material": mat, "replace": true}); code != 200 {
		t.Fatalf("replace: %d %v", code, res)
	}
	code, st := call("GET", "/v1/quarantine", nil)
	if code != 200 || st["phase"] != "none" {
		t.Fatalf("state %d %v", code, st)
	}
}
