//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"rackoon/internal/agent"
)

// runPlatform runs the agent in the foreground: SIGTERM and SIGINT end it,
// SIGHUP makes it read agent.toml again (systemctl reload, launchd, the
// supervisor).
func runPlatform(dir, level string) error {
	log := newLogger(level)
	slog.SetDefault(log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reload := make(chan struct{}, 1)
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		for {
			select {
			case <-stopped:
				return
			case s := <-sigs:
				if s == syscall.SIGHUP {
					select {
					case reload <- struct{}{}:
					default:
					}
					continue
				}
				log.Info("shutting down", "signal", s.String())
				cancel()
				return
			}
		}
	}()
	restartHook = func() { signal.Stop(sigs) }
	return runAgent(ctx, reload, dir, log)
}

// restartHook runs before the process restarts itself.
var restartHook = func() {}

// restartProcess starts the (new) executable in place of this process: on
// a Mac launchd started, by exiting (its LaunchDaemon keeps it alive); else
// by re-executing it, keeping the PID the service manager tracks.
func restartProcess(exe string, log *slog.Logger) error {
	restartHook()
	if restartByExit() {
		log.Warn("exiting so launchd starts the agent again", "executable", exe)
		return nil
	}
	log.Warn("re-executing the agent", "executable", exe)
	if err := agent.ReExec(exe); err != nil {
		// The service manager starts the (new) executable instead.
		return fmt.Errorf("re-exec %s: %w", exe, err)
	}
	return nil
}

// cmdService and cmdUninstall are the Windows service's; Linux and macOS
// install and remove the agent with install.sh.
func cmdService([]string) error {
	return errors.New("whombat-agent service is for Windows; here install.sh sets up the agent's service")
}

func cmdUninstall([]string) error {
	return errors.New("whombat-agent uninstall is for Windows; here run install.sh with --uninstall")
}

func serviceUsage() string { return "" }

// stopSignals end a command that waits (enroll).
func stopSignals() []os.Signal { return []os.Signal{os.Interrupt, syscall.SIGTERM} }

// prepareDirs: install.sh makes the agent's folders root's.
func prepareDirs(string, string) error { return nil }

// ownWrites: what root makes is root's.
func ownWrites() {}
