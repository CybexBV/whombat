package screen

import (
	"strings"
	"testing"
	"time"
)

const lanClaim = `{"v":1,"state":"claimable","code":"KXQM","url":"http://192.0.2.10:4480/"`

// New letters asked for at the box (Whombat whombat-link.md): the screen says how to ask, and for how long the
// letters it got stay.
func TestRenderNewLetters(t *testing.T) {
	rotates, press, stay := "The code changes after a wrong try.", "Press N for new letters.", "These letters stay for"
	for name, c := range map[string]struct {
		file       string
		has, hasnt []string
	}{
		// A runtime from before, or a console that can't pass the request on: the screen as it was.
		"not offered": {
			file:  lanClaim + `}`,
			has:   []string{"KXQM", rotates},
			hasnt: []string{press, stay},
		},
		"offered": {
			file:  lanClaim + `,"newLetters":true}`,
			has:   []string{"KXQM", rotates, press},
			hasnt: []string{stay},
		},
		// Asked for: they stay 10 minutes from 12:00, and can be asked for again.
		"asked for": {
			file:  lanClaim + `,"newLetters":true,"lettersUntil":"2026-09-26T12:10:00Z"}`,
			has:   []string{"KXQM", "These letters stay for 10 min.", press},
			hasnt: []string{rotates},
		},
		// A time already past (the file is a moment old): the usual line.
		"ran out": {
			file:  lanClaim + `,"newLetters":true,"lettersUntil":"2026-09-26T11:59:59Z"}`,
			has:   []string{"KXQM", rotates},
			hasnt: []string{stay},
		},
		"the wait": {
			file:  `{"v":1,"state":"backoff","url":"http://192.0.2.10:4480/","retryAt":"2026-09-26T12:04:00Z","newLetters":true}`,
			has:   []string{"Too many wrong codes. Try again in 4 min.", "Or press N for new letters now."},
			hasnt: []string{"KXQM"},
		},
		"the wait, not offered": {
			file:  `{"v":1,"state":"backoff","url":"http://192.0.2.10:4480/","retryAt":"2026-09-26T12:04:00Z"}`,
			has:   []string{"Too many wrong codes. Try again in 4 min."},
			hasnt: []string{"press N"},
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

func TestParseNewLetters(t *testing.T) {
	sc := mustParse(t, lanClaim+`,"newLetters":true,"lettersUntil":"2026-09-26T12:10:00Z"}`)
	if !sc.NewLetters || !sc.LettersUntil.Equal(now.Add(10*time.Minute)) || !sc.LettersStay(now) {
		t.Fatalf("%+v", sc)
	}
	if sc.LettersStay(now.Add(10 * time.Minute)) {
		t.Fatal("stays past its time")
	}
	// Outside the states that carry them the file isn't the contract's: the starting screen, never a half-read one.
	for _, bad := range []string{
		`{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","newLetters":true}`,
		`{"v":1,"state":"backoff","url":"https://app.whombat.com/claim","retryAt":"2026-09-26T12:04:00Z","lettersUntil":"2026-09-26T12:10:00Z"}`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

// Only the N key, alone: a pasted word or an escape sequence that holds an n asks for nothing.
func TestAsksNewLetters(t *testing.T) {
	for keys, want := range map[string]bool{
		"n": true, "N": true, "": false, "m": false, "nn": false, "no": false, "\x1b[n": false, "\r": false,
	} {
		if got := AsksNewLetters([]byte(keys)); got != want {
			t.Errorf("%q: %v, want %v", keys, got, want)
		}
	}
}

// A box with only an IPv6 address on its network: the app can't take that, so the screen says an IPv4 address is
// another way, under the line that names Whombat Link and Tailscale.
func TestRenderIPv6Only(t *testing.T) {
	noAddress := "The code appears once this Whombat has a secure address: Whombat Link or Tailscale."
	ipv4 := "If it also gets an IPv4 address, the code appears here and you can claim it in the Whombat app."
	for name, c := range map[string]struct {
		file       string
		has, hasnt []string
	}{
		"IPv6 only": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://[fd00::5]:4480/"}`,
			has:   []string{noAddress, "only an IPv6 address", ipv4},
			hasnt: []string{"KXQM", "fd00"},
		},
		// The Expert choice waiting for Tailscale: its own line stays, the IPv4 way is added.
		"IPv6 only, Tailscale sign-in": {
			file: `{"v":1,"state":"claimable","code":"KXQM","url":"http://[2001:db8::5]:4480/"` +
				`,"reach":{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}}`,
			has:   []string{"After you sign in to Tailscale and turn on HTTPS, the code appears here.", ipv4},
			hasnt: []string{"KXQM", "Whombat Link or Tailscale"},
		},
		"a name, not an address": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.tail1234.ts.net/"}`,
			has:   []string{noAddress},
			hasnt: []string{"IPv6", "IPv4"},
		},
		"IPv4": {
			file:  lanClaim + `}`,
			has:   []string{"KXQM"},
			hasnt: []string{"IPv6", "IPv4"},
		},
		// A box set up already says nothing about addresses it lacks.
		"IPv6 only, claimed": {
			file:  `{"v":1,"state":"claimed","url":"http://[fd00::5]:4480/"}`,
			has:   []string{"This Whombat is set up."},
			hasnt: []string{"IPv6", "IPv4"},
		},
		// Only a link-local or a public IPv6 address: the box names no address at all and waits. The runtime says the
		// network is IPv6 only on its own, and the screen says the same as with an address it could name.
		"IPv6 only, no address to name": {
			file:  `{"v":1,"state":"waiting","url":"http://0.0.0.0/","ipv6Only":true}`,
			has:   []string{"Claim this Whombat", noAddress, "only an IPv6 address", ipv4},
			hasnt: []string{"Check the network cable.", "0.0.0.0"},
		},
		"IPv6 only, no address to name, Tailscale sign-in": {
			file: `{"v":1,"state":"waiting","url":"http://0.0.0.0/","ipv6Only":true` +
				`,"reach":{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}}`,
			has:   []string{"After you sign in to Tailscale and turn on HTTPS, the code appears here.", ipv4},
			hasnt: []string{"Check the network cable.", "Whombat Link or Tailscale"},
		},
		// With an address the app can take, or one to open, there is a way in to show: nothing about IPv6.
		"said IPv6 only beside an IPv4 address": {
			file:  lanClaim + `,"ipv6Only":true}`,
			has:   []string{"KXQM"},
			hasnt: []string{"IPv6", "IPv4"},
		},
		"said IPv6 only beside a secure address": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"https://whombat.tail1234.ts.net/","ipv6Only":true}`,
			has:   []string{"KXQM"},
			hasnt: []string{"IPv6", "IPv4"},
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
	for raw, want := range map[string]bool{
		"http://[fd00::5]:4480/":     true,
		"http://[2001:db8::5]/":      true,
		"http://[::1]:4480/":         false,
		"http://[::]:4480/":          false,
		"https://[fd00::5]/":         false,
		"http://192.0.2.10:4480/":    false,
		"http://whombat.local/":      false,
		"http://[::ffff:192.0.2.1]/": false,
	} {
		if got := mustParse(t, `{"v":1,"state":"claimed","url":"`+raw+`"}`).IPv6Only; got != want {
			t.Errorf("%s: IPv6 only %v, want %v", raw, got, want)
		}
	}
}

// A box nobody can reach yet (no network): the runtime names no address, and neither does the screen. Never the
// hosted app's, never “localhost”, which would be the reader's own phone or computer.
func TestRenderNoAddressAtAll(t *testing.T) {
	for name, c := range map[string]struct {
		file       string
		has, hasnt []string
	}{
		"unclaimed": {
			file:  `{"v":1,"state":"waiting","url":"http://0.0.0.0/"}`,
			has:   []string{"Connecting to Whombat…", "Check the network cable."},
			hasnt: []string{"0.0.0.0", "localhost", "open ", "type "},
		},
		"claimed": {
			file:  `{"v":1,"state":"claimed","url":"http://0.0.0.0/"}`,
			has:   []string{"This Whombat is set up.", "Use it in the Whombat app on this network."},
			hasnt: []string{"0.0.0.0", "localhost", "Open "},
		},
	} {
		sc := mustParse(t, c.file)
		if sc.Openable || sc.InApp != "" || sc.IPv6Only {
			t.Errorf("%s: %+v", name, sc)
		}
		f := Render(sc, now, 200, 0, nil)
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
