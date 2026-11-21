package broker

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/proto"
)

// The agent's task registry for unRAID commands (docs/MANAGE.md 2.6): a
// task "unraid:<16 hex>" runs the command (and, where the command only
// starts something, follows unRAID's state until it is done), with its
// output as the task log. Tasks are kept in memory for a day after they
// end; their log files live in the agent's state directory (RAM on
// unRAID). Commands run in their own session and write to the file, so
// an agent restart does not stop them (the task is then unknown).
const (
	unraidTaskKeep     = 24 * time.Hour
	unraidTaskLogMax   = 500     // lines per task.status answer
	unraidTaskLogBytes = 2 << 20 // the log's tail read for task.status
)

// unraidTask is one task.
type unraidTask struct {
	id, op, guest, key string
	started            time.Time
	ended              *time.Time
	status             string // running | ok | error
	message            string
	logPath            string
}

// unraidTasks is the registry.
type unraidTasks struct {
	mu    sync.Mutex
	dir   string // log directory
	tasks map[string]*unraidTask
	mask  func(string) string
	// onEnd runs after a task ended (the runtime reads unRAID's state again).
	onEnd func()
	now   func() time.Time
}

func newUnraidTasks(dir string) *unraidTasks {
	return &unraidTasks{dir: dir, tasks: map[string]*unraidTask{}, mask: maskSecrets, now: time.Now}
}

// unraidRun is a running task's handle for its steps.
type unraidRun struct {
	t    *unraidTask
	reg  *unraidTasks
	env  []string
	logf func(format string, args ...any)
}

// busy reports a running task with the key (one array / parity, plugin or
// mover command at a time; one update per container).
func (r *unraidTasks) busy(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		if t.key == key && t.status == "running" {
			return true
		}
	}
	return false
}

// start registers a task and runs its steps in the background. The
// steps' answer is the task's message; an error fails the task with its
// text.
func (r *unraidTasks) start(op, guest, key string, env []string, steps func(ctx context.Context, run *unraidRun) (string, error)) (string, error) {
	r.mu.Lock()
	r.expireLocked()
	for _, t := range r.tasks {
		if t.key == key && t.status == "running" {
			r.mu.Unlock()
			return "", codeErr(CodeBusy, "Another "+unraidKeyWords(key)+" is still running.")
		}
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	id := proto.UnraidTaskPrefix + hex.EncodeToString(b[:])
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		r.mu.Unlock()
		return "", codeErr(CodePlatformError, "cannot keep the task's log: "+err.Error())
	}
	t := &unraidTask{id: id, op: op, guest: guest, key: key, started: r.now().UTC(), status: "running",
		logPath: filepath.Join(r.dir, strings.ReplaceAll(id, ":", "-")+".log")}
	f, err := os.OpenFile(t.logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		r.mu.Unlock()
		return "", codeErr(CodePlatformError, "cannot keep the task's log: "+err.Error())
	}
	f.Close()
	r.tasks[id] = t
	r.mu.Unlock()

	run := &unraidRun{t: t, reg: r, env: env}
	run.logf = func(format string, args ...any) { run.appendLog(fmt.Sprintf(format, args...)) }
	go func() {
		msg, err := safeSteps(steps, run)
		now := r.now().UTC()
		r.mu.Lock()
		t.ended = &now
		if err != nil {
			t.status, t.message = "error", truncateText(r.mask(firstLineOf(err.Error())), 500)
		} else {
			t.status, t.message = "ok", truncateText(msg, 500)
		}
		onEnd := r.onEnd
		r.mu.Unlock()
		if err != nil {
			run.logf("%s", t.message)
		}
		if onEnd != nil {
			onEnd()
		}
	}()
	return id, nil
}

func safeSteps(steps func(context.Context, *unraidRun) (string, error), run *unraidRun) (msg string, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("the task failed: %v", p)
		}
	}()
	return steps(context.Background(), run)
}

func unraidKeyWords(key string) string {
	switch {
	case key == "array":
		return "array or parity command"
	case key == "plugin":
		return "plugin check or update"
	case key == "mover":
		return "mover run"
	case key == "containers":
		return "container check"
	case strings.HasPrefix(key, "container:"):
		return "update of this container"
	}
	return "command like this"
}

