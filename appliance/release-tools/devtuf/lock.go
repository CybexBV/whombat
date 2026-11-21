package devtuf

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// Lock takes the repository's exclusive lock (<dir>/.lock, flock) so that tufrepo, the channel publisher and
// dev/up never write metadata at the same time. It waits up to wait; the lock ends with the returned func or the
// process.
func Lock(dir string, wait time.Duration) (func(), error) {
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
		}
		if err != unix.EWOULDBLOCK || time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("devtuf: repository %s is locked by another writer: %w", dir, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// LoadKeyFile reads a development key file ({development: true, ed25519Seed}) such as the ones in <repo>/keys.
func LoadKeyFile(path string) (role string, key []byte, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	return parseKeyFile(b, path)
}
