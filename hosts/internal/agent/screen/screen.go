// Package screen is the Mac's screen for Whombat's agent: it signs in to the
// Mac's own Screen Sharing (127.0.0.1:5900, Apple's sign-in with the screen
// account kept in screen.toml) to look, click and type, unlocks the lock
// screen, finds buttons by name through Whombat Helper (a LaunchAgent in the
// person's session), and opens the host's vnc console. It is pure Go and
// runs anywhere; only a Mac has the screen, the helper and ioreg.
package screen

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/rfb"
	"rackoon/internal/proto"
)

// DefaultAddr is the Mac's Screen Sharing, reached over loopback only.
const DefaultAddr = "127.0.0.1:5900"

// Errors the steps map to codes.
var (
	errNoAccount    = errors.New("no screen account")
	errNoScreen     = errors.New("Screen Sharing isn't answering")
	errSignInFailed = errors.New("the Mac refused the screen account")
	errBusy         = errors.New("another screen step is running")
)

// invalidError is a request the agent refuses (code invalid_request).
type invalidError string

func (e invalidError) Error() string { return string(e) }

// Options configure a Screen; empty fields are the Mac's real places.
type Options struct {
	ConfigDir string // the agent's config folder: screen.toml lives there
	Addr      string // Screen Sharing (DefaultAddr)
	UIRoot    string // the helpers' folders (DefaultUIRoot)
	HelperApp string // Whombat Helper's app bundle (DefaultHelperApp)
	// HelperPlist is the helper's LaunchAgent (DefaultHelperPlist).
	HelperPlist string
	Log         *slog.Logger
}

