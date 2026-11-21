package protocol

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
)

// LicenceErrorCode mirrors LicenceErrorCode in @whombat/protocol.
type LicenceErrorCode string

const (
	LicenceMalformed     LicenceErrorCode = "malformed"
	LicenceBadHeader     LicenceErrorCode = "bad_header"
	LicenceUnknownKid    LicenceErrorCode = "unknown_kid"
	LicenceBadSignature  LicenceErrorCode = "bad_signature"
	LicenceBadClaims     LicenceErrorCode = "bad_claims"
	LicenceWrongAudience LicenceErrorCode = "wrong_audience"
	LicenceWrongDevice   LicenceErrorCode = "wrong_device"
	LicenceBadLifetime   LicenceErrorCode = "bad_lifetime"
	LicenceNotYetValid   LicenceErrorCode = "not_yet_valid"
)

// LicenceError is returned by VerifyLicenceToken.
type LicenceError struct{ Code LicenceErrorCode }

func (e *LicenceError) Error() string { return "licence token: " + string(e.Code) }

// LicenceAudience is the audience a key set's tokens must carry: "whombat-appliance:<env>".
func LicenceAudience(env string) string { return LicenceAudiencePrefix + env }

// VerifyLicenceOptions configures VerifyLicenceToken.
type VerifyLicenceOptions struct {
	// KeySet is the pinned key set (ParseLicenceKeySet).
	KeySet LicenceKeySet
	// Device is this appliance's device id; the token's `sub` must equal it.
	Device string
	// Now is the caller's effective time in seconds since the epoch.
	Now int64
}

// VerifyLicenceToken verifies a licence token exactly like verifyLicenceToken in @whombat/protocol (LC-01):
// structure, header, key, strict Ed25519 signature, claims schema, audience, device, lifetime (nbf ≥ iat, exp > nbf,
// exp − iat ≤ 14 days) and iat/nbf ≤ Now + 300 s. An expired token passes; LicenceStatus computes its state.
func VerifyLicenceToken(token string, opts VerifyLicenceOptions) (*LicenceHeader, *LicenceClaims, error) {
	fail := func(c LicenceErrorCode) (*LicenceHeader, *LicenceClaims, error) {
		return nil, nil, &LicenceError{Code: c}
	}
	if len(token) > LicenceMaxBytes {
		return fail(LicenceMalformed)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fail(LicenceMalformed)
	}
	for _, p := range parts {
		if !segment.MatchString(p) {
			return fail(LicenceMalformed)
		}
	}
	rawHeader, ok := jsonSegment(parts[0])
	if !ok {
		return fail(LicenceMalformed)
	}
	sig, err := b64(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fail(LicenceMalformed)
	}
	header, err := ParseLicenceHeader(rawHeader)
	if err != nil {
		return fail(LicenceBadHeader)
	}
	var pub []byte
	found := false
	for _, k := range opts.KeySet.Keys {
		if k.Kid == header.Kid {
			found = true
			pub, err = b64(k.X)
			break
		}
	}
	if !found || err != nil || len(pub) != ed25519.PublicKeySize {
		return fail(LicenceUnknownKid)
	}
	if !ed25519strict.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return fail(LicenceBadSignature)
	}
	rawClaims, ok := jsonSegment(parts[1])
	if !ok {
		return fail(LicenceMalformed)
	}
	if err := schemas.Validate("LicenceClaims", rawClaims); err != nil {
		return fail(LicenceBadClaims)
	}
	claims := new(LicenceClaims)
	if err := json.Unmarshal(rawClaims, claims); err != nil {
		return fail(LicenceBadClaims)
	}
	if claims.Aud != LicenceAudience(opts.KeySet.Env) {
		return fail(LicenceWrongAudience)
	}
	if claims.Sub != opts.Device {
		return fail(LicenceWrongDevice)
	}
	if claims.Nbf < claims.Iat || claims.Exp <= claims.Nbf || claims.Exp-claims.Iat > LicenceLifetimeS {
		return fail(LicenceBadLifetime)
	}
	if claims.Iat > opts.Now+LicenceClockSkewS || claims.Nbf > opts.Now+LicenceClockSkewS {
		return fail(LicenceNotYetValid)
	}
	return header, claims, nil
}

// LicenceStatusParams is the input of LicenceStatus (epoch seconds).
type LicenceStatusParams struct {
	// Claims of the stored token that passed VerifyLicenceToken; nil: none.
	Claims *LicenceClaims
	// Now is the local clock.
	Now int64
	// HighWater is the manager's mark (max of accepted iats and control's now), LC-06.
	HighWater int64
	// ClockMark is the runtime's own mark, LC-07.
	ClockMark int64
	// ClaimedAt is when the appliance was claimed; nil: unclaimed.
	ClaimedAt *int64
	// GraceS is the grace after exp; 0 means LicenceGraceS.
	GraceS int64
}

// LicenceStatus computes the licence state exactly like licenceStatus in @whombat/protocol (LC-09). It returns nil for
// an unclaimed appliance without a token.
func LicenceStatus(in LicenceStatusParams) *LicenceStatusResult {
	grace := in.GraceS
	if grace == 0 {
		grace = LicenceGraceS
	}
	t := max(in.Now, in.HighWater, in.ClockMark)
	c := in.Claims
	if c == nil {
		if in.ClaimedAt == nil {
			return nil
		}
		ends := *in.ClaimedAt + grace
		state := LicenceStateGrace
		if t >= ends {
			state = LicenceStateLapsed
		}
		return &LicenceStatusResult{State: state, Reason: LicenceReasonNoLicence, GraceEndsAt: &ends, EffectiveAt: t}
	}
	plan, limits, iat, exp := c.Plan, c.Limits, c.Iat, c.Exp
	r := &LicenceStatusResult{Plan: &plan, Limits: &limits, RenewedAt: &iat, ExpiresAt: &exp, EffectiveAt: t}
	if c.State == EntitlementStateCancelled {
		r.State, r.Reason = LicenceStateLapsed, LicenceReasonCancelled
		return r
	}
	ends := c.Exp + grace
	r.GraceEndsAt = &ends
	switch {
	case t < c.Exp:
		switch c.State {
		case EntitlementStateTrialing:
			r.State, r.Reason = LicenceStateLicensed, LicenceReasonTrial
		case EntitlementStateActive:
			r.State, r.Reason = LicenceStateLicensed, LicenceReasonActive
		case EntitlementStatePastDue:
			r.State, r.Reason = LicenceStateLicensed, LicenceReasonPastDue
		default: // grace
			r.State, r.Reason = LicenceStateGrace, LicenceReasonPayment
		}
	case t < ends:
		r.State, r.Reason = LicenceStateGrace, LicenceReasonNotRenewed
	default:
		r.State, r.Reason = LicenceStateLapsed, LicenceReasonExpired
	}
	return r
}
