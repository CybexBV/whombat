package screen

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Banner is the console's footer: the words the getty banner shows on the other VTs (base.nix,
// whombat.console.banner). The appliance passes its own copy with --footer-file; this default keeps
// dev/console and the tests identical to it.
const Banner = `Whombat appliance. There is no login on this console.
For local recovery, restart and hold Space to open the boot menu, then choose
"Whombat Recovery" (you will need your disk recovery key).`

// Words of CC-08, verbatim.
const (
	wordStarting      = "Starting Whombat…"
	wordWaiting       = "Connecting to Whombat…"
	wordWaitingHint   = "Check the network cable. The claim code appears once this Whombat is online."
	wordClaimTitle    = "Claim this Whombat"
	wordClaimOpen     = "On a computer or phone, open %s and enter"
	wordClaimRotates  = "The code changes after a wrong try."
	wordBackoff       = "Too many wrong codes. Try again in %d min."
	wordClaimed       = "This Whombat is set up."
	wordClaimedOpen   = "Open %s to use it."
	defaultWidth      = 80
	minWidth          = 20
	glyphRows         = 5
	glyphPixel        = "█"
	glyphPixelOffCell = " "
)

// Without an address a person can open (Screen.Openable, Whombat LNK-55) the claimed box points at the apps, which reach
// it on this network. The claim screen shows the letters with the address the app types (Screen.InApp); without one
// either, no claim code, as there is nowhere to type it. The notes above say how to get an address (Tailscale's HTTPS,
// Link ended).
const (
	wordClaimNoAddress = "The code appears once this Whombat has a secure address: Whombat Link or Tailscale."
	wordClaimedApp     = "Use it in the Whombat app on this network."
	// While Tailscale asks for a sign-in or HTTPS (the Expert choice), the claim line names only Tailscale's steps.
	wordClaimAfterTailscale = "After you sign in to Tailscale and turn on HTTPS, the code appears here."
	wordClaimAfterHTTPS     = "After you turn on HTTPS in Tailscale, the code appears here."
	// A box with an address on this network (Screen.InApp) is claimed in the Whombat app there, with the same letters.
	wordClaimInApp = "In the Whombat app on this network, type %s and enter"
	// Only IPv6 addresses on this network (Screen.IPv6Only), whether the box could name one or not: the app takes an
	// IPv4 address, so that is another way, under the line that names Whombat Link and Tailscale.
	wordClaimIPv4 = "This network gave this Whombat only an IPv6 address. If it also gets an IPv4 address, the code appears here and you can claim it in the Whombat app."
)

// Under the claim link at the box's own address (Screen.FallbackInApp, Screen.FallbackTailnet): that address is on the
// internet, where others can keep it busy, so the screen also names a way in they can't reach. Last on the screen,
// under the letters: the first line stays the one to follow.
const (
	wordClaimElseInApp   = "If that page doesn’t open: in the Whombat app on this network, type %s."
	wordClaimElseTailnet = "If that page doesn’t open: on a device on your tailnet, open %s."
)

// New letters, asked for at the box (Whombat whombat-link.md): the person here gets fresh letters that stay for a
// while, whatever others on the network tried. The page has a button for it; this console takes the N key.
const (
	wordClaimStays   = "These letters stay for %d min."
	wordNewLetters   = "Press N for new letters."
	wordNewLettersIn = "Or press N for new letters now."
)

// A device waiting to sign in at this screen, over the claimed screen (Whombat BX-06), verbatim.
const (
	wordSignInKicker = "NEW DEVICE"
	wordSignInTitle  = "%s wants to sign in"
	wordSignInType   = "Type these letters on that device."
	wordSignInIgnore = "Didn’t ask for this? Ignore it: the code goes away in %d min."
)

// Whombat Link and Tailscale on the screen (contracts 4.4; Whombat whombat-link.md). The claim screen on a box reached
// over Tailscale says where to open its link with wordClaimOpenTailnet instead of wordClaimOpen.
const (
	wordLinkTitle        = "Turn on Whombat Link"
	wordLinkOpen         = "On a computer or phone, open %s and enter"
	wordLinkConfirm      = "Sign in or create an account there, then confirm this Whombat."
	wordLinkRotates      = "The code changes in %d min."
	wordLinkWaiting      = "Waiting for this Whombat’s web address…"
	wordLinkWaitingHint  = "Whombat Link is on. New web addresses are handed out in turn, and this one usually comes within a few minutes. This Whombat asks again every minute by itself; this screen changes when the address is ready."
	wordLinkStarting     = "Starting Whombat Link…"
	wordLinkGrace        = "Whombat Link ends on %s. Turn on Tailscale in the Whombat app to keep a way in, and check your paper backup details."
	wordLinkEnded        = "Whombat Link has ended. Subscribe again at app.whombat.com, or turn on Tailscale: in the Whombat app at home, or in the recovery menu (hold Space at power-on)."
	wordTailscaleLogin   = "Sign in to Tailscale: open %s on a computer or phone."
	wordTailscaleHTTPS   = "Turn on HTTPS in Tailscale: in the Tailscale admin console, open DNS and turn on HTTPS Certificates. This Whombat checks again by itself."
	wordClaimOpenTailnet = "On a device on your tailnet, open %s and enter"
)

