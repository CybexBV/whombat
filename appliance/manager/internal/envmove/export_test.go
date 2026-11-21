package envmove

// SetApplyHook stops a move before one of its steps in tests ("aside", "registration", "identity", "box", "done"), as
// a crash would (R1 #13).
func SetApplyHook(f func(step string) error) func() {
	applyHook = f
	return func() { applyHook = nil }
}

// SetRenameHook is asked before every rename a move makes (tests refuse renames across subvolumes with EXDEV).
func SetRenameHook(f func(oldpath, newpath string) error) { renameHook = f }

// Rename is the move's own rename (tests prove the EXDEV rule holds).
func Rename(oldpath, newpath string) error { return rename(oldpath, newpath) }

// SetFreeSpace replaces the free-space reading; the returned func restores it.
func SetFreeSpace(f func(dir string) (int64, error)) func() {
	old := freeSpace
	freeSpace = f
	return func() { freeSpace = old }
}
