package broker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	golibvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/proto"
)

// unRAID management (docs/MANAGE.md 2.6): the array, parity, disks, the
// mover, plugins, unRAID's notifications and Docker the unRAID way, with
// the commands unRAID's own web page uses. Every argument is checked
// against the latest report and the files on disk first; the commands
// get fixed words and names that passed those checks, never free text.

// unraidCommands are the unRAID commands by name (paths below the root).
var unraidCommands = map[string]string{
	"emcmd":            "/usr/local/sbin/emcmd",
	"mover":            "/usr/local/sbin/mover",
	"plugin":           "/usr/local/sbin/plugin",
	"notify":           "/usr/local/emhttp/plugins/dynamix/scripts/notify",
	"update_container": "/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container",
	"dockerupdate":     "/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate",
}

// unRAID files the operations read or change (below the root).
const (
	unraidVarINI         = "/var/local/emhttp/var.ini"
	unraidPluginsDir     = "/var/log/plugins"
	unraidPluginsNew     = "/tmp/plugins"
	unraidAutostart      = "/var/lib/docker/unraid-autostart"
	unraidUserPrefs      = "/boot/config/plugins/dockerMan/userprefs.cfg"
	unraidTemplatesDir   = "/boot/config/plugins/dockerMan/templates-user"
	unraidStamps         = "/var/tmp/stamps.ini"
	unraidDynamixCfg     = "/boot/config/plugins/dynamix/dynamix.cfg"
	unraidNotifyDefault  = "/tmp/notifications"
	unraidMoverPID       = "/var/run/mover.pid"
	unraidParityProgress = 5 * time.Minute // a log line while a parity check runs
)

