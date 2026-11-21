package grant

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/events"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

// clock is a test clock: After's functions run when advance passes their time.
type clock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer
}

type timer struct {
	at      time.Time
	f       func()
	stopped bool
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) After(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &timer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

// pending counts the timers that would still fire.
func (c *clock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}

// advance moves the clock by d, firing every timer due on the way, in order.
func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var next *timer
		for _, t := range c.timers {
			if !t.stopped && !t.at.After(end) && (next == nil || t.at.Before(next.at)) {
				next = t
			}
		}
		if next == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		next.stopped = true
		if next.at.After(c.now) {
			c.now = next.at
		}
		c.mu.Unlock()
		next.f()
	}
}

// jump sets the wall clock without firing anything (a time sync).
func (c *clock) jump(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

type fixture struct {
	t     *testing.T
	dir   string
	clock *clock
	log   *events.Log
	codes []string
}

func newFixture(t *testing.T) *fixture {
	dir := t.TempDir()
	c := &clock{now: time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)}
	return &fixture{t: t, dir: dir, clock: c, log: events.Open(filepath.Join(dir, "events.json"), c.Now, t.Logf),
		codes: []string{"KQ72MX", "AB34CD", "ZZ99YY"}}
}

func (f *fixture) open(env string) *Store {
	f.t.Helper()
	s, err := Open(Options{Path: filepath.Join(f.dir, "grant.json"), Environment: env, Events: f.log, Now: f.clock.Now,
		After: f.clock.After, Logf: f.t.Logf, NewCode: func() (string, error) {
			c := f.codes[0]
			f.codes = f.codes[1:]
			return c, nil
		}})
	if err != nil {
		f.t.Fatal(err)
	}
	return s
}

// kinds lists the event kinds after seq after.
func (f *fixture) kinds(after int64) []string {
	var out []string
	for _, e := range f.log.After(f.t.Context(), after, 0).Events {
		if !wire.EventValid(e) {
			f.t.Errorf("not a valid event: %+v", e)
		}
		out = append(out, string(e.Kind))
	}
	return out
}

func secs(n int64) *int64 { return &n }

var owner = wire.Person{AccountID: "acc_owner1", Name: "Anna de Vries"}

func closed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestDurationsAndLevels(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvProd)
	for _, d := range []*int64{secs(0), secs(60), secs(7200), secs(-3600)} {
		if _, err := s.Start(wire.LevelLook, d, owner); !errors.Is(err, ErrBadDuration) {
			t.Errorf("duration %d: %v", *d, err)
		}
	}
	for _, l := range []string{"", "root", "LOOK"} {
		if _, err := s.Start(l, secs(3600), owner); !errors.Is(err, ErrBadLevel) {
			t.Errorf("level %q: %v", l, err)
		}
	}
	for _, p := range []wire.Person{{}, {AccountID: "owner1", Name: "Anna"}, {AccountID: "acc_x", Name: ""},
		{AccountID: "acc_x", Name: "line\nbreak"}, {AccountID: "acc_x", Name: string(make([]byte, 121))}} {
		if _, err := s.Start(wire.LevelLook, secs(3600), p); !errors.Is(err, ErrBadPerson) {
			t.Errorf("person %+v: %v", p, err)
		}
	}
	if s.Level() != "" || len(f.kinds(0)) != 0 {
		t.Fatalf("a refused start changed something: %q %v", s.Level(), f.kinds(0))
	}
	for _, d := range wire.DurationsS {
		g, err := s.Start(wire.LevelFix, secs(d), owner)
		until, _ := time.Parse(time.RFC3339, *g.Until)
		if err != nil || until.Sub(f.clock.Now()) != time.Duration(d)*time.Second || g.Level != wire.LevelFix {
			t.Fatalf("%d: %+v %v", d, g, err)
		}
	}
}