// Screen runs the screen steps of one Mac. It implements agent.Screen.
type Screen struct {
	dir, addr, helperApp string
	uiRoot               string
	log                  *slog.Logger
	helper               helperClient
	helperPlist          string

	// Replaced in tests.
	consoleUID func() (int, bool)
	sessions   func(context.Context) ([]consoleSession, error)
	verify     func(context.Context, Account) (ok, known bool)
	// processPath is the file a process executes as the kernel knows it
	// (the helper's, a prompt's), procStart when it started.
	processPath func(ctx context.Context, pid int) (string, error)
	procStart   func(ctx context.Context, pid int) (int64, error)
	// codeVerify checks running code (a pid) against a code requirement;
	// appleCode says whether a process runs code Apple signed.
	codeVerify func(ctx context.Context, target, requirement string) error
	appleCode  func(ctx context.Context, pid int) bool
	// rootOnly checks that only root can change a file and its folders.
	rootOnly func(path string) error
	// sharingListener checks what listens on Screen Sharing's port,
	// sharingPeer who took a connection to it: macOS's own Screen Sharing,
	// else errSharingNotApple (nothing listening: errNoScreen).
	sharingListener func(ctx context.Context) error
	sharingPeer     func(ctx context.Context, nc net.Conn) error
	peers           helperPeerCache
	// connRefs lists a process's descriptors of the far end of a connection
	// to a helper socket; acceptWait is how long the helper may take to
	// accept one.
	connRefs   func(c *net.UnixConn, pid int) ([]sockRef, error)
	acceptWait time.Duration
	// peerLog keeps a refused helper's warning to once a minute per reason.
	peerLog struct {
		mu   sync.Mutex
		last string
		at   time.Time
	}
	// isAdmin says whether a Mac user is an administrator, paneSheet
	// whether System Settings shows a pane's password sheet in uid's
	// session and which processes hold it.
	isAdmin   func(ctx context.Context, user string) (bool, error)
	paneSheet func(ctx context.Context, uid int, pane string) (paneSheet, error)
	now       func() time.Time
	helperSys helperSystem // installing the helper: macOS's tools
	// The owner of the helper's app and LaunchAgent (root:wheel).
	ownerUID, ownerGID int

	stepTimeout  time.Duration // every step's bound
	busyWait     time.Duration // how long a step waits for another to finish
	wakeWait     time.Duration // unlock: how long the lock is watched after waking the display
	wakeSettle   time.Duration // unlock: then, for the lock screen to take input
	escGap       time.Duration // unlock: after Escape empties the password field
	settle       time.Duration // unlock: how long the screen may take to open after the password
	pollGap      time.Duration // unlock: between looks at the lock
	idleClose    time.Duration // the kept connection closes when unused this long
	unlockHold   time.Duration // or this long when it unlocked the screen (its end locks it again)
	signInEvery  time.Duration // re-check a working sign-in
	signInRetry  time.Duration // re-check a refused one
	helperEvery  time.Duration // ask the helper at most this often for Status
	sharingEvery time.Duration // probe Screen Sharing at most this often
	keyGap       time.Duration // between key events
	charGap      time.Duration // between typed characters and key chords
	clickGap     time.Duration // between a press and its release, and between clicks
	answerWithin time.Duration // a new helper must answer at the screen within this
	answerPoll   time.Duration // how often it is asked meanwhile
	retryGap     time.Duration // between tries to load the helper in a session

	// password and unlock's bound: a password checked key by key takes
	// longer (TestPasswordTime), and clearReserve of it is kept to empty
	// the field should typing run out of time.
	secretTimeout time.Duration
	clearReserve  time.Duration

	// password: how long a prompt may take to go (without Accessibility);
	// before keys go to a prompt, the Screen Sharing session's least age,
	// the least time after its Shift tap and the most it waits after that
	// tap for Screen Sharing's bubble to settle; the pause after the letter
	// macOS may drop.
	promptWait       time.Duration
	sharingSettle    time.Duration
	inputSettle      time.Duration
	sharingSettleMax time.Duration
	leadSettle       time.Duration

	installMu sync.Mutex // one helper install at a time

	steps chan struct{} // one Screen Sharing step at a time

	connMu   sync.Mutex
	conn     *rfbConn
	connKey  [32]byte // the account the connection signed in with
	connUsed time.Time
	// connHolds: the connection unlocked the screen, and macOS locks it
	// again when the connection ends.
	connHolds bool

	mu          sync.Mutex
	sharing     bool
	sharingAt   time.Time
	signIn      string // "ok" | "failed" | ""
	signInAt    time.Time
	signInUser  string
	checkedAt   time.Time // the directory's last check of the password
	fbW, fbH    int
	locked      *bool
	helperInfo  proto.MacHelper // Version, Accessibility, User of the last answer
	displays    []helperDisplay
	helperAt    time.Time // the last answer
	helperTried time.Time
	bundleVer   string
	bundleAt    time.Time
	refreshing  atomic.Bool
}

