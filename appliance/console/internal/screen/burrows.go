package screen

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// Burrows is what the claimed screen of the graphical console shows (CG-08, contracts CT-116): the oldest
// burrow's name and how many others the box holds. Burrow names are user input: they are cleaned and bounded
// here, and the page renders them as text only.
type Burrows struct {
	First string `json:"first"`
	More  int    `json:"more"`
}

// Bounds of CT-116.
const (
	MaxBurrowName = 64   // code points, after cleaning
	MaxMoreBurrow = 9999 // the count of the other burrows
)

// CleanName removes what Clean removes (C0, DEL, C1, format characters such as bidi overrides and zero-width
// joiners) and the line and paragraph separators (Zl, Zp), so a name is one line of plain text.
func CleanName(s string) string {
	return strings.Map(func(r rune) rune {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			return -1
		}
		return r
	}, s)
}

// displayBurrows is the contract's burrows (contracts 0.17.0, CT-116; the schema already bounds the name and the
// count, and local.ConsoleStateValid allows them only in `claimed`) as the page gets them: cleaned once more and cut
// to MaxBurrowName code points, whatever a future schema allows. nil when nothing is left to show.
func displayBurrows(b *local.ConsoleBurrows) *Burrows {
	if b == nil || b.More < 0 || b.More > MaxMoreBurrow {
		return nil
	}
	first := strings.TrimSpace(CleanName(b.First))
	if r := []rune(first); len(r) > MaxBurrowName {
		first = strings.TrimSpace(string(r[:MaxBurrowName]))
	}
	if first == "" {
		return nil
	}
	return &Burrows{First: first, More: int(b.More)}
}

// without is the state file without the named members, or false when it has none of them (or isn't an object).
// The burrows and the sign-in are decorations of the claimed screen: a file whose only fault is one of them keeps its
// claim state and shows neither the faulty one (CG-08, NX-78, CG-151).
func without(data []byte, members ...string) ([]byte, bool) {
	var doc map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	if dec.Decode(&doc) != nil || dec.More() {
		return nil, false
	}
	found := false
	for _, m := range members {
		if _, ok := doc[m]; ok {
			found = true
			delete(doc, m)
		}
	}
	if !found {
		return nil, false
	}
	b, err := json.Marshal(doc)
	return b, err == nil
}
