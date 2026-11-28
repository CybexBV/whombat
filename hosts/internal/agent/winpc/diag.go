package winpc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"rackoon/internal/proto"
)

// Exec limits, as on Linux and macOS.
const (
	execDefaultTimeout = 120 * time.Second
	execMaxTimeout     = 1800 * time.Second
	execMaxCommand     = 16 << 10
	execMaxOutput      = 256 << 10
)

// Diagnostics implements agent.Diagnostics on a Windows PC: the
// assistant's commands run in Windows PowerShell as SYSTEM. The read-only
// check catalog is Linux's and the Mac's; a PC has none yet.
type Diagnostics struct {
	dir string // where a command's script is written for its run
	log *slog.Logger
}

// NewDiagnostics returns the PC's diagnostics; dir is the agent's state
// folder.
func NewDiagnostics(dir string, log *slog.Logger) *Diagnostics {
	if log == nil {
		log = slog.Default()
	}
	return &Diagnostics{dir: dir, log: log}
}

// Run implements agent.Diagnostics: an empty catalog.
func (d *Diagnostics) Run(_ context.Context, req proto.DiagnoseRequest) proto.DiagnoseResponse {
	if req.Check == proto.DiagnoseList {
		return proto.DiagnoseResponse{Checks: []proto.DiagnoseCheck{}}
	}
	return proto.DiagnoseResponse{Code: codeUnsupported,
		Message: fmt.Sprintf("check %q is not available on a Windows PC; run a PowerShell command instead", req.Check)}
}

func execTimeout(s int) time.Duration {
	d := time.Duration(s) * time.Second
	switch {
	case d <= 0:
		return execDefaultTimeout
	case d > execMaxTimeout:
		return execMaxTimeout
	}
	return d
}

// execPrelude makes a command's output UTF-8 (the service has no console
// whose code page would decide it) and its errors plain text.
const execPrelude = "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n" +
	"$OutputEncoding = New-Object System.Text.UTF8Encoding $false\n" +
	"$ProgressPreference = 'SilentlyContinue'\n"

// Exec implements agent.Diagnostics: the command in Windows PowerShell as
// SYSTEM, from a script file of its own (so neither the command line's
// quoting nor the execution policy changes it), stdout and stderr as they
// interleave, the last 256 KiB kept. Everything it started ends with it.
func (d *Diagnostics) Exec(ctx context.Context, req proto.ExecRequest) proto.ExecResponse {
	switch {
	case strings.TrimSpace(req.Command) == "":
		return proto.ExecResponse{Code: codeInvalid, Message: "the command is empty", ExitCode: -1}
	case len(req.Command) > execMaxCommand:
		return proto.ExecResponse{Code: codeInvalid, Message: fmt.Sprintf("the command is longer than %d KiB", execMaxCommand>>10), ExitCode: -1}
	case strings.IndexByte(req.Command, 0) >= 0:
		return proto.ExecResponse{Code: codeInvalid, Message: "the command contains a NUL byte", ExitCode: -1}
	}
	if err := os.MkdirAll(filepath.Join(d.dir, "exec"), 0o700); err != nil {
		return proto.ExecResponse{Code: "failed", Message: "the command could not be started: " + err.Error(), ExitCode: -1}
	}
	var id [8]byte
	_, _ = rand.Read(id[:])
	path := filepath.Join(d.dir, "exec", "cmd-"+hex.EncodeToString(id[:])+".ps1")
	if err := os.WriteFile(path, []byte(execPrelude+req.Command+"\n"), 0o600); err != nil {
		return proto.ExecResponse{Code: "failed", Message: "the command could not be started: " + err.Error(), ExitCode: -1}
	}
	defer os.Remove(path)
	timeout := execTimeout(req.TimeoutS)
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command(PowerShellPath(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", scriptCommand(path))
	cmd.Dir = SystemRoot()
	buf := &tailBuffer{max: execMaxOutput}
	cmd.Stdout, cmd.Stderr = buf, buf
	start := time.Now()
	stop, err := startTree(cmd)
	if err != nil {
		return proto.ExecResponse{Code: "failed", Message: "the command could not be started: " + errMessage(err), ExitCode: -1}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timedOut := false
	select {
	case <-done:
	case <-rctx.Done():
		timedOut = ctx.Err() == nil
		stop()
		<-done
	}
	stop() // what the command left running ends with it
	resp := proto.ExecResponse{ExitCode: -1, DurationMs: time.Since(start).Milliseconds()}
	out := buf.text()
	if timedOut {
		resp.TimedOut = true
		out += fmt.Sprintf("\n[stopped after %d s: the time limit]\n", int(timeout.Seconds()))
	}
	resp.Output, resp.Truncated = out, buf.cut
	if cmd.ProcessState != nil {
		resp.ExitCode = cmd.ProcessState.ExitCode()
	}
	return resp
}

func errMessage(err error) string {
	var ee *exec.Error
	if errors.As(err, &ee) {
		return ee.Err.Error()
	}
	return err.Error()
}

// tailBuffer keeps the last max bytes written.
type tailBuffer struct {
	max int
	buf []byte
	cut bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*t.max {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-t.max:]...)
		t.cut = true
	}
	return len(p), nil
}

// text is the kept output as valid UTF-8, Windows' line ends as \n.
func (t *tailBuffer) text() string {
	b := t.buf
	if len(b) > t.max {
		b, t.cut = b[len(b)-t.max:], true
	}
	s := strings.ReplaceAll(string(b), "\r\n", "\n")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	return s
}
