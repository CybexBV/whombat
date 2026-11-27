// Package consoleapi is the graphical console's API (CG-06, CG-31): what the page shows, as validated, typed JSON.
// It reads exactly what the text console reads (console/internal/source) with the same validation (screen.Parse),
// and writes nothing. With a desk socket (Whombat DK-12, NX-160) it also passes the runtime's desk state on, checked
// and cleaned (console/internal/desk), and the page's few desk requests back, each checked on the way.
package consoleapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// Server answers the page's polls.
type Server struct {
	load   func() screen.Screen // the runtime's state file, validated (starting screen when unusable)
	footer string
	now    func() time.Time
	desk   *desk.Client // nil: no desk socket (the installer's tests, a console without --desk-socket)
	wait   screen.WaitWatch
}

// BodyLimits are the request bodies larger than the API's 1 KiB: a recording of up to 30 s, base64 (§2.5; the socket's
// own limit, DESK_TALK_REQUEST_MAX_BYTES, as the page's body carries the same), a recording from Talk's mic of up to
// five minutes (3.3, CG-363: DESK_HEAR_REQUEST_MAX_BYTES), a look's quiet (0.122, CG-331: a key of 120 and a subject
// of 160 code points, DESK_REQUEST_MAX_BYTES), a look's step (3.5, CG-371: the socket's own limit too) and the outputs'
// sizes (3.6).
var BodyLimits = map[string]int64{
	"/api/desk/talk":       local.DeskTalkRequestMaxBytes,
	"/api/desk/hear":       local.DeskHearRequestMaxBytes,
	"/api/desk/look/quiet": local.DeskRequestMaxBytes,
	"/api/desk/look/fix":   local.DeskRequestMaxBytes,
	// The outputs' sizes (3.6: four names of up to 60): the socket's own limit.
	"/api/desk/size": local.DeskRequestMaxBytes,
}

// WithDesk gives the server the desk socket's client.
func (s *Server) WithDesk(c *desk.Client) *Server {
	s.desk = c
	return s
}

// New makes a server. load reads the runtime's state file (source.Load on the appliance); footer is the banner's
// lines (already cleaned), sent as one string with "\n" between them.
func New(load func() screen.Screen, footer []string, now func() time.Time) *Server {
	if now == nil {
		now = time.Now
	}
	return &Server{load: load, footer: strings.Join(footer, "\n"), now: now}
}

// State is GET /api/state.
type State struct {
	Mode           string `json:"mode"`
	Now            string `json:"now"`
	Claim          Claim  `json:"claim"`
	Footer         string `json:"footer"`
	Locale         string `json:"locale,omitempty"`
	StandardFooter bool   `json:"standardFooter,omitempty"`
	// Desk is the runtime's desk state (DK-01…DK-12), null without a desk socket or an answer within a second.
	Desk *desk.State `json:"desk"`
	// Network is how the box is connected (the chip, CG-100), null without a desk socket or an answer within 2 s.
	Network *NetworkSummary `json:"network"`
	// Bluetooth is the box's Bluetooth (the chip, CG-201), null without a desk socket, an answer within 2 s or an
	// adapter.
	Bluetooth *BluetoothSummary `json:"bluetooth"`
	// Alert is a warning over every console screen (contracts 4.3, CG-400), left out when there is none.
	Alert *Alert `json:"alert,omitempty"`
	// Reach is Whombat Link and Tailscale as the text console shows them (contracts 4.4, CG-402, CG-404), left out when
	// the text console would show nothing of them.
	Reach *Reach `json:"reach,omitempty"`
}

// Reach is what the screen says about Whombat Link and Tailscale: only what the text console would show at the same
// moment (screen.Reach, already checked and cleaned by screen.Parse), so the page needs no rules of its own.
type Reach struct {
	Link      *ReachLink      `json:"link,omitempty"`
	Tailscale *ReachTailscale `json:"tailscale,omitempty"`
}

