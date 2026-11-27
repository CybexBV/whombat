package consoleapi

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
)

const (
	apiClaimable = `"state":"claimable","code":"KXQM","url":"https://app.whombat.com/claim"`
	apiClaimed   = `"state":"claimed","url":"https://app.whombat.com/claim"`
	// The Link code expires 12½ min after the fixture's now (2026-09-27T12:00:00Z).
	apiLinkCode = `{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}`
)

// canonical is JSON with its keys sorted, as json.Marshal writes a map.
func canonical(s string) string {
	if s == "" {
		return ""
	}
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		panic(err)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func apiFile(state, reach string) string { return `{"v":1,` + state + `,"reach":` + reach + `}` }

// reachJSON is /api/state's reach as raw JSON ("" when left out), and its claim. The QR codes come out on their own:
// qrs names the parts that had one ("link", "tailscale"), each checked to be a square of '#' and '.'.
func (f *fixture) reachJSON(t *testing.T) (reach string, claim map[string]any, qrs []string) {
	t.Helper()
	st := f.get(t)
	c, _ := st["claim"].(map[string]any)
	r, ok := st["reach"].(map[string]any)
	if !ok {
		return "", c, nil
	}
	for part, key := range map[string]string{"link": "qr", "tailscale": "loginQr"} {
		m, _ := r[part].(map[string]any)
		if q, ok := m[key]; ok {
			checkQR(t, q)
			qrs = append(qrs, part)
			delete(m, key)
		}
	}
	slices.Sort(qrs)
	b, _ := json.Marshal(r)
	return string(b), c, qrs
}

// checkQR fails unless v is a QR code as the page gets it: rows of '#' and '.', as many as each row is long.
func checkQR(t *testing.T, v any) {
	t.Helper()
	rows, _ := v.([]any)
	if len(rows) < 21 {
		t.Fatalf("QR code %v", v)
	}
	for _, r := range rows {
		s, _ := r.(string)
		if len(s) != len(rows) || strings.Trim(s, "#.") != "" {
			t.Fatalf("QR code row %q of %d", s, len(rows))
		}
	}
}

// The page gets exactly what the text console shows of Link and Tailscale (CG-402, CG-404), nothing more.
func TestReach(t *testing.T) {
	f := newFixture(t)
	for name, tc := range map[string]struct {
		file  string
		reach string // the JSON the page gets, "" for none, without its QR codes
		code  string // the claim code kept on the claim
		qrs   []string
	}{
		"link code over the claim": {apiFile(apiClaimable, `{"link":`+apiLinkCode+`}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, "KXQM", []string{"link"}},
		"code far ahead: no countdown": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-28T12:00:00Z"}}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link"}}`, "KXQM", []string{"link"}},
		"expired code": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-27T11:59:59Z"}}`),
			`{"link":{"state":"starting"}}`, "KXQM", nil},
		"code without its page": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH"}}`),
			`{"link":{"state":"starting"}}`, "KXQM", nil},
		"waiting for an address": {apiFile(apiClaimable, `{"link":{"state":"starting","waitingForAddress":true}}`),
			`{"link":{"state":"starting","waitingForAddress":true}}`, "KXQM", nil},
		// Linked, and the box's own address isn't there yet: the wait, with the claim in the app on this network.
		"on while the address comes": {apiFile(`"state":"claimable","code":"KXQM","url":"http://10.100.0.10:4480/claim"`, `{"link":{"state":"on"}}`),
			`{"link":{"state":"on","waitingForAddress":true}}`, "KXQM", nil},
		"on with its address": {apiFile(apiClaimable, `{"link":{"state":"on"}}`), "", "KXQM", nil},
		"claimed with a code": {apiFile(apiClaimed, `{"link":`+apiLinkCode+`}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, "", []string{"link"}},
		"claimed, waiting: the box's own screen": {apiFile(apiClaimed, `{"link":{"state":"starting","waitingForAddress":true}}`), "", "", nil},
		"grace": {apiFile(apiClaimed, `{"link":{"state":"grace","graceEndsAt":"2026-11-25T10:00:00Z"}}`),
			`{"link":{"state":"grace","graceEndsOn":"25 November"}}`, "", nil},
		"grace next year": {apiFile(apiClaimed, `{"link":{"state":"grace","graceEndsAt":"2027-01-03T10:00:00Z"}}`),
			`{"link":{"state":"grace","graceEndsOn":"3 January 2027"}}`, "", nil},
		"grace with locale": {apiFile(apiClaimed+`,"locale":"nl-NL"`, `{"link":{"state":"grace","graceEndsAt":"2026-11-25T10:00:00Z"}}`),
			`{"link":{"state":"grace","graceEndsOn":"25 November","graceEndsAt":"2026-11-25"}}`, "", nil},
		"grace without a date":    {apiFile(apiClaimed, `{"link":{"state":"grace"}}`), "", "", nil},
		"ended":                   {apiFile(apiClaimed, `{"link":{"state":"ended"}}`), `{"link":{"state":"ended"}}`, "", nil},
		"on and off show nothing": {apiFile(apiClaimed, `{"link":{"state":"on","code":"ABCD-EFGH","url":"https://app.whombat.com/link"}}`), "", "", nil},
		"tailscale sign-in and https": {apiFile(apiClaimable, `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123","needsHttps":true,"name":"whombat.tail1234.ts.net"}}`),
			`{"tailscale":{"loginUrl":"login.tailscale.com/a/abc123","needsHttps":true}}`, "KXQM", []string{"tailscale"}},
		// No address to open: Tailscale's sign-in is the first step, the claim (in the app on this network) the second.
		"tailscale first": {apiFile(`"state":"claimable","code":"KXQM","url":"http://10.100.0.214:4480/claim"`, `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}`),
			`{"tailscale":{"loginUrl":"login.tailscale.com/a/abc123","first":true}}`, "KXQM", []string{"tailscale"}},
		"tailscale name only": {apiFile(apiClaimable, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`), "", "KXQM", nil},
		// A sign-in link too long to read as a QR code keeps its text.
		"long sign-in link": {apiFile(apiClaimable, `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/`+strings.Repeat("a1", 100)+`"}}`),
			`{"tailscale":{"loginUrl":"login.tailscale.com/a/` + strings.Repeat("a1", 100) + `"}}`, "KXQM", nil},
		// A part the screen can't show goes on its own; a reach the contract refuses goes whole; the claim stays.
		"login link with a fragment, good code": {apiFile(apiClaimable, `{"link":`+apiLinkCode+`,"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc#x"}}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, "KXQM", []string{"link"}},
		"link page with userinfo": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://evil@app.whombat.com/link"}}`),
			`{"link":{"state":"starting"}}`, "KXQM", nil},
		"newer link state":        {apiFile(apiClaimable, `{"link":{"state":"paused"}}`), "", "KXQM", nil},
		"reach of the wrong type": {apiFile(apiClaimable, `"on"`), "", "KXQM", nil},
	} {
		f.writeState(t, tc.file)
		got, c, qrs := f.reachJSON(t)
		if got != canonical(tc.reach) {
			t.Errorf("%s: reach %s, want %s", name, got, tc.reach)
		}
		if !slices.Equal(qrs, tc.qrs) {
			t.Errorf("%s: QR codes for %v, want %v", name, qrs, tc.qrs)
		}
		if c == nil || (tc.code != "" && c["code"] != tc.code) {
			t.Errorf("%s: claim %v", name, c)
		}
		if strings.ContainsAny(got, "\x1b\a") {
			t.Errorf("%s: control characters reached the page: %q", name, got)
		}
	}
}

// The claim link on the box's tailnet name: the page says to open it on the tailnet, as the text console does.
func TestClaimOnTailnet(t *testing.T) {
	f := newFixture(t)
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"https://whombat.tail1234.ts.net/claim","reach":{"tailscale":{"name":"whombat.tail1234.ts.net"}}}`)
	if c := f.get(t)["claim"].(map[string]any); c["onTailnet"] != true || c["claimUrl"] != "whombat.tail1234.ts.net/claim" {
		t.Fatalf("%v", c)
	}
	// Another address, or no tailnet name: not on the tailnet.
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"https://app.whombat.com/claim","reach":{"tailscale":{"name":"whombat.tail1234.ts.net"}}}`)
	if c := f.get(t)["claim"].(map[string]any); c["onTailnet"] != nil {
		t.Fatalf("%v", c)
	}
	// Plain HTTP on the tailnet name serves no page (LNK-55): no address, no code, so nothing to open on the tailnet.
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.tail1234.ts.net/claim","reach":{"tailscale":{"name":"whombat.tail1234.ts.net"}}}`)
	if c := f.get(t)["claim"].(map[string]any); c["onTailnet"] != nil || c["code"] != nil {
		t.Fatalf("%v", c)
	}
}

