package apps

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// Container is what the runner reads of a container (docker inspect).
type Container struct {
	ID      string
	Name    string
	ImageID string // the image it runs ("sha256:…")
	Ref     string // the image reference it was created from (Config.Image)
	Labels  map[string]string
	// Status: running | restarting | exited | dead | created | paused.
	Status       string
	RestartCount int
	Health       string // "" (no health check) | starting | healthy | unhealthy
}

// Docker is what the runner does with Docker (the docker CLI on the server;
// tests use a fake).
type Docker interface {
	// Container inspects a container by name; nil, nil when it isn't there.
	Container(ctx context.Context, name string) (*Container, error)
	// ServiceContainers are the containers Compose runs for a project's
	// service now (one per replica).
	ServiceContainers(ctx context.Context, project, service string) ([]Container, error)
	// Image is an image's id and labels; "" when there is none by that
	// reference.
	Image(ctx context.Context, ref string) (id string, labels map[string]string, err error)
	Tag(ctx context.Context, src, dst string) error
	// Untag removes one tag (the image goes only when nothing else uses it).
	Untag(ctx context.Context, ref string) error
	// Compose runs `docker compose <project args> <args>`, its output to w.
	Compose(ctx context.Context, p Project, w io.Writer, args ...string) error
}

// ErrNoCompose: neither `docker compose` nor docker-compose is installed.
var ErrNoCompose = errors.New("docker compose isn’t installed")

// Runner runs one app task: `whombat-agent app-task --dir DIR`.
type Runner struct {
	Dir    string
	Docker Docker
	Now    func() time.Time
	// Poll is how often the watch reads the new container; Settle how long
	// it must keep running; HealthWait how long a health check may take to
	// pass. Tests make them short.
	Poll       time.Duration
	Settle     time.Duration
	HealthWait time.Duration
	// Stat checks the project's folder and files (tests replace it).
	Stat func(string) (os.FileInfo, error)

	mu  sync.Mutex
	log io.Writer
}

// Run runs the task to its end and writes result.json. It returns an error
// only when it could not write the result.
func (r *Runner) Run(ctx context.Context) error {
	spec, err := ReadSpec(r.Dir)
	if err != nil {
		return fmt.Errorf("read the task: %w", err)
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.Poll == 0 {
		r.Poll = 2 * time.Second
	}
	if r.Settle == 0 {
		r.Settle = 30 * time.Second
	}
	if r.HealthWait == 0 {
		r.HealthWait = 5 * time.Minute
	}
	if r.Docker == nil {
		r.Docker = NewCLI()
	}
	f, err := os.OpenFile(filepath.Join(r.Dir, LogFile), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open the log: %w", err)
	}
	defer f.Close()
	r.log = f
	limit := Limit(len(spec.Apps))
	deadline := spec.Started.Add(limit)
	if spec.Started.IsZero() || deadline.Before(r.Now()) {
		deadline = r.Now().Add(limit)
	}
	tctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	res := r.run(tctx, spec)
	res.Finished = r.Now().UTC()
	return WriteResult(r.Dir, res)
}

func (r *Runner) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.log != nil {
		fmt.Fprintf(r.log, format+"\n", args...)
	}
}

func (r *Runner) run(ctx context.Context, spec *TaskSpec) *TaskResult {
	res := &TaskResult{Status: StatusOK, Apps: []Outcome{}}
	for i, name := range spec.Apps {
		if ctx.Err() != nil {
			// Out of time: the apps not reached stay as they are.
			for _, rest := range spec.Apps[i:] {
				res.Apps = append(res.Apps, Outcome{App: rest, Status: proto.AppFailed, Reason: "timeout"})
			}
			res.Status, res.Code = StatusFailed, proto.TaskCodeTimeout
			break
		}
		o := r.update(ctx, name, spec.HoldMajor)
		r.logf("%s: %s", name, summary(o))
		res.Apps = append(res.Apps, o)
		if o.Status == proto.AppFailed || o.Status == proto.AppRolledBack {
			res.Status = StatusFailed
		}
	}
	res.Message = taskMessage(res.Apps)
	return res
}

// summary is one log line about an outcome.
func summary(o Outcome) string {
	s := o.Status
	if o.From != "" || o.To != "" {
		s += fmt.Sprintf(" (%s → %s)", orUnknown(o.From), orUnknown(o.To))
	}
	if o.Reason != "" {
		s += ": " + o.Reason
	}
	if o.Message != "" {
		s += ": " + o.Message
	}
	return s
}

