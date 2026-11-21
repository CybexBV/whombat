package release

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

type signedVectors struct {
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
}

func TestTupleDigest(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	tuple, err := ParseReleaseTuple(v.TupleDigest.Tuple)
	if err != nil {
		t.Fatal(err)
	}
	got, err := TupleDigest(tuple)
	if err != nil || got != v.TupleDigest.Digest {
		t.Fatalf("got %s (%v), want %s", got, err, v.TupleDigest.Digest)
	}
}

func TestAssignmentVectors(t *testing.T) {
	var v signedVectors
	vectors.Load(t, "signed.json", &v)
	keys := map[string]ed25519.PublicKey{}
	for id, k := range v.Assignments.Keys {
		b, _ := hex.DecodeString(k)
		keys[id] = b
	}
	for _, c := range v.Assignments.Cases {
		_, err := VerifyAssignment(c.Doc, AssignmentContext{
			Keys: keys, Env: Environment(c.Env), Device: c.Device, Now: c.Now, LastSequence: c.LastSequence,
		})
		got := "ok"
		var ae *AssignmentError
		if errors.As(err, &ae) {
			got = string(ae.Code)
		} else if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
	}
}

func TestJournalTransitions(t *testing.T) {
	if !CanTransition(UpdateJournalStateVerifying, UpdateJournalStateRolledBack) ||
		CanTransition(UpdateJournalStateHealthy, UpdateJournalStateActivating) {
		t.Fatal("transition table")
	}
	if len(UpdateJournalTransitions) != len(UpdateJournalStateValues) {
		t.Fatal("every state has a row")
	}
}
