package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/events"
	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

var owner = wire.Person{AccountID: "acc_owner1", Name: "Anna"}

func hour() *int64 { n := int64(3600); return &n }

// within waits for ch, at most 10 s.
func within(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("no %s", what)
	}
}

func TestSuperviseRunsTheWorkerOnlyDuringAGrant(t *testing.T) {
	dir := t.TempDir()
	log := events.Open(filepath.Join(dir, "events.json"), time.Now, t.Logf)
	g, err := grant.Open(grant.Options{Path: filepath.Join(dir, "grant.json"), Environment: wire.EnvLocal, Events: log})
	if err != nil {
		t.Fatal(err)
	}
	started, stopped, ended := make(chan struct{}, 4), make(chan struct{}, 4), make(chan struct{}, 4)
	run := func(ctx context.Context) error {
		if g.Level() == "" {
			t.Error("the worker ran without a grant")
		}
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		return ctx.Err()
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		supervise(ctx, g, run, func() { ended <- struct{}{} }, t.Logf)
		close(done)
	}()

	if _, err := g.Start(wire.LevelLook, hour(), owner); err != nil {
		t.Fatal(err)
	}
	within(t, started, "worker on the grant")
	// A level change keeps the same worker.
	_, _ = g.Start(wire.LevelFix, hour(), owner)
	_ = g.Stop(wire.StopDesk, nil)
	within(t, stopped, "worker stop on the stop")
	within(t, ended, "close-up after the grant")
	if len(started) != 0 || len(ended) != 0 {
		t.Fatalf("%d more starts, %d more ends", len(started), len(ended))
	}
	// Again, and the service stopping ends the worker without a close-up (the record closes itself).
	_, _ = g.Start(wire.LevelLook, hour(), owner)
	within(t, started, "worker on the second grant")
	cancel()
	within(t, stopped, "worker stop at shutdown")
	within(t, done, "supervise's return")
	if len(ended) != 0 {
		t.Fatal("closed up at shutdown")
	}
}

func TestWorkerStartsAgain(t *testing.T) {
	firstPause = time.Millisecond
	defer func() { firstPause = 2 * time.Second }()
	ctx, cancel := context.WithCancel(t.Context())
	runs := 0
	done := make(chan struct{})
	go func() {
		worker(ctx, func(context.Context) error {
			runs++
			if runs == 3 {
				cancel()
			}
			return errors.New("relay closed")
		}, t.Logf)
		close(done)
	}()
	within(t, done, "worker's return")
	if runs != 3 {
		t.Fatalf("%d runs", runs)
	}
}

func TestVisitEvents(t *testing.T) {
	dir := t.TempDir()
	log := events.Open(filepath.Join(dir, "events.json"), time.Now, t.Logf)
	start := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	m := records.Meta{ID: "20261021T120000Z-0123abcd", Who: "Claude", Level: wire.LevelFix, StartedAt: start, Steps: 2000,
		StepsDropped: 5}
	visitStart(log)(m)
	visitEnd(log)(m)
	ev := log.After(t.Context(), 0, 0).Events
	if len(ev) != 2 {
		t.Fatalf("%+v", ev)
	}
	// The contract's members (supportEventValid): startedAt and steps on the end only.
	s, e := ev[0], ev[1]
	if s.Kind != wire.EventVisitStart || *s.VisitID != m.ID || *s.Who != "Claude" || *s.Level != wire.LevelFix ||
		s.StartedAt != nil || s.Steps != nil || !wire.EventValid(s) {
		t.Fatalf("start %+v", s)
	}
	if e.Kind != wire.EventVisitEnd || *e.StartedAt != "2026-10-21T12:00:00Z" || e.Steps == nil || *e.Steps != 2005 ||
		!wire.EventValid(e) {
		t.Fatalf("end %+v", e)
	}
}

func TestDeviceID(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "device.json")
	read := deviceID(p)
	if _, err := read(); err == nil {
		t.Fatal("no file, an id")
	}
	for body, want := range map[string]string{
		`{"v":1,"deviceId":"dev_7Hq2mXk3","env":"local"}`: "dev_7Hq2mXk3",
		`{"v":1,"deviceId":"dev 1"}`:                      "",
		`{"v":1,"deviceId":""}`:                           "",
		`{`:                                               "",
	} {
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		got, err := read()
		if got != want || (want == "") != (err != nil) {
			t.Errorf("%s: %q %v", body, got, err)
		}
	}
}
