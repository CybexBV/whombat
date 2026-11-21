package pkgs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/agent/macos"
	"rackoon/internal/proto"
)

// A package task's files, in its own directory below the agent's state
// directory (the agent writes task.json; the runner, a separate process
// outside the agent, appends to log and writes result.json last, so an
// agent that restarted meanwhile finds the outcome).
const (
	SpecFile   = "task.json"
	LogFile    = "log"
	ResultFile = "result.json"
)

// Limits (SWU-04).
const (
	CheckLimit   = 10 * time.Minute
	InstallLimit = 2 * time.Hour
)

// Limit is how long a task may run.
func Limit(op string) time.Duration {
	if op == OpInstall {
		return InstallLimit
	}
	return CheckLimit
}

// TaskSpec is a package task as the agent starts it (task.json).
type TaskSpec struct {
	ID       string    `json:"id"`
	Op       string    `json:"op"` // check | install
	Manager  string    `json:"manager"`
	Packages []string  `json:"packages,omitempty"`
	Started  time.Time `json:"started"`
	// Server: the host's name in the sentences ("Another program is
	// installing packages on {server} right now.").
	Server string `json:"server,omitempty"`
	// Unit: the transient systemd unit running it; PID: the runner's
	// process without systemd.
	Unit string `json:"unit,omitempty"`
	PID  int    `json:"pid,omitempty"`
	// ConfigDir: the agent's configuration directory (a Mac's screen
	// account, for softwareupdate); "" = DefaultConfigDir.
	ConfigDir string `json:"config_dir,omitempty"`
}

// DefaultConfigDir is the agent's configuration directory by default.
const DefaultConfigDir = "/etc/whombat-agent"

// TaskResult statuses.
const (
	StatusOK     = "ok"
	StatusFailed = "failed"
)

// TaskResult is the end of a package task (result.json).
type TaskResult struct {
	Status  string `json:"status"` // ok | failed
	Message string `json:"message"`
	Code    string `json:"code,omitempty"` // busy | timeout
	// Installed: install only, nil when the agent couldn't count.
	Installed *int      `json:"installed,omitempty"`
	KeptBack  []string  `json:"kept_back,omitempty"`
	Warning   string    `json:"warning,omitempty"`
	Waiting   *int      `json:"waiting,omitempty"` // updates waiting afterwards
	Finished  time.Time `json:"finished"`
}

// keptBackMax bounds TaskResult.KeptBack.
const keptBackMax = 50

