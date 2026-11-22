//go:build !linux && !darwin

package diskusage

import "errors"

func hostMounts() ([]mountInfo, error) {
	return nil, errors.New("unsupported platform")
}

func hostStatfs(path string) (fsStat, error) {
	return fsStat{}, errors.New("unsupported platform")
}

func fdStatfs(int) (fsStat, error) {
	return fsStat{}, errors.New("unsupported platform")
}
