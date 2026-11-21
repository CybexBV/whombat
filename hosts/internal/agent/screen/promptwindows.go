package screen

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// The password step without Accessibility. Whombat Helper switched off in
// Accessibility (a new Mac, or a new ad hoc build of the helper, whose
// permission macOS forgets) can't read macOS's password prompt, and the
// prompt that switches it on is exactly such a prompt. The window server's
// list of windows needs no permission: it says which window is in front,
// whose it is and where. With that the agent recognises macOS's own prompt
// in front and types the password into it through Screen Sharing: keys go to
// the app macOS calls frontmost, which a prompt in front is (seen on both
// prompts). It never clicks the prompt: a click on its background, where no
// control is, keeps Screen Sharing's keys from reaching the prompt for the
// rest of that session (tried: on the title, on the empty top edge, waiting,
// moving the pointer afterwards), and without Accessibility the agent can't
// tell where the field is. For an administrator at the screen macOS fills in
// the name and puts the focus in the password field (seen on both prompts),
// so only then.

// Window levels (CGWindowLevel) that are the desktop's own furniture rather
// than a window someone works in: the Dock's and Notification Centre's (each
// a window over the whole screen that lets clicks through), the menu bar's and
// its menu extras' (Screen Sharing's "Your screen is being controlled"
// among them); and the pointer's level and above (Screen Sharing's
// indicators). SecurityAgent's prompt sits above all but the pointer's
// (level 1000); System Settings' sheets are ordinary windows (level 0).
const (
	dockLayer   = 20
	statusLayer = 25
	cursorLayer = 2147483630
)

const (
	settingsBundleID = "com.apple.systempreferences"
	// LocalAuthentication's view of a password sheet inside an app: System
	// Settings' panes ask for an administrator through it. Its responsible
	// process (launchctl procinfo) is the pane that asked.
	laRemoteService = "/System/Library/PrivateFrameworks/LocalAuthenticationUI.framework/Versions/A/XPCServices/LocalAuthenticationRemoteService.xpc/Contents/MacOS/LocalAuthenticationRemoteService"
	privacyPane     = settingsPanes + "SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension"
	// promptMinSize: a prompt is a dialog, never a sliver.
	promptMinSize = 100
)

// ssMenuAgent is Screen Sharing's menu bar agent. About 0.75 s after a
// session signs in it shows its bubble (someone is watching), starting
// itself first when it isn't running, and keys sent while it comes up are
// lost: the first letter of the password landed in SecurityAgent's prompt
// and the rest didn't, while SecurityAgent stayed the app in front (tried).
const ssMenuAgent = "com.apple.SSMenuAgent"

// errOldHelper: a helper before 1.0.2, which has no `windows`.
var errOldHelper = errors.New("Whombat Helper is too old to list the windows")

// furniture says whether a window looks like part of the desktop rather
// than one someone works in: invisible, a sliver, the desktop, or at the
// Dock's, Notification Centre's, the menu bar's or the pointer's level.
func furniture(w helperWindow) bool {
	return w.Alpha <= 0 || w.W < 20 || w.H < 20 || w.Layer < 0 ||
		(w.Layer >= dockLayer && w.Layer <= statusLayer) || w.Layer >= cursorLayer
}

// overlaps says whether two windows share any of the screen.
func overlaps(a, b helperWindow) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

// frontWindow is the frontmost window someone works in (nil when there is
// none). Furniture in front of it is passed over only when it is macOS's own
// (appleWindow) or lies elsewhere on the screen: any program can put a
// window at the menu bar's level or make it transparent, and one of those
// over the window found would be in front of it. Other apps' menu bar icons
// are windows at that level too, so one that covers nothing doesn't count.
func (s *Screen) frontWindow(ctx context.Context, wins []helperWindow) *helperWindow {
	for i := range wins {
		if furniture(wins[i]) {
			continue
		}
		for j := 0; j < i; j++ {
			if overlaps(wins[j], wins[i]) && !s.appleWindow(ctx, wins[j]) {
				return &wins[j]
			}
		}
		return &wins[i]
	}
	return nil
}

