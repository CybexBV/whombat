package screen

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/local"
)

const claimedURL = `"url":"https://app.whombat.com/claim"`

// signInFile is a claimed file with the given signIn member (raw JSON) and the burrows.
func signInFile(signIn string) string {
	return `{"v":1,"state":"claimed",` + claimedURL + `,"burrows":{"first":"Banjo’s Burrow","more":2},"signIn":` + signIn + `}`
}

const goodSignIn = `{"code":"KXQMTR","name":"John Doe","device":"Pixel 9","expiresAt":"2026-09-26T12:04:30Z"}`

func TestParseSignIn(t *testing.T) {
	sc := mustParse(t, signInFile(goodSignIn))
	si := sc.SignIn
	if sc.State != Claimed || sc.Burrows == nil || si == nil || si.Code != "KXQMTR" || si.Name != "John Doe" ||
		si.Device != "Pixel 9" || !si.ExpiresAt.Equal(now.Add(270*time.Second)) {
		t.Fatalf("%+v %+v", sc, si)
	}
	// Any script, as a burrow's name; members the contract doesn't know are ignored.
	sc = mustParse(t, signInFile(`{"code":"ABCDEF","name":"Zoë Ångström","device":"Zoë’s iPhone","expiresAt":"2026-09-26T14:04:30.25+02:00","x":1}`))
	if sc.SignIn == nil || sc.SignIn.Name != "Zoë Ångström" || !sc.SignIn.ExpiresAt.Equal(now.Add(270*time.Second+250*time.Millisecond)) {
		t.Fatalf("%+v", sc.SignIn)
	}
	if DisplayLetters("KXQMTR") != "KXQ MTR" {
		t.Fatal(DisplayLetters("KXQMTR"))
	}
}

