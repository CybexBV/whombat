package broker

// SetBeforeDial sets the hook between Bind's look at the path and its dial.
func SetBeforeDial(f func()) { beforeDial = f }
