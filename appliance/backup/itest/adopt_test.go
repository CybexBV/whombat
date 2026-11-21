package itest

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// broughtBack is the rehearsal's story: A backs up; B adopts A's place and backs up; B brings A's backup back (A is
// retired on B); A, stolen, makes another backup with its old key.
type broughtBack struct {
	*twoBoxes
	matA, matB *kit.Material
	stolen     string // the checkpoint the stolen A made after the bring back
}

func newBroughtBack(t *testing.T) *broughtBack {
	ctx := context.Background()
	x := &broughtBack{twoBoxes: newTwoBoxes(t)}
	var err error
	if x.matA, err = x.A.Material(); err != nil { // A's paper copy, from before it was stolen
		t.Fatal(err)
	}
	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckA.Manifest.ID)); err != nil {
		t.Fatal(err)
	}
	if err := quarantine.End(ctx, x.cfg, x.admin, x.ckA.Manifest.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	release(t, x.cfg)
	x.stolen = x.A.Checkpoint().Manifest.ID
	if x.matB, err = dest.Material(x.cfg); err != nil {
		t.Fatal(err)
	}
	return x
}

// listed is what an adopt of mat answered: each backup's id with the Whombat its manifest names.
func listed(t *testing.T, call func(method, path string, body any) (int, map[string]any), mat *kit.Material) map[string]string {
	t.Helper()
	code, res := call("POST", "/v1/adopt", map[string]any{"material": mat})
	if code != 200 {
		t.Fatalf("adopt: %d %v", code, res)
	}
	out := map[string]string{}
	for _, c := range res["checkpoints"].([]any) {
		e := c.(map[string]any)
		out[e["id"].(string)] = e["applianceId"].(string)
	}
	return out
}

