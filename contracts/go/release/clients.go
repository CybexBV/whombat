package release

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"

	"github.com/CybexBV/whombat/contracts/go/internal/canon"
	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
)

// ClientChannelErrorCode mirrors ClientChannelError in @whombat/release (CT-74).
type ClientChannelErrorCode string

const (
	ClientChannelBadSchema       ClientChannelErrorCode = "bad_schema"
	ClientChannelUnknownKey      ClientChannelErrorCode = "unknown_key"
	ClientChannelBadSignature    ClientChannelErrorCode = "bad_signature"
	ClientChannelWrongEnv        ClientChannelErrorCode = "wrong_env"
	ClientChannelBadLifetime     ClientChannelErrorCode = "bad_lifetime"
	ClientChannelExpired         ClientChannelErrorCode = "expired"
	ClientChannelNotYetValid     ClientChannelErrorCode = "not_yet_valid"
	ClientChannelRolledBack      ClientChannelErrorCode = "rolled_back"
	ClientChannelBadBundle       ClientChannelErrorCode = "bad_bundle"
	ClientChannelDuplicateBundle ClientChannelErrorCode = "duplicate_bundle"
)

// ClientChannelError is returned by VerifyClientChannel.
type ClientChannelError struct{ Code ClientChannelErrorCode }

func (e *ClientChannelError) Error() string { return "client channel: " + string(e.Code) }

// ClientChannelContext configures VerifyClientChannel.
type ClientChannelContext struct {
	// Keys maps channel key ids to raw Ed25519 public keys (resolve a pinned key document with AssignmentKeyMap).
	Keys map[string]ed25519.PublicKey
	Env  Environment
	Now  int64
	// LastSequence is the highest sequence accepted so far; the same sequence again is fine.
	LastSequence int64
	// ClockSkewS defaults to 300 when 0.
	ClockSkewS int64
}

// ClientBundleTarget is the TUF target path of a bundle's artifact (clientBundleTarget in @whombat/release).
func ClientBundleTarget(provider ClientProvider, version string, os ClientOs, arch ClientArch) string {
	return "clients/" + string(provider) + "/" + version + "/" + string(os) + "-" + string(arch) + ".tar.gz"
}

// VerifyClientChannel checks a signed client channel like verifyClientChannel in @whombat/release: schema, key,
// signature, environment, lifetime, time (with skew), sequence (not below LastSequence) and each bundle's
// consistency and uniqueness. On an appliance the caller has also found it as the TUF target ClientChannelTarget.
func VerifyClientChannel(raw []byte, ctx ClientChannelContext) (*SignedClientChannel, error) {
	fail := func(c ClientChannelErrorCode) (*SignedClientChannel, error) {
		return nil, &ClientChannelError{Code: c}
	}
	if err := schemas.Validate("SignedClientChannel", raw); err != nil {
		return fail(ClientChannelBadSchema)
	}
	var doc struct {
		Payload json.RawMessage `json:"payload"`
		KeyID   string          `json:"keyId"`
		Sig     string          `json:"sig"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fail(ClientChannelBadSchema)
	}
	key, ok := ctx.Keys[doc.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return fail(ClientChannelUnknownKey)
	}
	msg, err := canon.JSON(doc.Payload)
	sig, herr := hex.DecodeString(doc.Sig)
	if err != nil || herr != nil || !ed25519strict.Verify(key, msg, sig) {
		return fail(ClientChannelBadSignature)
	}
	out := new(SignedClientChannel)
	if err := json.Unmarshal(raw, out); err != nil {
		return fail(ClientChannelBadSchema)
	}
	p := out.Payload
	if p.Env != ctx.Env {
		return fail(ClientChannelWrongEnv)
	}
	if p.ExpiresAt <= p.IssuedAt || p.ExpiresAt-p.IssuedAt > ClientChannelMaxLifetimeS {
		return fail(ClientChannelBadLifetime)
	}
	skew := ctx.ClockSkewS
	if skew == 0 {
		skew = 300
	}
	if p.IssuedAt > ctx.Now+skew {
		return fail(ClientChannelNotYetValid)
	}
	if ctx.Now >= p.ExpiresAt+skew {
		return fail(ClientChannelExpired)
	}
	if p.Sequence < ctx.LastSequence {
		return fail(ClientChannelRolledBack)
	}
	seen := map[string]bool{}
	for _, b := range p.Bundles {
		if b.Artifact.Target != ClientBundleTarget(b.Provider, b.Version, b.Os, b.Arch) ||
			b.Adapter.Min > b.Adapter.Max ||
			b.TestedAt < b.PublishedAt ||
			(b.Source.Format == "tar.gz") != (b.Source.Path != nil) {
			return fail(ClientChannelBadBundle)
		}
		id := string(b.Provider) + "/" + b.Version + "/" + string(b.Os) + "-" + string(b.Arch)
		if seen[id] {
			return fail(ClientChannelDuplicateBundle)
		}
		seen[id] = true
	}
	return out, nil
}

// SelectClientBundle returns the first (most preferred) bundle of provider for os/arch whose adapter range includes
// adapter, or nil (selectClientBundle in @whombat/release).
func SelectClientBundle(bundles []ClientBundle, provider ClientProvider, os ClientOs, arch ClientArch, adapter int64) *ClientBundle {
	for i := range bundles {
		b := &bundles[i]
		if b.Provider == provider && b.Os == os && b.Arch == arch && b.Adapter.Min <= adapter && adapter <= b.Adapter.Max {
			return b
		}
	}
	return nil
}
