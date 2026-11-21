// Package sshkey reads and writes the few OpenSSH formats SFTP destinations need (BK-19): the box's own
// Ed25519 key (the private key in OpenSSH's "openssh-key-v1" format, its authorized_keys line), host keys
// as known_hosts-style lines, and SHA256 fingerprints as `ssh-keygen -l` prints them. Only public key
// parsing and Ed25519 generation: no SSH protocol here (ssh itself connects, BK-19).
package sshkey

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Key types accepted as host keys (what OpenSSH servers offer), in order of preference.
var hostKeyTypes = []string{
	"ssh-ed25519",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
	"ssh-rsa",
}

// PublicKey is an OpenSSH public key: its type and wire blob.
type PublicKey struct {
	Type string
	Blob []byte
}

// String is the key as one authorized_keys/known_hosts field pair ("ssh-ed25519 AAAA…").
func (k PublicKey) String() string {
	return k.Type + " " + base64.StdEncoding.EncodeToString(k.Blob)
}

// Fingerprint is "SHA256:<unpadded base64>", as `ssh-keygen -l` prints it.
func (k PublicKey) Fingerprint() string {
	h := sha256.Sum256(k.Blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

// HostKeyAlgorithms is the value for ssh's HostKeyAlgorithms that makes it negotiate exactly this key
// (an RSA key is used with the SHA-2 signature algorithms; plain ssh-rsa/SHA-1 is not offered).
func (k PublicKey) HostKeyAlgorithms() string {
	if k.Type == "ssh-rsa" {
		return "rsa-sha2-512,rsa-sha2-256"
	}
	return k.Type
}

// Rank orders host key types by preference (lower is better; -1 = not accepted).
func Rank(typ string) int {
	for i, t := range hostKeyTypes {
		if t == typ {
			return i
		}
	}
	return -1
}

var fingerprintRe = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}=?$`)

// IsFingerprint says whether s is a SHA256 fingerprint ("SHA256:…").
func IsFingerprint(s string) bool { return fingerprintRe.MatchString(strings.TrimSpace(s)) }

// SameFingerprint compares fingerprints, ignoring base64 padding.
func SameFingerprint(a, b string) bool {
	return strings.TrimRight(strings.TrimSpace(a), "=") == strings.TrimRight(strings.TrimSpace(b), "=")
}

// ParsePublicKey parses one line in authorized_keys or known_hosts style: an optional leading host list
// or marker, the key type, the base64 blob, an optional comment. The blob must decode and name the same
// type; markers (@cert-authority, @revoked) and certificates are refused.
func ParsePublicKey(line string) (PublicKey, error) {
	f := strings.Fields(strings.TrimSpace(line))
	for i, w := range f {
		if strings.HasPrefix(w, "@") {
			return PublicKey{}, fmt.Errorf("host key: %s lines are not accepted", w)
		}
		if Rank(w) < 0 {
			if strings.Contains(w, "-cert-v01@openssh.com") {
				return PublicKey{}, errors.New("host key: certificates are not accepted; give the server's plain host key")
			}
			continue
		}
		if i+1 >= len(f) {
			return PublicKey{}, errors.New("host key: the key data after the type is missing")
		}
		blob, err := base64.StdEncoding.DecodeString(f[i+1])
		if err != nil {
			return PublicKey{}, fmt.Errorf("host key: the key data isn't base64: %w", err)
		}
		inner, _, ok := readString(blob)
		if !ok || string(inner) != w {
			return PublicKey{}, fmt.Errorf("host key: the key data isn't a %s key", w)
		}
		if w == "ssh-ed25519" {
			_, rest, _ := readString(blob)
			pk, rest, ok := readString(rest)
			if !ok || len(pk) != ed25519.PublicKeySize || len(rest) != 0 {
				return PublicKey{}, errors.New("host key: malformed ssh-ed25519 key")
			}
		}
		return PublicKey{Type: w, Blob: blob}, nil
	}
	return PublicKey{}, fmt.Errorf("host key: no key of a supported type (%s)", strings.Join(hostKeyTypes, ", "))
}

// KnownHostsLine pins k for host:port ("host" for port 22, "[host]:port" otherwise).
func KnownHostsLine(host string, port int, k PublicKey) string {
	h := host
	if port != 0 && port != 22 {
		h = fmt.Sprintf("[%s]:%d", host, port)
	}
	return h + " " + k.String() + "\n"
}

// Ed25519Public is the public key of an Ed25519 key.
func Ed25519Public(pub ed25519.PublicKey) PublicKey {
	var b bytes.Buffer
	writeString(&b, []byte("ssh-ed25519"))
	writeString(&b, pub)
	return PublicKey{Type: "ssh-ed25519", Blob: b.Bytes()}
}

// AuthorizedKey is the authorized_keys line for a public key ("ssh-ed25519 AAAA… comment").
func AuthorizedKey(pub ed25519.PublicKey, comment string) string {
	s := Ed25519Public(pub).String()
	if comment != "" {
		s += " " + comment
	}
	return s
}

// Generate makes a new Ed25519 key.
func Generate() (ed25519.PrivateKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	return priv, err
}

const pemType = "OPENSSH PRIVATE KEY"
const magic = "openssh-key-v1\x00"

// MarshalPrivate encodes an Ed25519 private key as an unencrypted OpenSSH private key (PEM), the format
// ssh reads with -i.
func MarshalPrivate(priv ed25519.PrivateKey, comment string) []byte {
	pub := priv.Public().(ed25519.PublicKey)
	pubBlob := Ed25519Public(pub).Blob
	var check [4]byte
	_, _ = rand.Read(check[:])
	var sec bytes.Buffer
	sec.Write(check[:])
	sec.Write(check[:])
	writeString(&sec, []byte("ssh-ed25519"))
	writeString(&sec, pub)
	writeString(&sec, priv) // seed || public, 64 bytes
	writeString(&sec, []byte(comment))
	for i := byte(1); sec.Len()%8 != 0; i++ {
		sec.WriteByte(i)
	}
	var b bytes.Buffer
	b.WriteString(magic)
	writeString(&b, []byte("none")) // cipher
	writeString(&b, []byte("none")) // kdf
	writeString(&b, nil)            // kdf options
	_ = binary.Write(&b, binary.BigEndian, uint32(1))
	writeString(&b, pubBlob)
	writeString(&b, sec.Bytes())
	return pem.EncodeToMemory(&pem.Block{Type: pemType, Bytes: b.Bytes()})
}

// ParsePrivate decodes an unencrypted OpenSSH Ed25519 private key (MarshalPrivate's format, or one made by
// `ssh-keygen -t ed25519 -N ""`).
func ParsePrivate(data []byte) (ed25519.PrivateKey, error) {
	blk, _ := pem.Decode(bytes.TrimSpace(data))
	if blk == nil || blk.Type != pemType {
		return nil, errors.New("ssh key: not an OpenSSH private key")
	}
	b := blk.Bytes
	if !bytes.HasPrefix(b, []byte(magic)) {
		return nil, errors.New("ssh key: not an openssh-key-v1 key")
	}
	b = b[len(magic):]
	var cipher, kdf, pubBlob, sec []byte
	var ok bool
	if cipher, b, ok = readString(b); !ok {
		return nil, errors.New("ssh key: truncated")
	}
	if kdf, b, ok = readString(b); !ok {
		return nil, errors.New("ssh key: truncated")
	}
	if string(cipher) != "none" || string(kdf) != "none" {
		return nil, errors.New("ssh key: encrypted keys are not supported (the box's key has no passphrase)")
	}
	if _, b, ok = readString(b); !ok { // kdf options
		return nil, errors.New("ssh key: truncated")
	}
	if len(b) < 4 || binary.BigEndian.Uint32(b) != 1 {
		return nil, errors.New("ssh key: expected exactly one key")
	}
	b = b[4:]
	if pubBlob, b, ok = readString(b); !ok {
		return nil, errors.New("ssh key: truncated")
	}
	if sec, _, ok = readString(b); !ok || len(sec) < 8 {
		return nil, errors.New("ssh key: truncated")
	}
	if !bytes.Equal(sec[0:4], sec[4:8]) {
		return nil, errors.New("ssh key: check bytes differ (wrong format or encrypted)")
	}
	s := sec[8:]
	var typ, pub, priv []byte
	if typ, s, ok = readString(s); !ok || string(typ) != "ssh-ed25519" {
		return nil, errors.New("ssh key: only ssh-ed25519 keys are supported")
	}
	if pub, s, ok = readString(s); !ok || len(pub) != ed25519.PublicKeySize {
		return nil, errors.New("ssh key: malformed public part")
	}
	if priv, _, ok = readString(s); !ok || len(priv) != ed25519.PrivateKeySize {
		return nil, errors.New("ssh key: malformed private part")
	}
	key := ed25519.NewKeyFromSeed(priv[:ed25519.SeedSize])
	if !bytes.Equal(key.Public().(ed25519.PublicKey), pub) || !bytes.Equal(Ed25519Public(pub).Blob, pubBlob) {
		return nil, errors.New("ssh key: the public and private parts don't match")
	}
	return key, nil
}

func writeString(b *bytes.Buffer, s []byte) {
	_ = binary.Write(b, binary.BigEndian, uint32(len(s)))
	b.Write(s)
}

func readString(b []byte) (s, rest []byte, ok bool) {
	if len(b) < 4 {
		return nil, b, false
	}
	n := binary.BigEndian.Uint32(b)
	if uint64(n) > uint64(len(b)-4) {
		return nil, b, false
	}
	return b[4 : 4+n], b[4+n:], true
}
