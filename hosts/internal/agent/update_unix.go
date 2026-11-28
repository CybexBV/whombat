//go:build !windows

package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ReExec replaces the process with exe, keeping the arguments and the
// environment (the PID stays, so systemd, supervise-daemon and `whombat-agent
// supervise` keep tracking it).
func ReExec(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}

// InstallExecutable replaces dst with a copy of src (via dst.new and a
// rename, so dst is never partial), after keeping dst as backup (when
// set). src may be dst.new itself.
func InstallExecutable(src, dst, backup string) error {
	if backup != "" {
		if _, err := os.Stat(dst); err == nil {
			os.Remove(backup)
			if err := os.Link(dst, backup); err != nil {
				if err := copyFileAtomic(dst, backup, 0o755); err != nil {
					return fmt.Errorf("keeping the previous executable: %w", err)
				}
			}
		}
	}
	tmp := dst + ".new"
	if filepath.Clean(src) != filepath.Clean(tmp) {
		if err := copyFile(src, tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
	} else if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(dst))
	return nil
}
