package controlapi_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
)

// stallingProxy forwards TCP connections to target until stall: from then on the connections it already has carry
// nothing and stay open, as when the address a connection was opened from is gone; new connections still work.
type stallingProxy struct {
	ln     net.Listener
	target string
	mu     sync.Mutex
	open   []*stallable
}

type stallable struct {
	mu      sync.Mutex
	stalled bool
}

func (s *stallable) pass() bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.stalled }

func newStallingProxy(t *testing.T, target string) *stallingProxy {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &stallingProxy{ln: ln, target: target}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			in, err := ln.Accept()
			if err != nil {
				return
			}
			out, err := net.Dial("tcp", target)
			if err != nil {
				in.Close()
				continue
			}
			s := &stallable{}
			p.mu.Lock()
			p.open = append(p.open, s)
			p.mu.Unlock()
			t.Cleanup(func() { in.Close(); out.Close() })
			go pipe(s, out, in)
			go pipe(s, in, out)
		}
	}()
	return p
}

// pipe copies until the connection stalls; then it drops what arrives and keeps both ends open.
func pipe(s *stallable, dst, src net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if err != nil {
			return
		}
		if s.pass() {
			if _, err := dst.Write(buf[:n]); err != nil {
				return
			}
		}
	}
}

func (p *stallingProxy) stall() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.open {
		s.mu.Lock()
		s.stalled = true
		s.mu.Unlock()
	}
}

func (p *stallingProxy) conns() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.open) }

func TestHealthCheckedDropsAStalledConnection(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Proto)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	proxy := newStallingProxy(t, srv.Listener.Addr().String())
	url := "https://" + proxy.ln.Addr().String() + "/"

	tr := controlapi.HealthChecked(srv.Client().Transport.(*http.Transport), 150*time.Millisecond, 150*time.Millisecond)
	hc := &http.Client{Transport: tr, Timeout: 500 * time.Millisecond}
	get := func() (string, error) {
		res, err := hc.Get(url)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		return string(b), err
	}

	if proto, err := get(); err != nil || proto != "HTTP/2.0" {
		t.Fatalf("first request: %q, %v (want HTTP/2.0)", proto, err)
	}
	proxy.stall()
	if _, err := get(); err == nil {
		t.Fatal("a request on the stalled connection answered")
	}
	// The unanswered ping closes the stalled connection; the next request opens a new one and is answered.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if proto, err := get(); err == nil {
			if proto != "HTTP/2.0" {
				t.Fatalf("answered over %s", proto)
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("every request still went to the stalled connection")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if n := proxy.conns(); n != 2 {
		t.Fatalf("%d connections, want the stalled one and one new", n)
	}
}

func TestHealthCheckedKeepsTheTransport(t *testing.T) {
	base := &http.Transport{MaxIdleConns: 7}
	h := controlapi.HealthChecked(base, time.Second, 2*time.Second)
	// (Cloning gives the transport it was given an empty HTTP/2 configuration from Go 1.27 on: what counts is that the
	// pings aren't set there.)
	if h == base || (base.HTTP2 != nil && (base.HTTP2 == h.HTTP2 || base.HTTP2.SendPingTimeout != 0 || base.HTTP2.PingTimeout != 0)) {
		t.Fatal("HealthChecked changed the transport it was given")
	}
	if h.MaxIdleConns != 7 || h.HTTP2.SendPingTimeout != time.Second || h.HTTP2.PingTimeout != 2*time.Second {
		t.Fatalf("got %+v, %+v", h, h.HTTP2)
	}
}
