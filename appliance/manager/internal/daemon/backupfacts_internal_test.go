package daemon

import (
	"testing"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// A status read again a minute later (older age, a new updatedAt) is the same to the runtime; a new backup, a running
// one or a new generation isn't, and no status at all is a value of its own.
func TestBackupKeyIgnoresAgeOnly(t *testing.T) {
	st := func(id string, age int64, at string) *local.BackupServiceStatus {
		return &local.BackupServiceStatus{Kind: "whombat.backup-status/1", State: "protected", Protected: true,
			LastSuccess: &local.BackupServiceStatusLastSuccess{ID: id, AgeSeconds: age}, KitGeneration: 1, UpdatedAt: at}
	}
	a := st("ck-1", 10, "2026-11-04T11:00:00Z")
	b := st("ck-1", 70, "2026-11-04T11:01:00Z")
	if backupKey(a) != backupKey(b) {
		t.Fatalf("age only:\n%s\n%s", backupKey(a), backupKey(b))
	}
	if a.LastSuccess.AgeSeconds != 10 || a.UpdatedAt == "" {
		t.Fatalf("backupKey changed its argument: %+v", a)
	}
	running := st("ck-1", 10, "2026-11-04T11:00:00Z")
	running.Running = &local.BackupServiceStatusRunning{ID: "ck-2", Op: "checkpoint", Stage: "upload"}
	gen := st("ck-1", 10, "2026-11-04T11:00:00Z")
	gen.KitGeneration = 2
	for name, other := range map[string]*local.BackupServiceStatus{"new backup": st("ck-2", 0, "2026-11-04T11:00:00Z"),
		"running": running, "generation": gen, "none": nil} {
		if backupKey(other) == backupKey(a) {
			t.Errorf("%s: same key as before", name)
		}
	}
}
