package screen

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

// Who is at the other end. A process's name, its argv[0] and an app's
// bundle id are whatever the program chose; the kernel's record of the file
// a process runs (proc_pidpath on a Mac) and its code signature are not. The
// agent trusts the helper's socket, Screen Sharing's port and a password
// prompt only by those.

const (
	codesignPath = "/usr/bin/codesign"
	lsofPath     = "/usr/sbin/lsof"
	// Apple's Screen Sharing: launchd (pid 1) holds its port and starts
	// screensharingd, which takes each connection (seen on macOS 27).
	launchdPath        = "/sbin/launchd"
	screensharingdPath = "/System/Library/CoreServices/RemoteManagement/screensharingd.bundle/Contents/MacOS/screensharingd"
	// macOS's lock screen and login window.
	loginWindowPath = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"
	// appleAnchor: code Apple signed (macOS's own).
	appleAnchor = "anchor apple"
)

// errSharingNotApple: what answers on Screen Sharing's port isn't macOS's
// own Screen Sharing (a program listening there while it is off, or one
// that offers no Apple sign-in).
var errSharingNotApple = errors.New("what answers on Screen Sharing's port isn't macOS's Screen Sharing")

// procExe is the file a running process executes as the kernel knows it
// (proc_pidpath on a Mac, /proc/<pid>/exe on Linux), never its argv[0].
func procExe(ctx context.Context, pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("no process %d", pid)
	}
	exe, err := (&process.Process{Pid: int32(pid)}).ExeWithContext(ctx)
	if err != nil {
		return "", err
	}
	if exe == "" {
		return "", fmt.Errorf("process %d has no executable", pid)
	}
	return exe, nil
}

// procStart is when a process started (milliseconds), which with its pid
// names it: a pid alone may be used again.
func procStart(ctx context.Context, pid int) (int64, error) {
	return (&process.Process{Pid: int32(pid)}).CreateTimeWithContext(ctx)
}

// procUID is the user a process runs as (its real uid).
func procUID(ctx context.Context, pid int) (int, error) {
	uids, err := (&process.Process{Pid: int32(pid)}).UidsWithContext(ctx)
	if err != nil || len(uids) == 0 {
		return -1, fmt.Errorf("process %d: no user: %v", pid, err)
	}
	return int(uids[0]), nil
}

// codesignVerify checks a running process's code (target a pid) or a file
// against a code requirement (`codesign --verify -R=<requirement>`).
func codesignVerify(ctx context.Context, target, requirement string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("not a Mac")
	}
	_, err := runTool(ctx, 10*time.Second, codesignPath, "--verify", "-R="+requirement, target)
	return err
}

// ---- the processes macOS's own prompts belong to ----

// appleCode remembers which processes run code Apple signed, by pid, start
// time and the file the kernel says they run (exec keeps the pid and the
// start time, and Apple's own programs can run others).
type appleCode struct {
	mu sync.Mutex
	ok map[string]bool
	// The kernel's and codesign's answers (tests replace them).
	start  func(ctx context.Context, pid int) (int64, error)
	exe    func(ctx context.Context, pid int) (string, error)
	verify func(ctx context.Context, target, requirement string) error
}

// signed says whether pid runs code Apple signed (`codesign --verify
// -R='anchor apple' <pid>`: the running code, not a file someone could
// swap).
func (a *appleCode) signed(ctx context.Context, pid int) bool {
	startOf, exeOf, verify := a.start, a.exe, a.verify
	if startOf == nil {
		startOf, exeOf, verify = procStart, procExe, codesignVerify
	}
	start, err := startOf(ctx, pid)
	if err != nil {
		return false
	}
	exe, err := exeOf(ctx, pid)
	if err != nil {
		return false
	}
	key := procKey(pid, start, exe)
	a.mu.Lock()
	ok, known := a.ok[key]
	a.mu.Unlock()
	if known {
		return ok
	}
	ok = verify(ctx, strconv.Itoa(pid), appleAnchor) == nil
	// The same process still, running the same file, or the answer isn't
	// kept.
	if now, err := startOf(ctx, pid); err != nil || now != start {
		return false
	}
	if now, err := exeOf(ctx, pid); err != nil || now != exe {
		return false
	}
	a.mu.Lock()
	if a.ok == nil || len(a.ok) > 256 {
		a.ok = map[string]bool{}
	}
	a.ok[key] = ok
	a.mu.Unlock()
	return ok
}

