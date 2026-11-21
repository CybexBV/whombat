// Package identity loads the appliance management key (MA-03): an Ed25519 key at
// /persist/identity/management.key, PKCS#8 PEM, mode 0600, owned by the manager user. The key never
// leaves the manager process; the runtime gets admission tickets, not the key.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// Key is the management identity.
type Key struct {
	Private ed25519.PrivateKey
	Public  ed25519.PublicKey
}

// ErrPermissions means the key file is readable or writable by group/others or not owned by us.
var ErrPermissions = errors.New("management key file permissions are too open")

// Load reads the key and enforces 0600 (or stricter) ownership by the current user.
func Load(path string) (*Key, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%w: %s is %v", ErrPermissions, path, st.Mode().Perm())
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("%w: %s owned by uid %d", ErrPermissions, path, sys.Uid)
	}
	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	block, _ := pem.Decode(buf[:n])
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, errors.New("management key: expected PKCS#8 PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("management key is not Ed25519")
	}
	return &Key{Private: priv, Public: priv.Public().(ed25519.PublicKey)}, nil
}

// Generate creates a new key file (provisioning / development). It refuses to overwrite.
func Generate(path string) (*Key, error) {
	if _, err := os.Lstat(path); err == nil {
		return nil, fmt.Errorf("%s already exists", path)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := atomicfile.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return &Key{Private: priv, Public: pub}, nil
}
