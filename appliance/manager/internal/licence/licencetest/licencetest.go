// Package licencetest signs licence tokens for tests (the fake control and the manager's tests). Every key here is a
// TEST key derived from a public label; nothing here is ever a real licence key (LC-04).
package licencetest

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Signer is one licence signing key.
type Signer struct {
	Kid  string
	Priv ed25519.PrivateKey
}

// NewSigner derives a TEST key from a label (the same label gives the same key).
func NewSigner(label, kid string) Signer {
	seed := sha256.Sum256([]byte("whombat-licence-TEST-key/1\n" + label))
	return Signer{Kid: kid, Priv: ed25519.NewKeyFromSeed(seed[:])}
}

// JWK is the signer's public key as the key set carries it.
func (s Signer) JWK() protocol.Ed25519Jwk {
	alg, use := "EdDSA", "sig"
	return protocol.Ed25519Jwk{Kty: "OKP", Crv: "Ed25519", Kid: s.Kid,
		X: base64.RawURLEncoding.EncodeToString(s.Priv.Public().(ed25519.PublicKey)), Alg: &alg, Use: &use}
}

// KeySet is a LicenceKeySet of env with the signers' keys.
func KeySet(env string, signers ...Signer) protocol.LicenceKeySet {
	ks := protocol.LicenceKeySet{V: 1, Env: env}
	for _, s := range signers {
		ks.Keys = append(ks.Keys, s.JWK())
	}
	return ks
}

// WriteKeySet writes a key set file (0444, like /etc/whombat/licence-keys.json) and returns its path.
func WriteKeySet(dir string, ks protocol.LicenceKeySet) (string, error) {
	b, err := json.Marshal(ks)
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "licence-keys.json")
	_ = os.Remove(p)
	return p, os.WriteFile(p, b, 0o444)
}

// Claims builds valid claims for device in env: issued at iat, living ttl seconds.
func Claims(env, device, org, state string, iat, ttl int64) protocol.LicenceClaims {
	jti := make([]byte, 16)
	_, _ = rand.Read(jti)
	connectors := int64(50)
	return protocol.LicenceClaims{Iss: "https://control.test", Aud: protocol.LicenceAudience(env), Sub: device, Org: org,
		Plan: "whombat", State: protocol.EntitlementState(state),
		Limits: protocol.LicenceLimits{Devices: 1, Connectors: &connectors}, Iat: iat, Nbf: iat, Exp: iat + ttl,
		Jti: base64.RawURLEncoding.EncodeToString(jti)}
}

// Sign encodes a compact JWS with the licence header (typ may be overridden, e.g. an admission typ).
func (s Signer) Sign(c protocol.LicenceClaims) string { return s.SignTyp(c, protocol.LicenceTyp) }

// SignTyp is Sign with another typ in the header.
func (s Signer) SignTyp(c protocol.LicenceClaims, typ string) string {
	h, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": s.Kid, "typ": typ})
	p, _ := json.Marshal(c)
	in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	return in + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.Priv, []byte(in)))
}