func TestForeverPerEnvironment(t *testing.T) {
	for _, env := range []string{wire.EnvLocal, wire.EnvDev, wire.EnvProd} {
		f := newFixture(t)
		s := f.open(env)
		g, err := s.Start(wire.LevelFix, nil, owner)
		prod := env == wire.EnvProd
		if prod != errors.Is(err, ErrForeverNotAllowed) || s.ForeverAllowed() == prod || s.HelpCodeRequired() != prod {
			t.Fatalf("%s: %+v %v", env, g, err)
		}
		if !prod && (g.Until != nil || g.HelpCode != nil || s.Level() != wire.LevelFix || f.clock.pending() != 0) {
			t.Fatalf("%s: forever %+v, %d timers", env, g, f.clock.pending())
		}
		// Forever stays on: no timer, a year later still on.
		f.clock.advance(365 * 24 * time.Hour)
		if !prod && s.Level() != wire.LevelFix {
			t.Fatalf("%s: forever ended", env)
		}
	}
	if _, err := Open(Options{Path: filepath.Join(t.TempDir(), "g"), Environment: "staging", Events: newFixture(t).log}); err == nil {
		t.Fatal("an unknown environment opened")
	}
}

func TestHelpCodes(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvProd)
	if s.CheckCode("KQ72MX") {
		t.Fatal("a code passed without a grant")
	}
	g, err := s.Start(wire.LevelLook, secs(3600), owner)
	if err != nil || g.HelpCode == nil || *g.HelpCode != "KQ72MX" {
		t.Fatalf("%+v %v", g, err)
	}
	// Normalised: the way people type it.
	for _, typed := range []string{"KQ72MX", "kq7·2mx", "KQ7-2MX", "kq7 2mx", "KQ7.2MX"} {
		if !s.CheckCode(typed) {
			t.Fatalf("%q refused", typed)
		}
	}
	if s.Grant().WrongCodes != 0 {
		t.Fatal("a right code counted")
	}
	// A change keeps the code and the count; a stop and a new start make a new code.
	if s.CheckCode("support") || s.Grant().WrongCodes != 1 {
		t.Fatal("a wrong code didn't count")
	}
	g, _ = s.Start(wire.LevelFix, secs(86400), owner)
	if *g.HelpCode != "KQ72MX" || g.WrongCodes != 1 || g.Level != wire.LevelFix {
		t.Fatalf("change: %+v", g)
	}
	if err := s.Stop(wire.StopDesk, nil); err != nil {
		t.Fatal(err)
	}
	g, _ = s.Start(wire.LevelLook, secs(3600), owner)
	if *g.HelpCode != "AB34CD" || g.WrongCodes != 0 || s.CheckCode("KQ72MX") {
		t.Fatalf("new grant: %+v", g)
	}
	// Where no code is required, the user name doesn't matter.
	l := newFixture(t).open(wire.EnvLocal)
	if l.CheckCode("support") {
		t.Fatal("passed without a grant")
	}
	g, _ = l.Start(wire.LevelLook, secs(3600), owner)
	if g.HelpCode != nil || !l.CheckCode("support") || !l.CheckCode("") {
		t.Fatalf("local: %+v", g)
	}
}

func TestLockOut(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvProd)
	_, _ = s.Start(wire.LevelFix, secs(3600), owner)
	seq := f.log.Seq()
	ch := s.Changed()
	for i := 1; i < wire.WrongCodes; i++ {
		if s.CheckCode("AAAAAA") || s.Level() != wire.LevelFix || closed(ch) {
			t.Fatalf("wrong code %d ended it", i)
		}
	}
	// The count survives a restart.
	s.Close()
	s = f.open(wire.EnvProd)
	if s.Grant().WrongCodes != wire.WrongCodes-1 {
		t.Fatalf("after restart: %+v", s.Grant())
	}
	ch = s.Changed()
	if s.CheckCode("not a code at all") || s.Level() != "" || !closed(ch) || s.Grant() != nil {
		t.Fatal("the fifth wrong code didn't end it")
	}
	if k := f.kinds(seq); len(k) != 1 || k[0] != wire.EventLockedOut {
		t.Fatalf("events %v", k)
	}
	// Even the right code doesn't open it again.
	if s.CheckCode("KQ72MX") {
		t.Fatal("the code passed after the lock-out")
	}
	if s = f.open(wire.EnvProd); s.Level() != "" {
		t.Fatal("the lock-out didn't last")
	}
}

