package screen

import (
	"context"
	"errors"
	"fmt"
)

// Keys of a password go out one character at a time, each only while it
// reaches this prompt's password field, checked right before it, before
// Return, and before each key that empties the field. macOS turns Secure
// Event Input on while a password field has the keyboard, and the Mac's
// session list names the process that did (kCGSSessionSecureInputPID of the
// session at the screen): another program can't make that its prompt's or
// loginwindow's pid, and a name field (the login window's "Name and
// password", a prompt's user name) doesn't turn it on. But a process can
// leave it on while in the background (Apple's TN2150), so that alone isn't
// proof of where the keys go:
//
//   - With Accessibility (helper 1.0.4 on) the field itself is pinned when
//     the prompt is found: the element the helper says has the focus, its
//     process, role, subrole, place and size, and from helper 1.0.5 on its
//     token (the element's own identity for as long as it exists). Each check
//     needs that very element to have the focus, inside the prompt's window,
//     and that window still the frontmost, the same one where it was.
//   - Without it, the prompt's window must still be the frontmost window,
//     the same one (number and bounds), and its app the one with the
//     keyboard.
//   - Both ways, for System Settings' sheet LocalAuthentication must still
//     be busy for the pane that asked, so it is still the password sheet and
//     not another of its fields (a Wi-Fi network's, a new user's).
//   - The lock screen (unlock through Screen Sharing): the session list must
//     still say locked and the frontmost window must be loginwindow's.
//
// Whenever a check fails, nothing more is sent. A check and the key after it
// are two steps: focus that moves in the milliseconds between them can take
// that one key, but nothing after it, and never Return.

// errNotSecure: the keyboard doesn't go to the password field it should.
var errNotSecure = errors.New("the keyboard doesn't go to the password field")

// errAtLoginWindow: the Mac waits at its login window (after a restart,
// nobody logged in). There is no session at the screen, so the session list
// names no process with a password field, and nothing can tell where the
// keys would go: unlock types nothing there.
var errAtLoginWindow = errors.New("the Mac is at its login window")

// keyTarget is where a password may go.
type keyTarget struct {
	// allowed says whether pid may hold the field: macOS's own process of
	// the prompt or the lock screen, checked by the file it executes.
	allowed func(ctx context.Context, pid int) bool
	// uid is the user at the screen, whose helper is asked.
	uid int
	// ax: the helper has Accessibility (1.0.4 on); it is asked for the
	// focused element, which must be field.
	ax bool
	// window is the prompt's window as the window server listed it when the
	// prompt was found.
	window *helperWindow
	// field is the password field the keys go to, as the helper named the
	// focused element when the prompt was found (with Accessibility).
	field *pinnedField
	// pane: System Settings' sheet, asked for by this pane (the executable
	// LocalAuthentication's view service runs for).
	pane string
	// lock: the lock screen, typed into through Screen Sharing.
	lock bool
}

// pinnedField is the one element the password may go to.
type pinnedField struct {
	pid int
	el  helperElement
}

// sameField says whether e is the pinned element: the same token (empty
// before helper 1.0.5), role, subrole, place and size (a point of slack for
// rounding).
func sameField(e, pin helperElement) bool {
	const slack = 1
	near := func(a, b float64) bool { return a-b <= slack && b-a <= slack }
	return e.Token == pin.Token && e.Role == pin.Role && e.Subrole == pin.Subrole &&
		near(e.X, pin.X) && near(e.Y, pin.Y) && near(e.W, pin.W) && near(e.H, pin.H)
}

// pidSet allows exactly these pids.
func pidSet(pids ...int) func(context.Context, int) bool {
	set := map[int]bool{}
	for _, p := range pids {
		if p > 0 {
			set[p] = true
		}
	}
	return func(_ context.Context, pid int) bool { return set[pid] }
}

// secureInputPID is the process with Secure Event Input on in the session
// at the screen (0: none, or no session at the screen).
func secureInputPID(sessions []consoleSession) int {
	for _, c := range sessions {
		if c.OnConsole {
			return c.SecureInputPID
		}
	}
	return 0
}

// inWindow says whether an element (global points) lies inside a window
// (a point of slack for rounding).
func inWindow(e helperElement, w helperWindow) bool {
	const slack = 1
	return e.W > 0 && e.H > 0 && e.X >= w.X-slack && e.Y >= w.Y-slack &&
		e.X+e.W <= w.X+w.W+slack && e.Y+e.H <= w.Y+w.H+slack
}

// secureField checks that the keyboard goes to t's password field now (see
// above). The slower checks come first, so the last look is the closest to
// the key that follows.
func (s *Screen) secureField(ctx context.Context, t *keyTarget) error {
	if t.pane != "" {
		sheet, err := s.paneSheet(ctx, t.uid, t.pane)
		if err != nil || !sheet.busy {
			return fmt.Errorf("%w: System Settings no longer asks for the password", errNotSecure)
		}
	}
	sessions, err := s.sessions(ctx)
	if err != nil {
		return fmt.Errorf("%w: can't read the Mac's session list (%v)", errNotSecure, err)
	}
	if t.lock {
		if consoleUser(sessions) == "" {
			return fmt.Errorf("%w: %w", errNotSecure, errAtLoginWindow)
		}
		if locked, _ := lockState(sessions); !locked {
			return fmt.Errorf("%w: the screen isn't locked any more", errNotSecure)
		}
	}
	pid := secureInputPID(sessions)
	if pid <= 0 {
		return fmt.Errorf("%w: no password field has the keyboard", errNotSecure)
	}
	if !t.allowed(ctx, pid) {
		return fmt.Errorf("%w: another program's field has it (process %d)", errNotSecure, pid)
	}
	if t.ax {
		return s.pinnedHasFocus(ctx, t)
	}
	if t.lock {
		return s.lockInFront(ctx, t)
	}
	if t.window == nil {
		return fmt.Errorf("%w: can't tell which window has the keyboard", errNotSecure)
	}
	front, err := s.promptInFront(ctx, t.uid, *t.window)
	switch {
	case err != nil && ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		return fmt.Errorf("%w: can't tell which window is in front (%v)", errNotSecure, err)
	case !front:
		return fmt.Errorf("%w: the prompt's window isn't in front with the keyboard", errNotSecure)
	}
	return nil
}

