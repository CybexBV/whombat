package device

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/internal/canon"
	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// SigningBytes returns the canonical JSON the management key signs for a device request
// ({purpose, v, aud, device, op, ts, nonce, body}), identical to deviceRequestSigningBytes in TypeScript.
func SigningBytes(env *DeviceRequestEnvelope) ([]byte, error) {
	body := env.Body
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}
	return canon.Value(map[string]any{
		"purpose": DeviceRequestPurpose,
		"v":       env.V,
		"aud":     env.Aud,
		"device":  env.Device,
		"op":      env.Op,
		"ts":      env.Ts,
		"nonce":   env.Nonce,
		"body":    body,
	})
}

// SignDeviceRequest builds and signs an envelope. body must marshal to the op's request schema
// (e.g. *StatusReportRequest for "status.report"); it is validated before signing.
func SignDeviceRequest(aud, device string, op DeviceOpName, ts int64, nonce string, body any, key ed25519.PrivateKey) (*DeviceRequestEnvelope, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if err := schemas.Validate(requestSchema(op), raw); err != nil {
		return nil, err
	}
	env := &DeviceRequestEnvelope{V: 1, Aud: aud, Device: device, Op: op, Ts: ts, Nonce: nonce, Body: raw}
	msg, err := SigningBytes(env)
	if err != nil {
		return nil, err
	}
	env.Sig = hex.EncodeToString(ed25519.Sign(key, msg))
	return env, env.Validate()
}

// DeviceRequestMaxBytesFor is the size limit of one op's request (canonical JSON of the signed envelope), like
// deviceRequestMaxBytes in TypeScript: FeedbackCardsSyncMaxBytes for "feedback.cards.sync", SharePutMaxBytes
// for "share.put", else DeviceRequestMaxBytes (CT-91).
func DeviceRequestMaxBytesFor(op DeviceOpName) int {
	if op == DeviceOpNameFeedbackCardsSync {
		return FeedbackCardsSyncMaxBytes
	}
	if op == DeviceOpNameSharePut {
		return SharePutMaxBytes
	}
	return DeviceRequestMaxBytes
}