func TestExpiry(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvDev)
	_, _ = s.Start(wire.LevelLook, secs(3600), owner)
	ch := s.Changed()
	f.clock.advance(3599 * time.Second)
	if s.Level() != wire.LevelLook || closed(ch) {
		t.Fatal("ended early")
	}
	f.clock.advance(time.Second)
	if !closed(ch) || s.Grant() != nil || f.clock.pending() != 0 {
		t.Fatalf("the timer didn't end it: %d timers", f.clock.pending())
	}
	if k := f.kinds(0); len(k) != 2 || k[0] != wire.EventGrant || k[1] != wire.EventExpired {
		t.Fatalf("events %v", k)
	}

	// A wall clock that jumps past the end: off the moment anyone asks, before the timer.
	_, _ = s.Start(wire.LevelFix, secs(3600), owner)
	ch = s.Changed()
	f.clock.jump(2 * time.Hour)
	if s.Level() != "" || !closed(ch) || s.CheckCode("x") {
		t.Fatal("still on after the clock passed its end")
	}
	seq := f.log.Seq()
	f.clock.advance(time.Hour)
	if len(f.kinds(seq)) != 0 {
		t.Fatal("ended twice")
	}

	// One that ran out while the service was down ends at the next start, with its event.
	_, _ = s.Start(wire.LevelLook, secs(3600), owner)
	s.Close()
	f.clock.jump(2 * time.Hour)
	seq = f.log.Seq()
	if s = f.open(wire.EnvDev); s.Level() != "" {
		t.Fatal("came back after its time")
	}
	if k := f.kinds(seq); len(k) != 1 || k[0] != wire.EventExpired {
		t.Fatalf("events %v", k)
	}
}

func TestExpireNow(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvLocal)
	s.Expire() // off: nothing to tell
	_, _ = s.Start(wire.LevelFix, nil, owner)
	ch := s.Changed()
	s.Expire()
	if s.Level() != "" || !closed(ch) {
		t.Fatal("still on")
	}
	if k := f.kinds(0); len(k) != 2 || k[1] != wire.EventExpired {
		t.Fatalf("events %v", k)
	}
}

func TestPersistence(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvProd)
	g, _ := s.Start(wire.LevelFix, secs(86400), owner)
	fi, err := os.Stat(filepath.Join(f.dir, "grant.json"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("grant.json: %v %v", fi, err)
	}
	s.Close()
	f.clock.advance(time.Hour)
	s = f.open(wire.EnvProd)
	if got := s.Grant(); got == nil || *got.Until != *g.Until || *got.HelpCode != *g.HelpCode || got.Since != g.Since ||
		got.GrantedBy != owner {
		t.Fatalf("after restart: %+v, was %+v", got, g)
	}
	// Its timer runs again.
	f.clock.advance(23 * time.Hour)
	if s.Level() != "" {
		t.Fatal("the restarted grant didn't expire")
	}

	// A stop lasts.
	_, _ = s.Start(wire.LevelLook, secs(3600), owner)
	_ = s.Stop(wire.StopDesk, nil)
	if s = f.open(wire.EnvProd); s.Grant() != nil {
		t.Fatal("a stopped grant came back")
	}
}

