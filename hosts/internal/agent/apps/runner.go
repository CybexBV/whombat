package apps

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
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
	// ProjectContainers are the containers Compose runs for a project now,
	// one-off `compose run` containers left out.
	ProjectContainers(ctx context.Context, project string) ([]Container, error)
	// Image is an image's id and labels; "" when there is none by that
	// reference.
	Image(ctx context.Context, ref string) (id string, labels map[string]string, err error)
	// Pull pulls an image ("repo@sha256:…" or "repo:tag"), its output to w.
	Pull(ctx context.Context, ref string, w io.Writer) error
	Tag(ctx context.Context, src, dst string) error
	// Untag removes one tag (the image goes only when nothing else uses it).
	Untag(ctx context.Context, ref string) error
	// ConfigHash is Compose's hash of a service's settings as the project's
	// files say them now (`docker compose config --hash`).
	ConfigHash(ctx context.Context, p Project, service string) (string, error)
	// Config is the project's settings as Compose reads them now, every
	// profile's services included (`docker compose config`).
	Config(ctx context.Context, p Project) ([]byte, error)
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
	// DockerWait is how long finishing a stopped update waits for Docker to
	// answer after the server started.
	DockerWait time.Duration
	// Stat checks the project's folder and files (tests replace it).
	Stat func(string) (os.FileInfo, error)
	// Origins is where each project's own files are noted when its
	// services are recreated from the settings a task wrote down (default:
	// "projects" beside the task's folder).
	Origins string

	mu  sync.Mutex
	log io.Writer
}

// Run runs the task to its end and writes result.json. A task that has
// progress.json already was stopped part-way (the server restarted): Run
// then finishes the update that was being made and ends the task. It
// returns an error only when it could not write the result.
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
	if r.DockerWait == 0 {
		r.DockerWait = 5 * time.Minute
	}
	if r.Origins == "" {
		r.Origins = filepath.Join(filepath.Dir(r.Dir), "projects")
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
	prog, err := ReadProgress(r.Dir)
	if err != nil {
		// Unreadable: what it held is lost, so the task ends as if nothing ran.
		prog = &Progress{}
	}
	var res *TaskResult
	if prog != nil {
		tctx, cancel := context.WithTimeout(ctx, PerAppLimit)
		defer cancel()
		if res, err = r.resume(tctx, spec, prog); err != nil {
			// The way back stays written down: the agent starts the runner
			// again, or ends the task with what is known.
			r.logf("%v", err)
			return err
		}
	} else {
		limit := Limit(len(spec.Apps))
		deadline := spec.Started.Add(limit)
		if spec.Started.IsZero() || deadline.Before(r.Now()) {
			deadline = r.Now().Add(limit)
		}
		tctx, cancel := context.WithDeadline(ctx, deadline)
		defer cancel()
		res = r.run(tctx, spec)
	}
	res.Finished = r.Now().UTC()
	if err := WriteResult(r.Dir, res); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(r.Dir, ProgressFile))
	return nil
}

func (r *Runner) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.log != nil {
		fmt.Fprintf(r.log, format+"\n", args...)
	}
}

// save writes what the task has done so far and the update being made now.
func (r *Runner) save(done []Outcome, pending *Pending) error {
	return WriteProgress(r.Dir, &Progress{Done: append([]Outcome{}, done...), Pending: pending})
}

func (r *Runner) run(ctx context.Context, spec *TaskSpec) *TaskResult {
	res := &TaskResult{Status: StatusOK, Apps: []Outcome{}}
	expect := map[string]proto.AppExpect{}
	for _, e := range spec.Expect {
		expect[e.App] = e
	}
	handled := map[string]bool{}
	for i, name := range spec.Apps {
		if handled[name] {
			continue // updated with another app that runs the same image
		}
		if ctx.Err() != nil {
			// Out of time: the apps not reached stay as they are.
			for _, rest := range spec.Apps[i:] {
				if !handled[rest] {
					res.Apps = append(res.Apps, Outcome{App: rest, Status: proto.AppFailed, Reason: "timeout"})
				}
			}
			res.Status, res.Code = StatusFailed, proto.TaskCodeTimeout
			break
		}
		for _, o := range r.update(ctx, name, spec.HoldMajor, expect, res.Apps) {
			handled[o.App] = true
			r.logf("%s: %s", o.App, summary(o))
			res.Apps = append(res.Apps, o)
			if o.Status == proto.AppFailed || o.Status == proto.AppRolledBack {
				res.Status = StatusFailed
			}
		}
		if err := r.save(res.Apps, nil); err != nil {
			r.logf("(could not write down the progress: %v)", err)
		}
	}
	res.Message = taskMessage(res.Apps)
	return res
}

