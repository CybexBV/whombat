package local

import (
	"encoding/json"
	"regexp"
	"testing"
	"unicode"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestRevocationRefVectors(t *testing.T) {
	var v struct {
		RevocationRefs []struct {
			PeerID string `json:"peerId"`
			Ref    string `json:"ref"`
		} `json:"revocationRefs"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.RevocationRefs) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.RevocationRefs {
		if got := RevocationRef(c.PeerID); got != c.Ref {
			t.Errorf("RevocationRef(%s) = %s, want %s", c.PeerID, got, c.Ref)
		}
	}
}

func TestConsoleAndLeaseVectors(t *testing.T) {
	var v struct {
		ConsoleStates []struct {
			State   json.RawMessage `json:"state"`
			Valid   bool            `json:"valid"`
			Display string          `json:"display"`
		} `json:"consoleStates"`
		ClaimLookupLeases []struct {
			Request json.RawMessage `json:"request"`
			Valid   bool            `json:"valid"`
		} `json:"claimLookupLeases"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.ConsoleStates) == 0 || len(v.ClaimLookupLeases) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.ConsoleStates {
		s, err := ParseConsoleState(c.State)
		if err != nil {
			t.Fatalf("%s: %v", c.State, err)
		}
		if got := ConsoleStateValid(*s); got != c.Valid {
			t.Errorf("ConsoleStateValid(%s) = %v, want %v", c.State, got, c.Valid)
		}
		if got := ConsoleDisplayURL(s.URL); got != c.Display {
			t.Errorf("ConsoleDisplayURL(%s) = %s, want %s", s.URL, got, c.Display)
		}
	}
	for _, c := range v.ClaimLookupLeases {
		r, err := ParseClaimLookupLeaseRequest(c.Request)
		if err != nil {
			t.Fatalf("%s: %v", c.Request, err)
		}
		if got := ClaimLookupLeaseValid(*r); got != c.Valid {
			t.Errorf("ClaimLookupLeaseValid(%s) = %v, want %v", c.Request, got, c.Valid)
		}
	}
}

// TestDisplayTextVectors compiles the ConsoleDisplayText pattern with RE2 and checks that it refuses exactly the
// code points the TypeScript side refuses (CT-116), so the Unicode tables of both languages agree.
func TestDisplayTextVectors(t *testing.T) {
	var v struct {
		DisplayText struct {
			Pattern  string     `json:"pattern"`
			Rejected [][2]int32 `json:"rejected"`
		} `json:"displayText"`
	}
	vectors.Load(t, "local.json", &v)
	if v.DisplayText.Pattern == "" || len(v.DisplayText.Rejected) == 0 {
		t.Fatal("no vectors")
	}
	re := regexp.MustCompile(v.DisplayText.Pattern)
	refused := func(cp rune) bool {
		for _, r := range v.DisplayText.Rejected {
			if r[0] <= cp && cp <= r[1] {
				return true
			}
		}
		return false
	}
	mismatches := 0
	for cp := rune(0); cp <= unicode.MaxRune; cp++ {
		if cp >= 0xd800 && cp <= 0xdfff {
			continue // a Go string can't hold a surrogate
		}
		if got, want := !re.MatchString(string(cp)), refused(cp); got != want {
			if mismatches++; mismatches <= 10 {
				t.Errorf("U+%04X: RE2 refuses %v, TypeScript refuses %v", cp, got, want)
			}
		}
	}
	if mismatches > 10 {
		t.Errorf("%d mismatches in total", mismatches)
	}
}
