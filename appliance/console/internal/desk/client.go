// Package desk is the console server's side of the desk socket (Whombat DK-12, brief §2.3, NX-160): HTTP/1.1 JSON over
// the unix socket the runtime opens in the console's directory (/run/whombat/console/desk.sock, 0660, group
// whombat-console). The runtime decides what the screen shows and what it may do; this client asks, checks every answer
// against the contract (the generated `local` types' rules) and cleans every display string before the page gets it, as
// the console does with the console file (NX-78). It dials the socket only from the graphical console's server (and
// `--once --json`); the text console on tty1 has no socket at all.
//
// The peer is checked: the socket must be served by the runtime's uid (SO_PEERCRED on the dialled connection; the
// runtime itself, Node, can't read its peer, so the socket's mode and group are its side of the check, MR-15).
package desk

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"golang.org/x/sys/unix"
)

// The desk socket's paths (DESK_PATHS).
const (
	PathState     = local.DeskPathState
	PathUnlock    = local.DeskPathUnlock
	PathPhone     = local.DeskPathUnlockPhone
	PathLock      = local.DeskPathLock
	PathTouch     = local.DeskPathTouch
	PathDecide    = local.DeskPathDecide
	PathTalk      = local.DeskPathTalk
	PathTalkGet   = local.DeskPathTalkGet
	PathTalkAudio = local.DeskPathTalkAudio
	// The open conversation and its end (0.108, DK-63, DK-64).
	PathTalkSession = local.DeskPathTalkSession
	PathTalkClose   = local.DeskPathTalkClose
	// Found on your network's Not now (0.110, DF-04), also while locked.
	PathFoundDismiss = local.DeskPathFoundDismiss
	PathClaimLetters = local.DeskPathClaimLetters
	// Every server and a server's own screen (0.115, DK-83, DK-86), locked too but not in *Only the time*.
	PathServers = local.DeskPathServers
	PathServer  = local.DeskPathServer
)

// SocketDefault is DESK_SOCKET_DEFAULT (env WHOMBAT_DESK_SOCKET of the runtime).
const SocketDefault = local.DeskSocketDefault

const (
	// StateTimeout: the page polls every second; a runtime that takes longer is “no desk” for that poll (§2.5).
	StateTimeout = time.Second
	// CacheFor: one runtime call per second however many polls (the page's and the kiosk's).
	CacheFor    = time.Second
	callTimeout = 5 * time.Second
	talkTimeout = 15 * time.Second

	maxStateBytes  = local.DeskStateMaxBytes
	maxAnswerBytes = 16 << 10
	// maxSessionBytes is DESK_SESSION_MAX_BYTES (contracts 0.108, CT-664).
	maxSessionBytes = local.DeskSessionMaxBytes
	// maxServerBytes is DESK_SERVER_MAX_BYTES (contracts 0.115): a server's page, and every server's 24 cards, which
	// the contracts don't bound in bytes (the widest is under half of it).
	maxServerBytes = local.DeskServerMaxBytes
	// MaxAudioBytes bounds the spoken answer the page plays (600 characters of speech is well under a minute).
	MaxAudioBytes = 8 << 20
)

// ErrUnavailable: no desk socket, nobody serving it, the wrong peer, or no answer in time.
var ErrUnavailable = errors.New("unavailable")

// Error is the runtime's refusal of a request: its HTTP status and code (§2.3: 409 locked, 403 on_phone, 409 decided,
// 409 busy, 503 voice_unavailable, …). The console server answers the page with the same status and code.
type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string { return fmt.Sprintf("desk: %d %s", e.Status, e.Code) }

// Client talks to the desk socket.
type Client struct {
	socket string
	hc     *http.Client
	now    func() time.Time
	logf   func(format string, args ...any)
	// The timeouts (tests shorten them).
	stateTimeout, callTimeout, talkTimeout                           time.Duration
	hearTimeout                                                      func(seconds float64) time.Duration
	networkTimeout, wifiTimeout                                      time.Duration
	bluetoothStateTimeout, bluetoothTimeout, bluetoothConnectTimeout time.Duration

	mu      sync.Mutex
	cached  *State
	at      time.Time
	fetched bool
	failing string // the last failure logged ("" while it answers)

	// The network answer (network.go) and the Bluetooth one (bluetooth.go), each on its own lock: /api/state asks for
	// all three at once.
	netMu sync.Mutex
	net   netCache
	btMu  sync.Mutex
	bt    btCache
}

