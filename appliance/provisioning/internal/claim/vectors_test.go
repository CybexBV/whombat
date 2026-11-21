package claim

import (
	"encoding/json"
	"os"
	"testing"
)

// The contracts' claim-secret vectors (contracts/go/testdata/vectors/claim.json of this repository).
// This package delegates to protocol.NormalizeClaimSecret, IsClaimSecret and ClaimSecretHash;
// the vectors guard the delegation.
func TestContractClaimVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../contracts/go/testdata/vectors/claim.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Normalize []struct {
			Name, Input, Normalized string
			Valid                   bool
		} `json:"normalize"`
		Hashes []map[string]any `json:"hashes"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Normalize {
		got := Normalize(c.Input)
		if got != c.Normalized || Valid(got) != c.Valid {
			t.Errorf("%s: Normalize(%q) = %q valid=%v, want %q valid=%v", c.Name, c.Input, got, Valid(got), c.Normalized, c.Valid)
		}
	}
	if len(v.Hashes) == 0 {
		t.Fatal("no hash vectors")
	}
	for _, h := range v.Hashes {
		dev, _ := h["deviceId"].(string)
		sec, _ := h["secret"].(string)
		want, _ := h["hash"].(string)
		if got := SecretHash(dev, sec); got != want {
			t.Errorf("SecretHash(%q, %q) = %q, want %q", dev, sec, got, want)
		}
		wantV, _ := h["verifier"].(string)
		if gotV, err := Verifier(dev, sec); err != nil || gotV != wantV {
			t.Errorf("Verifier(%q, %q) = %q (%v), want %q", dev, sec, gotV, err, wantV)
		}
	}
}
