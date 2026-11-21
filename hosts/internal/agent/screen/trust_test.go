package screen

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// The helper is trusted only as the installed app's own process: its
// executable as the kernel knows it, a place only root can change, its
// running code the installed app's (codesign by pid, remembered per
// process), and it alone holding the other end of the connection.
func TestHelperPeer(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	fs := &fakeHelperSys{t: t}
	s.helperSys = fs
	writeFakeApp(t, s.helperApp, fakeZip{Version: "1.0.3"})
	uid, me := os.Getuid(), os.Getpid()
	exe := map[int]string{me: s.helperExe()}
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if p, ok := exe[pid]; ok {
			return p, nil
		}
		return "", errors.New("no such process")
	}
	var verified []string
	verifyErr := error(nil)
	s.codeVerify = func(_ context.Context, target, req string) error {
		verified = append(verified, target+" "+req)
		return verifyErr
	}
	rootErr := error(nil)
	s.rootOnly = func(string) error { return rootErr }
	// The kernel's view of who holds the far end of the connection: here
	// the helper (the test process) with one descriptor of its own.
	refs, refsErr := []sockRef{{fd: 7}}, error(nil)
	var holderAsked []int
	s.connRefs = func(_ *net.UnixConn, pid int) ([]sockRef, error) {
		holderAsked = append(holderAsked, pid)
		return refs, refsErr
	}
	s.acceptWait = 30 * time.Millisecond
	var logged strings.Builder
	s.log = slog.New(slog.NewTextHandler(&logged, nil))
	s.helper.check = s.checkHelperPeer
	h := newFakeHelper(t, s.uiRoot, uid, fakeHelperAnswers(&helperState{ax: true}))
	status := func() error {
		_, err := s.helper.call(context.Background(), uid, map[string]any{"op": "status"})
		return err
	}

	if err := status(); err != nil {
		t.Fatalf("the installed helper: %v", err)
	}
	if len(verified) != 1 || !strings.HasPrefix(verified[0], strconv.Itoa(me)+" ") || !strings.Contains(verified[0], "1.0.3") {
		t.Fatalf("verified %q", verified)
	}
	if len(holderAsked) != 1 || holderAsked[0] != me {
		t.Fatalf("asked who holds the connection: %v", holderAsked)
	}
	// Remembered for the same process; who holds the connection is asked
	// every time.
	if err := status(); err != nil || len(verified) != 1 || len(holderAsked) != 2 {
		t.Fatalf("second call: %v, verified %d times, holders asked %d times", err, len(verified), len(holderAsked))
	}
	// A new build installed: its requirement, checked again.
	writeFakeApp(t, s.helperApp, fakeZip{Version: "1.0.4"})
	later := time.Now().Add(time.Hour)
	os.Chtimes(s.helperExe(), later, later)
	if err := status(); err != nil || len(verified) != 2 || !strings.Contains(verified[1], "1.0.4") {
		t.Fatalf("new build: %v %q", err, verified)
	}

	refused := func(what string, isImpostor bool) {
		t.Helper()
		s.peers = helperPeerCache{}
		before := h.count("status")
		err := status()
		var r *helperRefusal
		if !errors.Is(err, errNoHelper) || !errors.As(err, &r) || r.impostor != isImpostor {
			t.Fatalf("%s: %v", what, err)
		}
		if h.count("status") != before {
			t.Fatalf("%s: the request was sent", what)
		}
	}
	// Code that isn't the installed app's.
	verifyErr = errors.New("test-requirement: code failed to satisfy specified code requirement(s)")
	refused("other code", true)
	verifyErr = nil
	// Another program listening there.
	exe[me] = "/Users/alex/Library/fake/WhombatHelper"
	refused("another program", true)
	exe[me] = s.helperExe()
	// The installed app where someone but root can change it.
	rootErr = errors.New("/Library/Application Support/Whombat belongs to uid 501")
	refused("not root's", false)
	rootErr = nil
	// The requirement can't be read.
	fs.reqErr = errors.New("codesign: no signature")
	refused("no requirement", false)
	fs.reqErr = nil

	// A program listened on the socket, forked a child that keeps it and
	// then ran the installed helper itself: the listener's pid passes every
	// check above, but the child takes the connection. The helper's process
	// never holds it: refused, nothing sent.
	refs = nil
	refused("taken by another process", true)
	// The helper's process holds it, but its open file has another
	// reference (a child's copy, a message in flight, a file port).
	refs = []sockRef{{fd: 7, shared: true}}
	refused("shared", true)
	// Held twice, or as standard input or output.
	refs = []sockRef{{fd: 7}, {fd: 9}}
	refused("held twice", true)
	refs = []sockRef{{fd: 1}}
	refused("standard output", true)
	// The kernel can't say.
	refs, refsErr = nil, errors.New("can't list the descriptors of process 1")
	refused("can't tell", false)
	refs, refsErr = []sockRef{{fd: 7}}, nil
	// The process went away and its pid was used again while it was checked.
	starts := 0
	s.procStart = func(context.Context, int) (int64, error) { starts++; return int64(starts), nil }
	refused("pid used again", true)
	s.procStart = func(context.Context, int) (int64, error) { return 1, nil }
	// The process can't be told.
	delete(exe, me)
	refused("unknown process", false)
	exe[me] = s.helperExe()

	// Refusals are warnings with the reason, each reason once a minute.
	if n := strings.Count(logged.String(), "level=WARN"); n != 11 {
		t.Fatalf("logged %d warnings:\n%s", n, logged.String())
	}
	if !strings.Contains(logged.String(), "didn't take the connection") || !strings.Contains(logged.String(), "something other than the installed Whombat Helper") {
		t.Fatalf("log:\n%s", logged.String())
	}
	refs = nil
	refused("taken again", true)
	refused("and again", true)
	if n := strings.Count(logged.String(), "level=WARN"); n != 12 {
		t.Fatalf("the same reason logged again within a minute (%d warnings)", n)
	}
	// The step's answer says why.
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps})
	if r.Code != proto.ScreenCodeNoHelper || !strings.Contains(r.Message, "Something other than the installed Whombat Helper") {
		t.Fatalf("ui apps: %+v", r)
	}
	refs, refsErr = nil, errors.New("no libproc")
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != proto.ScreenCodeNoHelper || !strings.Contains(r.Message, "couldn't check") {
		t.Fatalf("ui apps, can't check: %+v", r)
	}
}

