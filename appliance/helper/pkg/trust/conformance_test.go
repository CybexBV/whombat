package trust_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/canonjson"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Conformance vectors of whombat-contracts 0.2.0 (identical in the schema tarball and the vendored Go
// module): our JCS, the tuple digest binding and assignment verification must agree with them.
const vectorsPath = "../../../../contracts/go/testdata/vectors/signed.json"

type vectors struct {
	TupleDigest struct {
		Tuple  json.RawMessage `json:"tuple"`
		Digest string          `json:"digest"`
	} `json:"tupleDigest"`
	Assignments struct {
		Keys  map[string]string `json:"keys"`
		Cases []struct {
			Name         string          `json:"name"`
			Doc          json.RawMessage `json:"doc"`
			Now          int64           `json:"now"`
			Env          string          `json:"env"`
			Device       string          `json:"device"`
			LastSequence int64           `json:"lastSequence"`
			Expect       string          `json:"expect"`
		} `json:"cases"`
	} `json:"assignments"`
	Canonical []struct {
		Value     json.RawMessage `json:"value"`
		Canonical string          `json:"canonical"`
	} `json:"canonical"`
}

func loadVectors(t *testing.T) vectors {
	b, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCanonicalVectors(t *testing.T) {
	v := loadVectors(t)
	if len(v.Canonical) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Canonical {
		got, err := canonjson.Canonicalize(c.Value)
		if err != nil || string(got) != c.Canonical {
			t.Errorf("%s: got %s (%v), want %s", c.Value, got, err, c.Canonical)
		}
	}
}

func TestAssignmentVectorsThroughTrust(t *testing.T) {
	v := loadVectors(t)
	ks := &trust.KeySet{Keys: map[string]ed25519.PublicKey{}}
	for id, k := range v.Assignments.Keys {
		b, _ := hex.DecodeString(k)
		ks.Keys[id] = b
	}
	for _, c := range v.Assignments.Cases {
		_, err := trust.VerifyAssignment(c.Doc, ks, trust.VerifyParams{DeviceID: c.Device, Env: c.Env,
			Now: time.Unix(c.Now, 0), LastSequence: c.LastSequence, MaxClockSkew: 300 * time.Second})
		got := "ok"
		var ae *release.AssignmentError
		if errors.As(err, &ae) {
			got = string(ae.Code)
		} else if err != nil {
			got = err.Error()
		}
		if got != c.Expect {
			t.Errorf("%s: got %s want %s", c.Name, got, c.Expect)
		}
	}
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
