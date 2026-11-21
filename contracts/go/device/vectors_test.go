package device

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/canon"
	"github.com/CybexBV/whombat/contracts/go/internal/ed25519strict"
	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

type signedVectors struct {
	DeviceRequests struct {
		Audience   string            `json:"audience"`
		PublicKeys map[string]string `json:"publicKeys"`
		Cases      []struct {
			Name     string          `json:"name"`
			Envelope json.RawMessage `json:"envelope"`
			Now      int64           `json:"now"`
			Audience string          `json:"audience"`
			Expect   string          `json:"expect"`
		} `json:"cases"`
	} `json:"deviceRequests"`
	Registrations []struct {
		Name         string          `json:"name"`
		Registration json.RawMessage `json:"registration"`
		Expect       bool            `json:"expect"`
	} `json:"registrations"`
	PeerIDs []struct {
		PublicKey string `json:"publicKey"`
		PeerID    string `json:"peerId"`
	} `json:"peerIds"`
	Ed25519 []struct {
		Name       string `json:"name"`
		PublicKey  string `json:"publicKey"`
		Message    string `json:"message"`
		Signature  string `json:"signature"`
		Expect     bool   `json:"expect"`
		LaxAccepts bool   `json:"laxAccepts"`
	} `json:"ed25519"`
	Canonical []struct {
		Value     json.RawMessage `json:"value"`
		Canonical string          `json:"canonical"`
	} `json:"canonical"`
}

func TestDeviceRequestVectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	dr := v.DeviceRequests
	for _, c := range dr.Cases {
		aud := dr.Audience
		if c.Audience != "" {
			aud = c.Audience
		}
		_, err := VerifyDeviceRequest(c.Envelope, DeviceRequestContext{
			Audience: aud,
			Now:      c.Now,
			PublicKeyOf: func(d string) (ed25519.PublicKey, bool) {
				k, ok := dr.PublicKeys[d]
				b, _ := hex.DecodeString(k)
				return b, ok
			},
			ClaimNonce: func(string, string) bool { return true },
		})
		got := "ok"
		var de *DeviceRequestError
		if errors.As(err, &de) {
			got = string(de.Code)
		} else if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
	}
}

func TestSignDeviceRequestMatchesTypeScript(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	var want DeviceRequestEnvelope
	if err := json.Unmarshal(v.DeviceRequests.Cases[0].Envelope, &want); err != nil {
		t.Fatal(err)
	}
	// The vector key is derived from a public seed: sha256("whombat/seed-key/v1\0whombat-contracts-vectors\0device-dev_1-management").
	seed := devSeed("device-dev_1-management")
	var body PushSendRequest
	if err := json.Unmarshal(want.Body, &body); err != nil {
		t.Fatal(err)
	}
	got, err := SignDeviceRequest(want.Aud, want.Device, want.Op, want.Ts, want.Nonce, &body, ed25519.NewKeyFromSeed(seed))
	if err != nil {
		t.Fatal(err)
	}
	if got.Sig != want.Sig {
		t.Fatalf("signature differs: got %s want %s", got.Sig, want.Sig)
	}
}

func TestRegistrationVectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	for _, c := range v.Registrations {
		var r DeviceRegistration
		if err := json.Unmarshal(c.Registration, &r); err != nil {
			t.Fatal(err)
		}
		if got := VerifyRegistration(&r); got != c.Expect {
			t.Errorf("%s: got %v, want %v", c.Name, got, c.Expect)
		}
	}
}

func TestCanonicalJSONVectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	for _, c := range v.Canonical {
		got, err := canon.JSON(c.Value)
		if err != nil || string(got) != c.Canonical {
			t.Errorf("canonical(%s) = %s (%v), want %s", c.Value, got, err, c.Canonical)
		}
	}
}

func TestStrictEd25519Vectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	if len(v.Ed25519) < 4 {
		t.Fatal("missing ed25519 vectors")
	}
	for _, c := range v.Ed25519 {
		pub, _ := hex.DecodeString(c.PublicKey)
		msg, _ := hex.DecodeString(c.Message)
		sig, _ := hex.DecodeString(c.Signature)
		if got := ed25519strict.Verify(pub, msg, sig); got != c.Expect {
			t.Errorf("%s: strict %v, want %v", c.Name, got, c.Expect)
		}
		// Documents why the wrapper exists: crypto/ed25519 alone accepts some of these forgeries.
		if got := ed25519.Verify(pub, msg, sig); got != c.LaxAccepts {
			t.Errorf("%s: crypto/ed25519 %v, vector says %v", c.Name, got, c.LaxAccepts)
		}
	}
}

func TestPeerIDVectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	for _, c := range v.PeerIDs {
		pub, _ := hex.DecodeString(c.PublicKey)
		got, err := protocol.PeerIDFromEd25519PublicKey(pub)
		if err != nil || got != c.PeerID {
			t.Errorf("PeerId(%s) = %s (%v), want %s", c.PublicKey, got, err, c.PeerID)
		}
		back, err := protocol.Ed25519PublicKeyFromPeerID(c.PeerID)
		if err != nil || hex.EncodeToString(back) != c.PublicKey {
			t.Errorf("key of %s = %x (%v)", c.PeerID, back, err)
		}
	}
}

// A feedback card is free text inside a device body: Go's canonical JSON of the opaque card (Unicode, "<", "&", an
// emoji, as encoding/json re-escapes them) must give TypeScript's signature (CT-91).
func TestSignFeedbackCardsSyncMatchesTypeScript(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	seen := 0
	for _, c := range v.DeviceRequests.Cases {
		if c.Name != "feedback.cards.sync with free text" && c.Name != "feedback.cards.sync above 64 KiB" {
			continue
		}
		seen++
		var want DeviceRequestEnvelope
		if err := json.Unmarshal(c.Envelope, &want); err != nil {
			t.Fatal(err)
		}
		body, err := ParseFeedbackCardsSyncRequest(want.Body)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		got, err := SignDeviceRequest(want.Aud, want.Device, want.Op, want.Ts, want.Nonce, body, ed25519.NewKeyFromSeed(devSeed("device-dev_1-management")))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got.Sig != want.Sig {
			t.Fatalf("%s: signature differs: got %s want %s", c.Name, got.Sig, want.Sig)
		}
	}
	if seen != 2 {
		t.Fatalf("found %d feedback.cards.sync vectors, want 2", seen)
	}
}

func TestDeviceRequestMaxBytesFor(t *testing.T) {
	if DeviceRequestMaxBytesFor(DeviceOpNameFeedbackCardsSync) != FeedbackCardsSyncMaxBytes {
		t.Fatal("feedback.cards.sync must allow FeedbackCardsSyncMaxBytes")
	}
	if DeviceRequestMaxBytesFor(DeviceOpNameSharePut) != SharePutMaxBytes {
		t.Fatal("share.put must allow SharePutMaxBytes")
	}
	for _, op := range DeviceOpNameValues {
		if op == DeviceOpNameFeedbackCardsSync || op == DeviceOpNameSharePut {
			continue
		}
		if DeviceRequestMaxBytesFor(op) != DeviceRequestMaxBytes {
			t.Fatalf("%s: got %d", op, DeviceRequestMaxBytesFor(op))
		}
	}
}
