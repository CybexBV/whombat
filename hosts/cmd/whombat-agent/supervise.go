//go:build !windows

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/syslog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"rackoon/internal/agent"
)

// supervise supplies restart and signal handling on hosts without systemd.
// The PID file stays locked for the supervisor's lifetime; never unlink it,
// since a concurrent starter might already have opened the same inode.
func cmdSupervise(args []string) error {
	fs := flag.NewFlagSet("supervise", flag.ContinueOnError)
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	pidfile := fs.String("pid-file", "/run/whombat-agent.pid", "locked supervisor PID file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if _, err := agent.LoadConfig(*dir); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	var output io.Writer = os.Stderr
	if w, err := syslog.New(syslog.LOG_DAEMON|syslog.LOG_INFO, "whombat-agent"); err == nil {
		defer w.Close()
		output = w
	}
	return supervise(ctx, hup, *pidfile, output, 5*time.Second, 20*time.Second, func() *exec.Cmd {
		return exec.Command(exe, "run", "--config-dir", *dir)
	})
}

func supervise(ctx context.Context, hup <-chan os.Signal, pidfile string, output io.Writer, restartDelay, stopTimeout time.Duration, command func() *exec.Cmd) error {
	if err := os.MkdirAll(filepath.Dir(pidfile), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(pidfile, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another supervisor holds %s: %w", pidfile, err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.WriteString(strconv.Itoa(os.Getpid()) + "\n"); err != nil {
		return err
	}
	defer f.Truncate(0)

	for ctx.Err() == nil {
		cmd := command()
		cmd.Stdout, cmd.Stderr = output, output
		// Keep agent helpers in their own group so stopping also cleans up PTYs.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(output, "agent start failed: %v\n", err)
		} else {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			running := true
			for running {
				select {
				case <-ctx.Done():
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
					timer := time.NewTimer(stopTimeout)
					select {
					case <-done:
					case <-timer.C:
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
						<-done
					}
					timer.Stop()
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
					return nil
				case <-hup:
					_ = cmd.Process.Signal(syscall.SIGHUP)
				case err := <-done:
					// Clean up orphan helpers before starting another agent.
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
					if err != nil && !errors.Is(err, context.Canceled) {
						fmt.Fprintf(output, "agent exited: %v; restarting\n", err)
					}
					running = false
				}
			}
		}
		timer := time.NewTimer(restartDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
	return nil
}
