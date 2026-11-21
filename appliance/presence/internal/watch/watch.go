// Package watch is the camera's lifetime (Whombat DK-30, DK-32, DK-33; NX-283, NX-284): a watch turns the camera on
// when it is off and keeps it on PRESENCE_KEEP_S (6 s) more; a stop, the keep running out or the camera program's exit
// turns it off. The camera is held by a child program (presence-watch), so when the child is gone the camera is closed.
//
// A session is the time the camera is wanted, from the first watch to the stop or the keep's end. Within it:
//
//   - the latest checked frame answers watches (`starting` until the first one; `dark` when it has no face and is darker
//     than DarkLuma; `watching` otherwise), `seenAt` is the last frame with a face, `frameAt` the last frame;
//   - a colour camera whose picture stays dark for DarkSwitch (10 s) hands over to an infrared one, once per session; an
//     infrared camera that gives no picture within InfraredFirstFrame (5 s), stays dark as long, or exits hands back;
//   - a camera that exits, gives no first picture within FirstFrame (10 s) or no picture for Stall (5 s) has failed:
//     watches answer `failed` and it is started again no sooner than RetryAfter (30 s) after the failure.
package watch

import (
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/presence/internal/camera"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Config holds the watcher's times and the darkness line.
type Config struct {
	Keep               time.Duration
	RetryAfter         time.Duration
	DarkSwitch         time.Duration
	FirstFrame         time.Duration
	InfraredFirstFrame time.Duration
	Stall              time.Duration
	// DarkLuma: a checked frame without a face whose mean brightness (0–255) is below this is too dark to find one.
	DarkLuma int
}

// Defaults are DK-30's and DK-32's times (NX-283, NX-284).
func Defaults() Config {
	return Config{
		Keep:               local.PresenceKeepS * time.Second,
		RetryAfter:         30 * time.Second,
		DarkSwitch:         10 * time.Second,
		FirstFrame:         10 * time.Second,
		InfraredFirstFrame: 5 * time.Second,
		Stall:              5 * time.Second,
		DarkLuma:           40,
	}
}

// Event is one line of the camera program: the camera opened (Opened is what it reads, “YUYV 320×240”), or a frame
// was checked.
type Event struct {
	Opened string
	Frame  bool
	Face   bool
	Luma   int
}

// Child is a running camera program.
type Child interface {
	// Stop ends it (stdin closed and SIGTERM, SIGKILL after a second); it returns at once.
	Stop()
	// Done is closed when it has exited.
	Done() <-chan struct{}
}

// Spawn starts the camera program on cam. Its events and its exit are reported through the two functions, from other
// goroutines.
type Spawn func(cam camera.Camera, event func(Event), exit func(error)) (Child, error)

// Clock is the watcher's time (a fake one in tests).
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a Clock's timer.
type Timer interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// RealClock is the wall clock.
var RealClock Clock = realClock{}

// Watcher turns the camera on and off and answers watches.
type Watcher struct {
	cfg     Config
	clock   Clock
	spawn   Spawn
	cameras func() []camera.Camera
	log     func(format string, args ...any)

	mu      sync.Mutex
	session bool
	since   time.Time // the session's start
	keep    Timer
	keepGen int // a keep timer that fired while a newer watch held the lock is ignored
	seenAt  time.Time
	frameAt time.Time
	// The running child; gen counts children so a stopped one's late events are ignored.
	gen         int
	child       Child
	cam         camera.Camera
	onInfrared  bool
	triedIR     bool
	startedAt   time.Time
	frames      int
	lastFrameAt time.Time
	lastFace    bool
	lastLuma    int
	darkSince   time.Time
	failedAt    time.Time
	failed      bool
	noCamera    bool
	last        Child // the last child started, for Close
}

// New makes a watcher. cameras lists the usable cameras in DK-32's order (camera.Prober.Cameras).
func New(cfg Config, clock Clock, spawn Spawn, cameras func() []camera.Camera, log func(string, ...any)) *Watcher {
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Watcher{cfg: cfg, clock: clock, spawn: spawn, cameras: cameras, log: log}
}

// Watch turns the camera on if it is off, keeps it on Keep more and says what it sees.
func (w *Watcher) Watch() local.PresenceWatch {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.clock.Now()
	if !w.session {
		w.session, w.since = true, now
		w.seenAt, w.frameAt, w.triedIR = time.Time{}, time.Time{}, false
	}
	if w.keep != nil {
		w.keep.Stop()
	}
	w.keepGen++
	gen := w.keepGen
	w.keep = w.clock.AfterFunc(w.cfg.Keep, func() { w.expire(gen) })
	w.step(now)
	return w.answer()
}

// Stop turns the camera off now (the runtime's /stop).
func (w *Watcher) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.end("stopped")
}

// Close turns the camera off and waits, at most timeout, for the camera program to be gone (the service stopping).
func (w *Watcher) Close(timeout time.Duration) {
	w.mu.Lock()
	w.end("the service is stopping")
	last := w.last
	w.mu.Unlock()
	if last == nil {
		return
	}
	select {
	case <-last.Done():
	case <-time.After(timeout):
	}
}

func (w *Watcher) expire(gen int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if gen == w.keepGen {
		w.end("no watch for " + w.cfg.Keep.String())
	}
}