// ErrDockerDown: Docker didn't answer in time to finish a stopped update.
var ErrDockerDown = errors.New("Docker didn’t answer, so the update wasn’t finished yet")

// resume ends a task the server stopped part-way: the update that was
// being made is kept when its services run the new image well, else put
// back; the apps not reached stay as they are. It returns ErrDockerDown,
// and no result, when Docker doesn't answer in time.
func (r *Runner) resume(ctx context.Context, spec *TaskSpec, prog *Progress) (*TaskResult, error) {
	r.logf("The update was stopped part-way (the server may have restarted); finishing it.")
	res := &TaskResult{Status: StatusOK, Apps: append([]Outcome{}, prog.Done...)}
	if pend := prog.Pending; pend != nil {
		// Docker may still be starting after the server came back.
		if !r.dockerReady(ctx, pend.Project) {
			return nil, ErrDockerDown
		}
		res.Apps = append(res.Apps, r.finish(ctx, pend)...)
	}
	handled := map[string]bool{}
	for _, o := range res.Apps {
		handled[o.App] = true
	}
	for _, name := range spec.Apps {
		if !handled[name] {
			res.Apps = append(res.Apps, Outcome{App: name, Status: proto.AppFailed, Reason: proto.AppReasonInterrupted})
		}
	}
	for _, o := range res.Apps {
		r.logf("%s: %s", o.App, summary(o))
		if o.Status == proto.AppFailed || o.Status == proto.AppRolledBack {
			res.Status = StatusFailed
		}
	}
	res.Message = taskMessage(res.Apps)
	return res, nil
}

// dockerReady waits until Docker answers, at most DockerWait.
func (r *Runner) dockerReady(ctx context.Context, p Project) bool {
	deadline := r.Now().Add(r.DockerWait)
	for {
		_, err := r.Docker.ProjectContainers(ctx, p.Name)
		if err == nil {
			return true
		}
		if r.Now().After(deadline) {
			r.logf("(Docker doesn’t answer: %v)", err)
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(r.Poll):
		}
	}
}