func orUnknown(v string) string {
	if v == "" {
		return "?"
	}
	return v
}

// taskMessage is the task's one line (the hub's task view; Whombat words
// the apps itself from Apps).
func taskMessage(apps []Outcome) string {
	count := map[string]int{}
	for _, a := range apps {
		count[a.Status]++
	}
	var parts []string
	for _, k := range []string{proto.AppUpdated, proto.AppCurrent, proto.AppHeld, proto.AppRolledBack, proto.AppFailed} {
		if n := count[k]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, strings.ReplaceAll(k, "_", " ")))
		}
	}
	if len(parts) == 0 {
		return "No apps."
	}
	return strings.Join(parts, ", ") + "."
}

// update updates one app (see the package comment).
func (r *Runner) update(ctx context.Context, name string, holdMajor bool) Outcome {
	o := Outcome{App: name}
	c, err := r.Docker.Container(ctx, name)
	switch {
	case err != nil:
		o.Status, o.Reason, o.Message = proto.AppFailed, AppReasonDocker, lastLine(err.Error())
		return o
	case c == nil:
		o.Status, o.Reason = proto.AppFailed, proto.AppReasonGone
		return o
	}
	p, ok := ProjectOf(c.Labels)
	if !ok {
		o.Status, o.Reason = proto.AppFailed, proto.AppReasonNoCompose
		return o
	}
	o.Service = p.Service
	if !p.Usable(r.Stat) {
		o.Status, o.Reason = proto.AppFailed, proto.AppReasonNoFiles
		return o
	}
	ref := c.Ref
	if ref == "" || Pinned(ref) {
		o.Status, o.Reason = proto.AppFailed, proto.AppReasonPinned
		return o
	}
	oldID := c.ImageID
	o.From = VersionOf(c.Labels, ref)
	r.logf("Updating %s (Compose project %s, service %s) from %s.", name, p.Name, p.Service, orUnknown(o.From))
	// The previous image keeps a tag of its own until the new one is known to work.
	backup := BackupTag(ref, p.Service)
	if err := r.Docker.Tag(ctx, oldID, backup); err != nil {
		o.Status, o.Reason, o.Message = proto.AppFailed, AppReasonDocker, lastLine(err.Error())
		return o
	}
	dropBackup := func() {
		if err := r.Docker.Untag(context.WithoutCancel(ctx), backup); err != nil {
			r.logf("(could not remove the tag %s: %v)", backup, err)
		}
	}
	r.logf("$ docker compose pull %s", p.Service)
	if err := r.Docker.Compose(ctx, p, r.writer(), "pull", "--quiet", p.Service); err != nil {
		dropBackup()
		o.Status, o.Message = proto.AppFailed, lastLine(err.Error())
		o.Reason = proto.AppReasonPull
		if errors.Is(err, ErrNoCompose) {
			o.Reason = proto.AppReasonNoCLI
		}
		return o
	}
	newID, newLabels, err := r.Docker.Image(ctx, ref)
	if err != nil || newID == "" {
		dropBackup()
		o.Status, o.Reason = proto.AppFailed, proto.AppReasonPull
		if err != nil {
			o.Message = lastLine(err.Error())
		}
		return o
	}
	if newID == oldID {
		dropBackup()
		o.Status, o.To = proto.AppCurrent, o.From
		return o
	}
	o.To = VersionOf(newLabels, ref)
	if holdMajor && MajorJump(o.From, o.To) {
		// Nobody looked at this one: the service's image is the running one again, nothing restarts.
		r.logf("%s → %s is a new major version: leaving it for a person to decide.", orUnknown(o.From), o.To)
		if err := r.Docker.Tag(ctx, oldID, ref); err != nil {
			r.logf("(could not tag the running image again: %v)", err)
		}
		dropBackup()
		o.Status = proto.AppHeld
		return o
	}
	r.logf("$ docker compose up -d --no-deps %s", p.Service)
	upErr := r.Docker.Compose(ctx, p, r.writer(), "up", "--detach", "--no-deps", p.Service)
	reason := proto.AppReasonStart
	msg := ""
	if upErr == nil {
		reason, msg = r.watch(ctx, p, newID)
		if reason == "" {
			dropBackup()
			o.Status = proto.AppUpdated
			return o
		}
	} else {
		msg = lastLine(upErr.Error())
	}
	o.Reason, o.Message = reason, msg
	r.logf("%s didn’t come up (%s): putting %s back.", name, reason, orUnknown(o.From))
	if err := r.back(context.WithoutCancel(ctx), p, oldID, ref); err != nil {
		o.Status, o.Reason, o.Message = proto.AppFailed, proto.AppReasonBackFail, lastLine(err.Error())
		// The previous image keeps its own tag, so a person can still go back by hand.
		return o
	}
	dropBackup()
	o.Status = proto.AppRolledBack
	return o
}

