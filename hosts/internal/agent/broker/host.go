package broker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// HostID is the guest id of the host itself (Platform proto.PlatformHost).
const HostID = "host"

// hostPowerDelay lets the action answer reach the hub before the host goes
// down.
const hostPowerDelay = 3 * time.Second

// underSystemd reports whether the agent runs as a systemd service (and
// may be sandboxed): helpers that must not inherit the sandbox (host
// shells, guest starts) then run in a transient unit through systemd-run.
func underSystemd() bool {
	return os.Getenv("INVOCATION_ID") != "" && fileExists("/usr/bin/systemd-run")
}

func isSystemdHost() bool {
	fi, err := os.Stat("/run/systemd/system")
	return err == nil && fi.IsDir()
}

func isUnraid() bool { return fileExists("/etc/unraid-version") }

// hostPowerCommands returns the commands to try, in order, for a host
// reboot or shutdown. Unraid's /sbin/reboot and /sbin/poweroff run its
// clean-shutdown scripts (array stop); systemd hosts use systemctl.
func hostPowerCommands(action string) [][]string {
	verb, tool := "reboot", "reboot"
	if action == proto.ActionHostShutdown {
		verb, tool = "poweroff", "poweroff"
	}
	var cmds [][]string
	if isSystemdHost() && !isUnraid() {
		for _, p := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
			if fileExists(p) {
				cmds = append(cmds, []string{p, verb})
				break
			}
		}
	}
	for _, p := range []string{"/sbin/" + tool, "/usr/sbin/" + tool} {
		if fileExists(p) {
			cmds = append(cmds, []string{p})
			break
		}
	}
	return cmds
}

// runHostCommand runs a host power command (tests replace it).
func runHostCommand(argv []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = baseEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, lastLine(string(out)))
	}
	return nil
}

// hostAction answers first and reboots or shuts down the host after
// hostPowerDelay.
func (b *Broker) hostAction(req proto.ActionRequest) proto.ActionResponse {
	if req.GuestID != HostID {
		return proto.ActionResponse{Code: CodeInvalid, Message: `host actions need guest "host"`}
	}
	var state, what string
	switch req.Action {
	case proto.ActionHostReboot:
		state, what = "rebooting", "reboot"
	case proto.ActionHostShutdown:
		state, what = "shutting_down", "shutdown"
	default:
		return proto.ActionResponse{Code: CodeUnsupportedAction, Message: fmt.Sprintf("action %q is not available for the host", req.Action)}
	}
	cmds := b.hostCommands(req.Action)
	if len(cmds) == 0 {
		return proto.ActionResponse{Code: CodeUnsupportedAction, Message: "no " + what + " command found on this host"}
	}
	b.hostMu.Lock()
	defer b.hostMu.Unlock()
	if b.hostPending != "" {
		return proto.ActionResponse{OK: true, Noop: true, State: b.hostPending}
	}
	b.hostPending = state
	b.log.Warn("HOST "+what+" requested through the hub; it runs in a few seconds", "delay", b.hostDelay, "commands", cmds)
	time.AfterFunc(b.hostDelay, func() {
		var err error
		for _, argv := range cmds {
			b.log.Warn("running host "+what, "command", argv)
			if err = b.hostRun(argv); err == nil {
				return
			}
			b.log.Error("host "+what+" command failed", "command", argv, "err", err)
		}
		b.hostMu.Lock()
		b.hostPending = ""
		b.hostMu.Unlock()
	})
	return proto.ActionResponse{OK: true, State: state, Message: fmt.Sprintf("The host will %s in %d s", what, int(b.hostDelay.Seconds()))}
}

// hostConsole opens the host's root shell or its log.
func (b *Broker) hostConsole(ctx context.Context, req proto.ConsoleRequest) (agent.ConsoleSession, proto.ConsoleResponse) {
	if req.GuestID != HostID {
		return nil, proto.ConsoleResponse{Code: CodeInvalid, Message: `host consoles need guest "host"`}
	}
	var sess agent.ConsoleSession
	var err error
	switch req.Protocol {
	case proto.ProtoShell:
		sess, err = hostShell(req)
	case proto.ProtoLogs:
		sess, err = hostLogs()
	default:
		err = codeErr(CodeUnsupportedProtocol, "the host has shell and logs")
	}
	if err != nil {
		code, msg := errCode(err, CodeOpenFailed)
		return nil, proto.ConsoleResponse{Code: code, Message: msg}
	}
	return sess, proto.ConsoleResponse{OK: true}
}

func loginShell() string {
	for _, sh := range []string{"/bin/bash", "/usr/bin/bash", "/bin/sh"} {
		if fileExists(sh) {
			return sh
		}
	}
	return "/bin/sh"
}

// hostShellArgv is a root login shell, in a transient unit when the agent
// runs under systemd (the shell must not inherit the agent's sandbox: a
// read-only file system and no /root).
func hostShellArgv(shell string, systemd bool) []string {
	if !systemd {
		return []string{shell, "-l"}
	}
	return []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect", "--pty",
		"--service-type=exec", "--property=KillMode=mixed",
		"--description=Whombat host shell", "--working-directory=/root",
		"--setenv=TERM=xterm-256color", "--setenv=HOME=/root", "--setenv=USER=root",
		"--setenv=LOGNAME=root", "--setenv=SHELL=" + shell, "--setenv=LANG=C.UTF-8",
		"--", shell, "-l"}
}

func hostShell(req proto.ConsoleRequest) (agent.ConsoleSession, error) {
	shell := loginShell()
	argv := hostShellArgv(shell, underSystemd())
	dir := "/root"
	if syscall.Access(dir, 1 /* X_OK */) != nil {
		dir = "/"
	}
	p, err := startPTYDir(argv, baseEnv("USER=root", "LOGNAME=root", "SHELL="+shell), dir, req.Cols, req.Rows)
	if err != nil {
		return nil, codeErr(CodeOpenFailed, err.Error())
	}
	return p.session(proto.ProtoShell), nil
}

// hostLogArgv follows the systemd journal, or the syslog files without
// journald.
func hostLogArgv() ([]string, error) {
	if isSystemdHost() {
		for _, p := range []string{"/usr/bin/journalctl", "/bin/journalctl"} {
			if fileExists(p) {
				return []string{p, "--no-pager", "-f", "-n", "300", "--no-hostname", "-o", "short-iso"}, nil
			}
		}
	}
	var files []string
	for _, f := range []string{"/var/log/syslog", "/var/log/messages"} {
		if fileExists(f) {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return nil, codeErr(CodeProtocolUnavailable, "this host has neither journald nor /var/log/syslog or /var/log/messages")
	}
	return append([]string{"tail", "-n", "300", "-F"}, files...), nil
}

func hostLogs() (agent.ConsoleSession, error) {
	argv, err := hostLogArgv()
	if err != nil {
		return nil, err
	}
	return startLogCommand(argv, "-- the log command ended --")
}

// startLogCommand runs argv with its output (stdout and stderr) as a
// read-only log session.
func startLogCommand(argv []string, endNote string) (agent.ConsoleSession, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, codeErr(CodeOpenFailed, err.Error())
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = baseEnv("SYSTEMD_COLORS=0")
	cmd.Dir = "/"
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return nil, codeErr(CodeOpenFailed, err.Error())
	}
	w.Close()
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	return &logSession{
		protocol: proto.ProtoLogs,
		src:      r,
		endNote:  endNote,
		closeSrc: func() {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				<-done
			}
			r.Close()
		},
	}, nil
}
