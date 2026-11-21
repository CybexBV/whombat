package broker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// unraidFixture is a fake unRAID: a root tree with emhttp's var.ini,
// dockerMan's files, plugins and notifications, and fake emcmd, mover,
// plugin, notify, update_container and dockerupdate that record their
// arguments (one line per call) and act a little like the real ones.
type unraidFixture struct {
	t    *testing.T
	root string
	log  string
	b    *Broker
	m    *unraidManager
	mu   sync.Mutex
	rep  *proto.Report
}

const unraidVarStopped = `version="7.3.1"
NAME="BlackBox"
mdState="STOPPED"
fsState="Stopped"
configValid="yes"
mdResync="0"
mdResyncPos="0"
mdResyncSize="1953513560"
sbSynced="1790000000"
sbSyncErrs="0"
sbSyncExit="0"
csrf_token="0123456789ABCDEF"
`

func newUnraidFixture(t *testing.T) *unraidFixture {
	t.Helper()
	f := &unraidFixture{t: t, root: t.TempDir()}
	f.log = filepath.Join(f.root, "calls.log")
	f.write("var/local/emhttp/var.ini", unraidVarStopped)
	f.write("var/log/plugins/tailscale.plg", "<PLUGIN name=\"tailscale\" version=\"2026.10.08\">")
	f.write("var/log/plugins/unassigned.devices.plg", "<PLUGIN name=\"unassigned.devices\" version=\"2026.10.12\">")
	f.write("var/log/plugins/unRAIDServer.plg", "<PLUGIN name=\"unRAIDServer\" version=\"7.3.1\">")
	f.write("tmp/plugins/tailscale.plg", "<PLUGIN name=\"tailscale\" version=\"2026.10.15\">")
	f.write("tmp/plugins/unRAIDServer.plg", "<PLUGIN name=\"unRAIDServer\" version=\"7.3.3\">")
	f.write("tmp/notifications/unread/Docker___plex_06e0..c4b8_ticket.notify", "timestamp=1791245412\n")
	f.write("tmp/notifications/unread/Unraid_Parity_check_1792210000.notify", "timestamp=1792210000\n")
	f.write("boot/config/plugins/dockerMan/templates-user/my-plex.xml", "<?xml version=\"1.0\"?>\n<Container version=\"2\">\n  <Name>plex</Name>\n</Container>\n")
	f.write("var/lib/docker/unraid-autostart", "plex\nradarr 10\nsonarr\n")
	if err := os.MkdirAll(filepath.Join(f.root, "var/tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(f.root, "bin")
	vars := filepath.Join(f.root, "var/local/emhttp/var.ini")
	// emcmd changes var.ini the way emhttp would.
	f.script(bin, "emcmd", fmt.Sprintf(`case "$1" in
cmdStart=Start) sed -i 's/^mdState=.*/mdState="STARTED"/; s/^fsState=.*/fsState="Started"/' %[1]s ;;
cmdStop=Stop) sed -i 's/^mdState=.*/mdState="STOPPED"/; s/^fsState=.*/fsState="Stopped"/' %[1]s ;;
cmdCheck=Check*) sed -i 's/^mdResyncPos=.*/mdResyncPos="1000"/; s/^mdResync=.*/mdResync="1953513560"/' %[1]s ;;
cmdCheckPause=) sed -i 's/^mdResync=.*/mdResync="0"/' %[1]s ;;
cmdCheckResume=) sed -i 's/^mdResync=.*/mdResync="1953513560"/' %[1]s ;;
cmdCheckCancel=) sed -i 's/^mdResyncPos=.*/mdResyncPos="0"/; s/^sbSyncExit=.*/sbSyncExit="-4"/' %[1]s ;;
cmdSpinup=bad) echo "error: no such disk" >&2; exit 1 ;;
esac`, vars))
	f.script(bin, "mover", `echo "mover: started" >&2; echo "mover: finished" >&2`)
	f.script(bin, "plugin", `if [ "$2" = "unassigned.devices.plg" ]; then echo "plugin: download failed" >&2; exit 1; fi; echo "plugin: $2 updated"`)
	f.script(bin, "notify", fmt.Sprintf(`rm -f "%s/tmp/notifications/unread/$2"`, f.root))
	f.script(bin, "update_container", `echo "<p class='logLine'>Pulling image</p>"`)
	f.script(bin, "dockerupdate", `echo " Done."`)
	f.rep = &proto.Report{Unraid: &proto.Unraid{Version: "7.3.1", Name: "BlackBox",
		Array: proto.UnraidArray{State: proto.UnraidArrayStopped, StateRaw: "STOPPED", ConfigValid: true,
			Parity: proto.UnraidParity{State: "idle", Disks: 1},
			Disks:  []proto.UnraidDisk{{Name: "parity", Slot: "parity", Device: "sdb", Status: "ok"}, {Name: "disk1", Slot: "data", Device: "sdi", Status: "ok"}}},
		Pools:   []proto.UnraidPool{{Name: "apps", Disks: []proto.UnraidDisk{{Name: "apps", Device: "sdc"}, {Name: "apps2", Device: "sdd"}}}},
		Plugins: []proto.UnraidPlugin{{Name: "tailscale", File: "tailscale.plg", Version: "2026.10.08", Update: "2026.10.15"}, {Name: "unassigned.devices", File: "unassigned.devices.plg", Version: "2026.10.12"}},
		Docker:  proto.UnraidService{Enabled: true}},
		Docker: &proto.Platform{Guests: []proto.Guest{{ID: "plex", Name: "plex", Kind: "container", State: proto.StateRunning},
			{ID: "immich_server", Name: "immich_server", Kind: "container", State: proto.StateStopped},
			{ID: "radarr", Name: "radarr", Kind: "container", State: proto.StateRunning},
			{ID: "sonarr", Name: "sonarr", Kind: "container", State: proto.StateRunning}}},
		Libvirt: &proto.Platform{Guests: []proto.Guest{{ID: "pbs", Name: "pbs", Kind: "vm", State: proto.StateRunning}}},
	}
	f.b = NewBroker(&agent.Config{StateDir: filepath.Join(f.root, "state")}, func() *proto.Report {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.rep
	}, nil)
	f.m = newUnraidManager(filepath.Join(f.root, "state"))
	f.m.root = f.root
	f.m.isUnraid = func() bool { return true }
	f.m.interval = func(time.Duration) time.Duration { return 10 * time.Millisecond }
	f.m.containerState = func(context.Context, string) (string, error) { return proto.StateRunning, nil }
	for name := range f.m.bins {
		f.m.bins[name] = filepath.Join(bin, name)
	}
	f.b.unraidMgr = f.m
	return f
}

// write replaces a file in one step (a new file renamed over it), as the
// fake emcmd's sed -i does: the agent reads var.ini every few milliseconds
// while a task runs, and a file emptied and then written could be read empty
// in between, which looks like a parity check that ended with no errors.
func (f *unraidFixture) write(rel, content string) {
	f.t.Helper()
	p := filepath.Join(f.root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	tmp := p + ".new"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil {
		f.t.Fatal(err)
	}
}

func (f *unraidFixture) read(rel string) string {
	b, _ := os.ReadFile(filepath.Join(f.root, rel))
	return string(b)
}

func (f *unraidFixture) script(dir, name, body string) {
	f.t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.t.Fatal(err)
	}
	s := fmt.Sprintf("#!/bin/sh\necho \"%s $*\" >> %s\n%s\n", name, f.log, body)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o755); err != nil {
		f.t.Fatal(err)
	}
}

func (f *unraidFixture) calls() []string {
	b, _ := os.ReadFile(f.log)
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func (f *unraidFixture) setReport(edit func(u *proto.Unraid)) {
	f.mu.Lock()
	edit(f.rep.Unraid)
	f.mu.Unlock()
}

func (f *unraidFixture) manage(req proto.ManageRequest) proto.ManageResponse {
	f.t.Helper()
	if req.Platform == "" {
		req.Platform = proto.PlatformUnraid
	}
	return f.b.Manage(context.Background(), req)
}

// done waits for a task to end and returns its status with the log.
func (f *unraidFixture) done(resp proto.ManageResponse) *proto.TaskStatus {
	f.t.Helper()
	if !resp.OK || resp.Task == nil || !strings.HasPrefix(resp.Task.ID, "unraid:") || len(resp.Task.ID) != len("unraid:")+16 {
		f.t.Fatalf("no task: %+v", resp)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := f.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformUnraid, Task: resp.Task.ID})
		if !st.OK {
			f.t.Fatalf("task.status: %+v", st)
		}
		if st.TaskStatus.Status != "running" {
			return st.TaskStatus
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.t.Fatalf("task %s did not end", resp.Task.ID)
	return nil
}

// logged waits until a running task's log has the line.
func (f *unraidFixture) logged(resp proto.ManageResponse, line string) {
	f.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := f.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformUnraid, Task: resp.Task.ID})
		if !st.OK {
			f.t.Fatalf("task.status: %+v", st)
		}
		if slices.Contains(st.TaskStatus.Log, line) {
			return
		}
		if st.TaskStatus.Status != "running" {
			f.t.Fatalf("task %s ended before logging %q: %+v", resp.Task.ID, line, st.TaskStatus)
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.t.Fatalf("task %s did not log %q", resp.Task.ID, line)
}

func TestUnraidArrayAndParity(t *testing.T) {
	f := newUnraidFixture(t)
	st := f.done(f.manage(proto.ManageRequest{Op: proto.OpArrayStart}))
	if st.Status != "ok" || st.Message != "The array is started." || st.Type != "array.start" {
		t.Fatalf("start: %+v", st)
	}
	if !strings.Contains(strings.Join(st.Log, "\n"), "$ ") || !strings.Contains(strings.Join(st.Log, "\n"), "cmdStart=Start") {
		t.Errorf("log: %q", st.Log)
	}
	// The report still says stopped until the collector reads again: a
	// second start is refused by state, not sent.
	f.setReport(func(u *proto.Unraid) { u.Array.State, u.Array.StateRaw = proto.UnraidArrayStarted, "STARTED" })
	if r := f.manage(proto.ManageRequest{Op: proto.OpArrayStart}); r.Code != CodeBusy {
		t.Errorf("start when started: %+v", r)
	}
	// Parity check with corrections, followed until md is done.
	resp := f.manage(proto.ManageRequest{Op: proto.OpParityStart, Correct: true})
	if !resp.OK {
		t.Fatalf("parity.start: %+v", resp)
	}
	// A second array command waits for this one.
	if r := f.manage(proto.ManageRequest{Op: proto.OpArrayStop}); r.Code != CodeBusy || !strings.Contains(r.Message, "array or parity") {
		t.Errorf("stop during the check: %+v", r)
	}
	// md finishes only after the agent saw the check running.
	f.logged(resp, "The parity check is running.")
	vars := f.read("var/local/emhttp/var.ini")
	f.write("var/local/emhttp/var.ini", strings.NewReplacer(`mdResyncPos="1000"`, `mdResyncPos="0"`, `sbSyncErrs="0"`, `sbSyncErrs="3"`).Replace(vars))
	if st := f.done(resp); st.Status != "ok" || st.Message != "3 errors found." {
		t.Fatalf("parity: %+v", st)
	}
	// Pause, resume, cancel.
	f.write("var/local/emhttp/var.ini", strings.NewReplacer(`mdResyncPos="0"`, `mdResyncPos="1000"`).Replace(f.read("var/local/emhttp/var.ini")))
	f.setReport(func(u *proto.Unraid) { u.Array.Parity.State = "running" })
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpParityPause})); st.Status != "ok" || st.Message != "The parity check is paused." {
		t.Fatalf("pause: %+v", st)
	}
	if s := f.read("var/tmp/stamps.ini"); !strings.HasPrefix(s, "1790000000,") {
		t.Errorf("stamps after pause: %q", s)
	}
	f.setReport(func(u *proto.Unraid) { u.Array.Parity.State = "paused" })
	if r := f.manage(proto.ManageRequest{Op: proto.OpParityPause}); r.Code != CodeBusy {
		t.Errorf("pause when paused: %+v", r)
	}
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpParityResume})); st.Status != "ok" {
		t.Fatalf("resume: %+v", st)
	}
	if s := f.read("var/tmp/stamps.ini"); strings.Count(s, ",") != 2 {
		t.Errorf("stamps after resume: %q", s)
	}
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpParityCancel})); st.Status != "ok" || st.Message != "The parity check is cancelled." {
		t.Fatalf("cancel: %+v", st)
	}
	f.setReport(func(u *proto.Unraid) { u.Array.Parity.State = "idle" })
	if r := f.manage(proto.ManageRequest{Op: proto.OpParityCancel}); r.Code != CodeBusy {
		t.Errorf("cancel when idle: %+v", r)
	}
	f.setReport(func(u *proto.Unraid) { u.Array.Parity.Disks = 0 })
	if r := f.manage(proto.ManageRequest{Op: proto.OpParityStart, Correct: true}); r.Code != proto.CodeInvalidValue || r.FieldErrors["correct"] == "" {
		t.Errorf("correct without parity: %+v", r)
	}
	// Stop.
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpArrayStop})); st.Status != "ok" || st.Message != "The array is stopped." {
		t.Fatalf("stop: %+v", st)
	}
	want := []string{"emcmd cmdStart=Start", "emcmd cmdCheck=Check&optionCorrect=correct", "emcmd cmdCheckPause=",
		"emcmd cmdCheckResume=", "emcmd cmdCheckCancel=", "emcmd cmdStop=Stop"}
	if got := f.calls(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("calls:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// Tasks: newest first.
	l := f.manage(proto.ManageRequest{Op: proto.OpTaskList})
	if !l.OK || len(l.Tasks) != 6 || l.Tasks[0].Type != "array.stop" || l.Tasks[5].Type != "array.start" || l.Tasks[0].Log != nil {
		t.Errorf("task.list: %+v", l.Tasks)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpTaskStop, Task: l.Tasks[0].ID}); r.Code != CodeUnsupported {
		t.Errorf("task.stop: %+v", r)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformDocker, Task: "unraid:0000000000000000"}); r.Code != proto.CodeNotFound {
		t.Errorf("unknown task: %+v", r)
	}
	// Log pages.
	st = f.done(proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: l.Tasks[0].ID}})
	page := f.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Task: l.Tasks[0].ID, LogStart: 1})
	if page.TaskStatus.LogNext != len(st.Log) || len(page.TaskStatus.Log) != len(st.Log)-1 {
		t.Errorf("log page: %+v vs %d lines", page.TaskStatus, len(st.Log))
	}
	if none := f.manage(proto.ManageRequest{Op: proto.OpTaskStatus, Task: l.Tasks[0].ID, LogStart: -1}); none.TaskStatus.Log != nil {
		t.Errorf("log_start -1: %+v", none.TaskStatus)
	}
}