// ---- Screen Sharing's port ----

// lsof runs lsof and returns what it printed on stdout (its warnings go
// to stderr); it exits 1 when nothing matched.
func lsof(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, lsofPath, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	cmd.Dir = "/"
	out, err := cmd.Output()
	return string(out), err
}

// tcpSocket is one TCP socket lsof listed.
type tcpSocket struct {
	pid, uid int
	name     string // "*:5900", "127.0.0.1:5900->127.0.0.1:57320"
	state    string // "LISTEN", "ESTABLISHED"
}

// parseLsof reads `lsof -F pun` with TCP states (lines "p<pid>",
// "u<uid>", "f<fd>", "n<name>", "TST=<state>").
func parseLsof(out string) []tcpSocket {
	var socks []tcpSocket
	pid, uid := -1, -1
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		v := line[1:]
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(v)
			uid = -1
		case 'u':
			uid, _ = strconv.Atoi(v)
		case 'n':
			socks = append(socks, tcpSocket{pid: pid, uid: uid, name: v})
		case 'T':
			if st, ok := strings.CutPrefix(v, "ST="); ok && len(socks) > 0 {
				socks[len(socks)-1].state = st
			}
		}
	}
	return socks
}

// sharingProcess says whether pid is macOS's Screen Sharing: root's
// launchd (pid 1), which holds the port, or screensharingd, by the file
// the kernel says it runs (both on the sealed system volume) and the
// running code's Apple signature (apple, remembered per process).
func sharingProcess(ctx context.Context, pid, uid int, exeOf func(context.Context, int) (string, error), apple func(context.Context, int) bool) bool {
	if uid != 0 {
		return false
	}
	exe, err := exeOf(ctx, pid)
	if err != nil {
		return false
	}
	if !((pid == 1 && exe == launchdPath) || exe == screensharingdPath) {
		return false
	}
	return apple(ctx, pid)
}

// portOf is the port of a "host:port" address.
func portOf(addr string) (int, error) {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(p)
}

// macSharingListener checks what listens on Screen Sharing's port: nothing
// is errNoScreen (it is off), anything but macOS's own Screen Sharing is
// errSharingNotApple. Every listener on the port counts, whatever its
// address.
func macSharingListener(ctx context.Context, addr string, apple func(context.Context, int) bool) error {
	if runtime.GOOS != "darwin" {
		return errors.New("not a Mac")
	}
	port, err := portOf(addr)
	if err != nil {
		return err
	}
	out, err := lsof(ctx, "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-F", "pun")
	socks := parseLsof(out)
	if err != nil && len(socks) == 0 {
		return errNoScreen // lsof exits 1 when nothing matched
	}
	for _, sk := range socks {
		if !sharingProcess(ctx, sk.pid, sk.uid, procExe, apple) {
			return fmt.Errorf("%w (process %d listens on port %d)", errSharingNotApple, sk.pid, port)
		}
	}
	return nil
}

// macSharingPeer checks who took the agent's connection to Screen Sharing,
// once the server sent its greeting (so it has taken it): every process
// holding the other end must be macOS's Screen Sharing.
func macSharingPeer(ctx context.Context, nc net.Conn, apple func(context.Context, int) bool) error {
	if runtime.GOOS != "darwin" {
		return errors.New("not a Mac")
	}
	local, ok1 := nc.LocalAddr().(*net.TCPAddr)
	remote, ok2 := nc.RemoteAddr().(*net.TCPAddr)
	if !ok1 || !ok2 || !remote.IP.IsLoopback() {
		return fmt.Errorf("%w (not a loopback connection)", errSharingNotApple)
	}
	out, _ := lsof(ctx, "-nP", "-iTCP@"+local.String(), "-F", "pun")
	far := net.JoinHostPort(remote.IP.String(), strconv.Itoa(remote.Port)) + "->" + local.String()
	found := 0
	for _, sk := range parseLsof(out) {
		if sk.name != far || sk.pid == os.Getpid() {
			continue
		}
		if !sharingProcess(ctx, sk.pid, sk.uid, procExe, apple) {
			return fmt.Errorf("%w (process %d took the connection)", errSharingNotApple, sk.pid)
		}
		found++
	}
	if found == 0 {
		return fmt.Errorf("%w (no process of its took the connection)", errSharingNotApple)
	}
	return nil
}
