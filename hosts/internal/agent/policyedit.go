package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"rackoon/internal/proto"
)

// `whombat-agent allow | deny | policy` (PX-04): the [remote_control]
// switches of agent.toml, changed in place, and the running agent told to
// read them again.

// RemoteSwitches are the [remote_control] keys, in agent.toml's order.
var RemoteSwitches = []string{"console", "power", "host_shell", "host_power", "manage", "diagnose"}

// SwitchNames say in plain words what a switch allows.
var SwitchNames = map[string]string{
	"console":    "consoles",
	"power":      "power",
	"host_shell": "the host shell",
	"host_power": "host power",
	"manage":     "guest editing",
	"diagnose":   "diagnostics",
}

// ParseSwitches checks the switches named on the command line ("all" is
// every switch; host-shell is host_shell) and returns them in agent.toml's
// order.
func ParseSwitches(args []string) ([]string, error) {
	if len(args) == 0 {
		return nil, errors.New("name a switch: " + switchList())
	}
	want := map[string]bool{}
	for _, a := range args {
		s := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(a)), "-", "_")
		switch {
		case s == "all":
			for _, k := range RemoteSwitches {
				want[k] = true
			}
		case slices.Contains(RemoteSwitches, s):
			want[s] = true
		default:
			return nil, fmt.Errorf("%q is not a switch; the switches are %s", a, switchList())
		}
	}
	var out []string
	for _, k := range RemoteSwitches {
		if want[k] {
			out = append(out, k)
		}
	}
	return out, nil
}

func switchList() string {
	return strings.Join(RemoteSwitches, ", ") + " and all"
}

var (
	tomlTableRe = regexp.MustCompile(`^\s*\[`)
	remoteRe    = regexp.MustCompile(`^\s*\[\s*remote_control\s*\]\s*(#.*)?$`)
	// remoteElsewhereRe: remote_control set as a dotted key or an inline
	// table, which this editor does not rewrite.
	remoteElsewhereRe = regexp.MustCompile(`^\s*remote_control\s*[.=]`)
)

// keyLineRe matches "key = value  # comment" (or a commented-out
// "# key = ...") for one key.
func keyLineRe(key string) (*regexp.Regexp, *regexp.Regexp) {
	k := regexp.QuoteMeta(key)
	return regexp.MustCompile(`^(\s*)` + k + `\s*=\s*([^#]*?)(\s*#.*)?$`),
		regexp.MustCompile(`^\s*#\s*` + k + `\s*=`)
}

// SetRemoteControl sets switches in agent.toml's text. Lines of the
// [remote_control] table are rewritten in place, so comments, order and
// the other tables stay as they are; a commented-out "# key = ..." line
// takes the value, and a missing key is added after the table's last
// key (the table itself at the end when the file has none). The result
// must parse, with the switches as asked.
func SetRemoteControl(text string, set map[string]bool) (string, error) {
	lines := strings.Split(text, "\n")
	start, end := -1, len(lines)
	inTable := false
	for i, l := range lines {
		switch {
		case remoteRe.MatchString(l):
			if start >= 0 {
				return "", errors.New("agent.toml has [remote_control] twice; fix it by hand")
			}
			start, inTable = i, true
		case tomlTableRe.MatchString(l):
			if inTable {
				end, inTable = i, false
			}
		case start < 0 && remoteElsewhereRe.MatchString(l):
			return "", errors.New("agent.toml sets remote_control in a form this command does not edit; change it by hand")
		}
	}
	if start < 0 {
		// No table: add one at the end.
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
		lines = append(lines, "", "[remote_control]")
		start, end = len(lines)-1, len(lines)
	}
	for _, key := range RemoteSwitches {
		v, ok := set[key]
		if !ok {
			continue
		}
		val := strconv.FormatBool(v)
		active, commented := keyLineRe(key)
		done := false
		for i := start + 1; i < end; i++ {
			if m := active.FindStringSubmatch(lines[i]); m != nil {
				lines[i] = m[1] + key + " = " + val + m[3]
				done = true
			}
		}
		for i := start + 1; i < end && !done; i++ {
			if commented.MatchString(lines[i]) {
				lines[i] = key + " = " + val
				done = true
			}
		}
		if done {
			continue
		}
		// After the table's last key line (or its header).
		at := start
		for i := start + 1; i < end; i++ {
			if t := strings.TrimSpace(lines[i]); t != "" && !strings.HasPrefix(t, "#") {
				at = i
			}
		}
		lines = slices.Insert(lines, at+1, key+" = "+val)
		end++
	}
	out := strings.Join(lines, "\n")
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	var check struct {
		RemoteControl map[string]any `toml:"remote_control"`
	}
	if err := toml.Unmarshal([]byte(out), &check); err != nil {
		return "", fmt.Errorf("agent.toml would not be valid after the change (%v); fix it by hand", err)
	}
	for key, v := range set {
		if got, ok := check.RemoteControl[key].(bool); !ok || got != v {
			return "", fmt.Errorf("agent.toml sets %s in a way this command does not edit; change it by hand", key)
		}
	}
	return out, nil
}

