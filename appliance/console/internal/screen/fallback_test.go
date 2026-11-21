package screen

import (
	"strings"
	"testing"
)

// The claim link at the box's own address, as the runtime writes it once the address serves its page.
const ownClaim = `"state":"claimable","code":"KXQM","url":"https://quiet-river-otter.box.whombat.app/c/kxqmtv"`

const (
	elseInApp   = "If that page doesn’t open: in the Whombat app on this network, type 192.0.2.10."
	elseTailnet = "If that page doesn’t open: on a device on your tailnet, open whombat.tail1234.ts.net:4480."
	onTailnet   = `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`
)

// The own address is on the internet, where others can keep it busy: under the claim link the screen names a way in
// they can't reach, the Tailscale page when the box has one, else its address on this network for the app.
func TestRenderClaimFallback(t *testing.T) {
	open := "On a computer or phone, open quiet-river-otter.box.whombat.app/c/kxqmtv and enter"
	for name, c := range map[string]struct {
		file       string
		has, hasnt []string
	}{
		"the address on this network": {
			file:  `{"v":1,` + ownClaim + `,"fallbackUrl":"http://192.0.2.10:4480/"}`,
			has:   []string{open, "KXQM", elseInApp},
			hasnt: []string{"tailnet"},
		},
		"another port is said": {
			file: `{"v":1,` + ownClaim + `,"fallbackUrl":"http://192.0.2.10:4490/"}`,
			has:  []string{open, "type 192.0.2.10:4490."},
		},
		"the Tailscale page": {
			file:  reachFile(ownClaim+`,"fallbackUrl":"https://whombat.tail1234.ts.net:4480/"`, onTailnet),
			has:   []string{open, "KXQM", elseTailnet},
			hasnt: []string{"Whombat app"},
		},
		// A runtime from before, or a box with no other way: the screen as it was.
		"none": {
			file:  `{"v":1,` + ownClaim + `}`,
			has:   []string{open, "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		// Nothing the reader could use: an https page that isn't the box's tailnet name, an IPv6 address, loopback,
		// the address already shown.
		"https elsewhere": {
			file:  reachFile(ownClaim+`,"fallbackUrl":"https://example.com/"`, onTailnet),
			has:   []string{open, "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		"only IPv6": {
			file:  `{"v":1,` + ownClaim + `,"fallbackUrl":"http://[fd00::20]:4480/"}`,
			has:   []string{open, "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		"loopback": {
			file:  `{"v":1,` + ownClaim + `,"fallbackUrl":"http://127.0.0.1:4480/"}`,
			has:   []string{open, "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		"the same address": {
			file:  `{"v":1,` + ownClaim + `,"fallbackUrl":"https://quiet-river-otter.box.whombat.app/c/kxqmtv"}`,
			has:   []string{open, "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		// The claim is already on the tailnet or in the app on this network: those can't be kept busy from outside.
		"claimed on the tailnet": {
			file: reachFile(`"state":"claimable","code":"KXQM","url":"https://whombat.tail1234.ts.net:4480/"`+
				`,"fallbackUrl":"http://192.0.2.10:4480/"`, onTailnet),
			has:   []string{"On a device on your tailnet, open whombat.tail1234.ts.net:4480 and enter", "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
		"claimed in the app": {
			file:  lanClaim + `,"fallbackUrl":"https://whombat.tail1234.ts.net:4480/"}`,
			has:   []string{"In the Whombat app on this network, type 192.0.2.10 and enter", "KXQM"},
			hasnt: []string{"doesn’t open"},
		},
	} {
		f := Render(mustParse(t, c.file), now, 200, 0, nil)
		for _, w := range c.has {
			if !strings.Contains(f, w) {
				t.Errorf("%s: %q missing from\n%s", name, w, f)
			}
		}
		for _, w := range c.hasnt {
			if strings.Contains(f, w) {
				t.Errorf("%s: %q shown in\n%s", name, w, f)
			}
		}
	}
}

// A second address the console can't read or that came in the wrong state never costs the screen its code or state.
func TestParseClaimFallbackKeepsTheScreen(t *testing.T) {
	for name, file := range map[string]string{
		"escape sequence": `{"v":1,` + ownClaim + `,"fallbackUrl":"http://192.0.2.10:4480/\u001b[2J"}`,
		"not a url":       `{"v":1,` + ownClaim + `,"fallbackUrl":"192.0.2.10"}`,
		"a query":         `{"v":1,` + ownClaim + `,"fallbackUrl":"http://192.0.2.10:4480/?x=1"}`,
		"not a string":    `{"v":1,` + ownClaim + `,"fallbackUrl":7}`,
	} {
		sc := mustParse(t, file)
		if sc.State != Claimable || sc.Code != "KXQM" || !sc.Openable || sc.FallbackInApp != "" || sc.FallbackTailnet != "" {
			t.Errorf("%s: %+v", name, sc)
		}
	}
	// In the wait and once claimed there is no claim link on the screen, so no second way either.
	for name, file := range map[string]string{
		"backoff": `{"v":1,"state":"backoff","url":"https://quiet-river-otter.box.whombat.app/c/kxqmtv","retryAt":"2026-09-26T12:04:00Z","fallbackUrl":"http://192.0.2.10:4480/"}`,
		"claimed": `{"v":1,"state":"claimed","url":"https://quiet-river-otter.box.whombat.app/","fallbackUrl":"http://192.0.2.10:4480/"}`,
	} {
		sc := mustParse(t, file)
		if sc.FallbackInApp != "" || sc.FallbackTailnet != "" {
			t.Errorf("%s: %+v", name, sc)
		}
		if f := Render(sc, now, 200, 0, nil); strings.Contains(f, "doesn’t open") {
			t.Errorf("%s:\n%s", name, f)
		}
	}
}

// With the second way the claim screen still fits a text console: every word above the footer, the footer last, and
// on the usual 80×25 the letters still drawn large.
func TestRenderClaimFallbackGeometry(t *testing.T) {
	footer := strings.Split(Banner, "\n")
	sc := mustParse(t, `{"v":1,`+ownClaim+`,"fallbackUrl":"http://192.0.2.10:4480/","newLetters":true}`)
	for _, size := range [][2]int{{80, 25}, {64, 24}, {160, 45}, {100, 30}} {
		f := Render(sc, now, size[0], size[1], footer)
		lines := strings.Split(f, "\n")
		if len(lines) > size[1] {
			t.Errorf("%v: %d lines", size, len(lines))
		}
		flat := strings.Join(strings.Fields(f), " ")
		for _, w := range []string{"Claim this Whombat", "KXQM", "Press N for new letters.", elseInApp, "There is no login on this console."} {
			if !strings.Contains(flat, w) {
				t.Errorf("%v: %q missing from\n%s", size, w, f)
			}
		}
		if strings.Index(flat, elseInApp) < strings.Index(flat, "Press N for new letters.") {
			t.Errorf("%v: the second way isn't last\n%s", size, f)
		}
		for _, l := range lines {
			if n := len([]rune(l)); n > size[0] {
				t.Errorf("%v: a line of %d columns\n%s", size, n, f)
			}
		}
	}
	if f := Render(sc, now, 80, 25, footer); !strings.Contains(f, glyphPixel) {
		t.Errorf("80x25: the letters aren't drawn large\n%s", f)
	}
}
