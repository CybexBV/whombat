package screen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent"
)

// fakeZip is what the tests' "zip" holds: the app the fake ditto unpacks.
type fakeZip struct {
	BundleID string `json:"bundle_id"`
	Version  string `json:"version"`
	NoExe    bool   `json:"no_exe"`
}

func writeFakeApp(t *testing.T, app string, z fakeZip) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(app, "Contents", "MacOS"), 0o700); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
	<key>CFBundleExecutable</key><string>WhombatHelper</string>
	<key>CFBundleIdentifier</key><string>` + z.BundleID + `</string>
	<key>CFBundleShortVersionString</key><string>` + z.Version + `</string>
	<key>LSUIElement</key><true/>
</dict></plist>`
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o600); err != nil {
		t.Fatal(err)
	}
	if !z.NoExe {
		if err := os.WriteFile(filepath.Join(app, "Contents", "MacOS", helperExecutable), []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

// fakeHelperSys is macOS's tools for an install: ditto unpacks a fakeZip,
// codesign answers the teams set here, launchctl starts the app at the
// helper's path, which then answers on its socket with its bundle's
// version (or not at all when that version is broken).
type fakeHelperSys struct {
	t                 *testing.T
	mu                sync.Mutex
	s                 *Screen
	newTeam, oldTeam  string
	verifyErr         error
	users             []int
	loaded            map[int]bool
	broken            string // a version that never answers
	running           string // what the helper at the screen answers with
	ax                bool
	calls             []string
	unzipErr, teamErr error
	sameHash          bool  // ad hoc builds come out with one code hash
	reqErr            error // codesign can't say the requirement
}

func (f *fakeHelperSys) record(c string) {
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
}

func (f *fakeHelperSys) callList() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.calls, " ")
}

func (f *fakeHelperSys) Unzip(ctx context.Context, zip, dir string) error {
	f.record("unzip")
	if f.unzipErr != nil {
		return f.unzipErr
	}
	b, err := os.ReadFile(zip)
	if err != nil {
		return err
	}
	var z fakeZip
	if err := json.Unmarshal(b, &z); err != nil {
		return errors.New("not a zip")
	}
	writeFakeApp(f.t, filepath.Join(dir, "Whombat Helper.app"), z)
	return nil
}

func (f *fakeHelperSys) Verify(ctx context.Context, app string) error {
	f.record("verify")
	return f.verifyErr
}

func (f *fakeHelperSys) TeamID(ctx context.Context, app string) (string, error) {
	if f.teamErr != nil {
		return "", f.teamErr
	}
	if strings.Contains(app, string(filepath.Separator)+helperStage+string(filepath.Separator)) {
		return f.newTeam, nil
	}
	return f.oldTeam, nil
}

// Requirement is a Developer ID build's (the same for every version of a
// team) or an ad hoc build's (its code hash: the version's, unless sameHash).
func (f *fakeHelperSys) Requirement(ctx context.Context, app string) (string, error) {
	if f.reqErr != nil {
		return "", f.reqErr
	}
	team, _ := f.TeamID(ctx, app)
	if team != "" {
		return `identifier "com.whombat.helper" and anchor apple generic and certificate leaf[subject.OU] = ` + team, nil
	}
	b, _ := os.ReadFile(filepath.Join(app, "Contents", "Info.plist"))
	hash := bundleVersion(b)
	if f.sameHash {
		hash = "same"
	}
	return `cdhash H"` + hash + `"`, nil
}

func (f *fakeHelperSys) ResetAccessibility(ctx context.Context) error {
	f.record("tcc-reset")
	return nil
}

func (f *fakeHelperSys) DesktopUsers(ctx context.Context) ([]int, error) { return f.users, nil }

func (f *fakeHelperSys) Loaded(ctx context.Context, uid int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loaded[uid]
}

// start runs the app now at the helper's path.
func (f *fakeHelperSys) start() {
	v := f.s.HelperVersion()
	f.mu.Lock()
	defer f.mu.Unlock()
	if v == f.broken {
		v = ""
	}
	f.running = v
}

func (f *fakeHelperSys) Kickstart(ctx context.Context, uid int) error {
	f.record(fmt.Sprintf("kickstart:%d", uid))
	f.start()
	return nil
}

func (f *fakeHelperSys) Bootstrap(ctx context.Context, uid int, plist string) error {
	f.record(fmt.Sprintf("bootstrap:%d", uid))
	if _, err := os.Stat(plist); err != nil {
		return err
	}
	f.mu.Lock()
	f.loaded[uid] = true
	f.mu.Unlock()
	f.start()
	return nil
}

func (f *fakeHelperSys) Bootout(ctx context.Context, uid int) error {
	f.record(fmt.Sprintf("bootout:%d", uid))
	f.mu.Lock()
	delete(f.loaded, uid)
	f.running = ""
	f.mu.Unlock()
	return nil
}

type installFixture struct {
	s   *Screen
	sys *fakeHelperSys
	dir string
	uid int
}

func newInstallFixture(t *testing.T) *installFixture {
	t.Helper()
	s := newTestScreen(t, "127.0.0.1:1")
	uid := os.Getuid()
	f := &installFixture{s: s, uid: uid, dir: t.TempDir()}
	root := filepath.Dir(s.helperApp) // beside the helpers' sockets
	s.helperApp = filepath.Join(root, "Application Support", "Whombat", "Whombat Helper.app")
	s.helperPlist = filepath.Join(root, "LaunchAgents", HelperLabel+".plist")
	s.ownerUID, s.ownerGID = os.Getuid(), os.Getgid()
	s.answerWithin, s.answerPoll, s.retryGap = 300*time.Millisecond, 10*time.Millisecond, time.Millisecond
	f.sys = &fakeHelperSys{t: t, s: s, loaded: map[int]bool{}, users: []int{uid}, ax: true}
	s.helperSys = f.sys
	newFakeHelper(t, s.uiRoot, uid, func(req map[string]any) map[string]any {
		f.sys.mu.Lock()
		defer f.sys.mu.Unlock()
		if f.sys.running == "" {
			return map[string]any{"ok": false, "code": "failed"}
		}
		return map[string]any{"ok": true, "version": f.sys.running, "ax": f.sys.ax, "user": "alex"}
	})
	return f
}

// installed puts version's app in place with its LaunchAgent, loaded and
// running in the session at the screen.
func (f *installFixture) installed(t *testing.T, version, team string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(f.s.helperApp), 0o755)
	writeFakeApp(t, f.s.helperApp, fakeZip{BundleID: helperBundleID, Version: version})
	os.MkdirAll(filepath.Dir(f.s.helperPlist), 0o755)
	os.WriteFile(f.s.helperPlist, []byte(HelperLaunchAgent(f.s.helperApp)), 0o644)
	f.sys.oldTeam = team
	f.sys.loaded[f.uid] = true
	f.sys.running = version
}

func (f *installFixture) zip(t *testing.T, z fakeZip) string {
	t.Helper()
	if z.BundleID == "" {
		z.BundleID = helperBundleID
	}
	b, _ := json.Marshal(z)
	p := filepath.Join(f.dir, fmt.Sprintf("helper-%d.zip", time.Now().UnixNano()))
	os.WriteFile(p, b, 0o600)
	return p
}

func noLeftovers(t *testing.T, s *Screen) {
	t.Helper()
	for _, p := range []string{s.helperApp + helperPrevSuffix, filepath.Join(filepath.Dir(s.helperApp), helperStage)} {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s is left", p)
		}
	}
}

func TestInstallHelperUpdates(t *testing.T) {
	f := newInstallFixture(t)
	f.installed(t, "1.0.0", "AB12CD34EF")
	f.sys.newTeam = "AB12CD34EF"
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if !r.OK || !strings.Contains(r.Message, "1.1.0 is running") {
		t.Fatalf("%+v", r)
	}
	if v := f.s.HelperVersion(); v != "1.1.0" {
		t.Fatalf("installed %q", v)
	}
	noLeftovers(t, f.s)
	if c := f.sys.callList(); c != fmt.Sprintf("unzip verify kickstart:%d", f.uid) {
		t.Fatalf("calls %q", c)
	}
	// Readable by the person whose session runs it, writable by root only.
	for p, want := range map[string]os.FileMode{
		f.s.helperApp: 0o755,
		filepath.Join(f.s.helperApp, "Contents", "MacOS", helperExecutable): 0o755,
		filepath.Join(f.s.helperApp, "Contents", "Info.plist"):              0o644,
	} {
		if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != want {
			t.Errorf("%s: %v %v, want %v", p, fi.Mode().Perm(), err, want)
		}
	}
	// The report has the new helper at once.
	_, h := f.s.snapshot()
	if !h.Installed || !h.Running || h.Version != "1.1.0" || h.Accessibility == nil || !*h.Accessibility {
		t.Fatalf("report %+v", h)
	}
	// The same or an older one again: the agent refuses it before this; a
	// wrong bundle never replaces the app.
	for _, c := range []struct {
		name string
		z    fakeZip
		want string
	}{
		{"other bundle", fakeZip{BundleID: "com.example.other", Version: "1.2.0"}, "bundle id"},
		{"other version", fakeZip{Version: "1.3.0"}, "version"},
		{"no executable", fakeZip{Version: "1.2.0", NoExe: true}, "executable"},
	} {
		r := f.s.InstallHelper(context.Background(), f.zip(t, c.z), "1.2.0", "")
		if r.OK || r.Code != agent.CodeInstallFailed || !strings.Contains(r.Message, c.want) {
			t.Errorf("%s: %+v", c.name, r)
		}
		if v := f.s.HelperVersion(); v != "1.1.0" {
			t.Fatalf("%s: installed %q", c.name, v)
		}
		noLeftovers(t, f.s)
	}
	f.sys.verifyErr = errors.New("a sealed resource is missing or invalid")
	if r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.2.0"}), "1.2.0", ""); r.OK || !strings.Contains(r.Message, "signature") {
		t.Fatalf("bad signature: %+v", r)
	}
	if v := f.s.HelperVersion(); v != "1.1.0" {
		t.Fatalf("installed %q", v)
	}
}

func TestInstallHelperTeams(t *testing.T) {
	// reset: macOS's Accessibility permission for the old build is forgotten,
	// so the new build shows up switched off instead of a stale entry that
	// says on.
	cases := []struct {
		name               string
		oldTeam, newTeam   string
		named              string
		ok                 bool
		withoutAccessibity bool
		reset              bool
		sameHash           bool
		reqErr             error
	}{
		{"same team", "AB12CD34EF", "AB12CD34EF", "", true, false, false, false, nil},
		{"the build names the new team", "AB12CD34EF", "ZZ99YY88XX", "ZZ99YY88XX", true, false, true, false, nil},
		{"first Developer ID helper, named", "", "AB12CD34EF", "AB12CD34EF", true, false, true, false, nil},
		{"another team", "AB12CD34EF", "ZZ99YY88XX", "AB12CD34EF", false, false, false, false, nil},
		{"a team nobody names", "", "ZZ99YY88XX", "", false, false, false, false, nil},
		{"ad hoc after Developer ID", "AB12CD34EF", "", "AB12CD34EF", true, true, true, false, nil},
		{"ad hoc after ad hoc", "", "", "", true, true, true, false, nil},
		{"the same ad hoc build", "", "", "", true, false, false, true, nil},
		{"ad hoc, requirement unreadable", "", "", "", true, true, true, false, errors.New("codesign: no")},
		{"same team, requirement unreadable", "AB12CD34EF", "AB12CD34EF", "", true, false, false, false, errors.New("codesign: no")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newInstallFixture(t)
			f.installed(t, "1.0.0", c.oldTeam)
			f.sys.newTeam = c.newTeam
			f.sys.sameHash, f.sys.reqErr = c.sameHash, c.reqErr
			f.sys.ax = !c.withoutAccessibity
			r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", c.named)
			if r.OK != c.ok {
				t.Fatalf("%+v", r)
			}
			want := "1.1.0"
			if !c.ok {
				want = "1.0.0"
				if !strings.Contains(r.Message, "team "+c.newTeam) {
					t.Fatalf("refusal %q", r.Message)
				}
			}
			if v := f.s.HelperVersion(); v != want {
				t.Fatalf("installed %q", v)
			}
			if c.withoutAccessibity != strings.Contains(r.Message, "without Accessibility") {
				t.Fatalf("message %q", r.Message)
			}
			if calls := f.sys.callList(); c.reset != strings.Contains(calls, "tcc-reset") {
				t.Fatalf("reset %v, calls %q", c.reset, calls)
			} else if c.reset && strings.Index(calls, "tcc-reset") > strings.Index(calls, "kickstart") {
				t.Fatalf("reset after the restart: %q", calls)
			}
			noLeftovers(t, f.s)
		})
	}
}

func TestParseRequirement(t *testing.T) {
	// codesign -d -r- on John's Mac (macOS 27.2.1): an ad hoc universal build,
	// and a Developer ID app (its team replaced).
	adhoc := "# designated => cdhash H\"614a2536a123c3b02b8970418b168efb276fd25c\" or cdhash H\"de4583f4fa7d8a14d78b183b4199eb04cdc7de1e\"\n"
	if r, err := parseRequirement("Executable=/x/Whombat Helper.app/Contents/MacOS/WhombatHelper\n" + adhoc); err != nil ||
		r != `cdhash H"614a2536a123c3b02b8970418b168efb276fd25c" or cdhash H"de4583f4fa7d8a14d78b183b4199eb04cdc7de1e"` {
		t.Fatalf("ad hoc: %q %v", r, err)
	}
	devID := `Executable=/Applications/Example.app/Contents/MacOS/Example
