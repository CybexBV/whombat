package screen

import (
	"slices"
	"strings"
	"testing"
)

func TestOpenable(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://dev.whombat.com/claim":                   true,
		"https://able-baker-charlie.box.whombat.app/c/s3": true,
		"https://192.0.2.10/c/s3":                         true,
		"http://localhost:5190/claim":                     true,
		"http://LOCALHOST/claim":                          true,
		"http://127.0.0.1:4480/c/s3":                      true,
		"http://127.1.2.3/c/s3":                           true,
		"http://[::1]:4480/c/s3":                          true,
		"http://192.0.2.10:4480/c/s3":                     false,
		"http://whombat.local:4480/c/s3":                  false,
		"http://localhost.example.com/c/s3":               false,
		"http://128.0.0.1/c/s3":                           false,
		"http://[fd00::5]:4480/c/s3":                      false,
		"http://whombat.tail1234.ts.net/c/s3":             false,
	} {
		sc := mustParse(t, `{"v":1,"state":"claimed","url":"`+raw+`"}`)
		if sc.Openable != want {
			t.Errorf("%s: openable %v, want %v", raw, sc.Openable, want)
		}
	}
}

func TestInApp(t *testing.T) {
	for raw, want := range map[string]string{
		"http://192.168.1.20:4480/":      "192.168.1.20",
		"http://10.0.2.15:4480/c/s3":     "10.0.2.15",
		"http://192.0.2.10:8080/":        "192.0.2.10:8080",
		"http://192.0.2.10/":             "192.0.2.10:80",
		"http://127.0.0.1:4480/":         "",
		"http://0.0.0.0:4480/":           "",
		"http://[fd00::5]:4480/":         "",
		"http://whombat.local:4480/":     "",
		"https://192.0.2.10/":            "",
		"https://x.box.whombat.app/c/s3": "",
	} {
		if got := mustParse(t, `{"v":1,"state":"claimed","url":"`+raw+`"}`).InApp; got != want {
			t.Errorf("%s: in app %q, want %q", raw, got, want)
		}
	}
}

// Plain HTTP on a box answers only “This Whombat opens at https://…”, so the screen never sends anyone there (LNK-55).
func TestRenderNoOpenableAddress(t *testing.T) {
	noAddress := "The code appears once this Whombat has a secure address: Whombat Link or Tailscale."
	app := "Use it in the Whombat app on this network."
	lan := `"url":"http://192.0.2.10:4480/c/s3cr3t"`
	for name, c := range map[string]struct {
		file       string
		has, hasnt []string
	}{
		"https claim link": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"https://able-baker-charlie.box.whombat.app/c/s3cr3t"}`,
			has:   []string{"Claim this Whombat", "open able-baker-charlie.box.whombat.app/c/s3cr3t and enter", "KXQM"},
			hasnt: []string{noAddress},
		},
		"http loopback": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://localhost:4480/c/s3cr3t"}`,
			has:   []string{"open localhost:4480/c/s3cr3t and enter", "KXQM"},
			hasnt: []string{noAddress},
		},
		"http loopback claimed": {
			file:  `{"v":1,"state":"claimed","url":"http://127.0.0.1:4480/"}`,
			has:   []string{"This Whombat is set up.", "Open 127.0.0.1:4480 to use it."},
			hasnt: []string{app},
		},
		// Claimed in the app on this network instead: the address it types, never one to open in a browser.
		"http LAN claimable": {
			file: `{"v":1,"state":"claimable","code":"KXQM",` + lan + `}`,
			has: []string{"Claim this Whombat", "In the Whombat app on this network, type 192.0.2.10 and enter",
				"KXQM", "The code changes"},
			hasnt: []string{noAddress, "http", "4480", "/c/", "open 192"},
		},
		"http LAN on another port": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://192.0.2.10:8080/"}`,
			has:   []string{"type 192.0.2.10:8080 and enter", "KXQM"},
			hasnt: []string{noAddress},
		},
		"http IPv6 LAN claimable": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://[fd00::5]:4480/"}`,
			has:   []string{noAddress},
			hasnt: []string{"KXQM", "fd00"},
		},
		"http LAN claimed": {
			file:  `{"v":1,"state":"claimed",` + lan + `}`,
			has:   []string{"This Whombat is set up.", app},
			hasnt: []string{"192.0.2.10", "Open "},
		},
		"Link ended, claimed": {
			file: `{"v":1,"state":"claimed",` + lan + `,"reach":{"link":{"state":"ended"}}}`,
			has: []string{"Whombat Link has ended. Subscribe again at app.whombat.com", "This Whombat is set up.",
				app},
			hasnt: []string{"192.0.2.10"},
		},
		// Tailscale's steps above; meanwhile the app on this network claims it (an own login server may have no HTTPS).
		"Tailscale needs HTTPS, claimable": {
			file: `{"v":1,"state":"claimable","code":"KXQM",` + lan +
				`,"reach":{"tailscale":{"needsHttps":true,"name":"whombat.tail1234.ts.net"}}}`,
			has:   []string{"Turn on HTTPS in Tailscale", "Claim this Whombat", "type 192.0.2.10 and enter", "KXQM"},
			hasnt: []string{"the code appears here", "tailnet, open", "Whombat Link"},
		},
		// The Expert choice before its sign-in: only Tailscale's steps, Link isn't one of them.
		"Tailscale sign-in, claimable": {
			file: `{"v":1,"state":"claimable","code":"KXQM",` + lan +
				`,"reach":{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}}`,
			has:   []string{"Sign in to Tailscale", "Claim this Whombat", "type 192.0.2.10 and enter", "KXQM"},
			hasnt: []string{"the code appears here", "Whombat Link"},
		},
		"Tailscale sign-in, no address on this network": {
			file: `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.tail1234.ts.net/"` +
				`,"reach":{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}}`,
			has:   []string{"Sign in to Tailscale", "sign in to Tailscale and turn on HTTPS"},
			hasnt: []string{"KXQM", "Whombat Link"},
		},
		"Tailscale name over plain HTTP": {
			file:  `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.tail1234.ts.net/c/s3cr3t","reach":{"tailscale":{"name":"whombat.tail1234.ts.net"}}}`,
			has:   []string{noAddress},
			hasnt: []string{"KXQM", "whombat.tail1234.ts.net/c"},
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
		// Block letters exactly when there is a code to type.
		withCode := strings.Contains(c.file, "KXQM") && !slices.Contains(c.hasnt, "KXQM")
		if strings.Contains(f, "█") != withCode {
			t.Errorf("%s: block letters %v, want %v\n%s", name, !withCode, withCode, f)
		}
	}
	// Link ended: the note comes above the body.
	f := Render(mustParse(t, `{"v":1,"state":"claimed",`+lan+`,"reach":{"link":{"state":"ended"}}}`), now, 200, 0, nil)
	if strings.Index(f, "Whombat Link has ended") > strings.Index(f, app) {
		t.Errorf("ended note not above:\n%s", f)
	}
}
