package quarantine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// The room Whombat's qgroups have left, read from btrfs-progs' raw output (the limited 2/100 holds Whombat's 1/100).
func TestQuotaLeft(t *testing.T) {
	out := `qgroupid         rfer         excl     max_rfer     max_excl
--------         ----         ----     --------     --------
0/5             16384        16384         none         none
0/257       104857600    104857600         none         none
1/100       524288000    524288000         none         none
1/101       104857600    104857600   2147483648         none
2/100       629145600    629145600   1073741824         none
`
	if got := QuotaLeft([]byte(out)); got != 1073741824-629145600 {
		t.Fatalf("left %d", got)
	}
	if got := QuotaLeft([]byte("0/5 1 1 none none\n1/100 5 5 none none\n")); got != -1 {
		t.Fatalf("no limit: %d", got)
	}
	if got := QuotaLeft([]byte("2/100 900 900 800 none\n")); got != 0 {
		t.Fatalf("over the limit: %d", got)
	}
}

func TestNeedAndBytes(t *testing.T) {
	c := &state.Config{ReserveBytes: 1 << 30}
	m := &manifest.Manifest{Sources: []manifest.Source{{Name: "home", Bytes: 3 << 30}, {Name: "workspaces", Bytes: 1 << 30}}}
	m.Database.Dump.Size = 1 << 30
	disk, share := Need(c, m)
	if disk != (4<<30)+3*(1<<30)+(1<<30) || share != 4<<30 {
		t.Fatalf("need %d on the disk, %d in the share", disk, share)
	}
	for n, want := range map[int64]string{3 << 29: "1.5 GB", 5 << 20: "5 MB", 10: "1 KB"} {
		if got := Bytes(n); got != want {
			t.Fatalf("%d: %q, want %q", n, got, want)
		}
	}
}

// The servers' archive comes back from either form, the uncompressed hub.tar or an older checkpoint's hub.tar.gz, and
// only as the file the manifest names: another one lying beside it, or a path outside the two, is never handed over.
func TestHubArchiveEitherForm(t *testing.T) {
	for _, name := range []string{"hub.tar", "hub.tar.gz"} {
		root := t.TempDir()
		for _, n := range []string{"hub.tar", "hub.tar.gz"} {
			p := filepath.Join(root, "files", "hosts", n)
			_ = os.MkdirAll(filepath.Dir(p), 0o700)
			_ = os.WriteFile(p, []byte(n), 0o600)
		}
		p := filepath.Join(root, "files", "hosts", name)
		mf := &manifest.Manifest{Hosts: &manifest.Hosts{Backup: manifest.File{Path: "files/hosts/" + name}}}
		if got, err := hubArchive(root, mf); err != nil || got != p {
			t.Fatalf("%s: %q %v", name, got, err)
		}
		mf.Hosts.Backup.Path = "files/hosts/../../etc/passwd"
		if got, err := hubArchive(root, mf); err == nil {
			t.Fatalf("%s with a bad manifest path: %q", name, got)
		}
		_ = os.Remove(p)
		mf.Hosts.Backup.Path = "files/hosts/" + name
		if got, err := hubArchive(root, mf); err == nil {
			t.Fatalf("%s missing, the other form taken: %q", name, got)
		}
	}
	if _, err := hubArchive(t.TempDir(), &manifest.Manifest{Hosts: &manifest.Hosts{}}); err == nil {
		t.Fatal("no archive found")
	}
}

// The restore lock is held for a whole restore: a second process can't take it, the same process nests.
func TestRestoreLock(t *testing.T) {
	c := &state.Config{Persist: t.TempDir()}
	rel, err := lockRestore(c)
	if err != nil {
		t.Fatal(err)
	}
	rel2, err := lockRestore(c)
	if err != nil {
		t.Fatalf("nested: %v", err)
	}
	rel2()
	if held[restoreLockPath(c)] == nil {
		t.Fatal("the nested release dropped the outer hold")
	}
	rel()
	if held[restoreLockPath(c)] != nil {
		t.Fatal("still held")
	}
	if fi, err := os.Lstat(restoreLockPath(c)); err != nil || !strings.HasPrefix(fi.Name(), ".whombat-restore") {
		t.Fatalf("lock file: %v", err)
	}
}