var (
	unraidPluginFileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}\.plg$`)
	unraidDiskNameRe   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	unraidNotifyIDRe   = regexp.MustCompile(`^[0-9A-Za-z_][0-9A-Za-z_.+@^%-]{0,199}$`)
)

// unraidManager runs the unRAID operations.
type unraidManager struct {
	root  string            // "" = the real root (tests: a fake tree)
	bins  map[string]string // command paths (tests: fakes that record their arguments)
	tasks *unraidTasks
	env   []string
	// isUnraid is whether the host runs unRAID (tests set it).
	isUnraid func() bool
	// autostartMu serializes changes of dockerMan's autostart list.
	autostartMu sync.Mutex
	// interval scales the waits' poll intervals (tests make them short).
	interval func(time.Duration) time.Duration
	// containerState reads a container's state after an update (nil: the
	// Docker driver's).
	containerState func(ctx context.Context, name string) (string, error)
}

func newUnraidManager(stateDir string) *unraidManager {
	if stateDir == "" {
		stateDir = os.TempDir()
	}
	bins := map[string]string{}
	for k, v := range unraidCommands {
		bins[k] = v
	}
	return &unraidManager{bins: bins, tasks: newUnraidTasks(filepath.Join(stateDir, "tasks")),
		env:      []string{"PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C"},
		isUnraid: isUnraid, interval: func(d time.Duration) time.Duration { return d }}
}

func (m *unraidManager) path(p string) string {
	if m.root == "" {
		return p
	}
	return filepath.Join(m.root, p)
}

// bin returns a command's path, or unsupported when unRAID does not have
// it (another version, or not unRAID).
func (m *unraidManager) bin(name string) (string, error) {
	p := m.bins[name]
	if p == "" {
		return "", codeErr(CodeUnsupported, "unknown command "+name)
	}
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		return "", codeErr(CodeUnsupported, "This version of Unraid has no "+filepath.Base(p)+": do it in Unraid’s own page.")
	}
	return p, nil
}

// unraidHostOps are the host operations with Platform "unraid".
var unraidHostOps = map[string]bool{
	proto.OpArrayStart: true, proto.OpArrayStop: true, proto.OpParityStart: true, proto.OpParityPause: true,
	proto.OpParityResume: true, proto.OpParityCancel: true, proto.OpDiskSpinUp: true, proto.OpDiskSpinDown: true,
	proto.OpMoverStart: true, proto.OpPluginCheck: true, proto.OpPluginUpdate: true, proto.OpNotificationArchive: true,
	proto.OpContainersCheck: true, proto.OpTaskList: true, proto.OpTaskStatus: true, proto.OpTaskStop: true,
}

// unraidManage answers the unRAID operations, task.status of an unRAID
// task on any platform, and the Docker / libvirt guest operations; ok is
// false for every other request (the platform managers answer those).
func (b *Broker) unraidManage(ctx context.Context, req proto.ManageRequest) (proto.ManageResponse, bool) {
	switch {
	case req.Platform == proto.PlatformUnraid:
	case req.Op == proto.OpTaskStatus || req.Op == proto.OpTaskStop:
		if !strings.HasPrefix(req.Task, proto.UnraidTaskPrefix) {
			return proto.ManageResponse{}, false
		}
	case req.Op == proto.OpContainerUpdate || req.Op == proto.OpGuestAutostart:
	case req.Op == proto.OpTaskList && req.Platform == proto.PlatformDocker && req.GuestID != "":
		// A container's tasks are its updates.
		return proto.ManageResponse{OK: true, Tasks: b.unraid().tasks.list(req.GuestID)}, true
	default:
		return proto.ManageResponse{}, false
	}
	m := b.unraid()
	resp, err := b.unraidOp(ctx, m, req)
	if err != nil {
		var fe *fieldError
		if errors.As(err, &fe) {
			return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: fe.msg, FieldErrors: map[string]string{fe.field: fe.msg}}, true
		}
		code, msg := errCode(err, CodePlatformError)
		return proto.ManageResponse{Code: code, Message: msg}, true
	}
	return resp, true
}

// runQuiet runs a short command and returns its output.
func runQuiet(ctx context.Context, env []string, argv ...string) (string, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Dir = "/"
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// unraid returns the manager (created on first use).
func (b *Broker) unraid() *unraidManager {
	b.unraidOnce.Do(func() {
		if b.unraidMgr == nil {
			b.unraidMgr = newUnraidManager(b.cfg.StateDir)
		}
		b.unraidMgr.tasks.onEnd = func() {
			if f := b.OnUnraidChange; f != nil {
				f()
			}
		}
	})
	return b.unraidMgr
}

func (b *Broker) unraidOp(ctx context.Context, m *unraidManager, req proto.ManageRequest) (proto.ManageResponse, error) {
	switch req.Op {
	case proto.OpTaskStatus:
		st, ok := m.tasks.status(req.Task, req.LogStart)
		if !ok {
			return proto.ManageResponse{}, codeErr(proto.CodeNotFound, "This task is not known (it ended over a day ago, or the agent restarted).")
		}
		return proto.ManageResponse{OK: true, TaskStatus: st}, nil
	case proto.OpTaskStop:
		if _, ok := m.tasks.status(req.Task, -1); !ok {
			return proto.ManageResponse{}, codeErr(proto.CodeNotFound, "This task is not known.")
		}
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "Unraid’s commands can’t be stopped halfway; cancel a parity check with parity.cancel.")
	case proto.OpContainerUpdate, proto.OpGuestAutostart:
		return b.unraidGuestOp(ctx, m, req)
	}
	if !unraidHostOps[req.Op] {
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "unknown Unraid operation")
	}
	if req.Op == proto.OpTaskList {
		return proto.ManageResponse{OK: true, Tasks: m.tasks.list("")}, nil
	}
	if !m.isUnraid() {
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "This server does not run Unraid.")
	}
	r := b.inventory()
	if r == nil || r.Unraid == nil {
		return proto.ManageResponse{}, codeErr(CodeInventory, "The agent hasn’t read Unraid’s state yet; try again in a moment.")
	}
	u := r.Unraid
	start := func(key string, steps func(context.Context, *unraidRun) (string, error)) (proto.ManageResponse, error) {
		id, err := m.tasks.start(req.Op, "", key, m.env, steps)
		if err != nil {
			return proto.ManageResponse{}, err
		}
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}, nil
	}
	switch req.Op {
	case proto.OpArrayStart:
		emcmd, err := m.bin("emcmd")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		if err := unraidCanStart(m, u); err != nil {
			return proto.ManageResponse{}, err
		}
		return start("array", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(emcmd, "cmdStart=Start"); err != nil {
				return "", err
			}
			run.logf("Waiting for the array to start…")
			if err := run.wait(ctx, "start the array", 15*time.Minute, m.interval(3*time.Second), m.varState(proto.UnraidArrayStarted)); err != nil {
				return "", err
			}
			return "The array is started.", nil
		})
	case proto.OpArrayStop:
		emcmd, err := m.bin("emcmd")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		if u.Array.State != proto.UnraidArrayStarted {
			return proto.ManageResponse{}, codeErr(CodeBusy, "The array is not started.")
		}
		return start("array", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(emcmd, "cmdStop=Stop"); err != nil {
				return "", err
			}
			run.logf("Waiting for the array to stop…")
			if err := run.wait(ctx, "stop the array", 15*time.Minute, m.interval(3*time.Second), m.varState(proto.UnraidArrayStopped)); err != nil {
				return "", err
			}
			return "The array is stopped.", nil
		})
	case proto.OpParityStart:
		emcmd, err := m.bin("emcmd")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		switch {
		case u.Array.State != proto.UnraidArrayStarted:
			return proto.ManageResponse{}, codeErr(CodeBusy, "Start the array first.")
		case u.Array.Parity.State != "idle":
			return proto.ManageResponse{}, codeErr(CodeBusy, "A parity operation is already running.")
		case req.Correct && u.Array.Parity.Disks == 0:
			return proto.ManageResponse{}, invalidField("correct", "There’s no parity disk to correct.")
		}
		arg := "cmdCheck=Check"
		if req.Correct {
			arg += "&optionCorrect=correct"
		}
		return start("array", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(emcmd, arg); err != nil {
				return "", err
			}
			return m.followParity(ctx, run)
		})
	case proto.OpParityPause, proto.OpParityResume, proto.OpParityCancel:
		emcmd, err := m.bin("emcmd")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		state := u.Array.Parity.State
		var arg, want, done string
		switch req.Op {
		case proto.OpParityPause:
			if state != "running" {
				return proto.ManageResponse{}, codeErr(CodeBusy, "No parity operation is running.")
			}
			arg, want, done = "cmdCheckPause=", "paused", "The parity check is paused."
		case proto.OpParityResume:
			if state != "paused" {
				return proto.ManageResponse{}, codeErr(CodeBusy, "No parity operation is paused.")
			}
			arg, want, done = "cmdCheckResume=", "running", "The parity check goes on."
		default:
			if state == "idle" {
				return proto.ManageResponse{}, codeErr(CodeBusy, "No parity operation is running.")
			}
			arg, want, done = "cmdCheckCancel=", "idle", "The parity check is cancelled."
		}
		return start("parity:"+req.Op, func(ctx context.Context, run *unraidRun) (string, error) {
			// What the Main page's ParityControl.php does first: the
			// times of pauses and resumes (unRAID leaves them out of the
			// check's duration).
			if req.Op != proto.OpParityCancel {
				m.stamp(req.Op == proto.OpParityPause)
			}
			if err := run.command(emcmd, arg); err != nil {
				return "", err
			}
			if err := run.wait(ctx, "change the parity operation", time.Minute, m.interval(2*time.Second), m.parityState(want)); err != nil {
				return "", err
			}
			return done, nil
		})
	case proto.OpDiskSpinUp, proto.OpDiskSpinDown:
		emcmd, err := m.bin("emcmd")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		verb := "up"
		if req.Op == proto.OpDiskSpinDown {
			verb = "down"
		}
		arg := "cmdSpin" + verb + "All=Apply"
		if req.Disk != "all" {
			if !unraidDiskNameRe.MatchString(req.Disk) || !unraidHasDisk(u, req.Disk) {
				return proto.ManageResponse{}, codeErr(proto.CodeNotFound, "No disk "+strconv.Quote(req.Disk)+" in the array or a pool.")
			}
			arg = "cmdSpin" + verb + "=" + req.Disk
		}
		return start("spin", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(emcmd, arg); err != nil {
				return "", err
			}
			if req.Disk == "all" {
				return "Spinning " + verb + " every disk.", nil
			}
			return "Spinning " + verb + " " + req.Disk + ".", nil
		})
	case proto.OpMoverStart:
		mover, err := m.bin("mover")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		switch {
		case u.Array.State != proto.UnraidArrayStarted:
			return proto.ManageResponse{}, codeErr(CodeBusy, "Start the array first.")
		case u.Array.MoverRunning || m.moverRunning():
			return proto.ManageResponse{}, codeErr(CodeBusy, "The mover is already running.")
		}
		return start("mover", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(mover, "start"); err != nil {
				return "", err
			}
			return "The mover is done.", nil
		})
	case proto.OpPluginCheck:
		plugin, err := m.bin("plugin")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		return start("plugin", func(ctx context.Context, run *unraidRun) (string, error) {
			if err := run.command(plugin, "checkall"); err != nil {
				return "", err
			}
			return "Checked every plugin for updates.", nil
		})
	case proto.OpPluginUpdate:
		plugin, err := m.bin("plugin")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		files, err := m.pluginFiles(u, req.Plugin)
		if err != nil {
			return proto.ManageResponse{}, err
		}
		return start("plugin", func(ctx context.Context, run *unraidRun) (string, error) {
			var failed []string
			for _, f := range files {
				if err := run.command(plugin, "update", f); err != nil {
					run.logf("%s: %v", f, err)
					failed = append(failed, strings.TrimSuffix(f, ".plg"))
				}
			}
			switch {
			case len(failed) > 0:
				return "", fmt.Errorf("Could not update %s.", strings.Join(failed, ", "))
			case len(files) == 1:
				return strings.TrimSuffix(files[0], ".plg") + " is up to date.", nil
			}
			return fmt.Sprintf("%d plugins updated.", len(files)), nil
		})
	case proto.OpNotificationArchive:
		return m.archiveNotifications(ctx, req.Notification)
	case proto.OpContainersCheck:
		script, err := m.bin("dockerupdate")
		if err != nil {
			return proto.ManageResponse{}, err
		}
		if !u.Docker.Enabled {
			return proto.ManageResponse{}, codeErr(CodeBusy, "Docker is turned off in Unraid.")
		}
		return start("containers", func(ctx context.Context, run *unraidRun) (string, error) {
			// "nonotify": like the Docker page's own button, no unRAID
			// notification for each update found.
			if err := run.command(script, "check", "nonotify"); err != nil {
				return "", err
			}
			return "Checked the containers for updates.", nil
		})
	}
	return proto.ManageResponse{}, codeErr(CodeUnsupported, "unknown Unraid operation")
}

func (b *Broker) inventory() *proto.Report {
	if b.inv == nil {
		return nil
	}
	return b.inv()
}

func invalidField(field, msg string) error {
	return &fieldError{field: field, msg: msg}
}

// fieldError is an invalid_value with the field it is about.
type fieldError struct{ field, msg string }

func (e *fieldError) Error() string { return e.msg }

// unraidCanStart refuses a start that unRAID's own page would ask
// questions for: only the plain "Stopped, configuration valid" state
// starts from here; an encrypted array needs the passphrase unless the
// keyfile is there.
func unraidCanStart(m *unraidManager, u *proto.Unraid) error {
	switch u.Array.State {
	case proto.UnraidArrayStarted, proto.UnraidArrayStarting:
		return codeErr(CodeBusy, "The array is already started.")
	case proto.UnraidArrayStopping:
		return codeErr(CodeBusy, "The array is stopping; try again in a moment.")
	case proto.UnraidArrayInvalid:
		return codeErr(proto.CodeNotAllowed, "Unraid can’t start the array as it is set up now: open its Main page.")
	}
	if u.Array.StateRaw != "STOPPED" {
		return codeErr(proto.CodeNotAllowed, "This start needs a choice in Unraid’s own page (a new, missing or replaced disk).")
	}
	for _, d := range u.Array.Disks {
		switch d.Status {
		case "missing", "wrong", "new", "invalid":
			return codeErr(proto.CodeNotAllowed, "This start needs a choice in Unraid’s own page ("+d.Name+" is "+d.Status+").")
		}
	}
	if u.Encrypted && !u.KeyfilePresent {
		return codeErr(proto.CodeNotAllowed, "The array is encrypted: start it in Unraid’s own page, where you type the passphrase.")
	}
	return nil
}

// varINI reads emhttp's var.ini.
func (m *unraidManager) varINI() (map[string]string, error) {
	b, err := os.ReadFile(m.path(unraidVarINI))
	if err != nil {
		return nil, err
	}
	return parseFlatINI(b), nil
}

// parseFlatINI reads key="value" lines (sections ignored).
func parseFlatINI(b []byte) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.HasPrefix(k, "[") || strings.HasPrefix(k, ";") || strings.HasPrefix(k, "#") {
			continue
		}
		out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"`)
	}
	return out
}