func TestOpenDropsWhatDoesntFit(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.dir, "grant.json")
	// A forever grant saved by a test image doesn't open a prod one; nor does a grant without its code, or a file it
	// can't read.
	l := f.open(wire.EnvLocal)
	_, _ = l.Start(wire.LevelFix, nil, owner)
	l.Close()
	for _, env := range []string{wire.EnvProd} {
		if s := f.open(env); s.Level() != "" {
			t.Fatalf("%s opened a forever grant", env)
		}
	}
	l = f.open(wire.EnvLocal)
	_, _ = l.Start(wire.LevelFix, secs(3600), owner)
	l.Close()
	if s := f.open(wire.EnvProd); s.Level() != "" {
		t.Fatal("prod opened a grant without a help code")
	}
	for _, b := range []string{"{", `{"v":2,"grant":null}`, `{"v":1,"grant":{"level":"root","since":"2026-10-21T12:00:00Z"}}`} {
		if err := os.WriteFile(path, []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
		if s := f.open(wire.EnvLocal); s.Level() != "" {
			t.Fatalf("%s opened", b)
		}
	}
}

func TestStop(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvLocal)
	// Stopping what is off: nothing happens, nobody is told.
	if err := s.Stop(wire.StopOwner, &owner); err != nil || len(f.kinds(0)) != 0 {
		t.Fatalf("%v %v", err, f.kinds(0))
	}
	for _, c := range []struct {
		reason string
		by     *wire.Person
	}{{"owner", nil}, {"desk", &owner}, {"expired", nil}, {"", nil}, {"owner", &wire.Person{AccountID: "x"}}} {
		if err := s.Stop(c.reason, c.by); !errors.Is(err, ErrBadReason) && !errors.Is(err, ErrBadPerson) {
			t.Errorf("%+v: %v", c, err)
		}
	}
	_, _ = s.Start(wire.LevelFix, secs(3600), owner)
	ch := s.Changed()
	if err := s.Stop(wire.StopOwner, &owner); err != nil || !closed(ch) || s.Level() != "" || f.clock.pending() != 0 {
		t.Fatalf("stop: %v", err)
	}
	ev := f.log.After(t.Context(), 1, 0).Events
	if len(ev) != 1 || ev[0].Kind != wire.EventStop || *ev[0].Reason != wire.StopOwner || ev[0].By == nil || *ev[0].By != owner {
		t.Fatalf("events %+v", ev)
	}
}

func TestChanged(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvLocal)
	ch := s.Changed()
	if closed(ch) {
		t.Fatal("closed at start")
	}
	_, _ = s.Start(wire.LevelFix, secs(3600), owner)
	if !closed(ch) {
		t.Fatal("not closed on start")
	}
	// Each change closes the one before, and only that one.
	ch = s.Changed()
	_, _ = s.Start(wire.LevelLook, secs(3600), owner)
	if !closed(ch) || closed(s.Changed()) || s.Level() != wire.LevelLook {
		t.Fatal("not closed on a level change")
	}
	ev := f.log.After(t.Context(), 1, 0).Events
	if len(ev) != 1 || ev[0].Kind != wire.EventGrant || *ev[0].Level != wire.LevelLook || *ev[0].Duration != wire.DurationHour {
		t.Fatalf("events %+v", ev)
	}
}

func TestSaveFailure(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.dir, "gone")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := Open(Options{Path: filepath.Join(dir, "grant.json"), Environment: wire.EnvLocal, Events: f.log,
		Now: f.clock.Now, After: f.clock.After})
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(dir)
	// A start that can't be saved isn't made.
	if _, err := s.Start(wire.LevelFix, secs(3600), owner); !errors.Is(err, ErrNotSaved) || s.Level() != "" ||
		len(f.kinds(0)) != 0 {
		t.Fatalf("%v %q", err, s.Level())
	}
}

func TestGenerationMovesWhenAGrantEnds(t *testing.T) {
	f := newFixture(t)
	s := f.open(wire.EnvLocal)
	g0 := s.Generation()
	if _, err := s.Start(wire.LevelFix, nil, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(wire.LevelLook, nil, owner); err != nil { // a change while on keeps the grant
		t.Fatal(err)
	}
	if s.Generation() != g0 {
		t.Fatal("a start or a change moved the generation")
	}
	if err := s.Stop(wire.StopDesk, nil); err != nil {
		t.Fatal(err)
	}
	if s.Generation() == g0 {
		t.Fatal("a stop left the generation")
	}
}
