package screen

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// promptApps are macOS's own password prompt processes (tried on macOS 27):
// SecurityAgent (authorization: a script or app asking for an
// administrator), LocalAuthentication's UI agent (coreautha) and TCC's
// prompt service. Every password field they show asks for the Mac's
// password. The lock screen and the login window (loginwindow) are
// unlock's. NetAuthAgent is left out on purpose: it asks for another
// computer's password.
var promptApps = []string{
	"com.apple.SecurityAgent",
	"com.apple.LocalAuthentication.UIAgent",
	"com.apple.tcc.AuthorizationPromptService",
}

// A bundle id can be copied by any app, an executable under /System can't
// (the sealed system volume holds only Apple's code).
const (
	systemPrefix   = "/System/"
	settingsPanes  = "/System/Library/ExtensionKit/Extensions/"
	settingsApp    = "/System/Applications/System Settings.app/Contents/MacOS/System Settings"
	lockSymbol     = "lock.fill" // the lock on System Settings' password sheet (an SF Symbol: no language)
	appleBundleIDs = "com.apple."
)

func isPromptApp(bundleID string) bool {
	for _, b := range promptApps {
		if bundleID == b {
			return true
		}
	}
	return false
}

// isSettingsExec: System Settings and its panes, which show their own
// password sheet when a change needs an administrator ("Privacy & Security
// is trying to modify your system settings": the pane's extension process,
// com.apple.settings.PrivacySecurity.extension, tried).
func isSettingsExec(exe string) bool {
	return strings.HasPrefix(exe, settingsPanes) || exe == settingsApp
}

func isSecureField(e helperElement) bool {
	return e.Role == "AXSecureTextField" || e.Subrole == "AXSecureTextField"
}

// prompt is a password prompt the helper found.
type prompt struct {
	bundleID string
	app      string // its name, as the helper says it
	settings bool   // System Settings' sheet (else one of promptApps)
	field    helperElement
}

// promptField picks the password field of a prompt among an app's
// elements. For System Settings only a field in a sheet that shows the lock
// and holds no other password field counts: a pane also asks for a Wi-Fi
// network's key or a new user's password, which are not the Mac's.
func promptField(els []helperElement, settings bool) *helperElement {
	for i, e := range els {
		if !isSecureField(e) || !e.Enabled || e.W <= 0 || e.H <= 0 {
			continue
		}
		if !settings {
			return &els[i]
		}
		sheet := ""
		for _, c := range els {
			if (c.Role == "AXSheet" || c.Subrole == "AXDialog") && strings.HasPrefix(e.ID, c.ID+".") && len(c.ID) > len(sheet) {
				sheet = c.ID
			}
		}
		if sheet == "" {
			continue
		}
		secure, lock := 0, false
		for _, c := range els {
			if !strings.HasPrefix(c.ID, sheet+".") {
				continue
			}
			if isSecureField(c) {
				secure++
			}
			if c.Role == "AXImage" && c.Identifier == lockSymbol {
				lock = true
			}
		}
		if secure == 1 && lock {
			return &els[i]
		}
	}
	return nil
}

// Keys the password step sends besides the password: a letter for macOS to
// drop, and Command-A and Delete to empty a field.
var (
	leadKeys  = mustKeys("x")
	clearKeys = mustKeys("cmd+a delete")
)

func mustKeys(k string) [][]keyEvent {
	chords, err := parseKeys(k)
	if err != nil {
		panic(err)
	}
	return chords
}

// typeIntoPrompt types the password (and its Return) into the prompt's
// field through Screen Sharing, which loses keys there (macOS 27, tried in
// SecurityAgent's prompt while it stayed the app in front): around a
// session's start, and after the Mac sat without input the letters of the
// first 0.6 s or so (ten letters 0.2 s apart: the first three never
// arrived; a Shift tap before them doesn't help). So, after settleSharing, a
// letter is sent to be lost, leadSettle later Command-A and Delete empty the
// field of it and of anything else, and then the password goes in. The field
// is checked before the letter, before Command-A, before Delete, before each
// character of the password and before Return (secureField); typed says
// whether any of the password went out.
func (s *Screen) typeIntoPrompt(ctx context.Context, c *rfbConn, password [][]keyEvent, t *keyTarget) (typed bool, err error) {
	if err := s.sendChecked(ctx, c, t, leadKeys); err != nil {
		return false, err
	}
	if err := pause(ctx, s.leadSettle); err != nil {
		return false, err
	}
	if err := s.sendChecked(ctx, c, t, clearKeys); err != nil {
		return false, err
	}
	return s.typeSecret(ctx, c, password, t)
}