func TestUnraidStartRefusals(t *testing.T) {
	f := newUnraidFixture(t)
	for _, c := range []struct {
		edit func(u *proto.Unraid)
		code string
	}{
		{func(u *proto.Unraid) { u.Array.State = proto.UnraidArrayInvalid }, proto.CodeNotAllowed},
		{func(u *proto.Unraid) { u.Array.State, u.Array.StateRaw = proto.UnraidArrayStopped, "NEW_ARRAY" }, proto.CodeNotAllowed},
		{func(u *proto.Unraid) { u.Array.StateRaw, u.Array.Disks[1].Status = "STOPPED", "missing" }, proto.CodeNotAllowed},
		{func(u *proto.Unraid) { u.Array.Disks[1].Status, u.Encrypted = "ok", true }, proto.CodeNotAllowed},
		{func(u *proto.Unraid) { u.Array.State = proto.UnraidArrayStopping }, CodeBusy},
	} {
		f.setReport(c.edit)
		if r := f.manage(proto.ManageRequest{Op: proto.OpArrayStart}); r.Code != c.code {
			t.Errorf("start with %+v: %+v", f.rep.Unraid.Array, r)
		}
	}
	f.setReport(func(u *proto.Unraid) { u.Array.State, u.KeyfilePresent = proto.UnraidArrayStopped, true })
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpArrayStart})); st.Status != "ok" {
		t.Errorf("encrypted with a keyfile: %+v", st)
	}
	// Mover and parity need a started array.
	f.setReport(func(u *proto.Unraid) { u.Array.State = proto.UnraidArrayStopped })
	for _, op := range []string{proto.OpMoverStart, proto.OpParityStart, proto.OpArrayStop} {
		if r := f.manage(proto.ManageRequest{Op: op}); r.Code != CodeBusy {
			t.Errorf("%s on a stopped array: %+v", op, r)
		}
	}
	// No emcmd (not this unRAID).
	f.m.bins["emcmd"] = filepath.Join(f.root, "nope")
	if r := f.manage(proto.ManageRequest{Op: proto.OpArrayStop}); r.Code != CodeUnsupported {
		t.Errorf("without emcmd: %+v", r)
	}
	// Not unRAID at all.
	f.m.isUnraid = func() bool { return false }
	if r := f.manage(proto.ManageRequest{Op: proto.OpMoverStart}); r.Code != CodeUnsupported {
		t.Errorf("not unRAID: %+v", r)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpGuestAutostart, Platform: proto.PlatformDocker, GuestID: "plex", On: ptrBool(true)}); r.Code != CodeUnsupported {
		t.Errorf("docker autostart elsewhere: %+v", r)
	}
	if calls := f.calls(); len(calls) != 1 {
		t.Errorf("calls: %q", calls)
	}
}

