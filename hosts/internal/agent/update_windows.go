package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ReExec can't replace a running process on Windows. The agent ends with
// ErrRestart instead, which the service reports as a failure, and the
// service manager's recovery starts the executable again (now the new one).
func ReExec(string) error { return ErrRestart }

// asideSuffix names an executable moved out of the way while it ran.
const asideSuffix = ".old"

// InstallExecutable replaces dst with a copy of src. Windows can't
// overwrite or delete an executable while it runs, but it can rename it:
// dst moves aside (to backup when set, else dst.old) and dst.new takes its
// name; when that fails, dst moves back. src may be dst.new itself.
func InstallExecutable(src, dst, backup string) error {
	tmp := dst + ".new"
	if filepath.Clean(src) != filepath.Clean(tmp) {
		if err := copyFile(src, tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	aside := backup
	if aside == "" {
		aside = dst + asideSuffix
	}
	moved := false
	if _, err := os.Stat(dst); err == nil {
		if err := os.Remove(aside); err != nil && !errors.Is(err, fs.ErrNotExist) {
			// What is there still runs (a rollback's own failed version):
			// this one gets a name of its own, removed at a later start.
			aside = fmt.Sprintf("%s.%d%s", dst, time.Now().UnixNano(), asideSuffix)
		}
		if err := os.Rename(dst, aside); err != nil {
			return fmt.Errorf("moving the running executable aside: %w", err)
		}
		moved = true
	}
	if err := os.Rename(tmp, dst); err != nil {
		if moved {
			_ = os.Rename(aside, dst)
		}
		os.Remove(tmp)
		return err
	}
	return nil
}

// RemoveAsideExecutables removes the executables an update or a rollback
// moved out of the way (exe.old, exe.<n>.old) once they no longer run;
// one that still runs stays until a later start.
func RemoveAsideExecutables(exe string) {
	dir, base := filepath.Dir(exe), filepath.Base(exe)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, base+".") || !strings.HasSuffix(n, asideSuffix) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, n))
	}
}
