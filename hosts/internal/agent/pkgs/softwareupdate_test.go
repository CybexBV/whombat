package pkgs

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent/macos"
)

func TestPlanSoftwareUpdate(t *testing.T) {
	steps, err := Plan(SoftwareUpdate, OpCheck, nil, Host{})
	if err != nil || len(steps) != 1 || steps[0].Kind != StepRefresh || !slices.Equal(steps[0].Argv, []string{macos.SoftwareUpdate, "--list"}) {
		t.Fatalf("check: %+v %v", steps, err)
	}
	steps, _ = Plan(SoftwareUpdate, OpInstall, nil, Host{})
	if len(steps) != 1 || !slices.Equal(steps[0].Argv, []string{macos.SoftwareUpdate, "--install", "--all"}) || steps[0].Stdin != nil {
		t.Errorf("install all: %+v", steps)
	}
	// Apple silicon with the screen account: its name in argv, its
	// password on stdin only.
	h := Host{AppleSilicon: true, ScreenUser: "jdoe", ScreenPassword: "s3cret pass"}
	steps, _ = Plan(SoftwareUpdate, OpInstall, []string{"macOS Tahoe 26.2-25C56"}, h)
	want := []string{macos.SoftwareUpdate, "--install", "macOS Tahoe 26.2-25C56", "--user", "jdoe", "--stdinpass"}
	if len(steps) != 1 || !slices.Equal(steps[0].Argv, want) || string(steps[0].Stdin) != "s3cret pass\n" {
		t.Errorf("install named: %+v", steps)
	}
	if slices.ContainsFunc(steps[0].Argv, func(a string) bool { return strings.Contains(a, "s3cret") }) {
		t.Error("the password is in argv")
	}
	// Intel Macs don't take --user / --stdinpass.
	steps, _ = Plan(SoftwareUpdate, OpInstall, nil, Host{ScreenUser: "jdoe", ScreenPassword: "x"})
	if slices.Contains(steps[0].Argv, "--stdinpass") {
		t.Error("intel: no --stdinpass")
	}
	for _, bad := range []string{"--all", "-R", "a;b", `x"y`} {
		if _, err := Plan(SoftwareUpdate, OpInstall, []string{bad}, h); err == nil {
			t.Errorf("label %q accepted", bad)
		}
	}
}

func TestReadScreenAccount(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ScreenFile)
	if _, _, err := ReadScreenAccount(dir); !os.IsNotExist(err) {
		t.Errorf("missing: %v", err)
	}
	if err := os.WriteFile(p, []byte("user = \"jdoe\"\npassword = \"pa ss\\\"word\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if u, pw, err := ReadScreenAccount(dir); err != nil || u != "jdoe" || pw != `pa ss"word` {
		t.Errorf("%q %q %v", u, pw, err)
	}
	os.Chmod(p, 0o644)
	if _, _, err := ReadScreenAccount(dir); err == nil {
		t.Error("a file others can read is refused")
	}
	os.Chmod(p, 0o600)
	os.WriteFile(p, []byte("user = \"-x\"\npassword = \"y\"\n"), 0o600)
	if _, _, err := ReadScreenAccount(dir); err == nil {
		t.Error("a bad user name is refused")
	}
}

func TestNeedsRestart(t *testing.T) {
	for out, want := range map[string]bool{
		"Downloading macOS Tahoe 26.2\nDone.\nRestart required to finish installing updates.\n":    true,
		"Installing ...\nPlease restart immediately.\n":                                            true,
		"Installing Command Line Tools for Xcode\nDone with Command Line Tools for Xcode\nDone.\n": false,
	} {
		if NeedsRestart(out) != want {
			t.Errorf("%q", out)
		}
	}
}

// A softwareupdate install: the password goes to stdin, an update that
// waits for a restart leaves the marker the collector reads.
func TestRunnerSoftwareUpdate(t *testing.T) {
	state := t.TempDir()
	dir := filepath.Join(state, "packages", "pkg-0123456789abcdef")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	spec := &TaskSpec{ID: "pkg:0123456789abcdef", Op: OpInstall, Manager: SoftwareUpdate, Started: time.Now()}
	if err := WriteSpec(dir, spec); err != nil {
		t.Fatal(err)
	}
	waiting := []string{"macOS Tahoe 26.2-25C56", "Safari26.2-26.2"}
	var stdin string
	r := &Runner{Dir: dir, Host: &Host{AppleSilicon: true, ScreenUser: "jdoe", ScreenPassword: "pw"},
		Check: func(context.Context) (*Pending, error) {
			return &Pending{Names: slices.Clone(waiting), SecKnown: true}, nil
		},
		Exec: func(context.Context, []string, io.Writer) (int, error) {
			t.Error("no step without stdin")
			return 1, nil
		},
		ExecInput: func(_ context.Context, argv []string, in []byte, w io.Writer) (int, error) {
			stdin = string(in)
			io.WriteString(w, "Downloading macOS Tahoe 26.2\nDone.\nRestart required to finish installing updates.\n")
			waiting = nil
			return 0, nil
		},
		LockHeld: func() (bool, string) { return false, "" }, LockPoll: time.Millisecond, LockWait: 20 * time.Millisecond}
	res := runTask(t, r)
	if res.Status != StatusOK || res.Installed == nil || *res.Installed != 2 || res.Warning == "" || stdin != "pw\n" {
		t.Errorf("result %+v, stdin %q", res, stdin)
	}
	if _, ok := macos.ReadRestartNeeded(state); !ok {
		t.Error("no restart marker")
	}
	log, _ := os.ReadFile(filepath.Join(dir, LogFile))
	if strings.Contains(string(log), "\npw\n") || !strings.Contains(string(log), "--user jdoe --stdinpass") {
		t.Errorf("log: %s", log)
	}
}
