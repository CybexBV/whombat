package broker

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

// pvesm and ha-manager leave the agent's sandbox through systemd-run (they
// write outside /etc/pve); pveum and anything outside a unit run directly.
func TestPVEHostArgv(t *testing.T) {
	d := &pveDriver{inSystemd: true}
	got := d.hostArgv([]string{"pvesm", "free", "local:iso/x.iso"})
	if got[0] != "/usr/bin/systemd-run" || !strings.HasSuffix(got[len(got)-3], "pvesm") || got[len(got)-1] != "local:iso/x.iso" || !slices.Contains(got, "--pipe") {
		t.Fatalf("pvesm: %q", got)
	}
	if got := d.hostArgv([]string{"pvesh", "create", "/cluster/backup", "--id=backup-1"}); got[0] != "/usr/bin/systemd-run" || got[len(got)-1] != "--id=backup-1" {
		t.Fatalf("pvesh: %q", got)
	}
	if got := d.hostArgv([]string{"pveum", "role", "list"}); got[0] != "pveum" {
		t.Fatalf("pveum: %q", got)
	}
	d.inSystemd = false
	if got := d.hostArgv([]string{"ha-manager", "remove", "vm:100"}); got[0] != "ha-manager" {
		t.Fatalf("outside systemd: %q", got)
	}
}

// A failed command's error is its first error line; the rest is kept for
// pvesh's parameter errors.
func TestRunCommandError(t *testing.T) {
	_, err := runCommand(t.Context(), "sh", "-c", "echo '400 Parameter verification failed.' >&2; echo 'schedule: bad' >&2; exit 255")
	var ce *cmdError
	if !errors.As(err, &ce) || err.Error() != "sh: 400 Parameter verification failed." || !strings.Contains(ce.stderr, "schedule: bad") {
		t.Fatalf("err = %v (%#v)", err, err)
	}
}
