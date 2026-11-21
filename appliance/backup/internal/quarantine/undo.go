package quarantine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// Undo puts the box back as it was before a restore that didn't finish, from the restore's journal: whatever the
// restore put in the sources is removed (it is all in the backup), what prepare set aside moves back, the database set
// aside is renamed back, the servers' staged backup goes, and the marker is archived as failed. The moves are the
// same as prepare's (moveInto): on the box every source is a btrfs subvolume of its own, where a plain rename from the
// set-aside folder fails (EXDEV). It can be run again after it stopped part-way: nothing is emptied twice.
func Undo(ctx context.Context, c *state.Config, admin *pgtool.Admin, j *Journal) error {
	release, err := lockRestore(c)
	if err != nil {
		return err
	}
	defer release()
	lock, err := waitRunLock(ctx, c, 2*time.Minute)
	if err != nil {
		return err
	}
	defer lock.Unlock()
	return undo(ctx, c, admin, j)
}

func undo(ctx context.Context, c *state.Config, admin *pgtool.Admin, j *Journal) error {
	var errs []error
	sources := filesSources(c.Layout())
	if j.Prepared && !j.Emptied {
		for _, s := range sources {
			if err := emptyDir(s.Path); err != nil {
				errs = append(errs, err)
			}
		}
		if len(errs) == 0 {
			if err := syncFS(c.Persist); err != nil {
				errs = append(errs, err)
			}
		}
		if len(errs) == 0 {
			j.Emptied = true
			if err := j.save(); err != nil {
				errs = append(errs, err)
			}
		}
		if len(errs) > 0 {
			return keepQuarantined(c, errors.Join(errs...))
		}
	}
	for _, s := range sources {
		src := filepath.Join(j.dir, s.Name)
		if fi, err := os.Lstat(src); err != nil || !fi.IsDir() {
			continue
		}
		if err := settleCollisions(src, s.Path, j.Prepared); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := moveInto(ctx, src, s.Path); err != nil {
			errs = append(errs, fmt.Errorf("put %s back: %w", s.Path, err))
			continue
		}
		_ = os.Remove(src)
	}
	for _, n := range coverage.HostsStagedFiles {
		if hostsStaged := filepath.Join(c.Layout().HostsData(), n); fileExists(hostsStaged) {
			_ = os.Remove(hostsStaged)
		}
	}
	if admin != nil && j.AsideDB != "" {
		if exists, err := admin.Exists(ctx, j.AsideDB); err != nil {
			errs = append(errs, err)
		} else if exists {
			if err := admin.DropDB(ctx, j.DB); err != nil {
				errs = append(errs, err)
			} else if err := admin.SetAside(ctx, j.AsideDB, j.DB); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if len(errs) == 0 {
		if err := syncFS(c.Persist); err != nil { // everything is back on disk before the journal goes
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return keepQuarantined(c, errors.Join(errs...))
	}
	if fileExists(Path(c)) {
		if err := os.Rename(Path(c), filepath.Join(c.StateDir,
			"quarantine-failed-"+time.Now().UTC().Format("20060102T150405Z")+".json")); err != nil {
			return err
		}
	}
	dropBound(c, j.Stamp)
	return os.RemoveAll(j.dir)
}

// settleCollisions handles an entry that is both set aside and in its source, which only a move a power cut stopped
// leaves (moveInto names a copy only once it is whole, and removes the original only after): while prepare was
// moving things aside (not prepared), the set-aside one is whole; while an undo was moving them back (prepared, the
// sources emptied first), the one in the source is.
func settleCollisions(aside, source string, prepared bool) error {
	ents, err := os.ReadDir(aside)
	if err != nil {
		return err
	}
	for _, e := range ents {
		there := filepath.Join(source, e.Name())
		if _, err := os.Lstat(there); err != nil {
			continue
		}
		drop := there
		if prepared {
			drop = filepath.Join(aside, e.Name())
		}
		if err := os.RemoveAll(drop); err != nil {
			return err
		}
	}
	return nil
}

// keepQuarantined: an undo that couldn't put everything back keeps the box in quarantine (the runner doesn't start,
// the runtime does nothing outward) on what may be partial data, and says why; the next start tries again.
func keepQuarantined(c *state.Config, err error) error {
	m, _ := Load(c)
	if m == nil {
		m = &Marker{Kind: Kind, Phase: PhaseRestoring, Since: time.Now().UTC(), NewApplianceID: c.ApplianceID, Items: Items()}
	}
	m.Phase = PhaseRestoring
	m.Error = "putting this Whombat back as it was before the restore failed: " + err.Error()
	_ = state.WriteJSON(Path(c), m, 0o644)
	return err
}

// Cleanup removes what a finished restore set aside: the folder and the set-aside database.
func Cleanup(ctx context.Context, admin *pgtool.Admin, j *Journal) error {
	if admin != nil && j.AsideDB != "" {
		if err := admin.DropDB(ctx, j.AsideDB); err != nil {
			return fmt.Errorf("drop %s: %w", j.AsideDB, err)
		}
	}
	return os.RemoveAll(j.dir)
}

func emptyDir(dir string) error {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range ents {
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}
