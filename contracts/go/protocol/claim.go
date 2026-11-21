package protocol

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"unicode"
)

// ClaimSecretHashTag is the domain tag of ClaimSecretHash.
const ClaimSecretHashTag = "whombat-claim-secret/1"

var claimSecretRe = regexp.MustCompile(`^[A-Z2-7]{26}$`)

// NormalizeClaimSecret applies the claim-code normalization of provisioning NX-24 (CT-29), identical to
// normalizeClaimSecret in @whombat/protocol: ASCII upper-case a-z only; remove Unicode White_Space, U+FEFF and
// "-"; map "0"→"O", "1"→"I", "8"→"B". Check the result with IsClaimSecret; nothing is repaired.
func NormalizeClaimSecret(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsSpace(r) || r == 0xFEFF || r == '-':
			continue
		case r >= 'a' && r <= 'z':
			r -= 'a' - 'A'
		}
		switch r {
		case '0':
			r = 'O'
		case '1':
			r = 'I'
		case '8':
			r = 'B'
		}
		b.WriteRune(r)
	}
	return b.String()
}

// IsClaimSecret reports whether a normalized claim secret has the right shape (26 base32 characters).
func IsClaimSecret(normalized string) bool { return claimSecretRe.MatchString(normalized) }

// ClaimSecretHash is what the appliance stores (claim.json secretHash):
// base64url_nopad(SHA-256("whombat-claim-secret/1\n" + deviceID + "\n" + normalized)).
func ClaimSecretHash(deviceID, normalized string) (string, error) {
	if !IsClaimSecret(normalized) {
		return "", errors.New("not a normalized claim secret")
	}
	sum := sha256.Sum256([]byte(ClaimSecretHashTag + "\n" + deviceID + "\n" + normalized))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// ClaimVerifierTag is the domain tag of ClaimVerifier.
const ClaimVerifierTag = "whombat-claim-control/1"

// ClaimVerifier is the card proof control checks before opening a pending claim (MA-19d, CT-43), registered by
// provisioning after devices.register and computed by the client from the card as claimProof:
// base64url_nopad(SHA-256("whombat-claim-control/1\n" + deviceID + "\n" + normalized)). Control compares it in
// constant time and never sees the secret.
func ClaimVerifier(deviceID, normalized string) (string, error) {
	if !IsClaimSecret(normalized) {
		return "", errors.New("not a normalized claim secret")
	}
	sum := sha256.Sum256([]byte(ClaimVerifierTag + "\n" + deviceID + "\n" + normalized))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// ClaimCardPassword is the claim PAKE's card password (CT-66), identical to claimCardPassword in @whombat/protocol:
// ClaimSecretHash(deviceID, normalized). The appliance has it as claim.json secretHash, never the secret itself.
func ClaimCardPassword(deviceID, normalized string) (string, error) {
	return ClaimSecretHash(deviceID, normalized)
}
