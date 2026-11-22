package screen

import (
	"strings"
	"testing"
)

// A box the network names only by its IPv4 address, claimable in the Whombat app there.
const inAppFile = `"state":"claimable","code":"KXQM","url":"http://10.100.0.10:4480/claim"`

// Linked, while the box's own web address is still on the way: the wait, not the claim, with the Whombat app on this
// network as a quiet line under it. The same for Link confirmed and waiting for its address.
func TestRenderLinkOnWaitsForTheAddress(t *testing.T) {
	for name, link := range map[string]string{
		"on":                     `{"state":"on"}`,
		"starting, address next": `{"state":"starting","waitingForAddress":true}`,
	} {
		sc := mustParse(t, reachFile(inAppFile, `{"link":`+link+`}`))
		if l := sc.LinkShown(now); l == nil || !l.WaitingForAddress || sc.WaitingInApp(now) != "10.100.0.10" {
			t.Fatalf("%s: %+v", name, l)
		}
		f := Render(sc, now, 200, 0, nil)
		for _, w := range []string{"web address…", "10.100.0.10", "KXQM"} {
			if !strings.Contains(f, w) {
				t.Errorf("%s: %q missing from\n%s", name, w, f)
			}
		}
		if strings.Contains(f, "Claim this Whombat") || strings.Contains(f, "█") ||
			strings.Index(f, "web address…") > strings.Index(f, "10.100.0.10") {
			t.Errorf("%s: not the wait with the app's line under it\n%s", name, f)
		}
	}
	// Without an address for the app, the wait alone.
	f := frame(mustParse(t, reachFile(`"state":"claimable","code":"KXQM","url":"http://whombat.example.com/claim"`, `{"link":{"state":"on"}}`)))
	if !strings.Contains(f, "web address…") || strings.Contains(f, "KXQM") {
		t.Errorf("no address for the app:\n%s", f)
	}
	// Once the address is there, or the box is claimed: the screens as before.
	for name, file := range map[string]string{
		"address ready": claimableFile,
		"claimed":       `"state":"claimed","url":"http://10.100.0.10:4480/"`,
		"backoff":       `"state":"backoff","retryAt":"2026-09-26T12:05:00Z","url":"http://10.100.0.10:4480/claim"`,
	} {
		if f := frame(mustParse(t, reachFile(file, `{"link":{"state":"on"}}`))); strings.Contains(f, "web address…") {
			t.Errorf("%s:\n%s", name, f)
		}
	}
}

// While Tailscale asks for something and the claim has no address to open, the screen numbers the two: Tailscale first,
// then the claim, which the app on this network takes at once.
func TestRenderTailscaleFirst(t *testing.T) {
	sc := mustParse(t, reachFile(inAppFile, `{"tailscale":{`+loginURL+`}}`))
	if !sc.TailscaleFirst(now) {
		t.Fatal("not numbered")
	}
	f := Render(sc, now, 200, 0, nil)
	one, two := strings.Index(f, "1 · Sign in to Tailscale"), strings.Index(f, "2 · Claim this Whombat")
	if one < 0 || two < one || !strings.Contains(f, "now: in the Whombat app on this network, type 10.100.0.10") ||
		!strings.Contains(f, "KXQM") {
		t.Errorf("numbered:\n%s", f)
	}
	// HTTPS is Tailscale's step too; without an address for the app the claim line says what comes after it.
	f = Render(mustParse(t, reachFile(`"state":"claimable","code":"KXQM","url":"http://whombat.example.com/claim"`, `{"tailscale":{"needsHttps":true}}`)), now, 200, 0, nil)
	if !strings.Contains(f, "1 · Turn on HTTPS in Tailscale") || !strings.Contains(f, "2 · Claim this Whombat") {
		t.Errorf("https:\n%s", f)
	}
	// An address to open, nothing Tailscale asks for, the Link code, or a claimed box: no numbers.
	for name, file := range map[string]string{
		"address to open":  reachFile(claimableFile, `{"tailscale":{`+loginURL+`}}`),
		"nothing to do":    reachFile(inAppFile, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`),
		"link code":        reachFile(inAppFile, `{"link":`+linkStarting+`,"tailscale":{`+loginURL+`}}`),
		"claimed":          reachFile(`"state":"claimed","url":"http://10.100.0.10:4480/"`, `{"tailscale":{`+loginURL+`}}`),
		"backoff":          reachFile(`"state":"backoff","retryAt":"2026-09-26T12:05:00Z","url":"http://10.100.0.10:4480/claim"`, `{"tailscale":{`+loginURL+`}}`),
		"no tailscale yet": `{"v":1,` + inAppFile + `}`,
	} {
		sc := mustParse(t, file)
		if f := Render(sc, now, 200, 0, nil); sc.TailscaleFirst(now) || strings.Contains(f, "1 · ") || strings.Contains(f, "2 · ") {
			t.Errorf("%s:\n%s", name, f)
		}
	}
}

func TestQRModules(t *testing.T) {
	q := QRModules("https://quiet-river-otter.box.whombat.app/c/kxqmtv")
	if len(q) < 21 || len(q) > MaxQRModules {
		t.Fatalf("%d rows", len(q))
	}
	for _, r := range q {
		if len(r) != len(q) || strings.Trim(r, "#.") != "" {
			t.Fatalf("row %q", r)
		}
	}
	// The finder pattern in the corner: seven dark modules.
	if q[0][:7] != "#######" {
		t.Fatalf("%q", q[0])
	}
	if QRModules("") != nil || QRModules("https://login.tailscale.com/a/"+strings.Repeat("a1", 100)) != nil {
		t.Fatal("a QR code for nothing, or one too dense to read")
	}
}

// The QR codes hold the https address the screen shows in words, the Link page with its code: never anything else.
func TestHrefs(t *testing.T) {
	sc := mustParse(t, reachFile(`"state":"claimable","code":"KXQM","url":"https://able-baker-charlie.box.whombat.app/c/s3cr3t/"`,
		`{"link":`+linkStarting+`,"tailscale":{`+loginURL+`}}`))
	if sc.ClaimHref != "https://able-baker-charlie.box.whombat.app/c/s3cr3t" ||
		sc.Reach.Link.CodeHref("ABCD-EFGH") != "https://app.whombat.com/link?code=ABCD-EFGH" ||
		sc.Reach.Tailscale.LoginHref != "https://login.tailscale.com/a/abc123" {
		t.Fatalf("%q %q %q", sc.ClaimHref, sc.Reach.Link.CodeHref("ABCD-EFGH"), sc.Reach.Tailscale.LoginHref)
	}
	if sc := mustParse(t, `{"v":1,`+inAppFile+`}`); sc.ClaimHref != "" {
		t.Fatalf("plain HTTP: %q", sc.ClaimHref)
	}
	if (&Link{}).CodeHref("ABCD-EFGH") != "" || sc.Reach.Link.CodeHref("") != "" {
		t.Fatal("a page without its https address or code")
	}
}