// New returns the screen of this Mac.
func New(o Options) *Screen {
	if o.Addr == "" {
		o.Addr = DefaultAddr
	}
	if o.UIRoot == "" {
		o.UIRoot = DefaultUIRoot
	}
	if o.HelperApp == "" {
		o.HelperApp = DefaultHelperApp
	}
	if o.HelperPlist == "" {
		o.HelperPlist = DefaultHelperPlist
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	apple := &appleCode{}
	s := &Screen{
		dir: o.ConfigDir, addr: o.Addr, uiRoot: o.UIRoot, helperApp: o.HelperApp, log: o.Log,
		helper: helperClient{root: o.UIRoot}, helperPlist: o.HelperPlist,
		consoleUID: consoleUID, sessions: ioregSessions, verify: verifyAccount, now: time.Now, processPath: procExe,
		procStart: procStart, codeVerify: codesignVerify, appleCode: apple.signed,
		rootOnly:        func(path string) error { return agent.RootOnly(path, 0, "/") },
		sharingListener: func(ctx context.Context) error { return macSharingListener(ctx, o.Addr, apple.signed) },
		sharingPeer:     func(ctx context.Context, nc net.Conn) error { return macSharingPeer(ctx, nc, apple.signed) },
		connRefs:        connRefs, acceptWait: time.Second,
		isAdmin: dsAdmin, promptWait: 5 * time.Second, sharingSettle: 1500 * time.Millisecond,
		inputSettle: time.Second, sharingSettleMax: 3 * time.Second, leadSettle: 1200 * time.Millisecond,
		helperSys: macHelperSystem{}, answerWithin: 2 * time.Minute, answerPoll: 2 * time.Second, retryGap: time.Second,
		stepTimeout: proto.ScreenStepLimit(proto.ScreenLook), secretTimeout: proto.ScreenStepLimit(proto.ScreenPassword),
		clearReserve: 5 * time.Second, busyWait: 10 * time.Second,
		wakeWait: 3 * time.Second, wakeSettle: 500 * time.Millisecond, escGap: 400 * time.Millisecond,
		settle: 6 * time.Second, pollGap: 250 * time.Millisecond,
		idleClose: time.Minute, unlockHold: 5 * time.Minute, signInEvery: 10 * time.Minute, signInRetry: time.Hour,
		helperEvery: 10 * time.Second, sharingEvery: time.Minute,
		keyGap: 8 * time.Millisecond, charGap: 25 * time.Millisecond, clickGap: 40 * time.Millisecond,
		steps: make(chan struct{}, 1),
	}
	s.helper.check = s.checkHelperPeer
	s.paneSheet = s.paneSheetOf
	return s
}

// Start keeps the helper's folder ready for the user at the screen and
// closes an idle Screen Sharing connection, every 10 s, for the life of the
// process.
func (s *Screen) Start() {
	go func() {
		var lastErr string
		for {
			if uid, ok := s.consoleUID(); ok {
				if err := ensureUIDirs(s.uiRoot, uid); err != nil && err.Error() != lastErr {
					s.log.Warn("screen: can't prepare the helper's folder", "uid", uid, "err", err)
					lastErr = err.Error()
				} else if err == nil {
					lastErr = ""
				}
			}
			s.closeIdle()
			time.Sleep(10 * time.Second)
		}
	}()
}

// ---- the package's default screen (cmd/whombat-agent sets it on a Mac) ----

var defaultScreen atomic.Pointer[Screen]

// SetDefault makes s the screen Console, Thumbnail and Status use.
func SetDefault(s *Screen) { defaultScreen.Store(s) }

const unsupportedMsg = "This server has no screen the agent can reach (not a Mac)."

// Console opens the Mac's screen as the host's vnc console: the agent signs
// in to Screen Sharing with the screen account and relays the session to the
// browser, which sees security None.
func Console(ctx context.Context) (agent.ConsoleSession, proto.ConsoleResponse) {
	s := defaultScreen.Load()
	if s == nil {
		return nil, proto.ConsoleResponse{Code: agent.CodeUnsupported, Message: unsupportedMsg}
	}
	return s.Console(ctx)
}

// Thumbnail is a still picture of the Mac's screen (the host's thumbnail
// and screenshot): MaxWidth and Format ("jpeg" default, "png") as asked.
func Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
	s := defaultScreen.Load()
	if s == nil {
		return proto.ThumbnailResponse{Code: agent.CodeUnsupported, Message: unsupportedMsg}
	}
	return s.Thumbnail(ctx, req)
}

// Status is the screen and helper part of the Mac's report: cached, it asks
// the helper at most every 10 s and checks the sign-in at most every 10
// minutes, in the background.
func Status(ctx context.Context) (proto.MacScreen, proto.MacHelper) {
	s := defaultScreen.Load()
	if s == nil {
		return proto.MacScreen{}, proto.MacHelper{}
	}
	return s.Status(ctx)
}

// ---- status ----

