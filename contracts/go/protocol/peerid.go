package protocol

import (
	"bytes"
	"crypto/ed25519"
	"errors"

	"github.com/mr-tron/base58"
)

// ed25519PeerIDPrefix is the identity multihash (0x00, length 36) of the protobuf PublicKey{Type: Ed25519, Data: 32 bytes}.
var ed25519PeerIDPrefix = []byte{0x00, 0x24, 0x08, 0x01, 0x12, 0x20}

// PeerIDFromEd25519PublicKey returns the libp2p PeerId (`12D3KooW…`) of a raw Ed25519 public key.
func PeerIDFromEd25519PublicKey(pub []byte) (string, error) {
	if len(pub) != ed25519.PublicKeySize {
		return "", errors.New("ed25519 public keys are 32 bytes")
	}
	return base58.Encode(append(append([]byte{}, ed25519PeerIDPrefix...), pub...)), nil
}

// Ed25519PublicKeyFromPeerID returns the raw public key inside an Ed25519 PeerId.
func Ed25519PublicKeyFromPeerID(id string) ([]byte, error) {
	b, err := base58.Decode(id)
	if err != nil {
		return nil, err
	}
	if len(b) != 38 || !bytes.Equal(b[:6], ed25519PeerIDPrefix) {
		return nil, errors.New("not an Ed25519 PeerId")
	}
	return b[6:], nil
}
