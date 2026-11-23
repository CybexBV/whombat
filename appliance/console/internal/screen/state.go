// Package screen turns the runtime's console state file (CC-08, NX-32) into the plain-text screen that
// whombat-console draws on tty1. Everything read from the file is untrusted display input: it is validated
// against the contract (contracts 0.17.0 `local.ConsoleState`, `ConsoleStateValid`), every control and
// format character is refused, and the URL must additionally be a plain host/path, so a crafted file can't
// rewrite the terminal (the recovery menu's rule, N-3).
package screen

import (
	"errors"
	"fmt"
	"math/bits"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// The states of CC-08.
const (
	Starting  = string(local.ConsoleClaimStateStarting)
	Waiting   = string(local.ConsoleClaimStateWaiting)
	Claimable = string(local.ConsoleClaimStateClaimable)
	Backoff   = string(local.ConsoleClaimStateBackoff)
	Claimed   = string(local.ConsoleClaimStateClaimed)
)

// Screen is a validated state, ready to render.
type Screen struct {
	State string
	Code  string // claimable only, display form LL-NNNN-LL
	URL   string // without the scheme, e.g. dev.whombat.com/claim
	// ClaimHref is the claim link as a phone opens it (“https://…”), for the graphical console's QR code: "" unless the
	// file's url is https, as a plain-HTTP address opens nothing a phone could use.
	ClaimHref string
	RetryAt   time.Time // backoff only
	Burrows   *Burrows  // claimed only, when the runtime sent it (CT-116); the text console doesn't show it
	SignIn    *SignIn   // claimed only: a device waiting to sign in at this screen (BX-06); see LiveSignIn
	Alert     *Alert    // any state: a warning over every screen (contracts 4.3, own_address_foreign)
	Reach     *Reach    // any state: Whombat Link and Tailscale (contracts 4.4); see LinkStarting
	// Start is why the first start can't finish (CG-409): from the provisioning unit's file, not the runtime's (the
	// caller sets it, source.LoadStart); shown on the starting screen only (StartShown).
	Start *Start
	// Openable: URL serves a page a person can open. Plain HTTP on a box answers only “This Whombat opens at https://…”,
	// so an http:// URL counts only on loopback (development); otherwise the screen never shows it (Whombat LNK-55).
	Openable bool
	// InApp is where the Whombat app on this network reaches a box without such an address: the IPv4 address of its
	// plain-HTTP URL, with the port when it isn't the direct port's usual one (“192.168.1.20”). The claim screen then
	// shows the letters and says to type this in the app, which claims over the local network (docs/decisions/console-gui.md).
	// Empty when the URL is openable or names no such address.
	InApp string
	// IPv6Only: the box's network gave it an IPv6 address and no IPv4 one. The runtime says so on its own (the file's
	// ipv6Only), whichever IPv6 addresses those are: a box with only a link-local or a public one names no address at
	// all and waits. A plain-HTTP URL on an IPv6 address says the same. The app takes an IPv4 address only, so the
	// screen of a box without an address to open says that an IPv4 address is another way to go on.
	IPv6Only bool
	// LettersUntil: the letters were asked for at this screen and stay until then, whatever is tried (claimable only;
	// zero otherwise: the letters change after a wrong try).
	LettersUntil time.Time
	// NewLetters: the person at the box can ask for new letters now (claimable and backoff, when the runtime says so
	// and this console can pass the request on; the caller clears it when it can't).
	NewLetters bool
	// FallbackTailnet and FallbackInApp: another way to the claim, for when the address above doesn't open (the file's
	// fallbackUrl). The claim link at the box's own address is on the internet, where others can keep it busy; these
	// they can't reach. FallbackTailnet is the box's page on its Tailscale name, to open on a device on the tailnet;
	// FallbackInApp is its IPv4 address on this network, to type in the Whombat app (as InApp). At most one is set, and
	// only on a claimable screen whose own address is one to open and isn't on the tailnet itself.
	FallbackTailnet string
	FallbackInApp   string
	// PageOpen: a browser has the claim link open and waits for the letters (claimable only, beside an address to open).
	// The screen then says to type them there, without the link to open, its QR code or the second way in: the page is
	// already open, and scanning the code would move the claim to another device.
	PageOpen bool
	// WaitedLong: this console has shown the wait for the box's web address for WaitLongAfter (the caller sets it, from
	// its WaitWatch). Only then does the wait offer the claim in the Whombat app on this network.
	WaitedLong bool
}

// StartingScreen is what the console shows without a usable state file.
var StartingScreen = Screen{State: Starting}

// MaxFileSize bounds what is read from the state file.
const MaxFileSize = 4096

// A plain host[:port]/path: no userinfo, query, fragment or anything a terminal interprets. Stricter than
// the contract's printable-ASCII url on purpose: the console shows it to people. The host is a name or an IP address
// (IPv6 in brackets, so a development box on [::1] keeps its screen).
var urlRe = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?$`)

// Clean removes every control character (C0, DEL, C1, and Unicode format characters such as bidi
// overrides) from s. Used on anything file-provided before it reaches the terminal.
func Clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

// Parse validates the state file: the contract's schema (local.ParseConsoleState; members it doesn't know
// are ignored, as for every contract type) and local.ConsoleStateValid (a code exactly in `claimable`, a
// retryAt exactly in `backoff`, burrows and a sign-in only in `claimed`), then the display rules above. A file
// that is valid only without some of its burrows, sign-in, alert or reach keeps its state and loses those
// (parseValid).
func Parse(data []byte) (Screen, error) {
	if len(data) > MaxFileSize {
		return Screen{}, errors.New("state file too large")
	}
	st, err := parseValid(data)
	if err != nil {
		return Screen{}, err
	}
	sc := Screen{State: string(st.State)}
	if sc.URL, err = displayURL(st.URL); err != nil {
		return Screen{}, err
	}
	sc.Openable = openable(st.URL, sc.URL)
	sc.ClaimHref = httpsHref(st.URL, sc.URL)
	if !sc.Openable {
		sc.InApp = inApp(st.URL, sc.URL)
		// Never beside an address the app can take: then there is a way in to show.
		sc.IPv6Only = sc.InApp == "" && (ipv6Only(st.URL, sc.URL) || (st.Ipv6Only != nil && *st.Ipv6Only))
	}
	if st.LettersUntil != nil {
		// A time it can't read only loses the “stay for” line: the letters show as they always do.
		if until, err := time.Parse(time.RFC3339Nano, *st.LettersUntil); err == nil {
			sc.LettersUntil = until
		}
	}
	sc.NewLetters = st.NewLetters != nil && *st.NewLetters
	sc.PageOpen = st.PageOpen != nil && *st.PageOpen && sc.State == Claimable && sc.Openable
	if st.Code != nil {
		if Clean(*st.Code) != *st.Code {
			return Screen{}, errors.New("state file: invalid code")
		}
		sc.Code = *st.Code
	}
	if st.RetryAt != nil {
		if sc.RetryAt, err = time.Parse(time.RFC3339Nano, *st.RetryAt); err != nil {
			return Screen{}, errors.New("state file: invalid retryAt")
		}
	}
	sc.Burrows = displayBurrows(st.Burrows)
	sc.SignIn = displaySignIn(st.SignIn)
	sc.Alert = displayAlert(st.Alert)
	sc.Reach = displayReach(st.Reach)
	if st.FallbackURL != nil && sc.State == Claimable && sc.Openable && !sc.OnTailnet() {
		sc.FallbackTailnet, sc.FallbackInApp = sc.fallback(*st.FallbackURL)
	}
	return sc, nil
}

// fallback reads the file's fallbackUrl as the screen shows it: the box's page on its Tailscale name, or its IPv4
// address on this network for the app. Both "" when it is neither, can't be shown, or is the address already on the
// screen: the screen then names no second way, and keeps everything else.
func (s Screen) fallback(raw string) (tailnet, app string) {
	shown, err := displayURL(raw)
	if err != nil || shown == s.URL {
		return "", ""
	}
	if strings.HasPrefix(raw, "https://") {
		if s.onTailnet(shown) {
			return shown, ""
		}
		return "", ""
	}
	return "", inApp(raw, shown)
}

// decorationMembers are the members a file may lose and keep its claim state: the claimed screen's burrows (CT-116),
// the sign-in panel (BX-06), the alert (contracts 4.3; a kind from a newer runtime is outside this contract's enum),
// the reach (contracts 4.4; likewise a newer Link state) and the claim's second address (fallbackUrl). A runtime that
// gets one wrong never blanks the console or hides its claim code.
var decorationMembers = []string{"signIn", "burrows", "alert", "reach", "fallbackUrl"}

// decorations is every set of decorationMembers to drop, fewest first (nil: drop nothing), so a file loses no more than
// it must.
var decorations = func() [][]string {
	var out [][]string
	for n := 0; n <= len(decorationMembers); n++ {
		for mask := 0; mask < 1<<len(decorationMembers); mask++ {
			if bits.OnesCount(uint(mask)) != n {
				continue
			}
			var drop []string
			for i, m := range decorationMembers {
				if mask&(1<<i) != 0 {
					drop = append(drop, m)
				}
			}
			out = append(out, drop)
		}
	}
	return out
}()

// parseValid is the file as the contract reads it: as written, else without as few of its decorations as make it
// valid.
func parseValid(data []byte) (*local.ConsoleState, error) {
	var firstErr error
	for _, drop := range decorations {
		b := data
		if drop != nil {
			var ok bool
			if b, ok = without(data, drop...); !ok {
				continue
			}
		}
		st, err := local.ParseConsoleState(b)
		if err == nil && !local.ConsoleStateValid(*st) {
			err = errors.New("code, retryAt, burrows or signIn in the wrong state")
		}
		if err == nil {
			return st, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, fmt.Errorf("state file: %w", firstErr)
}

// displayURL returns the url as the console shows it (local.ConsoleDisplayURL: without the scheme),
// refusing anything but a plain host/path.
func displayURL(u string) (string, error) { return displayURLMax(u, 100) }

// displayURLMax is displayURL for a URL of up to limit bytes once shown.
func displayURLMax(u string, limit int) (string, error) {
	if Clean(u) != u {
		return "", errors.New("state file: invalid url")
	}
	d := strings.TrimSuffix(local.ConsoleDisplayURL(u), "/")
	if d == u || len(d) > limit || !urlRe.MatchString(d) {
		return "", errors.New("state file: invalid url")
	}
	return d, nil
}

// httpsHref is shown (an address as the screen shows it, already checked) as a phone opens it, "https://…", when raw
// (the address as the file gave it) is https; "" otherwise. Built from the checked form, so a QR code holds nothing the
// screen doesn't show in words.
func httpsHref(raw, shown string) string {
	if shown == "" || !strings.HasPrefix(raw, "https://") {
		return ""
	}
	return "https://" + shown
}

// openable reports whether raw (the file's url; shown, the same without its scheme) serves a page a person can open:
// https, or plain http on loopback (localhost, 127.0.0.0/8, [::1]), which only a development box uses.
func openable(raw, shown string) bool {
	if strings.HasPrefix(raw, "https://") {
		return true
	}
	if !strings.HasPrefix(raw, "http://") {
		return false
	}
	host, _, _ := strings.Cut(shown, "/")
	if h, ok := strings.CutPrefix(host, "["); ok {
		host, _, _ = strings.Cut(h, "]")
	} else {
		host, _, _ = strings.Cut(host, ":")
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// DirectPort is the port the box's direct listener uses unless set otherwise; the app assumes it when none is typed.
const DirectPort = "4480"

// inApp is the address the app types for raw (the file's url; shown, the same without its scheme) when it is plain HTTP
// on an IPv4 address that isn't loopback or unspecified: the host, with “:port” unless the port is DirectPort. Only
// IPv4: the box lists it first, and nobody types an IPv6 address on a phone. "" otherwise.
func inApp(raw, shown string) string {
	if !strings.HasPrefix(raw, "http://") {
		return ""
	}
	hostPort, _, _ := strings.Cut(shown, "/")
	host, port, found := strings.Cut(hostPort, ":")
	if !found {
		port = "80"
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.To4() == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return ""
	}
	if port == DirectPort {
		return host
	}
	return host + ":" + port
}

// ipv6Only reports whether raw (the file's url; shown, the same without its scheme) is plain HTTP on an IPv6 address
// that isn't loopback or unspecified: the box lists its IPv4 addresses first, so it has none on this network.
func ipv6Only(raw, shown string) bool {
	if !strings.HasPrefix(raw, "http://") {
		return false
	}
	host, _, _ := strings.Cut(shown, "/")
	h, ok := strings.CutPrefix(host, "[")
	if !ok {
		return false
	}
	h, _, _ = strings.Cut(h, "]")
	ip := net.ParseIP(h)
	return ip != nil && ip.To4() == nil && !ip.IsLoopback() && !ip.IsUnspecified()
}

// LettersStay reports whether the letters on the screen stay for a while (they were asked for here) at now.
func (s Screen) LettersStay(now time.Time) bool {
	return s.State == Claimable && s.LettersUntil.After(now)
}
