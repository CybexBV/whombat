// Package ed25519strict verifies Ed25519 signatures with the same rules as verifyEd25519Strict in
// @whombat/core: RFC 8032 cofactorless verification (crypto/ed25519, which already requires a canonical S and
// compares R's canonical encoding) plus a canonical public-key encoding and no small-order public keys.
// crypto/ed25519 alone accepts non-canonical and small-order public keys, with which signatures can be forged.
package ed25519strict

import (
	"bytes"
	"crypto/ed25519"

	"filippo.io/edwards25519"
)

var identity = edwards25519.NewIdentityPoint()

// PublicKeyOK reports whether pub is a canonical encoding of a point that is not of small order.
func PublicKeyOK(pub []byte) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil || !bytes.Equal(p.Bytes(), pub) {
		return false
	}
	return new(edwards25519.Point).MultByCofactor(p).Equal(identity) != 1
}

// Verify is crypto/ed25519.Verify with PublicKeyOK first. Wrong lengths return false.
func Verify(pub, msg, sig []byte) bool {
	return len(sig) == ed25519.SignatureSize && PublicKeyOK(pub) && ed25519.Verify(pub, msg, sig)
}
