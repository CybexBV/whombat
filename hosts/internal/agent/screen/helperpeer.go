package screen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// The helper's socket is in a folder of the user at the screen, so any of
// their programs could listen there, answer `ax: true` and be sent the
// password with an unlock. Before the agent sends anything on a connection
// (one request each), the process that answers must be the installed Whombat
// Helper: the user at the screen runs it, the kernel says it executes the
// installed app's executable, a file only root can change, its running code
// satisfies that app's designated requirement (an ad hoc build's is its code
// hash), and it alone holds the other end of this connection.
//
// The last part matters because the process macOS names for a connection
// (LOCAL_PEERPID) is the one that made the listening socket, not the one
// that reads: a program can listen on helper.sock, fork a child that keeps
// the socket, then run the genuine installed helper itself. Its pid then
// passes every check above while the child accepts and reads (tried on
// macOS 27). So the agent looks up, in the kernel's table of that process's
// descriptors, the socket at the other end of its own, and requires exactly
// one descriptor of it there, not 0, 1 or 2, whose open file has no other
// reference anywhere (PROC_FP_SHARED clear: no copy in another process,
// none in a message in flight, no file port; tried for each).

// sockRef is one of a process's descriptors of the far end of the agent's
// connection; shared says its open file has other references as well (or
// doesn't lead back to the agent's end).
type sockRef struct {
	fd     int
	shared bool
}

// helperRefusal is why the agent sent nothing on a helper's socket;
// impostor is true when something other than the installed helper answered
// (else the agent couldn't check it).
type helperRefusal struct {
	impostor bool
	reason   string
}

func (e *helperRefusal) Error() string { return e.reason }

func impostor(format string, a ...any) error {
	return &helperRefusal{impostor: true, reason: fmt.Sprintf(format, a...)}
}

func cantCheck(format string, a ...any) error {
	return &helperRefusal{reason: fmt.Sprintf(format, a...)}
}

// helperPeerCache remembers helpers already checked, by pid, start time and
// the file the kernel says they run, for the installed executable as it was
// then (an update makes a new one).
type helperPeerCache struct {
	mu    sync.Mutex
	stamp string // the installed executable: inode, size, time
	req   string // its app's designated requirement
	ok    map[string]bool
}

// helperExe is the installed helper's executable.
func (s *Screen) helperExe() string {
	return filepath.Join(s.helperApp, "Contents", "MacOS", helperExecutable)
}

// fileStamp names a file's current contents for a cache: inode, size and
// modification time.
func fileStamp(path string) (string, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	ino := uint64(0)
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		ino = uint64(st.Ino)
	}
	return fmt.Sprintf("%d/%d/%d", ino, fi.Size(), fi.ModTime().UnixNano()), nil
}

// procKey names a process for a cache: pid, start time and the file the
// kernel says it runs (exec keeps the pid and the start time).
func procKey(pid int, start int64, exe string) string {
	return strconv.Itoa(pid) + "/" + strconv.FormatInt(start, 10) + "/" + exe
}

// checkHelperPeer is helperClient's check: helperPeer, then nothing may
// have been written on the connection yet (spokeFirst); a refusal logged as
// a warning with its reason (each reason at most once a minute). A helper
// that turned the connection away as busy (it writes so and closes, before
// any check could see it hold the connection) is errHelperBusy.
func (s *Screen) checkHelperPeer(ctx context.Context, c *net.UnixConn, uid int) error {
	err := s.helperPeer(ctx, c, uid)
	switch {
	case err == nil:
		err = spokeFirst(c)
	case ctx.Err() == nil && saidBusy(c):
		err = errHelperBusy
	}
	if errors.Is(err, errHelperBusy) {
		s.log.Info("screen: Whombat Helper is busy; sent nothing", "uid", uid)
		return err
	}
	if err == nil || ctx.Err() != nil {
		return err
	}
	s.peerLog.mu.Lock()
	quiet := s.peerLog.last == err.Error() && s.now().Sub(s.peerLog.at) < time.Minute
	if !quiet {
		s.peerLog.last, s.peerLog.at = err.Error(), s.now()
	}
	s.peerLog.mu.Unlock()
	if !quiet {
		var r *helperRefusal
		if errors.As(err, &r) && r.impostor {
			s.log.Warn("screen: something other than the installed Whombat Helper answered on its socket; sent nothing", "uid", uid, "reason", err)
		} else {
			s.log.Warn("screen: couldn't check what answered on Whombat Helper's socket; sent nothing", "uid", uid, "reason", err)
		}
	}
	return err
}