// ReachLink is Link on the screen: starting (in place of the claim: the code, waiting for an address, or starting), on
// while the unclaimed box still waits for its web address (waitingForAddress, screen.LinkAwaitsAddress), grace with its
// end date, or ended. Off, and on otherwise, show nothing and are left out.
type ReachLink struct {
	State string `json:"state"`
	// Code and URL: starting, while the code is live; the page types nothing, it shows them.
	Code string `json:"code,omitempty"`
	URL  string `json:"url,omitempty"`
	// QR is the Link page with the code in its address as a QR code (screen.QRModules: one string per row, '#' dark),
	// so a phone opens it with the code filled in; left out without an https page or when too long to read.
	QR []string `json:"qr,omitempty"`
	// ExpiresAt (RFC 3339, the server's clock): when the code changes, only when the screen says so (screen.RotatesShown).
	ExpiresAt         string `json:"expiresAt,omitempty"`
	WaitingForAddress bool   `json:"waitingForAddress,omitempty"`
	// InApp is the address to type in the Whombat app on this network once the wait for the web address took long
	// (screen.WaitingInApp); the page shows it with the claim's letters. Left out before, and outside the wait.
	InApp string `json:"inApp,omitempty"`
	// GraceEndsOn is the day grace ends as the text console says it (“25 November”, the box's time zone).
	GraceEndsOn string `json:"graceEndsOn,omitempty"`
	// GraceEndsAt is the same day as an ISO date in the box's time zone.
	GraceEndsAt string `json:"graceEndsAt,omitempty"`
}

// ReachTailscale is what Tailscale needs from the person: its sign-in page (without the scheme, shown as text) and
// whether HTTPS certificates must be turned on.
type ReachTailscale struct {
	LoginURL   string `json:"loginUrl,omitempty"`
	NeedsHTTPS bool   `json:"needsHttps,omitempty"`
	// LoginQR is the sign-in page as a QR code (as ReachLink.QR); left out when it isn't https or is too long to read.
	LoginQR []string `json:"loginQr,omitempty"`
	// First: the screen numbers Tailscale's step and the claim (screen.TailscaleFirst), “1 · ” on this note.
	First bool `json:"first,omitempty"`
}

// Alert is the runtime's alert as the page gets it: its kind and since when (RFC 3339).
type Alert struct {
	Kind  string `json:"kind"`
	Since string `json:"since"`
}

// Claim is the claim state.
type Claim struct {
	State    string          `json:"state"`
	Code     string          `json:"code,omitempty"`
	ClaimURL string          `json:"claimUrl"` // "" when the box has no address a person can open (screen.Openable)
	AppURL   string          `json:"appUrl"`   // likewise
	RetryAt  string          `json:"retryAt,omitempty"`
	Burrows  *screen.Burrows `json:"burrows,omitempty"`
	// SignIn is a device waiting to sign in at this screen (BX-06, CG-150): claimed only, left out once its time is up.
	SignIn *SignIn `json:"signIn,omitempty"`
	// OnTailnet: the claim link is the box's Tailscale name, so the screen says to open it on the tailnet (CG-402).
	OnTailnet bool `json:"onTailnet,omitempty"`
	// InApp is the address to type in the Whombat app on this network, when the box has no address a person can open
	// but one there (screen.InApp): the page shows the code with it. Claimable only.
	InApp string `json:"inApp,omitempty"`
	// Start is why the first start can't finish (CG-409): starting only, left out when there is none.
	Start *Start `json:"start,omitempty"`
	// IPv6Only: the box's network gave it only IPv6 addresses (screen.IPv6Only); the page says an IPv4 address is
	// another way. Claimable without an address, and waiting (a box that could name none of them).
	IPv6Only bool `json:"ipv6Only,omitempty"`
	// LettersUntil (RFC 3339, the server's clock): the letters were asked for at this screen and stay until then
	// (screen.LettersStay). Claimable only, left out when the letters change after a wrong try.
	LettersUntil string `json:"lettersUntil,omitempty"`
	// NewLetters: the page may offer New letters (POST /api/claim/letters). Claimable and backoff only, with a desk
	// socket to pass it on.
	NewLetters bool `json:"newLetters,omitempty"`
	// FallbackTailnet and FallbackInApp: another way to the claim, for when the claim link doesn't open
	// (screen.FallbackTailnet, screen.FallbackInApp): the box's page on its tailnet name, or its address on this network
	// to type in the Whombat app. At most one, and only where the page shows the claim link with its code.
	FallbackTailnet string `json:"fallbackTailnet,omitempty"`
	FallbackInApp   string `json:"fallbackInApp,omitempty"`
	// QR is the claim link as a QR code (screen.QRModules), only beside the claim link with its code and only for an
	// https link. Never the letters: they are typed, so whoever opens the link still needs to be at the screen.
	QR []string `json:"qr,omitempty"`
	// Second: the claim is the second of two numbered steps, after Tailscale's (screen.TailscaleFirst).
	Second bool `json:"second,omitempty"`
	// PageOpen: a browser has the claim link open (screen.PageOpen). The page says to type the letters there, and gets
	// no QR code or second way in. Only beside the claim link with its code.
	PageOpen bool `json:"pageOpen,omitempty"`
}

