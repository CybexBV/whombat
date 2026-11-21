package sshd

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// HostKeyFile is the host key's name in the state directory.
const HostKeyFile = "ssh_host_ed25519_key"

// LoadOrCreateHostKey reads the Ed25519 host key at path, or makes one there (0600) when there is none: a box's own
// key, made at its first start, never in the image. A key file anyone but its owner may read, someone else's, or one
// that isn't Ed25519 is refused rather than used or replaced.
func LoadOrCreateHostKey(path string) (ssh.Signer, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		block, err := ssh.MarshalPrivateKey(priv, "whombat-support host key")
		if err != nil {
			return nil, err
		}
		if err := atomicfile.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
			return nil, fmt.Errorf("host key: %w", err)
		}
		return ssh.NewSignerFromKey(priv)
	}
	if err != nil {
		return nil, fmt.Errorf("host key: %w", err)
	}
	st, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("host key: %w", err)
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("host key: %s must be a regular file only its owner can read", path)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("host key: %s belongs to someone else", path)
	}
	signer, err := ssh.ParsePrivateKey(b)
	if err != nil {
		return nil, fmt.Errorf("host key: %w", err)
	}
	if signer.PublicKey().Type() != ssh.KeyAlgoED25519 {
		return nil, errors.New("host key: not an Ed25519 key")
	}
	return signer, nil
}

// HostKeyLine is a public key as `ssh-ed25519 <base64>`: no comment, no newline (SupportState.hostKey).
func HostKeyLine(pub ssh.PublicKey) string {
	return strings.TrimSuffix(string(ssh.MarshalAuthorizedKey(pub)), "\n")
}
