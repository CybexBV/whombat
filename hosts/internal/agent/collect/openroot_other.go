//go:build !linux

package collect

import (
	"errors"
	"os"
	"path/filepath"
)

// openInRoot reads files inside a container's root, which only Linux
// collectors do; elsewhere it is never called.
func openInRoot(root, rel string) (*os.File, error) {
	return nil, &os.PathError{Op: "open", Path: filepath.Join(root, rel), Err: errors.ErrUnsupported}
}
