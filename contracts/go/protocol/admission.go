package protocol

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
)

// AdmissionErrorCode mirrors AdmissionErrorCode in @whombat/protocol.
type AdmissionErrorCode string

const (
	AdmissionMalformed    AdmissionErrorCode = "malformed"
	AdmissionBadHeader    AdmissionErrorCode = "bad_header"
	AdmissionUnknownKid   AdmissionErrorCode = "unknown_kid"
	AdmissionBadSignature AdmissionErrorCode = "bad_signature"
	AdmissionBadClaims    AdmissionErrorCode = "bad_claims"
	AdmissionWrongAud     AdmissionErrorCode = "wrong_audience"
	AdmissionWrongIssuer  AdmissionErrorCode = "wrong_issuer"
	AdmissionWrongRole    AdmissionErrorCode = "wrong_role"
	AdmissionWrongWorker  AdmissionErrorCode = "wrong_worker"
	AdmissionBadLifetime  AdmissionErrorCode = "bad_lifetime"
	AdmissionNotYetValid  AdmissionErrorCode = "not_yet_valid"
	AdmissionExpired      AdmissionErrorCode = "expired"
)

// AdmissionError is returned by VerifyAdmissionTicket; CloseCode maps it to the WebSocket close code.
type AdmissionError struct{ Code AdmissionErrorCode }

// CloseCode is the relay close code for the failure: wrong_role → 4403, wrong_worker → 4421, else 4401.
func (e *AdmissionError) CloseCode() int {
	if c, ok := AdmissionErrorClose[string(e.Code)]; ok {
		return c
	}
	return RelayCloseBadTicket
}

func (e *AdmissionError) Error() string { return "admission ticket: " + string(e.Code) }

// VerifyAdmissionOptions configures VerifyAdmissionTicket.
type VerifyAdmissionOptions struct {
	JWKS AdmissionJwks
	// Now is the current time in seconds since the epoch.
	Now int64
	// Audience is the expected `aud` (`whombat-relay:<env>`).
	Audience string
	// Issuer is the expected `iss`; empty skips the check.
	Issuer string
	// Role is the expected `rol`; empty skips the check.
	Role TicketRole
	// Worker is this relay worker's id; a ticket naming another worker fails with wrong_worker. Empty skips.
	Worker string
	// ClockSkewS is the tolerated skew in seconds; 0 means TicketClockSkewS (30).
	ClockSkewS int64
}

var segment = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.Strict().DecodeString(s) }

func jsonSegment(s string) ([]byte, bool) {
	raw, err := b64(s)
	if err != nil || !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, false
	}
	return raw, true
}

// VerifyAdmissionTicket verifies a compact-JWS admission ticket exactly like verifyAdmissionTicket in
// @whombat/protocol: structure, header, key, Ed25519 signature, claims schema, audience/issuer/role, then time
// bounds. Single use of client tickets (`jti` until `exp`) is the caller's job.
func VerifyAdmissionTicket(token string, opts VerifyAdmissionOptions) (*AdmissionHeader, *AdmissionClaims, error) {
	fail := func(c AdmissionErrorCode) (*AdmissionHeader, *AdmissionClaims, error) {
		return nil, nil, &AdmissionError{Code: c}
	}
	if len(token) > RelayMaxTicketBytes {
		return fail(AdmissionMalformed)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fail(AdmissionMalformed)
	}
	for _, p := range parts {
		if !segment.MatchString(p) {
			return fail(AdmissionMalformed)
		}
	}
	rawHeader, ok := jsonSegment(parts[0])
	if !ok {
		return fail(AdmissionMalformed)
	}
	sig, err := b64(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fail(AdmissionMalformed)
	}
	header, err := ParseAdmissionHeader(rawHeader)
	if err != nil {
		return fail(AdmissionBadHeader)
	}
	var pub []byte
	found := false
	for _, k := range opts.JWKS.Keys {
		if k.Kid == header.Kid {
			found = true
			pub, err = b64(k.X)
			break
		}
	}
	if !found || err != nil || len(pub) != ed25519.PublicKeySize {
		return fail(AdmissionUnknownKid)
	}
	if !ed25519strict.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return fail(AdmissionBadSignature)
	}
	rawClaims, ok := jsonSegment(parts[1])
	if !ok {
		return fail(AdmissionMalformed)
	}
	if err := schemas.Validate("AdmissionClaims", rawClaims); err != nil {
		return fail(AdmissionBadClaims)
	}
	claims := new(AdmissionClaims)
	if err := json.Unmarshal(rawClaims, claims); err != nil {
		return fail(AdmissionBadClaims)
	}
	if claims.Aud != opts.Audience {
		return fail(AdmissionWrongAud)
	}
	if opts.Issuer != "" && claims.Iss != opts.Issuer {
		return fail(AdmissionWrongIssuer)
	}
	if opts.Role != "" && claims.Rol != opts.Role {
		return fail(AdmissionWrongRole)
	}
	if opts.Worker != "" && claims.Wrk != opts.Worker {
		return fail(AdmissionWrongWorker)
	}
	if claims.Nbf < claims.Iat || claims.Exp <= claims.Nbf || claims.Exp-claims.Iat > TicketMaxLifetimeS {
		return fail(AdmissionBadLifetime)
	}
	skew := opts.ClockSkewS
	if skew == 0 {
		skew = TicketClockSkewS
	}
	if claims.Iat > opts.Now+skew || claims.Nbf > opts.Now+skew {
		return fail(AdmissionNotYetValid)
	}
	if opts.Now >= claims.Exp+skew {
		return fail(AdmissionExpired)
	}
	return header, claims, nil
}
