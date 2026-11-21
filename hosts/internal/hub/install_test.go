package hub

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentpkg "rackoon/packaging/agent"
)

// fakeAgentScript stands in for whombat-agent in the installer tests: it
// records what install.sh asks of it in $INSTALL_EVENTS.
const fakeAgentScript = `#!/bin/sh
cmd=$1; shift
config=/nonexistent; args=""; force=""; check=""; hub=""; token=""
while [ $# -gt 0 ]; do
    case "$1" in
    --hub) hub=$2; shift 2 ;;
    --token) [ "$2" = - ] || exit 9; IFS= read -r token; shift 2 ;;
    --config-dir) config=$2; shift 2 ;;
    --ca-sha256|--pid-file) [ "$1" = --pid-file ] && pidfile=$2; shift 2 ;;
    --force) force=1; shift ;;
    --check) check=1; shift ;;
    --no-reload|--no-restart) shift ;;
    *) args="$args $1"; shift ;;
    esac
done
case "$cmd" in
enroll)
    [ "$token" = installer-test-token ] || { echo "whombat-agent: enrollment refused: invalid_token" >&2; exit 10; }
    if [ -f "$config/agent.crt" ] && [ -z "$force" ]; then echo "whombat-agent: already enrolled" >&2; exit 11; fi
    if [ -n "$FAKE_PENDING" ]; then
        echo "Approve this server in Whombat (Add a server) to finish."
        echo "whombat-agent: waiting en_test"
    fi
    printf 'hub = "%s"\n' "$hub" > "$config/agent.toml"
    echo certificate > "$config/agent.crt"
    cp "$FAKE_CA" "$config/ca.crt"
    echo "enrolled${force:+ --force}" >> "$INSTALL_EVENTS"
    ;;
whoami)
    if [ -n "$check" ]; then
        echo "check $hub" >> "$INSTALL_EVENTS"
        echo "fake-host $FAKE_PIN ${FAKE_CHECK:-known}"
    else
        echo "fake-host $FAKE_PIN"
    fi
    ;;
hub)
    set -- $args
    printf 'hub = "%s"\n' "$1" > "$config/agent.toml"
    echo "hub $1" >> "$INSTALL_EVENTS"
    ;;
policy)
    set -- $args
    [ "$1" = set ] || exit 12
    echo "policy $2" >> "$INSTALL_EVENTS"
    ;;
supervise)
    trap 'echo > "$pidfile"; exit 0' TERM INT
    trap 'echo reloaded >> "$INSTALL_EVENTS"' HUP
    echo $$ > "$pidfile"
    while :; do sleep 0.1; done
    ;;
esac
`

// testCA is a CA certificate in PEM and its pin (hex SHA-256 of the DER).
func testCA(t *testing.T, name string) ([]byte, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), hex.EncodeToString(sum[:])
}

// installSandbox runs the real generated installer in a filesystem sandbox.
// Downloads, the agent and init commands are fakes; boot hooks and service
// scripts are real, so persistence and upgrade behavior are exercised
// without root.
type installSandbox struct {
	t       *testing.T
	root    string
	manager string
	caPEM   []byte
	pin     string
	env     []string
	staged  string
}

