package itest

import (
	"context"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/clearing"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// A REST server without --append-only is cleared by the box (what the app says, clearedBy box): the windows are
// applied with restic against the real server, the stored size is measured for the space limit, and the status says
// who clears and how it went.
func TestBoxClearsARESTServerThatIsNotAppendOnly(t *testing.T) {
	w := NewWorld(t)
	m := w.StartMaintenance(w.RestUser, w.RestPass)
	ctx := context.Background()
	res, err := dest.Configure(ctx, w.Cfg, dest.Request{Repository: m.Repo("open"), RESTUser: w.RestUser, RESTPassword: w.RestPass, AllowInit: true})
	if err != nil {
		t.Fatal(err)
	}
	d := res.Destination
	if d.AppendOnly == "verified" || state.ClearedBy(d) != state.ClearedByBox {
		t.Fatalf("append-only %s", d.AppendOnly)
	}
	w.Checkpoint()
	w.Checkpoint()
	limit := int64(state.LimitMinBytes)
	p := state.DefaultPolicy()
	p.LimitBytes = &limit
	if err := state.SavePolicy(w.Cfg, p); err != nil {
		t.Fatal(err)
	}
	if !clearing.Due(w.Cfg, d, time.Now()) {
		t.Fatal("not due")
	}
	repo := w.Cfg.Repo(d)
	rec := clearing.Run(ctx, w.Cfg, d, repo, clearing.Size(d, repo), time.Now())
	if !rec.OK || rec.OverLimit || rec.Bytes == nil || *rec.Bytes <= 0 || len(rec.Steps) != 1 {
		t.Fatalf("clearing %+v", rec)
	}
	if snaps, err := repo.Snapshots(ctx, ""); err != nil || len(snaps) != 2 {
		t.Fatalf("the windows kept %d of 2 fresh backups (%v)", len(snaps), err)
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if st.Clearing == nil || st.Clearing.By != state.ClearedByBox || st.Clearing.OK == nil || !*st.Clearing.OK || st.Clearing.Bytes == nil {
		t.Fatalf("status clearing %+v", st.Clearing)
	}
}
