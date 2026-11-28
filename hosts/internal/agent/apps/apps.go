// Package apps updates Docker Compose apps on the agent's server (docs/MANAGE.md
// 2.10, Whombat's app-updates.md): for each app it keeps the image that runs
// now, pulls the newest image of the app's Compose service, recreates only
// that service in its own project folder with its own files, and watches it.
// When the new container stops, keeps restarting or fails its health check,
// it tags the previous image as the service's image again and recreates the
// service without pulling, so the app runs as before.
//
// The work runs outside the agent (`whombat-agent app-task --dir DIR` in a
// transient systemd unit, like a package task), so an agent that restarts
// meanwhile doesn't leave an app half updated; the runner writes result.json
// last.
package apps

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A task's files, in its own directory below the agent's state directory.
const (
	SpecFile   = "task.json"
	LogFile    = "log"
	ResultFile = "result.json"
)

// Limits: one app may take this long (a big image's pull, the watch and
// going back), a task at most TaskLimitMax.
const (
	PerAppLimit  = 30 * time.Minute
	TaskLimitMax = 3 * time.Hour
)

// Limit is how long a task of n apps may run.
func Limit(n int) time.Duration {
	if n < 1 {
		n = 1
	}
	return min(time.Duration(n)*PerAppLimit, TaskLimitMax)
}

// TaskSpec is an app task as the agent starts it (task.json).
type TaskSpec struct {
	ID        string    `json:"id"`
	Apps      []string  `json:"apps"`
	HoldMajor bool      `json:"hold_major,omitempty"`
	Started   time.Time `json:"started"`
	// Unit: the transient systemd unit running it; PID: the runner's
	// process without systemd.
	Unit string `json:"unit,omitempty"`
	PID  int    `json:"pid,omitempty"`
}

// Task result statuses (the task as a whole: ok when every app ended
// updated, current or held; failed when one couldn't be updated or was put
// back).
const (
	StatusOK     = "ok"
	StatusFailed = "failed"
)

