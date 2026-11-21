// Package fix is the Look and fix level of remote help (Whombat RH-02): a root command line (`bash -l` in a
// pseudo terminal), any command (`sh -c`), and `restart <unit>`. What these print — and only that, never what is typed
// — is copied into the visit's transcript. Each runs in its own session; when it ends, its channel closes or the grant
// ends, every process left in that session is killed.
package fix

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// SystemPath is the PATH of a root command line on the box (NixOS wrappers first, like a login shell).
const SystemPath = "/run/wrappers/bin:/run/current-system/sw/bin"

// Config is the Fix runner's configuration.
type Config struct {
	Bash, Sh, Systemctl string // absolute paths
	Path                string // default SystemPath
	Home                string // default /root
	// Drain bounds how long output is still read once a command has ended (default 2 s).
	Drain time.Duration
}

// DefaultConfig is the box's: the binaries in NixOS's system profile.
func DefaultConfig() Config {
	bin := "/run/current-system/sw/bin/"
	return Config{Bash: bin + "bash", Sh: bin + "sh", Systemctl: bin + "systemctl"}
}

// Runner runs Fix commands as the service's own user (root on the box).
type Runner struct {
	cfg Config
}

// New checks the configuration.
func New(cfg Config) (*Runner, error) {
	for _, b := range []string{cfg.Bash, cfg.Sh, cfg.Systemctl} {
		if !filepath.IsAbs(b) {
			return nil, fmt.Errorf("fix: binary %q isn't an absolute path", b)
		}
	}
	if cfg.Path == "" {
		cfg.Path = SystemPath
	}
	if cfg.Home == "" {
		cfg.Home = "/root"
	}
	if cfg.Drain <= 0 {
		cfg.Drain = 2 * time.Second
	}
	return &Runner{cfg: cfg}, nil
}

// Window is a terminal's size in characters.
type Window struct{ Cols, Rows uint16 }

// Term is what a pty-req asked for.
type Term struct {
	Name   string
	Window Window
}

// IO is one channel: In is what the support person types (never recorded), Out and Err what the command prints,
// Transcript the visit's transcript (nil: none). Out, Err and Transcript may be written at the same time.
type IO struct {
	In         io.Reader
	Out, Err   io.Writer
	Transcript io.Writer
}

