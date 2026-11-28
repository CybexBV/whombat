// Package claim creates the one-use claim secret, the claim link and the disk recovery key (MA-04).
// Control never sees the secret. Since contracts 0.5.1 (MA-19d, CT-43) it holds a domain-separated
// claim verifier (protocol.ClaimVerifier) so it can check a client's claim proof before opening a
// pending claim; the appliance alone checks the secret itself when a client sends enroll.claim.
package claim

import (
	"github.com/CybexBV/whombat/contracts/go/protocol"

	"crypto/rand"
	"encoding/base32"
	"errors"
	"io"
	"net/url"
	"strings"
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewSecret returns a 128-bit secret as 26 base32 characters (RFC 4648 alphabet, upper case).
func NewSecret(r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	var b [16]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", err
	}
	return b32.EncodeToString(b[:]), nil
}

// Display groups a secret for printing (XXXX-XXXX-…-XX).
func Display(secret string) string {
	var parts []string
	for i := 0; i < len(secret); i += 4 {
		end := min(i+4, len(secret))
		parts = append(parts, secret[i:end])
	}
	return strings.Join(parts, "-")
}

// Normalize is the one normalisation of a typed or scanned claim code (NX-24): the contracts'
// protocol.NormalizeClaimSecret (upper-case; drop whitespace incl. U+FEFF and "-"; 0/1/8 -> O/I/B).
func Normalize(s string) string { return protocol.NormalizeClaimSecret(s) }

// Valid reports whether a normalised claim code has the right shape (protocol.IsClaimSecret).
func Valid(normalized string) bool { return protocol.IsClaimSecret(normalized) }

// SecretHash is what the appliance keeps (claim.json secretHash): protocol.ClaimSecretHash over the
// normalised secret. It panics on a malformed secret; callers pass secrets from NewSecret.
func SecretHash(deviceID, secret string) string {
	h, err := protocol.ClaimSecretHash(deviceID, Normalize(secret))
	if err != nil {
		panic(err)
	}
	return h
}

// Verifier is the claim verifier registered with control (protocol.ClaimVerifier over the normalised
// secret; domain tag whombat-claim-control/1, distinct from the appliance's secret hash).
func Verifier(deviceID, secret string) (string, error) {
	return protocol.ClaimVerifier(deviceID, Normalize(secret))
}

// modhex is systemd's recovery-key alphabet (16 symbols, unambiguous on any keyboard layout).
const modhex = "cbdefghijklnrtuv"

// NewRecoveryKey returns a 256-bit key in systemd-cryptenroll's recovery-key format: 64 modhex
// characters in 8 dash-separated groups. It is enrolled as a passphrase keyslot on both LUKS volumes,
// so systemd-cryptsetup's console prompt accepts it.
func NewRecoveryKey(r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	var b [32]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", err
	}
	var sb strings.Builder
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(modhex[c>>4])
		sb.WriteByte(modhex[c&0xf])
	}
	return sb.String(), nil
}

// URLBase returns the hosted UI claim page for an environment: production's hosted UI is the only one, so a test
// image ("dev") points there too.
func URLBase(env string) (string, error) {
	switch env {
	case "local":
		return "http://localhost:5190/claim", nil
	case "dev", "prod":
		return "https://app.whombat.com/claim", nil
	}
	return "", errors.New("unknown environment")
}

// URL is the claim link encoded in the card's QR code. Everything is in the fragment, which browsers
// never send to a server: v (format), d (appliance id), p (content PeerId, pinned by the client before
// it sends anything), s (claim secret).
func URL(base, deviceID, peerID, secret string) string {
	v := url.Values{}
	v.Set("v", "1")
	v.Set("d", deviceID)
	v.Set("p", peerID)
	v.Set("s", Normalize(secret))
	return base + "#" + v.Encode()
}
