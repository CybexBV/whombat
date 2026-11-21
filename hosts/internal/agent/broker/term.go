package broker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"rackoon/internal/wire"
)

// sendControl sends a JSON control frame to the browser.
func sendControl(out func(wire.Frame) error, cc wire.ConsoleControl) error {
	b, err := json.Marshal(cc)
	if err != nil {
		return err
	}
	return out(wire.Frame{Kind: wire.FrameControl, Payload: b})
}

func sendStatus(out func(wire.Frame) error, protocol, resolution string) error {
	return sendControl(out, wire.ConsoleControl{Type: "status", State: "connected", Protocol: protocol, Resolution: resolution})
}

func parseControl(f wire.Frame) (wire.ConsoleControl, bool) {
	var cc wire.ConsoleControl
	if f.Kind != wire.FrameControl || json.Unmarshal(f.Payload, &cc) != nil {
		return cc, false
	}
	return cc, true
}

// clampTerm bounds terminal sizes from the browser.
func clampTerm(cols, rows int) (int, int) {
	if cols < 2 {
		cols = 2
	}
	if rows < 1 {
		rows = 1
	}
	if cols > 1000 {
		cols = 1000
	}
	if rows > 500 {
		rows = 500
	}
	return cols, rows
}

// termSession relays a byte stream (PTY, serial socket, Incus websocket) on
// channel 0. It implements agent.ConsoleSession.
type termSession struct {
	protocol string
	rw       io.ReadWriteCloser
	resize   func(cols, rows int) error // may be nil (serial)
	cleanup  func()                     // runs once after rw is closed

	closeOnce sync.Once
}

func (s *termSession) close() {
	s.closeOnce.Do(func() {
		s.rw.Close()
		if s.cleanup != nil {
			s.cleanup()
		}
	})
}

func (s *termSession) Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error {
	stop := context.AfterFunc(ctx, s.close)
	defer stop()
	defer s.close()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := sendStatus(out, s.protocol, ""); err != nil {
		return err
	}
	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := s.rw.Read(buf)
			if n > 0 {
				p := make([]byte, n)
				copy(p, buf[:n])
				if werr := out(wire.Frame{Kind: wire.FrameData, Payload: p}); werr != nil {
					readErr <- werr
					return
				}
			}
			if err != nil {
				readErr <- err
				return
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			if isEOF(err) {
				return nil
			}
			return err
		case f, ok := <-in:
			if !ok {
				return nil
			}
			switch f.Kind {
			case wire.FrameData:
				if f.Channel != 0 || len(f.Payload) == 0 {
					continue
				}
				if _, err := s.rw.Write(f.Payload); err != nil {
					return err
				}
			case wire.FrameControl:
				cc, ok := parseControl(f)
				if !ok {
					continue
				}
				switch cc.Type {
				case "resize":
					if s.resize != nil && cc.Cols > 0 && cc.Rows > 0 {
						c, r := clampTerm(cc.Cols, cc.Rows)
						_ = s.resize(c, r)
					}
				case "close":
					if cc.Channel == 0 {
						return nil
					}
				}
			}
		}
	}
}

// isEOF treats the errors a closed PTY or socket returns as a clean end.
func isEOF(err error) bool {
	return err == nil || errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) ||
		errors.Is(err, os.ErrClosed) || errors.Is(err, net.ErrClosed) || errors.Is(err, io.ErrClosedPipe)
}

// ptyProcess is a command attached to a pseudo terminal.
type ptyProcess struct {
	cmd    *exec.Cmd
	master *os.File
	done   chan struct{}
	err    error
}

// startPTY starts argv on a new PTY of the given size in its own session.
func startPTY(argv []string, env []string, cols, rows int) (*ptyProcess, error) {
	return startPTYDir(argv, env, "/", cols, rows)
}

// startPTYDir is startPTY in the working directory dir.
func startPTYDir(argv []string, env []string, dir string, cols, rows int) (*ptyProcess, error) {
	if cols <= 0 || rows <= 0 {
		cols, rows = 80, 24
	}
	cols, rows = clampTerm(cols, rows)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Dir = dir
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	p := &ptyProcess{cmd: cmd, master: f, done: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

func (p *ptyProcess) resize(cols, rows int) error {
	return pty.Setsize(p.master, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// stop hangs up the session, then kills it if it does not exit.
func (p *ptyProcess) stop() {
	select {
	case <-p.done:
		return
	default:
	}
	pid := p.cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGHUP)
	select {
	case <-p.done:
		return
	case <-time.After(2 * time.Second):
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = p.cmd.Process.Kill()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
	}
}

// session wraps the PTY process as a terminal console session.
func (p *ptyProcess) session(protocol string) *termSession {
	return &termSession{
		protocol: protocol,
		rw:       p.master,
		resize:   p.resize,
		cleanup:  p.stop,
	}
}

// baseEnv is the environment for helper commands (PATH for qm/pct/virsh).
func baseEnv(extra ...string) []string {
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=C.UTF-8",
		"TERM=xterm-256color",
		"HOME=/root",
		// systemd-run --pty (systemd >= 257) would set the terminal title
		// to the helper's command line.
		"SYSTEMD_ADJUST_TERMINAL_TITLE=0",
	}
	return append(env, extra...)
}

// openPTYSlave opens an existing PTY (e.g. a libvirt serial device) for
// reading and writing without making it our controlling terminal.
func openPTYSlave(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	// NewFile registers a non-blocking fd with the runtime poller, so Close
	// unblocks a pending Read.
	return os.NewFile(uintptr(fd), path), nil
}