func newInstallSandbox(t *testing.T, manager string) *installSandbox {
	t.Helper()
	sb := &installSandbox{t: t, root: t.TempDir(), manager: manager}
	sb.caPEM, sb.pin = testCA(t, "Whombat hosts CA")
	sb.write("/usr/local/bin/.keep", "", 0o600)
	sb.write("/etc/os-release", "NAME=\"Debian GNU/Linux\"\nPRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\n", 0o644)
	sb.write("/mock/id", "#!/bin/sh\necho \"${FAKE_UID:-0}\"\n", 0o755)
	sb.write("/mock/uname", "#!/bin/sh\nif [ \"$1\" = -m ]; then echo \"${FAKE_ARCH:-x86_64}\"; else echo Linux; fi\n", 0o755)
	sb.write("/mock/curl", "#!/bin/sh\ncp \"$FAKE_AGENT\" \"$3\"\n", 0o755)
	// Platform probes answer nothing unless a test says so (the machine
	// running the tests may have incus itself).
	sb.write("/mock/incus", "#!/bin/sh\nexit 1\n", 0o755)
	sb.write("/mock/pveversion", "#!/bin/sh\nexit 1\n", 0o755)
	sb.write("/fake-agent", fakeAgentScript, 0o755)
	sb.write("/ca.pem", string(sb.caPEM), 0o644)
	mockInit := "#!/bin/sh\necho \"$(basename \"$0\") $*\" >> \"$INSTALL_EVENTS\"\n"
	switch manager {
	case "systemd":
		sb.write("/run/systemd/system/.keep", "", 0o600)
		sb.write("/etc/systemd/system/.keep", "", 0o600)
		sb.write("/mock/systemctl", mockInit, 0o755)
	case "openrc":
		sb.write("/etc/init.d/.keep", "", 0o600)
		for _, cmd := range []string{"rc-service", "rc-update", "supervise-daemon"} {
			sb.write("/mock/"+cmd, mockInit, 0o755)
		}
	case "sysv":
		sb.write("/etc/init.d/.keep", "", 0o600)
		sb.write("/run/.keep", "", 0o600)
		sb.write("/mock/update-rc.d", mockInit, 0o755)
	case "unraid":
		sb.write("/etc/unraid-version", "version=7.3.1", 0o600)
		sb.write("/boot/config/go", "#!/bin/bash\necho existing-owner-command\n", 0o600)
		sb.write("/etc/rc.d/.keep", "", 0o600)
		sb.write("/run/.keep", "", 0o600)
	}
	binary, _ := os.ReadFile(sb.root + "/fake-agent")
	sb.writeScript(sb.pin, fmt.Sprintf("%x", sha256.Sum256(binary)))
	// Staged binaries (file://) are copied, not fetched with curl/wget.
	sb.write("/staged/whombat-agent-linux-amd64", string(binary), 0o755)
	sb.staged = "file://" + sb.root + "/staged"
	sb.env = append(os.Environ(), "PATH="+sb.root+"/mock:/usr/bin:/bin", "FAKE_AGENT="+sb.root+"/fake-agent",
		"INSTALL_EVENTS="+sb.root+"/events", "FAKE_CA="+sb.root+"/ca.pem", "FAKE_PIN="+sb.pin)
	return sb
}

func (sb *installSandbox) write(path, data string, mode os.FileMode) {
	sb.t.Helper()
	path = sb.root + path
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		sb.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), mode); err != nil {
		sb.t.Fatal(err)
	}
}

// writeScript renders install.sh for a hub with CA pin and the amd64
// checksum, its absolute paths moved into the sandbox.
func (sb *installSandbox) writeScript(pin, sum string) {
	sb.t.Helper()
	var script bytes.Buffer
	err := installTmpl.Execute(&script, map[string]string{
		"Origin": "https://hub.example", "AgentURL": "wss://hub.example:8443", "Pin": pin,
		"Unit": AgentUnit, "RC": agentpkg.RCService, "OpenRC": agentpkg.OpenRCService,
		"UnraidRC": strings.ReplaceAll(agentpkg.RCService, "/etc/whombat-agent", "/boot/config/plugins/whombat-agent"),
		"SumAMD64": sum, "SumARM64": "",
	})
	if err != nil {
		sb.t.Fatal(err)
	}
	r := sb.root
	replace := strings.NewReplacer("/usr/local/", r+"/usr/local/", "/etc/", r+"/etc/", "/run/", r+"/run/", "/boot/", r+"/boot/", "/var/lib/", r+"/var/lib/")
	sb.write("/install.sh", replace.Replace(script.String()), 0o700)
}

