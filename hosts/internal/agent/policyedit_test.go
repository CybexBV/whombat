package agent

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseSwitches(t *testing.T) {
	got, err := ParseSwitches([]string{"manage", "Power", "host-shell", "manage"})
	if err != nil || !reflect.DeepEqual(got, []string{"power", "host_shell", "manage"}) {
		t.Fatalf("switches %q %v", got, err)
	}
	if got, _ := ParseSwitches([]string{"all"}); !reflect.DeepEqual(got, RemoteSwitches) {
		t.Fatalf("all = %q", got)
	}
	_, err = ParseSwitches([]string{"manage", "consoles"})
	if err == nil || !strings.Contains(err.Error(), `"consoles" is not a switch`) || !strings.Contains(err.Error(), "console, power, host_shell, host_power, manage, diagnose and all") {
		t.Fatalf("unknown switch: %v", err)
	}
	if _, err := ParseSwitches(nil); err == nil || !strings.Contains(err.Error(), "name a switch") {
		t.Fatalf("no switch: %v", err)
	}
}

// The enrolled template: values change in place, every other line stays.
func TestSetRemoteControlTemplate(t *testing.T) {
	dir := t.TempDir()
	if err := WriteInitialConfig(&Config{Dir: dir, Hub: "wss://10.100.1.5:8443", CASHA256: "ab", StateDir: DefaultStateDir}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, ConfigFileName))
	out, err := SetRemoteControl(string(b), map[string]bool{"manage": true, "power": true, "diagnose": false})
	if err != nil {
		t.Fatal(err)
	}
	in, res := strings.Split(string(b), "\n"), strings.Split(out, "\n")
	if len(in) != len(res) {
		t.Fatalf("line count %d -> %d:\n%s", len(in), len(res), out)
	}
	var changed []string
	for i := range in {
		if in[i] != res[i] {
			changed = append(changed, in[i]+" -> "+res[i])
		}
	}
	want := []string{"power = false -> power = true", "manage = false -> manage = true", "diagnose = true -> diagnose = false"}
	if !reflect.DeepEqual(changed, want) {
		t.Fatalf("changed lines %q", changed)
	}
	if !strings.Contains(out, "whombat-agent allow manage") {
		t.Error("the template does not mention whombat-agent allow")
	}
	// Setting what is already set changes nothing.
	if again, _ := SetRemoteControl(out, map[string]bool{"manage": true}); again != out {
		t.Error("a second allow changed the file")
	}
}