// varState is a wait condition: the array reached the state (started:
// mdState STARTED and fsState Started; stopped: mdState not STARTED and
// fsState Stopped).
func (m *unraidManager) varState(want string) func() (bool, error) {
	return func() (bool, error) {
		v, err := m.varINI()
		if err != nil {
			return false, err
		}
		md, fs := strings.ToUpper(v["mdState"]), strings.ToLower(v["fsState"])
		if want == proto.UnraidArrayStarted {
			return md == "STARTED" && strings.HasPrefix(fs, "started"), nil
		}
		return md != "STARTED" && strings.HasPrefix(fs, "stopped"), nil
	}
}

// parityState is a wait condition on md's resync state: running |
// paused | idle.
func (m *unraidManager) parityState(want string) func() (bool, error) {
	return func() (bool, error) {
		v, err := m.varINI()
		if err != nil {
			return false, err
		}
		return unraidParityNow(v) == want, nil
	}
}

func unraidParityNow(v map[string]string) string {
	pos, _ := strconv.ParseInt(v["mdResyncPos"], 10, 64)
	if pos <= 0 {
		return "idle"
	}
	if r, _ := strconv.ParseInt(v["mdResync"], 10, 64); r == 0 {
		return "paused"
	}
	return "running"
}

// followParity follows a parity operation the agent started until it
// ends (a progress line every few minutes) and says how it went.
func (m *unraidManager) followParity(ctx context.Context, run *unraidRun) (string, error) {
	if err := run.wait(ctx, "start the parity check", time.Minute, m.interval(2*time.Second), func() (bool, error) {
		v, err := m.varINI()
		return err == nil && unraidParityNow(v) != "idle", err
	}); err != nil {
		return "", err
	}
	run.logf("The parity check is running.")
	last := time.Now()
	lastState := "running"
	err := run.wait(ctx, "finish the parity check", 7*24*time.Hour, m.interval(10*time.Second), func() (bool, error) {
		v, err := m.varINI()
		if err != nil {
			return false, err
		}
		st := unraidParityNow(v)
		if st == "idle" {
			return true, nil
		}
		if st != lastState {
			run.logf("The parity check is %s.", st)
			lastState = st
		}
		if st == "running" && time.Since(last) >= unraidParityProgress {
			last = time.Now()
			pos, _ := strconv.ParseFloat(v["mdResyncPos"], 64)
			size, _ := strconv.ParseFloat(v["mdResyncSize"], 64)
			if size > 0 {
				run.logf("%.1f %% done, %s errors so far.", pos/size*100, orZero(v["sbSyncErrs"]))
			}
		}
		return false, nil
	})
	if err != nil {
		return "", err
	}
	v, err := m.varINI()
	if err != nil {
		return "", err
	}
	errs, _ := strconv.ParseInt(v["sbSyncErrs"], 10, 64)
	switch exit, _ := strconv.ParseInt(v["sbSyncExit"], 10, 64); {
	case exit == -4:
		return "", errors.New("The parity check was cancelled.")
	case exit != 0:
		return "", fmt.Errorf("The parity check stopped with error code %d.", exit)
	case errs == 1:
		return "1 error found.", nil
	case errs > 1:
		return fmt.Sprintf("%d errors found.", errs), nil
	}
	return "No errors.", nil
}