// Apple's signature is remembered per process and the file it runs: a
// process that runs another file (exec keeps its pid and start time) is
// checked again, and an answer given while it changed isn't kept.
func TestAppleCodeCache(t *testing.T) {
	exe, start := "/usr/libexec/apple", int64(5)
	verified := 0
	signedBy := map[string]bool{"/usr/libexec/apple": true}
	var during func()
	a := &appleCode{
		start: func(context.Context, int) (int64, error) { return start, nil },
		exe:   func(context.Context, int) (string, error) { return exe, nil },
		verify: func(context.Context, string, string) error {
			verified++
			e := exe
			if during != nil {
				during()
			}
			if !signedBy[e] {
				return errors.New("not Apple's")
			}
			return nil
		},
	}
	ctx := context.Background()
	if !a.signed(ctx, 42) || !a.signed(ctx, 42) || verified != 1 {
		t.Fatalf("Apple's: verified %d times", verified)
	}
	exe = "/Users/alex/evil"
	if a.signed(ctx, 42) || verified != 2 {
		t.Fatalf("after exec: verified %d times", verified)
	}
	// It runs Apple's file again only once the check is over: not kept.
	exe = "/usr/libexec/other"
	signedBy[exe] = true
	during = func() { exe = "/Users/alex/evil" }
	if a.signed(ctx, 42) {
		t.Fatal("an answer for a process that changed meanwhile")
	}
	during = nil
	exe = "/usr/libexec/apple"
	start = 6 // another process with the same pid
	if !a.signed(ctx, 42) || verified != 4 {
		t.Fatalf("new process: verified %d times", verified)
	}
}

// Screen Sharing's processes count by root, the file the kernel says they
// run and Apple's signature of the running code.
func TestSharingProcess(t *testing.T) {
	ctx := context.Background()
	exes := map[int]string{1: launchdPath, 300: screensharingdPath, 301: "/Users/alex/screensharingd"}
	exeOf := func(_ context.Context, pid int) (string, error) { return exes[pid], nil }
	apple := map[int]bool{1: true, 300: true, 301: true}
	signed := func(_ context.Context, pid int) bool { return apple[pid] }
	for _, c := range []struct {
		pid, uid int
		want     bool
	}{{1, 0, true}, {300, 0, true}, {300, 501, false}, {301, 0, false}} {
		if got := sharingProcess(ctx, c.pid, c.uid, exeOf, signed); got != c.want {
			t.Fatalf("pid %d uid %d: %v", c.pid, c.uid, got)
		}
	}
	apple[300] = false
	if sharingProcess(ctx, 300, 0, exeOf, signed) {
		t.Fatal("screensharingd's path without Apple's signature")
	}
}