// appleWindow says whether macOS itself owns a window: the kernel's record
// of its process's executable is under /System and its code is Apple's.
func (s *Screen) appleWindow(ctx context.Context, w helperWindow) bool {
	exe, err := s.processPath(ctx, w.PID)
	return err == nil && strings.HasPrefix(exe, systemPrefix) && s.appleCode(ctx, w.PID)
}

func sameWindow(a, b helperWindow) bool { return a.Number == b.Number && a.PID == b.PID }

// unchanged says whether b is window a, where it was and as large.
func unchanged(a, b helperWindow) bool {
	return sameWindow(a, b) && a.X == b.X && a.Y == b.Y && a.W == b.W && a.H == b.H
}

// sheetOf says whether w is a sheet of another window of its own app: one
// behind it that holds it entirely, as System Settings' main window holds
// its password sheet.
func sheetOf(w helperWindow, wins []helperWindow) bool {
	for _, p := range wins {
		if p.PID != w.PID || sameWindow(p, w) || furniture(p) {
			continue
		}
		if p.X <= w.X && w.X+w.W <= p.X+p.W && p.Y <= w.Y && w.Y+w.H <= p.Y+p.H && p.W*p.H > w.W*w.H {
			return true
		}
	}
	return false
}

// helperWindows asks the helper for the windows on the screen.
func (s *Screen) helperWindows(ctx context.Context, uid int) ([]helperWindow, error) {
	a, err := s.helper.call(ctx, uid, map[string]any{"op": "windows"})
	switch {
	case err != nil && ctx.Err() != nil:
		return nil, ctx.Err()
	case err != nil:
		return nil, fmt.Errorf("Whombat Helper didn't answer: %w", err)
	case !a.OK && a.Code == "invalid_request":
		return nil, errOldHelper // "unknown op windows"
	case !a.OK:
		return nil, helperError(a)
	}
	return a.Windows, nil
}

// promptWindow is macOS's own password prompt when it is the frontmost
// window: one of promptApps' run from /System, or System Settings' sheet
// while its Privacy & Security pane asks for an administrator; its owner is
// checked by the file the kernel says it runs and by Apple's signature.
// With it comes where the password may go (the prompt's process, and for the
// sheet the processes that hold it). Nil when the window in front is
// anything else.
func (s *Screen) promptWindow(ctx context.Context, uid int, wins []helperWindow) (*helperWindow, *keyTarget) {
	w := s.frontWindow(ctx, wins)
	if w == nil || w.W < promptMinSize || w.H < promptMinSize {
		return nil, nil
	}
	exe, err := s.processPath(ctx, w.PID)
	if err != nil {
		return nil, nil
	}
	if isPromptApp(w.BundleID) && strings.HasPrefix(exe, systemPrefix) && s.appleCode(ctx, w.PID) {
		return w, &keyTarget{allowed: pidSet(w.PID), uid: uid, window: w}
	}
	// System Settings draws a pane's password sheet in a window of its own
	// (the window list can't tell it from a Wi-Fi password's or a new user's
	// sheet), so LocalAuthentication must be busy for the Privacy & Security
	// pane right now as well.
	if w.BundleID == settingsBundleID && exe == settingsApp && sheetOf(*w, wins) && s.appleCode(ctx, w.PID) {
		sheet, err := s.paneSheet(ctx, uid, privacyPane)
		if err != nil {
			s.log.Info("screen: can't tell whether System Settings asks for a password", "err", err)
		}
		if err == nil && sheet.busy {
			return w, &keyTarget{allowed: pidSet(append(sheet.pids, w.PID)...), uid: uid, window: w, pane: privacyPane}
		}
	}
	return nil, nil
}

