package itest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"

	"github.com/CybexBV/whombat/appliance/backup/internal/api"
	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// Quiesce timeout: blockers that never clear make the checkpoint give up within the bound, release the
// drain, record why, and leave the acknowledged work alone.
func TestQuiesceTimeoutIsBoundedAndKillsNothing(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint() // a previous success stays visible
	since := time.Now().Add(-3 * time.Minute)
	blockers := []runtimeadmin.Blocker{{Kind: "migration", ID: "m-0028", Description: "backfill running", Since: since}}
	w.Runtime.SetBlockers(blockers)
	w.Cfg.QuiesceTimeoutMs = 1500
	start := time.Now()
	_, err := w.Runner().Run(context.Background(), checkpoint.Options{Reason: "test"})
	elapsed := time.Since(start)
	var se *checkpoint.StageError
	if !errors.As(err, &se) || se.Stage != "quiesce" {
		t.Fatalf("want quiesce failure, got %v", err)
	}
	t.Logf("gave up after %s: %s", elapsed.Round(time.Millisecond), se.Reason)
	if elapsed > 1500*time.Millisecond+2*time.Second {
		t.Fatalf("not bounded: %s", elapsed)
	}
	if !strings.Contains(se.Reason, "migration m-0028") || !strings.Contains(se.Reason, "nothing was stopped") {
		t.Fatalf("reason %q", se.Reason)
	}
	if w.Runtime.Barrier() {
		t.Fatal("drain not released after the timeout")
	}
	_, resumes := w.Runtime.Counts()
	if resumes < 2 {
		t.Fatalf("resume not called (resumes=%d)", resumes)
	}
	st, err := state.CurrentStatus(w.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	// One failed try after a success is a blip: still protected, the count says so (failing from the second).
	if st.State != state.StateProtected || st.FailedAttempts != 1 || st.LastFailure.Stage != "quiesce" || st.LastSuccess == nil {
		t.Fatalf("status %+v", st)
	}
	// The work that blocked is untouched (the fake would report fewer blockers if anything was cancelled),
	// and once it finishes the next checkpoint succeeds.
	w.Runtime.SetBlockers(nil)
	w.Checkpoint()
	st, _ = state.CurrentStatus(w.Cfg)
	if st.State != state.StateProtected {
		t.Fatalf("after recovery: %s", st.State)
	}

	// Another caller (an update) holds the runtime: 409 busy, bounded too.
	w.Runtime.SetBusy("update drain rt-2 in progress")
	_, err = w.Runner().Run(context.Background(), checkpoint.Options{Reason: "test"})
	if !errors.As(err, &se) || se.Stage != "quiesce" || !strings.Contains(se.Reason, "busy") {
		t.Fatalf("busy: %v", err)
	}
	w.Runtime.SetBusy("")
}

// A crashed backup can't leave writes paused: the runtime's lease expires on its own.
func TestDrainLeaseExpires(t *testing.T) {
	w := NewWorld(t)
	c := runtimeadmin.New(w.Runtime.Socket)
	st, err := c.Drain(context.Background(), runtimeadmin.DrainRequest{RequestID: "ck-crashed", Reason: "backup", Scope: "writes", LeaseMs: 1000})
	if err != nil || !st.Safe {
		t.Fatalf("drain: %v %+v", err, st)
	}
	if !w.Runtime.Barrier() {
		t.Fatal("barrier not held")
	}
	time.Sleep(1300 * time.Millisecond)
	if w.Runtime.Barrier() {
		t.Fatal("barrier outlived its lease")
	}
}

func unixClient(sock string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
}

// No destination: explicitly "unprotected", never "enabled"; the API says so to the runtime.
func TestUnprotectedState(t *testing.T) {
	w := NewWorld(t)
	_, err := w.Runner().Run(context.Background(), checkpoint.Options{Reason: "scheduled"})
	if !errors.Is(err, checkpoint.ErrUnprotected) {
		t.Fatalf("want unprotected, got %v", err)
	}
	if n, _ := w.Runtime.Counts(); n != 0 {
		t.Fatal("runtime drained without a destination")
	}
	sock := filepath.Join(w.Dir, "api.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	r := w.Runner()
	srv := &api.Server{Cfg: w.Cfg, RuntimeUID: os.Getuid(), ManagerUID: -1,
		Checkpoint: func(ctx context.Context, opts checkpoint.Options) (*checkpoint.Result, error) {
			return r.Run(ctx, opts)
		}}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	hc := unixClient(sock)
	resp, err := hc.Get("http://backup/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	st, err := local.ParseBackupServiceStatus(body) // the contract schema
	if err != nil {
		t.Fatalf("status fails the contract: %v\n%s", err, body)
	}
	if st.State != "unprotected" || st.Protected || st.Destination.Configured || len(st.Coverage) != 15 {
		t.Fatalf("status %s", body)
	}
	resp, err = hc.Post("http://backup/v1/checkpoints", "application/json", strings.NewReader(`{"reason":"manual"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("checkpoint without destination: HTTP %d", resp.StatusCode)
	}
	resp, _ = hc.Get("http://backup/v1/recovery-material")
	resp.Body.Close()
	if resp.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("material without destination: HTTP %d", resp.StatusCode)
	}
	// A peer that isn't the runtime or the manager is refused.
	srv2 := &api.Server{Cfg: w.Cfg, RuntimeUID: os.Getuid() + 1, ManagerUID: -1}
	sock2 := filepath.Join(w.Dir, "api2.sock")
	l2, _ := net.Listen("unix", sock2)
	go srv2.Serve(l2)
	t.Cleanup(func() { srv2.Close() })
	resp, err = unixClient(sock2).Get("http://backup/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign peer: HTTP %d", resp.StatusCode)
	}

	// After configuring: pending until the first checkpoint, then protected; every document validates.
	w.Configure()
	st2, _ := state.CurrentStatus(w.Cfg)
	if st2.State != state.StatePending {
		t.Fatalf("after configure: %s", st2.State)
	}
	w.Checkpoint()
	resp, _ = hc.Get("http://backup/v1/status")
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	st, err = local.ParseBackupServiceStatus(body)
	if err != nil || st.State != "protected" || st.LastSuccess == nil {
		t.Fatalf("protected status: %v %s", err, body)
	}
	resp, _ = hc.Get("http://backup/v1/recovery-material")
	var mat map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&mat)
	resp.Body.Close()
	if mat["repositoryPassword"] == "" || mat["manifestKey"] == nil || mat["restPassword"] != w.RestPass {
		t.Fatalf("material %v", mat)
	}
}

// Before an incompatible migration the manager holds its own drain (scope all) and asks for a checkpoint
// inside it; the backup service doesn't drain again (it would be refused as busy) but confirms the drain.
func TestPreMigrationCheckpointInsideManagerDrain(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	c := runtimeadmin.New(w.Runtime.Socket)
	ctx := context.Background()
	// Without an active drain: refused, nothing taken.
	_, err := w.Runner().Run(ctx, checkpoint.Options{Reason: "pre-migration", UnderDrain: "upd-1"})
	var se *checkpoint.StageError
	if !errors.As(err, &se) || se.Stage != "quiesce" {
		t.Fatalf("without drain: %v", err)
	}
	if _, err := c.Drain(ctx, runtimeadmin.DrainRequest{RequestID: "upd-1", Reason: "backup", Scope: "all", LeaseMs: 60_000}); err != nil {
		t.Fatal(err)
	}
	before, _ := w.Runtime.Counts()
	res, err := w.Runner().Run(ctx, checkpoint.Options{Reason: "pre-migration", UnderDrain: "upd-1"})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := w.Runtime.Counts()
	if after != before {
		t.Fatal("the backup service drained on its own inside the manager's drain")
	}
	if id, _ := w.Runtime.Holder(); id != "upd-1" {
		t.Fatalf("the manager's drain was released by the backup service (holder %q)", id)
	}
	if res.Manifest.Quiesce.RequestID != "upd-1" || res.Manifest.Reason != "pre-migration" {
		t.Fatalf("manifest quiesce %+v", res.Manifest.Quiesce)
	}
	_ = c.Resume(ctx, "upd-1")
}

// The manager's checkpointed migration (MG-18) calls the backup API exactly as
// manager/internal/backupclient does and gets a verified checkpoint taken inside its own drain.
func TestManagerMigrationCheckpointAPI(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	sock := filepath.Join(w.Dir, "api-mgr.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	r := w.Runner()
	srv := &api.Server{Cfg: w.Cfg, RuntimeUID: -1, ManagerUID: os.Getuid(),
		Checkpoint: func(ctx context.Context, opts checkpoint.Options) (*checkpoint.Result, error) {
			return r.Run(ctx, opts)
		}}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	hc := unixClient(sock)
	body := `{"reason":"migration","releaseId":"rel-2026.09.2","migrations":["0029_contract_x"],"underDrain":"mgr-upd-7"}` // backupclient's body
	post := func() (int, map[string]any) {
		resp, err := hc.Post("http://backup/v1/checkpoints", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	// Without the manager's drain: refused, nothing taken (the manager defers and retries).
	errOf := func(out map[string]any) map[string]any { e, _ := out["error"].(map[string]any); return e }
	if code, out := post(); code != http.StatusBadGateway || errOf(out)["code"] != "checkpoint_failed" || errOf(out)["stage"] != "quiesce" {
		t.Fatalf("without drain: %d %v", code, out)
	}
	// Strict CheckpointRequest (CT-30): no pre-migration alias, no silent manual fallback, no
	// migration checkpoint without the drain id.
	for _, bad := range []string{
		`{"reason":"pre-migration","releaseId":"rel-2026.09.2"}`,
		`{"reason":"whatever"}`,
		`{"reason":"migration","releaseId":"rel-2026.09.2"}`,
		`{"reason":"manual","underDrain":"x"}`,
		`{"reason":"manual","extra":1}`,
	} {
		resp, err := hc.Post("http://backup/v1/checkpoints", "application/json", strings.NewReader(bad))
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest || errOf(out)["code"] != "bad_request" {
			t.Fatalf("%s: %d %v", bad, resp.StatusCode, out)
		}
	}
	ctx := context.Background()
	c := runtimeadmin.New(w.Runtime.Socket)
	if _, err := c.Drain(ctx, runtimeadmin.DrainRequest{RequestID: "mgr-upd-7", Reason: "backup", Scope: "all", LeaseMs: 60_000}); err != nil {
		t.Fatal(err)
	}
	code, out := post()
	if code != http.StatusOK || out["verified"] != true || out["ref"] == "" {
		t.Fatalf("migration checkpoint: %d %v", code, out)
	}
	ref, _ := out["ref"].(string)
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`).MatchString(ref) { // the manager's proto.ValidCheckpointID
		t.Fatalf("ref %q not a valid checkpoint id for the manager", ref)
	}
	if id, _ := w.Runtime.Holder(); id != "mgr-upd-7" {
		t.Fatal("the manager's drain was released")
	}
	_ = c.Resume(ctx, "mgr-upd-7")
	// The manifest records what it guards.
	d, _ := stateDest(w)
	snaps, _ := w.Cfg.Repo(d).Snapshots(ctx, "ck:"+ref)
	mb, err := w.Cfg.Repo(d).DumpBytes(ctx, snaps[0].ID, "manifest/checkpoint.json")
	if err != nil || !strings.Contains(string(mb), `"releaseId": "rel-2026.09.2"`) || !strings.Contains(string(mb), `"reason": "pre-migration"`) {
		t.Fatalf("manifest: %v %s", err, mb)
	}
	// The runtime can't ask for a migration checkpoint.
	srv2 := &api.Server{Cfg: w.Cfg, RuntimeUID: os.Getuid(), ManagerUID: -1, Checkpoint: srv.Checkpoint}
	sock2 := filepath.Join(w.Dir, "api-rt.sock")
	l2, _ := net.Listen("unix", sock2)
	go srv2.Serve(l2)
	t.Cleanup(func() { srv2.Close() })
	resp, err := unixClient(sock2).Post("http://backup/v1/checkpoints", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	rb, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if le, err := local.ParseLocalError(rb); resp.StatusCode != http.StatusForbidden || err != nil || le.Error.Code != "forbidden" {
		t.Fatalf("runtime asking for a migration checkpoint: HTTP %d %s", resp.StatusCode, rb)
	}
}
