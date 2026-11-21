package protocol

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"regexp"
)

// The claim PAKE (CC-06), identical to pake.ts in @whombat/protocol: CPace with PRS = the password,
// CI = lv_cat("whombat-claim/1", method, deviceId, appliancePeerId, clientPeerId), sid = the claim id, empty AD,
// the client as initiator; k = HKDF-SHA512(ISK, info "whombat-claim-confirm/1", 64 bytes);
// tagClient/tagAppliance = HMAC-SHA512(k, "client"/"appliance" || transcript)[:32], base64url without padding.

// ClaimPakeCITag, ClaimConfirmInfo and ClaimConfirmTagBytes are in constants_gen.go.

const (
	// ClaimMethodCode and ClaimMethodCard are the claim methods (CC-02).
	ClaimMethodCode = "code"
	ClaimMethodCard = "card"
)

var (
	// ErrClaimPakeInvalidShare: the peer's share is malformed or invalid (abort; on the appliance, refuse the
	// begin with claim_share_invalid — it is not a guess).
	ErrClaimPakeInvalidShare = errors.New("claim pake: invalid share")
	// ErrClaimPakeInvalidPassword: the password doesn't fit the method (or the method is unknown).
	ErrClaimPakeInvalidPassword = errors.New("claim pake: the password has the wrong shape")

	b64Tag    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	b64Strict = base64.RawURLEncoding.Strict()
)

// ClaimPakeContext is everything both sides must agree on besides the shares.
type ClaimPakeContext struct {
	// Method is ClaimMethodCode or ClaimMethodCard.
	Method string
	// Password: the 4 letters (code), or ClaimCardPassword(deviceID, normalized secret) for card (CT-66).
	Password        string
	DeviceID        string
	AppliancePeerID string
	ClientPeerID    string
	ClaimID         string
}

// ClaimPakeCI is lv_cat("whombat-claim/1", method, deviceId, appliancePeerId, clientPeerId).
func ClaimPakeCI(c ClaimPakeContext) []byte {
	return CPaceLVCat([]byte(ClaimPakeCITag), []byte(c.Method), []byte(c.DeviceID), []byte(c.AppliancePeerID),
		[]byte(c.ClientPeerID))
}

// ClaimPakeInputs returns the CPace inputs of a claim, or ErrClaimPakeInvalidPassword.
func ClaimPakeInputs(c ClaimPakeContext) (CPaceInputs, error) {
	switch {
	case c.Method == ClaimMethodCode && IsClaimLetters(c.Password):
	case c.Method == ClaimMethodCard && b64Tag.MatchString(c.Password) /* ClaimCardPassword's shape */:
	default:
		return CPaceInputs{}, ErrClaimPakeInvalidPassword
	}
	return CPaceInputs{PRS: []byte(c.Password), CI: ClaimPakeCI(c), SID: []byte(c.ClaimID)}, nil
}

// ClaimConfirmTags holds both confirmation tags (base64url).
type ClaimConfirmTags struct {
	// Client is tagClient, sent in enroll.claim's confirm.
	Client string
	// Appliance is tagAppliance, answered in enroll.claim's output confirm.
	Appliance string
}

// ClaimConfirmTagsFor derives both tags from ISK and the transcript.
func ClaimConfirmTagsFor(isk, transcript []byte) ClaimConfirmTags {
	k, err := hkdf.Key(sha512.New, isk, nil, ClaimConfirmInfo, 64)
	if err != nil {
		panic(err) // 64 <= 255*64
	}
	tag := func(role string) string {
		m := hmac.New(sha512.New, k)
		m.Write([]byte(role))
		m.Write(transcript)
		return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:ClaimConfirmTagBytes])
	}
	return ClaimConfirmTags{Client: tag("client"), Appliance: tag("appliance")}
}

func decodeClaimShare(s string) ([]byte, error) {
	if !b64Tag.MatchString(s) {
		return nil, ErrClaimPakeInvalidShare
	}
	b, err := b64Strict.DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, ErrClaimPakeInvalidShare
	}
	return b, nil
}

// ClaimPakeClient is the client between enroll.claim.begin and its answer (memory only).
type ClaimPakeClient struct {
	cpace *CPaceInitiator
	// Share goes in enroll.claim.begin.
	Share string
}

// NewClaimPakeClient starts the PAKE as the initiator.
func NewClaimPakeClient(c ClaimPakeContext, r io.Reader) (*ClaimPakeClient, error) {
	in, err := ClaimPakeInputs(c)
	if err != nil {
		return nil, err
	}
	a, err := NewCPaceInitiator(in, r, nil)
	if err != nil {
		return nil, err
	}
	return &ClaimPakeClient{cpace: a, Share: base64.RawURLEncoding.EncodeToString(a.Share)}, nil
}

// Finish takes the appliance's share and returns both tags: send Client, accept the result only if
// ClaimConfirmEqual(tags.Appliance, output.confirm).
func (c *ClaimPakeClient) Finish(applianceShare string) (ClaimConfirmTags, error) {
	yb, err := decodeClaimShare(applianceShare)
	if err != nil {
		return ClaimConfirmTags{}, err
	}
	res, err := c.cpace.Finish(yb, nil)
	if err != nil {
		return ClaimConfirmTags{}, ErrClaimPakeInvalidShare
	}
	return ClaimConfirmTagsFor(res.ISK, res.Transcript), nil
}

// ClaimPakeRespond is the appliance on enroll.claim.begin: its share (to answer) and both tags (to keep for the
// session, at most EnrollClaimBeginTTLS). Check enroll.claim's confirm with ClaimConfirmEqual(tags.Client, …) first.
func ClaimPakeRespond(c ClaimPakeContext, clientShare string, r io.Reader) (string, ClaimConfirmTags, error) {
	in, err := ClaimPakeInputs(c)
	if err != nil {
		return "", ClaimConfirmTags{}, err
	}
	ya, err := decodeClaimShare(clientShare)
	if err != nil {
		return "", ClaimConfirmTags{}, err
	}
	share, res, err := CPaceRespond(in, ya, nil, nil, r)
	if errors.Is(err, ErrCPaceInvalidShare) {
		return "", ClaimConfirmTags{}, ErrClaimPakeInvalidShare
	} else if err != nil {
		return "", ClaimConfirmTags{}, err
	}
	return base64.RawURLEncoding.EncodeToString(share), ClaimConfirmTagsFor(res.ISK, res.Transcript), nil
}

// ClaimConfirmEqual compares two confirmation tags in constant time; false for anything that isn't a tag.
func ClaimConfirmEqual(expected, received string) bool {
	if !b64Tag.MatchString(expected) || !b64Tag.MatchString(received) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(received)) == 1
}
