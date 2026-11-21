package hub

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"strings"
	"testing"

	agentpkg "rackoon/packaging/agent"
)

// macSandbox is the installer sandbox as a Mac: uname says Darwin, the
// macOS tools (sw_vers, launchctl, ditto, stat, ps, shasum) are fakes that
// record what install.sh asks of them, and /Library lives in the sandbox.
func macSandbox(t *testing.T, helper bool) *installSandbox {
	return macSandboxTeam(t, helper, "")
}

// macSandboxTeam is macSandbox whose hub names the helper's signing team.
func macSandboxTeam(t *testing.T, helper bool, team string) *installSandbox {
	t.Helper()
	sb := newInstallSandbox(t, "launchd")
	sb.write("/mock/uname", "#!/bin/sh\nif [ \"$1\" = -m ]; then echo \"${FAKE_ARCH:-arm64}\"; else echo Darwin; fi\n", 0o755)
	sb.write("/mock/sw_vers", "#!/bin/sh\necho \"${FAKE_MACOS:-27.2.1}\"\n", 0o755)
	sb.write("/mock/sysctl", "#!/bin/sh\necho \"${FAKE_ARM64:-1}\"\n", 0o755)
	sb.write("/mock/shasum", "#!/bin/sh\n[ \"$1 $2\" = '-a 256' ] || exit 9\nshift 2\nexec sha256sum \"$@\"\n", 0o755)
	sb.write("/mock/chown", "#!/bin/sh\nexit 0\n", 0o755)
	sb.write("/mock/stat", "#!/bin/sh\n[ \"$*\" = '-f %u /dev/console' ] || exit 9\necho \"${FAKE_CONSOLE_UID:-501}\"\n", 0o755)
	sb.write("/mock/ps", "#!/bin/sh\necho '  501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'\necho '    0 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'\n", 0o755)
	// Folders every Mac has.
	for _, d := range []string{"/Library/LaunchDaemons", "/Library/LaunchAgents", "/Library/Application Support", "/var/log"} {
		sb.write(d+"/.keep", "", 0o600)
	}
	sb.write("/mock/launchctl", "#!/bin/sh\necho \"launchctl $*\" >> \"$INSTALL_EVENTS\"\n", 0o755)
	// ditto -x -k ZIP DIR unpacks the helper's app.
	// The app's executable carries $FAKE_BUILD, so builds differ.
	sb.write("/mock/ditto", "#!/bin/sh\n[ \"$1 $2\" = '-x -k' ] || exit 9\napp=\"$4/Whombat Helper.app/Contents/MacOS\"\n"+
		"mkdir -p \"$app\" && printf '#!/bin/sh\\n# build %s\\n' \"${FAKE_BUILD:-1}\" > \"$app/WhombatHelper\" && chmod 0700 \"$app/WhombatHelper\"\n"+
		"printf 'CFBundleIdentifier=%s\\nCFBundleExecutable=WhombatHelper\\nCFBundleShortVersionString=%s\\n' \"${FAKE_BUNDLE_ID:-com.whombat.helper}\" \"${FAKE_VERSION:-1.0.0}\" > \"$app/../Info.plist\"\n"+
		"echo \"ditto $3\" >> \"$INSTALL_EVENTS\"\n", 0o755)
	// plutil -extract KEY raw -o - PLIST reads the fake Info.plist above.
	sb.write("/mock/plutil", "#!/bin/sh\n[ \"$1 $3 $4 $5\" = '-extract raw -o -' ] || exit 9\nsed -n \"s/^$2=//p\" \"$6\" | grep . || exit 1\n", 0o755)
	// codesign: an ad hoc requirement is the build's code hash; a team's
	// ($FAKE_TEAM) is the same for every build.
	sb.write("/mock/codesign", "#!/bin/sh\nif [ \"$1 $2 $3\" = '--verify --deep --strict' ]; then echo \"codesign verify\" >> \"$INSTALL_EVENTS\"; exit \"${FAKE_VERIFY_RC:-0}\"; fi\n"+
		"app=\"$3\"; [ \"$1\" = -dv ] && app=\"$2\"\n"+
		"exe=\"$app/Contents/MacOS/WhombatHelper\"; [ -f \"$exe\" ] || exit 1\n"+
		"case \"$1 $2\" in\n"+
		"'-d -r-') if [ -n \"$FAKE_TEAM\" ]; then echo \"designated => identifier \\\"com.whombat.helper\\\" and certificate leaf[subject.OU] = $FAKE_TEAM\"; "+
		"else echo \"# designated => cdhash H\\\"$(cksum < \"$exe\" | cut -d' ' -f1)\\\"\"; fi ;;\n"+
		"-dv*) echo \"TeamIdentifier=${FAKE_TEAM:-not set}\" >&2 ;;\nesac\n", 0o755)
	sb.write("/mock/tccutil", "#!/bin/sh\necho \"tccutil $*\" >> \"$INSTALL_EVENTS\"\n", 0o755)
	binary, _ := os.ReadFile(sb.root + "/fake-agent")
	sb.write("/staged/whombat-agent-darwin-arm64", string(binary), 0o755)
	sb.write("/staged/whombat-agent-darwin-amd64", "intel build", 0o755)
	zip := "a zip of Whombat Helper.app"
	sb.write("/staged/whombat-helper-macos.zip", zip, 0o644)
	helperSum := ""
	if helper {
		helperSum = fmt.Sprintf("%x", sha256.Sum256([]byte(zip)))
	}
	var script bytes.Buffer
	err := installTmpl.Execute(&script, map[string]string{
		"Origin": "https://hub.example", "AgentURL": "wss://hub.example:8443", "Pin": sb.pin,
		"Unit": AgentUnit, "RC": agentpkg.RCService, "OpenRC": agentpkg.OpenRCService, "UnraidRC": agentpkg.RCService,
		"SumAMD64": "", "SumARM64": "", "SumDarwinARM64": fmt.Sprintf("%x", sha256.Sum256(binary)),
		"SumDarwinAMD64": fmt.Sprintf("%x", sha256.Sum256([]byte("intel build"))),
		"HelperSum":      helperSum, "HelperVersion": "1.0.0", "HelperTeam": team,
	})
	if err != nil {
		t.Fatal(err)
	}
	r := sb.root
	replace := strings.NewReplacer("/usr/local/", r+"/usr/local/", "/etc/", r+"/etc/", "/var/lib/", r+"/var/lib/",
		"/var/log/", r+"/var/log/", "/var/run/", r+"/var/run/", "/Library/", r+"/Library/")
	sb.write("/install.sh", replace.Replace(script.String()), 0o700)
	return sb
}