// Start is the start problem as the page gets it: its kind and the release the box was installed with ("" none to
// show); the page says the text console's words.
type Start struct {
	Problem string `json:"problem"`
	Release string `json:"release,omitempty"`
}

// SignIn is the sign-in panel's: the six letters as typed (the page groups them), whose device and which, and when the
// code goes away (RFC 3339, the server's clock: the page counts down against `now`).
type SignIn struct {
	Code      string `json:"code"`
	Name      string `json:"name"`
	Device    string `json:"device"`
	ExpiresAt string `json:"expiresAt"`
}

// State computes what the page shows now.
func (s *Server) State(ctx context.Context) State {
	sc := s.load()
	now := s.now()
	sc.WaitedLong = s.wait.Long(sc, now)
	c := Claim{State: sc.State, Code: sc.Code, ClaimURL: sc.URL, AppURL: AppURL(sc.URL), Burrows: sc.Burrows}
	if sc.State == screen.Claimable && sc.OnTailnet() {
		c.OnTailnet = true
	}
	if !sc.Openable {
		// Plain HTTP on a box serves no page (Whombat LNK-55): the page gets no address to open. The claim code stays
		// when the app on this network can take it; otherwise there is nowhere to type it, and the page says
		// how to go on instead.
		c.ClaimURL, c.AppURL, c.OnTailnet = "", "", false
		if sc.State == screen.Claimable && sc.InApp != "" {
			c.InApp = sc.InApp
		} else {
			c.Code = ""
			c.IPv6Only = (sc.State == screen.Claimable || sc.State == screen.Waiting) && sc.IPv6Only
		}
	}
	if c.ClaimURL != "" && c.Code != "" {
		if sc.PageOpen {
			// The page is open already: only the letters matter, and a QR code would move the claim to a phone.
			c.PageOpen = true
		} else {
			c.FallbackTailnet, c.FallbackInApp = sc.FallbackTailnet, sc.FallbackInApp
			if sc.State == screen.Claimable {
				c.QR = screen.QRModules(sc.ClaimHref)
			}
		}
	}
	if p := sc.StartShown(); p != nil {
		c.Start = &Start{Problem: p.Problem, Release: p.Release}
	}
	if sc.State == screen.Backoff && !sc.RetryAt.IsZero() {
		c.RetryAt = sc.RetryAt.UTC().Format(time.RFC3339)
	}
	c.Second = sc.TailscaleFirst(now)
	// New letters: only where the page still shows letters (or the wait), and only when this server can pass it on.
	if c.Code != "" && sc.LettersStay(now) {
		c.LettersUntil = sc.LettersUntil.UTC().Format(time.RFC3339)
	}
	c.NewLetters = sc.NewLetters && s.desk != nil && (c.Code != "" || sc.State == screen.Backoff)
	if si := sc.LiveSignIn(now); si != nil {
		c.SignIn = &SignIn{Code: si.Code, Name: si.Name, Device: si.Device, ExpiresAt: si.ExpiresAt.UTC().Format(time.RFC3339)}
	}
	st := State{
		Mode: "console", Now: now.UTC().Format(time.RFC3339), Claim: c,
		Footer: s.footer, StandardFooter: s.footer == screen.Footer, Locale: sc.Locale,
	}
	if sc.Alert != nil {
		st.Alert = &Alert{Kind: sc.Alert.Kind, Since: sc.Alert.Since.UTC().Format(time.RFC3339)}
	}
	st.Reach = reach(sc, now)
	if s.desk != nil {
		// All at once: each has its own cache and timeout, so a slow network or Bluetooth answer doesn't hold up the
		// desk's.
		network := make(chan *NetworkSummary, 1)
		bluetooth := make(chan *BluetoothSummary, 1)
		go func() { network <- s.networkSummary(ctx) }()
		go func() { bluetooth <- s.bluetoothSummary(ctx) }()
		st.Desk = s.desk.State(ctx)
		st.Network, st.Bluetooth = <-network, <-bluetooth
	}
	return st
}