// Status returns the cached state and refreshes it in the background when
// it is due.
func (s *Screen) Status(ctx context.Context) (proto.MacScreen, proto.MacHelper) {
	s.mu.Lock()
	due := s.now().Sub(s.helperTried) >= s.helperEvery
	s.mu.Unlock()
	if due && s.refreshing.CompareAndSwap(false, true) {
		go func() {
			defer s.refreshing.Store(false)
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			defer cancel()
			s.refresh(rctx, false)
		}()
	}
	return s.snapshot()
}

// snapshot is the cached state as the report carries it.
func (s *Screen) snapshot() (proto.MacScreen, proto.MacHelper) {
	acct, _ := ReadAccount(s.dir)
	installed, version := s.bundle()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := proto.MacScreen{Sharing: s.sharing, Account: acct.User, Width: s.fbW, Height: s.fbH}
	if acct.User != "" && acct.User == s.signInUser {
		st.SignIn, st.SignInAt = s.signIn, s.signInAt
	}
	if s.locked != nil {
		v := *s.locked
		st.Locked = &v
	}
	h := proto.MacHelper{Installed: installed, Version: version}
	if !s.helperAt.IsZero() && s.now().Sub(s.helperAt) < time.Minute {
		h.Running = true
		h.Installed = true // it answers, so it is there
		h.User = s.helperInfo.User
		if s.helperInfo.Version != "" {
			h.Version = s.helperInfo.Version
		}
		if s.helperInfo.Accessibility != nil {
			v := *s.helperInfo.Accessibility
			h.Accessibility = &v
		}
	}
	return st, h
}

// bundle says whether the helper's app is installed and its version (from
// its Info.plist, read at most once a minute).
func (s *Screen) bundle() (bool, string) {
	fi, err := os.Stat(s.helperApp)
	if err != nil || !fi.IsDir() {
		return false, ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.now().Sub(s.bundleAt) >= time.Minute {
		s.bundleAt = s.now()
		s.bundleVer = ""
		if b, err := os.ReadFile(filepath.Join(s.helperApp, "Contents", "Info.plist")); err == nil {
			s.bundleVer = bundleVersion(b)
		}
	}
	return true, s.bundleVer
}

// refresh asks the helper (or ioreg) whether the screen is locked, probes
// Screen Sharing and re-checks the sign-in when due; force skips the
// helper's and Screen Sharing's intervals.
func (s *Screen) refresh(ctx context.Context, force bool) {
	now := s.now()
	s.mu.Lock()
	askHelper := force || now.Sub(s.helperTried) >= s.helperEvery
	if askHelper {
		s.helperTried = now
	}
	probe := force || now.Sub(s.sharingAt) >= s.sharingEvery
	s.mu.Unlock()

	if askHelper {
		var answer *helperAnswer
		if uid, ok := s.consoleUID(); ok {
			hctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			a, err := s.helper.call(hctx, uid, map[string]any{"op": "status"})
			cancel()
			if err == nil && a.OK {
				s.noteHelper(a)
				answer = a
			}
		}
		// The Mac's session list says whether the screen is locked; the
		// helper's own view stands in only when it can't be read.
		if sessions, err := s.sessions(ctx); err == nil {
			locked, _ := lockState(sessions)
			s.keepLock(locked, true)
		} else if answer != nil {
			s.keepLock(answer.Locked, true)
		} else {
			s.keepLock(false, false)
		}
	}
	if probe {
		// Who listens on the port, not whether something does: a program
		// listening there while Screen Sharing is off isn't Screen Sharing.
		err := s.sharingListener(ctx)
		if errors.Is(err, errSharingNotApple) {
			s.log.Warn("screen: something other than macOS's Screen Sharing listens on its port", "err", err)
		}
		s.markSharing(err == nil)
	}
	s.checkSignInIfDue(ctx)
}

// checkSignInIfDue checks the stored account's password when it changed,
// every 10 minutes while it works and every hour while it is refused, with
// the Mac's directory (verifyAccount), never with Screen Sharing: a sign-in
// there counts as someone using the Mac (screensharingd declares user
// activity), so on a timer it would keep the display awake and the screen
// from locking. A wrong password shows as "failed"; a right one keeps a
// refusal by Screen Sharing (the user may not be allowed in), which only
// a sign-in clears.
func (s *Screen) checkSignInIfDue(ctx context.Context) {
	acct, err := ReadAccount(s.dir)
	if err != nil {
		return
	}
	s.mu.Lock()
	last := s.signInAt
	if s.checkedAt.After(last) {
		last = s.checkedAt
	}
	age := s.now().Sub(last)
	state := s.signIn
	if s.signInUser != acct.User {
		state = ""
	}
	due := state == "" || (state == "ok" && age >= s.signInEvery) || (state == "failed" && age >= s.signInRetry)
	s.mu.Unlock()
	if !due {
		return
	}
	ok, known := s.verify(ctx, acct)
	switch {
	case !known:
	case !ok:
		s.noteSignIn(acct.User, false, 0, 0)
	case state != "failed":
		s.noteSignIn(acct.User, true, 0, 0)
	default: // still Screen Sharing's own refusal
	}
	s.mu.Lock()
	s.checkedAt = s.now()
	s.mu.Unlock()
}

func (s *Screen) noteSignIn(user string, ok bool, w, h int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signInUser, s.signInAt = user, s.now()
	s.signIn = "failed"
	if ok {
		s.signIn = "ok"
	}
	if w > 0 && h > 0 {
		s.fbW, s.fbH = w, h
	}
}

// noteHelper keeps the helper's answer for the report; the lock state comes
// from the session list (keepLock).
func (s *Screen) noteHelper(a *helperAnswer) {
	ax := a.AX
	s.mu.Lock()
	defer s.mu.Unlock()
	s.helperAt = s.now()
	s.helperInfo = proto.MacHelper{Version: clip(a.Version, 64), User: clip(a.User, 64), Accessibility: &ax}
	s.displays = a.Displays
}

func (s *Screen) markSharing(on bool) {
	s.mu.Lock()
	s.sharing, s.sharingAt = on, s.now()
	s.mu.Unlock()
}

func (s *Screen) fbSize() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fbW, s.fbH
}

