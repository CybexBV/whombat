package systemdrun

import (
	"context"
	"os/exec"
	"regexp"
	"slices"
	"testing"
	"time"
)

const loop = `for f in a b; do echo "[${f}] $$ $HOME"; done`

func TestLiteralDoublesEveryDollar(t *testing.T) {
	got := Literal("/bin/sh", "-c", loop, "$1", "plain")
	want := []string{"/bin/sh", "-c", `for f in a b; do echo "[$${f}] $$$$ $$HOME"; done`, "$$1", "plain"}
	if !slices.Equal(got, want) {
		t.Fatalf("Literal = %q, want %q", got, want)
	}
}

// TestLiteralThroughSystemd runs the loop in a real transient service of the
// user's own systemd, where there is one (a developer's machine); elsewhere it
// skips.
func TestLiteralThroughSystemd(t *testing.T) {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("no systemd-run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	argv := append([]string{"--user", "--quiet", "--wait", "--collect", "--pipe", "--service-type=exec", "--"},
		Literal("/bin/sh", "-c", loop)...)
	out, err := exec.CommandContext(ctx, "systemd-run", argv...).CombinedOutput()
	if err != nil {
		t.Skipf("no user systemd to run a transient service: %v: %s", err, out)
	}
	if !regexp.MustCompile(`^\[a\] \d+ /\S*\n\[b\] \d+ /\S*\n$`).Match(out) {
		t.Fatalf("the command lost its words: %q", out)
	}
}