designated => anchor apple generic and identifier "com.example.app" and (certificate leaf[field.1.2.840.113635.100.6.1.9] /* exists */ or certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "AB12CD34EF")
`
	if r, err := parseRequirement(devID); err != nil || !strings.HasPrefix(r, "anchor apple generic") || !strings.HasSuffix(r, `"AB12CD34EF")`) {
		t.Fatalf("Developer ID: %q %v", r, err)
	}
	if _, err := parseRequirement("Executable=/x\n"); err == nil {
		t.Fatal("no requirement accepted")
	}
}

func TestInstallHelperPutsBack(t *testing.T) {
	f := newInstallFixture(t)
	f.installed(t, "1.0.0", "")
	f.sys.broken = "1.1.0"
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if r.OK || r.Code != agent.CodeNoAnswer || !strings.Contains(r.Message, "previous one is back") {
		t.Fatalf("%+v", r)
	}
	if v := f.s.HelperVersion(); v != "1.0.0" {
		t.Fatalf("installed %q", v)
	}
	noLeftovers(t, f.s)
	// Restarted twice: the new one, then the previous one again (an ad hoc
	// build after an ad hoc one: Accessibility was reset for it first, so
	// the previous one comes back without it too).
	if c := f.sys.callList(); c != fmt.Sprintf("unzip verify tcc-reset kickstart:%d kickstart:%d", f.uid, f.uid) {
		t.Fatalf("calls %q", c)
	}
	f.sys.mu.Lock()
	running := f.sys.running
	f.sys.mu.Unlock()
	if running != "1.0.0" {
		t.Fatalf("running %q", running)
	}
}

// A Mac whose agent came before the hub had the helper: no app, no
// LaunchAgent.
func TestInstallHelperFirstTime(t *testing.T) {
	f := newInstallFixture(t)
	os.RemoveAll(filepath.Dir(f.s.helperApp)) // not even the Whombat folder
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if !r.OK {
		t.Fatalf("%+v", r)
	}
	b, err := os.ReadFile(f.s.helperPlist)
	if err != nil || string(b) != HelperLaunchAgent(f.s.helperApp) {
		t.Fatalf("LaunchAgent %q %v", b, err)
	}
	if fi, _ := os.Stat(f.s.helperPlist); fi.Mode().Perm() != 0o644 {
		t.Fatalf("LaunchAgent mode %v", fi.Mode().Perm())
	}
	if fi, _ := os.Stat(filepath.Dir(f.s.helperApp)); fi.Mode().Perm() != 0o755 {
		t.Fatalf("folder mode %v", fi.Mode().Perm())
	}
	if c := f.sys.callList(); c != fmt.Sprintf("unzip verify bootstrap:%d", f.uid) {
		t.Fatalf("calls %q", c)
	}
	noLeftovers(t, f.s)

	// The same Mac when that helper never answers: nothing of it stays.
	g := newInstallFixture(t)
	g.sys.broken = "1.1.0"
	r = g.s.InstallHelper(context.Background(), g.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if r.Code != agent.CodeNoAnswer || !strings.Contains(r.Message, "removed again") {
		t.Fatalf("%+v", r)
	}
	for _, p := range []string{g.s.helperApp, g.s.helperPlist} {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s is left", p)
		}
	}
	if c := g.sys.callList(); !strings.HasSuffix(c, fmt.Sprintf("bootout:%d", g.uid)) {
		t.Fatalf("calls %q", c)
	}
}

func TestInstallHelperNobodyAtTheScreen(t *testing.T) {
	f := newInstallFixture(t)
	f.installed(t, "1.0.0", "")
	f.s.consoleUID = func() (int, bool) { return 0, false }
	f.sys.users = nil
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if !r.OK || !strings.Contains(r.Message, "logs in") {
		t.Fatalf("%+v", r)
	}
	if v := f.s.HelperVersion(); v != "1.1.0" {
		t.Fatalf("installed %q", v)
	}
	noLeftovers(t, f.s)
	if c := f.sys.callList(); c != "unzip verify tcc-reset" {
		t.Fatalf("calls %q", c)
	}
	_, h := f.s.snapshot()
	if !h.Installed || h.Running || h.Version != "1.1.0" {
		t.Fatalf("report %+v", h)
	}
}

// Every desktop session gets the new helper; only the one at the screen is
// waited for.
func TestInstallHelperOtherSessions(t *testing.T) {
	f := newInstallFixture(t)
	f.installed(t, "1.0.0", "")
	other := f.uid + 1000
	f.sys.users = []int{other, f.uid}
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if !r.OK {
		t.Fatalf("%+v", r)
	}
	if c := f.sys.callList(); c != fmt.Sprintf("unzip verify tcc-reset bootstrap:%d kickstart:%d", other, f.uid) {
		t.Fatalf("calls %q", c)
	}
}

func TestInstallHelperLeavesALinkAlone(t *testing.T) {
	f := newInstallFixture(t)
	// The helper's folder is a link: refused, nothing written through it.
	target := t.TempDir()
	dir := filepath.Dir(f.s.helperApp)
	os.MkdirAll(filepath.Dir(dir), 0o755)
	os.RemoveAll(dir)
	if err := os.Symlink(target, dir); err != nil {
		t.Fatal(err)
	}
	r := f.s.InstallHelper(context.Background(), f.zip(t, fakeZip{Version: "1.1.0"}), "1.1.0", "")
	if r.OK || !strings.Contains(r.Message, "isn't a folder") {
		t.Fatalf("%+v", r)
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("wrote through the link: %v", entries)
	}
}

func TestParseTeamID(t *testing.T) {
	developerID := `Executable=/Library/Application Support/Whombat/Whombat Helper.app/Contents/MacOS/WhombatHelper