// ---- the kept Screen Sharing connection ----

func accountKey(a Account) [32]byte {
	return sha256.Sum256([]byte(a.User + "\x00" + a.Password))
}

// connection returns the kept connection, signing in again when it is gone
// or the account changed.
func (s *Screen) connection(ctx context.Context) (*rfbConn, error) {
	acct, err := ReadAccount(s.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNoAccount
	}
	if err != nil {
		return nil, err
	}
	key := accountKey(acct)
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.conn != nil && s.conn.alive() && s.connKey == key {
		s.connUsed = s.now()
		return s.conn, nil
	}
	if s.conn != nil {
		s.conn.close()
		s.conn = nil
	}
	s.connHolds = false
	s.mu.Lock()
	refused := s.signIn == "failed" && s.signInUser == acct.User && s.now().Sub(s.signInAt) < time.Minute
	s.mu.Unlock()
	if refused {
		// Screen Sharing logs every refusal (and a Mac may lock the
		// account after a few): steps wait a minute before trying again.
		return nil, errSignInFailed
	}
	c, err := s.dialRFB(ctx, acct)
	if err != nil {
		return nil, s.signInError(acct.User, err)
	}
	w, h := c.size()
	s.noteSignIn(acct.User, true, w, h)
	s.markSharing(true)
	s.conn, s.connKey, s.connUsed = c, key, s.now()
	return c, nil
}

// signInError notes a failed sign-in and returns the error to answer.
func (s *Screen) signInError(user string, err error) error {
	switch {
	case errors.Is(err, rfb.ErrAuth):
		s.noteSignIn(user, false, 0, 0)
		return errSignInFailed
	case errors.Is(err, errNoScreen), errors.Is(err, errSharingNotApple):
		s.markSharing(false)
		if errors.Is(err, errSharingNotApple) {
			return errSharingNotApple
		}
		return errNoScreen
	}
	return err
}