// AppReasonDocker: Docker itself didn't answer as expected.
const AppReasonDocker = "docker"

// back puts the previous image back: it is the service's image again, and
// the service is recreated from it without pulling, then watched again.
func (r *Runner) back(ctx context.Context, p Project, oldID, ref string) error {
	wctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err := r.Docker.Tag(wctx, oldID, ref); err != nil {
		return err
	}
	r.logf("$ docker compose up -d --no-deps --pull never %s", p.Service)
	err := r.Docker.Compose(wctx, p, r.writer(), "up", "--detach", "--no-deps", "--pull", "never", p.Service)
	if err != nil && unknownFlag(err) {
		// Compose before --pull: the image is there, so it isn't pulled anyway.
		err = r.Docker.Compose(wctx, p, r.writer(), "up", "--detach", "--no-deps", p.Service)
	}
	if err != nil {
		return err
	}
	if reason, msg := r.watch(wctx, p, oldID); reason != "" {
		if msg == "" {
			msg = "the previous version didn’t come up either (" + reason + ")"
		}
		return errors.New(msg)
	}
	return nil
}

func unknownFlag(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "unknown flag") || strings.Contains(s, "no such option") || strings.Contains(s, "unrecognized")
}

// watch follows the service's containers until they have run for Settle
// (and passed their health check, when they have one), or one of them
// stops, keeps restarting or fails its check. It returns "" when the app is
// up, else the reason and Docker's words.
func (r *Runner) watch(ctx context.Context, p Project, imageID string) (reason, msg string) {
	start := r.Now()
	var upSince time.Time
	restarts := map[string]int{}
	healthDeadline := start.Add(r.HealthWait)
	for {
		cs, err := r.Docker.ServiceContainers(ctx, p.Name, p.Service)
		now := r.Now()
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return proto.AppReasonStopped, "it ran out of time"
			}
			r.logf("(could not read the containers: %v)", err)
		case len(cs) == 0:
			return proto.AppReasonStopped, "no container runs the service"
		default:
			up, healthy, waiting := true, true, false
			for _, c := range cs {
				if imageID != "" && c.ImageID != "" && c.ImageID != imageID {
					up = false // the old container is still being replaced
					continue
				}
				first, seen := restarts[c.ID]
				if !seen {
					restarts[c.ID] = c.RestartCount
					first = c.RestartCount
				}
				switch {
				case c.Status == "exited" || c.Status == "dead":
					return proto.AppReasonStopped, ""
				case c.RestartCount-first >= 2:
					return proto.AppReasonRestarts, ""
				case c.Health == "unhealthy":
					return proto.AppReasonUnhealthy, ""
				case c.Status != "running":
					up = false
				}
				if c.Health == "starting" {
					healthy, waiting = false, true
				}
			}
			if !up {
				upSince = time.Time{}
			} else if upSince.IsZero() {
				upSince = now
			}
			if up && healthy && now.Sub(upSince) >= r.Settle {
				return "", ""
			}
			if waiting && now.After(healthDeadline) {
				return proto.AppReasonUnhealthy, "its health check didn’t pass in time"
			}
			if !up && now.Sub(start) > r.HealthWait {
				return proto.AppReasonStopped, "it didn’t start in time"
			}
		}
		select {
		case <-ctx.Done():
			return proto.AppReasonStopped, "it ran out of time"
		case <-time.After(r.Poll):
		}
	}
}

// writer is the log, for commands' output.
func (r *Runner) writer() io.Writer {
	return writerFunc(func(b []byte) (int, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.log == nil {
			return len(b), nil
		}
		return r.log.Write(b)
	})
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(b []byte) (int, error) { return f(b) }

// lastLine is the last non-empty line of a text, at most 300 bytes.
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			if len(l) > 300 {
				l = l[:300]
			}
			return l
		}
	}
	return ""
}

// tail keeps the end of a command's output for its error.
type tail struct{ b bytes.Buffer }

func (t *tail) Write(p []byte) (int, error) {
	t.b.Write(p)
	if t.b.Len() > 8192 {
		rest := append([]byte(nil), t.b.Bytes()[t.b.Len()-4096:]...)
		t.b.Reset()
		t.b.Write(rest)
	}
	return len(p), nil
}
