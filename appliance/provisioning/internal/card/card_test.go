package card

import (
	"strings"
	"testing"
)

// Everything interpolated is escaped.
func TestClaimCardEscapes(t *testing.T) {
	svg, err := ClaimSVG(Claim{DeviceID: "<x>", Secret: "&", URL: "https://a/claim", Model: `"m"`})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(svg, "<x>") || strings.Contains(svg, ">&<") {
		t.Fatal("unescaped")
	}
}