// promptTypingFailed is the answer when typing into a prompt stopped
// part-way: the field is emptied only while it still has the keyboard.
func (s *Screen) promptTypingFailed(ctx context.Context, c *rfbConn, t *keyTarget, typed bool, err error) error {
	if ctx.Err() != nil && !errors.Is(err, errNotSecure) {
		return err
	}
	switch {
	case !typed && errors.Is(err, errNotSecure):
		s.log.Info("screen: the prompt's password field didn't have the keyboard; nothing typed", "err", err)
		return &codeError{"failed", "The password prompt's password field didn't have the keyboard, so nothing was typed."}
	case !typed:
		return err
	case s.clearField(ctx, c, t, clearKeys):
		s.log.Info("screen: typing into the prompt stopped; emptied its field", "err", err)
		if errors.Is(err, context.DeadlineExceeded) {
			return &codeError{"failed", "Typing the password took too long, so Whombat emptied the prompt's password field and didn't press Return."}
		}
		return &codeError{"failed", "Typing the password stopped part-way, so Whombat emptied the prompt's password field and didn't press Return."}
	}
	s.log.Info("screen: typing into the prompt stopped and its field lost the keyboard", "err", err)
	return &codeError{"failed", "The password prompt's field lost the keyboard while the password was typed, so Whombat typed nothing more and didn't press Return."}
}

// frontApp is the app with the keyboard focus, as the helper sees it.
func (s *Screen) frontApp(ctx context.Context, uid int) (*helperApp, error) {
	a, err := s.helper.call(ctx, uid, map[string]any{"op": "apps"})
	if err != nil {
		return nil, err
	}
	if !a.OK {
		return nil, helperError(a)
	}
	for i := range a.Apps {
		if a.Apps[i].Active {
			return &a.Apps[i], nil
		}
	}
	return nil, nil
}

// trusted says whether the app is what the prompt claims to be: one of
// promptApps run from /System, or System Settings or one of its panes, by
// the file the kernel says it runs, and its code signed by Apple. It
// returns that file.
func (s *Screen) trusted(ctx context.Context, app *helperApp, settings bool) (string, bool) {
	exe, err := s.processPath(ctx, app.PID)
	switch {
	case err != nil:
		return "", false
	case settings && !(strings.HasPrefix(app.BundleID, appleBundleIDs) && isSettingsExec(exe)):
		return "", false
	case !settings && !(isPromptApp(app.BundleID) && strings.HasPrefix(exe, systemPrefix)):
		return "", false
	}
	return exe, s.appleCode(ctx, app.PID)
}

// list asks the helper for an app's elements ("" = the app with the
// keyboard focus); ok is false when that app isn't running.
func (s *Screen) listApp(ctx context.Context, uid int, app, role string) (els []helperElement, ok bool, err error) {
	req := map[string]any{"op": "list", "limit": 200}
	if app != "" {
		req["app"] = app
	}
	if role != "" {
		req["role"] = role
	}
	a, err := s.helper.call(ctx, uid, req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, fmt.Errorf("Whombat Helper didn't answer: %w", err)
	}
	if !a.OK {
		if a.Code == proto.ScreenCodeNotFound {
			return nil, false, nil
		}
		return nil, false, helperError(a)
	}
	return a.Elements, true, nil
}

// findPrompt finds the password field of macOS's own prompt: one of
// promptApps', or System Settings' sheet in the app with the keyboard focus
// (nil when there is none).
func (s *Screen) findPrompt(ctx context.Context, uid int) (*prompt, error) {
	for _, app := range promptApps {
		els, ok, err := s.listApp(ctx, uid, app, "AXSecureTextField")
		if err != nil {
			return nil, err
		}
		if f := promptField(els, false); ok && f != nil {
			return &prompt{bundleID: app, app: f.App, field: *f}, nil
		}
	}
	front, err := s.frontApp(ctx, uid)
	if err != nil || front == nil {
		return nil, err
	}
	if _, ok := s.trusted(ctx, front, true); !ok {
		return nil, nil
	}
	els, ok, err := s.listApp(ctx, uid, "", "")
	if err != nil {
		return nil, err
	}
	if f := promptField(els, true); ok && f != nil && f.App == front.Name {
		return &prompt{bundleID: front.BundleID, app: front.Name, settings: true, field: *f}, nil
	}
	return nil, nil
}

