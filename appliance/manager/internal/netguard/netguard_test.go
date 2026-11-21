package netguard_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

type checker struct{ ok atomic.Bool }

func (c *checker) Check(context.Context) error {
	if c.ok.Load() {
		return nil
	}
	return errors.New("no route to control")
}

type engineLock struct{ e *update.Engine }

func (l engineLock) AcquireLock(h, r string, ttl time.Duration) error {
	_, err := l.e.AcquireLock(h, r, ttl)
	return err
}
func (l engineLock) ReleaseLock(h string) error { return l.e.ReleaseLock(h) }

func candidate(id string) *netconfig.Candidate {
	c, err := netconfig.Parse([]byte(`{"v":1,"id":"` + id + `","interface":"enp1s0","ipv4":{"mode":"static","address":"192.168.9.5/24","gateway":"192.168.9.1"},"ipv6":{"mode":"auto"},"dns":["192.168.9.1"],"confirmTimeoutSec":60}`))
	if err != nil {
		panic(err)
	}
	return c
}

func guard(w *testworld.World, chk *checker) *netguard.Guard {
	return &netguard.Guard{CandidatesDir: w.P.NetCands, StateDir: filepath.Join(w.P.Dir, "manager", "netstate"),
		Helper: helperclient.Client{Socket: w.P.HelperSock}, Check: chk, Lock: engineLock{w.Engine}, Now: w.Clock.Now}
}

func run(t *testing.T, w *testworld.World, g *netguard.Guard, until string) *netguard.State {
	t.Helper()
	for i := 0; i < 100; i++ {
		st, _ := g.Load()
		if st.Phase == until {
			return st
		}
		wait, err := g.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		w.Clock.Advance(wait)
	}
	st, _ := g.Load()
	t.Fatalf("stuck in %s", st.Phase)
	return nil
}

func TestNetworkChangeConfirmed(t *testing.T) {
	w := testworld.New(t)
	chk := &checker{}
	chk.ok.Store(true)
	g := guard(w, chk)
	if err := g.Submit(candidate("n-a")); err != nil {
		t.Fatal(err)
	}
	// Updates cannot activate while a network change holds maintenance.
	if _, err := w.Engine.AcquireLock("backup", "x", time.Minute); !errors.Is(err, update.ErrLockBusy) {
		t.Fatalf("lock: %v", err)
	}
	run(t, w, g, netguard.PhaseCommitted)
	if !strings.Contains(w.Helper.ActiveNetwork(), "192.168.9.5/24") || w.Helper.DeadmanArmed() {
		t.Fatal("not committed")
	}
	if _, err := w.Engine.AcquireLock("backup", "x", time.Minute); err != nil {
		t.Fatalf("lock not released: %v", err)
	}
}

func TestNetworkChangeWithoutConnectivityRollsBack(t *testing.T) {
	w := testworld.New(t)
	g := guard(w, &checker{})
	g.Submit(candidate("n-b"))
	st := run(t, w, g, netguard.PhaseReverted)
	if !strings.Contains(st.Result, "deadline") || strings.Contains(w.Helper.ActiveNetwork(), "192.168.9.5") {
		t.Fatalf("not reverted: %+v %q", st, w.Helper.ActiveNetwork())
	}
}

func TestManagerCrashDuringNetworkChange(t *testing.T) {
	w := testworld.New(t)
	g := guard(w, &checker{})
	g.Submit(candidate("n-c"))
	g.Step(context.Background()) // applied, now confirming
	// The manager dies; its restart after the deadline reverts from the persisted state.
	w.Clock.Advance(5 * time.Minute)
	g2 := guard(w, &checker{})
	run(t, w, g2, netguard.PhaseReverted)
	// And if the manager never comes back, the helper's dead-man revert does it.
	g3 := guard(w, &checker{})
	g3.Submit(candidate("n-d"))
	g3.Step(context.Background())
	if !w.Helper.DeadmanArmed() {
		t.Fatal("dead-man not armed")
	}
	if err := w.Helper.FireNetworkDeadman(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(w.Helper.ActiveNetwork(), "192.168.9.5") {
		t.Fatal("dead-man did not revert")
	}
}
