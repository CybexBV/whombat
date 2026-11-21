package diagnose

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/agent/systemdrun"
	"rackoon/internal/proto"
)

// step is one part of a check: a command, a file, or Go code. A check of
// several steps shows each as a section headed "$ <title>".
type step struct {
	title string // what ran, for the transcript ("smartctl -x /dev/sda")

	argv    []string // a command (argv[0] is looked up in the clean PATH), or
	file    string   // a file to show, or
	fn      func(ctx context.Context) (string, error)
	outside bool // command: leave the agent's sandbox (systemd-run --pipe) when sandboxed
	// ok accepts exit statuses that are not failures (default: 0 only).
	ok func(exit int, out []byte) bool
	// redact hides secrets (configuration output); tailLines keeps the
	// last lines only.
	redact    bool
	tailLines int
}

// cmdStep is a command step titled with its own command line.
func cmdStep(argv ...string) step { return step{title: quoteArgv(argv), argv: argv} }

// fileStep shows a file.
func fileStep(path string) step { return step{title: "cat " + path, file: path} }

// runSpec and runResult are the command runner's interface (Diagnostics.run).
type runSpec struct {
	argv []string
	env  []string
	tail bool // keep the end of long output (else the start)
	// stdout: out is stdout only, stderr apart (output the agent parses).
	stdout bool
}

type runResult struct {
	out    []byte
	stderr []byte // with runSpec.stdout
	cut    bool   // more output than MaxOutput
	exit   int    // exit status; -1 when it did not run to its end
	err    error  // could not start, or timed out (errTimedOut)
}

var (
	errTimedOut    = errors.New("timed out")
	errCommandTime = fmt.Errorf("did not finish within %d s", int(CommandTimeout.Seconds()))
	errCheckTime   = errors.New("the check ran out of time")
)

// env is the clean environment of the checks' commands.
func env(parse bool) []string {
	e := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=C.UTF-8",
		"HOME=/root",
		"TERM=dumb",
		"SYSTEMD_COLORS=0",
		"SYSTEMD_PAGER=cat",
		"PAGER=cat",
	}
	if parse {
		e = append(e, "LC_ALL=C")
	}
	return e
}

// runReal runs a command in its own process group (killed as a whole when
// it takes longer than CommandTimeout or ctx ends), in /, with stdin
// closed; stdout and stderr are captured together (apart with s.stdout).
func runReal(ctx context.Context, s runSpec) runResult {
	ctx, cancel := context.WithTimeout(ctx, CommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.argv[0], s.argv[1:]...)
	cmd.Env = s.env
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	buf := &capBuffer{max: MaxOutput, tail: s.tail}
	errBuf := buf
	if s.stdout {
		errBuf = &capBuffer{max: 64 << 10}
	}
	cmd.Stdout, cmd.Stderr = buf, errBuf
	err := cmd.Run()
	r := runResult{out: buf.bytes(), cut: buf.cut, exit: -1}
	if s.stdout {
		r.stderr = errBuf.bytes()
	}
	if cmd.ProcessState != nil {
		r.exit = exitStatus(cmd.ProcessState)
	}
	switch {
	case ctx.Err() != nil:
		r.exit, r.err = -1, errTimedOut
	case err != nil && cmd.ProcessState == nil:
		r.err = err // did not start
	}
	return r
}

// exitStatus is the exit code, or 128 + the signal like a shell's $?.
func exitStatus(ps *os.ProcessState) int {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ws.ExitStatus()
	}
	return -1
}

// systemdRunPipe wraps argv in a transient unit, out of the agent's sandbox
// (like the broker's PVE tools).
func systemdRunPipe(argv []string, timeout time.Duration) []string {
	w := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect", "--pipe",
		"--service-type=exec", "--property=KillMode=mixed",
		fmt.Sprintf("--property=RuntimeMaxSec=%ds", int(timeout.Seconds())),
		"--description=Whombat diagnostics helper", "--"}
	return append(w, systemdrun.Literal(argv...)...)
}

// runStep runs one step and returns its text.
func (d *Diagnostics) runStep(ctx context.Context, s step, tail bool) (text string, cut bool, err error) {
	switch {
	case s.fn != nil:
		text, err = s.fn(ctx)
	case s.file != "":
		var b []byte
		b, err = d.readFile(s.file)
		text = string(b)
	default:
		var path string
		path, err = d.lookPath(s.argv[0])
		if err != nil {
			return "", false, err
		}
		argv := append([]string{path}, s.argv[1:]...)
		if s.outside && d.sandboxed {
			argv = systemdRunPipe(argv, CommandTimeout)
		}
		r := d.run(ctx, runSpec{argv: argv, env: d.cmdEnv(false), tail: tail || s.tailLines > 0})
		text, cut, err = string(r.out), r.cut, r.err
		if err == nil && !(s.ok != nil && s.ok(r.exit, r.out) || s.ok == nil && r.exit == 0) {
			err = fmt.Errorf("exit status %d", r.exit)
		}
		if errors.Is(err, errTimedOut) {
			err = errCommandTime
			if ctx.Err() != nil {
				err = errCheckTime
			}
		}
	}
	if s.tailLines > 0 {
		text = lastLines(text, s.tailLines)
	}
	if s.redact {
		text = redactConfig(text)
	}
	return text, cut, err
}