// UpdateRemoteControl sets switches in dir/agent.toml (written atomically,
// mode kept) and returns the configuration as it is now.
func UpdateRemoteControl(dir string, set map[string]bool) (*Config, error) {
	path := filepath.Join(dir, ConfigFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	text, err := SetRemoteControl(string(b), set)
	if err != nil {
		return nil, err
	}
	if text != string(b) {
		if err := WriteFileAtomic(path, []byte(text), st.Mode().Perm()); err != nil {
			return nil, err
		}
	}
	return LoadConfig(dir)
}

// Switches returns the configuration's switches by key.
func (c *Config) Switches() map[string]bool {
	rc := c.RemoteControl
	return map[string]bool{"console": rc.Console, "power": rc.Power, "host_shell": rc.HostShell, "host_power": rc.HostPower,
		"manage": rc.Manage, "diagnose": c.DiagnoseAllowed()}
}

// ResolveConfigDir is the configuration directory a command without
// --config-dir works on: /etc/whombat-agent, or the Unraid flash when the
// agent was installed there (HS-15).
func ResolveConfigDir() string {
	if _, err := os.Stat(filepath.Join(DefaultConfigDir, ConfigFileName)); err != nil {
		if _, err := os.Stat(filepath.Join(unraidConfigDir, ConfigFileName)); err == nil {
			return unraidConfigDir
		}
	}
	return DefaultConfigDir
}

// AgentProcess is a running agent: `whombat-agent run` or the supervisor
// of the SysV and Unraid scripts.
type AgentProcess struct {
	PID        int
	Supervisor bool
}

// FindAgents lists the running agents (and supervisors) that use the
// configuration directory dir, from procRoot (/proc). self is left out.
func FindAgents(procRoot, dir string, self int) []AgentProcess {
	ents, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	var out []AgentProcess
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self || pid <= 1 {
			continue
		}
		b, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "cmdline"))
		if err != nil || len(b) == 0 {
			continue
		}
		argv := strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
		if len(argv) < 2 || filepath.Base(argv[0]) != "whombat-agent" || (argv[1] != "run" && argv[1] != "supervise") {
			continue
		}
		cdir := DefaultConfigDir
		for i, a := range argv {
			switch {
			case (a == "--config-dir" || a == "-config-dir") && i+1 < len(argv):
				cdir = argv[i+1]
			case strings.HasPrefix(a, "--config-dir="):
				cdir = strings.TrimPrefix(a, "--config-dir=")
			case strings.HasPrefix(a, "-config-dir="):
				cdir = strings.TrimPrefix(a, "-config-dir=")
			}
		}
		if filepath.Clean(cdir) == filepath.Clean(dir) {
			out = append(out, AgentProcess{PID: pid, Supervisor: argv[1] == "supervise"})
		}
	}
	return out
}

// SetControlLevel sets dir/agent.toml's switches to exactly a control
// level's (Whombat SI-06: watch, operate or full; lowering works too) and
// returns the configuration as it is now.
func SetControlLevel(dir, level string) (*Config, error) {
	sw, ok := proto.ControlSwitches(level)
	if !ok {
		return nil, fmt.Errorf("%q is not a level; the levels are %s", level, strings.Join(proto.ControlLevels, ", "))
	}
	return UpdateRemoteControl(dir, sw)
}

// hubLineRe matches agent.toml's top-level hub key.
var hubLineRe = regexp.MustCompile(`^(\s*)hub\s*=\s*([^#]*?)(\s*#.*)?$`)

// SetHub points agent.toml's text at another hub URL (a Whombat whose
// address changed): the top-level hub line is rewritten in place, or added
// before the first table. The result must parse with that hub.
func SetHub(text, hub string) (string, error) {
	ws, err := HubWSBase(hub)
	if err != nil {
		return "", err
	}
	var cur struct {
		Hub string `toml:"hub"`
	}
	if toml.Unmarshal([]byte(text), &cur) == nil {
		if c, err := HubWSBase(cur.Hub); err == nil && c == ws {
			return text, nil
		}
	}
	lines := strings.Split(text, "\n")
	done := false
	first := len(lines)
	for i, l := range lines {
		if tomlTableRe.MatchString(l) {
			first = i
			break
		}
		if m := hubLineRe.FindStringSubmatch(l); m != nil {
			lines[i] = m[1] + "hub = " + strconv.Quote(ws) + m[3]
			done = true
		}
	}
	if !done {
		lines = slices.Insert(lines, first, "hub = "+strconv.Quote(ws))
	}
	out := strings.Join(lines, "\n")
	var check struct {
		Hub string `toml:"hub"`
	}
	if err := toml.Unmarshal([]byte(out), &check); err != nil || check.Hub != ws {
		return "", errors.New("agent.toml sets hub in a way this command does not edit; change it by hand")
	}
	return out, nil
}

// UpdateHub sets dir/agent.toml's hub (written atomically, mode kept). It
// reports whether the file changed.
func UpdateHub(dir, hub string) (bool, error) {
	path := filepath.Join(dir, ConfigFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	text, err := SetHub(string(b), hub)
	if err != nil {
		return false, err
	}
	if text == string(b) {
		return false, nil
	}
	return true, WriteFileAtomic(path, []byte(text), st.Mode().Perm())
}
