package screen

import (
	"strings"
	"testing"
	"time"
)

// The alert shows over every state; one the console can't read is dropped and nothing else is.
func TestParseAlert(t *testing.T) {
	for _, state := range []string{
		`"state":"starting",` + claimedURL,
		`"state":"claimable","code":"KXQM",` + claimedURL,
		`"state":"claimed",` + claimedURL + `,"burrows":{"first":"Banjo’s Burrow","more":2}`,
	} {
		sc := mustParse(t, `{"v":1,`+state+`,"alert":{"kind":"own_address_foreign","since":"2026-09-26T11:00:00Z"}}`)
		if sc.Alert == nil || sc.Alert.Kind != "own_address_foreign" || !sc.Alert.Since.Equal(now.Add(-time.Hour)) {
			t.Fatalf("%s: %+v", state, sc.Alert)
		}
		if !strings.Contains(Render(sc, now, 80, 0, nil), "security certificate for your Whombat’s address") {
			t.Fatalf("%s: no warning on the text console", state)
		}
	}
	for name, alert := range map[string]string{
		"a newer kind":  `{"kind":"something_new","since":"2026-09-26T11:00:00Z"}`,
		"no since":      `{"kind":"own_address_foreign"}`,
		"bad since":     `{"kind":"own_address_foreign","since":"yesterday"}`,
		"not an object": `"own_address_foreign"`,
	} {
		sc := mustParse(t, `{"v":1,"state":"claimable","code":"KXQM",`+claimedURL+`,"alert":`+alert+`}`)
		if sc.Alert != nil || sc.State != Claimable || sc.Code != "KXQM" {
			t.Fatalf("%s: %+v", name, sc)
		}
	}
	if sc := mustParse(t, `{"v":1,"state":"claimable","code":"KXQM",`+claimedURL+`}`); sc.Alert != nil || strings.Contains(Render(sc, now, 80, 0, nil), "WARNING") {
		t.Fatal("a warning without an alert")
	}
}