// promptHasFocus says whether the keyboard goes to p's password field now:
// the app with the keyboard focus is p's, it is what it claims to be, its
// focused element is the prompt's password field, and that field lies in
// the frontmost window, which is that app's. For System Settings' sheet
// LocalAuthentication must be busy for the pane that has the focus. It
// returns where the password may go: that app's process (and for the sheet
// the processes that hold it), that window, and the field itself as the
// helper names the focused element (version: the helper's, which says
// whether that name carries the element's token).
func (s *Screen) promptHasFocus(ctx context.Context, uid int, p *prompt, version string) (*keyTarget, error) {
	front, err := s.frontApp(ctx, uid)
	if err != nil || front == nil || front.BundleID != p.bundleID || front.Name != p.app {
		return nil, err
	}
	exe, ok := s.trusted(ctx, front, p.settings)
	if !ok {
		s.log.Warn("screen: the app with the focus poses as a password prompt", "bundle_id", front.BundleID, "pid", front.PID)
		return nil, nil
	}
	role := "AXSecureTextField"
	if p.settings {
		role = "" // the sheet's lock and its other fields count too
	}
	// No app named: the one with the keyboard focus, so the field found is
	// in the process just checked.
	els, ok, err := s.listApp(ctx, uid, "", role)
	if err != nil || !ok {
		return nil, err
	}
	f := promptField(els, p.settings)
	if f == nil || !f.Focused || f.App != front.Name {
		return nil, nil
	}
	pids := []int{front.PID}
	pane := ""
	if p.settings {
		// The sheet asks for the Mac's password only while LocalAuthentication
		// is busy for the pane that has the focus; every later check asks
		// again.
		sheet, err := s.paneSheet(ctx, uid, exe)
		if err != nil || !sheet.busy {
			s.log.Info("screen: System Settings' sheet isn't LocalAuthentication's asking for the Mac's password", "pane", exe, "err", err)
			return nil, nil
		}
		pids = append(pids, sheet.pids...)
		pane = exe
	}
	allowed := pidSet(pids...)
	// The window the password goes to: every later check holds the focused
	// field to it. It is the frontmost window and belongs to the prompt's
	// processes (System Settings draws a pane's sheet in a window of its own
	// while the pane's extension has the focus: seen on macOS 27).
	wins, err := s.helperWindows(ctx, uid)
	if errors.Is(err, errOldHelper) {
		return nil, &codeError{"failed", oldHelperMsg}
	}
	if err != nil {
		return nil, err
	}
	w := s.frontWindow(ctx, wins)
	if w == nil || !allowed(ctx, w.PID) || !inWindow(*f, *w) {
		return nil, nil
	}
	// The field itself, as the helper names the focused element: every
	// later check needs that very element to have the focus.
	a, err := s.helper.call(ctx, uid, map[string]any{"op": "focused"})
	switch {
	case err != nil && ctx.Err() != nil:
		return nil, ctx.Err()
	case err != nil:
		return nil, err
	case !a.OK || a.Element == nil:
		return nil, nil
	}
	el := *a.Element
	pin := *f
	pin.Token = el.Token
	switch {
	case !isSecureField(el) || !allowed(ctx, a.PID) || !sameField(el, pin) || !inWindow(el, *w):
		return nil, nil
	case helperAtLeast(version, helperFieldToken) && el.Token == "":
		s.log.Info("screen: Whombat Helper named the focused field without its token")
		return nil, nil
	}
	return &keyTarget{allowed: allowed, uid: uid, ax: true, window: w, field: &pinnedField{pid: a.PID, el: el}, pane: pane}, nil
}

// promptGone watches up to within for p's password field to go away.
func (s *Screen) promptGone(ctx context.Context, uid int, p *prompt, within time.Duration) bool {
	deadline := time.Now().Add(within)
	role := "AXSecureTextField"
	if p.settings {
		role = ""
	}
	for {
		els, ok, err := s.listApp(ctx, uid, p.bundleID, role)
		if err == nil && (!ok || promptField(els, p.settings) == nil) {
			return true
		}
		if !time.Now().Add(s.pollGap).Before(deadline) || pause(ctx, s.pollGap) != nil {
			return false
		}
	}
}

// storedPassword reads the screen account and its password's keys.
func storedPassword(dir string) ([][]keyEvent, error) {
	acct, err := ReadAccount(dir)
	if err != nil {
		return nil, errNoAccount
	}
	password, err := textEvents(acct.Password)
	if err != nil {
		return nil, fmt.Errorf("the stored password can't be typed: %w", err)
	}
	return password, nil
}

const (
	oldHelperMsg = "Whombat Helper is too old to answer a password prompt safely, so nothing was typed. It updates by itself; try again then."
	noPromptMsg  = "No macOS password prompt is on the Mac's screen."
	noAccessMsg  = "Whombat Helper needs Accessibility to find macOS's password prompt. Switch it on in System Settings → Privacy & Security → Accessibility."
)

