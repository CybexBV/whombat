// Package clearing is the box's own clearing of old backups (Whombat backup-options.md BKO-04, BKO-05): on every
// destination this Whombat's key may delete from (whatever isn't append-only: the disk, SFTP, S3, a REST server
// without --append-only, its own disk) it applies the person's keep windows after a scheduled backup, at most once a
// day, and then the space limit with the same ever shorter windows a backup place's cleanup uses, never touching the
// last 7 days. An append-only destination is cleared by its own side or by nobody (state.ClearedBy).
package clearing

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// Every is how often the box clears at most.
const Every = 23 * time.Hour

// Due says whether the box should clear d now.
func Due(c *state.Config, d *state.Destination, now time.Time) bool {
	if d == nil || state.ClearedBy(d) != state.ClearedByBox {
		return false
	}
	last := state.LoadClearing(c)
	if last == nil || last.Repository != d.Repository {
		return true
	}
	age := now.Sub(last.At)
	return age < 0 || age >= Every // a record dated in the future (the clock was put back) doesn't hold it back
}

// Repo is what clearing needs of a repository (tests use a fake).
type Repo interface {
	Forget(ctx context.Context, tag string, keep []string) (string, error)
	StoredSize(ctx context.Context) (int64, error)
}

// Run clears d once: the person's windows, then, while the repository is over the space limit, the limit's ladder.
// It records the outcome in <stateDir>/forget.json (the status shows it) and returns it.
func Run(ctx context.Context, c *state.Config, d *state.Destination, repo Repo, size func(context.Context) (int64, error), now time.Time) *state.ClearingRecord {
	p := state.LoadPolicy(c)
	rec := &state.ClearingRecord{At: now.UTC(), OK: true, Repository: d.Repository}
	forget := func(k state.PolicyKeep) bool {
		args := k.ForgetArgs()
		rec.Steps = append(rec.Steps, args)
		if _, err := repo.Forget(ctx, manifest.TagProduct, args); err != nil {
			rec.OK, rec.Error = false, state.ASCII(err.Error(), 300)
			return false
		}
		return true
	}
	if forget(p.Keep) && p.LimitBytes != nil {
		limit := *p.LimitBytes
		fits := func() bool {
			n, err := size(ctx)
			if err != nil {
				rec.OK, rec.Error = false, state.ASCII("measuring the backups: "+err.Error(), 300)
				return true // nothing more to do without a size
			}
			rec.Bytes = &n
			return n <= limit
		}
		ok := fits()
		for _, k := range p.Keep.LimitLadder() {
			if ok || !rec.OK {
				break
			}
			if !forget(k) {
				break
			}
			ok = fits()
		}
		rec.OverLimit = rec.OK && !ok
	}
	_ = state.WriteJSON(c.ClearingPath(), rec, 0o600)
	return rec
}

// Size measures the repository the way the space limit counts it: the files of a repository the box holds itself
// (the disk, its own disk; as a place's cleanup counts its folder), else what restic says it stores.
func Size(d *state.Destination, repo restic.Repo) func(context.Context) (int64, error) {
	if d.Kind == state.KindDisk || d.Kind == state.KindLocal {
		dir := repo.Repository
		return func(context.Context) (int64, error) { return dirSize(dir) }
	}
	return repo.StoredSize
}

func dirSize(root string) (int64, error) {
	var n int64
	err := filepath.WalkDir(root, func(_ string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.Type().IsRegular() {
			if fi, err := e.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n, err
}
