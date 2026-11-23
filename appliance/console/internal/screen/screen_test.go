package screen

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var now = time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

func mustParse(t *testing.T, s string) Screen {
	t.Helper()
	sc, err := Parse([]byte(s))
	if err != nil {
		t.Fatalf("Parse(%s): %v", s, err)
	}
	return sc
}

func TestParseStates(t *testing.T) {
	sc := mustParse(t, `{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}`)
	if sc.State != Claimable || sc.Code != "KXQM" || sc.URL != "dev.whombat.com/claim" {
		t.Fatalf("%+v", sc)
	}
	sc = mustParse(t, `{"v":1,"state":"backoff","url":"http://localhost:5190/claim","retryAt":"2026-09-26T12:04:30Z"}`)
	if sc.URL != "localhost:5190/claim" || !sc.RetryAt.Equal(now.Add(270*time.Second)) {
		t.Fatalf("%+v", sc)
	}
	for _, st := range []string{"starting", "waiting", "claimed"} {
		if sc := mustParse(t, `{"v":1,"state":"`+st+`","url":"https://app.whombat.com/claim"}`); sc.State != st {
			t.Fatal(st)
		}
	}
	// Members the contract doesn't know are ignored (a newer runtime must not blank the console).
	mustParse(t, `{"v":1,"state":"waiting","url":"https://a.b/claim","extra":1}`)
}

func TestParseRefuses(t *testing.T) {
	for name, s := range map[string]string{
		"not json":                `nope`,
		"version":                 `{"v":2,"state":"waiting","url":"https://a.b/claim"}`,
		"unknown state":           `{"v":1,"state":"owned","url":"https://a.b/claim"}`,
		"trailing data":           `{"v":1,"state":"waiting","url":"https://a.b/claim"} {}`,
		"no url":                  `{"v":1,"state":"waiting"}`,
		"claimable no code":       `{"v":1,"state":"claimable","url":"https://a.b/claim"}`,
		"code elsewhere":          `{"v":1,"state":"claimed","code":"KXQM","url":"https://a.b/claim"}`,
		"lower-case code":         `{"v":1,"state":"claimable","code":"kxqm","url":"https://a.b/claim"}`,
		"escape in code":          `{"v":1,"state":"claimable","code":"KX\u001b[2JQM","url":"https://a.b/claim"}`,
		"CSI in code":             `{"v":1,"state":"claimable","code":"KXQM\u009b2J","url":"https://a.b/claim"}`,
		"escape in url":           `{"v":1,"state":"waiting","url":"https://a.b/\u001b]0;pwned\u0007"}`,
		"newline in url":          `{"v":1,"state":"claimed","url":"https://a.b/claim\nroot# "}`,
		"bidi override url":       `{"v":1,"state":"claimed","url":"https://a.b/‮claim"}`,
		"url with query":          `{"v":1,"state":"claimed","url":"https://a.b/claim?x=1"}`,
		"url with userinfo":       `{"v":1,"state":"claimed","url":"https://evil@a.b/claim"}`,
		"url with space":          `{"v":1,"state":"claimed","url":"https://a.b/claim now"}`,
		"javascript url":          `{"v":1,"state":"claimed","url":"javascript:alert(1)"}`,
		"no scheme":               `{"v":1,"state":"claimed","url":"a.b/claim"}`,
		"numeric retryAt":         `{"v":1,"state":"backoff","url":"https://a.b/claim","retryAt":1790424270}`,
		"retryAt elsewhere":       `{"v":1,"state":"waiting","url":"https://a.b/claim","retryAt":"2026-09-26T12:04:30Z"}`,
		"letter outside alphabet": `{"v":1,"state":"claimable","code":"KIQM","url":"https://a.b/claim"}`,
		"url with fragment":       `{"v":1,"state":"claimed","url":"https://a.b/claim#s=1"}`,
		"backoff no retryAt":      `{"v":1,"state":"backoff","url":"https://a.b/claim"}`,
		"bad retryAt":             `{"v":1,"state":"backoff","url":"https://a.b/claim","retryAt":"soon"}`,
		"negative retryAt":        `{"v":1,"state":"backoff","url":"https://a.b/claim","retryAt":-5}`,
		"oversized":               `{"v":1,"state":"waiting","url":"https://a.b/claim","x":"` + strings.Repeat("a", MaxFileSize) + `"}`,
		"code wrong type":         `{"v":1,"state":"claimable","code":4821,"url":"https://a.b/claim"}`,
		"url far too long":        `{"v":1,"state":"claimed","url":"https://a.b/` + strings.Repeat("c", 200) + `"}`,
		"empty object":            `{}`,
		"array":                   `[]`,
		"null":                    `null`,
		"state with escape":       `{"v":1,"state":"waiting\u001b","url":"https://a.b/claim"}`,
		"invalid utf-8 in url":    "{\"v\":1,\"state\":\"claimed\",\"url\":\"a.b/\xff\"}",
	} {
		if sc, err := Parse([]byte(s)); err == nil {
			t.Errorf("%s: accepted as %+v", name, sc)
		}
	}
}

