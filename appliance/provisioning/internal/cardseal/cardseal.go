// Package cardseal encrypts the secret cards (claim card, disk recovery card) for the factory station
// before they are written to the factory medium (W4-SEC part 2 I-3): a USB stick or SD card keeps deleted
// and even overwritten files in flash blocks the file system no longer points at, so the medium must only
// ever hold ciphertext. The station holds the private key and decrypts in memory to print.
//
// Format "whombat-card-seal/1": magic || ephemeral X25519 public key (32) || AES-256-GCM nonce (12) ||
// ciphertext. The key is HKDF-SHA256(ECDH shared secret, salt = ephemeral || recipient, info = magic).
package cardseal

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

const magic = "whombat-card-seal/1\n"

// Suffix is appended to a sealed card's file name.
const Suffix = ".sealed"

func key(shared, eph, recip []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, shared, append(append([]byte{}, eph...), recip...), magic, 32)
}

// ParsePublicKey parses a base64 (std or raw URL) X25519 public key.
func ParsePublicKey(s string) (*ecdh.PublicKey, error) {
	s = strings.TrimSpace(s)
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		if b, err = base64.RawURLEncoding.DecodeString(s); err != nil {
			return nil, fmt.Errorf("card recipient: %w", err)
		}
	}
	return ecdh.X25519().NewPublicKey(b)
}

// GenerateKey makes a station key pair (private and public, base64).
func GenerateKey(r io.Reader) (priv, pub string, err error) {
	k, err := ecdh.X25519().GenerateKey(r)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(k.Bytes()), base64.StdEncoding.EncodeToString(k.PublicKey().Bytes()), nil
}

// ParsePrivateKey parses a base64 X25519 private key.
func ParsePrivateKey(s string) (*ecdh.PrivateKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, err
	}
	return ecdh.X25519().NewPrivateKey(b)
}

// Seal encrypts plaintext for the recipient.
func Seal(r io.Reader, to *ecdh.PublicKey, plaintext []byte) ([]byte, error) {
	if r == nil {
		r = rand.Reader
	}
	eph, err := ecdh.X25519().GenerateKey(r)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(to)
	if err != nil {
		return nil, err
	}
	k, err := key(shared, eph.PublicKey().Bytes(), to.Bytes())
	if err != nil {
		return nil, err
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(r, nonce); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString(magic)
	out.Write(eph.PublicKey().Bytes())
	out.Write(nonce)
	out.Write(gcm.Seal(nil, nonce, plaintext, []byte(magic)))
	return out.Bytes(), nil
}

// ErrNotSealed: the input is not a sealed card.
var ErrNotSealed = errors.New("not a sealed card")

// Open decrypts a sealed card.
func Open(priv *ecdh.PrivateKey, sealed []byte) ([]byte, error) {
	rest, ok := bytes.CutPrefix(sealed, []byte(magic))
	if !ok || len(rest) < 32+12+16 {
		return nil, ErrNotSealed
	}
	ephB, nonce, ct := rest[:32], rest[32:44], rest[44:]
	eph, err := ecdh.X25519().NewPublicKey(ephB)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(eph)
	if err != nil {
		return nil, err
	}
	k, err := key(shared, ephB, priv.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	return gcm.Open(nil, nonce, ct, []byte(magic))
}
