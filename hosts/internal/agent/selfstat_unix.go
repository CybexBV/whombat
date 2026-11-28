//go:build !windows

package agent

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// CPUTimeWithChildren returns the user+system CPU time of this process
// (all threads) plus that of its terminated, waited-for children.
func CPUTimeWithChildren() (time.Duration, bool) {
	var self, children syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &self) != nil || syscall.Getrusage(syscall.RUSAGE_CHILDREN, &children) != nil {
		return 0, false
	}
	tv := func(t syscall.Timeval) time.Duration {
		return time.Duration(t.Sec)*time.Second + time.Duration(t.Usec)*time.Microsecond
	}
	return tv(self.Utime) + tv(self.Stime) + tv(children.Utime) + tv(children.Stime), true
}

// readRSS returns VmRSS from /proc/self/status in bytes.
func readRSS() uint64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "VmRSS:"); ok {
			fields := strings.Fields(v)
			if len(fields) >= 1 {
				n, err := strconv.ParseUint(fields[0], 10, 64)
				if err == nil {
					return n * 1024 // kB
				}
			}
		}
	}
	return 0
}

// platformInstall: Linux and macOS tell how they were started from the
// process tree (detectInstall).
func platformInstall() (string, bool) { return "", false }
