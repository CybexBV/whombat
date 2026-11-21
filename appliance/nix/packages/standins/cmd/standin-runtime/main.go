// Command standin-runtime stands in for the Whombat runtime in VM tests until the real runtime is
// packaged (NX-20). It is NOT the product: it only has the runtime's operational surface.
//
//	whombat-server: admin socket ($WHOMBAT_ADMIN_SOCKET) with GET /health, POST /drain, POST /resume;
//	                /health checks PostgreSQL (psql over the unix socket) and the credentials.
//	whombat-runner: nothing but readiness and the watchdog.
//
// Fault injection for tests (files under /run/whombat-standin/, created by root in tests):
//
//	hang       stop sending WATCHDOG=1 (systemd must kill and restart the process)
//	unhealthy  /health answers "degraded"
//	crash      exit 1 at start (and every restart)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"whombat-appliance/standins/sdnotify"
)

var (
	version   = "standin-0"
	psql      = "psql"
	faultDir  = "/run/whombat-standin"
	releaseID = ""
)

func fault(name string) bool {
	_, err := os.Stat(filepath.Join(faultDir, name))
	return err == nil
}

func watchdog() {
	iv := sdnotify.WatchdogInterval()
	if iv == 0 {
		return
	}
	for range time.Tick(iv) {
		if fault("hang") {
			log.Print("fault: hang (not petting the watchdog)")
			continue
		}
		_ = sdnotify.Send("WATCHDOG=1")
	}
}

type check struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

func dbCheck(ctx context.Context) check {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, psql, "-X", "-A", "-t", "-h", "/run/postgresql", "-d", "whombat", "-c", "select 1").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "1" {
		return check{OK: false, Detail: strings.TrimSpace(string(out))}
	}
	return check{OK: true}
}

func credCheck() check {
	dir := os.Getenv("CREDENTIALS_DIRECTORY")
	for _, n := range []string{"master-key", "content-identity"} {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			return check{OK: false, Detail: "missing credential " + n}
		}
	}
	return check{OK: true}
}

func server() {
	sock := os.Getenv("WHOMBAT_ADMIN_SOCKET")
	if sock == "" {
		log.Fatal("WHOMBAT_ADMIN_SOCKET not set")
	}
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatal(err)
	}
	_ = os.Chmod(sock, 0o666) // the real runtime checks the peer uid; the stand-in answers anyone local
	draining := false
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		db, cred := dbCheck(r.Context()), credCheck()
		status := "ok"
		if !db.OK || !cred.OK || fault("unhealthy") {
			status = "degraded"
		}
		resp := map[string]any{"v": 1, "status": status, "releaseId": releaseID, "version": version,
			"checks": map[string]any{
				"db":              db,
				"credentials":     cred,
				"migrations":      map[string]any{"ok": db.OK, "compatible": true, "access": "read-write", "schemaVersion": 0},
				"sessionEndpoint": check{OK: true, Detail: "stand-in has no session endpoint"},
			}}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("POST /drain", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			RequestID string `json:"requestId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		draining = true
		_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "requestId": req.RequestID, "draining": true, "safe": true, "blockers": []any{}, "estimatedMs": 0})
	})
	mux.HandleFunc("POST /resume", func(w http.ResponseWriter, r *http.Request) {
		draining = false
		w.WriteHeader(http.StatusNoContent)
	})
	// GET /facts (CT-37): never claimed unless the test says so (fault file "claimed"). The manager's pushes
	// (facts, claim window, claim-code lease) are accepted and ignored.
	mux.HandleFunc("GET /facts", func(w http.ResponseWriter, r *http.Request) {
		claimed := fault("claimed")
		_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "activeSessions": 0, "claimed": claimed, "claimReported": claimed,
			"recovery": map[string]any{"enrolled": false, "kitVerified": false}, "revocations": map[string]any{"pending": 0, "applied": 0},
			"draining": false, "quarantined": false, "relay": "stopped",
			// Required since contracts 1.0.0 (the real runtime has always sent them, CT-73).
			"clientAdapters": map[string]any{"claude": 1, "codex": 1}})
	})
	for _, p := range []string{"/facts", "/claim-window", "/claim-lookup"} {
		mux.HandleFunc("POST "+p, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"v":1,"ok":true}`))
		})
	}
	go func() { log.Fatal(http.Serve(ln, mux)) }()
	_ = draining
}

func main() {
	log.SetFlags(0)
	role := filepath.Base(os.Args[0])
	if fault("crash") {
		log.Fatalf("fault: crash (%s)", role)
	}
	if strings.HasSuffix(role, "server") {
		server()
	}
	_ = sdnotify.Send(fmt.Sprintf("READY=1\nSTATUS=%s %s running", role, version))
	log.Printf("%s %s ready", role, version)
	watchdog()
	select {}
}