func orZero(s string) string {
	if s == "" {
		return "0"
	}
	return s
}

// stamp records a pause or resume time like the Main page's
// ParityControl.php (/var/tmp/stamps.ini: the check's start, then the
// pause and resume times).
func (m *unraidManager) stamp(pause bool) {
	p := m.path(unraidStamps)
	if _, err := os.Stat(p); pause && errors.Is(err, os.ErrNotExist) {
		v, _ := m.varINI()
		_ = os.WriteFile(p, []byte(v["sbSynced"]), 0o644)
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, ",%d", time.Now().Unix())
}

func (m *unraidManager) moverRunning() bool {
	b, err := os.ReadFile(m.path(unraidMoverPID))
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return false
	}
	_, err = os.Stat(m.path(fmt.Sprintf("/proc/%d", pid)))
	return err == nil
}

// unraidHasDisk: the disk is in the array or a pool of the report and
// has a device.
func unraidHasDisk(u *proto.Unraid, name string) bool {
	for _, d := range u.Array.Disks {
		if d.Name == name && d.Device != "" {
			return true
		}
	}
	for _, p := range u.Pools {
		for _, d := range p.Disks {
			if d.Name == name && d.Device != "" {
				return true
			}
		}
	}
	return false
}

// pluginFiles checks the plugin(s) to update: an installed plugin
// (/var/log/plugins) that unRAID's check found a newer version of
// (/tmp/plugins), never unRAID itself; "all" = every plugin the report
// lists with an update.
func (m *unraidManager) pluginFiles(u *proto.Unraid, plugin string) ([]string, error) {
	var files []string
	if plugin == "all" {
		for _, p := range u.Plugins {
			if p.Update != "" {
				files = append(files, p.File)
			}
		}
		if len(files) == 0 {
			return nil, codeErr(proto.CodeNotFound, "No plugin has an update.")
		}
	} else {
		files = []string{plugin}
	}
	for _, f := range files {
		switch {
		case !unraidPluginFileRe.MatchString(f):
			return nil, invalidField("plugin", "Not a plugin file name.")
		case f == "unRAIDServer.plg":
			return nil, codeErr(proto.CodeNotAllowed, "Unraid itself is updated in its own page (it needs a reboot).")
		}
		if _, err := os.Stat(m.path(filepath.Join(unraidPluginsDir, f))); err != nil {
			return nil, codeErr(proto.CodeNotFound, "No plugin "+f+" is installed.")
		}
		if _, err := os.Stat(m.path(filepath.Join(unraidPluginsNew, f))); err != nil {
			return nil, codeErr(proto.CodeNotFound, "Unraid hasn’t found a newer "+f+": check for updates first.")
		}
	}
	return files, nil
}