// run runs a command in the sandbox with extra environment; it returns
// stdout and stderr apart.
func (sb *installSandbox) run(stdin string, env []string, args ...string) (string, string, error) {
	cmd := exec.Command("sh", args...)
	cmd.Env = append(append([]string{}, sb.env...), env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return out.String(), errb.String(), err
}

// install runs install.sh with args.
func (sb *installSandbox) install(env []string, args ...string) (string, string, error) {
	return sb.run("", env, append([]string{sb.root + "/install.sh"}, args...)...)
}

func (sb *installSandbox) events() string {
	b, _ := os.ReadFile(sb.root + "/events")
	return string(b)
}

func (sb *installSandbox) configDir() string {
	if sb.manager == "unraid" {
		return sb.root + "/boot/config/plugins/whombat-agent"
	}
	return sb.root + "/etc/whombat-agent"
}

func (sb *installSandbox) stopService() {
	switch sb.manager {
	case "sysv":
		_, _, _ = sb.run("", nil, sb.root+"/etc/init.d/whombat-agent", "stop")
	case "unraid":
		_, _, _ = sb.run("", nil, sb.root+"/etc/rc.d/rc.whombat-agent", "stop")
	}
}

// hasLine reports whether out has the line.
func hasLine(out, line string) bool {
	return strings.Contains("\n"+out, "\n"+line+"\n")
}

// lastLine is the last non-empty line of out.
func lastLine(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	return lines[len(lines)-1]
}

func TestInstallerServiceManagers(t *testing.T) {
	for _, manager := range []string{"systemd", "openrc", "sysv", "unraid", "unsupported"} {
		t.Run(manager, func(t *testing.T) {
			sb := newInstallSandbox(t, manager)
			root := sb.root
			t.Cleanup(sb.stopService)
			args := []string{"--token", "installer-test-token", "--hub", "wss://10.100.0.7:8443", "--download-base", sb.staged, "--control", "full"}
			out, errOut, err := sb.install(nil, args...)
			if manager == "unsupported" {
				if err == nil || !strings.Contains(errOut, "install.sh: unsupported init system") {
					t.Fatalf("unsupported init: %v %s", err, errOut)
				}
				if _, err := os.Stat(root + "/usr/local/bin/whombat-agent"); !os.IsNotExist(err) {
					t.Fatal("unsupported installer mutated the host")
				}
				return
			}
			if err != nil {
				t.Fatalf("install: %v %s %s", err, out, errOut)
			}
			wantOS := "whombat-agent: os Debian GNU/Linux 13 (trixie) · amd64"
			if manager == "unraid" {
				wantOS = "whombat-agent: os Unraid 7.3.1 · Debian GNU/Linux 13 (trixie) · amd64"
			}
			if lastLine(out) != "whombat-agent: added fake-host" || !hasLine(out, wantOS) ||
				!strings.Contains(out, "Added to Whombat as fake-host.") || strings.Contains(out, "Approve") {
				t.Fatalf("fresh install said:\n%s", out)
			}
			if ev := sb.events(); !strings.Contains(ev, "enrolled\npolicy full\n") {
				t.Fatalf("events: %s", ev)
			}
			service := root + "/etc/init.d/whombat-agent"
			if manager == "unraid" {
				service = root + "/etc/rc.d/rc.whombat-agent"
			}
			if manager == "unraid" || manager == "sysv" {
				if _, errOut, err := sb.run("", nil, service, "status"); err != nil {
					t.Fatalf("service status: %v %s", err, errOut)
				}
			}
			// Reinstall keeps the identity (the same CA), re-points the hub,
			// applies the level and never adds a second boot hook.
			out, errOut, err = sb.install(nil, args...)
			if err != nil {
				t.Fatalf("reinstall: %v %s", err, errOut)
			}
			if lastLine(out) != "whombat-agent: kept fake-host" || !hasLine(out, wantOS) {
				t.Fatalf("reinstall said:\n%s", out)
			}
			events := sb.events()
			if strings.Count(events, "enrolled\n") != 1 || !strings.Contains(events, "check wss://10.100.0.7:8443\nhub wss://10.100.0.7:8443\npolicy full\n") {
				t.Fatalf("reinstall events: %s", events)
			}
			config := sb.configDir()
			if manager == "unraid" {
				goFile, _ := os.ReadFile(root + "/boot/config/go")
				if !strings.HasPrefix(string(goFile), "#!/bin/bash\necho existing-owner-command\n") || strings.Count(string(goFile), "/start.sh") != 1 {
					t.Fatalf("owner boot script was changed or hook duplicated: %s", goFile)
				}
				// Simulate loss of RAM files on reboot; execute only our boot hook.
				if _, errOut, err := sb.run("", nil, service, "stop"); err != nil {
					t.Fatalf("stop: %v %s", err, errOut)
				}
				_ = os.Remove(root + "/usr/local/bin/whombat-agent")
				_ = os.Remove(service)
				if _, errOut, err := sb.run("", nil, config+"/start.sh"); err != nil {
					t.Fatalf("boot restoration: %v %s", err, errOut)
				}
				if _, errOut, err := sb.run("", nil, service, "status"); err != nil {
					t.Fatalf("restored service: %v %s", err, errOut)
				}
			}
			cfg, _ := os.ReadFile(config + "/agent.toml")
			if string(cfg) != "hub = \"wss://10.100.0.7:8443\"\n" {
				t.Fatalf("LAN hub override not persisted: %s", cfg)
			}
			// An enrolled agent upgrades without a token (no hub check, no
			// level change).
			before := sb.events()
			if out, errOut, err := sb.install(nil, "--download-base", sb.staged); err != nil || lastLine(out) != "whombat-agent: kept fake-host" {
				t.Fatalf("upgrade without token: %v %s %s", err, out, errOut)
			}
			if ev := strings.TrimPrefix(sb.events(), before); strings.Contains(ev, "check") || strings.Contains(ev, "policy") {
				t.Fatalf("upgrade without token or level: %s", ev)
			}
			// A wrong checksum is refused.
			if _, errOut, err := sb.install(nil, "--download-base", sb.staged, "--sha256", strings.Repeat("0", 64)); err == nil ||
				!strings.Contains(errOut, "checksum mismatch") {
				t.Fatalf("bad checksum accepted: %v %s", err, errOut)
			}
			// Uninstall removes the binary and service but keeps the identity.
			sb.stopService()
			if _, errOut, err := sb.install(nil, "--uninstall"); err != nil {
				t.Fatalf("uninstall: %v %s", err, errOut)
			}
			if _, err := os.Stat(root + "/usr/local/bin/whombat-agent"); !os.IsNotExist(err) {
				t.Fatal("binary left after uninstall")
			}
			if _, err := os.Stat(config + "/agent.crt"); err != nil {
				t.Fatal("identity removed without --purge")
			}
			if manager == "unraid" {
				goFile, _ := os.ReadFile(root + "/boot/config/go")
				if strings.Contains(string(goFile), "start.sh") || !strings.Contains(string(goFile), "existing-owner-command") {
					t.Fatalf("boot hook not removed cleanly: %s", goFile)
				}
			}
		})
	}
}

// Whombat runs the installer over SSH as `sudo -S -p ” sh install.sh
// --token - …` with stdin "password\ntoken\n": sudo reads its line, the
// script the next one.
func TestInstallerTokenAfterSudoPassword(t *testing.T) {
	sb := newInstallSandbox(t, "systemd")
	sb.write("/mock/sudo", "#!/bin/sh\n[ \"$1\" = -S ] && shift 3\nIFS= read -r pw\n[ \"$pw\" = 'secret pass' ] || exit 1\nexec \"$@\"\n", 0o755)
	out, errOut, err := sb.run("secret pass\ninstaller-test-token\n", nil, sb.root+"/mock/sudo", "-S", "-p", "",
		"sh", sb.root+"/install.sh", "--token", "-", "--control", "operate", "--download-base", sb.staged)
	if err != nil || lastLine(out) != "whombat-agent: added fake-host" {
		t.Fatalf("install: %v\n%s\n%s", err, out, errOut)
	}
	if ev := sb.events(); !strings.Contains(ev, "enrolled\npolicy operate\n") {
		t.Fatalf("events: %s", ev)
	}
	// A token without a newline at the end works too; no token is refused.
	sb2 := newInstallSandbox(t, "systemd")
	if out, errOut, err := sb2.run("installer-test-token", nil, sb2.root+"/install.sh", "--token", "-", "--download-base", sb2.staged); err != nil ||
		lastLine(out) != "whombat-agent: added fake-host" {
		t.Fatalf("token without newline: %v %s %s", err, out, errOut)
	}
	if _, errOut, err := sb2.run("", nil, sb2.root+"/install.sh", "--token", "-", "--force"); err == nil ||
		!strings.Contains(errOut, "install.sh: could not read the token from stdin") {
		t.Fatalf("empty stdin: %v %s", err, errOut)
	}
}

// Kept with a changed box address; --control both ways; a server Whombat
// removed enrolls again; a token that is not pre-approved waits.
func TestInstallerKeptAndWaiting(t *testing.T) {
	sb := newInstallSandbox(t, "systemd")
	if out, errOut, err := sb.install([]string{"FAKE_PENDING=1"}, "--token", "installer-test-token", "--download-base", sb.staged); err != nil ||
		!hasLine(out, "whombat-agent: waiting en_test") || lastLine(out) != "whombat-agent: added fake-host" {
		t.Fatalf("waiting install: %v\n%s\n%s", err, out, errOut)
	} else if strings.Index(out, "whombat-agent: os ") > strings.Index(out, "whombat-agent: waiting") {
		t.Fatalf("the os line comes after waiting:\n%s", out)
	}
	if ev := sb.events(); strings.Contains(ev, "policy") {
		t.Fatalf("no --control, but the level changed: %s", ev)
	}
	cfg, _ := os.ReadFile(sb.configDir() + "/agent.toml")
	if string(cfg) != "hub = \"wss://hub.example:8443\"\n" {
		t.Fatalf("agent.toml: %s", cfg)
	}
	for _, level := range []string{"watch", "full", "operate"} {
		before := sb.events()
		out, errOut, err := sb.install(nil, "--token", "installer-test-token", "--hub", "wss://10.100.1.9:8443", "--control", level,
			"--download-base", sb.staged)
		if err != nil || lastLine(out) != "whombat-agent: kept fake-host" {
			t.Fatalf("kept %s: %v\n%s\n%s", level, err, out, errOut)
		}
		if ev := strings.TrimPrefix(sb.events(), before); !strings.Contains(ev, "hub wss://10.100.1.9:8443\npolicy "+level+"\n") ||
			strings.Contains(ev, "enrolled") {
			t.Fatalf("kept %s events: %s", level, ev)
		}
	}
	// Removed in Whombat (the hub refuses the certificate): enroll again.
	out, errOut, err := sb.install([]string{"FAKE_CHECK=removed"}, "--token", "installer-test-token", "--control", "full",
		"--download-base", sb.staged)
	if err != nil || lastLine(out) != "whombat-agent: added fake-host" || !strings.Contains(sb.events(), "enrolled --force\npolicy full\n") {
		t.Fatalf("removed identity: %v\n%s\n%s\n%s", err, out, errOut, sb.events())
	}
	// Unreachable or unknown answers keep the identity.
	if out, _, err := sb.install([]string{"FAKE_CHECK=unreachable"}, "--token", "installer-test-token", "--download-base", sb.staged); err != nil ||
		lastLine(out) != "whombat-agent: kept fake-host" {
		t.Fatalf("unreachable check: %v %s", err, out)
	}
}

// An agent of another Whombat (another CA) is left alone, before anything
// changes; --force moves it here.
func TestInstallerOtherWhombat(t *testing.T) {
	for _, manager := range []string{"systemd", "unraid"} {
		t.Run(manager, func(t *testing.T) {
			sb := newInstallSandbox(t, manager)
			t.Cleanup(sb.stopService)
			otherPEM, _ := testCA(t, "Another Whombat")
			cfgDir := strings.TrimPrefix(sb.configDir(), sb.root)
			sb.write(cfgDir+"/agent.crt", "certificate\n", 0o644)
			sb.write(cfgDir+"/ca.crt", string(otherPEM), 0o644)
			sb.write(cfgDir+"/agent.toml", "hub = 'wss://10.0.0.1:8443'\nca_sha256 = '"+sb.pin+"'\n", 0o600)
			for _, args := range [][]string{
				{"--token", "installer-test-token", "--control", "full", "--download-base", sb.staged},
				{"--download-base", sb.staged},
			} {
				out, errOut, err := sb.install(nil, args...)
				var ee *exec.ExitError
				if !errors.As(err, &ee) || ee.ExitCode() != 3 || lastLine(out) != "whombat-agent: other-whombat" ||
					!strings.Contains(errOut, "install.sh: this server reports to another Whombat") || !strings.Contains(out, "whombat-agent: os ") {
					t.Fatalf("other Whombat %v: %v\n%s\n%s", args, err, out, errOut)
				}
				if _, err := os.Stat(sb.root + "/usr/local/bin/whombat-agent"); !os.IsNotExist(err) || sb.events() != "" {
					t.Fatalf("the installer changed something: %s", sb.events())
				}
			}
			// The CA is read from ca.crt, not from agent.toml (which this
			// file fakes with our pin).
			out, errOut, err := sb.install(nil, "--token", "installer-test-token", "--force", "--control", "watch", "--download-base", sb.staged)
			if err != nil || lastLine(out) != "whombat-agent: added fake-host" || !strings.Contains(sb.events(), "enrolled --force\npolicy watch\n") {
				t.Fatalf("--force: %v\n%s\n%s\n%s", err, out, errOut, sb.events())
			}
			if ca, _ := os.ReadFile(sb.configDir() + "/ca.crt"); !bytes.Equal(ca, sb.caPEM) {
				t.Fatal("the identity was not replaced")
			}
		})
	}
	// Without ca.crt, agent.toml's ca_sha256 decides (any case).
	sb := newInstallSandbox(t, "systemd")
	sb.write("/etc/whombat-agent/agent.crt", "certificate\n", 0o644)
	sb.write("/etc/whombat-agent/agent.toml", "hub = \"wss://10.0.0.1:8443\"\nca_sha256 = \""+strings.ToUpper(sb.pin)+"\"\n", 0o600)
	if out, errOut, err := sb.install(nil, "--download-base", sb.staged); err != nil || lastLine(out) != "whombat-agent: kept fake-host" {
		t.Fatalf("pin from agent.toml: %v\n%s\n%s", err, out, errOut)
	}
}

// Failures name themselves in stable words, before anything is installed.
func TestInstallerErrorWords(t *testing.T) {
	// A PATH with the tools the script needs but neither curl nor wget.
	minimal := func(sb *installSandbox, with ...string) []string {
		bin := sb.root + "/bin"
		os.MkdirAll(bin, 0o755)
		for _, tool := range []string{"sh", "cat", "cp", "mv", "rm", "mkdir", "mktemp", "chmod", "install", "sed", "awk", "grep",
			"cut", "tr", "head", "sha256sum", "base64", "basename", "printf", "sleep"} {
			if p, err := exec.LookPath(tool); err == nil {
				os.Symlink(p, bin+"/"+tool)
			}
		}
		for _, w := range with {
			sb.write("/bin/"+w[:strings.Index(w, "=")], "#!/bin/sh\n"+w[strings.Index(w, "=")+1:]+"\n", 0o755)
		}
		return []string{"PATH=" + sb.root + "/mock:" + bin}
	}
	cases := []struct {
		name    string
		env     func(sb *installSandbox) []string
		args    []string
		want    string
		removed bool // the mock curl is taken away
	}{
		{"curl unreachable", func(sb *installSandbox) []string {
			sb.write("/mock/curl", "#!/bin/sh\nexit 7\n", 0o755)
			return nil
		}, nil, "install.sh: cannot reach https://hub.example/download/whombat-agent-linux-amd64\n", false},
		{"curl timeout", func(sb *installSandbox) []string {
			sb.write("/mock/curl", "#!/bin/sh\nexit 28\n", 0o755)
			return nil
		}, nil, "install.sh: cannot reach https://hub.example/download/whombat-agent-linux-amd64\n", false},
		{"curl other", func(sb *installSandbox) []string {
			sb.write("/mock/curl", "#!/bin/sh\nexit 22\n", 0o755)
			return nil
		}, nil, "install.sh: download failed: https://hub.example/download/whombat-agent-linux-amd64 (curl exit 22)\n", false},
		{"wget unreachable", func(sb *installSandbox) []string {
			return minimal(sb, "wget=exit 4")
		}, nil, "install.sh: cannot reach https://hub.example/download/whombat-agent-linux-amd64\n", true},
		{"busybox wget unreachable", func(sb *installSandbox) []string {
			return minimal(sb, "wget=echo \"wget: can't connect to remote host (10.62.52.1): Connection refused\" >&2; exit 1")
		}, nil, "wget: can't connect to remote host (10.62.52.1): Connection refused\ninstall.sh: cannot reach https://hub.example/download/whombat-agent-linux-amd64\n", true},
		{"busybox wget 404", func(sb *installSandbox) []string {
			return minimal(sb, "wget=echo 'wget: server returned error: HTTP/1.1 404 Not Found' >&2; exit 1")
		}, nil, "install.sh: download failed: https://hub.example/download/whombat-agent-linux-amd64 (wget exit 1)\n", true},
		{"no downloader", func(sb *installSandbox) []string { return minimal(sb) }, nil, "install.sh: curl or wget is required\n", true},
		{"not root", func(sb *installSandbox) []string { return []string{"FAKE_UID=1000"} }, nil, "install.sh: run as root (sudo)\n", false},
		{"architecture", func(sb *installSandbox) []string { return []string{"FAKE_ARCH=riscv64"} }, nil,
			"install.sh: unsupported architecture riscv64\n", false},
		{"bad level", func(sb *installSandbox) []string { return nil }, []string{"--control", "everything"},
			"install.sh: --control must be watch, operate or full\n", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sb := newInstallSandbox(t, "systemd")
			if c.removed {
				os.Remove(sb.root + "/mock/curl")
			}
			args := append([]string{"--token", "installer-test-token", "--control", "full"}, c.args...)
			out, errOut, err := sb.install(c.env(sb), args...)
			if err == nil || !strings.HasSuffix(errOut, c.want) || strings.Contains(out, "whombat-agent: added") {
				t.Fatalf("%v\nstdout:\n%s\nstderr:\n%s\nwant %q", err, out, errOut, c.want)
			}
			if _, err := os.Stat(sb.root + "/usr/local/bin/whombat-agent"); !os.IsNotExist(err) {
				t.Fatal("installed after a failure")
			}
		})
	}
}