// body returns the lines of a screen, top to bottom, and the letters drawn large where codeMarker is.
func body(s Screen, now time.Time) ([]string, string) {
	if si := s.LiveSignIn(now); si != nil {
		// The same words as the graphical console's panel (CG-150): whose device, the letters, how long they last.
		return []string{wordSignInKicker, "", fmt.Sprintf(wordSignInTitle, si.Name), si.Device, "", codeMarker, "",
			wordSignInType, fmt.Sprintf(wordSignInIgnore, MinutesLeft(si.ExpiresAt, now))}, DisplayLetters(si.Code)
	}
	if l := s.LinkShown(now); l != nil {
		return linkBody(l, now)
	}
	switch s.State {
	case Waiting:
		if s.IPv6Only {
			// The network is there, with IPv6 only: the claim screen without an address, not “check the cable”.
			return []string{wordClaimTitle, "", s.claimNoAddress(), "", wordClaimIPv4}, ""
		}
		return []string{wordWaiting, "", wordWaitingHint}, ""
	case Claimable:
		open, at := wordClaimOpen, s.URL
		switch {
		case s.Openable && s.OnTailnet():
			open = wordClaimOpenTailnet
		case !s.Openable && s.InApp != "":
			open, at = wordClaimInApp, s.InApp
		case !s.Openable:
			lines := []string{wordClaimTitle, "", s.claimNoAddress()}
			if s.IPv6Only {
				lines = append(lines, "", wordClaimIPv4)
			}
			return lines, ""
		}
		rotates := wordClaimRotates
		if s.LettersStay(now) {
			rotates = fmt.Sprintf(wordClaimStays, MinutesLeft(s.LettersUntil, now))
		}
		lines := []string{wordClaimTitle, "", fmt.Sprintf(open, at), "", codeMarker, "", rotates}
		if s.NewLetters {
			lines = append(lines, wordNewLetters)
		}
		if or := s.claimElse(); or != "" {
			lines = append(lines, "", or)
		}
		return lines, s.Code
	case Backoff:
		lines := []string{fmt.Sprintf(wordBackoff, MinutesLeft(s.RetryAt, now))}
		if s.NewLetters {
			lines = append(lines, wordNewLettersIn)
		}
		return lines, ""
	case Claimed:
		if !s.Openable {
			return []string{wordClaimed, "", wordClaimedApp}, ""
		}
		return []string{wordClaimed, "", fmt.Sprintf(wordClaimedOpen, s.URL)}, ""
	default:
		if p := s.StartShown(); p != nil {
			return startBody(p), ""
		}
		return []string{wordStarting}, ""
	}
}

const codeMarker = "\x00code"

// AsksNewLetters reports whether what was typed on the console's keyboard asks for new letters: the N key, alone (not
// inside a longer burst such as an escape sequence or a pasted word).
func AsksNewLetters(keys []byte) bool {
	return len(keys) == 1 && (keys[0] == 'n' || keys[0] == 'N')
}

// claimElse is the claim screen's last line: the other way in when the address above doesn't open, "" without one.
func (s Screen) claimElse() string {
	switch {
	case s.FallbackTailnet != "":
		return fmt.Sprintf(wordClaimElseTailnet, s.FallbackTailnet)
	case s.FallbackInApp != "":
		return fmt.Sprintf(wordClaimElseInApp, s.FallbackInApp)
	}
	return ""
}

// claimNoAddress is the claim screen's line without an address to open: what Tailscale still needs when it asks for
// something (the note above says how), else either way to get an address.
func (s Screen) claimNoAddress() string {
	if s.Reach != nil && s.Reach.Tailscale != nil {
		switch {
		case s.Reach.Tailscale.LoginURL != "":
			return wordClaimAfterTailscale
		case s.Reach.Tailscale.NeedsHTTPS:
			return wordClaimAfterHTTPS
		}
	}
	return wordClaimNoAddress
}

