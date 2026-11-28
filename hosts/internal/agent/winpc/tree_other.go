//go:build !windows

package winpc

import "os/exec"

// startTree: off Windows (tests only) the command runs on its own and stop
// kills it.
func startTree(cmd *exec.Cmd) (stop func(), err error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
		}
	}, nil
}
