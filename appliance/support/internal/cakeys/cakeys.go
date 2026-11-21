// Package cakeys reads the Whombat support CA keys the image pins (/etc/whombat/support-ca.pub, NX-416): OpenSSH
// public key lines, `ssh-ed25519 <base64> [comment]`, one or more; blank lines and `#` comments are skipped. No file, or
// one with no key (the placeholder), means remote help isn't available on this image. A file with anything else in it
// is refused whole: a broken pin lets nobody in rather than some.
package cakeys

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	maxFile = 64 << 10
	maxKeys = 16
	keyType = "ssh-ed25519"
)

// Read reads the CA keys at path; none (nil, nil) when there is no file.
func Read(path string) ([]ed25519.PublicKey, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxFile {
		return nil, errors.New("cakeys: the file is larger than 64 KiB")
	}
	var out []ed25519.PublicKey
	for i, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, err := Parse(line)
		if err != nil {
			return nil, fmt.Errorf("cakeys: line %d: %w", i+1, err)
		}
		if len(out) == maxKeys {
			return nil, fmt.Errorf("cakeys: more than %d keys", maxKeys)
		}
		out = append(out, k)
	}
	return out, nil
}

// Parse reads one public key line, `ssh-ed25519 <base64> [comment]`.
func Parse(line string) (ed25519.PublicKey, error) {
	f := strings.Fields(line)
	if len(f) < 2 || f[0] != keyType {
		return nil, errors.New("not an ssh-ed25519 public key")
	}
	blob, err := base64.StdEncoding.Strict().DecodeString(f[1])
	if err != nil {
		return nil, errors.New("the key isn't base64")
	}
	name, rest, ok := sshString(blob)
	if !ok || string(name) != keyType {
		return nil, errors.New("the key isn't an ssh-ed25519 key")
	}
	pub, rest, ok := sshString(rest)
	if !ok || len(rest) != 0 || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("the key isn't 32 bytes")
	}
	return ed25519.PublicKey(bytes.Clone(pub)), nil
}

// Line is a public key's bare line, `ssh-ed25519 <base64>` (SupportState.hostKey's form).
func Line(pub ed25519.PublicKey) string {
	var b []byte
	b = binary.BigEndian.AppendUint32(b, uint32(len(keyType)))
	b = append(b, keyType...)
	b = binary.BigEndian.AppendUint32(b, uint32(len(pub)))
	b = append(b, pub...)
	return keyType + " " + base64.StdEncoding.EncodeToString(b)
}

// sshString reads an SSH wire string (uint32 length, bytes).
func sshString(b []byte) (s, rest []byte, ok bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	n := binary.BigEndian.Uint32(b)
	if uint64(len(b)-4) < uint64(n) {
		return nil, nil, false
	}
	return b[4 : 4+n], b[4+n:], true
}
