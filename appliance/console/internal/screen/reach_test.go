package screen

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const (
	claimableFile = `"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"`
	linkStarting  = `{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-26T12:12:30Z"}`
	loginURL      = `"loginUrl":"https://login.tailscale.com/a/abc123"`
)

// reachFile is a state file (its members without braces) with the given reach member (raw JSON).
func reachFile(state, reach string) string { return `{"v":1,` + state + `,"reach":` + reach + `}` }

func TestParseReach(t *testing.T) {
	sc := mustParse(t, reachFile(claimableFile, `{"link":`+linkStarting+`,"tailscale":{`+loginURL+`,"needsHttps":true,"name":"whombat.tail1234.ts.net"}}`))
	l, ts := sc.Reach.Link, sc.Reach.Tailscale
	if sc.State != Claimable || sc.Code != "KXQM" || l == nil || l.State != "starting" || l.Code != "ABCD-EFGH" ||
		l.URL != "app.whombat.com/link" || !l.ExpiresAt.Equal(now.Add(750*time.Second)) || l.WaitingForAddress {
		t.Fatalf("%+v %+v", sc, l)
	}
	if ts == nil || ts.LoginURL != "login.tailscale.com/a/abc123" || !ts.NeedsHTTPS || ts.Name != "whombat.tail1234.ts.net" {
		t.Fatalf("%+v", ts)
	}
	// In any claim state, and grace with its date.
	sc = mustParse(t, reachFile(`"state":"claimed","url":"https://app.whombat.com/claim"`,
		`{"link":{"state":"grace","graceEndsAt":"2026-11-25T10:00:00Z"}}`))
	if sc.Reach == nil || sc.Reach.Link.State != "grace" || sc.Reach.Link.GraceEndsAt.Day() != 25 || sc.Reach.Tailscale != nil {
		t.Fatalf("%+v", sc.Reach)
	}
	// Nothing to show: no reach at all.
	if sc := mustParse(t, reachFile(claimableFile, `{"tailscale":{}}`)); sc.Reach != nil {
		t.Fatalf("%+v", sc.Reach)
	}
}

// A reach the console can't use is dropped, never the claim state or its code (the file's decorations).
func TestParseReachKeepsTheClaimScreen(t *testing.T) {
	for name, reach := range map[string]string{
		"wrong type":            `"on"`,
		"link wrong type":       `{"link":"starting"}`,
		"newer link state":      `{"link":{"state":"paused"}}`,
		"no link state":         `{"link":{"code":"ABCD-EFGH"}}`,
		"lower-case code":       `{"link":{"state":"starting","code":"abcd-efgh","url":"https://app.whombat.com/link"}}`,
		"code outside alphabet": `{"link":{"state":"starting","code":"ABCD-EFGI","url":"https://app.whombat.com/link"}}`,
		"escape in code":        `{"link":{"state":"starting","code":"ABCD\u001b[2J","url":"https://app.whombat.com/link"}}`,
		"http link page":        `{"link":{"state":"starting","code":"ABCD-EFGH","url":"http://app.whombat.com/link"}}`,
		"escape in link page":   `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/\u001b]0;x\u0007"}}`,
		"numeric expiresAt":     `{"link":{"state":"starting","expiresAt":1790424270}}`,
		"waiting as a string":   `{"link":{"state":"starting","waitingForAddress":"yes"}}`,
		"escape in login url":   `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/\u001b[2Jabc"}}`,
		"newline in login url":  `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc\nroot# "}}`,
		"login url too long":    `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/` + strings.Repeat("a", 500) + `"}}`,
		"javascript login":      `{"tailscale":{"loginUrl":"javascript:alert(1)//xx"}}`,
		"upper-case name":       `{"tailscale":{"name":"Whombat.ts.net"}}`,
		"name with escape":      `{"tailscale":{"name":"whombat\u001b.ts.net"}}`,
		"needsHttps as string":  `{"tailscale":{"needsHttps":"true"}}`,
	} {
		sc, err := Parse([]byte(reachFile(claimableFile, reach)))
		if err != nil || sc.State != Claimable || sc.Code != "KXQM" || sc.URL != "dev.whombat.com/claim" || sc.Reach != nil {
			t.Errorf("%s: %+v %v", name, sc, err)
			continue
		}
		f := frame(sc)
		if !strings.Contains(f, "Claim this Whombat") || !strings.Contains(f, "KXQM") || strings.ContainsAny(f, "\x1b\a\r") {
			t.Errorf("%s: not the claim screen\n%s", name, f)
		}
	}
	// What the schema allows but the screen doesn't show goes on its own: the code without a usable page, a sign-in
	// link a terminal would read as more than text.
	for name, reach := range map[string]string{
		"link page with query":  `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link?x=1"}}`,
		"link page userinfo":    `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://evil@app.whombat.com/link"}}`,
		"code without page":     `{"link":{"state":"starting","code":"ABCD-EFGH"}}`,
		"login with fragment":   `{"link":{"state":"starting"},"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc#x"}}`,
		"login with userinfo":   `{"link":{"state":"starting"},"tailscale":{"loginUrl":"https://evil@login.tailscale.com/a/abc"}}`,
		"login with percent":    `{"link":{"state":"starting"},"tailscale":{"loginUrl":"https://login.tailscale.com/a/%1b%5b2J"}}`,
		"login with semicolons": `{"link":{"state":"starting"},"tailscale":{"loginUrl":"https://login.tailscale.com/a;b"}}`,
	} {
		sc := mustParse(t, reachFile(claimableFile, reach))
		if sc.State != Claimable || sc.Code != "KXQM" || sc.Reach == nil || sc.Reach.Link == nil || sc.Reach.Link.Code != "" ||
			sc.Reach.Link.URL != "" || sc.Reach.Tailscale != nil {
			t.Errorf("%s: %+v", name, sc.Reach)
		}
		if f := frame(sc); !strings.Contains(f, "Starting Whombat Link…") || strings.Contains(f, "ABCD-EFGH") ||
			strings.Contains(f, "Sign in to Tailscale") {
			t.Errorf("%s:\n%s", name, f)
		}
	}
	// A bad reach next to a bad sign-in and a good alert: both bad ones go, the alert and the burrows stay.
	sc := mustParse(t, `{"v":1,"state":"claimed",`+claimedURL+`,"burrows":{"first":"Banjo’s Burrow","more":2},`+
		`"signIn":{"code":"kxqmtr"},"alert":{"kind":"own_address_foreign","since":"2026-09-26T11:00:00Z"},"reach":[]}`)
	if sc.State != Claimed || sc.Burrows == nil || sc.SignIn != nil || sc.Alert == nil || sc.Reach != nil {
		t.Fatalf("%+v", sc)
	}
}