// finish settles the update that was being made when the task stopped.
func (r *Runner) finish(ctx context.Context, pend *Pending) []Outcome {
	outs := func(status, reason, msg string) []Outcome {
		out := make([]Outcome, 0, len(pend.Apps))
		for _, o := range pend.Apps {
			o.Status, o.Reason, o.Message = status, reason, msg
			out = append(out, o)
		}
		return out
	}
	bg := context.WithoutCancel(ctx)
	dropBackup := func() {
		if err := r.Docker.Untag(bg, pend.Backup); err != nil {
			r.logf("(could not remove the tag %s: %v)", pend.Backup, err)
		}
	}
	cs, err := r.serviceContainers(ctx, pend.Project, append(append([]string{}, pend.Services...), pend.Idle...))
	if err != nil {
		r.logf("(could not read the containers: %v)", err)
	}
	running := ""
	for _, c := range cs {
		if c.ImageID != pend.OldID {
			running = c.ImageID
		}
	}
	if err == nil && len(cs) > 0 && running == "" {
		// Nothing was replaced yet: the tag names the image that runs again.
		if pend.Moved {
			if err := r.retag(bg, pend.OldID, pend.Ref); err != nil {
				return outs(proto.AppFailed, proto.AppReasonBackFail, lastLine(err.Error()))
			}
		}
		dropBackup()
		return outs(proto.AppFailed, proto.AppReasonInterrupted, "")
	}
	reason, msg := proto.AppReasonInterrupted, ""
	if running != "" {
		if pend.NewID != "" {
			running = pend.NewID
		}
		// The restart counts are taken from the first look: the server's own restart isn't the app's.
		reason, msg = r.watch(ctx, pend.Project, pend.Services, running, nil)
		if reason == "" {
			// The stopped services follow once the others run well (again
			// when they already did: Compose leaves them as they are).
			if err := r.up(ctx, pend.Project, pend.Idle, pend.Scale, false); err != nil {
				reason, msg = proto.AppReasonStart, lastLine(err.Error())
			} else {
				dropBackup()
				return outs(proto.AppUpdated, "", "")
			}
		}
	}
	r.logf("The update didn’t come up after the restart (%s): putting the previous version back.", reason)
	if err := r.back(bg, pend, map[string]int{}); err != nil {
		return outs(proto.AppFailed, proto.AppReasonBackFail, lastLine(err.Error()))
	}
	dropBackup()
	return outs(proto.AppRolledBack, reason, msg)
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

// AppReasonDocker: Docker itself didn't answer as expected.
const AppReasonDocker = "docker"

// update updates one app and every other service of its project that runs
// the same image, together (see the package comment); one outcome per
// container. done are the outcomes so far (kept with the way back). A task
// that says what was checked (expect) binds every app: one it says nothing
// about isn't updated.
func (r *Runner) update(ctx context.Context, name string, holdMajor bool, expect map[string]proto.AppExpect, done []Outcome) []Outcome {
	o := Outcome{App: name}
	fail := func(reason, msg string) []Outcome {
		o.Status, o.Reason, o.Message = proto.AppFailed, reason, msg
		return []Outcome{o}
	}
	c, err := r.Docker.Container(ctx, name)
	switch {
	case err != nil:
		return fail(AppReasonDocker, lastLine(err.Error()))
	case c == nil:
		return fail(proto.AppReasonGone, "")
	}
	p, ok := r.projectOf(c.Labels)
	if !ok {
		return fail(proto.AppReasonNoCompose, "")
	}
	o.Service = p.Service
	bound := len(expect) > 0
	exp, said := expect[name]
	if bound && (!said || !matches(exp, p.Service, *c)) {
		r.logf("%s isn’t what was said yes to any more (service, image or Compose settings changed).", name)
		return fail(proto.AppReasonChanged, "")
	}
	if !p.Usable(r.Stat) {
		return fail(proto.AppReasonNoFiles, "")
	}
	ref := c.Ref
	if ref == "" || Pinned(ref) || !ValidRef(ref) {
		return fail(proto.AppReasonPinned, "")
	}
	oldID := c.ImageID
	o.From = VersionOf(c.Labels, ref)

	// Every service of the project that runs this image goes with it, so
	// none runs the new version while another runs the old one; stopped
	// ones too, so none starts on it later untried.
	group, stray, err := r.group(ctx, p, *c)
	if err != nil {
		return fail(AppReasonDocker, lastLine(err.Error()))
	}
	if stray != "" {
		r.logf("%s belongs to a service updated with %s but runs another image.", stray, name)
		return fail(proto.AppReasonChanged, "")
	}
	services := []string{}
	scale := map[string]int{}
	outs := []Outcome{}
	for _, m := range group {
		if !slices.Contains(services, m.Service) {
			services = append(services, m.Service)
		}
		scale[m.Service]++
		if bound && m.Name != name {
			e, ok := expect[m.Name]
			if !ok || !matches(e, m.Service, m.Container) {
				r.logf("%s runs the same image as %s but wasn’t said yes to.", m.Name, name)
				return fail(proto.AppReasonChanged, "")
			}
		}
		x := Outcome{App: m.Name, Service: m.Service, From: o.From}
		if m.Name == name {
			outs = append([]Outcome{x}, outs...)
		} else {
			outs = append(outs, x)
		}
	}
	all := func(status, reason, msg, to string) []Outcome {
		out := make([]Outcome, 0, len(outs))
		for _, x := range outs {
			x.Status, x.Reason, x.Message, x.To = status, reason, msg, to
			out = append(out, x)
		}
		return out
	}
	// A service that was running is started again and watched; one that was
	// stopped is recreated and stays stopped.
	run, idle := []string{}, []string{}
	for _, s := range services {
		if slices.ContainsFunc(group, func(m member) bool { return m.Service == s && meantToRun(m.Status) }) {
			run = append(run, s)
		} else {
			idle = append(idle, s)
		}
	}

	// Compose's settings must be what runs: then recreating changes nothing
	// but the image.
	hashes := map[string]string{}
	for _, m := range group {
		h, ok := hashes[m.Service]
		if !ok {
			var err error
			if h, err = r.Docker.ConfigHash(ctx, p, m.Service); err != nil {
				if errors.Is(err, ErrNoCompose) {
					return all(proto.AppFailed, proto.AppReasonNoCLI, "", "")
				}
				return all(proto.AppFailed, AppReasonDocker, lastLine(err.Error()), "")
			}
			hashes[m.Service] = h
		}
		if have := ConfigHashOf(m.Labels); have == "" || h != have {
			r.logf("%s’s Compose settings changed since it was started: leaving it as it is.", m.Service)
			return all(proto.AppFailed, proto.AppReasonChanged, "", "")
		}
	}
	// The settings are written down once, now: the services are recreated,
	// and put back, from that copy, so an edit made to the project's files
	// while the image downloads changes nothing. The copy must say exactly
	// what runs.
	rp, err := r.resolve(ctx, p)
	if err != nil {
		return all(proto.AppFailed, AppReasonDocker, "could not write down the Compose settings: "+lastLine(err.Error()), "")
	}
	for s, want := range hashes {
		if h, err := r.Docker.ConfigHash(ctx, rp, s); err != nil || h != want {
			r.logf("The written-down settings of %s aren’t the ones it runs with: leaving it as it is.", s)
			return all(proto.AppFailed, AppReasonDocker, "Compose didn’t write down the settings "+s+" runs with", "")
		}
	}

	r.logf("Updating %s (Compose project %s, services %s) from %s.", name, p.Name, strings.Join(services, ", "), orUnknown(o.From))
	// The previous image keeps a tag of its own until the new one is known
	// to work, and the way back is written down before anything changes.
	backup := BackupTag(ref, p.Service)
	if err := r.Docker.Tag(ctx, oldID, backup); err != nil {
		return all(proto.AppFailed, AppReasonDocker, lastLine(err.Error()), "")
	}
	bg := context.WithoutCancel(ctx)
	pend := &Pending{Project: rp, Services: run, Idle: idle, Scale: scale, Apps: outs, Ref: ref, OldID: oldID, Backup: backup}
	// The progress is written again with this app's outcome once update
	// returns: until then a stop is checked again from the way back.
	dropBackup := func() {
		if err := r.Docker.Untag(bg, backup); err != nil {
			r.logf("(could not remove the tag %s: %v)", backup, err)
		}
	}
	// Exactly the image the person said yes to; without a digest (the
	// registry didn't say which), the tag's newest.
	pull := ref
	if said && exp.Digest != "" {
		pull = Repo(ref) + "@" + exp.Digest
	} else {
		pend.Moved = true // pulling a tag moves it
	}
	if err := r.save(done, pend); err != nil {
		dropBackup()
		return all(proto.AppFailed, AppReasonDocker, "could not write down the way back: "+lastLine(err.Error()), "")
	}
	// restore names the running image by its tag again after a pull moved it.
	restore := func() {
		if pend.Moved {
			if err := r.retag(bg, oldID, ref); err != nil {
				r.logf("(could not tag the running image again: %v)", err)
			}
		}
	}
	r.logf("$ docker pull %s", pull)
	if err := r.Docker.Pull(ctx, pull, r.writer()); err != nil {
		restore()
		dropBackup()
		return all(proto.AppFailed, proto.AppReasonPull, lastLine(err.Error()), "")
	}
	newID, newLabels, err := r.Docker.Image(ctx, pull)
	if err != nil || newID == "" {
		restore()
		dropBackup()
		msg := ""
		if err != nil {
			msg = lastLine(err.Error())
		}
		return all(proto.AppFailed, proto.AppReasonPull, msg, "")
	}
	if newID == oldID {
		dropBackup()
		return all(proto.AppCurrent, "", "", o.From)
	}
	to := VersionOf(newLabels, ref)
	if holdMajor && (o.From == "" || to == "" || MajorJump(o.From, to)) {
		// Nobody said yes to a new major version, and this may be one: the
		// services keep the image they run, nothing restarts.
		r.logf("%s → %s may be a new major version: leaving it for a person to decide.", orUnknown(o.From), orUnknown(to))
		restore()
		dropBackup()
		return all(proto.AppHeld, "", "", to)
	}
	pend.NewID, pend.Moved = newID, true
	// A finished stop names the version it went to.
	for i := range pend.Apps {
		pend.Apps[i].To = to
	}
	if err := r.save(done, pend); err != nil {
		restore()
		dropBackup()
		return all(proto.AppFailed, AppReasonDocker, "could not write down the way back: "+lastLine(err.Error()), "")
	}
	if err := r.Docker.Tag(ctx, newID, ref); err != nil {
		restore()
		dropBackup()
		return all(proto.AppFailed, AppReasonDocker, lastLine(err.Error()), "")
	}
	// The restart counts before the update: a container that crashed and
	// came back before the first look still counts.
	before := map[string]int{}
	for _, m := range group {
		before[m.ID] = m.RestartCount
	}
	reason, msg := "", ""
	if err := r.up(ctx, rp, run, scale, true); err != nil {
		reason, msg = proto.AppReasonStart, lastLine(err.Error())
	} else if reason, msg = r.watch(ctx, rp, run, newID, before); reason == "" {
		// The stopped services follow once the others run well.
		if err := r.up(ctx, rp, idle, scale, false); err != nil {
			reason, msg = proto.AppReasonStart, lastLine(err.Error())
		}
	}
	if reason == "" {
		dropBackup()
		return all(proto.AppUpdated, "", "", to)
	}
	r.logf("%s didn’t come up (%s): putting %s back.", name, reason, orUnknown(o.From))
	if err := r.back(bg, pend, before); err != nil {
		// The previous image keeps its own tag, so a person can still go back by hand.
		return all(proto.AppFailed, proto.AppReasonBackFail, lastLine(err.Error()), to)
	}
	dropBackup()
	return all(proto.AppRolledBack, reason, msg, to)
}

// meantToRun: a container in this state was running before the update.
func meantToRun(status string) bool {
	return status == "running" || status == "restarting" || status == "paused"
}

// matches reports whether a container is still what was checked: the same
// service, the same image, the same Compose settings. What was checked must
// name all three.
func matches(e proto.AppExpect, service string, c Container) bool {
	if e.Service != service || e.ImageID == "" || e.ImageID != c.ImageID {
		return false
	}
	return e.ConfigHash != "" && e.ConfigHash == ConfigHashOf(c.Labels)
}

// member is one container that is updated with an app.
type member struct {
	Container
	Service string
}

// group is the app's container and every other container of its project
// from the same image (the same reference, the same image id), running or
// not; the app's own first. stray names a container of one of those
// services that runs another image: recreating the service would replace it
// too.
func (r *Runner) group(ctx context.Context, p Project, c Container) (out []member, stray string, err error) {
	out = []member{{Container: c, Service: p.Service}}
	cs, err := r.Docker.ProjectContainers(ctx, p.Name)
	if err != nil {
		return nil, "", err
	}
	others := []Container{}
	for _, x := range cs {
		if x.Name == c.Name {
			continue
		}
		q, ok := r.projectOf(x.Labels)
		if !ok || q.Name != p.Name || q.Dir != p.Dir || !slices.Equal(q.Files, p.Files) ||
			x.Ref != c.Ref || x.ImageID != c.ImageID {
			others = append(others, x)
			continue
		}
		out = append(out, member{Container: x, Service: q.Service})
	}
	for _, x := range others {
		if slices.ContainsFunc(out, func(m member) bool { return m.Service == x.Labels[LabelService] }) {
			return nil, x.Name, nil
		}
	}
	return out, "", nil
}

// resolvedPrefix starts the name of a Compose file a task wrote down.
const resolvedPrefix = "compose-"

// origin is a project's own folder and files, noted when its services are
// recreated from the settings a task wrote down.
type origin struct {
	Dir      string   `json:"dir"`
	Files    []string `json:"files"`
	EnvFiles []string `json:"env_files,omitempty"`
}

// resolve writes the project's settings down, as Compose reads them now
// (every profile's services, so none is taken for a leftover), into a file
// of the task's own, and notes the project's own files. It returns the
// project as recreated from that file: the same name and folder.
func (r *Runner) resolve(ctx context.Context, p Project) (Project, error) {
	b, err := r.Docker.Config(ctx, p)
	if err != nil {
		return Project{}, err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return Project{}, errors.New("compose said no settings")
	}
	f := filepath.Join(r.Dir, resolvedPrefix+p.Name+"-"+p.Service+".yaml")
	if err := writeFile(f, b); err != nil {
		return Project{}, err
	}
	if err := os.MkdirAll(r.Origins, 0o700); err != nil {
		return Project{}, err
	}
	if err := writeJSON(filepath.Join(r.Origins, p.Name+".json"), origin{Dir: p.Dir, Files: p.Files, EnvFiles: p.EnvFiles}); err != nil {
		return Project{}, err
	}
	rp := p
	rp.Files = []string{f}
	return rp, nil
}

// projectOf reads a container's Compose labels (ProjectOf). Compose names
// the file a container was created from in its labels: for one recreated
// from settings a task wrote down, that is the task's file, and the
// project's own files are the ones noted for it then.
func (r *Runner) projectOf(labels map[string]string) (Project, bool) {
	p, ok := ProjectOf(labels)
	if !ok || len(p.Files) != 1 || !r.written(p.Files[0]) {
		return p, ok
	}
	var o origin
	if err := readJSON(filepath.Join(r.Origins, p.Name+".json"), &o); err == nil && o.Dir == p.Dir && len(o.Files) > 0 {
		p.Files, p.EnvFiles = o.Files, o.EnvFiles
	}
	return p, true
}

// written reports whether a Compose file is one an app task wrote down.
func (r *Runner) written(f string) bool {
	task := filepath.Dir(f)
	return filepath.Dir(task) == filepath.Dir(r.Dir) && strings.HasPrefix(filepath.Base(task), "app-") &&
		strings.HasPrefix(filepath.Base(f), resolvedPrefix)
}

// up recreates the services from the image their tag names now, each with
// as many containers as it had: started (and so watched afterwards), or left
// stopped. Compose neither pulls, builds nor removes other containers.
func (r *Runner) up(ctx context.Context, p Project, services []string, scale map[string]int, start bool) error {
	if len(services) == 0 {
		return nil
	}
	args := func(pull bool) []string {
		a := []string{"up"}
		if start {
			a = append(a, "--detach")
		} else {
			a = append(a, "--no-start")
		}
		a = append(a, "--no-deps")
		if pull {
			a = append(a, "--pull", "never")
		}
		a = append(a, "--no-build", "--remove-orphans=false")
		for _, s := range services {
			if n := scale[s]; n > 0 {
				a = append(a, "--scale", fmt.Sprintf("%s=%d", s, n))
			}
		}
		return append(append(a, "--"), services...)
	}
	r.logf("$ docker compose %s", strings.Join(args(true), " "))
	err := r.Docker.Compose(ctx, p, r.writer(), args(true)...)
	if err != nil && unknownFlag(err) {
		// Compose before --pull: the image is there, so it isn't pulled anyway.
		err = r.Docker.Compose(ctx, p, r.writer(), args(false)...)
	}
	return err
}

// retag names an image by a tag again, given time of its own however the
// task's time stands.
func (r *Runner) retag(ctx context.Context, id, ref string) error {
	tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()
	return r.Docker.Tag(tctx, id, ref)
}

// back puts the previous image back: it is the services' image again, and
// they are recreated from it, from the settings written down, without
// pulling; those that ran are watched again.
func (r *Runner) back(ctx context.Context, pend *Pending, before map[string]int) error {
	wctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err := r.Docker.Tag(wctx, pend.OldID, pend.Ref); err != nil {
		return err
	}
	if err := r.up(wctx, pend.Project, pend.Services, pend.Scale, true); err != nil {
		return err
	}
	if err := r.up(wctx, pend.Project, pend.Idle, pend.Scale, false); err != nil {
		return err
	}
	if reason, msg := r.watch(wctx, pend.Project, pend.Services, pend.OldID, before); reason != "" {
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

// serviceContainers are the project's containers of these services.
func (r *Runner) serviceContainers(ctx context.Context, p Project, services []string) ([]Container, error) {
	cs, err := r.Docker.ProjectContainers(ctx, p.Name)
	if err != nil {
		return nil, err
	}
	out := cs[:0:0]
	for _, c := range cs {
		if slices.Contains(services, c.Labels[LabelService]) {
			out = append(out, c)
		}
	}
	return out, nil
}

// watch follows the services' containers until they have run for Settle
// (and passed their health check, when they have one), or one of them
// stops, keeps restarting or fails its check. before are the restart counts
// before the update (a container it doesn't name started at none); nil
// takes them from the first look. It returns "" when the app is up, else
// the reason and Docker's words.
func (r *Runner) watch(ctx context.Context, p Project, services []string, imageID string, before map[string]int) (reason, msg string) {
	if len(services) == 0 {
		return "", ""
	}
	start := r.Now()
	var upSince time.Time
	restarts := map[string]int{}
	healthDeadline := start.Add(r.HealthWait)
	for {
		cs, err := r.serviceContainers(ctx, p, services)
		now := r.Now()
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return proto.AppReasonStopped, "it ran out of time"
			}
			r.logf("(could not read the containers: %v)", err)
		default:
			for _, s := range services {
				if !slices.ContainsFunc(cs, func(c Container) bool { return c.Labels[LabelService] == s }) {
					return proto.AppReasonStopped, "no container runs the service"
				}
			}
			up, healthy, waiting := true, true, false
			for _, c := range cs {
				if imageID != "" && c.ImageID != "" && c.ImageID != imageID {
					up = false // the old container is still being replaced
					continue
				}
				first, seen := restarts[c.ID]
				if !seen {
					first = c.RestartCount
					if before != nil {
						first = before[c.ID]
					}
					restarts[c.ID] = first
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