// The claim link comes as a QR code beside it, the https address and nothing else: never the letters, and never a
// plain-HTTP address, which opens nothing.
func TestClaimQR(t *testing.T) {
	f := newFixture(t)
	f.writeState(t, `{"v":1,`+apiClaimable+`}`)
	c := f.get(t)["claim"].(map[string]any)
	checkQR(t, c["qr"])
	b, _ := json.Marshal(c["qr"])
	want, _ := json.Marshal(screen.QRModules("https://app.whombat.com/claim"))
	if string(b) != string(want) || c["second"] != nil {
		t.Fatalf("%v", c)
	}
	for name, file := range map[string]string{
		"in the app on this network": `{"v":1,"state":"claimable","code":"KXQM","url":"http://10.100.0.10:4480/claim"}`,
		"backoff":                    `{"v":1,"state":"backoff","retryAt":"2026-09-27T12:05:00Z","url":"https://app.whombat.com/claim"}`,
		"claimed":                    `{"v":1,` + apiClaimed + `}`,
	} {
		f.writeState(t, file)
		if c := f.get(t)["claim"].(map[string]any); c["qr"] != nil {
			t.Errorf("%s: %v", name, c)
		}
	}
	// The second step after Tailscale's sign-in: the claim in the app on this network, with its letters.
	f.writeState(t, apiFile(`"state":"claimable","code":"KXQM","url":"http://10.100.0.214:4480/claim"`,
		`{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123"}}`))
	if c := f.get(t)["claim"].(map[string]any); c["second"] != true || c["inApp"] != "10.100.0.214" || c["code"] != "KXQM" || c["qr"] != nil {
		t.Fatalf("%v", c)
	}
}
