package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func waitFile(t *testing.T, path string, contains string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), contains) {
			return string(b)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s did not contain %q", path, contains)
	return ""
}

func TestSupervisorRestartsAndStops(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "worker")
	pidfile := filepath.Join(dir, "agent.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- supervise(ctx, nil, pidfile, io.Discard, 10*time.Millisecond, time.Second, func() *exec.Cmd {
			return exec.Command("sh", "-c", `if [ ! -f "$1" ]; then echo crashed > "$1"; exit 1; fi; echo "running $$" >> "$1"; while :; do sleep 1; done`, "worker", marker)
		})
	}()
	text := waitFile(t, marker, "running")
	parts := strings.Fields(text)
	pid, _ := strconv.Atoi(parts[len(parts)-1])
	// Another starter must not duplicate a running worker or truncate its PID.
	before, _ := os.ReadFile(pidfile)
	err := supervise(ctx, nil, pidfile, io.Discard, time.Second, time.Second, func() *exec.Cmd {
		t.Error("second supervisor started a worker")
		return exec.Command("true")
	})
	if err == nil {
		t.Fatal("second supervisor acquired the lock")
	}
	after, _ := os.ReadFile(pidfile)
	if string(before) != string(after) {
		t.Fatal("second supervisor changed the PID file")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("supervisor did not stop")
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("worker survived supervisor shutdown")
	}
	b, _ := os.ReadFile(pidfile)
	if len(b) != 0 {
		t.Fatal("PID file was not cleared")
	}
}

func TestSupervisorReloadAndForcedStop(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "signals")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hup := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() {
		done <- supervise(ctx, hup, filepath.Join(dir, "agent.pid"), io.Discard, time.Second, 50*time.Millisecond, func() *exec.Cmd {
			return exec.Command("sh", "-c", `trap 'echo reloaded >> "$1"' HUP; trap '' TERM; echo "ready $$" > "$1"; while :; do sleep 0.05; done`, "worker", marker)
		})
	}()
	text := waitFile(t, marker, "ready")
	pid, _ := strconv.Atoi(strings.Fields(text)[1])
	hup <- syscall.SIGHUP
	waitFile(t, marker, "reloaded")
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("uncooperative worker prevented shutdown")
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("uncooperative worker survived forced shutdown")
	}
}
