// Package recovery is the logic of whombat-manager-recovery (MG-16): started by systemd when
// whombat-manager fails (OnFailure=) it execs the known-good manager in recovery mode; when none is
// available it runs the recovery daemon built into itself. Recovery mode keeps tickets flowing and
// finishes or starts rollbacks, but never activates.
//
// The known-good manager is the whombat-manager of a host the update helper recorded as activated
// (TUF-verified tuple, read-only store path; M-3/MA-21d). The helper reports the store paths
// (known-good-manager); nothing under /persist is ever executed.
package recovery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/knowngood"
)

// Exec replaces the process (syscall.Exec in production).
type Exec func(path string, argv []string, env []string) error

// Source reports the known-good manager store paths (the update helper's records).
type Source func(ctx context.Context) ([]string, error)

// HelperSource asks the update helper over its socket.
func HelperSource(socket string) Source {
	return func(ctx context.Context) ([]string, error) {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		res, err := proto.Do(ctx, socket, proto.Request{V: proto.Version, Op: proto.OpKnownGoodManager})
		if err != nil {
			return nil, err
		}
		return res.StorePaths, nil
	}
}

// Launch selects and execs the known-good manager, or calls builtin when none is available.
func Launch(src Source, storeDir, configPath string, exec Exec, builtin func() error) error {
	var paths []string
	if src != nil {
		p, err := src(context.Background())
		if err != nil {
			fmt.Fprintf(os.Stderr, "whombat-manager-recovery: known-good manager unknown (%v); running the built-in recovery manager\n", err)
			return builtin()
		}
		paths = p
	}
	bin, err := knowngood.Select(paths, storeDir)
	if err != nil {
		if !errors.Is(err, knowngood.ErrNone) {
			return err
		}
		fmt.Fprintf(os.Stderr, "whombat-manager-recovery: %v; running the built-in recovery manager\n", err)
		return builtin()
	}
	argv := []string{bin, "--config", configPath, "--recovery"}
	if err := exec(bin, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "whombat-manager-recovery: exec %s failed: %v; running the built-in recovery manager\n", bin, err)
		return builtin()
	}
	return nil
}

// SyscallExec is the production Exec.
func SyscallExec(path string, argv, env []string) error { return syscall.Exec(path, argv, env) }
