package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// `whombat-agent allow <switch>…`, `deny <switch>…` and `policy` (PX-04):
// change [remote_control] in agent.toml and make the running agent read it
// again, or show the switches.

// policyArgs splits the arguments into switches and --config-dir (before
// or after them).
func policyArgs(cmd string, args []string) (dir string, explicit bool, switches []string, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h" || a == "--help" || a == "-help":
			return "", false, nil, errHelp
		case a == "--config-dir" || a == "-config-dir":
			if i+1 >= len(args) {
				return "", false, nil, errors.New(a + " needs a directory")
			}
			dir, explicit = args[i+1], true
			i++
		case strings.HasPrefix(a, "--config-dir=") || strings.HasPrefix(a, "-config-dir="):
			_, dir, _ = strings.Cut(a, "=")
			explicit = true
		case strings.HasPrefix(a, "-"):
			return "", false, nil, fmt.Errorf("%s: unknown option %s", cmd, a)
		default:
			switches = append(switches, a)
		}
	}
	if !explicit {
		dir = agent.ResolveConfigDir()
	}
	return dir, explicit, switches, nil
}

var errHelp = errors.New("help")

func policyUsage(w io.Writer) {
	fmt.Fprintf(w, `Usage:
  whombat-agent allow SWITCH... [--config-dir DIR]
  whombat-agent deny SWITCH... [--config-dir DIR]
  whombat-agent policy [--config-dir DIR]
  whombat-agent policy set LEVEL [--config-dir DIR] [--no-reload]

Switches: %s.
Levels: watch (read-only checks), operate (also consoles and guest power), full (every switch).
allow, deny and policy set change [remote_control] in agent.toml and reload the agent (run them as root).
`, strings.Join(agent.RemoteSwitches, ", ")+", all")
}

// levelTitles are the levels as Whombat names them (SI-06).
var levelTitles = map[string]string{
	proto.ControlWatch: "Watch only", proto.ControlOperate: "Restart and consoles", proto.ControlFull: "Full control",
}

// setLevel is `policy set LEVEL`: exactly the level's switches (install.sh
// --control), then a reload unless noReload (the installer restarts the
// agent itself).
func setLevel(dir string, explicit bool, level string, noReload bool) error {
	if _, ok := proto.ControlSwitches(level); !ok {
		return fmt.Errorf("%q is not a level; the levels are %s", level, strings.Join(proto.ControlLevels, ", "))
	}
	if !explicit && !isRoot() {
		return fmt.Errorf("this changes the agent's own settings, so run it as %s", asRoot("whombat-agent policy set "+level))
	}
	if _, err := agent.LoadConfig(dir); err != nil {
		return notEnrolled(dir, err)
	}
	cfg, err := agent.SetControlLevel(dir, level)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot change %s: run this as %s", filepath.Join(dir, agent.ConfigFileName), asRoot("whombat-agent policy set "+level))
		}
		return err
	}
	applied := true
	if !noReload {
		if applied, err = reloadAgent(dir); err != nil {
			return fmt.Errorf("agent.toml is changed, but the agent could not be told: %v; restart it to apply the change", err)
		}
	}
	fmt.Println(levelSentence(hostName(), level, cfg.Switches(), applied))
	return nil
}

// levelSentence is the one plain sentence policy set prints.
func levelSentence(host, level string, sw map[string]bool, applied bool) string {
	var allowed []string
	for _, k := range agent.RemoteSwitches {
		if sw[k] {
			allowed = append(allowed, agent.SwitchNames[k])
		}
	}
	s := host + " is set to " + levelTitles[level] + ": it allows " + joinWords(allowed, "and")
	if !applied {
		s += "; its agent is not running, so this applies when it starts"
	}
	return s + "."
}

