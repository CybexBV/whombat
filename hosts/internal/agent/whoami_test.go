package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A pre-approved enrollment (Whombat SI-07) gets its certificate on the
// first poll and never says it waits; an ordinary one says so once.
func TestEnrollPreApprovedAndPending(t *testing.T) {
	for _, pre := range []bool{true, false} {
		h := newFakeHub(t)
		h.preApprove = pre
		var pending []string
		dir := t.TempDir()
		_, err := Enroll(context.Background(), EnrollOptions{Hub: h.wsURL(), CASHA256: h.pin, Token: "tok-123", ConfigDir: dir,
			StateDir: dir + "/state", PollInterval: 10 * time.Millisecond, Timeout: 10 * time.Second,
			OnPending: func(id string) { pending = append(pending, id) }})
		if err != nil {
			t.Fatal(err)
		}
		h.mu.Lock()
		polls := h.enrollments["en_1"].polls
		h.mu.Unlock()
		if pre && (len(pending) != 0 || polls != 1) || !pre && (len(pending) != 1 || pending[0] != "en_1" || polls != 2) {
			t.Fatalf("pre-approved %v: pending %v, %d polls", pre, pending, polls)
		}
	}
}

func TestWhoamiAndCheckIdentity(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	id, pin, err := Whoami(cfg.Dir)
	if err != nil || id != "testhost" || pin != h.pin {
		t.Fatalf("whoami = %q %q %v", id, pin, err)
	}
	ctx := context.Background()
	if st, err := CheckIdentity(ctx, cfg.Dir, ""); st != IdentityKnown {
		t.Fatalf("known: %q %v", st, err)
	}
	h.revoked.Store(true)
	if st, err := CheckIdentity(ctx, cfg.Dir, h.wsURL()); st != IdentityRemoved {
		t.Fatalf("removed: %q %v", st, err)
	}
	h.revoked.Store(false)
	h.refuse.Store(true)
	if st, _ := CheckIdentity(ctx, cfg.Dir, ""); st != IdentityUnreachable {
		t.Fatalf("503: %q", st)
	}
	if st, _ := CheckIdentity(ctx, cfg.Dir, "wss://127.0.0.1:1"); st != IdentityUnreachable {
		t.Fatalf("nobody there: %q", st)
	}
	if _, _, err := Whoami(t.TempDir()); err == nil {
		t.Fatal("whoami without an identity")
	}
}

// policy set: exactly the level's switches, raising and lowering.
func TestSetControlLevel(t *testing.T) {
	dir := t.TempDir()
	if err := WriteInitialConfig(&Config{Dir: dir, Hub: "wss://10.100.1.5:8443", CASHA256: "ab", StateDir: DefaultStateDir}); err != nil {
		t.Fatal(err)
	}
	want := map[string]map[string]bool{
		"full":    {"console": true, "power": true, "host_shell": true, "host_power": true, "manage": true, "diagnose": true},
		"watch":   {"console": false, "power": false, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
		"operate": {"console": true, "power": true, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
	}
	for _, level := range []string{"full", "watch", "full", "operate", "watch"} {
		cfg, err := SetControlLevel(dir, level)
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range want[level] {
			if cfg.Switches()[k] != v {
				t.Fatalf("%s: %s = %v", level, k, cfg.Switches()[k])
			}
		}
	}
	// diagnose = false set by hand is turned back on: a level is exact.
	if _, err := UpdateRemoteControl(dir, map[string]bool{"diagnose": false}); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := SetControlLevel(dir, "watch"); !cfg.DiagnoseAllowed() {
		t.Fatal("watch left diagnose off")
	}
	if _, err := SetControlLevel(dir, "root"); err == nil || !strings.Contains(err.Error(), "watch, operate, full") {
		t.Fatalf("bad level: %v", err)
	}
}

func TestSetHub(t *testing.T) {
	dir := t.TempDir()
	if err := WriteInitialConfig(&Config{Dir: dir, Hub: "wss://10.100.1.5:8443", CASHA256: "ab", StateDir: DefaultStateDir}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ConfigFileName)
	before, _ := os.ReadFile(path)
	if changed, err := UpdateHub(dir, "wss://10.100.1.5:8443/"); err != nil || changed {
		t.Fatalf("same hub: %v %v", changed, err)
	}
	if changed, err := UpdateHub(dir, "wss://10.100.1.9:8443"); err != nil || !changed {
		t.Fatalf("new hub: %v %v", changed, err)
	}
	after, _ := os.ReadFile(path)
	in, out := strings.Split(string(before), "\n"), strings.Split(string(after), "\n")
	var diff []string
	for i := range in {
		if in[i] != out[i] {
			diff = append(diff, out[i])
		}
	}
	if len(in) != len(out) || len(diff) != 1 || diff[0] != `hub = "wss://10.100.1.9:8443"` {
		t.Fatalf("changed lines %q", diff)
	}
	if cfg, err := LoadConfig(dir); err != nil || cfg.Hub != "wss://10.100.1.9:8443" || cfg.CASHA256 != "ab" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	// No hub line: added before the first table, with a comment kept.
	got, err := SetHub("# mine\nca_sha256 = 'ab'\n\n[remote_control]\nconsole = true\n", "wss://h:8443")
	if err != nil || got != "# mine\nca_sha256 = 'ab'\n\nhub = \"wss://h:8443\"\n[remote_control]\nconsole = true\n" {
		t.Fatalf("added: %q %v", got, err)
	}
	if got, err := SetHub("hub = 'wss://a:1' # the box\n", "wss://b:2"); err != nil || got != "hub = \"wss://b:2\" # the box\n" {
		t.Fatalf("comment: %q %v", got, err)
	}
	if _, err := SetHub("hub = 'wss://a:1'\n", "http://b:2"); err == nil {
		t.Fatal("plain http accepted")
	}
}