// paneSheet is System Settings asking for a password for one of its panes:
// whether LocalAuthentication's view service is busy for that pane (it is
// only while the sheet is up: tried on macOS 27), and the processes that
// may hold the sheet's password field: System Settings, the pane's
// extension and those services, all of the session's user.
type paneSheet struct {
	busy bool
	pids []int
}

// paneSheetOf finds pane's sheet in uid's session: candidates from ps,
// each checked by the file the kernel says it runs and Apple's signature;
// a view service counts when launchctl procinfo says it runs for the pane
// (responsible path) and is busy ("dirty").
func (s *Screen) paneSheetOf(ctx context.Context, uid int, pane string) (paneSheet, error) {
	var sheet paneSheet
	if runtime.GOOS != "darwin" {
		return sheet, errors.New("not a Mac")
	}
	out, err := runTool(ctx, 5*time.Second, "/bin/ps", "-axo", "pid=,uid=,comm=")
	if err != nil {
		return sheet, err
	}
	for _, c := range psProcesses(out, uid, settingsApp, pane, laRemoteService) {
		exe, err := s.processPath(ctx, c.pid)
		if err != nil || exe != c.comm || !s.appleCode(ctx, c.pid) {
			continue
		}
		if exe == laRemoteService {
			info, err := runTool(ctx, 5*time.Second, "/bin/launchctl", "procinfo", strconv.Itoa(c.pid))
			if err != nil {
				continue // gone meanwhile
			}
			responsible, dirty := procinfo(info)
			if responsible != pane {
				continue
			}
			sheet.busy = sheet.busy || dirty
		}
		sheet.pids = append(sheet.pids, c.pid)
	}
	return sheet, nil
}

// psProcess is one line of `ps -axo pid=,uid=,comm=` (on macOS comm is the
// path the process was started with, which it chose: only a candidate).
type psProcess struct {
	pid  int
	comm string
}

// psProcesses are uid's processes in ps whose comm is one of paths.
func psProcesses(ps string, uid int, paths ...string) []psProcess {
	var out []psProcess
	for _, line := range strings.Split(ps, "\n") {
		pidText, rest, _ := strings.Cut(strings.TrimSpace(line), " ")
		uidText, comm, _ := strings.Cut(strings.TrimSpace(rest), " ")
		pid, err1 := strconv.Atoi(pidText)
		u, err2 := strconv.Atoi(uidText)
		comm = strings.TrimSpace(comm)
		if err1 == nil && err2 == nil && u == uid && slices.Contains(paths, comm) {
			out = append(out, psProcess{pid, comm})
		}
	}
	return out
}

// procinfo reads `launchctl procinfo`'s responsible path and whether the
// process is dirty (has work it must finish before it may exit).
func procinfo(out string) (responsible string, dirty bool) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "responsible path = "); ok {
			responsible = v
		}
		if line == "dirty = 1" {
			dirty = true
		}
	}
	return responsible, dirty
}

// dsAdmin says whether a user is in the Mac's admin group.
func dsAdmin(ctx context.Context, user string) (bool, error) {
	out, err := runTool(ctx, 5*time.Second, "/usr/bin/dsmemberutil", "checkmembership", "-U", user, "-G", "admin")
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(out) {
	case "user is a member of the group":
		return true, nil
	case "user is not a member of the group":
		return false, nil
	}
	return false, fmt.Errorf("dsmemberutil: %s", firstLine(out))
}

// promptInFront says whether p is still the frontmost window, unchanged
// (where it was, as large), and its app is the one macOS gives the keyboard
// (NSWorkspace's frontmost: SecurityAgent while its prompt is up, even when
// another app is asked to come forward; System Settings while its sheet is:
// tried).
func (s *Screen) promptInFront(ctx context.Context, uid int, p helperWindow) (bool, error) {
	wins, err := s.helperWindows(ctx, uid)
	if err != nil {
		return false, err
	}
	if f := s.frontWindow(ctx, wins); f == nil || !unchanged(*f, p) {
		return false, nil
	}
	front, err := s.frontApp(ctx, uid)
	if err != nil || front == nil {
		return false, err
	}
	return front.PID == p.PID, nil
}

