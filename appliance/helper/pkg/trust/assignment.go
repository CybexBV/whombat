package trust

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Assignment error classes. The underlying *release.AssignmentError (contract code) stays in the
// error chain.
var (
	ErrAssignmentSignature = errors.New("assignment signature invalid")
	ErrAssignmentScope     = errors.New("assignment is not for this device or environment")
	ErrAssignmentTime      = errors.New("assignment not yet valid or expired")
	ErrAssignmentReplay    = errors.New("assignment sequence replayed")
	ErrAssignmentMismatch  = errors.New("assignment does not match the approved tuple")
	ErrAssignmentHold      = errors.New("assignment is a hold")
)

// KeySet is the set of assignment keys a device trusts right now: from the TUF-verified
// `AssignmentKeys` document for the device's environment, release.AssignmentKeyMap (CT-41) accepts
// every active key, next keys once notBefore has passed and retired keys until notAfter; an invalid
// document refuses everything. Control's `GET /v1/assignment/keys` is never consulted (MG-21).
type KeySet struct {
	Keys map[string]ed25519.PublicKey
}

// AssignmentKeysDocument returns the verified AssignmentKeys document and its canonical bytes. The
// target content is the document's canonical JSON; the custom metadata carries the document and
// must hash to the signed target (like release tuples).
func (r *Repo) AssignmentKeysDocument() (*release.AssignmentKeys, []byte, error) {
	tf, ok := r.top[AssignmentKeysTarget]
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s", ErrNotApproved, AssignmentKeysTarget)
	}
	raw, kind, err := whombatCustom(tf.Custom)
	if err != nil || kind != KindAssignmentKeys {
		return nil, nil, fmt.Errorf("%w: assignment keys: %v", ErrInvalidMetadata, err)
	}
	var c assignmentKeysCustom
	if err := strictUnmarshal(raw, &c); err != nil {
		return nil, nil, fmt.Errorf("%w: assignment keys: %v", ErrInvalidMetadata, err)
	}
	doc, err := release.ParseAssignmentKeys(c.Document)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: assignment keys: %v", ErrInvalidMetadata, err)
	}
	canon, err := canonjson.Marshal(doc)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	if err := tf.VerifyLengthHashes(canon); err != nil {
		return nil, nil, fmt.Errorf("%w: assignment keys document does not match the signed target: %v", ErrInvalidMetadata, err)
	}
	return doc, canon, nil
}

// AssignmentKeys returns the keys trusted for env at time now.
func (r *Repo) AssignmentKeys(env string, now time.Time) (*KeySet, error) {
	_, canon, err := r.AssignmentKeysDocument()
	if err != nil {
		return nil, err
	}
	m, err := release.AssignmentKeyMap(canon, release.Environment(env), now.Unix())
	if err != nil {
		// *release.AssignmentKeysError stays in the chain (code: wrong_env, no_active_key, …).
		return nil, errors.Join(ErrInvalidMetadata, err)
	}
	ks := &KeySet{Keys: map[string]ed25519.PublicKey{}}
	for kid, h := range m {
		pub, err := hex.DecodeString(h)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%w: assignment key %q", ErrInvalidMetadata, kid)
		}
		ks.Keys[kid] = pub
	}
	return ks, nil
}

// SignAssignment signs a payload in the contract format {payload, keyId, sig=hex(Ed25519(JCS(payload)))}.
// Used by release-tools for development fixtures and by tests; control signs production assignments.
func SignAssignment(p release.AssignmentPayload, keyID string, key ed25519.PrivateKey) ([]byte, error) {
	body, err := canonjson.Marshal(p)
	if err != nil {
		return nil, err
	}
	return json.Marshal(release.SignedAssignment{Payload: p, KeyID: keyID, Sig: hex.EncodeToString(ed25519.Sign(key, body))})
}

// VerifyParams are the device-side expectations for an assignment.
type VerifyParams struct {
	DeviceID string
	Env      string
	Now      time.Time
	// LastSequence is the highest sequence already accepted; the assignment must be strictly greater.
	LastSequence int64
	MaxClockSkew time.Duration
}

// VerifyAssignment verifies a raw signed assignment with the contract verifier (@whombat/release
// verifyAssignment semantics) against the TUF-published keys of the device's environment.
func VerifyAssignment(raw []byte, ks *KeySet, p VerifyParams) (*release.SignedAssignment, error) {
	sa, err := release.VerifyAssignment(raw, release.AssignmentContext{Keys: ks.Keys, Env: release.Environment(p.Env),
		Device: p.DeviceID, Now: p.Now.Unix(), LastSequence: p.LastSequence, ClockSkewS: int64(p.MaxClockSkew / time.Second)})
	if err == nil {
		return sa, nil
	}
	var ae *release.AssignmentError
	if !errors.As(err, &ae) {
		return nil, fmt.Errorf("%w: %v", ErrAssignmentSignature, err)
	}
	switch ae.Code {
	case release.AssignmentWrongEnv, release.AssignmentWrongDevice:
		return nil, errors.Join(ErrAssignmentScope, err)
	case release.AssignmentBadLifetime, release.AssignmentExpired, release.AssignmentNotYetValid:
		return nil, errors.Join(ErrAssignmentTime, err)
	case release.AssignmentReplayed:
		return nil, errors.Join(ErrAssignmentReplay, err)
	default:
		return nil, errors.Join(ErrAssignmentSignature, err)
	}
}

// CheckAgainst verifies that an install assignment names exactly this approved release tuple.
func CheckAgainst(p *release.AssignmentPayload, rel *Release) error {
	if p.Action != "install" || p.ReleaseID == nil || p.TupleDigest == nil {
		return fmt.Errorf("%w: action %s", ErrAssignmentHold, p.Action)
	}
	if *p.ReleaseID != rel.Tuple.ReleaseID || *p.TupleDigest != rel.Digest {
		return fmt.Errorf("%w: assignment %s/%s, tuple %s/%s", ErrAssignmentMismatch, *p.ReleaseID, *p.TupleDigest, rel.Tuple.ReleaseID, rel.Digest)
	}
	return nil
}
