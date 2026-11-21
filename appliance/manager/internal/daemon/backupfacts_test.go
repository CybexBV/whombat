package daemon_test

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// A backup service whose status the test sets (`GET /v1/status`).
type fakeBackup struct {
	mu     sync.Mutex
	status string
}

func (f *fakeBackup) set(s string) { f.mu.Lock(); f.status = s; f.mu.Unlock() }

func (f *fakeBackup) start(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/status" {
			http.NotFound(w, r)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(f.status))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

// backupStatus is a status document whose last backup is id, aged age seconds.
func backupStatus(id string, age int) string {
	return fmt.Sprintf(`{"kind":"whombat.backup-status/1","state":"protected","protected":true,`+
		`"destination":{"configured":true,"kind":"rest","display":"nas.local/whombat","appendOnly":"verified","repositoryId":"a1b2c3d4"},`+
		`"lastSuccess":{"id":%q,"at":"2026-11-04T11:07:00Z","ageSeconds":%d,"snapshotId":"4f9c2e1a","method":"snapshot",`+
		`"quiesceHeldMs":850,"durationMs":9200,"bytesAdded":674000,"totalBytes":3700000,"files":211,"schemaVersion":120},`+
		`"lastFailure":null,"lastAttemptOk":true,"failedAttempts":0,"coverage":[],"recoverability":{"lastDrill":null},`+
		`"kitGeneration":1,"running":null,"updatedAt":"2026-11-04T11:%02d:00Z"}`, id, age, age%60)
}

// MG-152 through the running daemon: the runtime's facts carry the backup service's status from the start, and a new
// backup reaches the runtime within seconds, though facts are re-sent only every hour here. A status that differs only
// in its age isn't pushed again; one the service can't give leaves the backup facts out (unknown), never invented.
func TestBackupStatusReachesTheRuntime(t *testing.T) {
	t.Parallel()
	svc := &fakeBackup{status: backupStatus("ck-1", 60)}
	sock := svc.start(t)
	h := startDaemon(t, map[string]any{"backupSocket": sock, "backupWatchSec": 1, "factsResendSec": 3600})
	rt := h.w.Runtime
	last := func() string {
		f := rt.Facts()
		switch {
		case f == nil:
			return "no facts"
		case f.Backup == nil:
			return "no backup facts"
		case f.Backup.LastSuccess == nil:
			return "no last backup"
		}
		return f.Backup.LastSuccess.ID
	}
	show := func() string { return "facts: " + last() }
	h.eventually("the start-up facts with the backup status", func() bool { return last() == "ck-1" }, show)
	if f := rt.Facts(); f.Update == nil || f.Backup.KitGeneration != 1 || f.Backup.Destination.RepositoryID == nil {
		t.Fatalf("%+v", f)
	}

	svc.set(backupStatus("ck-2", 0))
	h.eventually("the new backup at the runtime", func() bool { return last() == "ck-2" }, show)

	svc.set(`{"kind":"whombat.backup-status/1","state":"somewhere"}`)
	h.eventually("no backup facts while the status is unusable", func() bool { return last() == "no backup facts" }, show)
}
