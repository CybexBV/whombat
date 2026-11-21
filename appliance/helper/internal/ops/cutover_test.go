package ops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// The move to the GitHub repository (Whombat LNK-26, LNK-50): a DEV box runs rt-1, DEV control assigns the bridge
// (rt-3, a host release) from the old repository, the GitHub repository continues the old one, and the bridge boots
// on the new mirror with channel development. The bridge's own checks after its reboot need it listed in development,
// and when its health checks fail the box must roll back to rt-1, which only a channel can still approve. Without
// --carry both fail; with both releases carried they pass.
func TestBridgeRollsBackAcrossTheCutover(t *testing.T) {
	t.Parallel()
	for _, carry := range [][]string{nil, {"rt-1", "rt-3"}} {
		w := newWorld(t)
		w.factoryHost()
		w.stageFiles("rt-3")
		if _, perr := w.do(proto.OpStageHost, "rt-3"); perr != nil {
			t.Fatal(perr)
		}
		w.assign("rt-3")
		if res, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil || !res.RebootPending {
			t.Fatalf("the bridge: %+v %v", res, perr)
		}
		d := t.TempDir()
		out := filepath.Join(d, "github")
		cont, err := devtuf.Continue(w.repo.Dir, out, devtuf.ContinueOptions{KeysDir: filepath.Join(d, "keys"),
			OfflineKeysDir: filepath.Join(d, "offline"), Now: func() time.Time { return w.clock }, Carry: carry})
		if err != nil {
			t.Fatal(err)
		}
		// What gh-continue prints says when nothing was carried.
		if warned := strings.Contains(strings.Join(cont.Bridge, "\n"), "NOT DONE"); warned != (carry == nil) {
			t.Fatalf("carry %v, bridge list %q", carry, cont.Bridge)
		}
		// The bridge's image: the GitHub repository's metadata in the mirror, channel development.
		w.h.cfg.MirrorDir = filepath.Join(out, "metadata")
		w.h.cfg.DefaultChannel = trust.ChannelDevelopment
		w.fake.SimulateReboot()
		_, check := w.do(proto.OpMigrateRuntime, "rt-3")
		res, rollback := w.do(proto.OpActivateHostOnReboot, "rt-1")
		if carry == nil {
			if check == nil || code(rollback) != proto.CodeRollbackRefused {
				t.Fatalf("without carried releases: check %v, rollback %v", check, rollback)
			}
			continue
		}
		if check != nil {
			t.Fatalf("the bridge's check after its reboot: %v", check)
		}
		if rollback != nil || !res.RebootPending || res.ReleaseID != "rt-1" {
			t.Fatalf("rollback to the release before the bridge: %+v %v", res, rollback)
		}
	}
}

// A bridge that rolls back keeps the box updatable from the old repository (Whombat LNK-26, LNK-50): the bridge's
// helper verifies the GitHub repository in a folder of its own (the DEV image's metadataDir), so after the rollback the
// earlier helper still finds the old repository's chain where it keeps it and takes DEV control's next assignment. With
// one folder for both, the continued root (new timestamp and snapshot keys) would refuse every old-repository refresh.
func TestBridgeRollbackKeepsTheOldRepository(t *testing.T) {
	t.Parallel()
	for _, own := range []bool{false, true} {
		w := newWorld(t)
		w.factoryHost()
		w.stageFiles("rt-3")
		if _, perr := w.do(proto.OpStageHost, "rt-3"); perr != nil {
			t.Fatal(perr)
		}
		w.assign("rt-3")
		if res, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil || !res.RebootPending {
			t.Fatalf("the bridge: %+v %v", res, perr)
		}
		d := t.TempDir()
		out := filepath.Join(d, "github")
		if _, err := devtuf.Continue(w.repo.Dir, out, devtuf.ContinueOptions{KeysDir: filepath.Join(d, "keys"),
			OfflineKeysDir: filepath.Join(d, "offline"), Now: func() time.Time { return w.clock }, Carry: []string{"rt-1", "rt-3"}}); err != nil {
			t.Fatal(err)
		}
		// The bridge boots on the GitHub mirror, refreshes (the continued root) and fails its health checks.
		legacy := w.h.cfg
		w.h.cfg.MirrorDir = filepath.Join(out, "metadata")
		w.h.cfg.DefaultChannel = trust.ChannelDevelopment
		if own {
			w.h.cfg.MetadataDir = filepath.Join(w.cfg.StateDir, "tuf-github")
		}
		w.fake.SimulateReboot()
		if _, perr := w.do(proto.OpMigrateRuntime, "rt-3"); perr != nil {
			t.Fatalf("the bridge's check after its reboot: %v", perr)
		}
		if res, perr := w.do(proto.OpActivateHostOnReboot, "rt-1"); perr != nil || !res.RebootPending {
			t.Fatalf("rollback: %+v %v", res, perr)
		}
		// Back on the earlier generation: its helper's configuration, the old repository, DEV control's assignments.
		w.h.cfg = legacy
		w.fake.SimulateReboot()
		if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
			t.Fatalf("bless the rollback: %v", perr)
		}
		w.clock = w.clock.Add(7 * time.Hour)
		must(t, w.add(devtuf.StandardRelease("rt-6", "26.05.1", "1.6.0")))
		must(t, w.repo.Publish())
		w.stageFiles("rt-6")
		_, stage := w.do(proto.OpStageRuntime, "rt-6")
		w.assign("rt-6")
		_, activate := w.do(proto.OpActivateRuntime, "rt-6")
		if !own {
			if stage == nil {
				t.Fatal("one metadata folder for both repositories: the old repository still verified after the continued root")
			}
			if !strings.Contains(stage.Error(), "signature") {
				t.Fatalf("one folder: %v", stage)
			}
			continue
		}
		if stage != nil || activate != nil {
			t.Fatalf("the earlier generation takes the next assignment: stage %v, activate %v", stage, activate)
		}
		// The bridge's folder keeps the continued chain for the next try forward.
		if _, err := os.Stat(filepath.Join(w.cfg.StateDir, "tuf-github", "root.json")); err != nil {
			t.Fatalf("the GitHub repository's verified root: %v", err)
		}
	}
}
