package screen

import (
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// SignIn is a device waiting to sign in at the box's screen (Whombat BX-06, contracts 0.106.0 `ConsoleSignIn`): the
// six letters the person types on that device, whose account it asks for and the device's own label. Name and device
// are user input (an account's name, the requester's text): cleaned and bounded here as the burrows' name is, and
// rendered as text only.
type SignIn struct {
	Code      string    // six letters of the claim alphabet, shown grouped 3 + 3 (DisplayLetters)
	Name      string    // the account's name, else its email
	Device    string    // the new device's label, as it asked
	ExpiresAt time.Time // the code goes away then, whether or not the file is rewritten (CG-151)
}

// MaxSignInAhead bounds how far ahead a sign-in may expire for the screen to show it: BX-02's five minutes three times
// over, so a later, longer code or a clock step still shows, and a broken file can't keep the panel up for hours.
const MaxSignInAhead = 15 * time.Minute

// signInCodeRe is the contract's `ScreenSignInLetters` (six of CLAIM_CODE_ALPHABET, BX-04): the schema checked it,
// and the screen draws nothing else as the letters.
var signInCodeRe = regexp.MustCompile(`^[ABCDEFGHJKMNPQRTVWXY]{6}$`)

// displaySignIn is the file's sign-in as the screen shows it: cleaned once more and cut to MaxBurrowName code points
// like a burrow's name (whatever a future schema allows), the letters exactly six of the alphabet, the time parsed.
// nil when any of it is left empty or wrong: a panel that can't say whose device it is shows nothing.
func displaySignIn(si *local.ConsoleSignIn) *SignIn {
	if si == nil || !signInCodeRe.MatchString(si.Code) {
		return nil
	}
	exp, err := time.Parse(time.RFC3339Nano, si.ExpiresAt)
	if err != nil {
		return nil
	}
	name, device := displayName(si.Name), displayName(si.Device)
	if name == "" || device == "" {
		return nil
	}
	return &SignIn{Code: si.Code, Name: name, Device: device, ExpiresAt: exp}
}

// displayName is a user-chosen name as the console shows it: one line of plain text, at most MaxBurrowName code points.
func displayName(s string) string {
	n := strings.TrimSpace(CleanName(s))
	if r := []rune(n); len(r) > MaxBurrowName {
		n = strings.TrimSpace(string(r[:MaxBurrowName]))
	}
	return n
}

// LiveSignIn is the sign-in the screen shows at now: none once its time is up (the runtime rewrites the file then, but
// a runtime that stopped without doing so can't leave the code on screen), and none that claims to last longer than
// MaxSignInAhead.
func (s Screen) LiveSignIn(now time.Time) *SignIn {
	si := s.SignIn
	if si == nil || s.State != Claimed || !now.Before(si.ExpiresAt) || si.ExpiresAt.Sub(now) > MaxSignInAhead {
		return nil
	}
	return si
}

// DisplayLetters groups the six letters 3 + 3 for reading (`KXQMTR` → `KXQ MTR`, the contracts'
// formatScreenSignInLetters); the space isn't typed.
func DisplayLetters(code string) string {
	if len(code) != 6 {
		return code
	}
	return code[:3] + " " + code[3:]
}
