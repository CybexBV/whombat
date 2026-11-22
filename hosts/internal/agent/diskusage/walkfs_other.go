//go:build !linux && !darwin

package diskusage

type unsupportedScanFS struct{}

func newDefaultScanFS(*Runner) scanFS {
	return unsupportedScanFS{}
}

func (unsupportedScanFS) OpenRoot(string, string, mountInfo) (scanDir, error) {
	return nil, &scanUnsupportedError{msg: "This server's system does not support safe disk scans."}
}
