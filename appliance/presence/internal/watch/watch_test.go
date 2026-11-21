package watch

import (
	"errors"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/presence/internal/camera"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// ---- A fake clock and a fake camera program ------------------------------------------------------------------------

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { was := !t.stopped; t.stopped = true; return was }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

// advance moves the clock on, firing the timers that come due on the way, in order.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var due *fakeTimer
		for _, t := range c.timers {
			if !t.stopped && !t.at.After(end) {
				due = t
				break
			}
		}
		if due == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		due.stopped = true
		c.now = due.at
		c.mu.Unlock()
		due.f()
	}
}

type fakeChild struct {
	cam     camera.Camera
	event   func(Event)
	exit    func(error)
	stopped bool
	done    chan struct{}
}

func (c *fakeChild) Stop()                 { c.stopped = true }
func (c *fakeChild) Done() <-chan struct{} { return c.done }

func (c *fakeChild) frame(face bool, luma int) { c.event(Event{Frame: true, Face: face, Luma: luma}) }

type rig struct {
	t        *testing.T
	clock    *fakeClock
	w        *Watcher
	children []*fakeChild
	cams     []camera.Camera
	spawnErr error
	refuse   string // a camera that won't start
	logs     []string
}

var (
	colour   = camera.Camera{Path: "/dev/video0", Name: "Integrated Camera", Kind: "colour", Usable: true}
	infrared = camera.Camera{Path: "/dev/video2", Name: "Integrated IR Camera", Kind: "infrared", Usable: true}
	t0       = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
)

func newRig(t *testing.T, cams ...camera.Camera) *rig {
	r := &rig{t: t, clock: &fakeClock{now: t0}, cams: cams}
	spawn := func(cam camera.Camera, event func(Event), exit func(error)) (Child, error) {
		if r.spawnErr != nil {
			return nil, r.spawnErr
		}
		if cam.Path == r.refuse {
			return nil, errors.New("exec: can't start")
		}
		c := &fakeChild{cam: cam, event: event, exit: exit, done: make(chan struct{})}
		r.children = append(r.children, c)
		return c, nil
	}
	r.w = New(Defaults(), r.clock, spawn, func() []camera.Camera { return camera.Order(r.cams) },
		func(f string, a ...any) { r.logs = append(r.logs, f) })
	return r
}

func (r *rig) last() *fakeChild {
	r.t.Helper()
	if len(r.children) == 0 {
		r.t.Fatal("no camera program started")
	}
	return r.children[len(r.children)-1]
}

// watch asks, and checks the state and face.
func (r *rig) watch(state local.PresenceState, face bool) local.PresenceWatch {
	r.t.Helper()
	a := r.w.Watch()
	if a.State != state || a.Face != face {
		r.t.Fatalf("at +%s: %s face=%v, want %s face=%v", r.clock.Now().Sub(t0), a.State, a.Face, state, face)
	}
	if err := a.Validate(); err != nil {
		r.t.Fatalf("not a PresenceWatch: %v", err)
	}
	return a
}

// tick is a second later, and a watch (the runtime asks every 2 s; here more often, so the keep never runs out).
func (r *rig) tick() {
	r.clock.advance(time.Second)
	r.w.Watch()
}

func at(d time.Duration) string { return t0.Add(d).Format("2006-01-02T15:04:05.000Z") }

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ---- The camera's lifetime -------------------------------------------------------------------------------------------

func TestWatchStartsTheCameraAndAnswersFromItsFrames(t *testing.T) {
	r := newRig(t, colour)
	a := r.watch(local.PresenceStateStarting, false)
	if a.SeenAt != nil || a.FrameAt != nil || r.last().cam.Path != colour.Path {
		t.Fatalf("starting: %+v, camera %s", a, r.last().cam.Path)
	}
	c := r.last()
	c.event(Event{Opened: "YUYV 320×240"})
	r.watch(local.PresenceStateStarting, false)
	r.clock.advance(500 * time.Millisecond)
	c.frame(true, 90)
	a = r.watch(local.PresenceStateWatching, true)
	if str(a.SeenAt) != at(500*time.Millisecond) || str(a.FrameAt) != at(500*time.Millisecond) {
		t.Fatalf("stamps: %s %s", str(a.SeenAt), str(a.FrameAt))
	}
	r.clock.advance(500 * time.Millisecond)
	c.frame(false, 90)
	a = r.watch(local.PresenceStateWatching, false)
	if str(a.SeenAt) != at(500*time.Millisecond) || str(a.FrameAt) != at(time.Second) {
		t.Fatalf("seenAt is the last face, frameAt the last frame: %s %s", str(a.SeenAt), str(a.FrameAt))
	}
	if len(r.children) != 1 {
		t.Fatalf("%d camera programs", len(r.children))
	}
}