// end ends the session: the camera goes off.
func (w *Watcher) end(why string) {
	if w.keep != nil {
		w.keep.Stop()
		w.keep = nil
	}
	if !w.session {
		return
	}
	w.session = false
	if w.child != nil {
		w.log("camera off after %s: %s", w.clock.Now().Sub(w.since).Round(time.Second), why)
	}
	w.stopChild()
}

// step moves the session on: notices a camera that stalled, hands over between colour and infrared, and starts the
// camera when it isn't running and may be started.
func (w *Watcher) step(now time.Time) {
	if !w.session {
		return
	}
	if w.child != nil {
		first := w.cfg.FirstFrame
		if w.onInfrared {
			first = w.cfg.InfraredFirstFrame
		}
		switch {
		case w.frames == 0 && now.Sub(w.startedAt) >= first:
			w.lost(now, "it gave no picture in "+first.String())
		case w.frames > 0 && now.Sub(w.lastFrameAt) >= w.cfg.Stall:
			w.lost(now, "it gave no picture for "+w.cfg.Stall.String())
		}
	}
	if w.child != nil && w.dark() && now.Sub(w.darkSince) >= w.cfg.DarkSwitch {
		if w.onInfrared {
			w.lost(now, "its picture stayed dark too")
		} else if !w.triedIR {
			if _, ir, _ := camera.Pick(w.cameras()); ir != nil {
				w.triedIR = true
				w.log("the picture stayed too dark for %s: trying the infrared camera %s", w.cfg.DarkSwitch, ir)
				w.stopChild()
				w.start(now, *ir, true)
			}
		}
	}
	if w.child == nil && (!w.failed || now.Sub(w.failedAt) >= w.cfg.RetryAfter) {
		first, _, ok := camera.Pick(w.cameras())
		w.noCamera = !ok
		if ok {
			w.start(now, first, false)
		}
	}
}

func (w *Watcher) start(now time.Time, cam camera.Camera, infrared bool) {
	w.gen++
	gen := w.gen
	child, err := w.spawn(cam,
		func(e Event) { w.event(gen, e) },
		func(err error) { w.exited(gen, err) })
	w.cam, w.onInfrared, w.startedAt = cam, infrared, now
	w.frames, w.lastFace, w.lastLuma, w.darkSince = 0, false, 0, time.Time{}
	if err != nil {
		w.child = nil
		if infrared {
			// The colour camera starts again in the same step.
			w.onInfrared = false
			w.log("the infrared camera %s didn't start: %v", cam, err)
			return
		}
		w.fail(now, cam, err.Error())
		return
	}
	w.child, w.last, w.failed = child, child, false
}

// lost handles a camera that stopped working: an infrared one hands back to the colour one, which starts at once; any
// other has failed.
func (w *Watcher) lost(now time.Time, why string) {
	cam, infrared := w.cam, w.onInfrared
	w.stopChild()
	if infrared {
		w.log("back to the colour camera: the infrared camera %s: %s", cam, why)
		w.onInfrared = false
		return
	}
	w.fail(now, cam, why)
}

func (w *Watcher) fail(now time.Time, cam camera.Camera, why string) {
	w.failed, w.failedAt = true, now
	w.log("camera %s failed: %s; trying again in %s at the earliest", cam, why, w.cfg.RetryAfter)
}

func (w *Watcher) stopChild() {
	if w.child == nil {
		return
	}
	w.gen++ // its late events and its exit are ignored
	w.child.Stop()
	w.child = nil
}

func (w *Watcher) event(gen int, e Event) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if gen != w.gen || w.child == nil {
		return
	}
	now := w.clock.Now()
	if !e.Frame {
		w.log("camera on: %s, %s", w.cam, e.Opened)
		return
	}
	w.frames++
	w.lastFrameAt, w.frameAt = now, now
	w.lastFace, w.lastLuma = e.Face, e.Luma
	if e.Face {
		w.seenAt = now
	}
	switch {
	case !w.dark():
		w.darkSince = time.Time{}
	case w.darkSince.IsZero():
		w.darkSince = now
	}
	w.step(now)
}

func (w *Watcher) exited(gen int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if gen != w.gen || w.child == nil {
		return
	}
	why := "it exited"
	if err != nil {
		why = err.Error()
	}
	w.child = nil
	now := w.clock.Now()
	if w.onInfrared {
		w.log("back to the colour camera: the infrared camera %s: %s", w.cam, why)
		w.onInfrared = false
		w.step(now)
		return
	}
	w.fail(now, w.cam, why)
}

// dark: the latest frame has no face and is darker than DarkLuma.
func (w *Watcher) dark() bool {
	return w.frames > 0 && !w.lastFace && w.lastLuma < w.cfg.DarkLuma
}

func (w *Watcher) answer() local.PresenceWatch {
	a := local.PresenceWatch{V: 1, State: local.PresenceStateFailed}
	switch {
	case w.child != nil && w.frames == 0:
		a.State = local.PresenceStateStarting
	case w.child != nil && w.dark():
		a.State = local.PresenceStateDark
	case w.child != nil:
		a.State = local.PresenceStateWatching
		a.Face = w.lastFace
	case w.noCamera:
		a.State = local.PresenceStateNoCamera
	}
	a.SeenAt, a.FrameAt = stamp(w.seenAt), stamp(w.frameAt)
	return a
}

func stamp(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000Z")
	return &s
}