// opPassword types the screen account's password into macOS's own password
// prompt in front (an administrator prompt, a privacy switch's) and
// presses Return, then answers whether the prompt went away. With
// Accessibility it finds the prompt's password field through the helper,
// clicks into it through Screen Sharing (which makes the prompt's window the
// one taking keys), and types only when the keyboard focus is in that field of
// one of macOS's own prompt processes, so the password never goes into an
// ordinary app or a web page. Without it, passwordByWindows. The lock
// screen and the login window take it through unlock.
func (s *Screen) opPassword(ctx context.Context, req proto.ScreenRequest) (proto.ScreenResponse, error) {
	if req.Text != "" || req.Account != nil {
		return proto.ScreenResponse{}, invalidError("password types the Mac's stored password; it takes no text")
	}
	if _, err := ReadAccount(s.dir); err != nil {
		return proto.ScreenResponse{}, errNoAccount
	}
	if locked, known := s.lockedNow(ctx); known && locked {
		return s.opUnlock(ctx)
	}
	uid, ok := s.consoleUID()
	if !ok {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoHelper, "Nobody is signed in at the Mac's screen, so there is no password prompt to answer. Unlock the screen first."}
	}
	st, err := s.helper.call(ctx, uid, map[string]any{"op": "status"})
	var refusal *helperRefusal
	switch {
	case err != nil && ctx.Err() != nil:
		return proto.ScreenResponse{}, ctx.Err()
	case errors.As(err, &refusal), errors.Is(err, errHelperBusy):
		return proto.ScreenResponse{}, err
	case err != nil:
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoHelper, "Whombat Helper isn't running at the Mac's screen; without it a password prompt can't be found safely."}
	case !st.OK:
		return proto.ScreenResponse{}, helperError(st)
	}
	s.noteHelper(st)
	if !st.AX || !helperAtLeast(st.Version, helperGuardedKeys) {
		// Without Accessibility the prompt is found in the window list (the
		// prompt that switches Accessibility on is one of these). A helper
		// before 1.0.4 isn't relied on for the checks before each key with
		// Accessibility either: the same way, as if it had none.
		return s.passwordByWindows(ctx, uid, st)
	}
	p, err := s.findPrompt(ctx, uid)
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	if p == nil {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoPrompt, noPromptMsg}
	}
	var field proto.UIElement
	err = s.step(ctx, func(c *rfbConn) error {
		// The account as it is now: a Forget queued before this step wins.
		password, err := storedPassword(s.dir)
		if err != nil {
			return err
		}
		if err := s.settleSharing(ctx, uid, c); err != nil {
			return err
		}
		w, _ := c.size()
		field = newPointMap(st.Displays, w).element(p.field)
		x, y := field.X+field.W/2, field.Y+field.H/2
		if err := inside(c, x, y); err != nil {
			return &codeError{"failed", "The password prompt isn't on the screen Whombat sees."}
		}
		for _, m := range []byte{0, btnLeft, 0} {
			if err := c.pointer(x, y, m); err != nil {
				return err
			}
			if err := pause(ctx, s.clickGap); err != nil {
				return err
			}
		}
		if err := pause(ctx, s.escGap); err != nil {
			return err
		}
		t, err := s.promptHasFocus(ctx, uid, p, st.Version)
		var ce *codeError
		switch {
		case err != nil && ctx.Err() != nil:
			return ctx.Err()
		case t == nil && errors.As(err, &ce):
			return err
		case t == nil:
			return &codeError{"failed", "Couldn't put the cursor in the prompt's password field, so nothing was typed."}
		}
		// Typing and the wait leave time to empty the field should they run out.
		tctx, cancel := s.typingTime(ctx)
		defer cancel()
		if typed, err := s.typeIntoPrompt(tctx, c, password, t); err != nil {
			return s.promptTypingFailed(ctx, c, t, typed, err)
		}
		if s.promptGone(tctx, uid, p, s.settle) {
			return nil
		}
		// Still there: the Mac refused it. The field is emptied while it
		// still has the keyboard, never typed into twice.
		if s.clearField(ctx, c, t, clearKeys) {
			return &codeError{"failed", "The password prompt is still there after typing the password: the Mac refused it. Whombat emptied the field."}
		}
		return &codeError{"failed", "The password prompt is still there after typing the password, and its field no longer has the keyboard, so Whombat left it alone."}
	})
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	s.log.Info("screen: typed the password into a prompt", "app", p.bundleID)
	return proto.ScreenResponse{Element: &field}, nil
}