// ReadSpec reads a task's task.json.
func ReadSpec(dir string) (*TaskSpec, error) {
	var s TaskSpec
	if err := readJSON(filepath.Join(dir, SpecFile), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// WriteSpec writes task.json.
func WriteSpec(dir string, s *TaskSpec) error { return writeJSON(filepath.Join(dir, SpecFile), s) }

// ReadResult reads result.json; nil while the task runs.
func ReadResult(dir string) (*TaskResult, error) {
	var r TaskResult
	if err := readJSON(filepath.Join(dir, ResultFile), &r); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return &r, nil
}

// WriteResult writes result.json atomically (once: an existing result
// stays).
func WriteResult(dir string, r *TaskResult) error {
	p := filepath.Join(dir, ResultFile)
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	return writeJSON(p, r)
}

func readJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(p string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Runner runs one package task: `whombat-agent package-task --dir DIR` in
// a transient systemd unit, or in its own session without systemd.
type Runner struct {
	Dir string
	// Check reads the waiting updates (pkgs.Check; tests replace it).
	Check func(ctx context.Context) (*Pending, error)
	// Exec runs one step's command, its output to w (tests replace it);
	// the exit status is returned (-1 when it couldn't run). ExecInput
	// does the same for a step with input on stdin.
	Exec      func(ctx context.Context, argv []string, w io.Writer) (int, error)
	ExecInput func(ctx context.Context, argv []string, stdin []byte, w io.Writer) (int, error)
	// LockHeld and LockPoll: the package lock (tests make them quick).
	LockHeld func() (bool, string)
	LockPoll time.Duration
	LockWait time.Duration
	// Host is read once at the start (tests set it).
	Host *Host
	Now  func() time.Time
	// Stop is closed when someone asked the task to stop (SIGTERM): a
	// check stops, an install carries on (dpkg must not stop halfway).
	Stop <-chan struct{}

	log *os.File
	mu  sync.Mutex
}

// Pending is the waiting updates as the runner counts them.
type Pending struct {
	Names    []string
	Security int
	SecKnown bool
}

// checkNow is Runner.Check's default: the package manager's cache.
func checkNow(ctx context.Context) (*Pending, error) {
	r, err := Check(ctx)
	if err != nil {
		return nil, err
	}
	out := &Pending{SecKnown: r.SecurityKnown, Security: r.Security()}
	for _, u := range r.Updates {
		out.Names = append(out.Names, u.Name)
	}
	return out, nil
}

// Run runs the task to its end and writes result.json. It returns an
// error only when it could not write the result.
func (r *Runner) Run(ctx context.Context) error {
	spec, err := ReadSpec(r.Dir)
	if err != nil {
		return fmt.Errorf("read the task: %w", err)
	}
	if r.Check == nil {
		r.Check = checkNow
	}
	if r.Exec == nil {
		r.Exec = execStep
	}
	if r.ExecInput == nil {
		r.ExecInput = execStepInput
	}
	if r.LockHeld == nil {
		m := spec.Manager
		r.LockHeld = func() (bool, string) { return LockHeld(m) }
	}
	if r.LockPoll == 0 {
		r.LockPoll = 2 * time.Second
	}
	if r.LockWait == 0 {
		r.LockWait = LockWait * time.Second
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	f, err := os.OpenFile(filepath.Join(r.Dir, LogFile), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open the log: %w", err)
	}
	defer f.Close()
	r.log = f

	limit := Limit(spec.Op)
	deadline := spec.Started.Add(limit)
	if spec.Started.IsZero() || deadline.Before(r.Now()) {
		deadline = r.Now().Add(limit)
	}
	tctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	// A check stops when asked; an install doesn't.
	if r.Stop != nil && spec.Op == OpCheck {
		go func() {
			select {
			case <-r.Stop:
				cancel()
			case <-tctx.Done():
			}
		}()
	} else if r.Stop != nil {
		go func() {
			select {
			case <-r.Stop:
				r.logf("Asked to stop: installing updates can’t be stopped halfway, so it carries on.")
			case <-tctx.Done():
			}
		}()
	}
	res := r.run(tctx, spec, limit)
	res.Finished = r.Now().UTC()
	if res.Status == StatusFailed && res.Message != "" {
		r.logf("%s", res.Message)
	}
	return WriteResult(r.Dir, res)
}

func (r *Runner) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.log != nil {
		fmt.Fprintf(r.log, format+"\n", args...)
	}
}

// run does the steps; the result's Finished is set by the caller.
func (r *Runner) run(ctx context.Context, spec *TaskSpec, limit time.Duration) *TaskResult {
	host := Host{}
	if r.Host != nil {
		host = *r.Host
	} else {
		host = HostOf(spec.Manager)
		if spec.Manager == SoftwareUpdate && spec.Op == OpInstall && host.AppleSilicon {
			dir := spec.ConfigDir
			if dir == "" {
				dir = DefaultConfigDir
			}
			u, pw, err := ReadScreenAccount(dir)
			switch {
			case err == nil:
				host.ScreenUser, host.ScreenPassword = u, pw
			case !errors.Is(err, os.ErrNotExist):
				r.logf("(the Mac's screen account can't be used: %v)", err)
			}
		}
	}
	steps, err := Plan(spec.Manager, spec.Op, spec.Packages, host)
	if err != nil {
		return &TaskResult{Status: StatusFailed, Message: firstUpper(err.Error()) + "."}
	}
	stopped := func() *TaskResult {
		if errors.Is(context.Cause(ctx), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			what := "Checking for updates"
			if spec.Op == OpInstall {
				what = "Installing updates"
			}
			return &TaskResult{Status: StatusFailed, Code: proto.TaskCodeTimeout,
				Message: fmt.Sprintf("%s took longer than %s and was stopped.", what, limitWords(limit))}
		}
		return &TaskResult{Status: StatusFailed, Message: "Checking for updates was stopped."}
	}
	res := &TaskResult{Status: StatusOK}
	var before *Pending
	upgradeOut := ""
	for _, st := range steps {
		if busy := r.waitLock(ctx, spec); busy != nil {
			return busy
		}
		if ctx.Err() != nil {
			return stopped()
		}
		if st.Kind == StepUpgrade {
			// What waits now, after the refresh: the install's count.
			if b, err := r.Check(ctx); err == nil {
				before = b
			} else {
				r.logf("(could not list the waiting updates before installing: %v)", err)
			}
		}
		r.logf("$ %s", strings.Join(st.Argv, " "))
		var buf tailBuffer
		var code int
		var err error
		if st.Stdin != nil {
			code, err = r.ExecInput(ctx, st.Argv, st.Stdin, io.MultiWriter(r.log, &buf))
		} else {
			code, err = r.Exec(ctx, st.Argv, io.MultiWriter(r.log, &buf))
		}
		out := buf.String()
		if ctx.Err() != nil {
			res = stopped()
			if st.Kind == StepUpgrade {
				r.count(spec, before, res, out)
			}
			return res
		}
		if err != nil && code < 0 {
			return &TaskResult{Status: StatusFailed, Message: fmt.Sprintf("Could not run %s: %v.", filepath.Base(st.Argv[0]), err)}
		}
		if st.Kind == StepRefresh && spec.Manager == APT {
			warn, fail := RefreshOutcome(out, code)
			res.Warning = warn
			if fail == "" {
				continue
			}
			if IsLockError(out) {
				return r.busy(spec)
			}
			// Stopped: "the other repositories were used" isn't true then.
			return &TaskResult{Status: StatusFailed, Message: fail}
		}
		if code != 0 {
			if IsLockError(out) {
				return r.busy(spec)
			}
			failed := &TaskResult{Status: StatusFailed, Message: LastLine(out), Warning: res.Warning}
			if failed.Message == "" {
				failed.Message = fmt.Sprintf("%s ended with exit status %d.", filepath.Base(st.Argv[0]), code)
			}
			if st.Kind == StepUpgrade {
				r.count(spec, before, failed, out)
			}
			return failed
		}
		if st.Kind == StepUpgrade {
			upgradeOut = out
			if spec.Manager == SoftwareUpdate && NeedsRestart(out) {
				res.Warning = "The Mac needs a restart to finish installing."
				if err := macos.WriteRestartNeeded(filepath.Dir(r.Dir), r.Now()); err != nil {
					r.logf("(could not note that the Mac needs a restart: %v)", err)
				}
			}
		}
	}
	if spec.Op == OpCheck {
		after, err := r.Check(ctx)
		if err != nil {
			return &TaskResult{Status: StatusFailed, Message: firstUpper(err.Error()) + ".", Warning: res.Warning}
		}
		n := len(after.Names)
		res.Waiting = &n
		res.Message = waitingWords(n, after)
		return res
	}
	r.count(spec, before, res, upgradeOut)
	switch {
	case res.Installed == nil:
		res.Message = "Installed the updates."
	case *res.Installed == 0:
		res.Message = "Nothing to install."
	case *res.Installed == 1:
		res.Message = "Installed 1 update."
	default:
		res.Message = fmt.Sprintf("Installed %d updates.", *res.Installed)
	}
	return res
}

// count sets Installed, KeptBack and Waiting from the waiting updates
// before and after the install.
func (r *Runner) count(spec *TaskSpec, before *Pending, res *TaskResult, out string) {
	after, err := r.Check(context.WithoutCancel(context.Background()))
	if err != nil {
		r.logf("(could not list the waiting updates afterwards: %v)", err)
		if n, ok := InstalledFromOutput(spec.Manager, out); ok {
			res.Installed = &n
		}
		return
	}
	n := len(after.Names)
	res.Waiting = &n
	still := map[string]bool{}
	for _, name := range after.Names {
		still[name] = true
	}
	if before != nil {
		installed := 0
		for _, name := range before.Names {
			if len(spec.Packages) > 0 && !slices.Contains(spec.Packages, name) {
				continue
			}
			if !still[name] {
				installed++
			}
		}
		res.Installed = &installed
	}
	if n, ok := InstalledFromOutput(spec.Manager, out); ok && (res.Installed == nil || n > *res.Installed) {
		res.Installed = &n
	}
	keep := func(name string) {
		if len(res.KeptBack) < keptBackMax && !slices.Contains(res.KeptBack, name) {
			res.KeptBack = append(res.KeptBack, name)
		}
	}
	for _, name := range after.Names {
		if len(spec.Packages) > 0 && !slices.Contains(spec.Packages, name) {
			continue
		}
		if before != nil && !slices.Contains(before.Names, name) {
			continue // new since: not one the install was asked for
		}
		keep(name)
	}
	// What the manager says it kept back (held packages never count as
	// waiting).
	for _, name := range KeptBackFromOutput(spec.Manager, out) {
		keep(name)
	}
}

// waitLock waits while another program holds the package lock, up to
// LockWait; then the task gives up (busy).
func (r *Runner) waitLock(ctx context.Context, spec *TaskSpec) *TaskResult {
	held, file := r.LockHeld()
	if !held {
		return nil
	}
	r.logf("Waiting for another program to finish with the package lock (%s)…", file)
	deadline := time.Now().Add(r.LockWait)
	t := time.NewTicker(r.LockPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil // the caller reports the stop
		case <-t.C:
		}
		if held, _ = r.LockHeld(); !held {
			return nil
		}
		if time.Now().After(deadline) {
			return r.busy(spec)
		}
	}
}

func (r *Runner) busy(spec *TaskSpec) *TaskResult {
	server := spec.Server
	if server == "" {
		server = "this server"
	}
	return &TaskResult{Status: StatusFailed, Code: proto.TaskCodeBusy,
		Message: fmt.Sprintf("Another program is installing packages on %s right now. Try again in a few minutes.", server)}
}

func waitingWords(n int, r *Pending) string {
	switch {
	case n == 0:
		return "No updates waiting."
	case r.SecKnown && r.Security > 0 && n == 1:
		return "1 update waiting, for security."
	case r.SecKnown && r.Security > 0:
		return fmt.Sprintf("%d updates waiting, %d for security.", n, r.Security)
	case n == 1:
		return "1 update waiting."
	}
	return fmt.Sprintf("%d updates waiting.", n)
}

func limitWords(d time.Duration) string {
	if d >= time.Hour && d%time.Hour == 0 {
		if d == time.Hour {
			return "an hour"
		}
		return fmt.Sprintf("%d hours", int(d/time.Hour))
	}
	return fmt.Sprintf("%d minutes", int(d/time.Minute))
}

func firstUpper(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), ".")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// execStep runs argv in its own process group with the package
// environment, stdin closed; when ctx ends the group gets SIGTERM, then
// SIGKILL 30 s later.
func execStep(ctx context.Context, argv []string, w io.Writer) (int, error) {
	p, err := lookPath(argv[0])
	if err != nil {
		return -1, err
	}
	cmd := exec.CommandContext(ctx, p, argv[1:]...)
	cmd.Env = stepEnv()
	cmd.Dir = "/"
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 30 * time.Second
	err = cmd.Run()
	if cmd.ProcessState == nil {
		return -1, err
	}
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // what it left behind
	}
	return cmd.ProcessState.ExitCode(), nil
}