func TestInstallerMac(t *testing.T) {
	sb := macSandbox(t, true)
	root := sb.root
	args := []string{"--token", "installer-test-token", "--hub", "wss://10.100.0.7:8443", "--download-base", sb.staged, "--control", "full"}
	out, errOut, err := sb.install(nil, args...)
	if err != nil {
		t.Fatalf("install: %v\n%s\n%s", err, out, errOut)
	}
	if lastLine(out) != "whombat-agent: added fake-host" || !hasLine(out, "whombat-agent: os macOS 27.2.1 · arm64") {
		t.Fatalf("install said:\n%s", out)
	}
	daemon, err := os.ReadFile(root + "/Library/LaunchDaemons/com.whombat.agent.plist")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<string>com.whombat.agent</string>", "<key>RunAtLoad</key>", "<key>KeepAlive</key>",
		"<string>" + root + "/Library/Application Support/Whombat/bin/whombat-agent</string>", "<string>run</string>", "/var/log/whombat-agent.log</string>"} {
		if !strings.Contains(string(daemon), want) {
			t.Errorf("LaunchDaemon lacks %q:\n%s", want, daemon)
		}
	}
	// The agent where only root writes; /usr/local/bin has a link to it.
	bin := root + "/Library/Application Support/Whombat/bin/whombat-agent"
	if st, err := os.Lstat(bin); err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0o755 {
		t.Fatalf("agent: %v %v", st, err)
	}
	if target, err := os.Readlink(root + "/usr/local/bin/whombat-agent"); err != nil || target != bin {
		t.Fatalf("command line link: %q %v", target, err)
	}
	agentPlist, err := os.ReadFile(root + "/Library/LaunchAgents/com.whombat.helper.plist")
	if err != nil || !strings.Contains(string(agentPlist), "<string>Aqua</string>") || !strings.Contains(string(agentPlist), "Whombat Helper.app/Contents/MacOS/WhombatHelper") {
		t.Fatalf("helper LaunchAgent: %v\n%s", err, agentPlist)
	}
	helper := root + "/Library/Application Support/Whombat/Whombat Helper.app/Contents/MacOS/WhombatHelper"
	if st, err := os.Stat(helper); err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("helper app: %v %v", st, err)
	}
	if _, err := os.Stat(root + "/etc/newsyslog.d/whombat-agent.conf"); err != nil {
		t.Error("no log rotation")
	}
	ev := sb.events()
	for _, want := range []string{"enrolled\npolicy full\n", "launchctl enable system/com.whombat.agent\n",
		"launchctl bootstrap system " + root + "/Library/LaunchDaemons/com.whombat.agent.plist\n",
		"launchctl bootstrap gui/501 " + root + "/Library/LaunchAgents/com.whombat.helper.plist\n"} {
		if !strings.Contains(ev, want) {
			t.Errorf("events lack %q:\n%s", want, ev)
		}
	}

	// Again: the identity stays. The same helper build keeps its
	// Accessibility permission.
	if out, errOut, err := sb.install(nil, args...); err != nil || lastLine(out) != "whombat-agent: kept fake-host" {
		t.Fatalf("reinstall: %v\n%s\n%s", err, out, errOut)
	}
	if strings.Contains(sb.events(), "tccutil") {
		t.Fatalf("the same build's permission was reset:\n%s", sb.events())
	}
	// Another ad hoc build: macOS would keep a stale entry, so it is reset
	// and the new build shows up switched off.
	before := sb.events()
	out, errOut, err = sb.install([]string{"FAKE_BUILD=2"}, args...)
	if err != nil || !hasLine(out, "Whombat Helper is a new build to macOS: switch its Accessibility on again in System Settings → Privacy & Security → Accessibility.") {
		t.Fatalf("new build: %v\n%s\n%s", err, out, errOut)
	}
	if ev := strings.TrimPrefix(sb.events(), before); !strings.Contains(ev, "tccutil reset Accessibility com.whombat.helper\n") ||
		strings.Index(ev, "tccutil") > strings.Index(ev, "launchctl bootstrap gui/501") {
		t.Fatalf("new build's events:\n%s", ev)
	}
	// Builds of one Developer ID team keep it.
	before = sb.events()
	if _, errOut, err := sb.install([]string{"FAKE_BUILD=3", "FAKE_TEAM=AB12CD34EF"}, args...); err != nil {
		t.Fatalf("team build: %v\n%s", err, errOut)
	}
	if ev := strings.TrimPrefix(sb.events(), before); strings.Contains(ev, "tccutil") {
		t.Fatalf("a team's build was reset:\n%s", ev)
	}
	// A wrong checksum is refused.
	if _, errOut, err := sb.install(nil, "--download-base", sb.staged, "--sha256", strings.Repeat("0", 64)); err == nil || !strings.Contains(errOut, "checksum mismatch") {
		t.Fatalf("bad checksum accepted: %v %s", err, errOut)
	}

	// An agent installed in /usr/local/bin before moves: the link takes its
	// place there.
	os.Remove(root + "/usr/local/bin/whombat-agent")
	sb.write("/usr/local/bin/whombat-agent", "an older agent", 0o755)
	if _, errOut, err := sb.install(nil, args...); err != nil {
		t.Fatalf("move: %v\n%s", err, errOut)
	}
	if target, err := os.Readlink(root + "/usr/local/bin/whombat-agent"); err != nil || target != bin {
		t.Fatalf("after the move: %q %v", target, err)
	}

	// Uninstall without --purge keeps the identity but never the stored
	// screen password.
	sb.write("/etc/whombat-agent/screen.toml", "user = \"alex\"\npassword = \"pw\"\n", 0o600)
	if out, errOut, err := sb.install(nil, "--uninstall"); err != nil {
		t.Fatalf("uninstall: %v\n%s\n%s", err, out, errOut)
	}
	if _, err := os.Stat(root + "/etc/whombat-agent/screen.toml"); !os.IsNotExist(err) {
		t.Fatal("the screen password stayed after uninstall")
	}
	if _, err := os.Stat(root + "/etc/whombat-agent/agent.crt"); err != nil {
		t.Fatalf("the identity went without --purge: %v", err)
	}
	for _, p := range []string{"/Library/Application Support/Whombat", "/usr/local/bin/whombat-agent"} {
		if _, err := os.Lstat(root + p); !os.IsNotExist(err) {
			t.Errorf("%s left after uninstall", p)
		}
	}
	if _, errOut, err := sb.install(nil, args...); err != nil {
		t.Fatalf("again after uninstall: %v\n%s", err, errOut)
	}

	// Uninstall --purge removes the agent, the helper (and its permission)
	// and the identity.
	before = sb.events()
	if out, errOut, err := sb.install(nil, "--purge"); err != nil {
		t.Fatalf("uninstall: %v\n%s\n%s", err, out, errOut)
	}
	for _, p := range []string{"/Library/LaunchDaemons/com.whombat.agent.plist", "/Library/LaunchAgents/com.whombat.helper.plist",
		"/Library/Application Support/Whombat", "/usr/local/bin/whombat-agent", "/etc/whombat-agent", "/etc/newsyslog.d/whombat-agent.conf"} {
		if _, err := os.Stat(root + p); !os.IsNotExist(err) {
			t.Errorf("%s left after uninstall", p)
		}
	}
	ev = strings.TrimPrefix(sb.events(), before)
	if !strings.Contains(ev, "launchctl bootout system/com.whombat.agent\n") || !strings.Contains(ev, "launchctl bootout gui/501/com.whombat.helper\n") ||
		!strings.Contains(ev, "tccutil reset Accessibility com.whombat.helper\n") {
		t.Errorf("uninstall events:\n%s", ev)
	}
}