// notifyPath is where unRAID keeps its notifications (dynamix.cfg
// [notify] path).
func (m *unraidManager) notifyPath() string {
	b, err := os.ReadFile(m.path(unraidDynamixCfg))
	if err != nil {
		return unraidNotifyDefault
	}
	sec := ""
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") {
			sec = strings.Trim(t, "[]\"")
			continue
		}
		if k, v, ok := strings.Cut(t, "="); ok && sec == "notify" && strings.TrimSpace(k) == "path" {
			if p := strings.Trim(strings.TrimSpace(v), `"`); filepath.IsAbs(p) {
				return filepath.Clean(p)
			}
		}
	}
	return unraidNotifyDefault
}

// archiveNotifications archives one unread notification or all of them
// with unRAID's own `notify archive <file>` (unRAID 7 keeps the archive
// copy from the start; archiving removes the unread one). Done at once.
func (m *unraidManager) archiveNotifications(ctx context.Context, id string) (proto.ManageResponse, error) {
	notify, err := m.bin("notify")
	if err != nil {
		return proto.ManageResponse{}, err
	}
	dir := filepath.Join(m.notifyPath(), "unread")
	ents, err := os.ReadDir(m.path(dir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return proto.ManageResponse{}, codeErr(CodePlatformError, "cannot read Unraid’s notifications: "+err.Error())
	}
	var files []string
	for _, e := range ents {
		n, ok := strings.CutSuffix(e.Name(), ".notify")
		if !ok || e.IsDir() || !unraidNotifyIDRe.MatchString(n) {
			continue
		}
		if id == "" || n == id {
			files = append(files, e.Name())
		}
	}
	if id != "" && len(files) == 0 {
		if !unraidNotifyIDRe.MatchString(id) {
			return proto.ManageResponse{}, invalidField("id", "Not a notification id.")
		}
		return proto.ManageResponse{}, codeErr(proto.CodeNotFound, "No unread notification "+strconv.Quote(id)+".")
	}
	sort.Strings(files)
	if len(files) > 1000 {
		files = files[:1000]
	}
	for _, f := range files {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		out, err := runQuiet(cctx, m.env, notify, "archive", f)
		cancel()
		if err != nil {
			return proto.ManageResponse{}, codeErr(CodePlatformError, "Unraid’s notify archive failed: "+firstLineOf(strings.TrimSpace(out+" "+err.Error())))
		}
	}
	return proto.ManageResponse{OK: true}, nil
}

// unraidGuestOp is container.update and guest.autostart.
func (b *Broker) unraidGuestOp(ctx context.Context, m *unraidManager, req proto.ManageRequest) (proto.ManageResponse, error) {
	switch req.Platform {
	case proto.PlatformDocker:
		if !m.isUnraid() {
			return proto.ManageResponse{}, codeErr(CodeUnsupported, "Container updates and autostart are Unraid features; this server does not run Unraid.")
		}
	case proto.PlatformLibvirt:
		if req.Op == proto.OpContainerUpdate {
			return proto.ManageResponse{}, codeErr(CodeUnsupported, "Only containers are updated from a template.")
		}
	default:
		return proto.ManageResponse{}, codeErr(CodeUnsupported, "This works for Docker containers on Unraid and libvirt VMs only.")
	}
	g, _, err := b.lookup(req.Platform, req.GuestID)
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if req.Op == proto.OpGuestAutostart && req.On == nil {
		return proto.ManageResponse{}, invalidField("on", "Say on (true) or off (false).")
	}
	unlock, ok := b.lockGuest(ctx, req.Platform, g.ID)
	if !ok {
		return proto.ManageResponse{}, codeErr(CodeBusy, "another action on this guest is still running")
	}
	defer unlock()
	if req.Op == proto.OpGuestAutostart && req.Platform == proto.PlatformLibvirt {
		d, _ := b.drivers[proto.PlatformLibvirt].(*libvirtDriver)
		if d == nil {
			return proto.ManageResponse{}, codeErr(CodeUnsupported, "libvirt is not available")
		}
		flag := int32(0)
		if *req.On {
			flag = 1
		}
		if err := d.withDomain(ctx, g, func(l *golibvirt.Libvirt, dom golibvirt.Domain) error {
			return l.DomainSetAutostart(dom, flag)
		}); err != nil {
			return proto.ManageResponse{}, err
		}
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{autostartChange(g.Autostart, *req.On)}}, nil
	}
	if !dockerNameRe.MatchString(g.ID) {
		return proto.ManageResponse{}, invalidField("guest", "Not a container name Unraid uses.")
	}
	if req.Op == proto.OpGuestAutostart {
		if err := m.setAutostart(g.ID, *req.On); err != nil {
			return proto.ManageResponse{}, err
		}
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{autostartChange(g.Autostart, *req.On)}}, nil
	}
	// container.update: dockerMan's update_container with the name, for a
	// container it made from a template.
	script, err := m.bin("update_container")
	if err != nil {
		return proto.ManageResponse{}, err
	}
	if !m.hasTemplate(g.ID) {
		return proto.ManageResponse{}, codeErr(proto.CodeNotAllowed, "This container wasn’t set up from an Unraid template: update it where it was created.")
	}
	name := g.ID
	wasRunning := g.State == proto.StateRunning || g.State == proto.StateUnhealthy
	state := m.containerState
	if dd, _ := b.drivers[proto.PlatformDocker].(*dockerDriver); state == nil && dd != nil {
		state = func(ctx context.Context, name string) (string, error) { return dd.state(ctx, &proto.Guest{ID: name}) }
	}
	id, err := m.tasks.start(req.Op, name, "container:"+name, m.env, func(ctx context.Context, run *unraidRun) (string, error) {
		run.logf("Updating %s from its template: pulling the image and creating the container again.", name)
		if err := run.command(script, name); err != nil {
			return "", err
		}
		// update_container reports to the Docker page, not on its output,
		// and exits 0 either way: check the container is back.
		if state != nil {
			st, err := state(ctx, name)
			switch {
			case err != nil:
				return "", fmt.Errorf("%s is gone after the update: recreate it from its template in Unraid", name)
			case wasRunning && st != proto.StateRunning && st != proto.StateUnhealthy:
				return "", fmt.Errorf("%s is updated but didn’t start again", name)
			}
		}
		return name + " is up to date.", nil
	})
	if err != nil {
		return proto.ManageResponse{}, err
	}
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}, nil
}

