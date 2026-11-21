package agent

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// A Mac's agent runs as root from its LaunchDaemon, so its executable must
// be where only root can change it. install.sh puts it in
// /Library/Application Support/Whombat/bin, leaves a link in /usr/local/bin
// for the command line, and moves an earlier install there when it runs
// again. Homebrew makes /usr/local/bin the person's own on Intel Macs, where
// a program of theirs could swap the root daemon's executable; such an agent
// says so in its report (the hint macos.agent_folder) instead of moving
// itself.

// RootOnly checks that only root (or owner) can change path: it and every
// folder above it, up to top, are no links, belong to root or owner, and
// are writable by nobody else.
func RootOnly(path string, owner int, top string) error {
	p, top := filepath.Clean(path), filepath.Clean(top)
	for {
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s is a link", p)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("%s: no owner", p)
		}
		if st.Uid != 0 && int(st.Uid) != owner {
			return fmt.Errorf("%s belongs to uid %d", p, st.Uid)
		}
		if fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s can be changed by others (%v)", p, fi.Mode().Perm())
		}
		parent := filepath.Dir(p)
		if p == top || parent == p {
			return nil
		}
		p = parent
	}
}