func TestSetRemoteControlEdits(t *testing.T) {
	cases := []struct {
		name, in string
		set      map[string]bool
		want     string
	}{
		{"comment and indent kept",
			"hub = \"wss://a:8443\"\n\n[remote_control]\n  console = false   # consoles\npower=true\n\n[update]\nallow = false\n",
			map[string]bool{"console": true},
			"hub = \"wss://a:8443\"\n\n[remote_control]\n  console = true   # consoles\npower=true\n\n[update]\nallow = false\n"},
		{"missing key after the table's last key",
			"[remote_control]\nconsole = true\n# a note\n\n[collectors]\ndocker = true\n",
			map[string]bool{"manage": true, "host_power": false},
			"[remote_control]\nconsole = true\nhost_power = false\nmanage = true\n# a note\n\n[collectors]\ndocker = true\n"},
		{"commented-out key",
			"[remote_control]\n# manage = true\nconsole = true\n",
			map[string]bool{"manage": true},
			"[remote_control]\nmanage = true\nconsole = true\n"},
		{"no table",
			"hub = \"wss://a:8443\"\n\n[update]\nallow = true\n\n",
			map[string]bool{"manage": true},
			"hub = \"wss://a:8443\"\n\n[update]\nallow = true\n\n[remote_control]\nmanage = true\n"},
		{"keys of other tables untouched",
			"[collectors]\nmanage = false\n[remote_control]\npower = false\n",
			map[string]bool{"manage": true, "power": true},
			"[collectors]\nmanage = false\n[remote_control]\npower = true\nmanage = true\n"},
	}
	for _, tc := range cases {
		got, err := SetRemoteControl(tc.in, tc.set)
		if err != nil || got != tc.want {
			t.Errorf("%s: %v\n got %q\nwant %q", tc.name, err, got, tc.want)
		}
	}
	for name, in := range map[string]string{
		"dotted":  "remote_control.console = true\n",
		"inline":  "remote_control = { console = true }\n",
		"twice":   "[remote_control]\nconsole = true\n[remote_control]\npower = true\n",
		"invalid": "[remote_control]\nconsole = false\n[update]\nallow = yes\n",
	} {
		if _, err := SetRemoteControl(in, map[string]bool{"console": true, "manage": true}); err == nil || !strings.Contains(err.Error(), "by hand") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestUpdateRemoteControl(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFileName)
	if err := os.WriteFile(path, []byte("hub = \"wss://a:8443\"\n[remote_control]\nconsole = true\n"), 0o640); err != nil || os.Chmod(path, 0o640) != nil {
		t.Fatal(err)
	}
	cfg, err := UpdateRemoteControl(dir, map[string]bool{"manage": true, "console": false})
	if err != nil {
		t.Fatal(err)
	}
	if sw := cfg.Switches(); !sw["manage"] || sw["console"] || !sw["diagnose"] || sw["power"] {
		t.Errorf("switches %v", sw)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", st.Mode())
	}
	if _, err := UpdateRemoteControl(t.TempDir(), map[string]bool{"manage": true}); !os.IsNotExist(err) {
		t.Errorf("missing agent.toml: %v", err)
	}
}

func TestFindAgents(t *testing.T) {
	proc := t.TempDir()
	write := func(pid string, argv ...string) {
		if err := os.MkdirAll(filepath.Join(proc, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(proc, pid, "cmdline"), []byte(strings.Join(argv, "\x00")+"\x00"), 0o644)
	}
	write("101", "/usr/local/bin/whombat-agent", "run", "--config-dir", "/etc/whombat-agent")
	write("102", "/usr/local/bin/whombat-agent", "supervise", "--config-dir", "/boot/config/plugins/whombat-agent", "--pid-file", "/run/whombat-agent.pid")
	write("103", "/usr/local/bin/whombat-agent", "run", "--config-dir", "/boot/config/plugins/whombat-agent")
	write("104", "/usr/local/bin/whombat-agent", "run") // the default directory
	write("105", "/usr/local/bin/rackoon-agent", "run", "--config-dir", "/etc/whombat-agent")
	write("106", "/usr/local/bin/whombat-agent", "allow", "manage")
	write("107", "/usr/local/bin/whombat-agent", "run", "--config-dir=/etc/whombat-agent/")
	write("self", "x")
	got := FindAgents(proc, DefaultConfigDir, 107)
	if !reflect.DeepEqual(got, []AgentProcess{{PID: 101}, {PID: 104}}) {
		t.Errorf("default dir: %+v", got)
	}
	got = FindAgents(proc, "/boot/config/plugins/whombat-agent", 0)
	if !reflect.DeepEqual(got, []AgentProcess{{PID: 102, Supervisor: true}, {PID: 103}}) {
		t.Errorf("unraid: %+v", got)
	}
	if got := FindAgents(proc, "/tmp/elsewhere", 0); len(got) != 0 {
		t.Errorf("other dir: %+v", got)
	}
}

func TestResolveConfigDir(t *testing.T) {
	// On the test machine neither directory is enrolled: the default.
	if _, err := os.Stat(filepath.Join(DefaultConfigDir, ConfigFileName)); err == nil {
		t.Skip("this machine has an enrolled agent")
	}
	if _, err := os.Stat(filepath.Join(UnraidConfigDir, ConfigFileName)); err == nil {
		t.Skip("this machine is Unraid")
	}
	if d := ResolveConfigDir(); d != DefaultConfigDir {
		t.Errorf("dir = %s", d)
	}
}