func autostartChange(old *bool, on bool) proto.ConfigChange {
	c := proto.ConfigChange{Key: "autostart", New: strconv.FormatBool(on)}
	if old != nil {
		c.Old = strconv.FormatBool(*old)
	}
	return c
}

// hasTemplate: a dockerMan user template has <Name> = the container (the
// template update_container looks for).
func (m *unraidManager) hasTemplate(name string) bool {
	ents, err := os.ReadDir(m.path(unraidTemplatesDir))
	if err != nil {
		return false
	}
	tag := regexp.MustCompile(`(?s)<Name>\s*(.*?)\s*</Name>`)
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".xml") {
			continue
		}
		b, err := os.ReadFile(m.path(filepath.Join(unraidTemplatesDir, e.Name())))
		if err != nil || len(b) > 1<<20 {
			continue
		}
		if mm := tag.FindSubmatch(b); mm != nil && string(mm[1]) == name {
			return true
		}
	}
	return false
}

// setAutostart changes dockerMan's autostart list the way its Docker page
// does (UpdateConfig.php): a line per container, "name" or "name wait";
// turning one on adds its line and sorts the list (by the page's own
// order in userprefs.cfg, else by name); turning one off removes its line
// and keeps the others as they are. An empty list removes the file.
func (m *unraidManager) setAutostart(name string, on bool) error {
	m.autostartMu.Lock()
	defer m.autostartMu.Unlock()
	p := m.path(unraidAutostart)
	b, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return codeErr(CodePlatformError, "cannot read the autostart list: "+err.Error())
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	first := func(l string) string { return strings.SplitN(l, " ", 2)[0] }
	idx := -1
	for i, l := range lines {
		if first(l) == name {
			idx = i
		}
	}
	switch {
	case on && idx >= 0, !on && idx < 0:
		return nil // already so
	case on:
		lines = append(lines, name)
		m.sortAutostart(lines)
	default:
		out := lines[:0]
		for _, l := range lines {
			if first(l) != name {
				out = append(out, l)
			}
		}
		lines = out
	}
	if len(lines) == 0 {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return codeErr(CodePlatformError, "cannot change the autostart list: "+err.Error())
		}
		return nil
	}
	tmp := p + ".whombat"
	if err := os.WriteFile(tmp, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		return codeErr(CodePlatformError, "cannot change the autostart list: "+err.Error())
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return codeErr(CodePlatformError, "cannot change the autostart list: "+err.Error())
	}
	return nil
}

