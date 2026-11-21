package main

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"rackoon/internal/agent"
)

func TestSwitchSentence(t *testing.T) {
	sw := func(on ...string) map[string]bool {
		m := map[string]bool{}
		for _, k := range on {
			m[k] = true
		}
		return m
	}
	cases := []struct {
		before, now map[string]bool
		named       []string
		on, applied bool
		want        string
	}{
		{sw("diagnose"), sw("power", "manage", "diagnose"), []string{"power", "manage"}, true, true,
			"pve-02 now allows power, guest editing and diagnostics."},
		{sw(), sw("manage"), []string{"manage"}, true, false,
			"pve-02 now allows guest editing; its agent is not running, so this applies when it starts."},
		{sw("power", "manage"), sw("power"), []string{"manage"}, false, true,
			"pve-02 no longer allows guest editing and still allows power."},
		{sw("power", "manage"), sw(), []string{"power", "manage"}, false, true,
			"pve-02 no longer allows power or guest editing, and allows nothing else."},
		{sw("diagnose"), sw("diagnose"), []string{"console"}, false, true,
			"pve-02 did not allow consoles anyway, and allows diagnostics."},
	}
	for _, tc := range cases {
		if got := switchSentence("pve-02", tc.before, tc.now, tc.named, tc.on, tc.applied); got != tc.want {
			t.Errorf("got  %q\nwant %q", got, tc.want)
		}
	}
}

func TestPolicyArgs(t *testing.T) {
	dir, explicit, sw, err := policyArgs("allow", []string{"manage", "--config-dir", "/tmp/a", "power"})
	if err != nil || dir != "/tmp/a" || !explicit || !reflect.DeepEqual(sw, []string{"manage", "power"}) {
		t.Fatalf("%q %v %q %v", dir, explicit, sw, err)
	}
	if dir, _, _, _ := policyArgs("allow", []string{"--config-dir=/tmp/b", "all"}); dir != "/tmp/b" {
		t.Fatalf("dir %q", dir)
	}
	if _, _, _, err := policyArgs("allow", []string{"--force", "manage"}); err == nil || !strings.Contains(err.Error(), "unknown option --force") {
		t.Fatalf("unknown option: %v", err)
	}
	if _, _, _, err := policyArgs("allow", []string{"--config-dir"}); err == nil {
		t.Fatal("--config-dir without a directory")
	}
}

func TestPrintPolicy(t *testing.T) {
	var b bytes.Buffer
	printPolicy(&b, "pve-02", "/etc/whombat-agent/agent.toml", map[string]bool{"manage": true, "diagnose": true})
	out := b.String()
	for _, want := range []string{"What pve-02 allows from Whombat (/etc/whombat-agent/agent.toml):", "  manage      on   guest editing: settings",
		"  console     off  consoles,", "whombat-agent allow SWITCH"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

func TestLevelSentence(t *testing.T) {
	if got := levelSentence("pve-03", "operate", map[string]bool{"console": true, "power": true, "diagnose": true}, true); got !=
		"pve-03 is set to Restart and consoles: it allows consoles, power and diagnostics." {
		t.Errorf("got %q", got)
	}
	if got := levelSentence("pve-03", "watch", map[string]bool{"diagnose": true}, false); got !=
		"pve-03 is set to Watch only: it allows diagnostics; its agent is not running, so this applies when it starts." {
		t.Errorf("got %q", got)
	}
}

// policy set and hub as install.sh runs them (--config-dir, no reload).
func TestPolicySetAndHub(t *testing.T) {
	dir := t.TempDir()
	if err := agent.WriteInitialConfig(&agent.Config{Dir: dir, Hub: "wss://10.100.1.5:8443", CASHA256: "ab", StateDir: agent.DefaultStateDir}); err != nil {
		t.Fatal(err)
	}
	for level, on := range map[string]int{"full": 6, "watch": 1, "operate": 3} {
		if err := cmdPolicy([]string{"set", level, "--config-dir", dir, "--no-reload"}); err != nil {
			t.Fatal(err)
		}
		cfg, _ := agent.LoadConfig(dir)
		n := 0
		for _, v := range cfg.Switches() {
			if v {
				n++
			}
		}
		if n != on {
			t.Fatalf("%s: %v", level, cfg.Switches())
		}
	}
	for _, args := range [][]string{{"set"}, {"set", "root"}, {"set", "full", "watch"}} {
		if err := cmdPolicy(append(args, "--config-dir", dir)); err == nil {
			t.Errorf("policy %v accepted", args)
		}
	}
	if err := cmdHub([]string{"wss://10.100.1.9:8443", "--config-dir", dir, "--no-restart"}); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := agent.LoadConfig(dir); cfg.Hub != "wss://10.100.1.9:8443" {
		t.Fatalf("hub = %q", cfg.Hub)
	}
	if err := cmdHub([]string{"http://10.100.1.9:8443", "--config-dir", dir}); err == nil {
		t.Fatal("plain http accepted")
	}
	if err := cmdWhoami([]string{"--config-dir", dir}); err == nil || !strings.Contains(err.Error(), "enroll this server first") {
		t.Fatalf("whoami without identity: %v", err)
	}
}