// cmdHub shows the hub URL in agent.toml, or points it at another one
// (install.sh, when the Whombat's address changed).
func cmdHub(args []string) error {
	noRestart := slices.Contains(args, "--no-restart")
	args = slices.DeleteFunc(slices.Clone(args), func(a string) bool { return a == "--no-restart" })
	dir, explicit, names, err := policyArgs("hub", args)
	if errors.Is(err, errHelp) {
		fmt.Println("Usage: whombat-agent hub [wss://HOST:PORT] [--config-dir DIR] [--no-restart]")
		return nil
	}
	if err != nil {
		return err
	}
	cfg, err := agent.LoadConfig(dir)
	if err != nil {
		return notEnrolled(dir, err)
	}
	switch len(names) {
	case 0:
		fmt.Println(cfg.Hub)
		return nil
	case 1:
	default:
		return errors.New("hub takes one URL, like wss://10.100.1.5:8443")
	}
	if !explicit && !isRoot() {
		return fmt.Errorf("this changes the agent's own settings, so run it as %s", asRoot("whombat-agent hub "+names[0]))
	}
	changed, err := agent.UpdateHub(dir, names[0])
	if err != nil {
		return err
	}
	ws, _ := agent.HubWSBase(names[0])
	if !changed {
		fmt.Printf("%s already reports to %s.\n", hostName(), ws)
		return nil
	}
	if !noRestart {
		restarted, err := restartAgent(dir)
		if err != nil {
			return fmt.Errorf("agent.toml is changed, but %w", err)
		}
		if restarted {
			fmt.Printf("%s now reports to %s.\n", hostName(), ws)
			return nil
		}
	}
	fmt.Printf("%s now reports to %s once its agent restarts.\n", hostName(), ws)
	return nil
}

// cmdWhoami prints "<server id> <CA SHA-256>" (install.sh's identity
// check); --check adds whether the hub still accepts this agent.
func cmdWhoami(args []string) error {
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	dir := fs.String("config-dir", "", "configuration directory")
	check := fs.Bool("check", false, "also ask the hub whether it still knows this server")
	hub := fs.String("hub", "", "hub to ask (default: agent.toml's)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dir == "" {
		*dir = agent.ResolveConfigDir()
	}
	id, pin, err := agent.Whoami(*dir)
	if err != nil {
		return notEnrolled(*dir, err)
	}
	if !*check {
		fmt.Println(id, pin)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	state, err := agent.CheckIdentity(ctx, *dir, *hub)
	if state == "" {
		return err
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-agent:", err)
	}
	fmt.Println(id, pin, state)
	return nil
}

// cmdSwitch is `allow` (on) and `deny` (off).
func cmdSwitch(name string, on bool, args []string) error {
	dir, explicit, names, err := policyArgs(name, args)
	if errors.Is(err, errHelp) {
		policyUsage(os.Stdout)
		return nil
	}
	if err != nil {
		return err
	}
	switches, err := agent.ParseSwitches(names)
	if err != nil {
		return err
	}
	// The agent's own configuration is root's (mode 0600) and so is the
	// agent; another directory's file permissions decide for themselves.
	if !explicit && !isRoot() {
		return fmt.Errorf("this changes the agent's own settings, so run it as %s", asRoot("whombat-agent "+name+" "+strings.Join(names, " ")))
	}
	before, err := agent.LoadConfig(dir)
	if err != nil {
		return notEnrolled(dir, err)
	}
	set := map[string]bool{}
	for _, s := range switches {
		set[s] = on
	}
	cfg, err := agent.UpdateRemoteControl(dir, set)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("cannot change %s: run this as %s", filepath.Join(dir, agent.ConfigFileName), asRoot("whombat-agent "+name+" "+strings.Join(names, " ")))
		}
		return err
	}
	applied, err := reloadAgent(dir)
	if err != nil {
		return fmt.Errorf("agent.toml is changed, but the agent could not be told: %v; restart it to apply the change", err)
	}
	fmt.Println(switchSentence(hostName(), before.Switches(), cfg.Switches(), switches, on, applied))
	return nil
}