// reach is the screen's reach as the page gets it: what the text console shows at now (screen.Render's body and notes),
// nothing more. Nil when that is nothing.
func reach(sc screen.Screen, now time.Time) *Reach {
	if sc.Reach == nil {
		return nil
	}
	out := &Reach{}
	if l := sc.LinkShown(now); l != nil {
		rl := &ReachLink{State: l.State, WaitingForAddress: l.WaitingForAddress, InApp: sc.WaitingInApp(now)}
		if code := l.LiveCode(now); code != "" {
			rl.Code, rl.URL, rl.QR = code, l.URL, screen.QRModules(l.CodeHref(code))
			if l.RotatesShown(now) {
				rl.ExpiresAt = l.ExpiresAt.UTC().Format(time.RFC3339)
			}
		}
		out.Link = rl
	} else if l := sc.Reach.Link; l != nil {
		switch {
		case l.GraceShown():
			out.Link = &ReachLink{State: l.State, GraceEndsOn: screen.DayMonth(l.GraceEndsAt, now)}
			if sc.Locale != "" {
				out.Link.GraceEndsAt = l.GraceEndsAt.In(now.Location()).Format(time.DateOnly)
			}
		case l.State == string(protocol.LinkStateEnded):
			out.Link = &ReachLink{State: l.State}
		}
	}
	if t := sc.Reach.Tailscale; t != nil && (t.LoginURL != "" || t.NeedsHTTPS) {
		out.Tailscale = &ReachTailscale{LoginURL: t.LoginURL, NeedsHTTPS: t.NeedsHTTPS, LoginQR: screen.QRModules(t.LoginHref),
			First: sc.TailscaleFirst(now)}
	}
	if out.Link == nil && out.Tailscale == nil {
		return nil
	}
	return out
}

// AppURL is the app's address as the claimed screen names it (“Open app.whombat.com to use it.”): the claim URL
// (already without its scheme and validated, screen.Parse) without its last `/claim`. The file names no other URL.
func AppURL(claimURL string) string {
	if claimURL == "" {
		return ""
	}
	if i := strings.Index(claimURL, "/"); i >= 0 {
		return claimURL[:i]
	}
	return claimURL
}

