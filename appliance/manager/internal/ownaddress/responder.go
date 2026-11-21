package ownaddress

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
	"golang.org/x/crypto/acme"
)

// Responder is the ACME socket (MG-163): the runtime pipes each `acme` door stream into one connection, byte for byte
// from the validator's ClientHello on, and never parses it. The responder answers only ALPN exactly `acme-tls/1`, for
// its own host, and only with a pending challenge certificate or the probe's certificate (MG-164); anything else gets
// a TLS alert and a close. It never serves the page's certificate or anything else.
type Responder struct {
	// RuntimeUID is the only peer it takes (kernel credentials).
	RuntimeUID uint32
	// Max is how many connections it serves at once (OwnAddressACMEConnectionsMax); more are closed at once.
	Max int
	// HandshakeTimeout bounds one connection (0: 10 s).
	HandshakeTimeout time.Duration
	Log              *slog.Logger

	mu        sync.Mutex
	challenge map[string]*tls.Certificate // by host, while the CA validates
	probe     map[string]*tls.Certificate // by host, while the manager probes the path
	slots     chan struct{}
	once      sync.Once
}

func (r *Responder) init() {
	r.once.Do(func() {
		n := r.Max
		if n <= 0 {
			n = local.OwnAddressACMEConnectionsMax
		}
		r.slots = make(chan struct{}, n)
		r.mu.Lock()
		if r.challenge == nil {
			r.challenge = map[string]*tls.Certificate{}
		}
		if r.probe == nil {
			r.probe = map[string]*tls.Certificate{}
		}
		r.mu.Unlock()
	})
}

func (r *Responder) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}

// SetChallenge serves c for host until ClearChallenge (nil clears it too).
func (r *Responder) SetChallenge(host string, c *tls.Certificate) { r.set(&r.challenge, host, c) }

// ClearChallenge stops serving host's challenge certificate.
func (r *Responder) ClearChallenge(host string) { r.set(&r.challenge, host, nil) }

// SetProbe serves the probe's certificate for host until ClearProbe.
func (r *Responder) SetProbe(host string, c *tls.Certificate) { r.set(&r.probe, host, c) }

// ClearProbe stops serving host's probe certificate.
func (r *Responder) ClearProbe(host string) { r.set(&r.probe, host, nil) }

func (r *Responder) set(m *map[string]*tls.Certificate, host string, c *tls.Certificate) {
	r.init()
	r.mu.Lock()
	defer r.mu.Unlock()
	if c == nil {
		delete(*m, host)
		return
	}
	(*m)[host] = c
}

// errRefused is every refusal's error: the TLS stack turns it into an alert, and the validator learns nothing more.
var errRefused = errors.New("not an acme-tls/1 hello for a pending name")

func (r *Responder) certificate(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if len(hi.SupportedProtos) != 1 || hi.SupportedProtos[0] != acme.ALPNProto {
		return nil, errRefused
	}
	name := strings.TrimSuffix(strings.ToLower(hi.ServerName), ".")
	r.mu.Lock()
	defer r.mu.Unlock()
	// A pending challenge wins: the CA's validation is the one that costs something when it fails.
	if c := r.challenge[name]; c != nil {
		return c, nil
	}
	if c := r.probe[name]; c != nil {
		return c, nil
	}
	return nil, errRefused
}

// Bind creates the socket at path (0660 in the manager's run directory, which the runtime's group can enter). A stale
// socket file is replaced; anything else at the path is an error.
func (r *Responder) Bind(path string) (net.Listener, error) {
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode().Type() != os.ModeSocket {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return nil, fmt.Errorf("%s: another process serves it", path)
		} else if !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, syscall.ENOENT) {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// Serve answers connections on ln until ctx ends; it closes ln.
func (r *Responder) Serve(ctx context.Context, ln net.Listener) error {
	r.init()
	go func() { <-ctx.Done(); ln.Close() }()
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		select {
		case r.slots <- struct{}{}:
		default:
			// Beyond the limit: closed before a byte is read, so the runtime's pipe ends at once.
			c.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-r.slots }()
			r.serve(c)
		}()
	}
}

func (r *Responder) serve(c net.Conn) {
	defer c.Close()
	cred, err := peercred.Of(c)
	if err != nil || cred.UID != r.RuntimeUID {
		r.log().Warn("own address: acme socket refused a peer", "uid", cred.UID, "pid", cred.PID)
		return
	}
	timeout := r.HandshakeTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	_ = c.SetDeadline(time.Now().Add(timeout))
	tc := tls.Server(c, &tls.Config{
		MinVersion:     tls.VersionTLS12,
		NextProtos:     []string{acme.ALPNProto},
		GetCertificate: r.certificate,
	})
	// The validator only reads the certificate; the handshake is the whole exchange.
	if err := tc.Handshake(); err == nil {
		_ = tc.Close()
	}
}
