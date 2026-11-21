package collect

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

func TestSubScheduling(t *testing.T) {
	c := &collector{cfg: &agent.Config{}, events: make(chan proto.Event, 8), lastEv: map[string]time.Time{}}
	c.bgCtx = context.Background()
	var fast, slow, dep, boom atomic.Int32
	fs := c.addSub("fast", 10*time.Second, func(context.Context) error { fast.Add(1); return nil }, nil)
	ss := c.addSub("slow", time.Hour, func(context.Context) error { slow.Add(1); return errors.New("broken") }, nil)
	ds := c.addSub("dep", time.Hour, func(context.Context) error { dep.Add(1); return nil }, ss)
	bs := c.addSub("boom", time.Hour, func(context.Context) error { boom.Add(1); panic("bad parser") }, nil)

	now := time.Now()
	for _, s := range []*sub{fs, ss, bs} {
		s.mu.Lock()
		if !s.due(now) {
			t.Errorf("%s not due on first run", s.name)
		}
		s.mu.Unlock()
	}
	ds.mu.Lock()
	if ds.due(now) {
		t.Error("dep must wait for its dependency")
	}
	ds.mu.Unlock()

	// Run all due subs synchronously.
	runDue := func() {
		for _, s := range c.subs {
			s.mu.Lock()
			var done chan struct{}
			if s.due(time.Now()) {
				done = s.start(c.bgCtx, c)
			}
			s.mu.Unlock()
			if done != nil {
				<-done
			}
		}
	}
	runDue()
	if fast.Load() != 1 || slow.Load() != 1 || dep.Load() != 1 || boom.Load() != 1 {
		t.Errorf("runs: fast=%d slow=%d dep=%d boom=%d", fast.Load(), slow.Load(), dep.Load(), boom.Load())
	}
	runDue() // nothing is due yet
	if fast.Load() != 1 {
		t.Error("fast ran again before its interval")
	}
	// An event marks the sub dirty, but only after minEventGap.
	fs.markDirty()
	runDue()
	if fast.Load() != 1 {
		t.Error("dirty sub ran within minEventGap")
	}
	fs.mu.Lock()
	fs.lastRun = fs.lastRun.Add(-minEventGap)
	fs.mu.Unlock()
	runDue()
	if fast.Load() != 2 {
		t.Error("dirty sub did not run")
	}

	st := map[string]proto.CollectorStatus{}
	for _, s := range c.statuses() {
		st[s.Name] = s
	}
	if !st["fast"].OK || st["slow"].OK || st["slow"].Error != "broken" || st["boom"].OK || st["boom"].Error != "panic: bad parser" {
		t.Errorf("statuses: %+v", st)
	}
	// Errors were reported as collector.error events (once each).
	n := 0
	for len(c.events) > 0 {
		if ev := <-c.events; ev.Kind == "collector.error" {
			n++
		}
	}
	if n != 2 {
		t.Errorf("collector.error events: %d", n)
	}
	// Absent platforms are not listed.
	bs.setAbsent(true)
	for _, s := range c.statuses() {
		if s.Name == "boom" {
			t.Error("absent sub listed")
		}
	}
}

func TestEmitNonBlocking(t *testing.T) {
	c := &collector{events: make(chan proto.Event, 2), lastEv: map[string]time.Time{}}
	for i := 0; i < 5; i++ {
		c.emit(proto.Event{Kind: "guest.state_changed", Platform: "docker", GuestID: string(rune('a' + i)), State: "running"}, true)
	}
	if len(c.events) != 2 {
		t.Errorf("buffered %d", len(c.events))
	}
}

func TestRate(t *testing.T) {
	if r := rate(2000, 1000, 10); r == nil || *r != 100 {
		t.Errorf("rate %v", r)
	}
	if r := rate(10, 1000, 10); r != nil {
		t.Error("counter reset must give nil")
	}
	if r := rate(10, 0, 0); r != nil {
		t.Error("dt=0 must give nil")
	}
}