// New makes a client for socket, served by peerUID (-1: any peer, tests only). now and logf may be nil.
func New(socket string, peerUID int, now func() time.Time, logf func(format string, args ...any)) *Client {
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	tr := &http.Transport{
		DialContext:            func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx, socket, peerUID) },
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 8 << 10,
	}
	return &Client{socket: socket, hc: &http.Client{Transport: tr}, now: now, logf: logf,
		stateTimeout: StateTimeout, callTimeout: callTimeout, talkTimeout: talkTimeout, hearTimeout: HearTimeout,
		networkTimeout: networkTimeout, wifiTimeout: wifiTimeout,
		bluetoothStateTimeout: bluetoothStateTimeout, bluetoothTimeout: bluetoothTimeout,
		bluetoothConnectTimeout: bluetoothConnectTimeout}
}

// errPeer: the socket is served by another uid than the runtime's.
var errPeer = errors.New("the desk socket isn't the runtime's")

func dial(ctx context.Context, socket string, peerUID int) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil || peerUID < 0 {
		return conn, err
	}
	raw, err := conn.(*net.UnixConn).SyscallConn()
	if err != nil {
		conn.Close()
		return nil, err
	}
	var cred *unix.Ucred
	var cerr error
	if err := raw.Control(func(fd uintptr) { cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) }); err != nil {
		cerr = err
	}
	if cerr != nil || cred == nil || cred.Uid != uint32(peerUID) {
		conn.Close()
		return nil, errPeer
	}
	return conn, nil
}

// State is the runtime's DeskState, checked and cleaned, from a cache of CacheFor; nil when there is no desk socket,
// nobody answers within StateTimeout or the answer isn't a valid DeskState (§2.5: then the page shows the console as
// before).
func (c *Client) State(ctx context.Context) *State {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.fetched && now.Sub(c.at) >= 0 && now.Sub(c.at) < CacheFor {
		return c.cached
	}
	ctx, cancel := context.WithTimeout(ctx, c.stateTimeout)
	defer cancel()
	st, err := c.fetchState(ctx)
	c.cached, c.at, c.fetched = st, now, true
	c.report(err)
	return st
}

// Invalidate drops the cached state: the next State asks the runtime (after a request that changed it).
func (c *Client) Invalidate() {
	c.mu.Lock()
	c.fetched = false
	c.mu.Unlock()
}

// report logs a change between answering and failing once, without the answer's contents.
func (c *Client) report(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
		var ve *validationError
		if errors.As(err, &ve) {
			msg = "the runtime's answer isn't a valid desk state"
		}
	}
	if msg == c.failing {
		return
	}
	// A runtime that is away for a while is one line; the wrong peer and an invalid answer are always worth one.
	switch {
	case msg == "":
		c.logf("desk: the runtime answers on %s", c.socket)
	case c.failing == "" || !errors.Is(err, ErrUnavailable) || errors.Is(err, errPeer):
		c.logf("desk: no desk state (%s)", msg)
	}
	c.failing = msg
}

type validationError struct{ err error }

func (e *validationError) Error() string { return e.err.Error() }

func (c *Client) fetchState(ctx context.Context) (*State, error) {
	body, _, err := c.do(ctx, http.MethodGet, PathState, nil, maxStateBytes)
	if err != nil {
		return nil, err
	}
	st, err := ParseState(body)
	if err != nil {
		return nil, &validationError{err}
	}
	cleanState(st)
	st.RemoteHelp = cleanRemoteHelp(st.RemoteHelp) // remotehelp.go (CG-290)
	return st, nil
}

// do sends one request and returns a 2xx answer's body; a refusal is an *Error, no answer ErrUnavailable.
func (c *Client) do(ctx context.Context, method, path string, req any, limit int64) ([]byte, string, error) {
	var rd io.Reader
	if req != nil {
		b, err := json.Marshal(req)
		if err != nil {
			return nil, "", err
		}
		rd = bytes.NewReader(b)
	}
	hr, err := http.NewRequestWithContext(ctx, method, "http://runtime"+path, rd)
	if err != nil {
		return nil, "", err
	}
	if req != nil {
		hr.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(hr)
	if err != nil {
		inner := errors.Unwrap(err) // the *url.Error's own
		if inner == nil {
			inner = err
		}
		return nil, "", fmt.Errorf("%w: %w", ErrUnavailable, inner)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, "", refusal(resp.StatusCode, body)
	}
	if int64(len(body)) > limit {
		return nil, "", fmt.Errorf("%w: the answer is too large", ErrUnavailable)
	}
	return body, resp.Header.Get("Content-Type"), nil
}

var codeRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// refusal is the runtime's error answer as the page gets it: the status (one the page knows, else 400 or 502) and the
// code from the contract's LocalError (`{"error": {"code", "message"}}`), or from the status when it has none.
func refusal(status int, body []byte) *Error {
	switch {
	case status == 400, status == 403, status == 404, status == 409, status == 413, status == 422, status == 429, status == 503:
	case status/100 == 4:
		status = http.StatusBadRequest
	default:
		status = http.StatusBadGateway
	}
	var le struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &le)
	code := le.Error.Code
	if code == "" {
		code = le.Code
	}
	if !codeRe.MatchString(code) {
		code = map[int]string{400: "bad_request", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large",
			422: "invalid", 429: "too_many", 502: "failed", 503: "unavailable"}[status]
	}
	return &Error{Status: status, Code: code}
}

