package local

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// isSpace is ECMAScript's [\p{Z}\s]: every separator, the ASCII white space and U+FEFF.
func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Z, r)
}

// HostText makes any string display text of at most max code points (CT-560), like hostText in
// @whombat/protocol/session: runs of separators and white space become one space, control, format and surrogate code
// points go (and bytes that aren't UTF-8), the ends are trimmed, and a longer string is cut to max−1 code points and
// "…". The result may be empty: leave out an optional member whose text came out empty. Producers of the hardware
// report and the network clean every display string with it rather than fail.
func HostText(s string, max int) string {
	var b strings.Builder
	space := false
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		if r == utf8.RuneError && size == 1 {
			space = false
			continue
		}
		if isSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		if unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs) {
			continue
		}
		b.WriteRune(r)
	}
	clean := strings.Trim(b.String(), " ")
	if utf8.RuneCountInString(clean) <= max {
		return clean
	}
	keep := max - 1
	if keep < 0 {
		keep = 0
	}
	cut, n := 0, 0
	for cut < len(clean) && n < keep {
		_, size := utf8.DecodeRuneInString(clean[cut:])
		cut += size
		n++
	}
	return strings.TrimRight(clean[:cut], " ") + "…"
}

// SsidValid reports whether s is a displayable Wi-Fi network name of at most SsidMaxBytes UTF-8 bytes (CT-564), like
// ssidValid in @whombat/protocol/session: the Ssid pattern (no control, format, surrogate or separator code point but
// U+0020) and the byte limit no pattern can say. Leave networks whose name fails it out of every list, and refuse a
// join or a forget naming one (400 bad_request).
func SsidValid(s string) bool {
	if s == "" || len(s) > SsidMaxBytes || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r != ' ' && unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Z) {
			return false
		}
	}
	return true
}

// WifiSignalFromDBm gives the signal bars 0…4 for a strength in dBm (CT-565), like wifiSignalFromDbm in
// @whombat/protocol/session: ≥ −55 → 4, ≥ −67 → 3, ≥ −75 → 2, ≥ −85 → 1, else 0. iwd reports hundredths of a dBm:
// divide first.
func WifiSignalFromDBm(dbm int) int64 {
	switch {
	case dbm >= -55:
		return 4
	case dbm >= -67:
		return 3
	case dbm >= -75:
		return 2
	case dbm >= -85:
		return 1
	}
	return 0
}

// NetworkChangeValid reports whether a change carries Failure exactly in phases reverting, reverted and failed
// (CT-567), like networkChangeValid in @whombat/protocol/session.
func NetworkChangeValid(c protocol.NetworkChange) bool {
	undone := c.Phase == protocol.NetworkChangePhaseReverting ||
		c.Phase == protocol.NetworkChangePhaseReverted ||
		c.Phase == protocol.NetworkChangePhaseFailed
	return undone == (c.Failure != nil)
}

// HostNetworkValid reports whether a network state is consistent (CT-566), like hostNetworkValid in
// @whombat/protocol/session: WifiMissing only without Wifi; the Wi-Fi card's Ssid exactly while connecting or
// connected, Signal, Address and PrefixLength only while connected; a cable's PrefixLength only with its Address;
// consistent changes (CableChange too, 3.13, CT-1640). Validate the JSON first.
func HostNetworkValid(n protocol.HostNetwork) bool {
	if n.Wifi != nil && n.WifiMissing != nil {
		return false
	}
	if w := n.Wifi; w != nil {
		if (w.State != protocol.WifiStateDisconnected) != (w.Ssid != nil) {
			return false
		}
		if w.State != protocol.WifiStateConnected && (w.Signal != nil || w.Address != nil || w.PrefixLength != nil) {
			return false
		}
	}
	for _, c := range n.Wired {
		if c.PrefixLength != nil && c.Address == nil {
			return false
		}
	}
	if c := n.CableChange; c != nil && !CableChangeValid(*c) {
		return false
	}
	return n.Change == nil || NetworkChangeValid(*n.Change)
}

// CableChangeValid reports whether a cable change carries Failure exactly in phases reverting, reverted and failed
// (3.13, CT-1640), like networkChangeValid in @whombat/protocol/session.
func CableChangeValid(c protocol.CableChange) bool {
	undone := c.Phase == protocol.NetworkChangePhaseReverting || c.Phase == protocol.NetworkChangePhaseReverted ||
		c.Phase == protocol.NetworkChangePhaseFailed
	return undone == (c.Failure != nil)
}
