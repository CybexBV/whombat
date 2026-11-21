// Package reap ends what a visit left running when the grant ends (NX-418): every process in the support service's own
// cgroup but the service itself — a command a Fix command line started in the background, a Look command still
// reading. Root's processes elsewhere (a unit support restarted, a transient one it made) are the system's and stay.
package reap

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// rounds bounds the sweeps, a pause apart: a killed process takes a moment to leave the cgroup, and one that forks while
// it is killed shows up in the next sweep. About five seconds in all.
const (
	rounds = 50
	pause  = 100 * time.Millisecond
)

// Options of Leftovers; the zero value is the real system.
type Options struct {
	ProcSelfCgroup string               // /proc/self/cgroup
	CgroupRoot     string               // /sys/fs/cgroup
	Self           int                  // os.Getpid()
	Kill           func(pid int) error  // SIGKILL
	Wait           func()               // the pause between sweeps
	Logf           func(string, ...any) // stderr
}

// Leftovers kills every process in this process's cgroup (and the cgroups below it) but this one, and says how many
// processes it killed. Only on the unified hierarchy (cgroup v2, as systemd 260 runs it).
func Leftovers(o Options) (int, error) {
	if o.ProcSelfCgroup == "" {
		o.ProcSelfCgroup = "/proc/self/cgroup"
	}
	if o.CgroupRoot == "" {
		o.CgroupRoot = "/sys/fs/cgroup"
	}
	if o.Self == 0 {
		o.Self = os.Getpid()
	}
	if o.Kill == nil {
		o.Kill = func(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
	}
	if o.Wait == nil {
		o.Wait = func() { time.Sleep(pause) }
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	dir, err := own(o.ProcSelfCgroup, o.CgroupRoot)
	if err != nil {
		return 0, err
	}
	killed := map[int]bool{}
	for i := range rounds {
		pids, err := members(dir)
		if err != nil {
			return len(killed), err
		}
		left := 0
		for _, pid := range pids {
			if pid == o.Self {
				continue
			}
			left++
			if err := o.Kill(pid); err == nil {
				killed[pid] = true
			} else if !errors.Is(err, syscall.ESRCH) {
				o.Logf("whombat-support: can't end process %d: %v", pid, err)
			}
		}
		if left == 0 {
			return len(killed), nil
		}
		if i < rounds-1 {
			o.Wait()
		}
	}
	return len(killed), errors.New("reap: processes are still there")
}

// own is this process's cgroup directory on the unified hierarchy (the `0::/path` line).
func own(procSelfCgroup, root string) (string, error) {
	b, err := os.ReadFile(procSelfCgroup)
	if err != nil {
		return "", err
	}
	for line := range strings.SplitSeq(string(b), "\n") {
		if p, ok := strings.CutPrefix(line, "0::"); ok && strings.HasPrefix(p, "/") && p != "/" &&
			!strings.Contains(p, "/../") && !strings.HasSuffix(p, "/..") {
			return filepath.Join(root, p), nil
		}
	}
	return "", errors.New("reap: not in a cgroup of its own on the unified hierarchy")
}

// members lists the processes in dir's cgroup and every cgroup below it.
func members(dir string) ([]int, error) {
	var out []int
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if path != dir && errors.Is(err, os.ErrNotExist) {
				return nil // a cgroup that went away while walking
			}
			return err
		}
		if !d.IsDir() {
			return nil
		}
		f, err := os.Open(filepath.Join(path, "cgroup.procs"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if pid, err := strconv.Atoi(strings.TrimSpace(sc.Text())); err == nil && pid > 0 {
				out = append(out, pid)
			}
		}
		return sc.Err()
	})
	return out, err
}