// sortAutostart orders the autostart lines like dockerMan: by the
// container's position in userprefs.cfg (index="name" lines; containers
// without one count as 0), ties by the line; without userprefs.cfg in
// natural, case-insensitive name order.
func (m *unraidManager) sortAutostart(lines []string) {
	b, err := os.ReadFile(m.path(unraidUserPrefs))
	if err != nil {
		sort.SliceStable(lines, func(i, j int) bool { return natLess(strings.ToLower(lines[i]), strings.ToLower(lines[j])) })
		return
	}
	pos := map[string]int{}
	for k, v := range parseFlatINI(b) {
		if n, err := strconv.Atoi(k); err == nil {
			if _, dup := pos[v]; !dup {
				pos[v] = n
			}
		}
	}
	key := func(l string) int { return pos[strings.SplitN(l, " ", 2)[0]] }
	sort.SliceStable(lines, func(i, j int) bool {
		if a, b := key(lines[i]), key(lines[j]); a != b {
			return a < b
		}
		return lines[i] < lines[j]
	})
}

// natLess is a natural order: digit runs compare as numbers.
func natLess(a, b string) bool {
	for a != "" && b != "" {
		da, db := a[0] >= '0' && a[0] <= '9', b[0] >= '0' && b[0] <= '9'
		if da && db {
			i, j := 0, 0
			for i < len(a) && a[i] >= '0' && a[i] <= '9' {
				i++
			}
			for j < len(b) && b[j] >= '0' && b[j] <= '9' {
				j++
			}
			na, nb := strings.TrimLeft(a[:i], "0"), strings.TrimLeft(b[:j], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			a, b = a[i:], b[j:]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}
