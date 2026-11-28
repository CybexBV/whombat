//go:build !windows

package agent

import (
	"errors"
	"fmt"
	"syscall"
)

// SignalReload sends SIGHUP to the agents of dir: to the supervisor when
// there is one (it passes the signal on), else to every `run` process.
// It reports how many it signalled.
func SignalReload(agents []AgentProcess) (int, error) {
	var sup, run []int
	for _, a := range agents {
		if a.Supervisor {
			sup = append(sup, a.PID)
		} else {
			run = append(run, a.PID)
		}
	}
	targets := run
	if len(sup) > 0 {
		targets = sup
	}
	n := 0
	var errs []error
	for _, pid := range targets {
		if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
			errs = append(errs, fmt.Errorf("process %d: %w", pid, err))
			continue
		}
		n++
	}
	return n, errors.Join(errs...)
}
