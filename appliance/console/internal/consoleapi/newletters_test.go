package consoleapi

import (
	"net/http"
	"os"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

const lanClaim = `{"v":1,"state":"claimable","code":"KXQM","url":"http://192.0.2.10:4480/"`

// New letters (Whombat whombat-link.md): the page is told it may offer them only when this server can pass the
// request on, and for how long letters asked for stay; the request goes to the runtime with nothing but its version.
func TestNewLetters(t *testing.T) {
	f := newFixture(t)
	claim := func() map[string]any { return f.get(t)["claim"].(map[string]any) }
	// Without a desk socket there is nobody to ask: not offered, and the route isn't there.
	f.writeState(t, lanClaim+`,"newLetters":true,"lettersUntil":"2026-09-27T12:10:00Z"}`)
	if c := claim(); c["newLetters"] != nil || c["lettersUntil"] != "2026-09-27T12:10:00Z" {
		t.Fatalf("%v", c)
	}
	if code, _ := f.do("POST", "/api/claim/letters", `{}`); code != http.StatusNotFound {
		t.Fatal(code)
	}

	fake := desktest.Start(t)
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	if c := claim(); c["newLetters"] != true || c["lettersUntil"] != "2026-09-27T12:10:00Z" || c["code"] != "KXQM" {
		t.Fatalf("%v", c)
	}
	// Letters that change after a wrong try, a time already past, a runtime that doesn't offer it.
	f.writeState(t, lanClaim+`,"newLetters":true,"lettersUntil":"2026-09-27T11:59:00Z"}`)
	if c := claim(); c["newLetters"] != true || c["lettersUntil"] != nil {
		t.Fatalf("%v", c)
	}
	f.writeState(t, lanClaim+`}`)
	if c := claim(); c["newLetters"] != nil || c["lettersUntil"] != nil {
		t.Fatalf("%v", c)
	}
	// The wait offers it too.
	f.writeState(t, `{"v":1,"state":"backoff","url":"http://192.0.2.10:4480/","retryAt":"2026-09-27T12:04:00Z","newLetters":true}`)
	if c := claim(); c["newLetters"] != true || c["state"] != "backoff" {
		t.Fatalf("%v", c)
	}
	// No letters on the page (nowhere to type them): nothing to renew.
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.tail1234.ts.net/","newLetters":true}`)
	if c := claim(); c["newLetters"] != nil || c["code"] != nil {
		t.Fatalf("%v", c)
	}

	fake.Set(desk.PathClaimLetters, desktest.Answer{Body: `{"v":1}`})
	if code, out := f.do("POST", "/api/claim/letters", `{}`); code != 200 || out["v"] != float64(1) {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Method != "POST" || got.Path != "/v1/desk/claim/letters" || got.Body != `{"v":1}` {
		t.Fatalf("%+v", got)
	}
	if code, _ := f.do("GET", "/api/claim/letters", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	// A box that shows no letters of its own: the runtime's refusal, passed on.
	fake.Set(desk.PathClaimLetters, desktest.Answer{Status: 409, Body: `{"error":{"code":"not_available","message":"x"}}`})
	if code, out := f.do("POST", "/api/claim/letters", `{}`); code != http.StatusConflict || out["message"] != "not_available" {
		t.Fatal(code, out)
	}
}

// Only an IPv6 address on this network: the page is told, so it can say an IPv4 address is another way.
func TestIPv6Only(t *testing.T) {
	f := newFixture(t)
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"http://[fd00::5]:4480/"}`)
	if c := f.get(t)["claim"].(map[string]any); c["ipv6Only"] != true || c["code"] != nil || c["inApp"] != nil {
		t.Fatalf("%v", c)
	}
	// A box that could name none of its IPv6 addresses waits, and the runtime says the network is IPv6 only.
	f.writeState(t, `{"v":1,"state":"waiting","url":"http://0.0.0.0/","ipv6Only":true}`)
	if c := f.get(t)["claim"].(map[string]any); c["ipv6Only"] != true || c["state"] != "waiting" || c["claimUrl"] != "" {
		t.Fatalf("%v", c)
	}
	for _, other := range []string{
		lanClaim + `}`,
		`{"v":1,"state":"claimed","url":"http://[fd00::5]:4480/"}`,
		`{"v":1,"state":"claimable","code":"KXQM","url":"https://able-baker-charlie.box.whombat.app/c/s3"}`,
		`{"v":1,"state":"waiting","url":"http://0.0.0.0/"}`,
		lanClaim + `,"ipv6Only":true}`,
	} {
		f.writeState(t, other)
		if c := f.get(t)["claim"].(map[string]any); c["ipv6Only"] != nil {
			t.Fatalf("%s: %v", other, c)
		}
	}
}

// The claim link at the box's own address comes with a second way in (the file's fallbackUrl): the page is told
// which, only where it shows the link with its code.
func TestClaimFallback(t *testing.T) {
	f := newFixture(t)
	claim := func() map[string]any { return f.get(t)["claim"].(map[string]any) }
	own := `{"v":1,"state":"claimable","code":"KXQM","url":"https://quiet-river-otter.box.whombat.app/c/kxqmtv"`
	f.writeState(t, own+`,"fallbackUrl":"http://192.0.2.10:4480/"}`)
	if c := claim(); c["fallbackInApp"] != "192.0.2.10" || c["fallbackTailnet"] != nil || c["code"] != "KXQM" ||
		c["claimUrl"] != "quiet-river-otter.box.whombat.app/c/kxqmtv" {
		t.Fatalf("%v", c)
	}
	f.writeState(t, own+`,"fallbackUrl":"https://whombat.tail1234.ts.net:4480/","reach":{"tailscale":{"name":"whombat.tail1234.ts.net"}}}`)
	if c := claim(); c["fallbackTailnet"] != "whombat.tail1234.ts.net:4480" || c["fallbackInApp"] != nil {
		t.Fatalf("%v", c)
	}
	// None sent, one the page can't use, or a screen that shows no claim link: nothing.
	for _, file := range []string{
		own + `}`,
		own + `,"fallbackUrl":"http://[fd00::20]:4480/"}`,
		lanClaim + `,"fallbackUrl":"https://whombat.tail1234.ts.net:4480/"}`,
		`{"v":1,"state":"claimed","url":"https://quiet-river-otter.box.whombat.app/","fallbackUrl":"http://192.0.2.10:4480/"}`,
	} {
		f.writeState(t, file)
		if c := claim(); c["fallbackInApp"] != nil || c["fallbackTailnet"] != nil {
			t.Errorf("%s: %v", file, c)
		}
	}
}
