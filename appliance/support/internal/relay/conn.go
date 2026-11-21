package relay

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// conn is a spliced data connection as a net.Conn: every Write goes out as binary messages of at most the relay's
// maximum, Read reads binary messages back to back, the relay's pings are answered, and a connection silent for three
// heartbeats (pings count) fails. A text message after `ready` breaks the protocol and closes it with 4400. Deadlines
// work as net.Conn's, except that a read deadline that passes breaks the connection for good (a WebSocket can't resume
// a read that timed out).
type conn struct {
	ws           *websocket.Conn
	writeTimeout time.Duration
	max          int
	idle         time.Duration

	rmu sync.Mutex // one reader
	r   io.Reader  // the current message

	wmu sync.Mutex // one writer

	dmu     sync.Mutex
	readDL  time.Time
	writeDL time.Time

	closeOnce sync.Once
	closed    chan struct{}
}

func newConn(ws *websocket.Conn, writeTimeout time.Duration) *conn {
	return &conn{ws: ws, writeTimeout: writeTimeout, max: MaxMessage, idle: time.Minute, closed: make(chan struct{})}
}

// start switches the connection to binary data after `ready`.
func (c *conn) start(maxMessage int64, idle time.Duration) {
	if maxMessage <= 0 || maxMessage > MaxMessage {
		maxMessage = MaxMessage
	}
	c.max = int(maxMessage)
	c.idle = idle
	c.ws.SetReadLimit(maxMessage)
	c.ws.SetPingHandler(func(data string) error {
		_ = c.ws.SetReadDeadline(c.readDeadline())
		err := c.ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
		var ne net.Error
		if err == websocket.ErrCloseSent || errors.As(err, &ne) && ne.Timeout() {
			return nil
		}
		return err
	})
}

func (c *conn) readDeadline() time.Time {
	d := time.Now().Add(c.idle)
	c.dmu.Lock()
	u := c.readDL
	c.dmu.Unlock()
	if !u.IsZero() && u.Before(d) {
		return u
	}
	return d
}

func (c *conn) writeDeadline() time.Time {
	d := time.Now().Add(c.writeTimeout)
	c.dmu.Lock()
	u := c.writeDL
	c.dmu.Unlock()
	if !u.IsZero() && u.Before(d) {
		return u
	}
	return d
}

func (c *conn) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func (c *conn) err(err error) error {
	if c.isClosed() {
		return net.ErrClosed
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) && (ce.Code == websocket.CloseNormalClosure || ce.Code == websocket.CloseGoingAway) {
		return io.EOF
	}
	return err
}

func (c *conn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.rmu.Lock()
	defer c.rmu.Unlock()
	for {
		if c.r == nil {
			_ = c.ws.SetReadDeadline(c.readDeadline())
			mt, r, err := c.ws.NextReader()
			if err != nil {
				return 0, c.err(err)
			}
			if mt != websocket.BinaryMessage {
				c.closeCode(protocol.RelayCloseBadHello, "text after ready")
				return 0, errProtocol("a text message after ready")
			}
			c.r = r
		}
		n, err := c.r.Read(p)
		if err == io.EOF {
			c.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		if err != nil {
			return n, c.err(err)
		}
		return n, nil
	}
}

func (c *conn) Write(p []byte) (int, error) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	n := 0
	for len(p) > 0 {
		chunk := p[:min(len(p), c.max)]
		_ = c.ws.SetWriteDeadline(c.writeDeadline())
		if err := c.ws.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
			return n, c.err(err)
		}
		n += len(chunk)
		p = p[len(chunk):]
	}
	return n, nil
}

// Close closes the connection with 1000 (the relay forwards it to the client).
func (c *conn) Close() error {
	c.closeCode(websocket.CloseNormalClosure, "")
	return nil
}

func (c *conn) closeCode(code int, reason string) {
	c.closeOnce.Do(func() {
		close(c.closed)
		closeWith(c.ws, code, reason)
	})
}

func (c *conn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *conn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }

func (c *conn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func (c *conn) SetReadDeadline(t time.Time) error {
	c.dmu.Lock()
	c.readDL = t
	c.dmu.Unlock()
	return c.ws.SetReadDeadline(c.readDeadline())
}

func (c *conn) SetWriteDeadline(t time.Time) error {
	c.dmu.Lock()
	c.writeDL = t
	c.dmu.Unlock()
	return c.ws.SetWriteDeadline(c.writeDeadline())
}