// freshConfig is a new box with no backups of its own and no database (enough to adopt and list).
func freshConfig(t *testing.T, w *World, id string) *state.Config {
	cfg := &state.Config{ApplianceID: id, Persist: filepath.Join(t.TempDir(), "persist"), PGBin: w.Tools.PGBin,
		Restic: w.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	return cfg
}

// BK-79: B's kit carries A's key and the cut-off B recorded when it brought A back; a box that opens B's kit lists
// B's backups and A's up to the cut-off, each under the Whombat that made it, never what the stolen A made later.
// BK-78: a second adopt replaces the first: after A's own paper copy only A's backups are listed (B's, read and cached
// under B's key, no longer), and A stays bounded at the cut-off the box learned; a box that saw only A's paper copy
// first lists everything A made, until B's kit bounds it.
func TestAdoptCarriesWhatItBroughtBack(t *testing.T) {
	x := newBroughtBack(t)
	idA, idB := x.A.Cfg.ApplianceID, x.B.Cfg.ApplianceID
	if len(x.matB.Adopted) != 1 {
		t.Fatalf("B's kit carries %+v", x.matB.Adopted)
	}
	a := x.matB.Adopted[0]
	if a.ManifestKey != x.matA.ManifestKey || a.ApplianceID != idA || a.Until.CheckpointID != x.ckA.Manifest.ID ||
		!slices.Contains(a.Until.Known, x.ckA.ManifestSHA256) {
		t.Fatalf("B's kit: %+v (want A %s up to %s)", a, idA, x.ckA.Manifest.ID)
	}
	// As the runtime passes it: the material's JSON, read back as a kit.
	raw, _ := json.Marshal(x.matB)
	if m, err := kit.Parse(raw); err != nil || len(m.Adopted) != 1 {
		t.Fatalf("B's material doesn't read back: %v", err)
	}

	c := freshConfig(t, x.B, "apl-c")
	call := apiClient(t, c)
	got := listed(t, call, x.matB)
	if len(got) != 2 || got[x.ckB.Manifest.ID] != idB || got[x.ckA.Manifest.ID] != idA {
		t.Fatalf("C with B's kit lists %v; want %s by B and %s by A, not the stolen %s", got, x.ckB.Manifest.ID,
			x.ckA.Manifest.ID, x.stolen)
	}

	got = listed(t, call, x.matA)
	if len(got) != 1 || got[x.ckA.Manifest.ID] != idA {
		t.Fatalf("C with A's paper copy after B's kit lists %v; want only %s", got, x.ckA.Manifest.ID)
	}
	if b, _ := os.ReadFile(c.AdoptedManifestKeyPath()); strings.TrimSpace(string(b)) != x.matA.ManifestKey {
		t.Fatalf("the adopted key is %q", b)
	}
	if h := quarantine.AdoptedHead(c); h == nil || h.ManifestSHA256 != x.matA.Head.ManifestSHA256 {
		t.Fatalf("the adopted head %+v, want A's kit's", h)
	}
	if _, err := os.Stat(listing.EarlierPath(c)); !os.IsNotExist(err) {
		t.Fatalf("B's earlier Whombats stay: %v", err)
	}

	d := freshConfig(t, x.B, "apl-d")
	call = apiClient(t, d)
	got = listed(t, call, x.matA)
	if len(got) != 2 || got[x.stolen] != idA || got[x.ckA.Manifest.ID] != idA {
		t.Fatalf("D with A's paper copy lists %v", got)
	}
	got = listed(t, call, x.matB)
	if len(got) != 2 || got[x.ckB.Manifest.ID] != idB || got[x.ckA.Manifest.ID] != idA {
		t.Fatalf("D with B's kit after A's lists %v", got)
	}
}

// BK-79: bringing back one of the earlier Whombat's backups from the adopted kit keeps that Whombat's cut-off and
// retires the adopted Whombat too, at the backups it had; the next kit carries both.
func TestRestoreAnEarlierWhombatsBackup(t *testing.T) {
	ctx := context.Background()
	x := newBroughtBack(t)
	cw := NewWorld(t)
	call := apiClient(t, cw.Cfg)
	if got := listed(t, call, x.matB); len(got) != 2 {
		t.Fatalf("C lists %v", got)
	}
	cfg := *cw.Cfg
	cfg.RuntimeSocket = ""
	pc, _ := pgx.ParseConfig(cw.Tools.AdminDSN)
	admin := &pgtool.Admin{DSN: cw.Tools.AdminDSN}
	DropSetAside(t, cw.Tools, cw.DB.Name)
	o := quarantine.AppOptions{CheckpointID: x.ckA.Manifest.ID, DB: cw.DB.Name, DBOwner: pc.User, DSN: cw.DB.DSN,
		Admin: admin, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, Log: t.Logf,
		StopRuntime: func(context.Context) error { return nil }, StartRuntime: func(context.Context) {}}
	if err := quarantine.AppRestore(ctx, &cfg, o); err != nil {
		t.Fatal(err)
	}
	if err := quarantine.End(ctx, &cfg, admin, x.ckA.Manifest.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	release(t, &cfg)
	keys, err := listing.LoadKeys(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	if keys.Until == nil || !slices.Contains(keys.Until.Known, x.ckB.ManifestSHA256) || len(keys.Earlier) != 1 ||
		keys.Earlier[0].Bound.CheckpointID != x.ckA.Manifest.ID {
		t.Fatalf("after bringing A's backup back from B's kit: until %+v, earlier %+v", keys.Until, keys.Earlier)
	}
	later := x.B.Checkpoint() // B, the Whombat C replaces, still running somewhere
	res, err := listing.List(ctx, &cfg, cfg.Repo(mustDest(t, &cfg)), keys)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, e := range res.Checkpoints {
		ids[e.ID] = true
	}
	if !ids[x.ckA.Manifest.ID] || !ids[x.ckB.Manifest.ID] || ids[later.Manifest.ID] || ids[x.stolen] {
		t.Fatalf("C lists %v: want A's and B's from before, not B's later %s or the stolen A's %s", ids,
			later.Manifest.ID, x.stolen)
	}
	m, err := dest.Material(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Adopted) != 2 || m.Adopted[0].ManifestKey != x.matB.ManifestKey || m.Adopted[1].ManifestKey != x.matA.ManifestKey {
		t.Fatalf("C's kit carries %+v", m.Adopted)
	}
}
