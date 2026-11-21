package itest

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

func checkOf(rep *restore.Report, name string) *restore.Check {
	for i := range rep.Checks {
		if rep.Checks[i].Name == name {
			return &rep.Checks[i]
		}
	}
	return nil
}

// A hosts service that can't make its backup no longer stops the backup: everything else goes up, the signed
// manifest and the status say the servers aren't in it, a check of that backup reports the servers skipped (not
// passed), and the next backup is whole again. A broken archive is a gap the same way.
func TestServersBackupFailureLeavesAGap(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	h := w.WithHosts()
	h.Failing("failed: database disk image is malformed")
	res := w.Checkpoint()
	g := res.Manifest.Incomplete
	if g == nil || !strings.Contains(g.Servers, "malformed") || res.Manifest.Hosts != nil {
		t.Fatalf("manifest: incomplete %+v hosts %+v", g, res.Manifest.Hosts)
	}
	for _, s := range res.Manifest.Sources {
		if s.Name == "hosts" {
			t.Fatal("the hosts source was uploaded without a usable archive")
		}
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if st.State != state.StateProtected || st.LastSuccess == nil || st.LastSuccess.Incomplete == nil ||
		!st.LastSuccess.Incomplete.Servers || !strings.Contains(st.LastSuccess.Incomplete.Reason, "servers") {
		t.Fatalf("status %+v %+v", st.State, st.LastSuccess)
	}
	// People read why in their words; the hosts service's own error stays in the manifest (and the log).
	if r := st.LastSuccess.Incomplete.Reason; strings.Contains(r, "malformed") || !strings.Contains(r, "couldn’t make its copy") {
		t.Fatalf("the status's reason: %q", r)
	}
	if err := st.Validate(); err != nil {
		t.Fatalf("contract: %v", err)
	}
	rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_g", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill %v %v", err, rep.Failed())
	}
	if c := checkOf(rep, "hosts"); c == nil || !c.Skipped {
		t.Fatalf("hosts check %+v: the missing servers must be reported, not passed", c)
	}
	h.Failing("")
	whole := w.Checkpoint()
	if whole.Manifest.Incomplete != nil || whole.Manifest.Hosts == nil {
		t.Fatalf("the next backup: %+v", whole.Manifest.Incomplete)
	}
	if st, _ := state.CurrentStatus(w.Cfg); st.LastSuccess.Incomplete != nil {
		t.Fatalf("status still says incomplete: %+v", st.LastSuccess.Incomplete)
	}
	// An archive that isn't one (truncated by a full disk) is left out the same way.
	if err := os.WriteFile(filepath.Join(h.Dir, coverage.HostsBackupFile), []byte("not a hub backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.Failing("ok") // answers ok without writing a new one
	broken := w.Checkpoint()
	if g := broken.Manifest.Incomplete; g == nil || !strings.Contains(g.Servers, "unusable") {
		t.Fatalf("a broken archive: %+v", g)
	}
}

// The hosts service writes an uncompressed hub.tar now (restic deduplicates it between checkpoints): the checkpoint
// carries it under its own name, leaves a stale hub.tar.gz from before out, and a check reads it to its end.
func TestServersAsAnUncompressedArchive(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	h := w.WithHosts()
	old := filepath.Join(h.Dir, coverage.HostsBackupFile)
	WriteFile(t, old, string(HubBackup("from the hosts service before")))
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	h.WritesTar()
	res := w.Checkpoint()
	if res.Manifest.Hosts == nil || res.Manifest.Hosts.Backup.Path != manifest.HostsBackupTarPath || res.Manifest.Incomplete != nil {
		t.Fatalf("hosts %+v incomplete %+v", res.Manifest.Hosts, res.Manifest.Incomplete)
	}
	tarBytes, _ := h.Last()
	if res.Manifest.Hosts.Backup.SHA256 != sha256hex(string(tarBytes)) {
		t.Fatal("the manifest names another archive than the one just written")
	}
	staleOut := false
	for _, s := range res.Manifest.Sources {
		for _, x := range s.Excluded {
			staleOut = staleOut || x == "files/hosts/"+coverage.HostsBackupFile
		}
	}
	if !staleOut {
		t.Fatalf("the stale %s went up with it: %+v", coverage.HostsBackupFile, res.Manifest.Sources)
	}
	rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_g", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill %v %v", err, rep.Failed())
	}
	if c := checkOf(rep, "hosts"); c == nil || !c.OK {
		t.Fatalf("hosts check %+v", c)
	}
	// A restore hands the hosts service the plain tar under its own staged name, never the stale hub.tar.gz.
	cfg, marker := applyOnFreshBox(t, w, res.Manifest.ID, true)
	staged, err := os.ReadFile(filepath.Join(cfg.Layout().HostsData(), coverage.HostsStagedTarFile))
	if err != nil || !bytes.Equal(staged, tarBytes) || marker.Servers != quarantine.ServersStaged {
		t.Fatalf("staged %d bytes (%v), want the checkpoint's hub.tar; servers %q", len(staged), err, marker.Servers)
	}
	if _, err := os.Lstat(filepath.Join(cfg.Layout().HostsData(), coverage.HostsStagedFile)); err == nil {
		t.Fatal("a gzipped archive staged too")
	}
}

// An attachment the database references that isn't on the box any more no longer stops every backup: the rest goes
// up, the manifest names it, the status says so plainly, and a check of the backup counts it as recorded.
func TestMissingAttachmentLeavesAGap(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	key := w.Blob("a photo that went missing on the box")
	if err := os.Remove(filepath.Join(w.Cfg.Layout().Home(), "files", key)); err != nil {
		t.Fatal(err)
	}
	res := w.Checkpoint()
	g := res.Manifest.Incomplete
	if g == nil || g.MissingAttachments != 1 || len(g.MissingAttachmentKeys) != 1 || g.MissingAttachmentKeys[0] != key {
		t.Fatalf("manifest incomplete %+v", g)
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if st.LastSuccess == nil || st.LastSuccess.Incomplete == nil || st.LastSuccess.Incomplete.Attachments != 1 ||
		!strings.Contains(st.LastSuccess.Incomplete.Reason, "attachment") {
		t.Fatalf("status %+v", st.LastSuccess)
	}
	rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_g", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill %v %v", err, rep.Failed())
	}
	if c := checkOf(rep, "attachments"); c == nil || !c.OK || !strings.Contains(c.Detail, "already missing") {
		t.Fatalf("attachments check %+v", c)
	}
}