func TestTheKeepTurnsTheCameraOff(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	// Watches every 2 s keep it on.
	for range 5 {
		r.clock.advance(time.Second)
		c.frame(true, 80)
		r.clock.advance(time.Second)
		r.watch(local.PresenceStateWatching, true)
	}
	if c.stopped {
		t.Fatal("stopped while watched")
	}
	r.clock.advance(local.PresenceKeepS*time.Second - time.Millisecond)
	if c.stopped {
		t.Fatal("stopped before the keep ran out")
	}
	r.clock.advance(time.Millisecond)
	if !c.stopped {
		t.Fatal("the camera stayed on 6 s after the last watch")
	}
	// The next watch is a new session: a new camera program, nothing seen yet.
	a := r.watch(local.PresenceStateStarting, false)
	if len(r.children) != 2 || a.SeenAt != nil || a.FrameAt != nil {
		t.Fatalf("new session: %d programs, %+v", len(r.children), a)
	}
}

func TestStopTurnsTheCameraOffAtOnce(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	c.frame(true, 80)
	r.w.Stop()
	if !c.stopped {
		t.Fatal("stop left the camera on")
	}
	// Its late lines and exit change nothing.
	c.frame(true, 80)
	c.exit(errors.New("killed"))
	r.clock.advance(10 * time.Second) // the old keep timer fires into nothing
	a := r.watch(local.PresenceStateStarting, false)
	if len(r.children) != 2 || a.SeenAt != nil {
		t.Fatalf("after stop: %d programs, %+v", len(r.children), a)
	}
	r.w.Stop()
	r.w.Stop() // twice is fine
}

func TestAKeepThatFiresAfterANewerWatchIsIgnored(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	// The first watch's timer fires; a newer watch already replaced it.
	first := r.clock.timers[0]
	r.clock.advance(time.Second)
	r.watch(local.PresenceStateStarting, false)
	first.f()
	if r.last().stopped {
		t.Fatal("an old keep timer turned the camera off")
	}
}

func TestAFailedCameraWaits30sBeforeItIsTriedAgain(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	c.frame(true, 80)
	c.exit(errors.New("presence-watch: the camera went away"))
	r.watch(local.PresenceStateFailed, false)
	for range 14 {
		r.clock.advance(2 * time.Second)
		r.watch(local.PresenceStateFailed, false)
	}
	if len(r.children) != 1 {
		t.Fatalf("restarted within 30 s: %d", len(r.children))
	}
	r.clock.advance(2 * time.Second) // 30 s after the failure
	r.watch(local.PresenceStateStarting, false)
	if len(r.children) != 2 {
		t.Fatalf("not restarted after 30 s: %d", len(r.children))
	}
	// A stop and a new session don't shorten the wait.
	r.last().exit(errors.New("busy"))
	r.w.Stop()
	r.watch(local.PresenceStateFailed, false)
}

func TestACameraThatWontStartHasFailed(t *testing.T) {
	r := newRig(t, colour)
	r.spawnErr = errors.New("exec: no such file")
	r.watch(local.PresenceStateFailed, false)
	r.spawnErr = nil
	r.clock.advance(29 * time.Second)
	r.watch(local.PresenceStateFailed, false)
	r.clock.advance(time.Second)
	r.watch(local.PresenceStateStarting, false)
}

func TestNoCamera(t *testing.T) {
	r := newRig(t)
	r.watch(local.PresenceStateNoCamera, false)
	if len(r.children) != 0 {
		t.Fatal("started a program without a camera")
	}
	// One plugged in: the next watch uses it.
	r.cams = []camera.Camera{colour}
	r.watch(local.PresenceStateStarting, false)
}

func TestNoPictureMeansFailed(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	for range 9 {
		r.tick()
	}
	r.watch(local.PresenceStateStarting, false)
	r.clock.advance(time.Second)
	r.watch(local.PresenceStateFailed, false)
	if !r.children[0].stopped {
		t.Fatal("a camera with no first picture was left running")
	}
	// Pictures that stop: failed after Stall.
	for range 30 {
		r.tick()
	}
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	c.frame(false, 90)
	r.clock.advance(Defaults().Stall - time.Millisecond)
	r.watch(local.PresenceStateWatching, false)
	r.clock.advance(time.Millisecond)
	r.watch(local.PresenceStateFailed, false)
	if !c.stopped {
		t.Fatal("a stalled camera was left running")
	}
}

// ---- Dark pictures and the infrared camera (DK-32) ------------------------------------------------------------------

