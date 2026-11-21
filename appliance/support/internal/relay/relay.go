// Package relay is the support service's relay worker (Whombat RH-06): while a grant is active the box dials the relay
// as the appliance for its support route, exactly like the runtime does for its app route (relay protocol v1, MA-05;
// `packages/protocol/src/relay.ts` and `admission.ts` in the contracts, the relay's `internal/relay/server.go`):
//
//   - one control connection: `hello` with the support route's appliance ticket, no session, class `interactive`; the
//     relay answers `welcome`, then announces each support client with `incoming{session, class}`; `drain` or a close
//     makes it reconnect after the relay's delay or a jittered backoff, with a fresh ticket after 4401 and 4421;
//   - one data connection per `incoming`: `hello{session}` with the same ticket while it is unexpired, `welcome`, then
//     `ready`, after which only binary messages flow; the connection becomes a net.Conn for the SSH server. At the
//     session limit the box answers `refuse{session}` instead (the client gets 4429).
//
// The relay only sees tickets and opaque bytes (SSH runs end to end inside them); nothing here decides who gets in.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Ticket is an appliance admission ticket for the support route with the relay worker it names.
type Ticket struct {
	Token     string    // compact JWS
	ExpiresAt time.Time // the ticket's exp
	URL       string    // the worker's URL (`wss://…`; `/v1/connect` is added when it names only the host)
	Worker    string    // the worker id (`wrk`)
}

// TicketSource hands out tickets (the manager's `POST /v1/support/ticket`).
type TicketSource interface {
	Ticket(ctx context.Context) (Ticket, error)
}

// Defaults.
const (
	// MaxSessions is how many support sessions may be open at once; the next one is refused.
	MaxSessions = 8
	// TicketMargin: a ticket is replaced this long before it expires.
	TicketMargin = 60 * time.Second
	// MaxMessage is the largest binary message either way (RELAY_MAX_MESSAGE_BYTES).
	MaxMessage = protocol.RelayMaxMessageBytes
	// maxText bounds text messages before `ready` (RELAY_MAX_TEXT_MESSAGE_BYTES).
	maxText = protocol.RelayMaxTextMessageBytes
)

// Options tune Run; the zero value is the production setting.
type Options struct {
	MaxSessions  int                                   // default MaxSessions
	TicketMargin time.Duration                         // default TicketMargin
	MinRefresh   time.Duration                         // shortest wait between ticket refreshes (default 5 s)
	HelloTimeout time.Duration                         // welcome and ready must arrive within this (default 10 s)
	WriteTimeout time.Duration                         // one message write (default 30 s)
	Now          func() time.Time                      // default time.Now
	After        func(time.Duration) <-chan time.Time  // waits between attempts (default time.After)
	Backoff      func(attempt int) time.Duration       // default full-jitter exponential, 500 ms … 30 s
	Jitter       func(max time.Duration) time.Duration // added to a drain's delay (default uniform in [0, max))
	Dialer       *websocket.Dialer                     // default: 10 s handshake, no proxy, no compression
	Logf         func(format string, args ...any)
}

func (o *Options) fill() {
	if o.MaxSessions <= 0 {
		o.MaxSessions = MaxSessions
	}
	if o.TicketMargin <= 0 {
		o.TicketMargin = TicketMargin
	}
	if o.MinRefresh <= 0 {
		o.MinRefresh = 5 * time.Second
	}
	if o.HelloTimeout <= 0 {
		o.HelloTimeout = 10 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 30 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.After == nil {
		o.After = time.After
	}
	if o.Backoff == nil {
		o.Backoff = func(attempt int) time.Duration {
			return BackoffDelay(attempt, 500*time.Millisecond, 30*time.Second, rand.Float64)
		}
	}
	if o.Jitter == nil {
		o.Jitter = func(max time.Duration) time.Duration {
			if max <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(max)))
		}
	}
	if o.Dialer == nil {
		o.Dialer = &websocket.Dialer{
			HandshakeTimeout:  10 * time.Second,
			Subprotocols:      []string{protocol.RelaySubprotocol},
			EnableCompression: false,
			ReadBufferSize:    16 * 1024,
			WriteBufferSize:   16 * 1024,
		}
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
}

// BackoffDelay is full-jitter exponential backoff (the runtime's relay client): uniform in [0, min(max, base·2^attempt)).
func BackoffDelay(attempt int, base, max time.Duration, random func() float64) time.Duration {
	ceiling := max
	if attempt < 30 {
		if c := base << attempt; c > 0 && c < max {
			ceiling = c
		}
	}
	return time.Duration(random() * float64(ceiling))
}

