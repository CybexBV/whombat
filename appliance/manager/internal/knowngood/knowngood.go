// Package knowngood selects the manager binary whombat-manager-recovery runs when whombat-manager keeps
// failing (MG-16). Since W4-SEC part 2 (M-3, MA-21d) the known-good manager is never a copy in
// manager-writable state: it is the whombat-manager of a host the update helper recorded as activated,
// resolved from the TUF-approved tuple (tuple.manager.storePath) and executed from the read-only Nix
// store, whose contents the helper imported against the approved NAR hash. The manager uid can neither
// plant a binary nor choose the path.
package knowngood

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// Binary is the manager executable inside a manager store path.
const Binary = "bin/whombat-manager"

// StoreDir is the Nix store.
const StoreDir = "/nix/store"

// ErrNone means no usable known-good manager exists.
var ErrNone = errors.New("no known-good manager in the store")

// Select returns the first usable manager binary among the helper-provided store paths (current known-good
// host first). A path is usable if it is a valid store path directly under storeDir and its bin/whombat-manager
// resolves to an executable regular file inside the store.
func Select(storePaths []string, storeDir string) (string, error) {
	var errs []error
	for _, p := range storePaths {
		bin, err := check(p, storeDir)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		return bin, nil
	}
	return "", errors.Join(append([]error{ErrNone}, errs...)...)
}

func check(p, storeDir string) (string, error) {
	if storeDir == StoreDir && !trust.ValidStorePath(p) {
		return "", fmt.Errorf("%q is not a store path", p)
	}
	if filepath.Dir(p) != storeDir || strings.Contains(filepath.Base(p), "..") {
		return "", fmt.Errorf("%q is not directly in %s", p, storeDir)
	}
	bin := filepath.Join(p, Binary)
	real, err := filepath.EvalSymlinks(bin)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(real, storeDir+"/") {
		return "", fmt.Errorf("%s resolves outside the store (%s)", bin, real)
	}
	st, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("%s: not an executable file", real)
	}
	return bin, nil
}
