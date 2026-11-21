package protocol

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestClaimCodeVectors(t *testing.T) {
	var v struct {
		Codes []struct {
			Input  string `json:"input"`
			Expect struct {
				Kind    string `json:"kind"`
				Letters string `json:"letters"`
				Lookup  string `json:"lookup"`
			} `json:"expect"`
		} `json:"codes"`
		Formats []struct {
			Letters string  `json:"letters"`
			Lookup  string  `json:"lookup"`
			Code    *string `json:"code"`
		} `json:"formats"`
		Letters []struct {
			Random  string `json:"random"`
			Letters string `json:"letters"`
		} `json:"letters"`
	}
	vectors.Load(t, "claim.json", &v)
	if len(v.Codes) == 0 || len(v.Formats) == 0 || len(v.Letters) == 0 {
		t.Fatal("no claim code vectors")
	}
	for _, c := range v.Codes {
		got := NormalizeClaimCode(c.Input)
		if string(got.Kind) != c.Expect.Kind || got.Letters != c.Expect.Letters || got.Lookup != c.Expect.Lookup {
			t.Errorf("NormalizeClaimCode(%q) = %+v, want %+v", c.Input, got, c.Expect)
		}
	}
	for _, c := range v.Formats {
		got, err := FormatClaimCode(c.Letters, c.Lookup)
		if c.Code == nil {
			if err == nil {
				t.Errorf("FormatClaimCode(%q, %q) = %q, want an error", c.Letters, c.Lookup, got)
			}
		} else if err != nil || got != *c.Code {
			t.Errorf("FormatClaimCode(%q, %q) = %q (%v), want %q", c.Letters, c.Lookup, got, err, *c.Code)
		}
	}
	for _, c := range v.Letters {
		random, _ := hex.DecodeString(c.Random)
		r := bytes.NewReader(random)
		got, err := GenerateClaimLetters(r)
		if err != nil || got != c.Letters || r.Len() != 0 {
			t.Errorf("GenerateClaimLetters(%s) = %q (%v, %d left), want %q", c.Random, got, err, r.Len(), c.Letters)
		}
	}
}