// A run that ignores its context never finishes; once it overruns its
// timeout the sub is reported as stuck instead of with its last result, and
// a stuck platform collector's guests are flagged as not reporting.
func TestStuckSubIsReported(t *testing.T) {
	c := &collector{cfg: &agent.Config{}, events: make(chan proto.Event, 8), lastEv: map[string]time.Time{}}
	c.bgCtx = context.Background()
	block := make(chan struct{})
	defer close(block)
	s := c.addSub(proto.PlatformDocker, 10*time.Second, func(context.Context) error { <-block; return nil }, nil)
	s.timeout = 10 * time.Millisecond
	c.dockerSub = s
	s.mu.Lock()
	s.start(c.bgCtx, c)
	s.runStart = time.Now().Add(-time.Minute) // pretend it has been blocked a minute
	s.mu.Unlock()
	st := c.statuses()
	if len(st) != 1 || st[0].OK || !strings.HasPrefix(st[0].Error, "stuck: no result for 1m") {
		t.Fatalf("statuses: %+v", st)
	}
	r := &proto.Report{Docker: &proto.Platform{Guests: []proto.Guest{{ID: "web", State: proto.StateRunning}}}}
	c.markStuckPlatforms(r)
	if r.Docker.Error == "" || len(r.Docker.Guests) != 1 {
		t.Fatalf("stuck platform: %+v", r.Docker)
	}
	s.mu.Lock()
	s.runStart = time.Now().Add(-10 * time.Minute)
	s.mu.Unlock()
	r = &proto.Report{Docker: &proto.Platform{Guests: []proto.Guest{{ID: "web", State: proto.StateRunning}}}}
	c.markStuckPlatforms(r)
	if len(r.Docker.Guests) != 0 {
		t.Fatal("guests of a long-stuck platform must not be reported")
	}
}

// A failing platform keeps its last guests for keepOnError, then drops them.
func TestFailedPlatformKeepsGuestsBriefly(t *testing.T) {
	prev := &proto.Platform{Version: "27", Guests: []proto.Guest{{ID: "web"}}}
	err := errors.New("connection refused")
	if p := failedPlatform(prev, time.Now().Add(-30*time.Second), "27", err); len(p.Guests) != 1 || p.Error == "" {
		t.Fatalf("recent success: %+v", p)
	}
	if p := failedPlatform(prev, time.Now().Add(-keepOnError-time.Second), "27", err); len(p.Guests) != 0 {
		t.Fatalf("old success: %+v", p)
	}
	if p := failedPlatform(nil, time.Time{}, "", err); p.Error != "connection refused" {
		t.Fatalf("no previous: %+v", p)
	}
}

func TestStatfsTimeout(t *testing.T) {
	st, err := statfsTimeout("/", time.Second)
	if err != nil || st.Blocks == 0 {
		t.Fatalf("statfs /: %+v %v", st, err)
	}
	r, err := statfs("/")
	if err != nil || r.Size == 0 || r.Used > r.Size {
		t.Fatalf("statfs result: %+v %v", r, err)
	}
}

func agentCollectors(imageUpdates *bool) agent.Collectors {
	return agent.Collectors{ImageUpdates: imageUpdates}
}

// Partial errors keep the collector OK and send no collector.error event.
func TestPartialError(t *testing.T) {
	c := &collector{cfg: &agent.Config{}, events: make(chan proto.Event, 8), lastEv: map[string]time.Time{}}
	c.bgCtx = context.Background()
	s := c.addSub("smart", time.Hour, func(context.Context) error { return partial("sdc: open failed") }, nil)
	s.mu.Lock()
	done := s.start(c.bgCtx, c)
	s.mu.Unlock()
	<-done
	st := c.statuses()
	if len(st) != 1 || !st[0].OK || st[0].Error != "sdc: open failed" {
		t.Errorf("status: %+v", st)
	}
	if len(c.events) != 0 {
		t.Error("partial error sent an event")
	}
}

// Reloaded toggles reach the collectors without a restart.
func TestSetCollectors(t *testing.T) {
	c := newTestCollector()
	if !c.smart.toggle.enabled(true) {
		t.Fatal("smart default on")
	}
	off := false
	c.SetCollectors(agent.Collectors{SMART: &off})
	if c.smart.toggle.enabled(true) {
		t.Error("smart still on after reload")
	}
	for _, s := range c.subs {
		s.mu.Lock()
		dirty := s.dirty
		s.mu.Unlock()
		if !dirty {
			t.Errorf("%s not marked to run again", s.name)
		}
	}
}