func TestClean(t *testing.T) {
	in := "a\x1b[2J\x07b\r\nc\u009bd‮e\x7f​f"
	// Like the recovery menu's filter (N-3): the control characters go, the printable rest stays inert.
	if got := Clean(in); got != "a[2Jbcdef" {
		t.Fatalf("Clean = %q", got)
	}
	if Clean("Starting Whombat… “ok” ’") != "Starting Whombat… “ok” ’" {
		t.Fatal("Clean must keep printable Unicode")
	}
}

func frame(sc Screen) string { return Render(sc, now, 80, 0, strings.Split(Footer, "\n")) }

func TestRenderWords(t *testing.T) {
	cases := []struct {
		sc   Screen
		want []string
	}{
		{StartingScreen, []string{"Starting Whombat…"}},
		{Screen{State: Waiting, URL: "dev.whombat.com/claim"}, []string{"Connecting to Whombat…",
			"Check the network cable. The claim code appears once this Whombat is online."}},
		{Screen{State: Claimable, Code: "KXQM", URL: "dev.whombat.com/claim", Openable: true}, []string{"Claim this Whombat",
			"On a computer or phone, open dev.whombat.com/claim and enter", "KXQM",
			"The code changes after a wrong try."}},
		{Screen{State: Backoff, URL: "dev.whombat.com/claim", RetryAt: now.Add(4*time.Minute + time.Second)},
			[]string{"Too many wrong codes. Try again in 5 min."}},
		{Screen{State: Claimed, URL: "dev.whombat.com/claim", Openable: true}, []string{"This Whombat is set up.",
			"Open dev.whombat.com/claim to use it."}},
	}
	for _, c := range cases {
		f := frame(c.sc)
		for _, w := range c.want {
			if !strings.Contains(f, w) {
				t.Errorf("%s: %q missing from\n%s", c.sc.State, w, f)
			}
		}
		// The footer under every screen but the claim's (the person setting the box up doesn't need it yet).
		setup := c.sc.State == Claimable || c.sc.State == Backoff
		for _, w := range strings.Split(Footer, "\n") {
			if strings.Contains(f, w) == setup {
				t.Errorf("%s: footer line %q shown %v\n%s", c.sc.State, w, !setup, f)
			}
		}
		if c.sc.State != Claimable && strings.Contains(f, "█") {
			t.Errorf("%s: block letters outside claimable", c.sc.State)
		}
		if strings.ContainsAny(f, "\x1b\r\t") {
			t.Errorf("%s: control characters in the frame", c.sc.State)
		}
	}
}