func post[T any](c *Client, ctx context.Context, path string, req any, timeout time.Duration, parse func([]byte) (*T, error)) (*T, error) {
	return postUpTo(c, ctx, path, req, timeout, maxAnswerBytes, parse)
}

// postUpTo is post reading at most limit bytes of the answer.
func postUpTo[T any](c *Client, ctx context.Context, path string, req any, timeout time.Duration, limit int64,
	parse func([]byte) (*T, error)) (*T, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, _, err := c.do(ctx, http.MethodPost, path, req, limit)
	if err != nil {
		return nil, err
	}
	v, err := parse(body)
	if err != nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "failed"}
	}
	return v, nil
}

// Unlock tries a PIN (DK-04).
func (c *Client) Unlock(ctx context.Context, pin string) (*UnlockAnswer, error) {
	if !pinRe.MatchString(pin) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	defer c.Invalidate()
	return post(c, ctx, PathUnlock, UnlockRequest{V: 1, Pin: pin}, c.callTimeout, local.ParseDeskUnlockAnswer)
}

// Phone asks the paired person's phone to unlock the screen (DK-04).
func (c *Client) Phone(ctx context.Context) (*PhoneAnswer, error) {
	defer c.Invalidate()
	return post(c, ctx, PathPhone, Request{V: 1}, c.callTimeout, local.ParseDeskPhoneUnlockAnswer)
}

// Lock locks the screen at once.
func (c *Client) Lock(ctx context.Context) (*Ack, error) {
	defer c.Invalidate()
	return post(c, ctx, PathLock, Request{V: 1}, c.callTimeout, local.ParseDeskAck)
}

// Touch keeps an unlocked screen unlocked (409 when locked).
func (c *Client) Touch(ctx context.Context) (*TouchAnswer, error) {
	defer c.Invalidate()
	return post(c, ctx, PathTouch, Request{V: 1}, c.callTimeout, local.ParseDeskTouchAnswer)
}

// Decide answers an ask on the screen (DK-05): approve, decline (Not now) or deny (0.108, DK-61); pin, when not nil, is
// the PIN typed again to approve a risky ask (DK-62) or with a wider scope; scope, when not nil, is how far an approve
// reaches (0.116, TF-14: `once`, or one of the ask's choices, `task` or `agent`). The runtime decides whether the screen
// may (403 `not_offered` for a scope the ask doesn't offer the person now). Refused without asking: a scope that isn't
// one, a scope with anything but approve (DeskDecideRequestValid), and a wider scope without the PIN, as 403
// `pin_needed` (DeskDecideNeedsPin: every wider choice needs it, whatever the ask). A runtime from before 0.108 answers
// `{"v":1}`, which is decided (`Result` nil).
func (c *Client) Decide(ctx context.Context, number int64, decision string, pin, scope *string) (*DecideAnswer, error) {
	d := local.DeskDecision(decision)
	req := DecideRequest{V: 1, Number: number, Decision: d, Pin: pin}
	if scope != nil {
		s := local.DeskDecideScope(*scope)
		req.Scope = &s
	}
	if number < 1 || number > 1<<53-1 || !slices.Contains(local.DeskDecisionValues, d) ||
		(pin != nil && !pinRe.MatchString(*pin)) ||
		(req.Scope != nil && !slices.Contains(local.DeskDecideScopeValues, *req.Scope)) ||
		!local.DeskDecideRequestValid(req) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	if pin == nil && local.DeskDecideNeedsPin(false, req) {
		return nil, &Error{Status: http.StatusForbidden, Code: local.DeskErrorPinNeeded}
	}
	defer c.Invalidate()
	return post(c, ctx, PathDecide, req, c.callTimeout, local.ParseDeskDecideAnswer)
}