func TestRootOnly(t *testing.T) {
	top := shortTempDir(t)
	os.Chmod(top, 0o755)
	dir := filepath.Join(top, "Whombat", "bin")
	os.MkdirAll(dir, 0o755)
	file := filepath.Join(dir, "whombat-agent")
	os.WriteFile(file, []byte("x"), 0o755)
	me := os.Getuid()
	if err := agent.RootOnly(file, me, top); err != nil {
		t.Fatal(err)
	}
	os.Chmod(filepath.Join(top, "Whombat"), 0o775)
	if err := agent.RootOnly(file, me, top); err == nil || !strings.Contains(err.Error(), "changed by others") {
		t.Fatalf("group-writable folder: %v", err)
	}
	os.Chmod(filepath.Join(top, "Whombat"), 0o755)
	os.Chmod(file, 0o757)
	if err := agent.RootOnly(file, me, top); err == nil {
		t.Fatal("a file others can write")
	}
	os.Chmod(file, 0o755)
	if err := agent.RootOnly(file, me+1, top); err == nil && me != 0 {
		t.Fatal("someone else's file")
	}
	link := filepath.Join(dir, "link")
	os.Symlink(file, link)
	if err := agent.RootOnly(link, me, top); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("a link: %v", err)
	}
}

func TestParseLsof(t *testing.T) {
	// `lsof -nP -iTCP:5900 -F pun` on macOS 27 while a viewer is connected
	// (shortened): launchd holds the port, screensharingd the connection.
	out := "p1\nu0\nf15\nn*:5900\nTST=LISTEN\nTQR=0\nf16\nn*:5900\nTST=LISTEN\np75689\nu0\nf3\nn*:5900\nTST=LISTEN\n" +
		"f7\nn127.0.0.1:5900->127.0.0.1:57320\nTST=ESTABLISHED\np75688\nu501\nf3\nn127.0.0.1:57320->127.0.0.1:5900\nTST=ESTABLISHED\n"
	got := parseLsof(out)
	if len(got) != 5 || got[0] != (tcpSocket{1, 0, "*:5900", "LISTEN"}) ||
		got[3] != (tcpSocket{75689, 0, "127.0.0.1:5900->127.0.0.1:57320", "ESTABLISHED"}) || got[4].uid != 501 {
		t.Fatalf("%+v", got)
	}
}

// What answers on Screen Sharing's port must be macOS's own: a listener
// that isn't (a program while Screen Sharing is off) gets nothing, the
// status says Screen Sharing is off, and the step answers no_screen.
func TestSharingNotApple(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	if err := writeAccount(s.dir, Account{User: "alex", Password: "pw"}); err != nil {
		t.Fatal(err)
	}
	s.markSharing(true)
	s.sharingPeer = func(context.Context, net.Conn) error {
		return errSharingNotApple
	}
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook})
	if r.Code != proto.ScreenCodeNoScreen || !strings.Contains(r.Message, "other than macOS's Screen Sharing") {
		t.Fatalf("look: %+v", r)
	}
	if n, _ := f.counts(); n != 0 {
		t.Fatal("signed in to it")
	}
	if st, _ := s.snapshot(); st.Sharing {
		t.Fatal("status still says Screen Sharing is on")
	}
	if _, resp := s.Console(context.Background()); resp.Code != proto.ScreenCodeNoScreen {
		t.Fatalf("console: %+v", resp)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenAccountSet, Account: &proto.ScreenAccount{User: "alex", Password: "pw"}})
	if r.Code != proto.ScreenCodeNoScreen {
		t.Fatalf("account.set: %+v", r)
	}
	// Any other error from the check counts as not Apple's.
	s.sharingPeer = func(context.Context, net.Conn) error { return errors.New("lsof: not found") }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook}); r.Code != proto.ScreenCodeNoScreen {
		t.Fatalf("unknown peer: %+v", r)
	}
	// The status probe asks who listens.
	s.sharingPeer = func(context.Context, net.Conn) error { return nil }
	s.sharingListener = func(context.Context) error { return errSharingNotApple }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenStatus}); !r.OK || r.Status.Sharing {
		t.Fatalf("status: %+v", r.Status)
	}
	s.sharingListener = func(context.Context) error { return nil }
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenStatus}); !r.Status.Sharing {
		t.Fatalf("status: %+v", r.Status)
	}
}

// screen.toml: a regular file only its owner reads; a link or a file
// others can read is refused.
func TestReadAccountChecks(t *testing.T) {
	dir := shortTempDir(t)
	if _, err := ReadAccount(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("none: %v", err)
	}
	if err := writeAccount(dir, Account{User: "alex", Password: "pw"}); err != nil {
		t.Fatal(err)
	}
	if a, err := ReadAccount(dir); err != nil || a.User != "alex" {
		t.Fatalf("stored: %+v %v", a, err)
	}
	p := filepath.Join(dir, AccountFileName)
	os.Chmod(p, 0o644)
	if _, err := ReadAccount(dir); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("readable by others: %v", err)
	}
	os.Chmod(p, 0o600)
	other := filepath.Join(shortTempDir(t), "elsewhere.toml")
	os.Rename(p, other)
	os.Symlink(other, p)
	if _, err := ReadAccount(dir); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("a link: %v", err)
	}
	os.Remove(p)
	if err := syscall.Mkfifo(p, 0o600); err == nil {
		if _, err := ReadAccount(dir); err == nil {
			t.Fatal("a pipe")
		}
	}
}