// windowGone watches up to within for p to leave the screen.
func (s *Screen) windowGone(ctx context.Context, uid int, p helperWindow, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		if wins, err := s.helperWindows(ctx, uid); err == nil {
			there := false
			for _, w := range wins {
				there = there || (sameWindow(w, p) && w.Alpha > 0)
			}
			if !there {
				return true
			}
		}
		if !time.Now().Add(s.pollGap).Before(deadline) || pause(ctx, s.pollGap) != nil {
			return false
		}
	}
}

// blindUserCheck: typing without seeing the fields is right only when macOS
// fills in the name and puts the focus in the password field, which it does
// for an administrator at the screen; and the password is the screen
// account's, so that account must be the one at the screen. Neither is
// something switching Accessibility on would fix (that prompt is one of
// these), so they aren't no_access: not_admin, or failed for someone else
// at the screen.
func (s *Screen) blindUserCheck(ctx context.Context, st *helperAnswer, acct Account) error {
	user := ""
	if sessions, err := s.sessions(ctx); err == nil {
		user = consoleUser(sessions)
	}
	if user == "" {
		user = st.User // the helper runs as the user at the screen
	}
	if !strings.EqualFold(user, acct.User) {
		return &codeError{"failed", fmt.Sprintf("Whombat Helper doesn't have Accessibility, and without it Whombat answers macOS's password prompt only for %s, the Mac's screen account, at the screen; someone else is. Type the password at the Mac.", acct.User)}
	}
	admin, err := s.isAdmin(ctx, acct.User)
	if err != nil {
		s.log.Info("screen: can't tell whether the screen account is an administrator", "err", err)
		return &codeError{"failed", fmt.Sprintf("Couldn't tell whether %s is an administrator of this Mac, so nothing was typed.", acct.User)}
	}
	if !admin {
		return &codeError{proto.ScreenCodeNotAdmin, fmt.Sprintf("%s isn't an administrator of this Mac. Without Accessibility for Whombat Helper, Whombat answers macOS's password prompt only for an administrator; type the password at the Mac.", acct.User)}
	}
	return nil
}

// settleSharing readies the Screen Sharing session for a password prompt's
// keys: a Shift tap (the session's own input first; harmless in a field),
// then a wait until the tap is inputSettle old, the session sharingSettle
// old, and Screen Sharing's bubble has stopped changing (two looks alike,
// fully shown), at most sharingSettleMax after the tap. A helper without
// `windows` can't show the bubble, so then only the times count.
func (s *Screen) settleSharing(ctx context.Context, uid int, c *rfbConn) error {
	if err := s.sendChords(ctx, c, [][]keyEvent{tap(ksShiftL)}); err != nil {
		return err
	}
	return s.waitSettled(ctx, uid, c.signedIn, time.Now())
}

// waitSettled is settleSharing's wait, for a session signed in at signedIn
// and tapped at tapped.
func (s *Screen) waitSettled(ctx context.Context, uid int, signedIn, tapped time.Time) error {
	ready := signedIn.Add(s.sharingSettle)
	if t := tapped.Add(s.inputSettle); t.After(ready) {
		ready = t
	}
	var last *helperWindow
	for {
		now := time.Now()
		if now.Sub(tapped) >= s.sharingSettleMax {
			return nil
		}
		var bubble *helperWindow
		wins, err := s.helperWindows(ctx, uid)
		for i := range wins {
			if wins[i].BundleID == ssMenuAgent && wins[i].Alpha > 0 {
				bubble = &wins[i]
				break
			}
		}
		steady := err != nil || bubble == nil ||
			(bubble.Alpha >= 1 && last != nil && sameWindow(*last, *bubble) && last.W == bubble.W && last.H == bubble.H)
		if !now.Before(ready) && steady {
			return nil
		}
		last = bubble
		if err := pause(ctx, s.pollGap); err != nil {
			return err
		}
	}
}

