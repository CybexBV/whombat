package diagnose

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/agent/systemdrun"
	"rackoon/internal/proto"
)

// Exec limits (proto.ExecRequest).
const (
	ExecDefaultTimeout = 120 * time.Second
	ExecMaxTimeout     = 1800 * time.Second
	ExecMaxCommand     = 16 << 10
)

// ExecTimeout is the run time a request gets.
func ExecTimeout(timeoutS int) time.Duration {
	switch d := time.Duration(timeoutS) * time.Second; {
	case timeoutS <= 0:
		return ExecDefaultTimeout
	case d > ExecMaxTimeout:
		return ExecMaxTimeout
	default:
		return d
	}
}

// execEnv is the clean environment of the assistant's commands.
var execEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/root",
	"LANG=C.UTF-8",
	"USER=root",
	"LOGNAME=root",
	"SHELL=/bin/sh",
	"TERM=dumb",
	"SYSTEMD_COLORS=0",
	"DEBIAN_FRONTEND=noninteractive", // stdin is closed: no prompts
}

// execUnitArgv runs the command in a transient unit through systemd-run:
// outside the agent's sandbox (a read-only file system, no /root), killed
// by systemd when RuntimeMaxSec passes, with everything it started
// (KillMode=mixed: SIGTERM to the shell, SIGKILL to the rest 5 s later).
func execUnitArgv(shell, cmd string, timeout time.Duration) []string {
	argv := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect", "--pipe",
		"--service-type=exec", "--property=KillMode=mixed", "--property=TimeoutStopSec=5s",
		fmt.Sprintf("--property=RuntimeMaxSec=%ds", int(timeout.Seconds())),
		"--description=Whombat assistant command", "--working-directory=/root"}
	for _, e := range execEnv {
		argv = append(argv, "--setenv="+e)
	}
	return append(append(argv, "--"), systemdrun.Literal(shell, "-c", cmd)...)
}

// Exec implements agent.Diagnostics: cmd with /bin/sh -c as root, stdin
// closed, in root's home (/root, a Mac's /var/root; else /), with a clean
// environment; stdout and stderr
// as they interleave, the last MaxOutput bytes kept. Under systemd it runs
// in a transient unit (execUnitArgv); elsewhere in its own process group,
// killed as a whole when the time is up or the shell exits.
func (d *Diagnostics) Exec(ctx context.Context, req proto.ExecRequest) proto.ExecResponse {
	switch {
	case strings.TrimSpace(req.Command) == "":
		return proto.ExecResponse{Code: CodeInvalid, Message: "the command is empty", ExitCode: -1}
	case len(req.Command) > ExecMaxCommand:
		return proto.ExecResponse{Code: CodeInvalid, Message: fmt.Sprintf("the command is longer than %d KiB", ExecMaxCommand>>10), ExitCode: -1}
	case strings.IndexByte(req.Command, 0) >= 0:
		return proto.ExecResponse{Code: CodeInvalid, Message: "the command contains a NUL byte", ExitCode: -1}
	}
	timeout := ExecTimeout(req.TimeoutS)
	var argv []string
	dir := "/"
	limit := timeout
	home, environ := "/root", execEnv
	if d.home != "" {
		home = d.home
	}
	if d.execEnv != nil {
		environ = d.execEnv
	}
	if d.sandboxed {
		argv = execUnitArgv(d.shell, req.Command, timeout)
		limit += 10 * time.Second // systemd stops the unit; this only bounds systemd-run
	} else {
		argv = []string{d.shell, "-c", req.Command}
		if syscall.Access(home, 1 /* X_OK */) == nil {
			dir = home
		}
	}
	rctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(rctx, argv[0], argv[1:]...)
	cmd.Env = environ
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	// Background processes that keep the output open do not hold the
	// answer back for more than this.
	cmd.WaitDelay = 2 * time.Second
	buf := &capBuffer{max: MaxOutput, tail: true}
	cmd.Stdout, cmd.Stderr = buf, buf

	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)
	if !d.sandboxed && cmd.Process != nil {
		// What the command left running in the background ends with it, as
		// in a transient unit.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	resp := proto.ExecResponse{ExitCode: -1, DurationMs: elapsed.Milliseconds()}
	out := buf.bytes()
	resp.Output, resp.Truncated = finish(string(out), true, buf.cut)
	if cmd.ProcessState == nil {
		resp.Code = CodeFailed
		resp.Message = "the command could not be started: " + errMessage(err)
		return resp
	}
	resp.ExitCode = exitStatus(cmd.ProcessState)
	switch {
	case rctx.Err() != nil && ctx.Err() == nil:
		resp.TimedOut = true
	case d.sandboxed && resp.ExitCode != 0 && elapsed >= timeout-time.Second:
		// systemd-run exits 1 when RuntimeMaxSec stopped the unit.
		resp.TimedOut = true
	}
	if resp.TimedOut {
		resp.Output, resp.Truncated = finish(string(out)+fmt.Sprintf("\n[stopped after %d s: the time limit]\n", int(timeout.Seconds())), true, buf.cut)
	}
	return resp
}

func errMessage(err error) string {
	if err == nil {
		return "unknown error"
	}
	var ee *exec.Error
	if errors.As(err, &ee) {
		return ee.Err.Error()
	}
	return err.Error()
}
