// Package card renders the printed cards as SVG (A6 landscape, 148 × 105 mm). PDF is produced from the
// SVG by rsvg-convert where the station has it.
package card

import (
	"fmt"
	"html"
	"strings"

	"rsc.io/qr"
)

// Claim is the content of the claim card. Since MA-22 (CC-02) the card carries no fingerprint: the claim
// protocol (CPace, channel-bound to both static keys) authenticates the appliance, nobody compares groups.
type Claim struct {
	DeviceID    string
	Secret      string // display form
	URL         string // QR payload
	Environment string
	Model       string
	Serial      string
}

// Recovery is the content of the disk recovery card.
type Recovery struct {
	DeviceID string
	Key      string
	Serial   string
}

func esc(s string) string { return html.EscapeString(s) }

// qrPath renders a QR code as one SVG path of unit squares, placed at (x, y) with the given size (mm).
func qrPath(payload string, x, y, size float64) (string, error) {
	code, err := qr.Encode(payload, qr.M)
	if err != nil {
		return "", err
	}
	quiet := 4
	n := code.Size + 2*quiet
	unit := size / float64(n)
	var d strings.Builder
	for r := 0; r < code.Size; r++ {
		for c := 0; c < code.Size; c++ {
			if code.Black(c, r) {
				fmt.Fprintf(&d, "M%.3f %.3fh%.3fv%.3fh-%.3fz", x+float64(c+quiet)*unit, y+float64(r+quiet)*unit, unit, unit, unit)
			}
		}
	}
	return fmt.Sprintf(`<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="#fff"/><path fill="#000" d="%s"/>`,
		x, y, size, size, d.String()), nil
}

const head = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="148mm" height="105mm" viewBox="0 0 148 105" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">
<rect width="148" height="105" fill="#fff"/>
<rect x="3" y="3" width="142" height="99" rx="4" fill="none" stroke="#000" stroke-width="0.4"/>
`

// ClaimSVG renders the claim card.
func ClaimSVG(c Claim) (string, error) {
	qrs, err := qrPath(c.URL, 92, 18, 50)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString(head)
	fmt.Fprintf(&b, `<text x="10" y="15" font-size="6" font-weight="bold">Claim your Whombat</text>
<text x="10" y="22" font-size="3">Scan the code, or open %s</text>
<text x="10" y="26.5" font-size="3">and choose “Claim with a card”:</text>
<text x="10" y="37" font-size="3" fill="#444">Appliance ID</text>
<text x="10" y="43" font-size="5" font-family="DejaVu Sans Mono, monospace">%s</text>
<text x="10" y="55" font-size="3" fill="#444">Claim code</text>
<text x="10" y="61" font-size="4" font-family="DejaVu Sans Mono, monospace" font-weight="bold">%s</text>
`, esc(strings.TrimPrefix(strings.TrimPrefix(claimHost(c.URL), "https://"), "http://")),
		esc(c.DeviceID), esc(c.Secret))
	b.WriteString(qrs)
	fmt.Fprintf(&b, `<text x="10" y="82" font-size="2.6">Keep this card private. Anyone with the claim code can claim this appliance until you do.</text>
<text x="10" y="86" font-size="2.6">The code works once. Whombat staff will never ask you for it.</text>
<text x="10" y="96" font-size="2.3" fill="#666">%s · serial %s · %s</text>
</svg>
`, esc(c.Model), esc(c.Serial), esc(c.Environment))
	return b.String(), nil
}

func claimHost(u string) string {
	if i := strings.Index(u, "#"); i >= 0 {
		return u[:i]
	}
	return u
}

// RecoverySVG renders the disk recovery card (a separate card: it unlocks the disks without the TPM).
func RecoverySVG(r Recovery) string {
	groups := strings.Split(r.Key, "-")
	var lines [2]string
	if len(groups) == 8 {
		lines[0] = strings.Join(groups[:4], "-")
		lines[1] = strings.Join(groups[4:], "-")
	} else {
		lines[0] = r.Key
	}
	var b strings.Builder
	b.WriteString(head)
	fmt.Fprintf(&b, `<text x="10" y="15" font-size="6" font-weight="bold">Whombat disk recovery key</text>
<text x="10" y="22" font-size="3">Appliance %s · serial %s</text>
<text x="10" y="40" font-size="4.4" font-family="DejaVu Sans Mono, monospace" font-weight="bold">%s</text>
<text x="10" y="48" font-size="4.4" font-family="DejaVu Sans Mono, monospace" font-weight="bold">%s</text>
<text x="10" y="62" font-size="2.8">This key unlocks the appliance’s disks if its security chip can’t (for example after a</text>
<text x="10" y="66" font-size="2.8">firmware change or a disk moved to another machine), and authorises local recovery.</text>
<text x="10" y="74" font-size="2.8">Store it apart from the appliance and from the claim card. Whombat does not keep a copy</text>
<text x="10" y="78" font-size="2.8">and cannot recover it for you.</text>
</svg>
`, esc(r.DeviceID), esc(r.Serial), esc(lines[0]), esc(lines[1]))
	return b.String()
}