// Run keeps the support route's control connection up and hands every spliced session to serve (in its own
// goroutine; serve owns the connection and must return once it is closed). It returns ctx.Err() once ctx ends, after
// closing the control connection and every session and waiting for serve to return; it never returns before.
func Run(ctx context.Context, src TicketSource, serve func(net.Conn)) error {
	return RunWith(ctx, src, serve, Options{})
}

// RunWith is Run with options.
func RunWith(ctx context.Context, src TicketSource, serve func(net.Conn), opt Options) error {
	opt.fill()
	w := &worker{opt: opt, src: src, serve: serve}
	attempt := 0
	for ctx.Err() == nil {
		res := w.control(ctx)
		if res.welcomed {
			attempt = 0
		}
		if res.dropTicket {
			w.forget()
		}
		var delay time.Duration
		switch {
		case res.moved:
			delay = 0
		case res.drain != nil:
			delay = *res.drain + opt.Jitter(time.Second)
		default:
			delay = opt.Backoff(attempt)
			attempt++
		}
		if ctx.Err() != nil {
			break
		}
		if delay > 0 {
			select {
			case <-ctx.Done():
			case <-opt.After(delay):
			}
		}
	}
	w.wg.Wait()
	return ctx.Err()
}

type worker struct {
	opt   Options
	src   TicketSource
	serve func(net.Conn)
	wg    sync.WaitGroup // data connections

	mu       sync.Mutex
	cur      Ticket // the newest ticket; zero when none
	sessions int
}

// result is how one control connection ended.
type result struct {
	welcomed   bool           // the relay admitted it
	dropTicket bool           // the relay refused the ticket (4401, 4421): get a fresh one
	drain      *time.Duration // the relay is draining: reconnect after this
	moved      bool           // a fresh ticket names another worker: reconnect there at once
}

func (w *worker) logf(format string, args ...any) {
	w.opt.Logf("whombat-support: relay: "+format, args...)
}

// current is the newest ticket when it is still good for a hello (unexpired); ok false otherwise.
func (w *worker) current() (Ticket, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	t := w.cur
	return t, t.Token != "" && w.opt.Now().Before(t.ExpiresAt)
}

func (w *worker) forget() {
	w.mu.Lock()
	w.cur = Ticket{}
	w.mu.Unlock()
}

// ticket answers the newest ticket while it is more than the margin away from expiring, else fetches one.
func (w *worker) ticket(ctx context.Context) (Ticket, error) {
	w.mu.Lock()
	t := w.cur
	w.mu.Unlock()
	if t.Token != "" && w.opt.Now().Add(w.opt.TicketMargin).Before(t.ExpiresAt) {
		return t, nil
	}
	return w.fetch(ctx)
}

// fetch asks the source for a ticket and keeps it.
func (w *worker) fetch(ctx context.Context) (Ticket, error) {
	fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	t, err := w.src.Ticket(fctx)
	if err != nil {
		return Ticket{}, err
	}
	if err := checkTicket(t, w.opt.Now()); err != nil {
		return Ticket{}, err
	}
	w.mu.Lock()
	w.cur = t
	w.mu.Unlock()
	return t, nil
}

func checkTicket(t Ticket, now time.Time) error {
	if t.Token == "" || len(t.Token) > protocol.RelayMaxTicketBytes {
		return errors.New("the ticket is empty or too long")
	}
	if !now.Before(t.ExpiresAt) {
		return errors.New("the ticket has expired")
	}
	if t.Worker == "" {
		return errors.New("the ticket names no worker")
	}
	if _, err := connectURL(t.URL); err != nil {
		return err
	}
	return nil
}

// connectURL is the ticket's URL, with /v1/connect when it names only the host; ws or wss only.
func connectURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "ws") || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("the relay URL %q isn't a ws(s) URL", raw)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = protocol.RelayPath
	}
	u.Fragment = ""
	return u.String(), nil
}

func (w *worker) dial(ctx context.Context, t Ticket) (*websocket.Conn, error) {
	u, err := connectURL(t.URL)
	if err != nil {
		return nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, w.opt.HelloTimeout)
	defer cancel()
	ws, resp, err := w.opt.Dialer.DialContext(dctx, u, http.Header{})
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	if ws.Subprotocol() != protocol.RelaySubprotocol {
		ws.Close()
		return nil, errors.New("the relay didn't agree on the subprotocol")
	}
	return ws, nil
}

