package devtuf

// SetRotateHook stops the key ceremony after a signing step in tests (R1 #4: an interruption while signing).
func SetRotateHook(f func(stage string) error) func() {
	rotateHook = f
	return func() { rotateHook = nil }
}

// SetKeyFileHook stops saveKeys before one of its changes in tests (R2 A2: a kill while the keys folder changes).
func SetKeyFileHook(f func(op, name string) error) func() {
	keyFileHook = f
	return func() { keyFileHook = nil }
}