// helperPeer checks the process that answers on a helper socket (see
// above). Any doubt refuses.
func (s *Screen) helperPeer(ctx context.Context, c *net.UnixConn, uid int) error {
	if peer, err := peerUID(c); err != nil || peer != uid {
		return impostor("the socket isn't the user's")
	}
	pid, err := peerPID(c)
	if err != nil || pid <= 0 {
		return cantCheck("can't tell which process listens: %v", err)
	}
	want := s.helperExe()
	exe, err := s.processPath(ctx, pid)
	if err != nil {
		return cantCheck("can't tell what process %d runs: %v", pid, err)
	}
	if exe != want {
		return impostor("process %d runs %s, not the installed helper", pid, exe)
	}
	if err := s.rootOnly(want); err != nil {
		return cantCheck("the installed helper isn't root's alone: %v", err)
	}
	stamp, err := fileStamp(want)
	if err != nil {
		return cantCheck("the installed helper: %v", err)
	}
	start, err := s.procStart(ctx, pid)
	if err != nil {
		return cantCheck("process %d: %v", pid, err)
	}
	key := procKey(pid, start, exe)
	pc := &s.peers
	pc.mu.Lock()
	if pc.stamp != stamp {
		pc.stamp, pc.req, pc.ok = stamp, "", map[string]bool{}
	}
	req, known := pc.req, pc.ok[key]
	pc.mu.Unlock()
	if !known {
		if req == "" {
			if req, err = s.helperSys.Requirement(ctx, s.helperApp); err != nil || req == "" {
				return cantCheck("can't read the installed helper's signature: %v", err)
			}
		}
		if err := s.codeVerify(ctx, strconv.Itoa(pid), req); err != nil {
			return impostor("process %d isn't the installed helper's code: %v", pid, err)
		}
		pc.mu.Lock()
		if pc.stamp == stamp {
			pc.req = req
			if len(pc.ok) > 64 {
				pc.ok = map[string]bool{}
			}
			pc.ok[key] = true
		}
		pc.mu.Unlock()
	}
	if err := s.soleHolder(ctx, c, pid); err != nil {
		return err
	}
	// The same process still, running the same file.
	if now, err := s.procStart(ctx, pid); err != nil || now != start {
		return impostor("process %d went away while it was checked", pid)
	}
	if now, err := s.processPath(ctx, pid); err != nil || now != want {
		return impostor("process %d changed what it runs while it was checked", pid)
	}
	return nil
}

// The helper never writes before it is asked, except to say it is busy,
// which it does as it closes the connection. Anything else already waiting
// on the connection was written before the checks saw the helper hold it:
// by whatever held it then (a program that accepted, wrote an answer of its
// own and then ran the genuine helper, which keeps the pid and inherits the
// connection). The agent would read that as the helper's answer.

// spokeFirst looks, without waiting and without taking it, at what the
// other end wrote before the agent asked: nothing is nil; the helper's busy
// answer is errHelperBusy; the end closed or anything else is a refusal.
func spokeFirst(c *net.UnixConn) error {
	data, closed, err := peekConn(c)
	switch {
	case err != nil:
		return cantCheck("can't tell whether something wrote on the connection: %v", err)
	case closed:
		return cantCheck("the helper closed the connection before it was asked")
	case len(data) == 0:
		return nil
	case busyLine(data):
		return errHelperBusy
	}
	return impostor("something wrote on the connection before Whombat asked anything")
}

// saidBusy says whether the other end, refused, had written the helper's
// busy answer (waiting a moment for it).
func saidBusy(c *net.UnixConn) bool {
	c.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	defer c.SetReadDeadline(time.Time{})
	buf := make([]byte, 4096)
	n, _ := io.ReadAtLeast(c, buf, 1)
	return busyLine(buf[:n])
}

// busyLine says whether data starts with the helper's answer that it is
// busy: code busy (1.0.5 on), or failed with the words before it.
func busyLine(data []byte) bool {
	line, _, ok := bytes.Cut(data, []byte("\n"))
	if !ok {
		return false
	}
	var a helperAnswer
	return json.Unmarshal(line, &a) == nil && busyAnswer(&a)
}

// busyAnswer: the helper's answer that it takes no more requests now.
func busyAnswer(a *helperAnswer) bool {
	return !a.OK && (a.Code == "busy" || (a.Code == "failed" && a.Message == "the helper is busy; try again"))
}

// peekConn reads what is waiting on c without taking it and without
// waiting; closed says the other end closed with nothing left to read.
func peekConn(c *net.UnixConn) (data []byte, closed bool, err error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, false, err
	}
	buf := make([]byte, 4096)
	var n int
	var rerr error
	if err := raw.Control(func(fd uintptr) {
		for {
			n, _, rerr = syscall.Recvfrom(int(fd), buf, syscall.MSG_PEEK|syscall.MSG_DONTWAIT)
			if rerr != syscall.EINTR {
				return
			}
		}
	}); err != nil {
		return nil, false, err
	}
	switch {
	case rerr == syscall.EAGAIN || rerr == syscall.EWOULDBLOCK:
		return nil, false, nil
	case rerr != nil:
		return nil, false, rerr
	case n == 0:
		return nil, true, nil
	}
	return buf[:n], false, nil
}

// soleHolder waits up to acceptWait until pid has taken the connection and
// checks that it is the only one that has it: exactly one descriptor of
// pid, not standard input, output or error, whose open file has no other
// reference. A connection someone else takes is refused at once.
func (s *Screen) soleHolder(ctx context.Context, c *net.UnixConn, pid int) error {
	deadline := time.Now().Add(s.acceptWait)
	gap := time.Millisecond
	for {
		refs, err := s.connRefs(c, pid)
		if err != nil {
			return cantCheck("can't tell who holds the connection: %v", err)
		}
		switch {
		case len(refs) > 1:
			return impostor("process %d holds the connection %d times", pid, len(refs))
		case len(refs) == 1 && refs[0].shared:
			return impostor("process %d shares the connection with something else (another process, a copy or a message in flight)", pid)
		case len(refs) == 1 && refs[0].fd <= 2:
			return impostor("process %d holds the connection as its standard input or output", pid)
		case len(refs) == 1:
			return nil
		}
		// Not taken yet. Once a process has accepted it, macOS names that
		// one for the connection.
		if now, err := peerPID(c); err == nil && now > 0 && now != pid {
			return impostor("process %d took the connection, not the helper (process %d)", now, pid)
		}
		if !time.Now().Before(deadline) {
			return impostor("process %d didn't take the connection", pid)
		}
		if err := pause(ctx, gap); err != nil {
			return err
		}
		if gap < 8*time.Millisecond {
			gap *= 2
		}
	}
}
