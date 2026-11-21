package screen

import (
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Reach is how the box is reached, as the screen shows it (contracts 4.4 `ConsoleReach`, any claim state): Whombat
// Link's state and code, and what Tailscale still needs. Each part is nil when it has nothing the screen can show.
type Reach struct {
	Link      *Link
	Tailscale *Tailscale
}

// Link is Whombat Link on the screen (contracts 4.4 `ConsoleLink`; Whombat whombat-link.md).
type Link struct {
	State             string    // off, starting, on, grace or ended (protocol.LinkState)
	Code              string    // starting only, XXXX-XXXX; "" unless URL is set too, as the code means nothing without the page
	URL               string    // the page to type the code at, without the scheme (app.whombat.com/link)
	ExpiresAt         time.Time // the code changes then; zero when the file doesn't say
	WaitingForAddress bool      // confirmed, but the day's new addresses ran out
	GraceEndsAt       time.Time // grace only; zero when the file doesn't say
}

// Tailscale is what Tailscale needs from the person, on the screen (contracts 4.4 `ConsoleTailscale`).
type Tailscale struct {
	LoginURL   string // the sign-in page without the scheme, e.g. login.tailscale.com/a/abc123
	NeedsHTTPS bool   // the tailnet has HTTPS certificates off
	Name       string // the box's name on the tailnet, once it's in
}

// MaxLoginURL bounds the Tailscale sign-in link as shown (the contract's 500 less the scheme): it is shown whole, over
// as many lines as it needs, so it must not be able to fill the screen.
const MaxLoginURL = 500

// MaxLinkCodeAhead bounds how far ahead a Link code may expire for the screen to say when it changes: the code's own
// lifetime (protocol.LinkCodeTTLS) three times over, as MaxSignInAhead does for a sign-in.
const MaxLinkCodeAhead = 3 * protocol.LinkCodeTTLS * time.Second

// The contract's LinkCode (protocol.LinkCodePattern): the claim alphabet, 4 + 4. The schema checked it; the screen
// draws nothing else as the code.
var linkCodeRe = regexp.MustCompile(protocol.LinkCodePattern)

// A tailnet name as the contract has it (TailscaleName): lower-case DNS labels, at least two.
var tailnetNameRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`)

// displayReach is the file's reach as the screen shows it: each member checked once more and dropped on its own when
// it is wrong, so a bad sign-in link never hides the Link code and the other way round.
func displayReach(r *local.ConsoleReach) *Reach {
	if r == nil {
		return nil
	}
	out := &Reach{Link: displayLink(r.Link), Tailscale: displayTailscale(r.Tailscale)}
	if out.Link == nil && out.Tailscale == nil {
		return nil
	}
	return out
}

func displayLink(l *local.ConsoleLink) *Link {
	if l == nil || !slices.Contains(protocol.LinkStateValues, l.State) {
		return nil
	}
	out := &Link{State: string(l.State), WaitingForAddress: l.WaitingForAddress != nil && *l.WaitingForAddress}
	if l.Code != nil && l.URL != nil && linkCodeRe.MatchString(*l.Code) {
		if u, err := displayURLMax(*l.URL, 100); err == nil {
			out.Code, out.URL = *l.Code, u
		}
	}
	if l.ExpiresAt != nil {
		if t, err := time.Parse(time.RFC3339Nano, *l.ExpiresAt); err == nil {
			out.ExpiresAt = t
		}
	}
	if l.GraceEndsAt != nil {
		if t, err := time.Parse(time.RFC3339Nano, *l.GraceEndsAt); err == nil {
			out.GraceEndsAt = t
		}
	}
	return out
}

func displayTailscale(t *local.ConsoleTailscale) *Tailscale {
	if t == nil {
		return nil
	}
	out := &Tailscale{NeedsHTTPS: t.NeedsHttps != nil && *t.NeedsHttps}
	if t.LoginURL != nil {
		// Shown as text, never as a link or a QR code: the same plain host/path rule as the claim link.
		if u, err := displayURLMax(*t.LoginURL, MaxLoginURL); err == nil {
			out.LoginURL = u
		}
	}
	if t.Name != nil && len(*t.Name) <= 253 && tailnetNameRe.MatchString(*t.Name) {
		out.Name = *t.Name
	}
	if *out == (Tailscale{}) {
		return nil
	}
	return out
}

// LinkStarting is the Link that takes the place of the claim screen: Link starting. The claim needs the box's address
// first, so even a box that already has a claim code shows the Link code first. A claimed box shows it only while
// there is a code to type (body): the owner may have chosen Link in the recovery menu, with no app to show it.
func (s Screen) LinkStarting() *Link {
	if s.Reach == nil || s.Reach.Link == nil || s.Reach.Link.State != string(protocol.LinkStateStarting) {
		return nil
	}
	return s.Reach.Link
}

// LinkShown is the Link that takes the place of the claim screen at now, nil when the claim's own screen shows: Link
// starting, and on a claimed box only while there is a code to type. The text console (body) and the graphical one
// (consoleapi) use the same rule.
func (s Screen) LinkShown(now time.Time) *Link {
	l := s.LinkStarting()
	if l == nil || (s.State == Claimed && l.LiveCode(now) == "") {
		return nil
	}
	return l
}

// RotatesShown reports whether the screen says when the Link code changes: a code lasts LinkCodeTTLS, and a time much
// further off is a broken clock or file, where a wrong count is worse than none.
func (l *Link) RotatesShown(now time.Time) bool {
	return !l.ExpiresAt.IsZero() && l.ExpiresAt.Sub(now) <= MaxLinkCodeAhead
}

// LiveCode is the Link code the screen shows at now: none once it has expired (the box asks for a new one then, and a
// runtime that stopped rewriting the file can't leave a dead code on screen).
func (l *Link) LiveCode(now time.Time) string {
	if l.Code == "" || (!l.ExpiresAt.IsZero() && !now.Before(l.ExpiresAt)) {
		return ""
	}
	return l.Code
}

// OnTailnet reports whether the claim link names the box's Tailscale address, so the claim screen says to open it on
// the tailnet rather than anywhere.
func (s Screen) OnTailnet() bool { return s.onTailnet(s.URL) }

// onTailnet reports whether shown (an address without its scheme) is on the box's Tailscale name.
func (s Screen) onTailnet(shown string) bool {
	if s.Reach == nil || s.Reach.Tailscale == nil || s.Reach.Tailscale.Name == "" {
		return false
	}
	host, _, _ := strings.Cut(shown, "/")
	host, _, _ = strings.Cut(host, ":")
	return strings.EqualFold(host, s.Reach.Tailscale.Name)
}