func TestInstallerMacWithoutHelper(t *testing.T) {
	sb := macSandbox(t, false)
	out, errOut, err := sb.install([]string{"FAKE_ARCH=x86_64"}, "--token", "installer-test-token", "--download-base", sb.staged)
	if err != nil {
		t.Fatalf("%v\n%s\n%s", err, out, errOut)
	}
	// A shell under Rosetta still gets the Apple silicon build.
	if !hasLine(out, "whombat-agent: os macOS 27.2.1 · arm64") || !strings.Contains(out, "no Whombat Helper") {
		t.Fatalf("said:\n%s", out)
	}
	if _, err := os.Stat(sb.root + "/Library/LaunchAgents/com.whombat.helper.plist"); !os.IsNotExist(err) {
		t.Error("helper installed without a helper build")
	}
	if strings.Contains(sb.events(), "gui/") {
		t.Errorf("events: %s", sb.events())
	}
	// An Intel Mac gets the amd64 build.
	sb2 := macSandbox(t, false)
	out, errOut, err = sb2.install([]string{"FAKE_ARCH=x86_64", "FAKE_ARM64=0"}, "--token", "installer-test-token", "--download-base", sb2.staged)
	if err == nil || !hasLine(out, "whombat-agent: os macOS 27.2.1 · amd64") {
		// The Intel stand-in is no runnable agent: the install stops after
		// the download, which is all this checks.
		t.Fatalf("intel: %v\n%s\n%s", err, out, errOut)
	}
}

