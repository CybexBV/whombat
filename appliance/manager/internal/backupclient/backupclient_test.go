package backupclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func serve(t *testing.T, h http.HandlerFunc) string {
	dir, _ := os.MkdirTemp(os.Getenv("XDG_RUNTIME_DIR"), "bkc")
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "b.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func TestCheckpointSendsStrictRequestWithUnderDrain(t *testing.T) {
	var got []byte
	sock := serve(t, func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		json.NewEncoder(w).Encode(local.CheckpointResult{Ok: true, Ref: "ckpt-7", Verified: true, ID: "c7", Seq: 7,
			SnapshotID: "s", ManifestSHA256: "0000000000000000000000000000000000000000000000000000000000000000",
			CreatedAt: "2026-09-25T12:00:00Z", SchemaVersion: 12})
	})
	ref, err := Client{Socket: sock}.Checkpoint(context.Background(), update.CheckpointRequest{ReleaseID: "rt-2", Migrations: []string{"m0012"}, UnderDrain: "drain-abc"})
	if err != nil || ref != "ckpt-7" {
		t.Fatalf("%s %v", ref, err)
	}
	req, err := local.ParseCheckpointRequest(got)
	if err != nil || req.Reason != "migration" || req.UnderDrain == nil || *req.UnderDrain != "drain-abc" {
		t.Fatalf("request %s: %v", got, err)
	}
}

func TestCheckpointLocalErrors(t *testing.T) {
	stage := "upload"
	sock := serve(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(local.LocalError{Error: local.LocalErrorError{Code: "checkpoint_failed", Message: "upload failed", Stage: &stage}})
	})
	_, err := Client{Socket: sock}.Checkpoint(context.Background(), update.CheckpointRequest{ReleaseID: "rt-2"})
	var be *Error
	if !errors.As(err, &be) || be.Code != "checkpoint_failed" || be.Stage == nil || *be.Stage != "upload" {
		t.Fatalf("%v", err)
	}
}
