//go:build !unix

package diskusage

import "errors"

func isSymlinkLoopErr(error) bool { return false }

func isNotDirErr(err error) bool { return errors.Is(err, errNotDir) }