// Handler serves /api/state and the desk's requests (behind web.Handler's token check and body limit).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodGet) {
			return
		}
		web.JSON(w, http.StatusOK, s.State(r.Context()))
	})
	// The desk (§2.5): thin, checked pass-throughs to the runtime's desk socket. The page sends the fields named here;
	// the server builds the runtime's request itself, so nothing else reaches the socket.
	mux.HandleFunc("/api/desk/unlock", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Pin string `json:"pin"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.Unlock(ctx, in.Pin)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/unlock/phone", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.Phone(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/lock", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.Lock(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/touch", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.Touch(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/decide", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Number   int64   `json:"number"`
			Decision string  `json:"decision"`
			Pin      *string `json:"pin"`   // a risky ask's Approve (0.108, DK-62), a wider choice's (0.116, TF-14)
			Scope    *string `json:"scope"` // one of the ask's choices (0.116, TF-14)
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.Decide(ctx, in.Number, in.Decision, in.Pin, in.Scope)
		return a, true, err
	}))
	// New letters on the claim screen (Whombat whombat-link.md): the person at the box asks for fresh claim letters
	// that stay for a while. Nothing but the request; the runtime answers 409 not_available where it doesn't apply.
	mux.HandleFunc("/api/claim/letters", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.ClaimLetters(ctx)
		return a, true, err
	}))
	// Found on your network's Not now (0.110, DF-04): allowed while locked, nothing but the request.
	mux.HandleFunc("/api/desk/found/dismiss", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.FoundDismiss(ctx)
		return a, true, err
	}))
	// Every server and a server's own screen (0.115, DK-83, DK-86): locked too, not in *Only the time* (the runtime's
	// `locked`); the page sends a server's id and a range, nothing else reaches the socket.
	mux.HandleFunc("/api/desk/servers", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.Servers(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/server", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			ID    string `json:"id"`
			Range string `json:"range"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.Server(ctx, in.ID, in.Range)
		return a, true, err
	}))
	// Ignore and Not now on a look (0.122, QN-20, CG-331): the look's key and its line as the state gave them, and how;
	// the runtime takes it only unlocked, from a person who may manage the thing.
	mux.HandleFunc("/api/desk/look/quiet", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Key    string `json:"key"`
			Notice struct {
				Check   string  `json:"check"`
				Subject *string `json:"subject"`
			} `json:"notice"`
			How string `json:"how"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.QuietLook(ctx, in.Key, in.Notice.Check, in.Notice.Subject, in.How)
		return a, true, err
	}))
	// The step the assistant offers on a look (3.5, CG-371): the look's key, nothing else; the runtime takes it only
	// unlocked, from a person who may manage the thing.
	mux.HandleFunc("/api/desk/look/fix", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Key string `json:"key"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.FixLook(ctx, in.Key)
		return a, true, err
	}))
	// The screen of widgets (3.6): the outputs the page shows on and their sizes, at start and whenever they change.
	mux.HandleFunc("/api/desk/size", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Outputs []desk.SizeOutput `json:"outputs"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.Size(ctx, in.Outputs)
		return a, true, err
	}))
	// A picture a widget names, as Talk's spoken answer (GET ?thing=…&ref=…): the thing and its signed ref, nothing else
	// reaches the socket; the bytes come back with their type, and the page shows them from a blob it made (the runtime
	// decides whether the screen may see them).
	mux.HandleFunc("/api/desk/image", func(w http.ResponseWriter, r *http.Request) {
		if s.desk == nil {
			web.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !web.Method(w, r, http.MethodGet) {
			return
		}
		q := r.URL.Query()
		img, kind, err := s.desk.Image(r.Context(), q.Get("thing"), q.Get("ref"))
		if err != nil {
			deskError(w, err)
			return
		}
		w.Header().Set("Content-Type", kind)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(img)
	})
	// Remote help's Stop (CG-291): no body, no PIN, locked or not.
	mux.HandleFunc("/api/desk/remote-help/stop", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.RemoteHelpStop(ctx)
		return a, true, err
	}))
	// The open conversation and its end (0.108, DK-63, DK-64).
	mux.HandleFunc("/api/desk/talk/session", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.TalkSession(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/talk/close", s.deskPost(func(ctx context.Context, _ *http.Request, _ http.ResponseWriter) (any, bool, error) {
		a, err := s.desk.TalkClose(ctx)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/talk", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			Text     *string `json:"text"`
			AudioWav *string `json:"audioWav"`
			Continue bool    `json:"continue"`
			Server   *string `json:"server"` // Ask about this server (0.115, DK-85)
			Spoken   bool    `json:"spoken"` // the words Talk's mic heard (3.3, CG-361)
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.Talk(ctx, in.Text, in.AudioWav, in.Continue, in.Server, in.Spoken)
		return a, true, err
	}))
	// Talk's mic (3.3, CG-363): the recording to words for Talk's box. The box may take minutes for five minutes of
	// speech, longer than the server's timeouts: this request's own are as long as the runtime may take.
	mux.HandleFunc("/api/desk/hear", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			AudioWav string `json:"audioWav"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		until := time.Now().Add(desk.HearTimeout(desk.HearSeconds(in.AudioWav)) + 5*time.Second)
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(until)
		_ = rc.SetWriteDeadline(until)
		a, err := s.desk.Hear(ctx, in.AudioWav)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/talk/get", s.deskPost(func(ctx context.Context, r *http.Request, w http.ResponseWriter) (any, bool, error) {
		var in struct {
			ID string `json:"id"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return nil, false, nil
		}
		a, err := s.desk.TalkGet(ctx, in.ID)
		return a, true, err
	}))
	mux.HandleFunc("/api/desk/talk/audio", func(w http.ResponseWriter, r *http.Request) {
		if s.desk == nil {
			web.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !web.Method(w, r, http.MethodGet) {
			return
		}
		wav, err := s.desk.TalkAudio(r.Context(), r.URL.Query().Get("id"))
		if err != nil {
			deskError(w, err)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(wav)
	})
	s.networkRoutes(mux)
	s.bluetoothRoutes(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { web.Error(w, http.StatusNotFound, "not found") })
	return mux
}

// deskPost is a desk request: POST only, 404 without a desk socket; call decodes the page's body (false: it answered
// already) and asks the runtime.
func (s *Server) deskPost(call func(context.Context, *http.Request, http.ResponseWriter) (any, bool, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.desk == nil {
			web.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		out, ok, err := call(r.Context(), r, w)
		if !ok {
			return
		}
		if err != nil {
			deskError(w, err)
			return
		}
		web.JSON(w, http.StatusOK, out)
	}
}

// deskError answers with the runtime's status and code (`{"message": "<code>"}`, as the console's other errors);
// no desk socket or no answer is 503 `unavailable`.
func deskError(w http.ResponseWriter, err error) {
	var de *desk.Error
	switch {
	case errors.As(err, &de):
		web.Error(w, de.Status, de.Code)
	case errors.Is(err, desk.ErrUnavailable):
		web.Error(w, http.StatusServiceUnavailable, "unavailable")
	default:
		web.Error(w, http.StatusBadGateway, "failed")
	}
}
