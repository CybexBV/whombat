// Package relaytest is an in-process relay worker for tests, following the relay's internal/relay/server.go for
// what an appliance sees: the subprotocol, `hello` within a deadline, tickets checked (unknown 4401, another worker's
// 4421), `welcome`, `incoming` on the control connection, a newer control connection superseding the old one (4409),
// `refuse` ending the waiting client with 4429, `welcome` then `ready` on the data connection, binary messages spliced
// to the client, pings, `drain`. Tickets are opaque tokens the test allows; clients are plain loopback TCP connections.
package relaytest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Relay is one fake relay worker.
type Relay struct {
	URL         string // ws://127.0.0.1:port, without the path (the worker adds /v1/connect)
	Worker      string
	HeartbeatMs int64
	MaxMessage  int64

	srv *httptest.Server

	mu       sync.Mutex
	tickets  map[string]string // token → worker
	control  *wsw
	ctlUp    chan struct{} // closed when a control connection is welcomed; replaced when it goes
	pending  map[string]*session
	lastData *wsw
	next     int

	// HoldReady, when set before a session opens, delays its `ready` until it is closed.
	HoldReady chan struct{}

	Hellos       chan protocol.RelayHello // every hello, in order
	Refused      chan string              // sessions the appliance refused
	EarlyBinary  atomic.Bool              // the appliance sent binary before ready
	sizesMu      sync.Mutex
	messageSizes []int // binary messages from the appliance
}

type wsw struct {
	ws  *websocket.Conn
	wmu sync.Mutex
}

func (w *wsw) text(b []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	_ = w.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return w.ws.WriteMessage(websocket.TextMessage, b)
}

func (w *wsw) binary(b []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	_ = w.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return w.ws.WriteMessage(websocket.BinaryMessage, b)
}

func (w *wsw) close(code int, reason string) {
	_ = w.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	time.AfterFunc(time.Second, func() { w.ws.Close() })
}

type session struct {
	id     string
	class  string
	joined chan *data
	ended  chan int // close code when the session ends before joining
}

// data is a joined appliance data connection: its binary messages arrive on in (closed when it ends).
type data struct {
	*wsw
	in chan []byte
}

// New starts a fake worker.
func New(worker string) *Relay {
	r := &Relay{
		Worker: worker, HeartbeatMs: 20000, MaxMessage: protocol.RelayMaxMessageBytes,
		tickets: map[string]string{}, pending: map[string]*session{}, ctlUp: make(chan struct{}),
		Hellos: make(chan protocol.RelayHello, 256), Refused: make(chan string, 64),
	}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	r.URL = "ws" + strings.TrimPrefix(r.srv.URL, "http")
	return r
}

// Close stops the worker and every connection.
func (r *Relay) Close() {
	r.srv.CloseClientConnections()
	r.srv.Close()
}

// Allow admits token as a ticket for worker.
func (r *Relay) Allow(token, worker string) {
	r.mu.Lock()
	r.tickets[token] = worker
	r.mu.Unlock()
}

// Token makes a token shaped like a compact JWS.
func Token(name string) string {
	return "eyJhbGciOiJFZERTQSJ9." + name + "-payload-0123456789.c2lnbmF0dXJl"
}

// MessageSizes are the sizes of the binary messages the appliance sent so far.
func (r *Relay) MessageSizes() []int {
	r.sizesMu.Lock()
	defer r.sizesMu.Unlock()
	return append([]int(nil), r.messageSizes...)
}

