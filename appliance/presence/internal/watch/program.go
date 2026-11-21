package watch

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/presence/internal/camera"
)

// Program runs presence-watch (nix/packages/presence-engine): the camera and the detector live in it, so its exit
// closes the camera.
type Program struct {
	Bin, Model string
	// Threshold overrides presence-watch's face threshold (0: its own, NX-282).
	Threshold float64
	// KillAfter is how long a child may take to exit after SIGTERM before SIGKILL (1 s).
	KillAfter time.Duration
}

// Spawn starts `presence-watch --device PATH` (or `--frames DIR --repeat` for a folder of pictures) and reports its
// lines. stdin is a pipe the child watches: closing it, or this process dying, ends the child.
func (p Program) Spawn(cam camera.Camera, event func(Event), exit func(error)) (Child, error) {
	args := []string{"--model", p.Model}
	if p.Threshold > 0 {
		args = append(args, "--threshold", strconv.FormatFloat(p.Threshold, 'f', -1, 64))
	}
	if cam.Frames {
		args = append(args, "--frames", cam.Path, "--repeat")
	} else {
		args = append(args, "--device", cam.Path)
	}
	cmd := exec.Command(p.Bin, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tail{max: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &proc{cmd: cmd, stdin: stdin, done: make(chan struct{}), killAfter: p.KillAfter}
	if c.killAfter <= 0 {
		c.killAfter = time.Second
	}
	go func() {
		readLines(stdout, event)
		// Whatever is left (a child that printed too long a line) is drained, so Wait doesn't hang on the pipe.
		_, _ = io.Copy(io.Discard, stdout)
		err := cmd.Wait()
		close(c.done)
		if err != nil {
			if last := stderr.last(); last != "" {
				err = errors.New(last)
			}
		}
		exit(err)
	}()
	return c, nil
}

// readLines turns the child's JSON lines into events; anything else is skipped.
func readLines(r io.Reader, event func(Event)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 64<<10)
	for sc.Scan() {
		var l struct {
			Face   *bool  `json:"face"`
			Luma   int    `json:"luma"`
			Camera string `json:"camera"`
			Format string `json:"format"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		}
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			continue
		}
		switch {
		case l.Face != nil:
			event(Event{Frame: true, Face: *l.Face, Luma: l.Luma})
		case l.Camera != "":
			event(Event{Opened: fmt.Sprintf("%s %d×%d", l.Format, l.Width, l.Height)})
		}
	}
}

// SelfTest loads the model and checks a black frame (`--self-test`): the detector works.
func (p Program) SelfTest(ctx context.Context) error {
	out, err := p.run(ctx, "--model", p.Model, "--self-test")
	if err == nil && !bytes.Contains(out, []byte(`"selfTest":"ok"`)) {
		err = errors.New("no answer")
	}
	return err
}

// Probe lists the capture devices (`--probe`); it streams from none of them.
func (p Program) Probe(ctx context.Context) ([]byte, error) { return p.run(ctx, "--probe") }

func (p Program) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, p.Bin, args...)
	stderr := &tail{max: 4096}
	cmd.Stderr = stderr
	out, err := cmd.Output()
	if err != nil && stderr.last() != "" {
		err = fmt.Errorf("%w: %s", err, stderr.last())
	}
	return out, err
}

type proc struct {
	cmd       *exec.Cmd
	stdin     io.Closer
	done      chan struct{}
	killAfter time.Duration
	once      sync.Once
}

func (c *proc) Done() <-chan struct{} { return c.done }

// Stop closes the child's stdin and sends SIGTERM; SIGKILL follows when it hasn't exited after killAfter.
func (c *proc) Stop() {
	c.once.Do(func() {
		_ = c.stdin.Close()
		_ = c.cmd.Process.Signal(syscall.SIGTERM)
		go func() {
			t := time.NewTimer(c.killAfter)
			defer t.Stop()
			select {
			case <-c.done:
			case <-t.C:
				_ = c.cmd.Process.Kill()
			}
		}()
	})
}

// tail keeps the end of what a child writes to stderr (at most max bytes), for the journal's one line on a failure.
type tail struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

// last is the last non-empty line.
func (t *tail) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.b)), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