// FoundDismiss puts Found on your network away for the burrow (0.110, DF-04: Not now). The runtime allows it while
// locked too; the page sends nothing but the request.
func (c *Client) FoundDismiss(ctx context.Context) (*Ack, error) {
	defer c.Invalidate()
	return post(c, ctx, PathFoundDismiss, Request{V: 1}, c.callTimeout, local.ParseDeskAck)
}

// ClaimLetters asks the runtime for new claim letters that stay for a while (Whombat whombat-link.md): the person at
// the box's own screen asked. Before the claim there is no lock or pairing to ask for; the runtime refuses it (409
// not_available) on a box that shows no letters of its own.
func (c *Client) ClaimLetters(ctx context.Context) (*Ack, error) {
	defer c.Invalidate()
	return post(c, ctx, PathClaimLetters, Request{V: 1}, c.callTimeout, local.ParseDeskAck)
}

// Servers is every server of the fleet as the glance's cards (0.115, DK-86): worst first, the first DESK_SERVERS, the
// rest counted; each card cleaned as the glance's.
func (c *Client) Servers(ctx context.Context) (*ServersAnswer, error) {
	a, err := postUpTo(c, ctx, PathServers, Request{V: 1}, c.callTimeout, maxServerBytes, local.ParseDeskServersAnswer)
	if err == nil {
		for i := range a.Servers {
			cleanServer(&a.Servers[i])
		}
	}
	return a, err
}

// Server is a server's own screen (0.115, DK-83) over rng ("1h", "24h", "7d"): an id and a range the socket accepts,
// else 400 without asking; the answer checked (ParseServerPage: consistent, the server asked for) and cleaned.
func (c *Client) Server(ctx context.Context, id, rng string) (*ServerPage, error) {
	r := local.DeskServerRange(rng)
	if !local.ValidDeskServerID(id) || !slices.Contains(local.DeskServerRangeValues, r) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	p, err := postUpTo(c, ctx, PathServer, ServerRequest{V: 1, ID: id, Range: r}, c.callTimeout, maxServerBytes,
		func(b []byte) (*ServerPage, error) { return ParseServerPage(b, id) })
	if err == nil {
		cleanServerPage(p)
	}
	return p, err
}

// TalkSession is the open conversation as the screen shows it (0.108, DK-63): checked (DeskTalkSessionValid) and
// cleaned as the state is.
func (c *Client) TalkSession(ctx context.Context) (*Session, error) {
	s, err := postUpTo(c, ctx, PathTalkSession, Request{V: 1}, c.callTimeout, maxSessionBytes, ParseSession)
	if err == nil {
		cleanSession(s)
	}
	return s, err
}

// TalkClose closes the open conversation (0.108, DK-64): the next question starts a new one.
func (c *Client) TalkClose(ctx context.Context) (*Ack, error) {
	return post(c, ctx, PathTalkClose, Request{V: 1}, c.callTimeout, local.ParseDeskAck)
}

// Talk starts a question to the assistant, typed or spoken (DK-06): exactly one of text and audioWav. server, when not
// nil, is the server whose screen it was asked from (0.115, DK-85).
func (c *Client) Talk(ctx context.Context, text, audioWav *string, cont bool, server *string, spoken bool) (*TalkStarted, error) {
	req, err := TalkRequestFor(text, audioWav, cont, server, spoken)
	if err != nil {
		return nil, err
	}
	defer c.Invalidate()
	return post(c, ctx, PathTalk, req, c.talkTimeout, local.ParseDeskTalkStarted)
}

// TalkGet is a talk's state.
func (c *Client) TalkGet(ctx context.Context, id string) (*Talk, error) {
	if !ValidID(id) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	t, err := post(c, ctx, PathTalkGet, TalkRef{V: 1, ID: id}, c.callTimeout, ParseTalk)
	if err == nil {
		cleanTalk(t)
	}
	return t, err
}

// TalkAudio is the spoken answer (a WAV file the page plays).
func (c *Client) TalkAudio(ctx context.Context, id string) ([]byte, error) {
	if !ValidID(id) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	ctx, cancel := context.WithTimeout(ctx, c.talkTimeout)
	defer cancel()
	body, ct, err := c.do(ctx, http.MethodPost, PathTalkAudio, TalkRef{V: 1, ID: id}, MaxAudioBytes)
	if err != nil {
		return nil, err
	}
	mt, _, _ := strings.Cut(ct, ";")
	if mt = strings.ToLower(strings.TrimSpace(mt)); (mt != "audio/wav" && mt != "audio/x-wav" && mt != "audio/wave") ||
		!isRIFFWave(body) {
		return nil, &Error{Status: http.StatusBadGateway, Code: "failed"}
	}
	return body, nil
}