Identifier=com.whombat.helper
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Example BV (AB12CD34EF)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=17 Nov 2026 at 10:00:00
Info.plist entries=14
TeamIdentifier=AB12CD34EF
Runtime Version=26.0.0
Sealed Resources version=2 rules=13 files=0
Internal requirements count=1 size=180
`
	adhoc := `Executable=/tmp/hu/Whombat Helper.app/Contents/MacOS/WhombatHelper
Identifier=com.whombat.helper
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1234 flags=0x10002(adhoc,runtime) hashes=27+7 location=embedded
Signature=adhoc
Info.plist entries=14
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=0
`
	if team, err := parseTeamID(developerID); err != nil || team != "AB12CD34EF" {
		t.Fatalf("Developer ID: %q %v", team, err)
	}
	if team, err := parseTeamID(adhoc); err != nil || team != "" {
		t.Fatalf("ad hoc: %q %v", team, err)
	}
	if _, err := parseTeamID("Identifier=com.whombat.helper\n"); err == nil {
		t.Fatal("no team accepted")
	}
	if _, err := parseTeamID("TeamIdentifier=../x\n"); err == nil {
		t.Fatal("an odd team accepted")
	}
}

func TestParseDesktopUsers(t *testing.T) {
	ps := `    0 /sbin/launchd
    0 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow
  501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow
  501 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock
  502 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow
  501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow
  503 /Applications/Not loginwindow
`
	if got := parseDesktopUsers(ps); fmt.Sprint(got) != "[501 502]" {
		t.Fatalf("%v", got)
	}
}