// pinnedHasFocus checks, with Accessibility, that the prompt's window is
// still the frontmost, the same one where it was, and then (the closest look
// to the key) that the focused element is the pinned field inside it.
func (s *Screen) pinnedHasFocus(ctx context.Context, t *keyTarget) error {
	if t.window == nil || t.field == nil {
		return fmt.Errorf("%w: the prompt's field wasn't pinned", errNotSecure)
	}
	wins, err := s.helperWindows(ctx, t.uid)
	switch {
	case err != nil && ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		return fmt.Errorf("%w: can't tell which window is in front (%v)", errNotSecure, err)
	}
	if f := s.frontWindow(ctx, wins); f == nil || !unchanged(*f, *t.window) {
		return fmt.Errorf("%w: the prompt's window isn't in front where it was", errNotSecure)
	}
	a, err := s.helper.call(ctx, t.uid, map[string]any{"op": "focused"})
	switch {
	case err != nil && ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		return fmt.Errorf("%w: Whombat Helper didn't say what has the focus (%v)", errNotSecure, err)
	case !a.OK:
		return fmt.Errorf("%w: Whombat Helper didn't say what has the focus (%s)", errNotSecure, a.Code)
	case a.Element == nil || !isSecureField(*a.Element):
		return fmt.Errorf("%w: the focused element isn't a password field", errNotSecure)
	case a.PID != t.field.pid || !t.allowed(ctx, a.PID):
		return fmt.Errorf("%w: the focused password field is another program's (process %d)", errNotSecure, a.PID)
	case !sameField(*a.Element, t.field.el):
		return fmt.Errorf("%w: another password field has the keyboard", errNotSecure)
	case !inWindow(*a.Element, *t.window):
		return fmt.Errorf("%w: the focused password field isn't in the prompt's window", errNotSecure)
	}
	return nil
}

// lockInFront checks that the lock screen is in front: the frontmost window
// someone works in is loginwindow's (seen on macOS 27: its windows at levels
// 2000 and 2001 cover everything while the screen is locked).
func (s *Screen) lockInFront(ctx context.Context, t *keyTarget) error {
	wins, err := s.helperWindows(ctx, t.uid)
	switch {
	case err != nil && ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		return fmt.Errorf("%w: can't tell what is in front of the lock screen (%v)", errNotSecure, err)
	}
	if w := s.frontWindow(ctx, wins); w == nil || !t.allowed(ctx, w.PID) {
		return fmt.Errorf("%w: something other than the lock screen is in front", errNotSecure)
	}
	return nil
}

// typeSecret sends the password's keys one character at a time and then
// Return, checking the field right before each. typed says whether any of
// the password went out.
func (s *Screen) typeSecret(ctx context.Context, c *rfbConn, password [][]keyEvent, t *keyTarget) (typed bool, err error) {
	for _, ch := range password {
		if err := s.secureField(ctx, t); err != nil {
			return typed, err
		}
		typed = true
		if err := s.sendChords(ctx, c, [][]keyEvent{ch}); err != nil {
			return true, err
		}
	}
	if err := s.secureField(ctx, t); err != nil {
		return typed, err
	}
	return typed, s.sendChords(ctx, c, [][]keyEvent{tap(ksReturn)})
}

// sendChecked sends chords, each only while the field still passes, and
// stops at the first check or send that fails, returning its error.
func (s *Screen) sendChecked(ctx context.Context, c *rfbConn, t *keyTarget, chords [][]keyEvent) error {
	for _, ch := range chords {
		if err := s.secureField(ctx, t); err != nil {
			return err
		}
		if err := s.sendChords(ctx, c, [][]keyEvent{ch}); err != nil {
			return err
		}
	}
	return nil
}

// clearField empties the password field with clear, each key only while the
// field still has the keyboard; it says whether it did.
func (s *Screen) clearField(ctx context.Context, c *rfbConn, t *keyTarget, clear [][]keyEvent) bool {
	return s.sendChecked(ctx, c, t, clear) == nil
}

// typingTime bounds typing a password and waiting for it to be taken so
// that, should that run out, clearReserve of the step's own time is left to
// empty the field (still only while it passes the checks).
func (s *Screen) typingTime(ctx context.Context) (context.Context, context.CancelFunc) {
	if dl, ok := ctx.Deadline(); ok {
		return context.WithDeadline(ctx, dl.Add(-s.clearReserve))
	}
	return context.WithCancel(ctx)
}

// loginWindow allows macOS's own loginwindow (the lock screen and the login
// window): by the file the kernel says it runs and its Apple signature.
func (s *Screen) loginWindow(ctx context.Context, pid int) bool {
	exe, err := s.processPath(ctx, pid)
	return err == nil && exe == loginWindowPath && s.appleCode(ctx, pid)
}