// A PIN: 4 to 6 ASCII digits (DESK_PIN_RE, DK-26; 6 before 0.103).
var pinRe = regexp.MustCompile(fmt.Sprintf(`^[0-9]{%d,%d}$`, local.DeskPinMin, local.DeskPinMax))

// Talk input bounds (CT-531; 3.3, CG-361): text ≤ 1000 characters, audio 16 kHz mono 16-bit PCM WAV of at most 30 s.
const (
	MaxTalkText    = local.DeskTalkTextMax
	MaxTalkSeconds = local.DeskAudioMaxSeconds
	talkRate       = local.DeskAudioSampleRate
)

// TalkRequestFor checks what the page sent and builds the runtime's request: one line of typed text (cleaned, at most
// MaxTalkText characters) or a base64 WAV the voice service can take, and the server it was asked about when one was
// named (a server id the socket accepts, 0.115, DK-85; anything else is 400: the page sends only the ids it got).
// spoken: the text is what Talk's mic heard (3.3, CG-361), sent only with text and only when true.
func TalkRequestFor(text, audioWav *string, cont bool, server *string, spoken bool) (*TalkRequest, error) {
	bad := &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	req := &TalkRequest{V: 1, Text: text, AudioWav: audioWav, Continue: cont, Server: server}
	if spoken && text != nil {
		req.Spoken = &spoken
	}
	if !local.DeskTalkRequestValid(*req) || (server != nil && !local.ValidDeskServerID(*server)) {
		return nil, bad
	}
	if text != nil {
		t := strings.TrimSpace(strings.Join(strings.Fields(cleanTyped(*text)), " "))
		if t == "" || len([]rune(t)) > MaxTalkText {
			return nil, bad
		}
		req.Text = &t
		if req.Validate() != nil {
			return nil, bad
		}
		return req, nil
	}
	wav, err := base64.StdEncoding.DecodeString(*audioWav)
	if err != nil {
		return nil, bad
	}
	if err := CheckTalkWav(wav); err != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadAudio}
	}
	if req.Validate() != nil {
		return nil, bad
	}
	return req, nil
}

// cleanTyped keeps typed text to printable characters (line breaks become spaces).
func cleanTyped(s string) string {
	return line(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s), 4*MaxTalkText)
}

// CheckTalkWav checks a recording: RIFF/WAVE, PCM, one channel, 16 kHz, 16 bits, at most MaxTalkSeconds, not empty.
func CheckTalkWav(b []byte) error {
	return checkWav(b, MaxTalkSeconds)
}

// checkWav checks a recording of at most maxSeconds: RIFF/WAVE, PCM, one channel, 16 kHz, 16 bits, not empty.
func checkWav(b []byte, maxSeconds int) error {
	maxData := maxSeconds * talkRate * 2
	if !isRIFFWave(b) {
		return errors.New("not a WAV file")
	}
	if len(b) > 44+maxData+1024 {
		return errors.New("too long")
	}
	var fmtOK, dataOK bool
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(binary.LittleEndian.Uint32(b[p+4:p+8]))
		body := p + 8
		if size < 0 || body+size > len(b) {
			// A recorder that streams may leave the data chunk's size too large or 0xFFFFFFFF: what is there counts.
			if id != "data" {
				return errors.New("a chunk runs past the end")
			}
			size = len(b) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return errors.New("short fmt chunk")
			}
			f := b[body : body+16]
			format, channels := binary.LittleEndian.Uint16(f[0:]), binary.LittleEndian.Uint16(f[2:])
			rate, bits := binary.LittleEndian.Uint32(f[4:]), binary.LittleEndian.Uint16(f[14:])
			if format != 1 || channels != 1 || rate != talkRate || bits != 16 {
				return errors.New("not 16 kHz mono 16-bit PCM")
			}
			fmtOK = true
		case "data":
			if !fmtOK {
				return errors.New("data before fmt")
			}
			if size == 0 || size > maxData {
				return errors.New("empty or too long")
			}
			dataOK = true
		}
		p = body + size + size%2
	}
	if !fmtOK || !dataOK {
		return errors.New("no fmt or data chunk")
	}
	return nil
}

func isRIFFWave(b []byte) bool {
	return len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WAVE"
}