func TestDark(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	c.frame(false, 12)
	r.watch(local.PresenceStateDark, false)
	// A face in a dim frame is a face.
	c.frame(true, 12)
	r.watch(local.PresenceStateWatching, true)
	// No face in a lit room is nobody there.
	c.frame(false, 90)
	r.watch(local.PresenceStateWatching, false)
	// Without an infrared camera it stays dark however long.
	for range 20 {
		r.tick()
		c.frame(false, 5)
	}
	r.watch(local.PresenceStateDark, false)
	if len(r.children) != 1 {
		t.Fatalf("%d programs", len(r.children))
	}
}

func TestDarkForTenSecondsTurnsToTheInfraredCamera(t *testing.T) {
	r := newRig(t, infrared, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	if c.cam.Path != colour.Path {
		t.Fatalf("started with %s, not the colour camera", c.cam.Path)
	}
	c.frame(true, 80)
	r.tick()
	for range 9 {
		c.frame(false, 10)
		r.tick()
	}
	r.watch(local.PresenceStateDark, false)
	if len(r.children) != 1 {
		t.Fatal("switched before 10 s of dark")
	}
	r.clock.advance(time.Second)
	c.frame(false, 10) // 10 s after the first dark frame
	ir := r.last()
	if !c.stopped || ir.cam.Path != infrared.Path {
		t.Fatalf("not on the infrared camera: colour stopped %v, now %s", c.stopped, ir.cam.Path)
	}
	a := r.watch(local.PresenceStateStarting, false)
	if str(a.SeenAt) != at(0) {
		t.Fatalf("the session's last face was forgotten: %s", str(a.SeenAt))
	}
	r.clock.advance(time.Second)
	ir.frame(true, 70)
	r.watch(local.PresenceStateWatching, true)
	// The colour camera's late lines don't count.
	c.frame(false, 5)
	r.watch(local.PresenceStateWatching, true)
}

func TestAnInfraredCameraThatDoesntHelpHandsBack(t *testing.T) {
	darkTen := func(r *rig, c *fakeChild) {
		for range 11 {
			c.frame(false, 8)
			r.tick()
		}
	}
	t.Run("no picture in 5 s", func(t *testing.T) {
		r := newRig(t, colour, infrared)
		r.watch(local.PresenceStateStarting, false)
		darkTen(r, r.last())
		ir := r.last()
		r.clock.advance(Defaults().InfraredFirstFrame)
		r.watch(local.PresenceStateStarting, false)
		back := r.last()
		if !ir.stopped || back.cam.Path != colour.Path || len(r.children) != 3 {
			t.Fatalf("not back on colour: %d programs, now %s", len(r.children), back.cam.Path)
		}
		// Not tried again this session.
		darkTen(r, back)
		r.watch(local.PresenceStateDark, false)
		if len(r.children) != 3 {
			t.Fatalf("infrared tried twice: %d programs", len(r.children))
		}
	})
	t.Run("dark too", func(t *testing.T) {
		r := newRig(t, colour, infrared)
		r.watch(local.PresenceStateStarting, false)
		darkTen(r, r.last())
		darkTen(r, r.last())
		if r.last().cam.Path != colour.Path || len(r.children) != 3 {
			t.Fatalf("not back on colour: %d programs", len(r.children))
		}
	})
	t.Run("it exits", func(t *testing.T) {
		r := newRig(t, colour, infrared)
		r.watch(local.PresenceStateStarting, false)
		darkTen(r, r.last())
		r.last().exit(errors.New("presence-watch: can't start the camera: Input/output error"))
		r.watch(local.PresenceStateStarting, false) // no failure: the colour camera is back at once
		if r.last().cam.Path != colour.Path {
			t.Fatalf("now %s", r.last().cam.Path)
		}
	})
	t.Run("it won't start", func(t *testing.T) {
		r := newRig(t, colour, infrared)
		r.refuse = infrared.Path
		r.watch(local.PresenceStateStarting, false)
		darkTen(r, r.last())
		r.watch(local.PresenceStateStarting, false) // no failure: the colour camera is back at once
		if len(r.children) != 2 || !r.children[0].stopped || r.last().cam.Path != colour.Path {
			t.Fatalf("%d programs, now %s", len(r.children), r.last().cam.Path)
		}
	})
	t.Run("a new session starts with colour", func(t *testing.T) {
		r := newRig(t, colour, infrared)
		r.watch(local.PresenceStateStarting, false)
		darkTen(r, r.last())
		r.w.Stop()
		r.watch(local.PresenceStateStarting, false)
		if r.last().cam.Path != colour.Path {
			t.Fatalf("new session on %s", r.last().cam.Path)
		}
	})
}

func TestCloseWaitsForTheProgram(t *testing.T) {
	r := newRig(t, colour)
	r.watch(local.PresenceStateStarting, false)
	c := r.last()
	close(c.done)
	r.w.Close(time.Minute)
	if !c.stopped {
		t.Fatal("close left the camera on")
	}
	r.w.Close(time.Minute) // nothing running: returns
}
