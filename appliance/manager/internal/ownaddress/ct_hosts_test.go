package ownaddress

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// The watch covers every host the box answers at, each with its own record: a new host starts without a restart, a
// host the box no longer answers at stops and is forgotten. One answer names them all and claims no more than each.
func TestCTOverTwoHosts(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	f := &fakeSpotter{pages: [][]map[string]any{{
		issuanceOf("1", newHost),
		issuanceOf("2", "*.whombat.app", "whombat.app"), // covers newHost, not oldHost
		issuanceOf("3", oldHost),
		issuanceOf("4", "*.box.whombat.app"), // covers oldHost only
		issuanceOf("5", "other-name.whombat.app"),
	}}}
	w, st := newWatch(t, f, c)
	var open atomic.Bool
	open.Store(true)
	w.Sleep = func(ctx context.Context, d time.Duration) bool {
		if open.Load() && d < time.Minute {
			return true // each host's first check (within a minute of its start) at once; the next never
		}
		<-ctx.Done()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer func() { cancel(); w.Wait() }()
	w.Follow(ctx, []string{newHost, oldHost})
	fresh := func() bool {
		r := w.Response(c.now())
		return r != nil && len(r.Hosts) == 2 && r.LastFreshAt != nil
	}
	for i := 0; i < 200 && !fresh(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	r := w.Response(c.now())
	if !fresh() || !slices.Equal(r.Hosts, []string{newHost, oldHost}) || r.Validate() != nil {
		t.Fatalf("%+v", r)
	}
	var ids []string
	for _, cert := range r.Certs {
		ids = append(ids, cert.ID)
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []string{"1", "2", "3", "4"}) {
		t.Fatalf("certs %v", ids)
	}
	for _, h := range []string{newHost, oldHost} {
		if _, err := os.Stat(filepath.Join(st.Dir(), "ct-"+h+".json")); err != nil {
			t.Fatalf("no record for %s: %v", h, err)
		}
	}

	// The old host stops: its record goes, in the answer and on disk.
	w.Follow(ctx, []string{newHost})
	r = w.Response(c.now())
	if !slices.Equal(r.Hosts, []string{newHost}) || slices.ContainsFunc(r.Certs, func(c local.OwnAddressCtCert) bool { return c.ID == "3" || c.ID == "4" }) {
		t.Fatalf("after the old host stopped: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), "ct-"+oldHost+".json")); !os.IsNotExist(err) {
		t.Fatalf("the old host's record stayed: %v", err)
	}

	// A new host joins: until it was checked the answer has no fresh check, and it watches only since then.
	c.add(time.Hour)
	open.Store(false)
	w.Follow(ctx, []string{homeHost, newHost})
	for i := 0; i < 200 && len(w.Response(c.now()).Hosts) < 2; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	r = w.Response(c.now())
	if !slices.Equal(r.Hosts, []string{homeHost, newHost}) || r.LastFreshAt != nil || r.CheckingSince != "2026-11-23T13:00:00Z" {
		t.Fatalf("with a new host: %+v", r)
	}
}

// An older manager's ct.json counts for its host, and goes once the host has a record of its own.
func TestCTTakesAnOlderRecord(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	w, st := newWatch(t, &fakeSpotter{}, c)
	since := c.now().Add(-48 * time.Hour)
	if err := st.writeJSON(ctFile, CTState{Host: oldHost, CheckingSince: since, Missed: []Window{}}); err != nil {
		t.Fatal(err)
	}
	if err := w.Start(oldHost); err != nil {
		t.Fatal(err)
	}
	if r := w.Response(c.now()); r.CheckingSince != since.Format(time.RFC3339) {
		t.Fatalf("%+v", r)
	}
	if err := w.Check(context.Background(), oldHost); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(st.Dir(), ctFile)); !os.IsNotExist(err) {
		t.Fatal("ct.json stayed")
	}
	if r := w.Response(c.now()); r.CheckingSince != since.Format(time.RFC3339) || r.LastFreshAt == nil {
		t.Fatalf("%+v", r)
	}
}

func TestRelevantNamesPerZone(t *testing.T) {
	names := []string{"*.whombat.app", "*.box.whombat.app", "whombat.app"}
	if got := RelevantNames(names, newHost, ZoneOf(newHost)); !slices.Equal(got, []string{"*.whombat.app"}) {
		t.Fatal(got)
	}
	if got := RelevantNames(names, oldHost, ZoneOf(oldHost)); !slices.Equal(got, []string{"*.box.whombat.app"}) {
		t.Fatal(got)
	}
}
