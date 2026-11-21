package protocol

import (
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestClaimSecretVectors(t *testing.T) {
	var v struct {
		Normalize []struct {
			Name       string `json:"name"`
			Input      string `json:"input"`
			Normalized string `json:"normalized"`
			Valid      bool   `json:"valid"`
		} `json:"normalize"`
		Hashes []struct {
			DeviceID string `json:"deviceId"`
			Secret   string `json:"secret"`
			Hash     string `json:"hash"`
			Verifier string `json:"verifier"`
		} `json:"hashes"`
	}
	vectors.Load(t, "claim.json", &v)
	for _, c := range v.Normalize {
		got := NormalizeClaimSecret(c.Input)
		if got != c.Normalized || IsClaimSecret(got) != c.Valid {
			t.Errorf("%s: %q valid=%v, want %q valid=%v", c.Name, got, IsClaimSecret(got), c.Normalized, c.Valid)
		}
	}
	for _, c := range v.Hashes {
		got, err := ClaimSecretHash(c.DeviceID, c.Secret)
		if err != nil || got != c.Hash {
			t.Errorf("hash(%s) = %s (%v), want %s", c.DeviceID, got, err, c.Hash)
		}
		ver, err := ClaimVerifier(c.DeviceID, c.Secret)
		if err != nil || ver != c.Verifier {
			t.Errorf("verifier(%s) = %s (%v), want %s", c.DeviceID, ver, err, c.Verifier)
		}
	}
	if _, err := ClaimSecretHash("dev_1", "short"); err == nil {
		t.Error("an invalid secret must not hash")
	}
}