// dropConnection closes the kept connection; it says whether there was one.
func (s *Screen) dropConnection() bool {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	had := s.conn != nil
	if had {
		s.conn.close()
		s.conn = nil
	}
	s.connHolds = false
	return had
}

// holdConnection marks c, the kept connection, as the one that unlocked
// the screen: it stays open up to unlockHold without steps.
func (s *Screen) holdConnection(c *rfbConn) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.conn == c {
		s.connHolds = true
		s.connUsed = s.now()
	}
}

// touchConnection counts a step that didn't need Screen Sharing (one of the
// helper's) as using the kept connection.
func (s *Screen) touchConnection() {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.conn != nil {
		s.connUsed = s.now()
	}
}

func (s *Screen) closeIdle() {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	idle := s.idleClose
	if s.connHolds {
		idle = s.unlockHold
	}
	if s.conn != nil && (!s.conn.alive() || s.now().Sub(s.connUsed) >= idle) {
		s.conn.close()
		s.conn = nil
		s.connHolds = false
	}
}

// exclusive runs fn as the one screen step running: Screen Sharing steps,
// unlocks and account changes wait for each other (up to busyWait, then
// errBusy), so none drops or replaces the connection under another.
func (s *Screen) exclusive(ctx context.Context, fn func() error) error {
	wctx, cancel := context.WithTimeout(ctx, s.busyWait)
	select {
	case s.steps <- struct{}{}:
		cancel()
	case <-wctx.Done():
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errBusy
	}
	defer func() { <-s.steps }()
	return fn()
}

// step runs fn with the kept connection, one step at a time.
func (s *Screen) step(ctx context.Context, fn func(c *rfbConn) error) error {
	return s.exclusive(ctx, func() error { return s.withConn(ctx, fn) })
}

// withConn runs fn with the kept connection; the caller runs exclusively.
func (s *Screen) withConn(ctx context.Context, fn func(c *rfbConn) error) error {
	c, err := s.connection(ctx)
	if err != nil {
		return err
	}
	err = fn(c)
	s.connMu.Lock()
	s.connUsed = s.now()
	s.connMu.Unlock()
	return err
}

