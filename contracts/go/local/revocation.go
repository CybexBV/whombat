package local

import (
	"crypto/sha256"
	"encoding/base64"
)

// RevocationRef is the opaque reference control sees for an endpoint revocation (`revocations.report`): the
// first 22 base64url characters of sha256("whombat-revocation-ref/v1:" + peerId), like revocationRef in
// @whombat/control-contracts/local.
func RevocationRef(peerID string) string {
	sum := sha256.Sum256([]byte("whombat-revocation-ref/v1:" + peerID))
	return base64.RawURLEncoding.EncodeToString(sum[:])[:22]
}

// RecoveryKitState maps RuntimeFacts.recovery to DeviceStatusReport.recoveryKit.
func RecoveryKitState(enrolled, kitVerified bool) string {
	switch {
	case !enrolled:
		return "not_created"
	case kitVerified:
		return "confirmed"
	}
	return "unconfirmed"
}