// linkBody is the screen while Link starts on an unclaimed box: the code and where to type it, else why there is none.
func linkBody(l *Link, now time.Time) ([]string, string) {
	if l.WaitingForAddress {
		return []string{wordLinkWaiting, "", wordLinkWaitingHint}, ""
	}
	code := l.LiveCode(now)
	if code == "" {
		return []string{wordLinkStarting}, ""
	}
	lines := []string{wordLinkTitle, "", fmt.Sprintf(wordLinkOpen, l.URL), "", codeMarker, "", wordLinkConfirm}
	if l.RotatesShown(now) {
		lines = append(lines, fmt.Sprintf(wordLinkRotates, MinutesLeft(l.ExpiresAt, now)))
	}
	return lines, code
}

// GraceShown reports whether the screen says when Link's grace ends: in grace, with the date the file gave.
func (l *Link) GraceShown() bool {
	return l.State == string(protocol.LinkStateGrace) && !l.GraceEndsAt.IsZero()
}

// notes are the lines above the body, in this order: what Tailscale needs, then Link's grace or end. Each is one
// paragraph; the person can act on them whatever the claim's state.
func notes(s Screen, now time.Time) []string {
	if s.Reach == nil {
		return nil
	}
	var out []string
	if t := s.Reach.Tailscale; t != nil {
		if t.LoginURL != "" {
			out = append(out, fmt.Sprintf(wordTailscaleLogin, t.LoginURL))
		}
		if t.NeedsHTTPS {
			out = append(out, wordTailscaleHTTPS)
		}
	}
	if l := s.Reach.Link; l != nil {
		switch {
		case l.GraceShown():
			out = append(out, fmt.Sprintf(wordLinkGrace, DayMonth(l.GraceEndsAt, now)))
		case l.State == string(protocol.LinkStateEnded):
			out = append(out, wordLinkEnded)
		}
	}
	return out
}

// DayMonth is a date as the screen says it, in the box's time zone: "25 November", with the year only when it isn't
// this year's.
func DayMonth(t, now time.Time) string {
	t = t.In(now.Location())
	if t.Year() != now.Year() {
		return t.Format("2 January 2006")
	}
	return t.Format("2 January")
}

// MinutesLeft is the backoff shown on the console: whole minutes until retryAt, rounded up, at least 1.
func MinutesLeft(retryAt, now time.Time) int {
	m := int(math.Ceil(retryAt.Sub(now).Minutes()))
	return max(m, 1)
}

// Render draws a whole frame of width columns. With height > 0 the body is centred vertically and the
// footer sits on the last lines (exactly height lines, no trailing newline, so a VT never scrolls); with
// height 0 the frame is compact (for --once). footer is plain text (already cleaned by the caller).
func Render(s Screen, now time.Time, width, height int, footer []string) string {
	if width < minWidth {
		width = defaultWidth
	}
	text, code := body(s, now)
	var top []string
	if s.Alert != nil {
		// The warning comes first on every screen: it is about using the box at all.
		top = append(top, "WARNING", AlertWords(s.Alert.Kind), "")
	}
	for _, n := range notes(s, now) {
		top = append(top, n, "")
	}
	text = append(top, text...)
	lines := layout(text, code, width, true)
	var foot []string
	for _, l := range footer {
		for _, w := range wrap(l, width-2) {
			foot = append(foot, "  "+w)
		}
	}
	var out []string
	if height <= 0 {
		out = append(append(append([]string{""}, lines...), ""), foot...)
		return strings.Join(trimRight(out), "\n") + "\n"
	}
	area := height - len(foot) - 1 // one blank line above the footer
	if len(lines) > area {
		// Too much for the screen: the code as plain letters only, then without the blank lines between paragraphs, so
		// every word still fits above the footer.
		lines = layout(text, code, width, false)
		if len(lines) > area {
			lines = slices.DeleteFunc(lines, func(l string) bool { return strings.TrimSpace(l) == "" })
		}
	}
	pad := max((area-len(lines))/2, 0)
	for range pad {
		out = append(out, "")
	}
	out = append(out, lines...)
	for len(out) < height-len(foot) {
		out = append(out, "")
	}
	out = append(out, foot...)
	if len(out) > height {
		out = out[:height]
	}
	return strings.Join(trimRight(out), "\n")
}

// layout centres the lines of text in width columns, wrapped, with the code where codeMarker is (in block letters when
// big and they fit).
func layout(text []string, code string, width int, big bool) []string {
	var lines []string
	for _, l := range text {
		if l == codeMarker {
			if big {
				lines = append(lines, codeLines(code, width)...)
			} else {
				lines = append(lines, center(code, width))
			}
			continue
		}
		for _, w := range wrap(l, width-2) {
			lines = append(lines, center(w, width))
		}
	}
	return lines
}

