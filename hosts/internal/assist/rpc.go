// Package assist runs the assistant's AI command-line tools (Claude Code,
// Codex) for the hub: it installs and updates them, signs them in, runs
// investigations as CLI sessions and serves them Rackoon's tools over MCP,
// relaying every tool call to the hub (docs/ASSIST.md).
//
// The hub talks to the runner over one connection (a Unix socket from
// systemd, or a child process's pipes) with Peer, a small JSON-RPC peer
// that also speaks to Codex's app-server and to the CLIs' MCP clients.
package assist

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
)

// MaxMessage bounds one JSON-RPC message (tool output is bounded well
// below this by the hub).
const MaxMessage = 16 << 20

// RPCError is a JSON-RPC error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return e.Message }

// Standard and Rackoon error codes.
const (
	ErrMethodNotFound = -32601
	ErrInvalidParams  = -32602
	ErrInternal       = -32603
	// ErrApp carries an application error with a code string in Data.
	ErrApp = -32000
)

// AppError is an error with a stable code for the hub ("not_installed",
// "signed_out", ...). It crosses the connection as an RPCError.
type AppError struct {
	Code    string
	Message string
}

func (e *AppError) Error() string { return e.Message }

// Errf returns an AppError.
func Errf(code, format string, args ...any) error {
	return &AppError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrorCode returns the code of an AppError (also one that crossed the
// connection), or "".
func ErrorCode(err error) string {
	var ae *AppError
	if errors.As(err, &ae) {
		return ae.Code
	}
	var re *RPCError
	if errors.As(err, &re) && re.Code == ErrApp {
		var code string
		_ = json.Unmarshal(re.Data, &code)
		return code
	}
	return ""
}

type message struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Handler answers the other side's requests. It runs on its own goroutine
// per request; ctx ends when the peer closes.
type Handler func(ctx context.Context, method string, params json.RawMessage) (any, error)

// NotifyHandler receives notifications, in order, on the read loop: it
// must not block for long.
type NotifyHandler func(method string, params json.RawMessage)

// Peer is one side of a newline-delimited JSON-RPC connection. Both sides
// may send requests and notifications.
type Peer struct {
	// V2 adds "jsonrpc": "2.0" to every message (MCP); Codex's app-server
	// and the hub link leave it out.
	V2 bool

	rw       io.ReadWriteCloser
	wmu      sync.Mutex
	w        *bufio.Writer
	next     atomic.Int64
	mu       sync.Mutex
	pending  map[string]chan message
	handle   Handler
	notify   NotifyHandler
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	err      error
	inflight sync.WaitGroup
}

// NewPeer wraps rw. Start must be called to begin reading.
func NewPeer(rw io.ReadWriteCloser, handle Handler, notify NotifyHandler) *Peer {
	ctx, cancel := context.WithCancel(context.Background())
	return &Peer{rw: rw, w: bufio.NewWriter(rw), pending: map[string]chan message{}, handle: handle, notify: notify,
		ctx: ctx, cancel: cancel, done: make(chan struct{})}
}

// Start reads messages until the connection ends.
func (p *Peer) Start() { go p.readLoop() }

// Done is closed when the connection ended; Err tells why.
func (p *Peer) Done() <-chan struct{} { return p.done }

// Err is the reason the peer stopped (after Done).
func (p *Peer) Err() error { return p.err }

// Close ends the connection; pending calls fail.
func (p *Peer) Close() error {
	p.cancel()
	return p.rw.Close()
}

func (p *Peer) readLoop() {
	sc := bufio.NewScanner(p.rw)
	sc.Buffer(make([]byte, 64<<10), MaxMessage)
	var err error
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var m message
		if e := json.Unmarshal(line, &m); e != nil {
			continue // not JSON-RPC (a CLI's stray output line)
		}
		switch {
		case m.Method != "" && len(m.ID) > 0:
			p.inflight.Add(1)
			go p.serve(m)
		case m.Method != "":
			if p.notify != nil {
				p.notify(m.Method, m.Params)
			}
		case len(m.ID) > 0:
			p.mu.Lock()
			ch := p.pending[string(m.ID)]
			delete(p.pending, string(m.ID))
			p.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}
	err = sc.Err()
	if err == nil {
		err = io.EOF
	}
	p.err = err
	p.cancel()
	p.rw.Close()
	p.mu.Lock()
	for id, ch := range p.pending {
		delete(p.pending, id)
		close(ch)
	}
	p.mu.Unlock()
	p.inflight.Wait()
	close(p.done)
}

func (p *Peer) serve(m message) {
	defer p.inflight.Done()
	var res any
	err := (*RPCError)(nil)
	if p.handle == nil {
		err = &RPCError{Code: ErrMethodNotFound, Message: "method not found: " + m.Method}
	} else if r, e := p.handle(p.ctx, m.Method, m.Params); e != nil {
		err = toRPCError(e)
	} else {
		res = r
	}
	out := message{ID: m.ID}
	if err != nil {
		out.Error = err
	} else {
		b, e := json.Marshal(res)
		if e != nil {
			out.Error = &RPCError{Code: ErrInternal, Message: e.Error()}
		} else {
			out.Result = b
		}
	}
	_ = p.write(out)
}

func toRPCError(err error) *RPCError {
	var re *RPCError
	if errors.As(err, &re) {
		return re
	}
	var ae *AppError
	if errors.As(err, &ae) {
		code, _ := json.Marshal(ae.Code)
		return &RPCError{Code: ErrApp, Message: ae.Message, Data: code}
	}
	return &RPCError{Code: ErrInternal, Message: err.Error()}
}

func (p *Peer) write(m message) error {
	if p.V2 {
		m.JSONRPC = "2.0"
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if _, err := p.w.Write(append(b, '\n')); err != nil {
		return err
	}
	return p.w.Flush()
}

// ErrClosed is returned by calls on a closed peer.
var ErrClosed = errors.New("connection closed")

// Call sends a request and decodes its result into out (nil: discard).
func (p *Peer) Call(ctx context.Context, method string, params, out any) error {
	id := strconv.FormatInt(p.next.Add(1), 10)
	ch := make(chan message, 1)
	p.mu.Lock()
	select {
	case <-p.done:
		p.mu.Unlock()
		return ErrClosed
	default:
	}
	p.pending[id] = ch
	p.mu.Unlock()
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	if params == nil {
		raw = nil
	}
	if err := p.write(message{ID: json.RawMessage(id), Method: method, Params: raw}); err != nil {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return ErrClosed
		}
		if m.Error != nil {
			return m.Error
		}
		if out != nil && len(m.Result) > 0 {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return ctx.Err()
	case <-p.done:
		return ErrClosed
	}
}

// Notify sends a notification.
func (p *Peer) Notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	if params == nil {
		raw = nil
	}
	return p.write(message{Method: method, Params: raw})
}