// The os line names the platform first, like Whombat's progress shows it.
func TestInstallerOSLine(t *testing.T) {
	sb := newInstallSandbox(t, "systemd")
	sb.write("/mock/pveversion", "#!/bin/sh\necho 'pve-manager/9.0.3/025864202ebb6109 (running kernel: 6.14.8-2-pve)'\n", 0o755)
	sb.write("/mock/incus", "#!/bin/sh\n[ \"$1\" = --version ] && echo 6.0.4\n", 0o755)
	out, errOut, err := sb.install([]string{"FAKE_ARCH=aarch64"}, "--token", "installer-test-token", "--download-base", sb.staged,
		"--sha256", strings.Repeat("0", 64))
	if err == nil || !strings.Contains(out, "whombat-agent: os Proxmox VE 9.0 · Incus 6.0 · Debian GNU/Linux 13 (trixie) · arm64\n") {
		t.Fatalf("%v\n%s\n%s", err, out, errOut)
	}
}

// Without a published checksum the installer refuses unless --sha256 is given.
func TestInstallerRequiresChecksum(t *testing.T) {
	var script bytes.Buffer
	if err := installTmpl.Execute(&script, map[string]string{"Origin": "https://hub.example", "AgentURL": "wss://hub.example:8443",
		"Pin": strings.Repeat("a", 64), "Unit": AgentUnit, "SumAMD64": "", "SumARM64": ""}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(script.String(), "the hub publishes no checksum") {
		t.Fatal("installer lacks the checksum requirement")
	}
}
