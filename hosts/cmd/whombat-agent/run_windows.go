package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"

	"rackoon/internal/agent"
)

// serviceName is the agent's Windows service.
const serviceName = "whombat-agent"

// Exit codes the service reports to the service manager. Any code but 0
// counts as a failure, and the service's recovery actions (set by
// `whombat-agent service install`) start it again.
const (
	exitRestart = 1 // an update or a rollback: start the new executable
	exitFailed  = 2 // the agent couldn't run
)

// runPlatform runs the agent as the Windows service, or, started from a
// console, in the foreground until Ctrl+C.
func runPlatform(dir, level string) error {
	isService, err := svc.IsWindowsService()
	if err != nil {
		return fmt.Errorf("cannot tell whether this runs as a service: %w", err)
	}
	if exe, err := agent.ExecutablePath(); err == nil {
		agent.RemoveAsideExecutables(exe)
	}
	if isService {
		return svc.Run(serviceName, &service{dir: dir, level: level})
	}
	// In a console too, the agent reads nothing of its folder before it
	// made it its own.
	if err := prepareDirs(dir, ""); err != nil {
		return err
	}
	log := newLogger(level)
	slog.SetDefault(log)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	err = runAgent(ctx, nil, dir, log)
	if errors.Is(err, agent.ErrRestart) {
		// No service manager restarts a console's agent: start the new
		// executable here and pass on how it ends.
		cancel()
		return runAgain()
	}
	return err
}

// runAgain runs the agent's executable (an update's) with this process's
// arguments and exits with its exit code.
func runAgain() error {
	exe, err := agent.ExecutablePath()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	return nil
}

// restartProcess: Windows can't replace a running process, so the agent
// ends and its service starts again (see runPlatform).
func restartProcess(exe string, log *slog.Logger) error {
	log.Warn("ending so the service starts the agent again", "executable", exe)
	return agent.ErrRestart
}

// service is the agent as a Windows service: Stop and Shutdown end it,
// ParamChange (`sc.exe control whombat-agent paramchange`) makes it read
// agent.toml again, as SIGHUP does elsewhere.
type service struct {
	dir, level string
}

func (s *service) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	if err := prepareDirs(s.dir, ""); err != nil {
		// Nothing in the agent's folder can be trusted, its log neither:
		// Windows' own event log says why the agent stopped.
		eventLog(windows.EVENTLOG_ERROR_TYPE, "The Whombat agent stopped before it started: "+err.Error())
		return true, exitFailed
	}
	logf, err := openServiceLog()
	var w io.Writer = io.Discard
	if err == nil {
		defer logf.Close()
		w = logf
	}
	log := newLoggerTo(w, s.level)
	slog.SetDefault(log)
	if err != nil {
		// Without its log the agent still runs.
		log.Warn("cannot open the log file", "err", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reload := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() { done <- runAgent(ctx, reload, s.dir, log) }()
	const accepts = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptParamChange
	status <- svc.Status{State: svc.Running, Accepts: accepts}
	stopping := false
	for {
		select {
		case err := <-done:
			status <- svc.Status{State: svc.StopPending}
			switch {
			case stopping:
				return false, 0
			case errors.Is(err, agent.ErrRestart):
				log.Info("restarting through the service manager")
				return true, exitRestart
			case err != nil:
				log.Error("the agent stopped", "err", err)
				return true, exitFailed
			}
			// The agent ended by itself without an error (it doesn't):
			// start it again all the same.
			return true, exitRestart
		case r := <-req:
			switch r.Cmd {
			case svc.Interrogate:
				status <- r.CurrentStatus
			case svc.Stop, svc.Shutdown:
				if !stopping {
					log.Info("shutting down", "control", r.Cmd)
					stopping = true
					cancel()
				}
				status <- svc.Status{State: svc.StopPending}
			case svc.ParamChange:
				select {
				case reload <- struct{}{}:
				default:
				}
				status <- svc.Status{State: svc.Running, Accepts: accepts}
			}
		}
	}
}

// eventLog writes msg to Windows' Application log as an error or a warning
// (kind) of the agent's service (Event Viewer, Windows Logs, Application).
func eventLog(kind uint16, msg string) {
	src, err := windows.UTF16PtrFromString(serviceName)
	if err != nil {
		return
	}
	text, err := windows.UTF16PtrFromString(msg)
	if err != nil {
		return
	}
	h, err := windows.RegisterEventSource(nil, src)
	if err != nil {
		return
	}
	defer windows.DeregisterEventSource(h)
	_ = windows.ReportEvent(h, kind, 0, 1, 0, 1, 0, &text, nil)
}

// logMax is the size of the service's log before it starts a new one (the
// last one stays as whombat-agent.log.1).
const logMax = 10 << 20

// openServiceLog opens the service's log in %ProgramData%\Whombat\logs and
// sends the Go runtime's own last words (a panic) to crash.log beside it.
func openServiceLog() (*rotatingFile, error) {
	dir := filepath.Join(agent.WindowsDataDir, "logs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if f, err := os.OpenFile(filepath.Join(dir, "crash.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		_ = windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
	}
	return openRotating(filepath.Join(dir, "whombat-agent.log"), logMax)
}

// rotatingFile is a log file that moves itself to path.1 once it holds max
// bytes.
type rotatingFile struct {
	mu   sync.Mutex
	path string
	max  int64
	f    *os.File
	size int64
}

func openRotating(path string, max int64) (*rotatingFile, error) {
	r := &rotatingFile{path: path, max: max}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, fi.Size()
	return nil
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return 0, os.ErrClosed
	}
	if r.size+int64(len(p)) > r.max && r.size > 0 {
		r.f.Close()
		_ = os.Remove(r.path + ".1")
		_ = os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			r.f = nil
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *rotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// stopSignals end a command that waits (enroll): Ctrl+C.
func stopSignals() []os.Signal { return []os.Signal{os.Interrupt} }
