package screen

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Whombat Helper's updates (docs/AGENT-PROTOCOL.md "Self-update"): the
// agent received the hub's signed zip and verified it; InstallHelper unpacks
// it beside the app, checks the bundle, swaps it in and restarts the helper
// in the desktop sessions, and puts the previous one back when the new one
// doesn't answer at the screen. Screen implements agent.HelperUpdater.

const (
	// HelperLabel is the helper's LaunchAgent.
	HelperLabel = "com.whombat.helper"
	// DefaultHelperPlist is the LaunchAgent's file (install.sh writes it).
	DefaultHelperPlist = "/Library/LaunchAgents/com.whombat.helper.plist"

	helperBundleID   = "com.whombat.helper"
	helperExecutable = "WhombatHelper"
	helperStage      = ".update" // the staging folder beside the app (install.sh uses .new)
	helperPrevSuffix = ".prev"   // the previous app until the new one answered
)

// HelperLaunchAgent is the LaunchAgent that starts the helper at app in
// every desktop session; install.sh writes the same file for the default
// app.
func HelperLaunchAgent(app string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + HelperLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + xmlEscape(filepath.Join(app, "Contents", "MacOS", helperExecutable)) + `</string>
	</array>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// helperSystem is what an install asks macOS to do; tests use a fake.
type helperSystem interface {
	// Unzip unpacks zip into dir (ditto -x -k).
	Unzip(ctx context.Context, zip, dir string) error
	// Verify checks the app's signature (codesign --verify --deep --strict).
	Verify(ctx context.Context, app string) error
	// TeamID is the Apple team of the app's signature ("" = signed ad hoc).
	TeamID(ctx context.Context, app string) (string, error)
	// Requirement is the app's designated requirement (codesign -d -r-),
	// what macOS remembers a privacy permission by.
	Requirement(ctx context.Context, app string) (string, error)
	// ResetAccessibility forgets the helper's Accessibility permission
	// (tccutil reset Accessibility com.whombat.helper).
	ResetAccessibility(ctx context.Context) error
	// DesktopUsers are the users with a desktop session (a loginwindow).
	DesktopUsers(ctx context.Context) ([]int, error)
	// Loaded: the LaunchAgent is loaded in uid's session.
	Loaded(ctx context.Context, uid int) bool
	// Kickstart restarts the loaded helper in uid's session.
	Kickstart(ctx context.Context, uid int) error
	// Bootstrap loads the LaunchAgent at plist in uid's session.
	Bootstrap(ctx context.Context, uid int, plist string) error
	// Bootout unloads it from uid's session.
	Bootout(ctx context.Context, uid int) error
}

// HelperVersion is the installed helper's version, read from its bundle
// now ("" when it isn't installed or doesn't say).
func (s *Screen) HelperVersion() string {
	b, err := readSmall(filepath.Join(s.helperApp, "Contents", "Info.plist"))
	if err != nil {
		return ""
	}
	return bundleVersion(b)
}

func helperFailed(format string, a ...any) proto.UpdateResponse {
	return proto.UpdateResponse{Code: agent.CodeInstallFailed, Message: fmt.Sprintf(format, a...)}
}

// InstallHelper installs the helper app in zip (verified by the agent) as
// version; team is the Apple team the hub's build names ("" = none).
func (s *Screen) InstallHelper(ctx context.Context, zip, version, team string) proto.UpdateResponse {
	s.installMu.Lock()
	defer s.installMu.Unlock()
	app := s.helperApp
	dir := filepath.Dir(app)
	if err := s.ensureOwnedDir(dir); err != nil {
		return helperFailed("can't prepare %s: %v", dir, err)
	}
	stage := filepath.Join(dir, helperStage)
	if err := os.RemoveAll(stage); err != nil {
		return helperFailed("can't clear %s: %v", stage, err)
	}
	if err := os.Mkdir(stage, 0o700); err != nil {
		return helperFailed("can't make %s: %v", stage, err)
	}
	defer os.RemoveAll(stage)
	if err := s.helperSys.Unzip(ctx, zip, stage); err != nil {
		return helperFailed("can't unpack the new Whombat Helper: %v", err)
	}
	newApp := filepath.Join(stage, filepath.Base(app))
	if err := checkHelperBundle(newApp, version); err != nil {
		return helperFailed("the new Whombat Helper isn't right: %v", err)
	}
	if err := s.helperSys.Verify(ctx, newApp); err != nil {
		return helperFailed("the new Whombat Helper's signature doesn't verify: %v", err)
	}
	newTeam, err := s.helperSys.TeamID(ctx, newApp)
	if err != nil {
		return helperFailed("can't read the new Whombat Helper's signature: %v", err)
	}
	hadOld := isRealDir(app)
	oldTeam, oldReq := "", ""
	if hadOld {
		oldTeam, _ = s.helperSys.TeamID(ctx, app)
		oldReq, _ = s.helperSys.Requirement(ctx, app)
	}
	newReq, _ := s.helperSys.Requirement(ctx, newApp)
	if newTeam != "" && newTeam != oldTeam && newTeam != team {
		return helperFailed("the new Whombat Helper is signed by team %s, which neither the installed helper nor the hub's build names", newTeam)
	}
	if err := s.ownTree(newApp); err != nil {
		return helperFailed("can't hand the new Whombat Helper to root: %v", err)
	}

	// The swap: the previous app stays as <app>.prev until the new one
	// answered at the screen.
	prev := app + helperPrevSuffix
	if err := os.RemoveAll(prev); err != nil {
		return helperFailed("can't clear %s: %v", prev, err)
	}
	if hadOld {
		if err := os.Rename(app, prev); err != nil {
			return helperFailed("can't keep the previous Whombat Helper: %v", err)
		}
	} else if err := os.RemoveAll(app); err != nil { // not an app: a stray file or link
		return helperFailed("can't clear %s: %v", app, err)
	}
	if err := os.Rename(newApp, app); err != nil {
		if hadOld {
			_ = os.Rename(prev, app)
		}
		return helperFailed("can't move the new Whombat Helper in place: %v", err)
	}
	syncDir(dir)
	s.forgetHelper()
	if accessibilityGoesStale(hadOld, oldTeam, newTeam, oldReq, newReq) {
		// macOS remembers Accessibility by the build it saw (an ad hoc build
		// by its code hash): the list would show the new build switched on
		// while it has no access, and no entry to switch on would appear.
		// Reset, the new build shows up switched off (tried).
		if err := s.helperSys.ResetAccessibility(ctx); err != nil {
			s.log.Warn("can't reset Whombat Helper's Accessibility permission", "err", err)
		} else {
			s.log.Warn("Whombat Helper is a new build to macOS: its Accessibility permission was reset", "version", version)
		}
	}
	wrote, err := s.ensureHelperPlist(app)
	if err != nil {
		s.putHelperBack(ctx, app, prev, hadOld, false)
		return helperFailed("can't write the helper's LaunchAgent: %v", err)
	}
	uid, atScreen := s.consoleUID()
	s.restartHelpers(ctx, uid, atScreen)
	if !atScreen {
		// No session at the screen to try it in: it starts at the next login.
		os.RemoveAll(prev)
		s.log.Warn("Whombat Helper updated; nobody is at the screen to start it", "version", version, "team", newTeam)
		return proto.UpdateResponse{OK: true, Message: fmt.Sprintf("Whombat Helper %s is installed; it starts when someone logs in to the Mac.", version)}
	}
	if a := s.awaitHelper(ctx, uid, version); a != nil {
		os.RemoveAll(prev)
		s.log.Warn("Whombat Helper updated", "version", version, "team", newTeam, "accessibility", a.AX)
		msg := fmt.Sprintf("Whombat Helper %s is running.", version)
		if !a.AX {
			// An ad hoc build or another signer is a new app to macOS: its
			// Accessibility permission has to be given again.
			msg = fmt.Sprintf("Whombat Helper %s is running without Accessibility: switch it on in Privacy & Security → Accessibility.", version)
		}
		return proto.UpdateResponse{OK: true, Message: msg}
	}
	s.log.Error("the new Whombat Helper didn't answer at the screen; putting the previous one back", "version", version, "uid", uid)
	s.putHelperBack(ctx, app, prev, hadOld, wrote)
	back := "the previous one is back"
	if !hadOld {
		back = "it was removed again"
	}
	return proto.UpdateResponse{Code: agent.CodeNoAnswer,
		Message: fmt.Sprintf("the new Whombat Helper %s didn't answer within %s; %s", version, s.answerWithin, back)}
}

// accessibilityGoesStale says whether macOS's Accessibility permission for
// the installed helper won't carry over to the new build: there was one, the
// new build's designated requirement differs (or can't be read), and it is
// signed ad hoc or by another team. A Developer ID build of the same team
// keeps the requirement, and the permission.
func accessibilityGoesStale(hadOld bool, oldTeam, newTeam, oldReq, newReq string) bool {
	if !hadOld {
		return false
	}
	if oldReq != "" && oldReq == newReq {
		return false
	}
	return newTeam == "" || newTeam != oldTeam
}

// putHelperBack removes the new app and restores the previous one (and
// takes out the LaunchAgent it wrote when there was none before).
func (s *Screen) putHelperBack(ctx context.Context, app, prev string, hadOld, wrotePlist bool) {
	if err := os.RemoveAll(app); err != nil {
		s.log.Error("can't remove the new Whombat Helper", "err", err)
	}
	if hadOld {
		if err := os.Rename(prev, app); err != nil {
			s.log.Error("can't put the previous Whombat Helper back", "err", err)
		}
	}
	s.forgetHelper()
	if wrotePlist && !hadOld {
		users, _ := s.helperSys.DesktopUsers(ctx)
		for _, u := range users {
			_ = s.helperSys.Bootout(ctx, u)
		}
		os.Remove(s.helperPlist)
		return
	}
	uid, atScreen := s.consoleUID()
	s.restartHelpers(ctx, uid, atScreen)
}

// restartHelpers restarts the helper in every desktop session (bootstraps
// it where it isn't loaded), the one at the screen included.
func (s *Screen) restartHelpers(ctx context.Context, consoleUID int, atScreen bool) {
	users, err := s.helperSys.DesktopUsers(ctx)
	if err != nil {
		s.log.Warn("can't list the desktop sessions", "err", err)
	}
	if atScreen && !containsInt(users, consoleUID) {
		users = append(users, consoleUID)
	}
	for _, u := range users {
		if s.helperSys.Loaded(ctx, u) {
			if err := s.helperSys.Kickstart(ctx, u); err != nil {
				s.log.Warn("can't restart Whombat Helper", "uid", u, "err", err)
			}
			continue
		}
		var err error
		for i := 0; i < 3; i++ {
			if err = s.helperSys.Bootstrap(ctx, u, s.helperPlist); err == nil {
				break
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.retryGap):
			}
		}
		if err != nil {
			s.log.Warn("can't start Whombat Helper", "uid", u, "err", err)
		}
	}
}

// awaitHelper asks uid's helper for its status until it answers with
// version (nil when it doesn't within answerWithin). The answer becomes the
// report's helper part.
func (s *Screen) awaitHelper(ctx context.Context, uid int, version string) *helperAnswer {
	deadline := time.Now().Add(s.answerWithin)
	for {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		a, err := s.helper.call(cctx, uid, map[string]any{"op": "status"})
		cancel()
		if err == nil && a.OK && a.Version == version {
			s.noteHelper(a)
			return a
		}
		if !time.Now().Add(s.answerPoll).Before(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(s.answerPoll):
		}
	}
}

// forgetHelper drops what the report knew of the helper, so the next one
// reads the bundle again.
func (s *Screen) forgetHelper() {
	s.mu.Lock()
	s.bundleAt, s.bundleVer = time.Time{}, ""
	s.helperAt = time.Time{}
	s.mu.Unlock()
}

// checkHelperBundle: an app bundle (not a link) with the helper's
// executable, whose Info.plist names com.whombat.helper and version.
func checkHelperBundle(app, version string) error {
	if !isRealDir(app) {
		return errors.New("the zip holds no Whombat Helper.app")
	}
	fi, err := os.Lstat(filepath.Join(app, "Contents", "MacOS", helperExecutable))
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o111 == 0 {
		return errors.New("the app has no executable " + helperExecutable)
	}
	b, err := readSmall(filepath.Join(app, "Contents", "Info.plist"))
	if err != nil {
		return fmt.Errorf("its Info.plist: %w", err)
	}
	v, err := parsePlist(strings.NewReader(string(b)))
	if err != nil {
		return fmt.Errorf("its Info.plist: %w", err)
	}
	m, _ := v.(map[string]any)
	id, _ := m["CFBundleIdentifier"].(string)
	got, _ := m["CFBundleShortVersionString"].(string)
	exe, hasExe := m["CFBundleExecutable"].(string)
	switch {
	case strings.TrimSpace(id) != helperBundleID:
		return fmt.Errorf("its bundle id is %q, not %s", id, helperBundleID)
	case strings.TrimSpace(got) != version:
		return fmt.Errorf("it is version %q, not %s", got, version)
	case hasExe && exe != helperExecutable:
		return fmt.Errorf("its executable is %q, not %s", exe, helperExecutable)
	}
	return nil
}

// readSmall reads a regular file of at most 1 MiB (not through a link).
func readSmall(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 1<<20 {
		return nil, errors.New("not a small regular file")
	}
	return os.ReadFile(path)
}

func isRealDir(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.IsDir()
}

// ensureOwnedDir makes dir (root's, 0755) when it is missing; one that is
// there must be a folder, not a link, and is given back to root and made
// writable by root only (it holds the helper the agent trusts and the
// agent's own executable).
func (s *Screen) ensureOwnedDir(dir string) error {
	fi, err := os.Lstat(dir)
	switch {
	case err == nil && !fi.IsDir():
		return errors.New("it isn't a folder")
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return err
	case err != nil:
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.Lchown(dir, s.ownerUID, s.ownerGID); err != nil {
		return err
	}
	return os.Chmod(dir, 0o755)
}

// ownTree gives the app to root (wheel) and makes it readable by everyone
// and writable by root only: chmod -R u+rwX,go+rX,go-w, as install.sh does.
// The helper runs as the person and must be able to read its app.
func (s *Screen) ownTree(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := os.Lchown(path, s.ownerUID, s.ownerGID); err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		mode := fi.Mode().Perm() | 0o644
		if fi.IsDir() || mode&0o111 != 0 {
			mode |= 0o111
		}
		mode &^= 0o022
		return os.Chmod(path, mode)
	})
}

// ensureHelperPlist writes the LaunchAgent when it is missing (a Mac whose
// agent was installed before the hub had the helper); wrote says it did.
func (s *Screen) ensureHelperPlist(app string) (wrote bool, err error) {
	if _, err := os.Lstat(s.helperPlist); err == nil {
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(s.helperPlist), 0o755); err != nil {
		return false, err
	}
	tmp := s.helperPlist + ".tmp"
	if err := os.WriteFile(tmp, []byte(HelperLaunchAgent(app)), 0o644); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if err := os.Lchown(tmp, s.ownerUID, s.ownerGID); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, s.helperPlist); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return true, nil
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

func containsInt(l []int, v int) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}

// ---- macOS's tools ----

// macHelperSystem runs macOS's own tools (a Mac only).
type macHelperSystem struct{}

func runTool(ctx context.Context, limit time.Duration, name string, args ...string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", errors.New("not a Mac")
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	cmd.Dir = "/"
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s: %v: %s", filepath.Base(name), err, firstLine(string(out)))
	}
	return string(out), nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return clip(line, 200)
}

func guiTarget(uid int) string { return "gui/" + strconv.Itoa(uid) }

func (macHelperSystem) Unzip(ctx context.Context, zip, dir string) error {
	_, err := runTool(ctx, 2*time.Minute, "/usr/bin/ditto", "-x", "-k", zip, dir)
	return err
}

func (macHelperSystem) Verify(ctx context.Context, app string) error {
	_, err := runTool(ctx, 2*time.Minute, "/usr/bin/codesign", "--verify", "--deep", "--strict", app)
	return err
}

func (macHelperSystem) TeamID(ctx context.Context, app string) (string, error) {
	out, err := runTool(ctx, time.Minute, "/usr/bin/codesign", "-d", "--verbose=2", app)
	if err != nil {
		return "", err
	}
	return parseTeamID(out)
}

func (macHelperSystem) Requirement(ctx context.Context, app string) (string, error) {
	out, err := runTool(ctx, time.Minute, "/usr/bin/codesign", "-d", "-r-", app)
	if err != nil {
		return "", err
	}
	return parseRequirement(out)
}

func (macHelperSystem) ResetAccessibility(ctx context.Context) error {
	_, err := runTool(ctx, 30*time.Second, "/usr/bin/tccutil", "reset", "Accessibility", helperBundleID)
	return err
}

func (macHelperSystem) DesktopUsers(ctx context.Context) ([]int, error) {
	out, err := runTool(ctx, 15*time.Second, "/bin/ps", "-axo", "uid=,comm=")
	if err != nil {
		return nil, err
	}
	return parseDesktopUsers(out), nil
}

func (macHelperSystem) Loaded(ctx context.Context, uid int) bool {
	_, err := runTool(ctx, 15*time.Second, "/bin/launchctl", "print", guiTarget(uid)+"/"+HelperLabel)
	return err == nil
}

func (macHelperSystem) Kickstart(ctx context.Context, uid int) error {
	_, err := runTool(ctx, 30*time.Second, "/bin/launchctl", "kickstart", "-k", guiTarget(uid)+"/"+HelperLabel)
	return err
}

func (macHelperSystem) Bootstrap(ctx context.Context, uid int, plist string) error {
	_, err := runTool(ctx, 30*time.Second, "/bin/launchctl", "bootstrap", guiTarget(uid), plist)
	return err
}

func (macHelperSystem) Bootout(ctx context.Context, uid int) error {
	_, err := runTool(ctx, 30*time.Second, "/bin/launchctl", "bootout", guiTarget(uid)+"/"+HelperLabel)
	return err
}

var teamValueRe = regexp.MustCompile(`^[A-Z0-9]{10}$`)

// parseTeamID reads `codesign -d --verbose=2`'s TeamIdentifier ("" for an
// ad hoc signature, whose team is "not set").
func parseTeamID(out string) (string, error) {
	adhoc, team, found := false, "", false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "Signature=adhoc":
			adhoc = true
		case strings.HasPrefix(line, "TeamIdentifier="):
			team, found = strings.TrimPrefix(line, "TeamIdentifier="), true
		}
	}
	switch {
	case adhoc || team == "not set":
		return "", nil
	case !found:
		return "", errors.New("codesign names no team")
	case !teamValueRe.MatchString(team):
		return "", fmt.Errorf("codesign names the team %q", team)
	}
	return team, nil
}

// parseRequirement reads `codesign -d -r-`'s designated requirement (an ad
// hoc signature's is implicit and printed as a comment: "# designated =>").
func parseRequirement(out string) (string, error) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
		if r, ok := strings.CutPrefix(line, "designated => "); ok && strings.TrimSpace(r) != "" {
			return strings.TrimSpace(r), nil
		}
	}
	return "", errors.New("codesign names no designated requirement")
}

// parseDesktopUsers reads `ps -axo uid=,comm=`: the users other than root
// with a loginwindow (a desktop session), each once, in order.
func parseDesktopUsers(out string) []int {
	var users []int
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || filepath.Base(strings.Join(f[1:], " ")) != "loginwindow" {
			continue
		}
		uid, err := strconv.Atoi(f[0])
		if err != nil || uid == 0 || containsInt(users, uid) {
			continue
		}
		users = append(users, uid)
	}
	return users
}