// codeLines draws the code (or the sign-in's grouped letters) in 5-row block letters when the width allows — two columns per pixel (square on a
// VT's 1:2 cells) or else one — and always as plain text underneath (block letters read from a distance, the
// plain line is unambiguous).
func codeLines(code string, width int) []string {
	plain := center(code, width)
	for _, f := range []struct{ scale, gap int }{{2, 4}, {1, 2}, {1, 1}} {
		rows, ok := bigText(code, f.scale, f.gap)
		if !ok || utf8.RuneCountInString(rows[0]) > width-2 {
			continue
		}
		var out []string
		for _, r := range rows {
			out = append(out, center(r, width))
		}
		return append(out, "", plain)
	}
	return []string{plain}
}

func bigText(s string, scale, gap int) ([]string, bool) {
	rows := make([]string, glyphRows)
	px := strings.NewReplacer("#", strings.Repeat(glyphPixel, scale), ".", strings.Repeat(glyphPixelOffCell, scale))
	for i, r := range s {
		g, ok := font[r]
		if !ok {
			return nil, false
		}
		for y := range glyphRows {
			if i > 0 {
				rows[y] += strings.Repeat(glyphPixelOffCell, gap)
			}
			rows[y] += px.Replace(g[y])
		}
	}
	return rows, true
}

func center(s string, width int) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	return strings.Repeat(" ", (width-n)/2) + s
}

// wrap breaks s at spaces into lines of at most w runes. A longer word (a long sign-in link) is broken across lines:
// it is shown whole, never cut, and a line wider than the screen would make the terminal wrap it and push the footer
// off.
func wrap(s string, w int) []string {
	if w < 10 || utf8.RuneCountInString(s) <= w {
		return []string{s}
	}
	var out []string
	cur := ""
	for _, word := range strings.Fields(s) {
		for utf8.RuneCountInString(word) > w {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
			r := []rune(word)
			out = append(out, string(r[:w]))
			word = string(r[w:])
		}
		switch {
		case cur == "":
			cur = word
		case utf8.RuneCountInString(cur)+1+utf8.RuneCountInString(word) <= w:
			cur += " " + word
		default:
			out = append(out, cur)
			cur = word
		}
	}
	return append(out, cur)
}

func trimRight(lines []string) []string {
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	return lines
}

// font: 5×5 block letters for the claim-code alphabet of CC-01 (also the Link code's, 4.4), the digits and the dash,
// and a narrower space between the sign-in's two groups of three (BX-06).
var font = map[rune][glyphRows]string{
	' ': {"...", "...", "...", "...", "..."},
	'A': {".###.", "#...#", "#####", "#...#", "#...#"},
	'B': {"####.", "#...#", "####.", "#...#", "####."},
	'C': {".####", "#....", "#....", "#....", ".####"},
	'D': {"####.", "#...#", "#...#", "#...#", "####."},
	'E': {"#####", "#....", "####.", "#....", "#####"},
	'F': {"#####", "#....", "####.", "#....", "#...."},
	'G': {".####", "#....", "#..##", "#...#", ".####"},
	'H': {"#...#", "#...#", "#####", "#...#", "#...#"},
	'J': {"..###", "...#.", "...#.", "#..#.", ".##.."},
	'K': {"#...#", "#..#.", "###..", "#..#.", "#...#"},
	'M': {"#...#", "##.##", "#.#.#", "#...#", "#...#"},
	'N': {"#...#", "##..#", "#.#.#", "#..##", "#...#"},
	'P': {"####.", "#...#", "####.", "#....", "#...."},
	'Q': {".###.", "#...#", "#.#.#", "#..#.", ".##.#"},
	'R': {"####.", "#...#", "####.", "#..#.", "#...#"},
	'T': {"#####", "..#..", "..#..", "..#..", "..#.."},
	'V': {"#...#", "#...#", "#...#", ".#.#.", "..#.."},
	'W': {"#...#", "#...#", "#.#.#", "##.##", "#...#"},
	'X': {"#...#", ".#.#.", "..#..", ".#.#.", "#...#"},
	'Y': {"#...#", ".#.#.", "..#..", "..#..", "..#.."},
	'0': {".###.", "#..##", "#.#.#", "##..#", ".###."},
	'1': {"..#..", ".##..", "..#..", "..#..", ".###."},
	'2': {".###.", "#...#", "..##.", ".#...", "#####"},
	'3': {"####.", "....#", ".###.", "....#", "####."},
	'4': {"#..#.", "#..#.", "#####", "...#.", "...#."},
	'5': {"#####", "#....", "####.", "....#", "####."},
	'6': {".###.", "#....", "####.", "#...#", ".###."},
	'7': {"#####", "....#", "...#.", "..#..", "..#.."},
	'8': {".###.", "#...#", ".###.", "#...#", ".###."},
	'9': {".###.", "#...#", ".####", "....#", ".###."},
	'-': {".....", ".....", ".###.", ".....", "....."},
}
