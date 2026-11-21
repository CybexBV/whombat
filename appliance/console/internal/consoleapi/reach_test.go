package consoleapi

import (
	"encoding/json"
	"strings"
	"testing"
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

// reachJSON is /api/state's reach as raw JSON ("" when left out), and its claim.
func (f *fixture) reachJSON(t *testing.T) (string, map[string]any) {
	t.Helper()
	st := f.get(t)
	c, _ := st["claim"].(map[string]any)
	r, ok := st["reach"]
	if !ok {
		return "", c
	}
	b, _ := json.Marshal(r)
	return string(b), c
}

// The page gets exactly what the text console shows of Link and Tailscale (CG-402, CG-404), nothing more.
func TestReach(t *testing.T) {
	f := newFixture(t)
	for name, tc := range map[string]struct {
		file  string
		reach string // the JSON the page gets, "" for none
		code  string // the claim code kept on the claim
	}{
		"link code over the claim": {apiFile(apiClaimable, `{"link":`+apiLinkCode+`}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, "KXQM"},
		"code far ahead: no countdown": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-28T12:00:00Z"}}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link"}}`, "KXQM"},
		"expired code": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://app.whombat.com/link","expiresAt":"2026-09-27T11:59:59Z"}}`),
			`{"link":{"state":"starting"}}`, "KXQM"},
		"code without its page": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH"}}`),
			`{"link":{"state":"starting"}}`, "KXQM"},
		"waiting for an address": {apiFile(apiClaimable, `{"link":{"state":"starting","waitingForAddress":true}}`),
			`{"link":{"state":"starting","waitingForAddress":true}}`, "KXQM"},
		"claimed with a code": {apiFile(apiClaimed, `{"link":`+apiLinkCode+`}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, ""},
		"claimed, waiting: the box's own screen": {apiFile(apiClaimed, `{"link":{"state":"starting","waitingForAddress":true}}`), "", ""},
		"grace": {apiFile(apiClaimed, `{"link":{"state":"grace","graceEndsAt":"2026-11-25T10:00:00Z"}}`),
			`{"link":{"state":"grace","graceEndsOn":"25 November"}}`, ""},
		"grace next year": {apiFile(apiClaimed, `{"link":{"state":"grace","graceEndsAt":"2027-01-03T10:00:00Z"}}`),
			`{"link":{"state":"grace","graceEndsOn":"3 January 2027"}}`, ""},
		"grace without a date":    {apiFile(apiClaimed, `{"link":{"state":"grace"}}`), "", ""},
		"ended":                   {apiFile(apiClaimed, `{"link":{"state":"ended"}}`), `{"link":{"state":"ended"}}`, ""},
		"on and off show nothing": {apiFile(apiClaimed, `{"link":{"state":"on","code":"ABCD-EFGH","url":"https://app.whombat.com/link"}}`), "", ""},
		"tailscale sign-in and https": {apiFile(apiClaimable, `{"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc123","needsHttps":true,"name":"whombat.tail1234.ts.net"}}`),
			`{"tailscale":{"loginUrl":"login.tailscale.com/a/abc123","needsHttps":true}}`, "KXQM"},
		"tailscale name only": {apiFile(apiClaimable, `{"tailscale":{"name":"whombat.tail1234.ts.net"}}`), "", "KXQM"},
		// A part the screen can't show goes on its own; a reach the contract refuses goes whole; the claim stays.
		"login link with a fragment, good code": {apiFile(apiClaimable, `{"link":`+apiLinkCode+`,"tailscale":{"loginUrl":"https://login.tailscale.com/a/abc#x"}}`),
			`{"link":{"state":"starting","code":"ABCD-EFGH","url":"app.whombat.com/link","expiresAt":"2026-09-27T12:12:30Z"}}`, "KXQM"},
		"link page with userinfo": {apiFile(apiClaimable, `{"link":{"state":"starting","code":"ABCD-EFGH","url":"https://evil@app.whombat.com/link"}}`),
			`{"link":{"state":"starting"}}`, "KXQM"},
		"newer link state":        {apiFile(apiClaimable, `{"link":{"state":"paused"}}`), "", "KXQM"},
		"reach of the wrong type": {apiFile(apiClaimable, `"on"`), "", "KXQM"},
	} {
		f.writeState(t, tc.file)
		got, c := f.reachJSON(t)
		if got != canonical(tc.reach) {
			t.Errorf("%s: reach %s, want %s", name, got, tc.reach)
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