// stepEnv is Env, or on a Mac macOS's own clean environment.
func stepEnv() []string {
	if runtime.GOOS == "darwin" {
		return macos.Env
	}
	return Env
}

// execStepInput is execStep with stdin (softwareupdate's password).
func execStepInput(ctx context.Context, argv []string, stdin []byte, w io.Writer) (int, error) {
	p, err := lookPath(argv[0])
	if err != nil {
		return -1, err
	}
	cmd := exec.CommandContext(ctx, p, argv[1:]...)
	cmd.Env = stepEnv()
	cmd.Dir = "/"
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = 30 * time.Second
	err = cmd.Run()
	if cmd.ProcessState == nil {
		return -1, err
	}
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	return cmd.ProcessState.ExitCode(), nil
}

// restartWords are what softwareupdate prints when an installed update
// finishes at the next restart.
var restartWords = []string{"restart required", "please restart", "requires restarting", "restart to complete", "restart your computer", "needs to restart"}

// NeedsRestart: softwareupdate says the Mac must restart to finish.
func NeedsRestart(out string) bool {
	l := strings.ToLower(out)
	for _, w := range restartWords {
		if strings.Contains(l, w) {
			return true
		}
	}
	return false
}

// tailBuffer keeps the last 256 KiB a step printed (its outcome is read
// from it; the whole output is in the log).
type tailBuffer struct {
	mu sync.Mutex
	b  []byte
}

const tailMax = 256 << 10

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > tailMax {
		t.b = bytes.Clone(t.b[len(t.b)-tailMax:])
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}