func TestRenderBigCode(t *testing.T) {
	// Wide: square pixels (two columns each).
	f := Render(Screen{State: Claimable, Code: "KXQM", URL: "a.b/claim", Openable: true}, now, 80, 0, nil)
	if !strings.Contains(f, "██      ██") || strings.Count(f, "█") < 80 {
		t.Fatalf("no double-width block letters at 80 columns:\n%s", f)
	}
	// Narrower: one column per pixel.
	f = Render(Screen{State: Claimable, Code: "KXQM", URL: "a.b/claim", Openable: true}, now, 40, 0, nil)
	if strings.Contains(f, "████") || strings.Count(f, "█") < 40 || !strings.Contains(f, "KXQM") {
		t.Fatalf("40 columns:\n%s", f)
	}
	// Too narrow for block letters: the plain letters only.
	f = Render(Screen{State: Claimable, Code: "KXQM", URL: "a.b/claim", Openable: true}, now, 22, 0, nil)
	if strings.Contains(f, "█") || !strings.Contains(f, "KXQM") {
		t.Fatalf("22 columns:\n%s", f)
	}
	// A letter outside the font falls back to plain text.
	f = Render(Screen{State: Claimable, Code: "ILOS", URL: "a.b/claim", Openable: true}, now, 120, 0, nil)
	if strings.Contains(f, "█") || !strings.Contains(f, "ILOS") {
		t.Fatalf("letters outside the font:\n%s", f)
	}
	for r := range font {
		if len(font[r]) != glyphRows {
			t.Fatalf("glyph %q", r)
		}
		// Five pixels wide, the space between the sign-in's groups three (BX-06).
		w := 5
		if r == ' ' {
			w = 3
		}
		for _, row := range font[r] {
			if len(row) != w {
				t.Fatalf("glyph %q row %q", r, row)
			}
		}
	}
	for _, r := range "ABCDEFGHJKMNPQRTVWXY0123456789-" {
		if _, ok := font[r]; !ok {
			t.Fatalf("no glyph for %q (CC-01 alphabet)", r)
		}
	}
}

func TestRenderFullScreenGeometry(t *testing.T) {
	footer := strings.Split(Footer, "\n")
	for _, size := range [][2]int{{80, 25}, {64, 24}, {50, 18}, {160, 45}} {
		for _, sc := range []Screen{StartingScreen, {State: Claimable, Code: "KXQM", URL: "dev.whombat.com/claim"},
			{State: Waiting, URL: "x.y/claim"}, {State: Claimed, URL: "app.whombat.com"}} {
			f := Render(sc, now, size[0], size[1], footer)
			lines := strings.Split(f, "\n")
			// Exactly the screen's lines, none more (a VT never scrolls); the last may be blank without the footer.
			if len(lines) != size[1] || strings.Count(f, "\n") != size[1]-1 {
				t.Fatalf("%v %s: %d lines", size, sc.State, len(lines))
			}
			for _, l := range lines {
				if utf8.RuneCountInString(l) > size[0] {
					t.Fatalf("%v %s: line wider than the screen: %q", size, sc.State, l)
				}
			}
			// During the claim the footer gives way: the person setting the box up doesn't need it yet.
			if sc.State == Claimable {
				if strings.Contains(f, "hold Space") {
					t.Fatalf("%v %s: the footer shows during the claim:\n%s", size, sc.State, f)
				}
				continue
			}
			if !strings.HasPrefix(lines[len(lines)-1], "  ") || !strings.Contains(f, "hold Space") {
				t.Fatalf("%v %s: footer not at the bottom:\n%s", size, sc.State, f)
			}
		}
	}
	// Vertically centred: the title is roughly in the middle of the area above the footer.
	lines := strings.Split(Render(StartingScreen, now, 80, 25, footer), "\n")
	for i, l := range lines {
		if strings.Contains(l, "Starting Whombat") && (i < 8 || i > 13) {
			t.Fatalf("title on line %d", i)
		}
	}
}
