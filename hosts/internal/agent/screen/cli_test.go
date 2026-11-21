package screen

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"testing"
)

// Asking for help prints the usage on stdout and is no error.
func TestCLIHelp(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, args := range [][]string{nil, {"--help"}, {"-h"}, {"help"}, {"ui"}, {"account", "--help"}, {"look", "-h"}} {
		var out bytes.Buffer
		if err := CLI(args, t.TempDir(), &out, log); err != nil {
			t.Fatalf("%q: %v", args, err)
		}
		if !strings.Contains(out.String(), "whombat-agent screen OP") || !strings.Contains(out.String(), "password") {
			t.Fatalf("%q printed %q", args, out.String())
		}
		if args != nil && args[0] == "look" && !strings.Contains(out.String(), "-max-width") {
			t.Fatalf("a step's help lacks its flags: %q", out.String())
		}
	}
	var out bytes.Buffer
	if err := CLI([]string{"paint"}, t.TempDir(), &out, log); err == nil || !strings.Contains(err.Error(), "unknown screen step") {
		t.Fatalf("an unknown step: %v", err)
	}
}