// A sign-in that isn't one drops the panel, never the claim state, the burrows or (in claimable) the code.
func TestParseSignInDropsOnlyThePanel(t *testing.T) {
	for name, signIn := range map[string]string{
		"five letters":        `{"code":"KXQMT","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"seven letters":       `{"code":"KXQMTRA","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"lower case":          `{"code":"kxqmtr","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"outside alphabet":    `{"code":"KXQMTI","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"grouped":             `{"code":"KXQ MTR","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"escape in code":      `{"code":"KXQ\u001bTR","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"numeric code":        `{"code":123456,"name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"bidi in name":        `{"code":"KXQMTR","name":"Evil\u202eslaP","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"newline in device":   `{"code":"KXQMTR","name":"John","device":"Pixel\nroot# ","expiresAt":"2026-09-26T12:04:30Z"}`,
		"escape in device":    `{"code":"KXQMTR","name":"John","device":"\u001b[2JPixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"zero-width in name":  `{"code":"KXQMTR","name":"Jo\u200bhn","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"leading space":       `{"code":"KXQMTR","name":" John","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"empty name":          `{"code":"KXQMTR","name":"","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"name too long":       `{"code":"KXQMTR","name":"` + strings.Repeat("ä", 65) + `","device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"no device":           `{"code":"KXQMTR","name":"John","expiresAt":"2026-09-26T12:04:30Z"}`,
		"no expiresAt":        `{"code":"KXQMTR","name":"John","device":"Pixel"}`,
		"bad expiresAt":       `{"code":"KXQMTR","name":"John","device":"Pixel","expiresAt":"soon"}`,
		"numeric expiresAt":   `{"code":"KXQMTR","name":"John","device":"Pixel","expiresAt":1790424270}`,
		"expiresAt no zone":   `{"code":"KXQMTR","name":"John","device":"Pixel","expiresAt":"2026-09-26T12:04:30"}`,
		"impossible date":     `{"code":"KXQMTR","name":"John","device":"Pixel","expiresAt":"2026-02-30T12:04:30Z"}`,
		"not an object":       `"KXQMTR"`,
		"an array":            `[]`,
		"null":                `null`,
		"name not a string":   `{"code":"KXQMTR","name":{"first":"John"},"device":"Pixel","expiresAt":"2026-09-26T12:04:30Z"}`,
		"device not a string": `{"code":"KXQMTR","name":"John","device":7,"expiresAt":"2026-09-26T12:04:30Z"}`,
	} {
		sc, err := Parse([]byte(signInFile(signIn)))
		if err != nil || sc.State != Claimed || sc.SignIn != nil || sc.Burrows == nil || sc.Burrows.First != "Banjo’s Burrow" {
			t.Errorf("%s: %+v, %v", name, sc, err)
		}
	}
	// Only in `claimed`: elsewhere the file keeps its state (and the claim code shows) without it.
	for _, doc := range []string{
		`{"v":1,"state":"claimable","code":"KXQM",` + claimedURL + `,"signIn":` + goodSignIn + `}`,
		`{"v":1,"state":"backoff",` + claimedURL + `,"retryAt":"2026-09-26T12:04:30Z","signIn":` + goodSignIn + `}`,
		`{"v":1,"state":"starting",` + claimedURL + `,"signIn":` + goodSignIn + `}`,
		`{"v":1,"state":"waiting",` + claimedURL + `,"signIn":` + goodSignIn + `}`,
	} {
		sc := mustParse(t, doc)
		if sc.SignIn != nil || sc.State == Claimed || (sc.State == Claimable && sc.Code != "KXQM") {
			t.Errorf("%s: %+v", doc, sc)
		}
	}
	// Bad burrows beside a good sign-in: the sign-in stays.
	sc := mustParse(t, `{"v":1,"state":"claimed",`+claimedURL+`,"burrows":{"first":"Evil\u202eworrub","more":2},"signIn":`+goodSignIn+`}`)
	if sc.Burrows != nil || sc.SignIn == nil || sc.SignIn.Code != "KXQMTR" {
		t.Fatalf("%+v", sc)
	}
	// Both wrong: the claim state alone.
	sc = mustParse(t, `{"v":1,"state":"claimed",`+claimedURL+`,"burrows":{"first":"","more":2},"signIn":{"code":"no"}}`)
	if sc.State != Claimed || sc.Burrows != nil || sc.SignIn != nil || sc.URL != "app.whombat.com/claim" {
		t.Fatalf("%+v", sc)
	}
	// A file broken elsewhere is still refused with a sign-in in it.
	if _, err := Parse([]byte(`{"v":2,"state":"claimed",` + claimedURL + `,"signIn":` + goodSignIn + `}`)); err == nil {
		t.Fatal("v 2 accepted")
	}
}

func TestDisplaySignInCleans(t *testing.T) {
	// Whatever a future schema lets through: control and format characters go, the name is one bounded line.
	si := displaySignIn(&local.ConsoleSignIn{Code: "KXQMTR", Name: "\u200dJohn\u2028 Doe ", Device: strings.Repeat("é", 70),
		ExpiresAt: "2026-09-26T12:04:30Z"})
	if si == nil || si.Name != "John Doe" || utf8.RuneCountInString(si.Device) != MaxBurrowName {
		t.Fatalf("%+v", si)
	}
	if displaySignIn(&local.ConsoleSignIn{Code: "KXQMTR", Name: "\u200b", Device: "Pixel", ExpiresAt: "2026-09-26T12:04:30Z"}) != nil {
		t.Fatal("a name that cleans to nothing still shows")
	}
}

func TestLiveSignIn(t *testing.T) {
	sc := mustParse(t, signInFile(goodSignIn)) // expires at now + 4:30
	for _, c := range []struct {
		at   time.Time
		live bool
	}{
		{now, true},
		{now.Add(270*time.Second - time.Millisecond), true},
		{now.Add(270 * time.Second), false}, // its time is up although the file still has it
		{now.Add(time.Hour), false},
		{now.Add(270*time.Second - MaxSignInAhead), true},
		{now.Add(270*time.Second - MaxSignInAhead - time.Second), false}, // claims to last too long
	} {
		if got := sc.LiveSignIn(c.at) != nil; got != c.live {
			t.Errorf("at %s: live %v", c.at.Format(time.RFC3339Nano), got)
		}
	}
	if (Screen{State: Claimable, SignIn: sc.SignIn}).LiveSignIn(now) != nil {
		t.Fatal("a sign-in outside claimed")
	}
}

func TestRenderSignIn(t *testing.T) {
	sc := mustParse(t, signInFile(goodSignIn))
	f := Render(sc, now, 80, 0, strings.Split(Footer, "\n"))
	for _, w := range []string{"NEW DEVICE", "John Doe wants to sign in", "Pixel 9", "KXQ MTR",
		"Type these letters on that device.", "Didn’t ask for this? Ignore it: the code goes away in 5 min."} {
		if !strings.Contains(f, w) {
			t.Errorf("%q missing from\n%s", w, f)
		}
	}
	if !strings.Contains(f, "█") || strings.Contains(f, "This Whombat is set up.") || strings.ContainsAny(f, "\x1b\r\t") {
		t.Fatalf("frame:\n%s", f)
	}
	// Whole minutes, rounded up; under a minute is 1 min.
	for _, c := range []struct {
		at   time.Duration
		want string
	}{{0, "in 5 min."}, {29 * time.Second, "in 5 min."}, {30 * time.Second, "in 4 min."}, {209 * time.Second, "in 2 min."},
		{211 * time.Second, "in 1 min."}, {269 * time.Second, "in 1 min."}} {
		if f := Render(sc, now.Add(c.at), 80, 0, nil); !strings.Contains(f, c.want) {
			t.Errorf("+%s: %q missing from\n%s", c.at, c.want, f)
		}
	}
	// Its time up, the claimed screen is back.
	if f := Render(sc, now.Add(270*time.Second), 80, 0, nil); !strings.Contains(f, "This Whombat is set up.") || strings.Contains(f, "KXQ") {
		t.Fatalf("expired:\n%s", f)
	}
	// It fits a VT: Terminus 16×32 on 1024×768 is 64×24, and the longest name wraps.
	long := signInFile(`{"code":"KXQMTR","name":"` + strings.Repeat("Wolfgang ", 6) + `Amadeus","device":"` +
		strings.Repeat("d", 64) + `","expiresAt":"2026-09-26T12:04:30Z"}`)
	sc = mustParse(t, long)
	for _, size := range [][2]int{{64, 24}, {80, 25}, {120, 33}} {
		f := Render(sc, now, size[0], size[1], strings.Split(Footer, "\n"))
		lines := strings.Split(f, "\n")
		if len(lines) != size[1] || !strings.Contains(f, "KXQ MTR") || !strings.Contains(f, "Type these letters") ||
			!strings.Contains(f, "goes away in") || !strings.Contains(f, "hold Space") {
			t.Fatalf("%v:\n%s", size, f)
		}
		for _, l := range lines {
			if utf8.RuneCountInString(l) > size[0] {
				t.Fatalf("%v: line wider than the screen: %q", size, l)
			}
		}
	}
}
