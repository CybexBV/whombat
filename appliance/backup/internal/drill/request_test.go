package drill

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func testConfig(t *testing.T) *state.Config {
	c := &state.Config{Persist: t.TempDir()}
	c.Defaults()
	if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return c
}

// Requests queue in order, the same one twice counts once, and the file goes once the last is taken (the path unit
// starts the drill while it exists).
func TestRequestQueue(t *testing.T) {
	c := testConfig(t)
	now := time.Now().UTC()
	for _, r := range []Request{{CheckpointID: "ck-a", Own: true, At: now}, {CheckpointID: "ck-b", At: now}, {CheckpointID: "ck-a", Own: true, At: now}} {
		if err := Enqueue(c, r); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{"ck-a", "ck-b"} {
		if !Pending(c) {
			t.Fatalf("%s: nothing pending", want)
		}
		r, err := Take(c)
		if err != nil || r == nil || r.CheckpointID != want {
			t.Fatalf("take: %+v %v, want %s", r, err, want)
		}
	}
	if Pending(c) {
		t.Fatal("still pending")
	}
	if _, err := os.Stat(RequestPath(c)); !os.IsNotExist(err) {
		t.Fatalf("the request file stayed: %v", err)
	}
	if r, err := Take(c); r != nil || err != nil {
		t.Fatalf("empty take: %+v %v", r, err)
	}
	// A request written before the queue (one bare object) is still taken.
	if err := state.WriteJSON(RequestPath(c), Request{CheckpointID: "ck-old", Own: true, At: now}, 0o600); err != nil {
		t.Fatal(err)
	}
	if r, _ := Take(c); r == nil || r.CheckpointID != "ck-old" || !r.Own {
		t.Fatalf("old request: %+v", r)
	}
}

// A request made while a backup holds the run lock waits for it: nothing is taken until the lock is free.
func TestRequestWaitsForTheRunLock(t *testing.T) {
	c := testConfig(t)
	if err := Enqueue(c, Request{CheckpointID: "ck-1", Own: true, At: time.Now()}); err != nil {
		t.Fatal(err)
	}
	backup, err := state.TryLock(c)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	if _, err := WaitLock(ctx, c, 20*time.Millisecond); err == nil {
		t.Fatal("got the lock a backup holds")
	}
	cancel()
	if !Pending(c) {
		t.Fatal("the request was lost while the backup ran")
	}
	got := make(chan error, 1)
	go func() {
		l, err := WaitLock(context.Background(), c, 10*time.Millisecond)
		if err == nil {
			defer l.Unlock()
			var r *Request
			if r, err = Take(c); err == nil && (r == nil || r.CheckpointID != "ck-1") {
				err = os.ErrNotExist
			}
		}
		got <- err
	}()
	time.Sleep(50 * time.Millisecond)
	backup.Unlock()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("after the backup: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the check never got the lock")
	}
}