// The helper never writes before it is asked, except its busy answer, which
// comes with a close. Anything waiting on the connection when the checks
// pass was written by whatever held it before them (a program that wrote a
// forged answer and then ran the genuine helper, which inherits the
// connection): refused, nothing sent. A busy helper is busy, not an
// impostor nor one that couldn't be checked.
func TestHelperSpokeFirst(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	s.helperSys = &fakeHelperSys{t: t}
	writeFakeApp(t, s.helperApp, fakeZip{Version: "1.0.5"})
	uid, me := os.Getuid(), os.Getpid()
	s.processPath = func(_ context.Context, pid int) (string, error) {
		if pid == me {
			return s.helperExe(), nil
		}
		return "", errors.New("no such process")
	}
	var logged strings.Builder
	s.log = slog.New(slog.NewTextHandler(&logged, nil))
	s.helper.check = s.checkHelperPeer
	// The far end: what it writes as it accepts, and whether it then closes.
	// The kernel's view of who holds the connection is given only once that
	// is done, so the checks always come after it.
	var mu sync.Mutex
	var first string
	var closeAfter bool
	var refsErr error
	set := func(f string, c bool, e error) {
		mu.Lock()
		first, closeAfter, refsErr = f, c, e
		mu.Unlock()
	}
	written := make(chan struct{}, 1)
	got := make(chan string, 1)
	s.connRefs = func(*net.UnixConn, int) ([]sockRef, error) {
		<-written
		mu.Lock()
		defer mu.Unlock()
		return []sockRef{{fd: 7}}, refsErr
	}
	if err := ensureUIDirs(s.uiRoot, uid); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", s.helper.socket(uid))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			first, closeAfter := first, closeAfter
			mu.Unlock()
			if first != "" {
				c.Write([]byte(first))
			}
			if closeAfter {
				c.Close()
				written <- struct{}{}
				continue
			}
			written <- struct{}{}
			line, _ := bufio.NewReader(c).ReadString('\n')
			got <- line
			if line != "" {
				c.Write([]byte(`{"ok":false,"code":"busy","message":"the helper is busy; try again"}` + "\n"))
			}
			c.Close()
		}
	}()
	call := func() error {
		_, err := s.helper.call(context.Background(), uid, map[string]any{"op": "status"})
		return err
	}

	// A forged answer waiting before the agent asked: refused, nothing sent.
	set(`{"ok":true,"version":"1.0.5","ax":true}`+"\n", false, nil)
	err = call()
	var r *helperRefusal
	if !errors.Is(err, errNoHelper) || !errors.As(err, &r) || !r.impostor || !strings.Contains(err.Error(), "before Whombat asked") {
		t.Fatalf("spoke first: %v", err)
	}
	if line := <-got; line != "" {
		t.Fatalf("sent %q", line)
	}
	if !strings.Contains(logged.String(), "level=WARN") {
		t.Fatalf("no warning:\n%s", logged.String())
	}
	// The helper's busy answer, written as it closes: busy, whether the
	// checks saw it hold the connection or couldn't tell any more; its words
	// before 1.0.5 too.
	for _, c := range []struct {
		name, line string
		refsErr    error
	}{
		{"busy", `{"ok":false,"code":"busy","message":"the helper is busy; try again"}`, nil},
		{"busy, closed before the checks", `{"ok":false,"code":"busy","message":"the helper is busy; try again"}`, errors.New("the connection has no other end")},
		{"busy before 1.0.5", `{"code":"failed","message":"the helper is busy; try again","ok":false}`, errors.New("the connection has no other end")},
	} {
		set(c.line+"\n", true, c.refsErr)
		if err := call(); !errors.Is(err, errHelperBusy) {
			t.Fatalf("%s: %v", c.name, err)
		}
	}
	// Anything else, closed: not busy.
	set(`{"ok":false,"code":"failed","message":"no"}`+"\n", true, errors.New("the connection has no other end"))
	if err := call(); errors.Is(err, errHelperBusy) || !errors.Is(err, errNoHelper) {
		t.Fatalf("closed with another answer: %v", err)
	}
	// Busy as its answer to the request: busy too.
	set("", false, nil)
	if err := call(); !errors.Is(err, errHelperBusy) {
		t.Fatalf("answered busy: %v", err)
	}
	<-got
	// The step says so in plain words.
	set(`{"ok":false,"code":"busy","message":"the helper is busy; try again"}`+"\n", true, nil)
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIApps}); r.Code != "busy" || r.Message != "Whombat Helper is busy; try again." {
		t.Fatalf("ui apps: %+v", r)
	}
}
