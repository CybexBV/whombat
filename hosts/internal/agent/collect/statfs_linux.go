package collect

import "syscall"

// statfsFrsize is the fragment size statfs counts blocks in.
func statfsFrsize(st *syscall.Statfs_t) uint64 { return uint64(st.Frsize) }