// requestSchema is the registry name of an op's request body: "status.report" → "StatusReportRequest".
func requestSchema(op DeviceOpName) string {
	var b strings.Builder
	for _, part := range strings.FieldsFunc(string(op), func(r rune) bool { return r == '.' || r == '_' || r == '-' }) {
		b.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return b.String() + "Request"
}

// DeviceRequestErrorCode mirrors DeviceRequestError in @whombat/control-contracts.
type DeviceRequestErrorCode string

const (
	DeviceRequestBadEnvelope   DeviceRequestErrorCode = "bad_envelope"
	DeviceRequestTooLarge      DeviceRequestErrorCode = "too_large"
	DeviceRequestWrongAudience DeviceRequestErrorCode = "wrong_audience"
	DeviceRequestUnknownDevice DeviceRequestErrorCode = "unknown_device"
	DeviceRequestBadSignature  DeviceRequestErrorCode = "bad_signature"
	DeviceRequestStale         DeviceRequestErrorCode = "stale"
	DeviceRequestReplayed      DeviceRequestErrorCode = "replayed"
	DeviceRequestBadBody       DeviceRequestErrorCode = "bad_body"
)

// DeviceRequestError is returned by VerifyDeviceRequest.
type DeviceRequestError struct{ Code DeviceRequestErrorCode }

func (e *DeviceRequestError) Error() string { return "device request: " + string(e.Code) }

// DeviceRequestContext configures VerifyDeviceRequest.
type DeviceRequestContext struct {
	Audience string
	Now      int64
	// PublicKeyOf returns the device's current management key, or false if unknown/retired.
	PublicKeyOf func(device string) (ed25519.PublicKey, bool)
	// ClaimNonce records (device, nonce) and returns false if it was already seen within DeviceNonceTTLS.
	ClaimNonce func(device, nonce string) bool
	// MaxSkewS defaults to DeviceRequestMaxSkewS when 0.
	MaxSkewS int64
}

// VerifyDeviceRequest verifies an envelope like verifyDeviceRequest in TypeScript (same order of checks).
func VerifyDeviceRequest(raw []byte, ctx DeviceRequestContext) (*DeviceRequestEnvelope, error) {
	fail := func(c DeviceRequestErrorCode) (*DeviceRequestEnvelope, error) {
		return nil, &DeviceRequestError{Code: c}
	}
	env, err := ParseDeviceRequestEnvelope(raw)
	if err != nil {
		return fail(DeviceRequestBadEnvelope)
	}
	msg, err := SigningBytes(env)
	if err != nil {
		return fail(DeviceRequestBadEnvelope)
	}
	if len(msg) > DeviceRequestMaxBytesFor(env.Op) {
		return fail(DeviceRequestTooLarge)
	}
	if env.Aud != ctx.Audience {
		return fail(DeviceRequestWrongAudience)
	}
	key, ok := ctx.PublicKeyOf(env.Device)
	if !ok {
		return fail(DeviceRequestUnknownDevice)
	}
	sig, err := hex.DecodeString(env.Sig)
	if err != nil || !ed25519strict.Verify(key, msg, sig) {
		return fail(DeviceRequestBadSignature)
	}
	skew := ctx.MaxSkewS
	if skew == 0 {
		skew = DeviceRequestMaxSkewS
	}
	if d := ctx.Now - env.Ts; d > skew || d < -skew {
		return fail(DeviceRequestStale)
	}
	if !ctx.ClaimNonce(env.Device, env.Nonce) {
		return fail(DeviceRequestReplayed)
	}
	if err := schemas.Validate(requestSchema(env.Op), env.Body); err != nil {
		return fail(DeviceRequestBadBody)
	}
	return env, nil
}

// RegistrationSigningBytes is what the management key signs to prove possession at provisioning.
func RegistrationSigningBytes(r *DeviceRegistration) ([]byte, error) {
	return canon.Value(map[string]any{
		"purpose":             RegistrationPurpose,
		"env":                 r.Env,
		"hardwareSerial":      r.HardwareSerial,
		"model":               r.Model,
		"managementPublicKey": r.ManagementPublicKey,
		"contentPeerId":       r.ContentPeerID,
		"contentPublicKey":    r.ContentPublicKey,
		"provisionedAt":       r.ProvisionedAt,
	})
}

// SignRegistration fills r.Proof and r.ContentProof with the management and content keys' signatures.
func SignRegistration(r *DeviceRegistration, management, content ed25519.PrivateKey) error {
	msg, err := RegistrationSigningBytes(r)
	if err != nil {
		return err
	}
	r.Proof = hex.EncodeToString(ed25519.Sign(management, msg))
	r.ContentProof = hex.EncodeToString(ed25519.Sign(content, msg))
	return r.Validate()
}

// VerifyRegistration checks both proofs (strict Ed25519) and that ContentPeerID is the PeerId of
// ContentPublicKey, like verifyRegistration in TypeScript.
func VerifyRegistration(r *DeviceRegistration) bool {
	if r.ManagementPublicKey == r.ContentPublicKey {
		return false
	}
	contentKey, err := hex.DecodeString(r.ContentPublicKey)
	if err != nil || len(contentKey) != ed25519.PublicKeySize {
		return false
	}
	if id, err := protocol.PeerIDFromEd25519PublicKey(contentKey); err != nil || id != r.ContentPeerID {
		return false
	}
	msg, err := RegistrationSigningBytes(r)
	if err != nil {
		return false
	}
	mgmt, err1 := hex.DecodeString(r.ManagementPublicKey)
	proof, err2 := hex.DecodeString(r.Proof)
	contentProof, err3 := hex.DecodeString(r.ContentProof)
	return err1 == nil && err2 == nil && err3 == nil &&
		ed25519strict.Verify(mgmt, msg, proof) && ed25519strict.Verify(contentKey, msg, contentProof)
}

// AssignmentResultValid reports whether an `update.assignment` answer is consistent: an assignment is present
// exactly when the result is "assigned" (CT-28).
func AssignmentResultValid(r *UpdateAssignmentResponse) bool {
	return (r.Result == "assigned") == (r.Assignment != nil)
}