// Outcome is what the task did to one app (proto.AppResult with JSON names).
type Outcome struct {
	App     string `json:"app"`
	Service string `json:"service,omitempty"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Message string `json:"message,omitempty"`
}

// TaskResult is the end of an app task (result.json).
type TaskResult struct {
	Status   string    `json:"status"`
	Message  string    `json:"message"`
	Code     string    `json:"code,omitempty"` // timeout
	Apps     []Outcome `json:"apps"`
	Finished time.Time `json:"finished"`
}

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

// WriteResult writes result.json atomically (once: an existing result stays).
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

// ---- Compose projects -----------------------------------------------------------

// The labels Docker Compose puts on the containers it creates.
const (
	LabelProject    = "com.docker.compose.project"
	LabelService    = "com.docker.compose.service"
	LabelWorkingDir = "com.docker.compose.project.working_dir"
	LabelFiles      = "com.docker.compose.project.config_files"
	LabelEnvFiles   = "com.docker.compose.project.environment_file"
	LabelOneOff     = "com.docker.compose.oneoff"
	// LabelVersion is the OCI version label many images carry.
	LabelVersion = "org.opencontainers.image.version"
)

// Project is how Compose started a service: the project's name, folder and
// files, as the container's labels say.
type Project struct {
	Name     string
	Service  string
	Dir      string
	Files    []string
	EnvFiles []string
}

// ProjectOf reads a container's Compose labels; ok is false for a container
// Compose didn't start (or a one-off `compose run` container).
func ProjectOf(labels map[string]string) (Project, bool) {
	p := Project{Name: labels[LabelProject], Service: labels[LabelService], Dir: labels[LabelWorkingDir]}
	if p.Name == "" || p.Service == "" || strings.EqualFold(labels[LabelOneOff], "true") {
		return Project{}, false
	}
	p.Files = splitPaths(labels[LabelFiles], p.Dir)
	p.EnvFiles = splitPaths(labels[LabelEnvFiles], p.Dir)
	return p, true
}

// splitPaths splits a label's comma-separated paths; relative ones are
// below dir.
func splitPaths(s, dir string) []string {
	var out []string
	for _, f := range strings.Split(s, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if !filepath.IsAbs(f) && dir != "" {
			f = filepath.Join(dir, f)
		}
		out = append(out, filepath.Clean(f))
	}
	return out
}

// Usable reports whether the project's folder and files are still on disk
// (stat; a relative or missing folder isn't).
func (p Project) Usable(stat func(string) (os.FileInfo, error)) bool {
	if stat == nil {
		stat = os.Stat
	}
	if p.Dir == "" || !filepath.IsAbs(p.Dir) {
		return false
	}
	if st, err := stat(p.Dir); err != nil || !st.IsDir() {
		return false
	}
	for _, f := range p.Files {
		if st, err := stat(f); err != nil || st.IsDir() {
			return false
		}
	}
	return true
}

// Args are the compose arguments that name the project: its name, folder,
// files and env files.
func (p Project) Args() []string {
	out := []string{"--project-name", p.Name, "--project-directory", p.Dir}
	for _, f := range p.Files {
		out = append(out, "--file", f)
	}
	for _, f := range p.EnvFiles {
		out = append(out, "--env-file", f)
	}
	return out
}

// Pinned reports whether an image reference names one digest
// ("app@sha256:…"): nothing newer can come for it.
func Pinned(ref string) bool {
	return strings.Contains(ref, "@sha256:") || strings.HasPrefix(ref, "sha256:")
}

// ---- versions ---------------------------------------------------------------------

var (
	versionTagRe = regexp.MustCompile(`^[vV]?(\d+)(\.\d+){0,3}([-+._][0-9A-Za-z][0-9A-Za-z.+-]*)?$`)
	digitRe      = regexp.MustCompile(`\d`)
)

// Tag is an image reference's tag ("latest" when it has none).
func Tag(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	slash := strings.LastIndex(ref, "/")
	if i := strings.LastIndex(ref, ":"); i > slash {
		return ref[i+1:]
	}
	return "latest"
}

// Repo is an image reference without its tag or digest.
func Repo(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	slash := strings.LastIndex(ref, "/")
	if i := strings.LastIndex(ref, ":"); i > slash {
		return ref[:i]
	}
	return ref
}

// VersionOf is an image's version: its OCI version label, else its tag when
// the tag looks like a version ("v2.3.1", "16.4", "1.27-alpine"); "" when
// unknown ("latest", "release").
func VersionOf(labels map[string]string, ref string) string {
	if v := cleanVersion(labels[LabelVersion]); v != "" {
		return v
	}
	if t := Tag(ref); versionTagRe.MatchString(t) {
		return cleanVersion(t)
	}
	return ""
}

func cleanVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 40 || !digitRe.MatchString(v) || strings.ContainsAny(v, " \t\n") {
		return ""
	}
	return v
}

// Major is a version's first number (-1 when it has none). Calendar
// versions (2024.12, a year as their first number) have no major: a new year
// isn't a breaking change.
func Major(v string) int {
	v = strings.TrimLeft(strings.TrimSpace(v), "vV")
	end := 0
	for end < len(v) && v[end] >= '0' && v[end] <= '9' {
		end++
	}
	if end == 0 {
		return -1
	}
	n, err := strconv.Atoi(v[:end])
	if err != nil || n >= 1000 {
		return -1
	}
	return n
}

// MajorJump reports whether going from one version to another raises the
// major version (both known).
func MajorJump(from, to string) bool {
	a, b := Major(from), Major(to)
	return a >= 0 && b >= 0 && b > a
}

// BackupTag is the tag the previous image keeps while an app is updated
// ("ghcr.io/immich-app/immich-server:whombat-previous-immich-server"), so
// nothing prunes it before the update is known to work.
func BackupTag(ref, service string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
			return r
		}
		return '-'
	}, service)
	tag := "whombat-previous-" + clean
	if len(tag) > 128 {
		tag = tag[:128]
	}
	return Repo(ref) + ":" + tag
}