// runSteps runs a check's steps and builds its answer. A failing step of
// several shows its error in its section; a check of one step that fails
// answers "failed" (or "timeout") with what it printed.
func (d *Diagnostics) runSteps(ctx context.Context, steps []step, tail bool) proto.DiagnoseResponse {
	var resp proto.DiagnoseResponse
	for _, s := range steps {
		resp.Commands = append(resp.Commands, s.title)
	}
	if len(steps) == 1 {
		text, cut, err := d.runStep(ctx, steps[0], tail)
		resp.Output, resp.Truncated = finish(text, tail, cut)
		if err != nil {
			resp.Code = CodeFailed
			if ctx.Err() != nil || errors.Is(err, errCommandTime) || errors.Is(err, errCheckTime) {
				resp.Code = CodeTimeout
			}
			resp.Message = steps[0].title + ": " + err.Error()
			if l := lastLine(text); l != "" && resp.Code == CodeFailed {
				resp.Message += ": " + l
			}
		}
		return resp
	}
	var b strings.Builder
	failed, anyCut := 0, false
	for _, s := range steps {
		fmt.Fprintf(&b, "$ %s\n", s.title)
		if ctx.Err() != nil {
			b.WriteString("[skipped: the check ran out of time]\n\n")
			failed++
			continue
		}
		text, cut, err := d.runStep(ctx, s, tail)
		anyCut = anyCut || cut
		if text = strings.TrimRight(text, "\n"); text != "" {
			b.WriteString(text)
			b.WriteByte('\n')
		}
		if cut {
			b.WriteString("[output cut]\n")
		}
		if err != nil {
			failed++
			fmt.Fprintf(&b, "[%s]\n", err)
		}
		b.WriteByte('\n')
	}
	// Cut sections are marked in place.
	resp.Output, resp.Truncated = finish(strings.TrimRight(b.String(), "\n")+"\n", tail, false)
	resp.Truncated = resp.Truncated || anyCut
	if failed == len(steps) {
		resp.Code = CodeFailed
		resp.Message = "every command of the check failed"
	}
	return resp
}

// ---- output -----------------------------------------------------------------------

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// finish makes s the answer: escape sequences removed, valid UTF-8, at most
// MaxOutput bytes (the end kept when tail, else the start). cut: s is
// already cut (the runner kept only a part).
func finish(s string, tail, cut bool) (string, bool) {
	if strings.IndexByte(s, 0x1b) >= 0 {
		s = ansiRe.ReplaceAllString(s, "")
	}
	s = strings.ToValidUTF8(s, "\uFFFD")
	const (
		headNote = "[output cut: only the last 256 KiB are shown]\n"
		tailNote = "\n[output cut at 256 KiB]\n"
	)
	if !cut && len(s) <= MaxOutput {
		return s, false
	}
	if tail {
		if n := MaxOutput - len(headNote); len(s) > n {
			s = s[len(s)-n:]
		}
		if i := strings.IndexByte(s, '\n'); i >= 0 && i < 4096 {
			s = s[i+1:] // the first line is a part of one
		}
		return headNote + strings.ToValidUTF8(s, ""), true
	}
	if n := MaxOutput - len(tailNote); len(s) > n {
		s = s[:n]
		if i := strings.LastIndexByte(s, '\n'); i >= 0 && len(s)-i < 4096 {
			s = s[:i]
		}
	}
	return strings.ToValidUTF8(strings.TrimRight(s, "\n"), "") + tailNote, true
}

// capBuffer keeps at most max bytes of what is written: the first ones, or
// with tail the last ones.
type capBuffer struct {
	max  int
	tail bool
	buf  []byte
	cut  bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if !c.tail {
		if room := c.max - len(c.buf); room < len(p) {
			p = p[:max(room, 0)]
			c.cut = true
		}
		c.buf = append(c.buf, p...)
		return n, nil
	}
	c.buf = append(c.buf, p...)
	if len(c.buf) > 2*c.max {
		c.buf = append(c.buf[:0], c.buf[len(c.buf)-c.max:]...)
		c.cut = true
	}
	return n, nil
}

func (c *capBuffer) bytes() []byte {
	if c.tail && len(c.buf) > c.max {
		c.cut = true
		return c.buf[len(c.buf)-c.max:]
	}
	return c.buf
}

// lastLines returns the last n lines of s.
func lastLines(s string, n int) string {
	s = strings.TrimRight(s, "\n")
	i := len(s)
	for k := 0; k < n; k++ {
		j := strings.LastIndexByte(s[:i], '\n')
		if j < 0 {
			return s + "\n"
		}
		i = j
	}
	return s[i+1:] + "\n"
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	if r := []rune(s); len(r) > 300 {
		s = string(r[:300])
	}
	return s
}

// quoteArgv renders argv as a shell would need it, for reading.
func quoteArgv(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		q[i] = shellQuote(a)
	}
	return strings.Join(q, " ")
}

var plainArg = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./_-]+$`)

func shellQuote(s string) string {
	if plainArg.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