// switchSentence is the one plain sentence allow and deny print.
func switchSentence(host string, before, now map[string]bool, named []string, on, applied bool) string {
	var allowed, stopped, asked []string
	for _, k := range agent.RemoteSwitches {
		if now[k] {
			allowed = append(allowed, agent.SwitchNames[k])
		}
		if slices.Contains(named, k) {
			asked = append(asked, agent.SwitchNames[k])
			if !on && before[k] {
				stopped = append(stopped, agent.SwitchNames[k])
			}
		}
	}
	var s string
	switch {
	case on:
		s = host + " now allows " + joinWords(allowed, "and")
	case len(stopped) == 0 && len(allowed) == 0:
		s = host + " did not allow " + joinWords(asked, "or") + " anyway, and allows nothing"
	case len(stopped) == 0:
		s = host + " did not allow " + joinWords(asked, "or") + " anyway, and allows " + joinWords(allowed, "and")
	case len(allowed) == 0:
		s = host + " no longer allows " + joinWords(stopped, "or") + ", and allows nothing else"
	default:
		s = host + " no longer allows " + joinWords(stopped, "or") + " and still allows " + joinWords(allowed, "and")
	}
	if !applied {
		s += "; its agent is not running, so this applies when it starts"
	}
	return s + "."
}

// joinWords is "a, b and c".
func joinWords(w []string, conj string) string {
	switch len(w) {
	case 0:
		return "nothing"
	case 1:
		return w[0]
	}
	return strings.Join(w[:len(w)-1], ", ") + " " + conj + " " + w[len(w)-1]
}

func hostName() string {
	h, _ := os.Hostname()
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	if h == "" {
		h = "This server"
	}
	return h
}

func notEnrolled(dir string, err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("there is no %s: enroll this server first, or give --config-dir", filepath.Join(dir, agent.ConfigFileName))
	}
	if errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("cannot read %s: run this as root", filepath.Join(dir, agent.ConfigFileName))
	}
	return err
}

// cmdPolicy prints the switches, or sets a control level (policy set).
func cmdPolicy(args []string) error {
	noReload := slices.Contains(args, "--no-reload")
	args = slices.DeleteFunc(slices.Clone(args), func(a string) bool { return a == "--no-reload" })
	dir, explicit, names, err := policyArgs("policy", args)
	if errors.Is(err, errHelp) {
		policyUsage(os.Stdout)
		return nil
	}
	if err != nil {
		return err
	}
	if len(names) > 0 && names[0] == "set" {
		if len(names) != 2 {
			return errors.New("policy set takes one level: " + strings.Join(proto.ControlLevels, ", "))
		}
		return setLevel(dir, explicit, names[1], noReload)
	}
	if len(names) > 0 {
		return fmt.Errorf("policy takes no switches (to change one: whombat-agent allow %s)", names[0])
	}
	cfg, err := agent.LoadConfig(dir)
	if err != nil {
		return notEnrolled(dir, err)
	}
	printPolicy(os.Stdout, hostName(), filepath.Join(dir, agent.ConfigFileName), cfg.Switches())
	return nil
}

// switchHelp says what each switch covers (whombat-agent policy).
var switchHelp = map[string]string{
	"console":    "consoles, container shells and logs, the host's process and service lists",
	"power":      "start, shut down, restart, pause and snapshot guests",
	"host_shell": "a root shell on this server",
	"host_power": "reboot and shut down this server",
	"manage":     "guest editing: settings, disks, backups and backup jobs, create and delete",
	"diagnose":   "read-only checks: logs, SMART, services",
}

func printPolicy(w io.Writer, host, path string, sw map[string]bool) {
	fmt.Fprintf(w, "What %s allows from Whombat (%s):\n", host, path)
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, k := range agent.RemoteSwitches {
		state := "off"
		if sw[k] {
			state = "on"
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", k, state, switchHelp[k])
	}
	tw.Flush()
	fmt.Fprintln(w, "Change one with: whombat-agent allow SWITCH, or whombat-agent deny SWITCH.")
}