var termRe = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,40}$`)

func (r *Runner) env(term *Term) []string {
	t := "dumb"
	if term != nil {
		t = "xterm-256color"
		if termRe.MatchString(term.Name) {
			t = term.Name
		}
	}
	return []string{"PATH=" + r.cfg.Path, "HOME=" + r.cfg.Home, "USER=root", "LOGNAME=root", "SHELL=" + r.cfg.Bash,
		"TERM=" + t, "LANG=C.UTF-8"}
}

// Shell runs `bash -l` in a pseudo terminal (or on pipes when no terminal was asked for) until it exits, ctx ends or
// its input fails; it returns the exit status.
func (r *Runner) Shell(ctx context.Context, io IO, term *Term, winch <-chan Window) (int, error) {
	transcript(io.Transcript, "$ bash -l\n")
	return r.start(ctx, []string{r.cfg.Bash, "-l"}, io, term, winch)
}

// Exec runs one command line with `sh -c` (in a pseudo terminal when one was asked for).
func (r *Runner) Exec(ctx context.Context, line string, io IO, term *Term, winch <-chan Window) (int, error) {
	transcript(io.Transcript, "$ "+line+"\n")
	return r.start(ctx, []string{r.cfg.Sh, "-c", line}, io, term, winch)
}

var unitRe = regexp.MustCompile(`^[A-Za-z0-9@._-]{1,80}$`)

// Restart restarts one unit (`systemctl restart -- <unit>`).
func (r *Runner) Restart(ctx context.Context, unit string, io IO) (int, error) {
	if !unitRe.MatchString(unit) || strings.HasPrefix(unit, "-") {
		return 2, errors.New("fix: not a unit name")
	}
	transcript(io.Transcript, "$ systemctl restart -- "+unit+"\n")
	return r.start(ctx, []string{r.cfg.Systemctl, "restart", "--", unit}, io, nil, nil)
}

func transcript(w io.Writer, s string) {
	if w != nil {
		_, _ = io.WriteString(w, s)
	}
}

// start runs argv in a new session and waits for it.
func (r *Runner) start(ctx context.Context, argv []string, cio IO, term *Term, winch <-chan Window) (int, error) {
	var tr io.Writer
	if cio.Transcript != nil {
		tr = &locked{w: cio.Transcript}
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = r.env(term)
	cmd.Dir = r.cfg.Home
	if st, err := os.Stat(cmd.Dir); err != nil || !st.IsDir() {
		cmd.Dir = "/"
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = r.cfg.Drain

	var wg sync.WaitGroup // output copies
	var master *os.File
	var inW *os.File
	if term != nil {
		m, slave, err := openPTY()
		if err != nil {
			return 1, fmt.Errorf("fix: no terminal: %w", err)
		}
		master = m
		defer master.Close()
		setWindow(master, term.Window)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
		cmd.SysProcAttr.Setctty = true
		cmd.SysProcAttr.Ctty = 0
		if err := cmd.Start(); err != nil {
			slave.Close()
			return 127, err
		}
		slave.Close()
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = io.Copy(&tee{w: cio.Out, t: tr}, master) // ends with EIO once no process holds the terminal
		}()
		go func() { _, _ = io.Copy(master, cio.In) }()
		if winch != nil {
			go func() {
				for w := range winch {
					setWindow(master, w)
				}
			}()
		}
	} else {
		inR, w, err := os.Pipe()
		if err != nil {
			return 1, err
		}
		inW = w
		cmd.Stdin = inR
		cmd.Stdout = &tee{w: cio.Out, t: tr}
		cmd.Stderr = &tee{w: cio.Err, t: tr}
		if err := cmd.Start(); err != nil {
			inR.Close()
			inW.Close()
			return 127, err
		}
		inR.Close()
		go func() {
			_, _ = io.Copy(inW, cio.In)
			inW.Close()
		}()
	}
	pid := cmd.Process.Pid

	// Wait for the exit without reaping it: while the leader is a zombie its pid (= the session id) can't be reused,
	// so killing "everything in this session" can't hit anyone else's.
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		var info unix.Siginfo
		for {
			if err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil); err != unix.EINTR {
				return
			}
		}
	}()
	select {
	case <-exited:
	case <-ctx.Done():
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-exited
	}
	KillSession(pid)
	err := cmd.Wait()
	if inW != nil {
		inW.Close()
	}
	if master != nil {
		_ = master.SetReadDeadline(time.Now().Add(r.cfg.Drain))
		wg.Wait()
	}
	if ctx.Err() != nil {
		return 130, ctx.Err()
	}
	return exitCode(cmd, err), nil
}

func exitCode(cmd *exec.Cmd, err error) int {
	if cmd.ProcessState == nil {
		return 1
	}
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	if c := cmd.ProcessState.ExitCode(); c >= 0 {
		return c
	}
	if err != nil {
		return 1
	}
	return 0
}

// KillSession kills every live process whose session is sid (a command's background jobs too, wherever they were
// reparented). A process that left the session with setsid() isn't found: root can daemonize on purpose.
func KillSession(sid int) {
	_ = syscall.Kill(-sid, syscall.SIGKILL)
	for range 8 {
		found := false
		for _, pid := range sessionMembers(sid) {
			found = true
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		if !found {
			return
		}
	}
}

// sessionMembers lists the processes in /proc of session sid that aren't zombies yet.
func sessionMembers(sid int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == sid {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// pid (comm) state ppid pgrp session …; comm may hold anything, so read after its last ')'.
		i := strings.LastIndexByte(string(b), ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(string(b[i+1:]))
		if len(f) < 4 || f[0] == "Z" || f[0] == "X" {
			continue
		}
		if s, err := strconv.Atoi(f[3]); err == nil && s == sid {
			pids = append(pids, pid)
		}
	}
	return pids
}

// tee writes to w and copies what w took into t; t failing (the transcript is full) never stops w.
type tee struct {
	w io.Writer
	t io.Writer
}

func (x *tee) Write(p []byte) (int, error) {
	n, err := x.w.Write(p)
	if x.t != nil && n > 0 {
		if _, terr := x.t.Write(p[:n]); terr != nil {
			x.t = nil
		}
	}
	return n, err
}

// locked serialises writes to the transcript (stdout and stderr are copied at the same time).
type locked struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *locked) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