func pause(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ---- console and thumbnail ----

// Console signs in to Screen Sharing on a connection of its own and relays
// it to the browser.
func (s *Screen) Console(ctx context.Context) (agent.ConsoleSession, proto.ConsoleResponse) {
	acct, err := ReadAccount(s.dir)
	if err != nil {
		code, msg := errorCode(errNoAccount)
		if !errors.Is(err, fs.ErrNotExist) {
			code, msg = "failed", err.Error()
		}
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	nc, rw, info, err := s.handshake(ctx, acct)
	if err != nil {
		code, msg := errorCode(s.signInError(acct.User, err))
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	nc.SetDeadline(time.Time{})
	s.noteSignIn(acct.User, true, info.Width, info.Height)
	s.markSharing(true)
	s.log.Info("screen: console signed in to Screen Sharing", "user", acct.User, "resolution", info.Resolution())
	return rfb.NewSession(rw, info, nil), proto.ConsoleResponse{OK: true, Resolution: info.Resolution()}
}

// Thumbnail takes a still picture through the kept connection.
func (s *Screen) Thumbnail(ctx context.Context, req proto.ThumbnailRequest) proto.ThumbnailResponse {
	format, ok := imageFormat(req.Format, "jpeg")
	if !ok || req.MaxWidth < 0 {
		return proto.ThumbnailResponse{Code: "invalid_request", Message: "format is jpeg or png, max_w 0 or more"}
	}
	ctx, cancel := context.WithTimeout(ctx, s.stepTimeout)
	defer cancel()
	data, w, h, _, _, err := s.look(ctx, req.MaxWidth, format)
	if err != nil {
		code, msg := errorCode(err)
		return proto.ThumbnailResponse{Code: code, Message: msg}
	}
	return proto.ThumbnailResponse{Image: data, Width: w, Height: h}
}

// handshake dials Screen Sharing and signs in (for the console: the
// browser chooses its own pixel format and encodings). Whatever answers on
// its port gets the account, and later the password typed as keys, so it
// must be macOS's own: before the agent sends anything, the process that
// took the connection must be Apple's Screen Sharing (sharingPeer), and only
// Apple's sign-in (type 30) is accepted, never None or VNC authentication.
func (s *Screen) handshake(ctx context.Context, acct Account) (net.Conn, io.ReadWriteCloser, *rfb.Info, error) {
	var d net.Dialer
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	nc, err := d.DialContext(dctx, "tcp", s.addr)
	cancel()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: %v", errNoScreen, err)
	}
	deadline := time.Now().Add(20 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	nc.SetDeadline(deadline)
	greeted := func() error {
		if err := s.sharingPeer(ctx, nc); err != nil {
			if !errors.Is(err, errSharingNotApple) {
				err = fmt.Errorf("%w (can't tell who took the connection: %v)", errSharingNotApple, err)
			}
			return err
		}
		return nil
	}
	rw, info, err := rfb.ClientHandshake(nc, rfb.Options{User: acct.User, Password: acct.Password, Greeted: greeted})
	if err != nil {
		nc.Close()
		if errors.Is(err, rfb.ErrNotApple) {
			err = fmt.Errorf("%w (%v)", errSharingNotApple, err)
		}
		if errors.Is(err, errSharingNotApple) {
			s.log.Warn("screen: refused to sign in to what answers on Screen Sharing's port", "addr", s.addr, "err", err)
		}
		return nil, nil, nil, err
	}
	return nc, rw, info, nil
}

// errorCode maps an error to the screen codes and plain words.
func errorCode(err error) (code, msg string) {
	var inv invalidError
	var ce *codeError
	var refusal *helperRefusal
	switch {
	case errors.As(err, &inv):
		return "invalid_request", string(inv)
	case errors.As(err, &ce):
		return ce.code, ce.msg
	case errors.Is(err, errNoAccount):
		return proto.ScreenCodeNoAccount, "No Mac account is set for the screen yet. Set the Mac's password on its page."
	case errors.Is(err, errSharingNotApple):
		return proto.ScreenCodeNoScreen, "Something other than macOS's Screen Sharing answers on its port, so Whombat won't sign in there. Turn Screen Sharing on in System Settings → General → Sharing, or stop the program that uses its port."
	case errors.Is(err, errNoScreen):
		return proto.ScreenCodeNoScreen, "Screen Sharing isn't answering on this Mac. Turn it on in System Settings → General → Sharing."
	case errors.Is(err, errSignInFailed):
		return proto.ScreenCodeSignInFailed, "The Mac refused the screen account's password. Set it again on the Mac's page."
	case errors.Is(err, errBusy):
		return "busy", "Another screen step is still running. Try again in a moment."
	case errors.Is(err, errHelperBusy):
		return "busy", "Whombat Helper is busy; try again."
	case errors.As(err, &refusal) && refusal.impostor:
		return proto.ScreenCodeNoHelper, "Something other than the installed Whombat Helper answered on its socket at the Mac's screen, so Whombat sent it nothing."
	case errors.As(err, &refusal):
		return proto.ScreenCodeNoHelper, "Whombat couldn't check that the installed Whombat Helper answers at the Mac's screen, so it sent it nothing."
	case errors.Is(err, errNoHelper):
		return proto.ScreenCodeNoHelper, "Whombat Helper isn't running at the Mac's screen."
	case errors.Is(err, context.DeadlineExceeded):
		return agent.CodeTimeout, "The Mac's screen didn't answer in time."
	}
	return "failed", clip(err.Error(), 500)
}
