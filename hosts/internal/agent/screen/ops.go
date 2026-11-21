package screen

import (
	"context"
	"errors"
	"fmt"
	"image"
	"io/fs"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"rackoon/internal/agent/rfb"
	"rackoon/internal/proto"
)

// Screen runs one screen step, bounded to 25 s (password and unlock: 60 s).
// It implements agent.Screen.
func (s *Screen) Screen(ctx context.Context, req proto.ScreenRequest) proto.ScreenResponse {
	limit := s.stepTimeout
	if req.Op == proto.ScreenPassword || req.Op == proto.ScreenUnlock {
		limit = s.secretTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var resp proto.ScreenResponse
	var err error
	switch req.Op {
	case proto.ScreenStatus:
		resp = s.opStatus(ctx)
	case proto.ScreenLook:
		resp, err = s.opLook(ctx, req)
	case proto.ScreenClick:
		err = s.opClick(ctx, req)
	case proto.ScreenDrag:
		err = s.opDrag(ctx, req)
	case proto.ScreenScroll:
		err = s.opScroll(ctx, req)
	case proto.ScreenType:
		err = s.opType(ctx, req)
	case proto.ScreenKeys:
		err = s.opKeys(ctx, req)
	case proto.ScreenUnlock:
		resp, err = s.opUnlock(ctx)
	case proto.ScreenPassword:
		resp, err = s.opPassword(ctx, req)
	case proto.ScreenAccountSet:
		resp, err = s.opAccountSet(ctx, req)
	case proto.ScreenAccountCheck:
		resp, err = s.opAccountCheck(ctx)
	case proto.ScreenAccountClear:
		resp, err = s.opAccountClear(ctx)
	case proto.ScreenUIApps, proto.ScreenUIList, proto.ScreenUIPress, proto.ScreenUISet,
		proto.ScreenUIMenu, proto.ScreenUIFocus, proto.ScreenUIOpen:
		resp, err = s.opUI(ctx, req)
	default:
		err = invalidError(fmt.Sprintf("unknown screen step %q", clip(req.Op, 40)))
	}
	if err != nil {
		code, msg := errorCode(err)
		resp = proto.ScreenResponse{Code: code, Message: msg, Status: resp.Status}
	} else if resp.Code == "" {
		resp.OK = true
	}
	if resp.ScreenW == 0 {
		resp.ScreenW, resp.ScreenH = s.fbSize()
	}
	return resp
}

// codeError is an answer with a code of the helper's or the unlock's own.
type codeError struct{ code, msg string }

func (e *codeError) Error() string { return e.msg }

func (s *Screen) opStatus(ctx context.Context) proto.ScreenResponse {
	s.refresh(ctx, true)
	st, h := s.snapshot()
	return proto.ScreenResponse{Status: &st, Helper: &h}
}

// look takes the screen and returns it encoded, scaled to maxW.
func (s *Screen) look(ctx context.Context, maxW int, format string) (data []byte, w, h, sw, sh int, err error) {
	var img *image.RGBA
	err = s.step(ctx, func(c *rfbConn) error {
		var e error
		img, e = c.look(ctx)
		return e
	})
	if err != nil {
		return nil, 0, 0, 0, 0, err
	}
	b := img.Bounds()
	if maxW <= 0 || maxW > b.Dx() {
		maxW = b.Dx()
	}
	// A picture must fit one message to the hub: a big screen's PNG is
	// made smaller until it does (the click space stays the screen's).
	for {
		out := scaleTo(img, maxW)
		data, err = encodeImage(out, format)
		if err != nil {
			return nil, 0, 0, 0, 0, err
		}
		if len(data) <= maxImageBytes || maxW <= minImageW {
			return data, out.Bounds().Dx(), out.Bounds().Dy(), b.Dx(), b.Dy(), nil
		}
		maxW = maxW * 3 / 4
	}
}

// maxImageBytes keeps a look's answer under the hub's 8 MiB message limit;
// minImageW is as small as it gets for that.
var maxImageBytes, minImageW = 7 << 20, 320

func (s *Screen) opLook(ctx context.Context, req proto.ScreenRequest) (proto.ScreenResponse, error) {
	format, ok := imageFormat(req.Format, "png")
	if !ok {
		return proto.ScreenResponse{}, invalidError("format is png or jpeg")
	}
	if req.MaxW < 0 || req.MaxW > maxFramebuffer {
		return proto.ScreenResponse{}, invalidError("max_w is 0 (full size) to 8192")
	}
	data, w, h, sw, sh, err := s.look(ctx, req.MaxW, format)
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	return proto.ScreenResponse{Image: data, Format: format, W: w, H: h, ScreenW: sw, ScreenH: sh}, nil
}

// inside checks that a point is on the screen.
func inside(c *rfbConn, x, y int) error {
	w, h := c.size()
	if x < 0 || y < 0 || x >= w || y >= h {
		return invalidError(fmt.Sprintf("(%d, %d) is outside the %d×%d screen", x, y, w, h))
	}
	return nil
}

func buttonMask(b string) (byte, error) {
	switch b {
	case "", "left":
		return btnLeft, nil
	case "right":
		return btnRight, nil
	case "middle":
		return btnMiddle, nil
	}
	return 0, invalidError("button is left, right or middle")
}

func (s *Screen) opClick(ctx context.Context, req proto.ScreenRequest) error {
	mask, err := buttonMask(req.Button)
	if err != nil {
		return err
	}
	clicks := req.Clicks
	if clicks == 0 {
		clicks = 1
	}
	if clicks < 1 || clicks > 3 {
		return invalidError("clicks is 1, 2 or 3")
	}
	return s.step(ctx, func(c *rfbConn) error {
		if err := inside(c, req.X, req.Y); err != nil {
			return err
		}
		if err := c.pointer(req.X, req.Y, 0); err != nil {
			return err
		}
		if err := pause(ctx, s.clickGap); err != nil {
			return err
		}
		for i := 0; i < clicks; i++ {
			if err := c.pointer(req.X, req.Y, mask); err != nil {
				return err
			}
			if err := pause(ctx, s.clickGap); err != nil {
				return err
			}
			if err := c.pointer(req.X, req.Y, 0); err != nil {
				return err
			}
			if err := pause(ctx, s.clickGap); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Screen) opDrag(ctx context.Context, req proto.ScreenRequest) error {
	mask, err := buttonMask(req.Button)
	if err != nil {
		return err
	}
	return s.step(ctx, func(c *rfbConn) error {
		if err := inside(c, req.X, req.Y); err != nil {
			return err
		}
		if err := inside(c, req.ToX, req.ToY); err != nil {
			return err
		}
		if err := c.pointer(req.X, req.Y, 0); err != nil {
			return err
		}
		if err := pause(ctx, s.clickGap); err != nil {
			return err
		}
		if err := c.pointer(req.X, req.Y, mask); err != nil {
			return err
		}
		const steps = 12
		for i := 1; i <= steps; i++ {
			if err := pause(ctx, s.charGap); err != nil {
				return err
			}
			x := req.X + (req.ToX-req.X)*i/steps
			y := req.Y + (req.ToY-req.Y)*i/steps
			if err := c.pointer(x, y, mask); err != nil {
				return err
			}
		}
		if err := pause(ctx, s.clickGap); err != nil {
			return err
		}
		return c.pointer(req.ToX, req.ToY, 0)
	})
}

// maxScroll bounds one scroll's steps in each direction.
const maxScroll = 50

// wheelPerStep: Screen Sharing scrolls one pixel per wheel event, however
// fast they come (measured on a Mac), so one scroll step is a burst of 40:
// about two lines of text.
const wheelPerStep = 40

func (s *Screen) opScroll(ctx context.Context, req proto.ScreenRequest) error {
	if req.DX == 0 && req.DY == 0 {
		return invalidError("give dx or dy (scroll steps; dy positive scrolls down)")
	}
	if abs(req.DX) > maxScroll || abs(req.DY) > maxScroll {
		return invalidError(fmt.Sprintf("at most %d scroll steps each way", maxScroll))
	}
	return s.step(ctx, func(c *rfbConn) error {
		x, y := req.X, req.Y
		if x == 0 && y == 0 {
			w, h := c.size()
			x, y = w/2, h/2 // no point given: the middle of the screen
		}
		if err := inside(c, x, y); err != nil {
			return err
		}
		if err := c.pointer(x, y, 0); err != nil {
			return err
		}
		wheel := func(n int, pos, neg byte) error {
			b := pos
			if n < 0 {
				b, n = neg, -n
			}
			for i := 0; i < n*wheelPerStep; i++ {
				if i%wheelPerStep == 0 {
					if err := pause(ctx, s.charGap); err != nil {
						return err
					}
				}
				if err := c.pointer(x, y, b); err != nil {
					return err
				}
				if err := c.pointer(x, y, 0); err != nil {
					return err
				}
			}
			return nil
		}
		if err := wheel(req.DY, btnWheelDown, btnWheelUp); err != nil {
			return err
		}
		return wheel(req.DX, btnWheelRight, btnWheelLeft)
	})
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// sendChords sends key chords: keyGap between the events of a chord,
// charGap after each.
func (s *Screen) sendChords(ctx context.Context, c *rfbConn, chords [][]keyEvent) error {
	for _, ch := range chords {
		if err := ctx.Err(); err != nil {
			return err
		}
		for i, ev := range ch {
			if i > 0 {
				// A chord once begun is finished, whatever the step's time:
				// its key-ups must follow (a Shift left down would change
				// everything typed after it).
				pause(context.WithoutCancel(ctx), s.keyGap)
			}
			if err := c.key(ev.sym, ev.down); err != nil {
				return err
			}
		}
		if err := pause(ctx, s.charGap); err != nil {
			return err
		}
	}
	return nil
}

func (s *Screen) opType(ctx context.Context, req proto.ScreenRequest) error {
	if req.Text == "" {
		return invalidError("give the text to type")
	}
	chords, err := textEvents(req.Text)
	if err != nil {
		return invalidError(err.Error())
	}
	return s.step(ctx, func(c *rfbConn) error { return s.sendChords(ctx, c, chords) })
}

func (s *Screen) opKeys(ctx context.Context, req proto.ScreenRequest) error {
	chords, err := parseKeys(req.Keys)
	if err != nil {
		return invalidError(err.Error())
	}
	return s.step(ctx, func(c *rfbConn) error { return s.sendChords(ctx, c, chords) })
}

// lockedNow says whether the screen waits for a password. The Mac's session
// list (ioreg's, which root reads reliably) decides; the helper's view of its
// own session is asked only when that can't be read.
func (s *Screen) lockedNow(ctx context.Context) (locked, known bool) {
	if sessions, err := s.sessions(ctx); err == nil {
		locked, _ = lockState(sessions)
		return s.keepLock(locked, true)
	}
	if uid, ok := s.consoleUID(); ok {
		hctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		a, err := s.helper.call(hctx, uid, map[string]any{"op": "status"})
		cancel()
		if err == nil && a.OK {
			s.noteHelper(a)
			return s.keepLock(a.Locked, true)
		}
	}
	return s.keepLock(false, false)
}

// keepLock keeps the lock state for the report (unknown is nil there).
func (s *Screen) keepLock(locked, known bool) (bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !known {
		s.locked = nil
		return false, false
	}
	s.locked = &locked
	return locked, true
}

// watchLock asks for the lock state every pollGap for at most within, and
// returns as soon as the screen is open.
func (s *Screen) watchLock(ctx context.Context, within time.Duration) (locked, known bool, err error) {
	deadline := time.Now().Add(within)
	for {
		locked, known = s.lockedNow(ctx)
		if known && !locked {
			return locked, known, nil
		}
		if !time.Now().Add(s.pollGap).Before(deadline) {
			return locked, known, nil
		}
		if err := pause(ctx, s.pollGap); err != nil {
			return locked, known, err
		}
	}
}

func tap(sym uint32) []keyEvent { return []keyEvent{{sym, true}, {sym, false}} }

// unlockOutcome is what an unlock did: how often it typed the password and
// the lock state it ended with.
type unlockOutcome struct {
	typed         int
	locked, known bool
}

// loginWindowMsg: unlock at the login window after a restart. macOS names no
// process with a password field there (there is no session at the screen),
// so nothing can tell where the keys would go: the name field of "Name and
// password" or a list of people would take them as well.
const loginWindowMsg = "The Mac is at its login window after a restart, where Whombat can't check that the password would go into the password field, so it typed nothing. Log in at the Mac once; after that Whombat can unlock it."

// errLockUnknown: nothing could tell whether the screen is locked, and a
// password is never typed into a screen that may be open.
var errLockUnknown = &codeError{"failed", "Couldn't tell whether the Mac's screen is locked, so the password wasn't typed."}

// unlockOn wakes the display with a Shift tap and watches the lock for up to
// wakeWait: woken within macOS's grace period the screen opens by itself
// (the lock flag is set as soon as the display sleeps), and typing then
// would put the password into the app in front. When it stays locked, it
// gives the lock screen wakeSettle more to take input, empties its field
// with Escape (the first key after the lock screen sat idle can be
// swallowed, which loses the password's first letter), checks once more
// that it is still locked, and types the password and Return only while
// loginwindow's password field has the keyboard (typeSecret checks before
// each); then it watches up to settle for the screen to open. Still locked:
// the same once more. When nothing can tell whether it is locked, nothing is
// typed: the login window's "Name and password" or an open desktop would
// take the password in clear.
func (s *Screen) unlockOn(ctx context.Context, c *rfbConn, password [][]keyEvent, wakeWait time.Duration) (unlockOutcome, error) {
	var out unlockOutcome
	if err := s.sendChords(ctx, c, [][]keyEvent{tap(ksShiftL)}); err != nil {
		return out, err
	}
	locked, known, err := s.watchLock(ctx, wakeWait)
	out.locked, out.known = locked, known
	switch {
	case err != nil || (known && !locked):
		return out, err
	case !known:
		return out, errLockUnknown
	}
	if err := pause(ctx, s.wakeSettle); err != nil {
		return out, err
	}
	// The lock screen of the session at the screen; its user's helper says
	// what is in front. Typing and the waits after it leave time to empty
	// the field should they run out.
	uid, _ := s.consoleUID()
	t := &keyTarget{allowed: s.loginWindow, uid: uid, lock: true}
	escape := [][]keyEvent{tap(ksEscape)}
	tctx, cancel := s.typingTime(ctx)
	defer cancel()
	var took time.Duration
	for try := 0; try < 2; try++ {
		if dl, ok := tctx.Deadline(); try > 0 && ok && time.Until(dl) < took {
			break // no time for another try
		}
		began := time.Now()
		// Escape empties the field; it too goes only while the lock screen's
		// field has the keyboard.
		if err := s.sendChecked(tctx, c, t, escape); err != nil {
			return out, s.lockNotTyped(err)
		}
		if err := pause(tctx, s.escGap); err != nil {
			return out, err
		}
		// Never type into a screen that opened meanwhile.
		out.locked, out.known = s.lockedNow(tctx)
		switch {
		case !out.known:
			return out, errLockUnknown
		case !out.locked:
			return out, nil
		}
		typed, err := s.typeSecret(tctx, c, password, t)
		if typed {
			out.typed++
		}
		switch {
		case err == nil:
		case !typed:
			return out, s.lockNotTyped(err)
		case errors.Is(err, errNotSecure):
			s.clearField(ctx, c, t, escape)
			s.log.Info("screen: the lock screen's password field lost the keyboard while typing", "err", err)
			return out, &codeError{"failed", "The lock screen's password field lost the keyboard while the password was typed, so Whombat typed nothing more and didn't press Return."}
		default:
			// Part of it went (out of time, say): emptied while the field
			// still has the keyboard.
			s.clearField(ctx, c, t, escape)
			s.log.Info("screen: typing into the lock screen stopped", "err", err)
			return out, &codeError{"failed", "Typing the password into the lock screen stopped part-way, so Whombat emptied its field and didn't press Return."}
		}
		if out.locked, out.known, err = s.watchLock(tctx, s.settle); err != nil || !out.known || !out.locked {
			return out, err
		}
		took = time.Since(began)
		s.log.Info("screen: still locked after typing the password", "try", try+1)
	}
	return out, nil
}

// lockNotTyped is unlock's answer when nothing of the password went: the
// login window after a restart, the lock screen's field without the
// keyboard or covered; anything else as it is.
func (s *Screen) lockNotTyped(err error) error {
	switch {
	case errors.Is(err, errAtLoginWindow):
		s.log.Info("screen: the Mac is at its login window; nothing typed", "err", err)
		return &codeError{"failed", loginWindowMsg}
	case errors.Is(err, errNotSecure):
		s.log.Info("screen: the lock screen's password field doesn't have the keyboard; nothing typed", "err", err)
		return &codeError{"failed", "The lock screen's password field doesn't have the keyboard, or something else is in front of the lock screen, so nothing was typed."}
	}
	return err
}

// unlockByHelper unlocks through the helper when it can. Keys from inside
// the person's session open the lock screen for good, while typed through
// Screen Sharing they don't last: macOS saves the lock when Screen Sharing
// starts showing the screen and locks it again when its last viewer leaves
// (tried). So the kept Screen Sharing session ends first, and nothing of the
// agent's watches the screen meanwhile. used is false when it can't: nobody
// or someone else is at the screen (the password goes only to its own
// user's session), no helper with Accessibility, a helper that doesn't check
// the lock screen's field before each key it sends (before 1.0.4: it never
// gets the password), or its unlock didn't go through.
func (s *Screen) unlockByHelper(ctx context.Context, acct Account) (out unlockOutcome, used bool, err error) {
	uid, ok := s.consoleUID()
	if !ok {
		return out, false, nil
	}
	sessions, err := s.sessions(ctx)
	if err != nil || !strings.EqualFold(consoleUser(sessions), acct.User) {
		return out, false, nil
	}
	locked, _ := lockState(sessions)
	if out.locked, out.known = s.keepLock(locked, true); !locked {
		return out, true, nil // open, so the display is on (its sleep sets the lock)
	}
	hctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	st, err := s.helper.call(hctx, uid, map[string]any{"op": "status"})
	cancel()
	if err != nil || !st.OK || !st.AX {
		return out, false, nil
	}
	s.noteHelper(st)
	if !helperAtLeast(st.Version, helperGuardedKeys) {
		s.log.Info("screen: Whombat Helper is too old to get the password for its unlock; typing through Screen Sharing", "version", clip(st.Version, 64))
		return out, false, nil
	}
	if s.dropConnection() {
		// Its end locks the screen once more; let the lock screen settle.
		if err := pause(ctx, s.wakeSettle); err != nil {
			return out, true, err
		}
	}
	for try := 0; try < 2; try++ {
		if dl, ok := ctx.Deadline(); try > 0 && ok && time.Until(dl) < 2*s.settle {
			break // no time for another try
		}
		a, err := s.helper.call(ctx, uid, map[string]any{"op": "unlock", "password": acct.Password})
		switch {
		case err != nil && ctx.Err() != nil:
			return out, true, ctx.Err()
		case err != nil || !a.OK:
			if try > 0 {
				return out, true, nil
			}
			msg := ""
			if a != nil {
				msg = a.Code + ": " + a.Message
			}
			s.log.Info("screen: Whombat Helper didn't unlock; typing through Screen Sharing", "helper", msg, "err", err)
			return out, false, nil
		case a.Message == "typed":
			out.typed++
		}
		if out.locked, out.known, err = s.watchLock(ctx, s.settle); err != nil || !out.known || !out.locked {
			return out, true, err
		}
		s.log.Info("screen: still locked after Whombat Helper typed the password", "try", try+1)
	}
	return out, true, nil
}

// consoleUser is the user of the session at the screen ("" at the login
// window).
func consoleUser(sessions []consoleSession) string {
	for _, c := range sessions {
		if c.OnConsole && c.LoggedIn {
			return c.User
		}
	}
	return ""
}

// opUnlock wakes the display and types the screen account's password when
// the lock screen or the login window waits for it: through the helper when
// it can (unlockByHelper: the screen stays open), else through Screen
// Sharing (unlockOn), whose session then stays open up to unlockHold
// without steps, as the screen locks again when it ends.
func (s *Screen) opUnlock(ctx context.Context) (proto.ScreenResponse, error) {
	if _, err := ReadAccount(s.dir); err != nil {
		return proto.ScreenResponse{}, errNoAccount
	}
	var out unlockOutcome
	var byHelper bool
	// One step: the helper's unlock closes the kept connection, which must
	// not happen under another step. The account is read inside it, so a
	// Forget queued before it wins.
	err := s.exclusive(ctx, func() error {
		acct, err := ReadAccount(s.dir)
		if err != nil {
			return errNoAccount
		}
		password, err := textEvents(acct.Password)
		if err != nil {
			return fmt.Errorf("the stored password can't be typed: %w", err)
		}
		if out, byHelper, err = s.unlockByHelper(ctx, acct); err != nil || byHelper {
			return err
		}
		return s.withConn(ctx, func(c *rfbConn) error {
			var e error
			out, e = s.unlockOn(ctx, c, password, s.wakeWait)
			if e == nil && out.typed > 0 && out.known && !out.locked {
				s.holdConnection(c)
			}
			return e
		})
	})
	if err != nil {
		st, _ := s.snapshot()
		return proto.ScreenResponse{Status: &st}, err
	}
	st, _ := s.snapshot()
	resp := proto.ScreenResponse{Status: &st}
	switch {
	case out.typed == 0 && out.known && !out.locked:
		resp.Message = "The screen wasn't locked."
	case !out.known:
		return resp, &codeError{"failed", "Typed the password, but couldn't tell whether the screen opened."}
	case out.locked:
		return resp, &codeError{"failed", fmt.Sprintf("The Mac's screen is still locked after typing the password %s.", times(out.typed))}
	case !byHelper:
		resp.Message = fmt.Sprintf("Unlocked through Screen Sharing, which macOS undoes: the screen locks again when Whombat's screen session ends, %s after its last step.", inWords(s.unlockHold))
	}
	return resp, nil
}

// inWords says a duration of whole minutes the way people do.
func inWords(d time.Duration) string {
	switch m := int(d / time.Minute); {
	case d%time.Minute != 0:
		return d.String()
	case m == 1:
		return "a minute"
	default:
		return fmt.Sprintf("%d minutes", m)
	}
}

func times(n int) string {
	switch n {
	case 1:
		return "once"
	case 2:
		return "twice"
	}
	return fmt.Sprintf("%d times", n)
}

// The account steps replace or drop the kept connection, so they run as
// steps of their own (exclusive), never under another.

func (s *Screen) opAccountSet(ctx context.Context, req proto.ScreenRequest) (proto.ScreenResponse, error) {
	if req.Account == nil {
		return proto.ScreenResponse{}, invalidError("give the Mac's user name and password")
	}
	acct := Account{User: strings.TrimSpace(req.Account.User), Password: req.Account.Password}
	if err := validAccount(acct); err != nil {
		return proto.ScreenResponse{}, invalidError(err.Error())
	}
	err := s.exclusive(ctx, func() error {
		c, err := s.dialRFB(ctx, acct)
		if err != nil {
			if errors.Is(err, rfb.ErrAuth) {
				s.log.Info("screen: account refused by Screen Sharing; not stored", "user", acct.User)
				return errSignInFailed
			}
			if errors.Is(err, errNoScreen) || errors.Is(err, errSharingNotApple) {
				s.markSharing(false)
			}
			return err
		}
		if err := writeAccount(s.dir, acct); err != nil {
			c.close()
			return fmt.Errorf("storing the account: %w", err)
		}
		w, h := c.size()
		s.noteSignIn(acct.User, true, w, h)
		s.markSharing(true)
		// The connection that just signed in becomes the kept one.
		s.connMu.Lock()
		if s.conn != nil {
			s.conn.close()
		}
		s.conn, s.connKey, s.connUsed, s.connHolds = c, accountKey(acct), s.now(), false
		s.connMu.Unlock()
		s.log.Info("screen: account stored", "user", acct.User, "resolution", c.info.Resolution())
		return nil
	})
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	st, _ := s.snapshot()
	return proto.ScreenResponse{Status: &st}, nil
}

func (s *Screen) opAccountCheck(ctx context.Context) (proto.ScreenResponse, error) {
	if _, err := ReadAccount(s.dir); errors.Is(err, fs.ErrNotExist) {
		return proto.ScreenResponse{}, errNoAccount
	}
	// The account is read inside the step, so a Forget queued before it wins.
	err := s.exclusive(ctx, func() error {
		acct, err := ReadAccount(s.dir)
		if errors.Is(err, fs.ErrNotExist) {
			return errNoAccount
		}
		if err != nil {
			return err
		}
		s.dropConnection()
		c, err := s.dialRFB(ctx, acct)
		if err != nil {
			return s.signInError(acct.User, err)
		}
		w, h := c.size()
		s.noteSignIn(acct.User, true, w, h)
		s.markSharing(true)
		s.connMu.Lock()
		s.conn, s.connKey, s.connUsed, s.connHolds = c, accountKey(acct), s.now(), false
		s.connMu.Unlock()
		return nil
	})
	st, _ := s.snapshot()
	return proto.ScreenResponse{Status: &st}, err
}

func (s *Screen) opAccountClear(ctx context.Context) (proto.ScreenResponse, error) {
	err := s.exclusive(ctx, func() error {
		s.dropConnection()
		if err := clearAccount(s.dir); err != nil {
			return err
		}
		s.mu.Lock()
		s.signIn, s.signInUser, s.signInAt = "", "", time.Time{}
		s.mu.Unlock()
		return nil
	})
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	s.log.Info("screen: account forgotten")
	st, _ := s.snapshot()
	return proto.ScreenResponse{Status: &st}, nil
}

// ---- ui.*: the helper ----

// UI request limits.
const (
	uiListDefault = 300
	uiListMax     = 1000
	uiTextMax     = 200
	uiValueMax    = 10000
	uiPathMax     = 8
)

func checkText(field, v string, n int, required bool) error {
	switch {
	case required && strings.TrimSpace(v) == "":
		return invalidError("give " + field)
	case utf8.RuneCountInString(v) > n:
		return invalidError(fmt.Sprintf("%s is at most %d characters", field, n))
	case strings.ContainsAny(v, "\x00"):
		return invalidError(field + " can't hold a NUL")
	}
	return nil
}

// uiRequest builds the helper's request for a ui.* step.
func uiRequest(req proto.ScreenRequest) (map[string]any, error) {
	m := map[string]any{}
	if err := checkText("app", req.App, uiTextMax, req.Op == proto.ScreenUIFocus); err != nil {
		return nil, err
	}
	if req.App != "" {
		m["app"] = req.App
	}
	role, ok := axRole(req.Role)
	if !ok {
		return nil, invalidError("role is button, checkbox, switch, text_field, menu_item, link, tab, row, popup, radio, any or an AX role, or up to 8 of them separated by commas (at most 64 characters)")
	}
	if req.Index < 0 || req.Index > 1000 {
		return nil, invalidError("index is 0 to 1000")
	}
	switch req.Op {
	case proto.ScreenUIApps:
		m["op"] = "apps"
	case proto.ScreenUIList:
		m["op"] = "list"
		limit := req.Limit
		if limit == 0 {
			limit = uiListDefault
		}
		if limit < 0 || limit > uiListMax {
			return nil, invalidError(fmt.Sprintf("limit is 1 to %d", uiListMax))
		}
		m["limit"] = limit
		if err := checkText("window", req.Window, uiTextMax, false); err != nil {
			return nil, err
		}
		if req.Window != "" {
			m["window"] = req.Window
		}
	case proto.ScreenUIPress, proto.ScreenUISet:
		m["op"] = "press"
		if req.Op == proto.ScreenUISet {
			m["op"] = "set"
			if err := checkText("the value", req.Text, uiValueMax, false); err != nil {
				return nil, err
			}
			m["value"] = req.Text
		}
		if err := checkText("the name", req.Name, uiTextMax, req.Op == proto.ScreenUIPress); err != nil {
			return nil, err
		}
		if req.Name != "" {
			m["name"] = req.Name
		}
		if role != "" {
			m["role"] = role
		}
		if req.Index > 0 {
			m["index"] = req.Index
		}
	case proto.ScreenUIMenu:
		m["op"] = "menu"
		if len(req.Path) == 0 || len(req.Path) > uiPathMax {
			return nil, invalidError(fmt.Sprintf("path names 1 to %d menu items, for example [\"File\", \"Save…\"]", uiPathMax))
		}
		for _, p := range req.Path {
			if err := checkText("a menu item", p, uiTextMax, true); err != nil {
				return nil, err
			}
		}
		m["path"] = req.Path
	case proto.ScreenUIFocus:
		m["op"] = "focus"
	case proto.ScreenUIOpen:
		m["op"] = "open"
		t := strings.TrimSpace(req.Target)
		if err := checkText("the target", t, 2048, true); err != nil {
			return nil, err
		}
		if strings.Contains(t, ":") && t != "accessibility" {
			u, err := url.Parse(t)
			if err != nil || u.Scheme != "https" || u.Host == "" {
				return nil, invalidError("target is \"accessibility\", an app's name or an https address")
			}
		} else if utf8.RuneCountInString(t) > uiTextMax || strings.Contains(t, "/") {
			return nil, invalidError("target is \"accessibility\", an app's name or an https address")
		}
		m["target"] = t
	}
	return m, nil
}

// uiNeedsAccess: the steps that read or drive other apps' controls.
func uiNeedsAccess(op string) bool {
	switch op {
	case proto.ScreenUIList, proto.ScreenUIPress, proto.ScreenUISet, proto.ScreenUIMenu:
		return true
	}
	return false
}

func (s *Screen) opUI(ctx context.Context, req proto.ScreenRequest) (proto.ScreenResponse, error) {
	hreq, err := uiRequest(req)
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	uid, ok := s.consoleUID()
	if !ok {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoHelper, "Nobody is signed in at the Mac's screen, so Whombat Helper isn't running. Unlock the screen first."}
	}
	st, err := s.helper.call(ctx, uid, map[string]any{"op": "status"})
	if err != nil {
		var refusal *helperRefusal
		switch {
		case ctx.Err() != nil:
			return proto.ScreenResponse{}, ctx.Err()
		case errors.As(err, &refusal), errors.Is(err, errHelperBusy):
			return proto.ScreenResponse{}, err // says why
		}
		return proto.ScreenResponse{}, errNoHelper
	}
	if !st.OK {
		return proto.ScreenResponse{}, helperError(st)
	}
	s.noteHelper(st)
	if st.Locked {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeLocked, "The Mac's screen is locked. Unlock it first."}
	}
	if uiNeedsAccess(req.Op) && !st.AX {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoAccess, "Whombat Helper doesn't have Accessibility yet. Switch it on in System Settings → Privacy & Security → Accessibility."}
	}
	a, err := s.helper.call(ctx, uid, hreq)
	if err != nil {
		if ctx.Err() != nil {
			return proto.ScreenResponse{}, ctx.Err()
		}
		return proto.ScreenResponse{}, fmt.Errorf("Whombat Helper didn't answer: %w", err)
	}
	// The screen is in use: a session that holds an unlock stays open.
	s.touchConnection()
	if !a.OK {
		return proto.ScreenResponse{}, helperError(a)
	}
	fbW, _ := s.fbSize()
	pm := newPointMap(st.Displays, fbW)
	// The helper's note on what happened (a press whose app is still busy)
	// goes with the answer.
	resp := proto.ScreenResponse{Message: clip(strings.TrimSpace(a.Message), 1000)}
	switch req.Op {
	case proto.ScreenUIApps:
		for _, app := range a.Apps {
			resp.Apps = append(resp.Apps, proto.UIApp{Name: clip(app.Name, uiTextMax), BundleID: clip(app.BundleID, uiTextMax),
				PID: app.PID, Active: app.Active, Windows: clipList(app.Windows, 50, uiTextMax)})
		}
	case proto.ScreenUIList:
		limit := hreq["limit"].(int)
		for i, e := range a.Elements {
			if i >= limit {
				resp.Truncated = true
				break
			}
			resp.Elements = append(resp.Elements, pm.element(e))
		}
		resp.Truncated = resp.Truncated || a.Truncated
	}
	if a.Element != nil {
		e := pm.element(*a.Element)
		resp.Element = &e
	}
	return resp, nil
}

// helperError maps the helper's own codes.
func helperError(a *helperAnswer) error {
	msg := clip(strings.TrimSpace(a.Message), 1000)
	switch a.Code {
	case proto.ScreenCodeNoAccess, proto.ScreenCodeNotFound, proto.ScreenCodeLocked, "failed":
		if msg == "" {
			msg = "Whombat Helper couldn't do that (" + a.Code + ")."
		}
		return &codeError{a.Code, msg}
	case "invalid_request":
		if msg == "" {
			msg = "Whombat Helper didn't understand the request."
		}
		return invalidError(msg)
	}
	if msg == "" {
		msg = "Whombat Helper couldn't do that."
	}
	return &codeError{"failed", msg}
}
