//go:build !linux

package collect

import "syscall"

// readAdjtimex: only Linux has adjtimex().
func readAdjtimex() (state int, status int32, offset int64, err error) {
	return 0, 0, 0, syscall.ENOSYS
}