func TestRenderLinkStarting(t *testing.T) {
	// Unclaimed, with or without a claim code: the Link code first, in block letters.
	for _, state := range []string{claimableFile, `"state":"waiting","url":"https://dev.whombat.com/claim"`,
		`"state":"starting","url":"https://dev.whombat.com/claim"`} {
		f := frame(mustParse(t, reachFile(state, `{"link":`+linkStarting+`}`)))
		for _, w := range []string{"Turn on Whombat Link", "On a computer or phone, open app.whombat.com/link and enter",
			"ABCD-EFGH", "Sign in or create an account there, then confirm this Whombat.", "The code changes in 13 min."} {
			if !strings.Contains(f, w) {
				t.Errorf("%s: %q missing from\n%s", state, w, f)
			}
		}
		if strings.Contains(f, "Claim this Whombat") || strings.Contains(f, "KXQM") || strings.Count(f, "█") < 60 {
			t.Errorf("%s: not the Link screen\n%s", state, f)
		}
	}
	// Claimed: the code shows while there is one to type (Link chosen in the recovery menu, no app at hand); without
	// one the box's own screen stays.
	f := frame(mustParse(t, reachFile(`"state":"claimed",`+claimedURL, `{"link":`+linkStarting+`}`)))
	if !strings.Contains(f, "ABCD-EFGH") || strings.Contains(f, "This Whombat is set up.") {
		t.Errorf("claimed with a code:\n%s", f)
	}
	f = frame(mustParse(t, reachFile(`"state":"claimed",`+claimedURL, `{"link":{"state":"starting","waitingForAddress":true}}`)))
	if strings.Contains(f, "web address…") || !strings.Contains(f, "This Whombat is set up.") {
		t.Errorf("claimed, waiting:\n%s", f)
	}
	// Waiting for an address, and no code (yet, or no longer).
	f = Render(mustParse(t, reachFile(claimableFile, `{"link":{"state":"starting","waitingForAddress":true}}`)), now, 200, 0, nil)
	if !strings.Contains(f, "web address…") || !strings.Contains(f, "changes by itself") || strings.Contains(f, "KXQM") {
		t.Errorf("waiting:\n%s", f)
	}
	for name, l := range map[string]string{
		"no code": `{"state":"starting"}`,
		"expired": `{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-26T11:59:59Z"}`,
	} {
		f = frame(mustParse(t, reachFile(claimableFile, `{"link":`+l+`}`)))
		if !strings.Contains(f, "Starting Whombat Link…") || strings.Contains(f, "ABCD") || strings.Contains(f, "KXQM") {
			t.Errorf("%s:\n%s", name, f)
		}
	}
	// No expiry, or one too far off to be true: the code without a count.
	for _, exp := range []string{``, `,"expiresAt":"2027-01-01T00:00:00Z"`} {
		f = frame(mustParse(t, reachFile(claimableFile, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link"`+exp+`}}`)))
		if !strings.Contains(f, "ABCD-EFGH") || strings.Contains(f, "The code changes in") {
			t.Errorf("expiresAt %q:\n%s", exp, f)
		}
	}
	// Link on: the claim screen with the box's own claim link, as today.
	f = Render(mustParse(t, reachFile(`"state":"claimable","code":"KXQM","url":"https://able-baker-charlie.box.whombat.app/c/s3cr3t"`,
		`{"link":{"state":"on"}}`)), now, 200, 0, nil)
	if !strings.Contains(f, "On a computer or phone, open able-baker-charlie.box.whombat.app/c/s3cr3t and enter") {
		t.Errorf("on:\n%s", f)
	}
}

func TestRenderLinkGraceAndEnded(t *testing.T) {
	grace := "Whombat Link ends on 25 November. Turn on Tailscale in the Whombat app to keep a way in, and check your paper backup details."
	ended := "Whombat Link has ended. Subscribe again at app.whombat.com, or turn on Tailscale: in the Whombat app at home, " +
		"or in the recovery menu (hold Space at power-on)."
	for _, state := range []string{`"state":"claimed",` + claimedURL, claimableFile} {
		for words, l := range map[string]string{
			grace: `{"state":"grace","graceEndsAt":"2026-11-25T10:00:00Z"}`,
			ended: `{"state":"ended"}`,
		} {
			sc := mustParse(t, reachFile(state, `{"link":`+l+`}`))
			f := Render(sc, now, 200, 0, nil) // wide: each paragraph on one line
			if !strings.Contains(f, words) {
				t.Errorf("%s: %q missing from\n%s", state, words, f)
			}
			// Above the normal screen.
			body := "This Whombat is set up."
			if sc.State == Claimable {
				body = "Claim this Whombat"
			}
			if i, j := strings.Index(f, words), strings.Index(f, body); j < 0 || i > j {
				t.Errorf("%s: not above the body\n%s", state, f)
			}
		}
	}
	// Another year says so; grace without a date says nothing rather than a wrong date.
	if f := frame(mustParse(t, reachFile(claimableFile, `{"link":{"state":"grace","graceEndsAt":"2027-01-03T10:00:00Z"}}`))); !strings.Contains(f, "3 January 2027") {
		t.Errorf("next year:\n%s", f)
	}
	if f := frame(mustParse(t, reachFile(claimableFile, `{"link":{"state":"grace"}}`))); strings.Contains(f, "Whombat Link") {
		t.Errorf("no date:\n%s", f)
	}
}

func TestRenderTailscale(t *testing.T) {
	login := "Sign in to Tailscale: open login.tailscale.com/a/abc123 on a computer or phone."
	https := "Turn on HTTPS in Tailscale: in the Tailscale admin console, open DNS and turn on HTTPS Certificates. " +
		"This Whombat checks again by itself."
	for _, state := range []string{`"state":"claimed",` + claimedURL, claimableFile, `"state":"waiting","url":"https://dev.whombat.com/claim"`} {
		f := Render(mustParse(t, reachFile(state, `{"tailscale":{`+loginURL+`,"needsHttps":true}}`)), now, 200, 0, nil)
		if !strings.Contains(f, login) || !strings.Contains(f, https) || strings.Index(f, login) > strings.Index(f, https) {
			t.Errorf("%s:\n%s", state, f)
		}
	}
	// Order: the alert, Tailscale, then Link's end, then the body.
	f := Render(mustParse(t, reachFile(claimableFile+`,"alert":{"kind":"own_address_foreign","since":"2026-09-26T11:00:00Z"}`,
		`{"link":{"state":"ended"},"tailscale":{`+loginURL+`}}`)), now, 200, 0, nil)
	order := []string{"WARNING", "Sign in to Tailscale", "Whombat Link has ended", "Claim this Whombat"}
	for i := 1; i < len(order); i++ {
		if strings.Index(f, order[i-1]) < 0 || strings.Index(f, order[i-1]) > strings.Index(f, order[i]) {
			t.Fatalf("%q not before %q:\n%s", order[i-1], order[i], f)
		}
	}
	// A long sign-in link is shown whole over several lines, none wider than the screen.
	long := "login.tailscale.com/a/" + strings.Repeat("abcdef0123", 20)
	sc := mustParse(t, reachFile(claimableFile, `{"tailscale":{"loginUrl":"https://`+long+`"}}`))
	f = Render(sc, now, 80, 25, strings.Split(Footer, "\n"))
	joined := ""
	for _, l := range strings.Split(f, "\n") {
		if utf8.RuneCountInString(l) > 80 {
			t.Fatalf("line wider than the screen: %q", l)
		}
		joined += strings.TrimSpace(l)
	}
	if !strings.Contains(joined, long) {
		t.Fatalf("sign-in link cut:\n%s", f)
	}
}

func TestRenderClaimOnTailnet(t *testing.T) {
	tsClaim := `"state":"claimable","code":"KXQM","url":"https://whombat.tail1234.ts.net/c/s3cr3t"`
	f := frame(mustParse(t, reachFile(tsClaim, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`)))
	if !strings.Contains(f, "On a device on your tailnet, open whombat.tail1234.ts.net/c/s3cr3t and enter") || !strings.Contains(f, "KXQM") {
		t.Errorf("tailnet:\n%s", f)
	}
	// A claim link elsewhere keeps today's words.
	f = frame(mustParse(t, reachFile(claimableFile, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`)))
	if !strings.Contains(f, "On a computer or phone, open dev.whombat.com/claim and enter") {
		t.Errorf("elsewhere:\n%s", f)
	}
	// Tailscale named but the box claimed: the claimed screen, no claim words.
	f = frame(mustParse(t, reachFile(`"state":"claimed","url":"https://whombat.tail1234.ts.net/"`, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`)))
	if strings.Contains(f, "tailnet") || !strings.Contains(f, "This Whombat is set up.") {
		t.Errorf("claimed:\n%s", f)
	}
}

// Everything at once still fits the screen, the codes in plain letters at least: on a claimed box with the footer at the
// bottom, on one being set up without it (it gives way to Link's code).
func TestRenderReachGeometry(t *testing.T) {
	footer := strings.Split(Footer, "\n")
	const alert = `,"alert":{"kind":"own_address_foreign","since":"2026-09-26T11:00:00Z"}`
	const reach = `{"link":` + linkStarting + `,"tailscale":{` + loginURL + `,"needsHttps":true}}`
	claimed := mustParse(t, reachFile(`"state":"claimed",`+claimedURL+alert, reach))
	sc := mustParse(t, reachFile(claimableFile+alert, reach))
	for _, size := range [][2]int{{80, 25}, {64, 24}, {160, 45}, {100, 30}} {
		f := Render(claimed, now, size[0], size[1], footer)
		lines := strings.Split(f, "\n")
		if len(lines) != size[1] || !strings.Contains(strings.Join(lines[len(lines)-2:], " "), "hold Space") || !strings.Contains(f, "ABCD-EFGH") {
			t.Fatalf("claimed %v: %d lines, footer not at the bottom\n%s", size, len(lines), f)
		}
		f = Render(sc, now, size[0], size[1], footer)
		lines = strings.Split(f, "\n")
		if len(lines) != size[1] || strings.Contains(f, "hold Space") {
			t.Fatalf("%v: %d lines, or the footer shows while the box is set up\n%s", size, len(lines), f)
		}
		for _, l := range lines {
			if utf8.RuneCountInString(l) > size[0] {
				t.Fatalf("%v: line wider than the screen: %q", size, l)
			}
		}
		if !strings.Contains(f, "ABCD-EFGH") || !strings.Contains(f, "The code changes in 13 min.") {
			t.Fatalf("%v:\n%s", size, f)
		}
	}
	// Room enough: block letters.
	if f := Render(sc, now, 160, 45, footer); !strings.Contains(f, "█") {
		t.Fatalf("no block letters on a large screen:\n%s", f)
	}
}

// The Link code's alphabet (the claim alphabet, upper case, and the dash) all has block letters.
func TestFontHasLinkCode(t *testing.T) {
	for _, r := range "ABCDEFGHJKMNPQRTVWXY-" {
		if _, ok := font[r]; !ok {
			t.Fatalf("no glyph for %q", r)
		}
	}
	if rows, ok := bigText("ABCD-EFGH", 1, 2); !ok || utf8.RuneCountInString(rows[0]) > 78 {
		t.Fatal("the Link code doesn't fit 80 columns in block letters")
	}
}
