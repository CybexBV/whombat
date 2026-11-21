package broker_test

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
)

type restoreHelper struct{ ops []proto.Op }

func (h *restoreHelper) Do(_ context.Context, req proto.Request) (*proto.Result, error) {
	h.ops = append(h.ops, req.Op)
	return &proto.Result{}, nil
}

// The restore's maintenance lock keeps updates back while a restore runs and while the person answers its checklist,
// and is given back as soon as the backup service says the restore failed (it was undone), was released, or never
// started; an earlier restore's outcome doesn't count.
func TestRestoreLockEndsWithTheRestore(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	var mu sync.Mutex
	st := broker.RestoreState{Phase: "none"}
	set := func(phase string, since *time.Time) {
		mu.Lock()
		st = broker.RestoreState{Phase: phase, Since: since}
		mu.Unlock()
	}
	h := &restoreHelper{}
	s := &broker.Server{RuntimeUID: uint32(os.Getuid()), Engine: w.Engine, Helper: h, Now: w.Clock.Now,
		RestoreState: func(context.Context) (broker.RestoreState, error) { mu.Lock(); defer mu.Unlock(); return st, nil }}
	c := serveSupport(t, s)
	holder := func() string {
		js, err := w.Engine.Load()
		if err != nil {
			t.Fatal(err)
		}
		if js.Lock == nil {
			return ""
		}
		return js.Lock.Holder
	}
	start := func() {
		t.Helper()
		if resp, m := post(t, c, broker.PathBackupRestore, `{"checkpointId":"ck-1"}`); resp.StatusCode != 202 {
			t.Fatalf("restore: %d %v", resp.StatusCode, m)
		}
		if holder() != "backup-restore" {
			t.Fatal("no maintenance lock while the restore runs")
		}
	}
	ctx := context.Background()
	before := w.Clock.Now().Add(-time.Hour)
	after := func() *time.Time { at := w.Clock.Now().Add(time.Minute); return &at }

	start()
	set("failed", &before) // the last restore's failure, from before this one
	s.CheckRestoreLock(ctx)
	set("restoring", nil)
	s.CheckRestoreLock(ctx)
	set("checking", after()) // in place: the person answers the checklist
	s.CheckRestoreLock(ctx)
	if holder() != "backup-restore" {
		t.Fatal("the lock went while the restore was running or in quarantine")
	}
	set("failed", after())
	s.CheckRestoreLock(ctx)
	if holder() != "" {
		t.Fatal("a failed restore keeps updates blocked")
	}

	start()
	set("none", nil)
	s.CheckRestoreLock(ctx)
	if holder() != "backup-restore" {
		t.Fatal("the lock went before the restore could start")
	}
	w.Clock.Advance(20 * time.Minute)
	s.CheckRestoreLock(ctx)
	if holder() != "" {
		t.Fatal("a restore that never started keeps updates blocked")
	}

	start()
	set("released", after())
	s.CheckRestoreLock(ctx)
	if holder() != "" {
		t.Fatal("a released restore keeps updates blocked")
	}
	if len(h.ops) != 3 {
		t.Fatalf("helper ops %v", h.ops)
	}
}
