package release

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/CybexBV/whombat/contracts/go/internal/canon"
	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
)

// TupleDigest is `sha256:<hex>` of the tuple's canonical JSON (tupleDigest in @whombat/release).
func TupleDigest(t *ReleaseTuple) (string, error) {
	c, err := canon.Value(t)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// AssignmentErrorCode mirrors AssignmentError in @whombat/release.
type AssignmentErrorCode string

const (
	AssignmentBadSchema    AssignmentErrorCode = "bad_schema"
	AssignmentUnknownKey   AssignmentErrorCode = "unknown_key"
	AssignmentBadSignature AssignmentErrorCode = "bad_signature"
	AssignmentWrongEnv     AssignmentErrorCode = "wrong_env"
	AssignmentWrongDevice  AssignmentErrorCode = "wrong_device"
	AssignmentBadAction    AssignmentErrorCode = "bad_action"
	AssignmentBadLifetime  AssignmentErrorCode = "bad_lifetime"
	AssignmentExpired      AssignmentErrorCode = "expired"
	AssignmentNotYetValid  AssignmentErrorCode = "not_yet_valid"
	AssignmentReplayed     AssignmentErrorCode = "replayed"
)

// AssignmentError is returned by VerifyAssignment.
type AssignmentError struct{ Code AssignmentErrorCode }

func (e *AssignmentError) Error() string { return "assignment: " + string(e.Code) }

// AssignmentContext configures VerifyAssignment.
type AssignmentContext struct {
	// Keys maps assignment key ids to raw Ed25519 public keys.
	Keys         map[string]ed25519.PublicKey
	Env          Environment
	Device       string
	Now          int64
	LastSequence int64
	// ClockSkewS defaults to 300 when 0.
	ClockSkewS int64
}

// VerifyAssignment checks a signed assignment like verifyAssignment in @whombat/release. It does not check the
// tuple against TUF: the caller must also find `releaseId` with `tupleDigest` in verified TUF metadata.
func VerifyAssignment(raw []byte, ctx AssignmentContext) (*SignedAssignment, error) {
	fail := func(c AssignmentErrorCode) (*SignedAssignment, error) { return nil, &AssignmentError{Code: c} }
	if err := schemas.Validate("SignedAssignment", raw); err != nil {
		return fail(AssignmentBadSchema)
	}
	var doc struct {
		Payload json.RawMessage `json:"payload"`
		KeyID   string          `json:"keyId"`
		Sig     string          `json:"sig"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fail(AssignmentBadSchema)
	}
	key, ok := ctx.Keys[doc.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return fail(AssignmentUnknownKey)
	}
	msg, err := canon.JSON(doc.Payload)
	sig, herr := hex.DecodeString(doc.Sig)
	if err != nil || herr != nil || !ed25519strict.Verify(key, msg, sig) {
		return fail(AssignmentBadSignature)
	}
	out := new(SignedAssignment)
	if err := json.Unmarshal(raw, out); err != nil {
		return fail(AssignmentBadSchema)
	}
	p := out.Payload
	if p.Env != ctx.Env {
		return fail(AssignmentWrongEnv)
	}
	if p.Device != ctx.Device {
		return fail(AssignmentWrongDevice)
	}
	install := p.Action == "install"
	if install != (p.ReleaseID != nil) || install != (p.TupleDigest != nil) {
		return fail(AssignmentBadAction)
	}
	if p.ExpiresAt <= p.IssuedAt || p.ExpiresAt-p.IssuedAt > AssignmentMaxLifetimeS || p.NotBefore < p.IssuedAt {
		return fail(AssignmentBadLifetime)
	}
	skew := ctx.ClockSkewS
	if skew == 0 {
		skew = 300
	}
	if p.IssuedAt > ctx.Now+skew {
		return fail(AssignmentNotYetValid)
	}
	if ctx.Now >= p.ExpiresAt+skew {
		return fail(AssignmentExpired)
	}
	if p.Sequence <= ctx.LastSequence {
		return fail(AssignmentReplayed)
	}
	return out, nil
}

// CanTransition reports whether the update journal may move from one state to another (MA-11).
func CanTransition(from, to UpdateJournalState) bool {
	for _, s := range UpdateJournalTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}
