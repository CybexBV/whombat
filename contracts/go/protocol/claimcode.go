package protocol

import (
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode"
)

// ClaimCodeAlphabet (constants_gen.go) holds the 20 letters of the console claim code (CC-01): no I L O S U Z.

var (
	claimLettersRe = regexp.MustCompile(`^[ABCDEFGHJKMNPQRTVWXY]{4}$`)
	claimFullRe    = regexp.MustCompile(`^([ABCDEFGHJKMNPQRTVWXY]{2})([0-9]{4,6})([ABCDEFGHJKMNPQRTVWXY]{2})$`)
	claimLookupRe  = regexp.MustCompile(`^[0-9]{4,6}$`)
)

// ClaimCodeKind says what NormalizeClaimCode found.
type ClaimCodeKind string

const (
	// ClaimCodeLetters: only the four letters (the box was found nearby).
	ClaimCodeLetters ClaimCodeKind = "letters"
	// ClaimCodeFull: the whole code, with its lookup number.
	ClaimCodeFull ClaimCodeKind = "code"
	// ClaimCodeInvalid: anything else. Nothing is repaired.
	ClaimCodeInvalid ClaimCodeKind = "invalid"
)

// NormalizedClaimCode is the result of NormalizeClaimCode. Letters and Lookup are empty unless the kind has them.
type NormalizedClaimCode struct {
	Kind    ClaimCodeKind
	Letters string
	Lookup  string
}

// NormalizeClaimCode is normalizeClaimCode of @whombat/protocol (CC-01): ASCII upper-case a-z only; drop Unicode
// White_Space, U+FEFF and "-"; the result must be 4 letters, or 2 letters + 4–6 digits + 2 letters, letters from
// ClaimCodeAlphabet. A letter outside the alphabet is invalid, never mapped.
func NormalizeClaimCode(input string) NormalizedClaimCode {
	var b strings.Builder
	for _, r := range input {
		switch {
		case unicode.IsSpace(r) || r == 0xFEFF || r == '-':
			continue
		case r >= 'a' && r <= 'z':
			r -= 'a' - 'A'
		}
		b.WriteRune(r)
	}
	s := b.String()
	if claimLettersRe.MatchString(s) {
		return NormalizedClaimCode{Kind: ClaimCodeLetters, Letters: s}
	}
	if m := claimFullRe.FindStringSubmatch(s); m != nil {
		return NormalizedClaimCode{Kind: ClaimCodeFull, Letters: m[1] + m[3], Lookup: m[2]}
	}
	return NormalizedClaimCode{Kind: ClaimCodeInvalid}
}

// IsClaimLetters reports whether s is four letters of ClaimCodeAlphabet.
func IsClaimLetters(s string) bool { return claimLettersRe.MatchString(s) }

// IsClaimLookup reports whether s is a lookup number (4–6 decimal digits).
func IsClaimLookup(s string) bool { return claimLookupRe.MatchString(s) }

// FormatClaimCode returns the display form L1L2-NNNN-L3L4 ("KX-4821-QM").
func FormatClaimCode(letters, lookup string) (string, error) {
	if !IsClaimLetters(letters) {
		return "", errors.New("not claim letters")
	}
	if !IsClaimLookup(lookup) {
		return "", errors.New("not a claim lookup number")
	}
	return letters[:2] + "-" + lookup + "-" + letters[2:], nil
}

// GenerateClaimLetters draws four letters without modulo bias, exactly like generateClaimLetters: bytes are read in
// order, 4 at first and then as many as letters are still missing; a byte b < 240 gives ClaimCodeAlphabet[b%20],
// a byte >= 240 is skipped. Pass crypto/rand.Reader.
func GenerateClaimLetters(r io.Reader) (string, error) {
	letters := make([]byte, 0, ClaimLettersLength)
	for draws := 0; len(letters) < ClaimLettersLength; draws++ {
		if draws > 64 {
			return "", errors.New("randomness source keeps returning bytes >= 240")
		}
		buf := make([]byte, ClaimLettersLength-len(letters))
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b < 240 {
				letters = append(letters, ClaimCodeAlphabet[b%20])
			}
		}
	}
	return string(letters), nil
}