func ptrBool(b bool) *bool { return &b }

func TestUnraidDisksMoverPlugins(t *testing.T) {
	f := newUnraidFixture(t)
	f.setReport(func(u *proto.Unraid) { u.Array.State = proto.UnraidArrayStarted })
	for _, c := range []struct {
		op, disk, msg string
	}{
		{proto.OpDiskSpinUp, "all", "Spinning up every disk."},
		{proto.OpDiskSpinDown, "all", "Spinning down every disk."},
		{proto.OpDiskSpinDown, "disk1", "Spinning down disk1."},
		{proto.OpDiskSpinUp, "apps2", "Spinning up apps2."},
	} {
		if st := f.done(f.manage(proto.ManageRequest{Op: c.op, Disk: c.disk})); st.Status != "ok" || st.Message != c.msg {
			t.Errorf("%s %s: %+v", c.op, c.disk, st)
		}
	}
	for _, d := range []string{"disk9", "flash", "../x", "", "DISK1"} {
		if r := f.manage(proto.ManageRequest{Op: proto.OpDiskSpinUp, Disk: d}); r.Code != proto.CodeNotFound {
			t.Errorf("spin up %q: %+v", d, r)
		}
	}
	// The mover runs to its end.
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpMoverStart})); st.Status != "ok" || !strings.Contains(strings.Join(st.Log, "\n"), "mover: finished") {
		t.Errorf("mover: %+v", st)
	}
	f.setReport(func(u *proto.Unraid) { u.Array.MoverRunning = true })
	if r := f.manage(proto.ManageRequest{Op: proto.OpMoverStart}); r.Code != CodeBusy {
		t.Errorf("mover twice: %+v", r)
	}
	// Plugins.
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpPluginCheck})); st.Status != "ok" {
		t.Errorf("check: %+v", st)
	}
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpPluginUpdate, Plugin: "tailscale.plg"})); st.Status != "ok" || st.Message != "tailscale is up to date." {
		t.Errorf("update: %+v", st)
	}
	for plg, code := range map[string]string{"unRAIDServer.plg": proto.CodeNotAllowed, "nope.plg": proto.CodeNotFound,
		"unassigned.devices.plg": proto.CodeNotFound, "../../etc/passwd": proto.CodeInvalidValue, "x.sh": proto.CodeInvalidValue} {
		if r := f.manage(proto.ManageRequest{Op: proto.OpPluginUpdate, Plugin: plg}); r.Code != code {
			t.Errorf("update %s: %+v", plg, r)
		}
	}
	// All: the plugins the report says have an update; one failing fails
	// the task, the others still run.
	f.write("tmp/plugins/unassigned.devices.plg", "<PLUGIN version=\"2026.10.16\">")
	f.setReport(func(u *proto.Unraid) { u.Plugins[1].Update = "2026.10.16" })
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpPluginUpdate, Plugin: "all"})); st.Status != "error" || st.Message != "Could not update unassigned.devices." {
		t.Errorf("update all: %+v", st)
	}
	f.setReport(func(u *proto.Unraid) { u.Plugins[0].Update, u.Plugins[1].Update = "", "" })
	if r := f.manage(proto.ManageRequest{Op: proto.OpPluginUpdate, Plugin: "all"}); r.Code != proto.CodeNotFound {
		t.Errorf("nothing to update: %+v", r)
	}
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpContainersCheck})); st.Status != "ok" {
		t.Errorf("containers.check: %+v", st)
	}
	want := []string{"emcmd cmdSpinupAll=Apply", "emcmd cmdSpindownAll=Apply", "emcmd cmdSpindown=disk1", "emcmd cmdSpinup=apps2",
		"mover start", "plugin checkall", "plugin update tailscale.plg", "plugin update tailscale.plg", "plugin update unassigned.devices.plg",
		"dockerupdate check nonotify"}
	if got := f.calls(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("calls:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestUnraidNotifications(t *testing.T) {
	f := newUnraidFixture(t)
	if r := f.manage(proto.ManageRequest{Op: proto.OpNotificationArchive, Notification: "Docker___plex_06e0..c4b8_ticket"}); !r.OK || r.Task != nil {
		t.Fatalf("archive one: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(f.root, "tmp/notifications/unread/Docker___plex_06e0..c4b8_ticket.notify")); err == nil {
		t.Error("still unread")
	}
	for id, code := range map[string]string{"Docker___plex_06e0..c4b8_ticket": proto.CodeNotFound, "../x": proto.CodeInvalidValue} {
		if r := f.manage(proto.ManageRequest{Op: proto.OpNotificationArchive, Notification: id}); r.Code != code {
			t.Errorf("archive %q: %+v", id, r)
		}
	}
	f.write("tmp/notifications/unread/b.notify", "timestamp=1\n")
	if r := f.manage(proto.ManageRequest{Op: proto.OpNotificationArchive}); !r.OK {
		t.Fatalf("archive all: %+v", r)
	}
	if ents, _ := os.ReadDir(filepath.Join(f.root, "tmp/notifications/unread")); len(ents) != 0 {
		t.Errorf("left unread: %v", ents)
	}
	want := []string{"notify archive Docker___plex_06e0..c4b8_ticket.notify", "notify archive Unraid_Parity_check_1792210000.notify", "notify archive b.notify"}
	if got := f.calls(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("calls: %q", got)
	}
	// unRAID keeps its notifications elsewhere.
	f.write("boot/config/plugins/dynamix/dynamix.cfg", "[notify]\npath=\"/boot/notes\"\n")
	f.write("boot/notes/unread/x.notify", "timestamp=1\n")
	if r := f.manage(proto.ManageRequest{Op: proto.OpNotificationArchive, Notification: "x"}); !r.OK {
		t.Errorf("other path: %+v", r)
	}
}

func TestUnraidContainerUpdateAndAutostart(t *testing.T) {
	f := newUnraidFixture(t)
	resp := f.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "plex"})
	st := f.done(resp)
	if st.Status != "ok" || st.Message != "plex is up to date." || st.GuestID != "plex" || st.Type != "container.update" {
		t.Fatalf("update: %+v", st)
	}
	if log := strings.Join(st.Log, "\n"); !strings.Contains(log, "Pulling image") || strings.Contains(log, "<p") {
		t.Errorf("log: %q", st.Log)
	}
	if l := f.manage(proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformDocker, GuestID: "plex"}); len(l.Tasks) != 1 {
		t.Errorf("plex's tasks: %+v", l)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "immich_server"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("without template: %+v", r)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "nope"}); r.Code != CodeUnknownGuest {
		t.Errorf("unknown: %+v", r)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformLibvirt, GuestID: "pbs"}); r.Code != CodeUnsupported {
		t.Errorf("libvirt update: %+v", r)
	}
	// The container did not come back.
	f.m.containerState = func(context.Context, string) (string, error) { return "", fmt.Errorf("no such container") }
	if st := f.done(f.manage(proto.ManageRequest{Op: proto.OpContainerUpdate, Platform: proto.PlatformDocker, GuestID: "plex"})); st.Status != "error" ||
		!strings.Contains(st.Message, "gone") {
		t.Errorf("gone: %+v", st)
	}
	if got := f.calls(); strings.Join(got, "|") != "update_container plex|update_container plex" {
		t.Errorf("calls: %q", got)
	}

	// Autostart: dockerMan's list, sorted by name when one is added, the
	// others' waits kept.
	auto := func(id string, on bool) proto.ManageResponse {
		return f.manage(proto.ManageRequest{Op: proto.OpGuestAutostart, Platform: proto.PlatformDocker, GuestID: id, On: &on})
	}
	if r := auto("immich_server", true); !r.OK || r.Task != nil || len(r.Changes) != 1 || r.Changes[0].New != "true" {
		t.Fatalf("on: %+v", r)
	}
	if s := f.read("var/lib/docker/unraid-autostart"); s != "immich_server\nplex\nradarr 10\nsonarr\n" {
		t.Errorf("after on: %q", s)
	}
	if r := auto("plex", false); !r.OK {
		t.Fatalf("off: %+v", r)
	}
	if s := f.read("var/lib/docker/unraid-autostart"); s != "immich_server\nradarr 10\nsonarr\n" {
		t.Errorf("after off: %q", s)
	}
	if r := auto("radarr", true); !r.OK || f.read("var/lib/docker/unraid-autostart") != "immich_server\nradarr 10\nsonarr\n" {
		t.Errorf("already on: %+v %q", r, f.read("var/lib/docker/unraid-autostart"))
	}
	// The Docker page's own order (userprefs.cfg) wins over names.
	f.write("boot/config/plugins/dockerMan/userprefs.cfg", "0=\"sonarr\"\n1=\"radarr\"\n2=\"plex\"\n3=\"immich_server\"\n")
	if r := auto("plex", true); !r.OK {
		t.Fatal(r)
	}
	if s := f.read("var/lib/docker/unraid-autostart"); s != "sonarr\nradarr 10\nplex\nimmich_server\n" {
		t.Errorf("by userprefs: %q", s)
	}
	for _, id := range []string{"sonarr", "radarr", "plex", "immich_server"} {
		if r := auto(id, false); !r.OK {
			t.Errorf("off %s: %+v", id, r)
		}
	}
	if _, err := os.Stat(filepath.Join(f.root, "var/lib/docker/unraid-autostart")); err == nil {
		t.Error("an empty list should remove the file")
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpGuestAutostart, Platform: proto.PlatformDocker, GuestID: "plex"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("without on: %+v", r)
	}
	if r := f.manage(proto.ManageRequest{Op: proto.OpGuestAutostart, Platform: proto.PlatformIncus, GuestID: "web", On: ptrBool(true)}); r.Code != CodeUnsupported {
		t.Errorf("incus: %+v", r)
	}
}

func TestNatLessAndMask(t *testing.T) {
	if !natLess("disk2", "disk10") || natLess("disk10", "disk2") || !natLess("a", "b") || natLess("b", "a") {
		t.Error("natural order")
	}
	if got := maskSecrets(`curl https://user:hunter2@x.y/?token=abc csrf_token="0123" fine=1`); got != `curl https://user:**********@x.y/?token=********** csrf_token=********** fine=1` {
		t.Errorf("mask: %s", got)
	}
}