// WaitControl waits for a welcomed control connection.
func (r *Relay) WaitControl(ctx context.Context) error {
	for {
		r.mu.Lock()
		up, ctl := r.ctlUp, r.control
		r.mu.Unlock()
		if ctl != nil {
			return nil
		}
		select {
		case <-up:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// WaitNoControl waits until no control connection is up.
func (r *Relay) WaitNoControl(ctx context.Context) error {
	for {
		r.mu.Lock()
		ctl := r.control
		r.mu.Unlock()
		if ctl == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// Drain tells the control connection the worker is draining.
func (r *Relay) Drain(retryAfterMs int64) error {
	r.mu.Lock()
	ctl := r.control
	r.mu.Unlock()
	if ctl == nil {
		return errors.New("no control connection")
	}
	b, _ := json.Marshal(protocol.RelayDrain{T: "drain", RetryAfterMs: retryAfterMs})
	return ctl.text(b)
}

// CloseControl closes the control connection with code.
func (r *Relay) CloseControl(code int, reason string) {
	r.mu.Lock()
	ctl := r.control
	r.mu.Unlock()
	if ctl != nil {
		ctl.close(code, reason)
	}
}

// PingData pings the newest data connection and waits for its pong.
func (r *Relay) PingData(ctx context.Context) error {
	r.mu.Lock()
	d := r.lastData
	r.mu.Unlock()
	if d == nil {
		return errors.New("no data connection")
	}
	got := make(chan struct{}, 1)
	d.ws.SetPongHandler(func(string) error {
		select {
		case got <- struct{}{}:
		default:
		}
		return nil
	})
	if err := d.ws.WriteControl(websocket.PingMessage, []byte("hb"), time.Now().Add(time.Second)); err != nil {
		return err
	}
	select {
	case <-got:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Open is a support client: it asks the appliance for a session and, once spliced, answers the client's end.
// A refused session fails with an error naming 4429.
func (r *Relay) Open(ctx context.Context, class string) (net.Conn, error) {
	r.mu.Lock()
	ctl := r.control
	r.next++
	s := &session{id: fmt.Sprintf("session-%08d", r.next), class: class, joined: make(chan *data, 1), ended: make(chan int, 1)}
	if ctl != nil {
		r.pending[s.id] = s
	}
	r.mu.Unlock()
	if ctl == nil {
		return nil, errors.New("4404 appliance offline")
	}
	b, _ := json.Marshal(protocol.RelayIncoming{T: "incoming", Session: s.id, Class: protocol.RelayStreamClass(class)})
	if err := ctl.text(b); err != nil {
		return nil, err
	}
	var d *data
	select {
	case d = <-s.joined:
	case code := <-s.ended:
		return nil, fmt.Errorf("%d session ended", code)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	// The client's end: a loopback TCP pair, so both directions buffer like the real thing.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		return nil, err
	}
	near, err := ln.Accept()
	if err != nil {
		client.Close()
		return nil, err
	}
	go func() { // appliance → client
		defer near.Close()
		for b := range d.in {
			if _, err := near.Write(b); err != nil {
				d.close(websocket.CloseGoingAway, "")
				return
			}
		}
	}()
	go func() { // client → appliance
		buf := make([]byte, 32*1024)
		for {
			n, err := near.Read(buf)
			if n > 0 {
				if d.binary(buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				d.close(websocket.CloseNormalClosure, "")
				return
			}
		}
	}()
	return client, nil
}

func (r *Relay) serve(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != protocol.RelayPath {
		http.NotFound(w, req)
		return
	}
	up := websocket.Upgrader{Subprotocols: []string{protocol.RelaySubprotocol}, CheckOrigin: func(*http.Request) bool { return true }}
	ws, err := up.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c := &wsw{ws: ws}
	if ws.Subprotocol() != protocol.RelaySubprotocol {
		c.close(protocol.RelayCloseBadHello, "subprotocol")
		return
	}
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	mt, b, err := ws.ReadMessage()
	if err != nil || mt != websocket.TextMessage || len(b) > protocol.RelayMaxTextMessageBytes {
		c.close(protocol.RelayCloseBadHello, "bad hello")
		return
	}
	h, err := protocol.ParseRelayHello(b)
	if err != nil {
		c.close(protocol.RelayCloseBadHello, "bad hello")
		return
	}
	r.Hellos <- *h
	r.mu.Lock()
	worker, ok := r.tickets[h.Ticket]
	r.mu.Unlock()
	switch {
	case !ok:
		c.close(protocol.RelayCloseBadTicket, "bad_signature")
		return
	case worker != r.Worker:
		c.close(protocol.RelayCloseWrongWorker, "wrong_worker")
		return
	}
	_ = ws.SetReadDeadline(time.Time{})
	if h.Session == nil {
		r.handleControl(c)
	} else {
		r.handleData(c, h)
	}
}

func (r *Relay) welcome(c *wsw) error {
	b, _ := json.Marshal(protocol.RelayWelcome{T: "welcome", V: 1, Conn: "conn-" + strconv.Itoa(int(time.Now().UnixNano()%1e8)),
		HeartbeatMs: r.HeartbeatMs, MaxMessage: r.MaxMessage})
	return c.text(b)
}

func (r *Relay) handleControl(c *wsw) {
	if err := r.welcome(c); err != nil {
		return
	}
	r.mu.Lock()
	old := r.control
	r.control = c
	close(r.ctlUp)
	r.ctlUp = make(chan struct{})
	r.mu.Unlock()
	if old != nil {
		old.close(protocol.RelayCloseReplayedTicket, "superseded")
	}
	defer func() {
		r.mu.Lock()
		if r.control == c {
			r.control = nil
		}
		r.mu.Unlock()
		c.ws.Close()
	}()
	for {
		mt, b, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.TextMessage {
			c.close(protocol.RelayCloseBadHello, "protocol error")
			return
		}
		m, err := protocol.ParseRelayUpstreamMessage(b)
		ref, ok := m.(*protocol.RelayRefuse)
		if err != nil || !ok {
			c.close(protocol.RelayCloseBadHello, "protocol error")
			return
		}
		r.mu.Lock()
		s := r.pending[ref.Session]
		delete(r.pending, ref.Session)
		r.mu.Unlock()
		if s != nil {
			r.Refused <- ref.Session
			s.ended <- protocol.RelayCloseRateLimited
		}
	}
}

func (r *Relay) handleData(c *wsw, h *protocol.RelayHello) {
	r.mu.Lock()
	s := r.pending[*h.Session]
	switch {
	case s == nil:
		r.mu.Unlock()
		c.close(protocol.RelayCloseApplianceOffline, "unknown session")
		return
	case string(h.Class) != s.class:
		r.mu.Unlock()
		c.close(protocol.RelayCloseBadHello, "class")
		return
	}
	delete(r.pending, s.id)
	r.lastData = c
	hold := r.HoldReady
	r.mu.Unlock()
	// One reader for the connection's life: anything binary before ready breaks the protocol.
	var ready atomic.Bool
	in := make(chan []byte, 256)
	c.ws.SetReadLimit(r.MaxMessage)
	go func() {
		defer close(in)
		for {
			mt, b, err := c.ws.ReadMessage()
			if err != nil {
				return
			}
			if mt != websocket.BinaryMessage {
				c.close(protocol.RelayCloseBadHello, "protocol error")
				return
			}
			if !ready.Load() {
				r.EarlyBinary.Store(true)
			}
			r.sizesMu.Lock()
			r.messageSizes = append(r.messageSizes, len(b))
			r.sizesMu.Unlock()
			in <- b
		}
	}()
	if err := r.welcome(c); err != nil {
		return
	}
	if hold != nil {
		<-hold
	}
	ready.Store(true)
	if err := c.text([]byte(`{"t":"ready"}`)); err != nil {
		return
	}
	s.joined <- &data{wsw: c, in: in}
}
