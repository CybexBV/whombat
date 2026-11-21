package recovery

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/knowngood"
)

func storeManager(t *testing.T, store, name, script string) string {
	t.Helper()
	p := filepath.Join(store, name)
	os.MkdirAll(filepath.Join(p, "bin"), 0o755)
	if err := os.WriteFile(filepath.Join(p, knowngood.Binary), []byte(script), 0o555); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLaunchPrefersKnownGoodFromHelper(t *testing.T) {
	store := t.TempDir()
	good := storeManager(t, store, "aaaa-whombat-manager-1.0", "#!/bin/sh\n")
	src := func(context.Context) ([]string, error) { return []string{good}, nil }
	var got []string
	builtin := false
	err := Launch(src, store, "/etc/whombat/manager.json", func(p string, argv, env []string) error { got = argv; return nil }, func() error { builtin = true; return nil })
	if err != nil || builtin || got[0] != filepath.Join(good, knowngood.Binary) || strings.Join(got[1:], " ") != "--config /etc/whombat/manager.json --recovery" {
		t.Fatalf("%v %v %v", err, builtin, got)
	}
	// Exec failure falls back to the built-in recovery.
	Launch(src, store, "c", func(string, []string, []string) error { return errors.New("exec format error") }, func() error { builtin = true; return nil })
	if !builtin {
		t.Fatal("no fallback")
	}
	// Helper unavailable or no record: built-in.
	for _, s := range []Source{nil, func(context.Context) ([]string, error) { return nil, errors.New("helper unavailable") }} {
		builtin = false
		Launch(s, store, "c", nil, func() error { builtin = true; return nil })
		if !builtin {
			t.Fatal("no fallback without a known-good manager")
		}
	}
}

// fakeHelper answers known-good-manager on a unix socket like the update helper.
func fakeHelper(t *testing.T, paths []string) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "helper.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadBytes('\n')
			var req proto.Request
			json.Unmarshal(line, &req)
			resp := proto.Response{V: proto.Version, OK: req.Op == proto.OpKnownGoodManager, Result: &proto.Result{StorePaths: paths}}
			b, _ := json.Marshal(resp)
			c.Write(append(b, '\n'))
			c.Close()
		}
	}()
	return sock
}

// End to end with real processes: the launcher asks the helper, verifies the store path and execs its
// manager. A binary planted in manager-writable state (the reviewer's M-3 PoC: a self-consistent
// known-good copy under /persist) is never executed.
func TestRecoveryLauncherRealExec(t *testing.T) {
	d := t.TempDir()
	launcher := filepath.Join(d, "whombat-manager-recovery")
	build := exec.Command("go", "build", "-o", launcher, "github.com/CybexBV/whombat/appliance/manager/cmd/whombat-manager-recovery")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	store := filepath.Join(d, "store")
	marker := filepath.Join(d, "ran")
	good := storeManager(t, store, "aaaa-whombat-manager-1.0", "#!/bin/sh\necho \"$@\" > "+marker+"\n")
	cmd := exec.Command(launcher, "--config", filepath.Join(d, "missing.json"), "--helper-socket", fakeHelper(t, []string{good}), "--store-dir", store)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v %s", err, out)
	}
	b, _ := os.ReadFile(marker)
	if strings.TrimSpace(string(b)) != "--config "+filepath.Join(d, "missing.json")+" --recovery" {
		t.Fatalf("known-good ran with %q", b)
	}
	// The manager uid controls /persist/manager/known-good: a planted binary there is not executed even
	// if the helper were tricked into naming it.
	os.Remove(marker)
	planted := filepath.Join(d, "persist", "manager", "known-good", "current")
	os.MkdirAll(filepath.Join(planted, "bin"), 0o755)
	os.WriteFile(filepath.Join(planted, knowngood.Binary), []byte("#!/bin/sh\necho pwned > "+marker+"\n"), 0o755)
	out, _ := exec.Command(launcher, "--config", filepath.Join(d, "missing.json"), "--helper-socket", fakeHelper(t, []string{planted}), "--store-dir", store).CombinedOutput()
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("planted binary was executed")
	}
	if !strings.Contains(string(out), "built-in recovery manager") {
		t.Fatalf("expected built-in fallback, got %s", out)
	}
}