func TestInstallerMacTooOld(t *testing.T) {
	sb := macSandbox(t, true)
	_, errOut, err := sb.install([]string{"FAKE_MACOS=12.7.4"}, "--token", "installer-test-token", "--download-base", sb.staged)
	if err == nil || !strings.HasSuffix(errOut, "install.sh: macOS 13 or later is needed (this Mac has 12.7.4)\n") {
		t.Fatalf("%v %q", err, errOut)
	}
	if _, err := os.Stat(sb.root + "/usr/local/bin/whombat-agent"); !os.IsNotExist(err) {
		t.Fatal("installed on an old macOS")
	}
}

// At the first install as at an update, the helper must be the bundle the
// hub described and its signature must verify.
func TestInstallerMacHelperChecks(t *testing.T) {
	for _, c := range []struct {
		name string
		env  []string
		team string
		want string
	}{
		{"another bundle", []string{"FAKE_BUNDLE_ID=com.example.other"}, "", "isn't Whombat Helper 1.0.0"},
		{"another version", []string{"FAKE_VERSION=0.9.0"}, "", "isn't Whombat Helper 1.0.0"},
		{"a broken signature", []string{"FAKE_VERIFY_RC=1"}, "", "signature doesn't verify"},
		{"another team", []string{"FAKE_TEAM=ZZ99ZZ99ZZ"}, "AB12CD34EF", "team the hub names"},
	} {
		sb := macSandboxTeam(t, true, c.team)
		_, errOut, err := sb.install(c.env, "--token", "installer-test-token", "--download-base", sb.staged)
		if err == nil || !strings.Contains(errOut, c.want) {
			t.Fatalf("%s: %v %q", c.name, err, errOut)
		}
		if _, err := os.Stat(sb.root + "/Library/Application Support/Whombat/Whombat Helper.app"); !os.IsNotExist(err) {
			t.Fatalf("%s: installed anyway", c.name)
		}
	}
	sb := macSandboxTeam(t, true, "AB12CD34EF")
	if _, errOut, err := sb.install([]string{"FAKE_TEAM=AB12CD34EF"}, "--token", "installer-test-token", "--download-base", sb.staged); err != nil {
		t.Fatalf("the hub's team: %v %s", err, errOut)
	}
	if !strings.Contains(sb.events(), "codesign verify\n") {
		t.Fatalf("not verified:\n%s", sb.events())
	}
}
