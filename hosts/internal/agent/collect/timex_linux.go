package collect

import "golang.org/x/sys/unix"

func readAdjtimex() (state int, status int32, offset int64, err error) {
	var tx unix.Timex
	st, err := unix.Adjtimex(&tx)
	return st, tx.Status, tx.Offset, err
}