func (r *unraidRun) appendLog(line string) {
	f, err := os.OpenFile(r.t.logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = io.WriteString(f, strings.TrimRight(line, "\n")+"\n")
}

// command runs argv to its end in its own session, its output appended
// to the task's log. A non-zero exit is an error with the last line the
// command printed.
func (r *unraidRun) command(argv ...string) error {
	r.logf("$ %s", strings.Join(argv, " "))
	f, err := os.OpenFile(r.t.logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("cannot write the task's log: %w", err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = r.env
	cmd.Dir = "/"
	cmd.Stdout, cmd.Stderr = f, f
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	err = cmd.Run()
	f.Close()
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if last := r.lastLine(); last != "" && !strings.HasPrefix(last, "$ ") {
			return fmt.Errorf("%s", last)
		}
		return fmt.Errorf("%s ended with exit status %d", filepath.Base(argv[0]), ee.ExitCode())
	}
	return fmt.Errorf("cannot run %s: %w", filepath.Base(argv[0]), err)
}

// lastLine is the log's last non-empty line.
func (r *unraidRun) lastLine() string {
	lines := r.reg.readLog(r.t.logPath)
	for i := len(lines) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			return s
		}
	}
	return ""
}

// wait polls cond every interval until it answers done or the time is
// up (an error then, saying what it waited for).
func (r *unraidRun) wait(ctx context.Context, what string, limit, interval time.Duration, cond func() (bool, error)) error {
	deadline := time.Now().Add(limit)
	for {
		done, err := cond()
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Unraid didn’t %s within %s", what, limit.Round(time.Second))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]|<[^>]{1,200}>`)

// readLog reads the log's lines (its tail when long), progress lines
// (\r) split, terminal escapes and HTML tags (dockerMan's output) taken
// out, secrets masked.
func (r *unraidTasks) readLog(path string) []string { return readTaskLog(path, r.mask) }

// readTaskLog reads a task log file the way readLog describes (unRAID and
// package tasks).
func readTaskLog(path string, mask func(string) string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > unraidTaskLogBytes {
		_, _ = f.Seek(st.Size()-unraidTaskLogBytes, io.SeekStart)
	}
	b, _ := io.ReadAll(io.LimitReader(f, unraidTaskLogBytes))
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	var out []string
	for _, l := range strings.FieldsFunc(string(b), func(c rune) bool { return c == '\n' || c == '\r' }) {
		l = strings.TrimRight(ansiRe.ReplaceAllString(l, ""), " \t")
		if strings.TrimSpace(l) == "" {
			continue
		}
		out = append(out, truncateText(mask(l), 1000))
	}
	return out
}

// status answers task.status.
func (r *unraidTasks) status(id string, logStart int) (*proto.TaskStatus, bool) {
	r.mu.Lock()
	r.expireLocked()
	t, ok := r.tasks[id]
	if !ok {
		r.mu.Unlock()
		return nil, false
	}
	st := r.statusLocked(t)
	path := t.logPath
	r.mu.Unlock()
	if logStart >= 0 {
		lines := r.readLog(path)
		if logStart > len(lines) {
			logStart = len(lines)
		}
		end := min(len(lines), logStart+unraidTaskLogMax)
		st.Log = lines[logStart:end]
		st.LogNext = end
	}
	return &st, true
}

func (r *unraidTasks) statusLocked(t *unraidTask) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.id, Type: t.op, GuestID: t.guest, User: "root", Started: t.started, Status: t.status, Message: t.message}
	if t.ended != nil {
		e := *t.ended
		st.Ended = &e
	}
	return st
}

// list answers task.list: the tasks of the last day, newest first (a
// guest's only when guest is set).
func (r *unraidTasks) list(guest string) []proto.TaskStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expireLocked()
	out := []proto.TaskStatus{}
	for _, t := range r.tasks {
		if guest == "" || t.guest == guest {
			out = append(out, r.statusLocked(t))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Started.Equal(out[j].Started) {
			return out[i].Started.After(out[j].Started)
		}
		return out[i].ID > out[j].ID
	})
	return out
}

// expireLocked drops tasks that ended more than a day ago, and their logs.
func (r *unraidTasks) expireLocked() {
	cut := r.now().Add(-unraidTaskKeep)
	for id, t := range r.tasks {
		if t.ended != nil && t.ended.Before(cut) {
			_ = os.Remove(t.logPath)
			delete(r.tasks, id)
		}
	}
}

// maskSecrets hides secret-looking key=value pairs and passwords in URLs
// in a log line (the commands print none we know of; this is a net).
var (
	secretKVRe  = regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|csrf|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)`)
	urlSecretRe = regexp.MustCompile(`(://[^/\s:@]+:)[^@\s/]+@`)
)

func maskSecrets(s string) string {
	s = secretKVRe.ReplaceAllString(s, "${1}${2}**********")
	return urlSecretRe.ReplaceAllString(s, "${1}**********@")
}

func truncateText(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func firstLineOf(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
