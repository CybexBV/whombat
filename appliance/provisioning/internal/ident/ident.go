// Package ident creates the appliance's per-device identities (MA-03) and encodes them in the formats
// their consumers read. PeerId derivation comes from the vendored contracts bindings (MA-02); only the
// private-key file encodings and the claim-card fingerprint are implemented here.
//
//   - management key: Ed25519, PKCS#8 PEM ("PRIVATE KEY"), read by whombat-manager
//     (manager/internal/identity); public half as lower-case hex (contracts PublicKeyHex).
//   - content identity: Ed25519 as a libp2p protobuf private key (0x08 0x01 0x12 0x40 ‖ seed ‖ pub),
//     read by the runtime (WHOMBAT_CONTENT_KEY_FILE); public half as a libp2p PeerId (12D3KooW…).
package ident

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base32"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Key is an Ed25519 key pair.
type Key struct {
	Private ed25519.PrivateKey
	Public  ed25519.PublicKey
}

// Generate reads 32 bytes from r (crypto/rand.Reader in production: getrandom(2), which blocks until the
// kernel CRNG is initialised) and derives a key.
func Generate(r io.Reader) (*Key, error) {
	if r == nil {
		r = rand.Reader
	}
	pub, priv, err := ed25519.GenerateKey(r)
	if err != nil {
		return nil, err
	}
	return &Key{Private: priv, Public: pub}, nil
}

// PKCS8PEM encodes the private key as PKCS#8 PEM.
func (k *Key) PKCS8PEM() ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(k.Private)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// PublicHex is the raw public key as lower-case hex (64 characters).
func (k *Key) PublicHex() string { return hex.EncodeToString(k.Public) }

// PeerID is the libp2p PeerId of the public key.
func (k *Key) PeerID() string {
	id, err := protocol.PeerIDFromEd25519PublicKey(k.Public)
	if err != nil {
		panic(err) // a generated key is always 32 bytes
	}
	return id
}

// Libp2pPrivateKey is the libp2p protobuf encoding of the private key (KeyType Ed25519 = 1, 64-byte
// seed‖public data), as written by libp2p's privateKeyToProtobuf.
func (k *Key) Libp2pPrivateKey() []byte {
	out := []byte{0x08, 0x01, 0x12, 0x40}
	return append(out, k.Private...)
}

// ParseLibp2pPrivateKey reads the format written by Libp2pPrivateKey.
func ParseLibp2pPrivateKey(b []byte) (*Key, error) {
	if len(b) != 68 || b[0] != 0x08 || b[1] != 0x01 || b[2] != 0x12 || b[3] != 0x40 {
		return nil, errors.New("not a libp2p Ed25519 private key")
	}
	priv := ed25519.NewKeyFromSeed(b[4:36])
	pub := priv.Public().(ed25519.PublicKey)
	if string(pub) != string(b[36:]) {
		return nil, errors.New("libp2p key: public half does not match the seed")
	}
	return &Key{Private: priv, Public: pub}, nil
}

// ParsePKCS8PEM reads the format written by PKCS8PEM.
func ParsePKCS8PEM(b []byte) (*Key, error) {
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, errors.New("expected PKCS#8 PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	return &Key{Private: priv, Public: priv.Public().(ed25519.PublicKey)}, nil
}

// Fingerprint is the claim-card fingerprint of a PeerId, identical to @whombat/secure-channel's
// `fingerprint(peerId)`: the first 125 bits of SHA-256("whombat-peer-fingerprint/1\0" ‖ multihash bytes
// of the PeerId), RFC 4648 base32, five groups of five (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). The TypeScript
// package has no Go binding for it; the known-answer vector in its tests is checked in ident_test.go.
func Fingerprint(peerID string) (string, error) {
	pub, err := protocol.Ed25519PublicKeyFromPeerID(peerID)
	if err != nil {
		return "", err
	}
	mh := append([]byte{0x00, 0x24, 0x08, 0x01, 0x12, 0x20}, pub...)
	sum := sha256.Sum256(append([]byte("whombat-peer-fingerprint/1\x00"), mh...))
	s := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])[:25]
	parts := make([]string, 0, 5)
	for i := 0; i < 25; i += 5 {
		parts = append(parts, s[i:i+5])
	}
	return strings.Join(parts, "-"), nil
}