// bringForward makes p's app the frontmost when the prompt is in front but
// another app has the keyboard (the helper's focus, which needs no
// Accessibility), and says whether p is in front with the keyboard now.
func (s *Screen) bringForward(ctx context.Context, uid int, p helperWindow) (bool, error) {
	front, err := s.promptInFront(ctx, uid, p)
	if front || err != nil || p.BundleID == "" {
		return front, err
	}
	if a, err := s.helper.call(ctx, uid, map[string]any{"op": "focus", "app": p.BundleID}); err != nil || !a.OK {
		return false, nil
	}
	if err := pause(ctx, s.escGap); err != nil {
		return false, err
	}
	return s.promptInFront(ctx, uid, p)
}

// passwordByWindows types the screen account's password into macOS's own
// prompt in front when the helper can't read it (no Accessibility): it finds
// the prompt in the window list, checks the account, makes sure the prompt
// is in front with the keyboard, and types it (typeIntoPrompt: before each
// key the prompt's process has a password field with the keyboard and the
// prompt's window is still in front, unchanged). Then it watches the prompt
// go. When it stays, the field is emptied while it still passes, and the
// answer is failed: it never types the password twice.
func (s *Screen) passwordByWindows(ctx context.Context, uid int, st *helperAnswer) (proto.ScreenResponse, error) {
	wins, err := s.helperWindows(ctx, uid)
	if errors.Is(err, errOldHelper) && st.AX {
		return proto.ScreenResponse{}, &codeError{"failed", oldHelperMsg}
	}
	if errors.Is(err, errOldHelper) {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoAccess, noAccessMsg}
	}
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	p, t := s.promptWindow(ctx, uid, wins)
	if p == nil {
		return proto.ScreenResponse{}, &codeError{proto.ScreenCodeNoPrompt, noPromptMsg}
	}
	prompt := *p
	var el proto.UIElement
	err = s.step(ctx, func(c *rfbConn) error {
		// The account as it is now: a Forget queued before this step wins.
		acct, err := ReadAccount(s.dir)
		if err != nil {
			return errNoAccount
		}
		if err := s.blindUserCheck(ctx, st, acct); err != nil {
			return err
		}
		password, err := storedPassword(s.dir)
		if err != nil {
			return err
		}
		fbW, _ := c.size()
		el = newPointMap(st.Displays, fbW).element(helperElement{ID: "window " + strconv.Itoa(prompt.Number),
			Role: "AXWindow", Enabled: true, X: prompt.X, Y: prompt.Y, W: prompt.W, H: prompt.H, App: prompt.Owner})
		if err := s.settleSharing(ctx, uid, c); err != nil {
			return err
		}
		front, err := s.bringForward(ctx, uid, prompt)
		if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		if !front {
			return &codeError{"failed", "The password prompt isn't the app in front, so nothing was typed."}
		}
		// Typing and the wait leave time to empty the field should they run out.
		tctx, cancel := s.typingTime(ctx)
		defer cancel()
		if typed, err := s.typeIntoPrompt(tctx, c, password, t); err != nil {
			return s.promptTypingFailed(ctx, c, t, typed, err)
		}
		if s.windowGone(tctx, uid, prompt, s.promptWait) {
			return nil
		}
		// Still there: the field is emptied, but only while the prompt is in
		// front and its password field has the keyboard (else the keys would
		// go elsewhere).
		if !s.clearField(ctx, c, t, clearKeys) {
			return &codeError{"failed", "The password prompt is still on the screen after typing the password, but its field no longer has the keyboard, so Whombat left it alone."}
		}
		return &codeError{"failed", "The password prompt is still there after typing the password: the Mac refused it. Whombat emptied the field it typed into."}
	})
	if err != nil {
		return proto.ScreenResponse{}, err
	}
	s.log.Info("screen: typed the password into a prompt without Accessibility", "app", prompt.BundleID)
	return proto.ScreenResponse{Element: &el}, nil
}