func hello(ws *websocket.Conn, t Ticket, class, session string, timeout time.Duration) error {
	h := protocol.RelayHello{T: "hello", V: protocol.RelayProtocolVersion, Ticket: t.Token, Class: protocol.RelayStreamClass(class)}
	if session != "" {
		h.Session = &session
	}
	if err := h.Validate(); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	b, _ := json.Marshal(h)
	_ = ws.SetWriteDeadline(time.Now().Add(timeout))
	return ws.WriteMessage(websocket.TextMessage, b)
}

// readText reads one text message from the relay (bounded) and parses it; binary or anything malformed is an error.
func readText(ws *websocket.Conn) (protocol.RelayDownstreamMessage, error) {
	mt, r, err := ws.NextReader()
	if err != nil {
		return nil, err
	}
	if mt != websocket.TextMessage {
		return nil, errProtocol("a binary message before ready")
	}
	b, err := io.ReadAll(io.LimitReader(r, maxText+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxText {
		return nil, errProtocol("a text message too large")
	}
	m, err := protocol.ParseRelayDownstreamMessage(b)
	if err != nil {
		return nil, errProtocol("a message that isn't the protocol's")
	}
	return m, nil
}

type errProtocol string

func (e errProtocol) Error() string { return string(e) }

// closeWith sends a close frame and closes the socket.
func closeWith(ws *websocket.Conn, code int, reason string) {
	_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	_ = ws.Close()
}

// idleFor is how long a connection may stay silent: three of the relay's heartbeats (pings count), 10 s … 180 s.
func idleFor(heartbeatMs int64) time.Duration {
	d := 3 * time.Duration(heartbeatMs) * time.Millisecond
	return min(max(d, 10*time.Second), 180*time.Second)
}

// keepAlive answers the relay's pings and pushes the read deadline on with every ping.
func keepAlive(ws *websocket.Conn, idle time.Duration) {
	ws.SetPingHandler(func(data string) error {
		_ = ws.SetReadDeadline(time.Now().Add(idle))
		err := ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
		var ne net.Error
		if err == websocket.ErrCloseSent || errors.As(err, &ne) && ne.Timeout() {
			return nil
		}
		return err
	})
}

// control runs one control connection until it ends.
func (w *worker) control(ctx context.Context) (res result) {
	t, err := w.ticket(ctx)
	if err != nil {
		if ctx.Err() == nil {
			w.logf("no ticket: %v", err)
		}
		return res
	}
	ws, err := w.dial(ctx, t)
	if err != nil {
		if ctx.Err() == nil {
			w.logf("can't reach the relay: %v", err)
		}
		return res
	}
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(cctx, func() { closeWith(ws, websocket.CloseNormalClosure, "") })
	defer stop()
	defer ws.Close()

	ws.SetReadLimit(maxText)
	if err := hello(ws, t, string(protocol.RelayClassInteractive), "", w.opt.HelloTimeout); err != nil {
		w.logf("control hello: %v", err)
		return res
	}
	_ = ws.SetReadDeadline(time.Now().Add(w.opt.HelloTimeout))
	m, err := readText(ws)
	if err != nil {
		return w.closed(ws, err, res)
	}
	welcome, ok := m.(*protocol.RelayWelcome)
	if !ok {
		closeWith(ws, protocol.RelayCloseBadHello, "expected welcome")
		return res
	}
	res.welcomed = true
	idle := idleFor(welcome.HeartbeatMs)
	keepAlive(ws, idle)
	w.logf("connected to worker %s", t.Worker)

	// Keep a fresh ticket for data connections; one for another worker moves the control connection there.
	moved := make(chan struct{})
	var refreshing sync.WaitGroup
	refreshing.Add(1)
	go func() {
		defer refreshing.Done()
		w.refresh(cctx, t, moved, func() { closeWith(ws, websocket.CloseNormalClosure, "moving") })
	}()
	defer func() {
		cancel()
		refreshing.Wait()
	}()

	for {
		_ = ws.SetReadDeadline(time.Now().Add(idle))
		m, err := readText(ws)
		if err != nil {
			select {
			case <-moved:
				res.moved = true
				return res
			default:
			}
			return w.closed(ws, err, res)
		}
		switch m := m.(type) {
		case *protocol.RelayIncoming:
			w.incoming(cctx, ws, m, t)
		case *protocol.RelayDrain:
			d := time.Duration(m.RetryAfterMs) * time.Millisecond
			res.drain = &d
			w.logf("worker %s is draining", t.Worker)
			closeWith(ws, websocket.CloseNormalClosure, "relay draining")
			return res
		default:
			closeWith(ws, protocol.RelayCloseBadHello, "unexpected message")
			return res
		}
	}
}

// closed reads how the relay closed the control connection.
func (w *worker) closed(ws *websocket.Conn, err error, res result) result {
	var ce *websocket.CloseError
	var pe errProtocol
	switch {
	case errors.As(err, &ce):
		switch ce.Code {
		case protocol.RelayCloseBadTicket, protocol.RelayCloseWrongWorker:
			res.dropTicket = true
		case protocol.RelayCloseDraining:
			var reason protocol.RelayDrainReason
			if r, perr := protocol.ParseRelayDrainReason([]byte(ce.Text)); perr == nil {
				reason = *r
				d := time.Duration(reason.RetryAfterMs) * time.Millisecond
				res.drain = &d
			}
		}
		w.logf("the relay closed the control connection (%d)", ce.Code)
	case errors.As(err, &pe):
		closeWith(ws, protocol.RelayCloseBadHello, string(pe))
		w.logf("control connection: %v", pe)
	default:
		w.logf("control connection: %v", err)
	}
	return res
}

// refresh replaces the ticket the margin before it expires (or MinRefresh after the last try). A ticket for another
// worker or URL closes the control connection so the next one goes there.
func (w *worker) refresh(ctx context.Context, used Ticket, moved chan struct{}, closeControl func()) {
	for {
		w.mu.Lock()
		cur := w.cur
		w.mu.Unlock()
		if cur.Token == "" {
			cur = used
		}
		wait := max(cur.ExpiresAt.Sub(w.opt.Now())-w.opt.TicketMargin, w.opt.MinRefresh)
		select {
		case <-ctx.Done():
			return
		case <-w.opt.After(wait):
		}
		t, err := w.fetch(ctx)
		if err != nil {
			if ctx.Err() == nil {
				w.logf("can't refresh the ticket: %v", err)
			}
			continue
		}
		if t.Worker != used.Worker || t.URL != used.URL {
			w.logf("moving to worker %s", t.Worker)
			close(moved)
			closeControl()
			return
		}
	}
}

// incoming opens a data connection for the session, or refuses it at the limit or without a good ticket for this
// control connection's worker.
func (w *worker) incoming(ctx context.Context, ctl *websocket.Conn, in *protocol.RelayIncoming, used Ticket) {
	t, ok := w.current()
	if ok && (t.Worker != used.Worker || t.URL != used.URL) {
		ok = false
	}
	if ok {
		w.mu.Lock()
		if w.sessions >= w.opt.MaxSessions {
			ok = false
		} else {
			w.sessions++
		}
		w.mu.Unlock()
	}
	if !ok {
		b, _ := json.Marshal(protocol.RelayRefuse{T: "refuse", Session: in.Session})
		_ = ctl.SetWriteDeadline(time.Now().Add(w.opt.WriteTimeout))
		if err := ctl.WriteMessage(websocket.TextMessage, b); err != nil {
			w.logf("refuse: %v", err)
		}
		return
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		defer func() {
			w.mu.Lock()
			w.sessions--
			w.mu.Unlock()
		}()
		w.data(ctx, t, in.Session, string(in.Class))
	}()
}

// data joins one session and serves it until either side closes it or ctx ends.
func (w *worker) data(ctx context.Context, t Ticket, session, class string) {
	ws, err := w.dial(ctx, t)
	if err != nil {
		if ctx.Err() == nil {
			w.logf("data connection: %v", err)
		}
		return
	}
	c := newConn(ws, w.opt.WriteTimeout)
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	defer c.Close()

	ws.SetReadLimit(maxText)
	if err := hello(ws, t, class, session, w.opt.HelloTimeout); err != nil {
		w.logf("data hello: %v", err)
		return
	}
	_ = ws.SetReadDeadline(time.Now().Add(w.opt.HelloTimeout))
	var welcome *protocol.RelayWelcome
	for {
		m, err := readText(ws)
		if err != nil {
			var pe errProtocol
			if errors.As(err, &pe) {
				closeWith(ws, protocol.RelayCloseBadHello, string(pe))
			}
			if ctx.Err() == nil {
				w.logf("data connection: %v", err)
			}
			return
		}
		switch m := m.(type) {
		case *protocol.RelayWelcome:
			if welcome != nil {
				closeWith(ws, protocol.RelayCloseBadHello, "a second welcome")
				return
			}
			welcome = m
			continue
		case *protocol.RelayReady:
			if welcome == nil {
				closeWith(ws, protocol.RelayCloseBadHello, "ready before welcome")
				return
			}
		default:
			closeWith(ws, protocol.RelayCloseBadHello, "unexpected message")
			return
		}
		break
	}
	c.start(min(int64(MaxMessage), welcome.MaxMessage), idleFor(welcome.HeartbeatMs))
	w.serve(c)
}
