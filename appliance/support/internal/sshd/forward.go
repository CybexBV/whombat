package sshd

import (
	"context"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

// Channel payloads (RFC 4254 §7.2; OpenSSH PROTOCOL §2.4).
type directTCPIP struct {
	Host     string
	Port     uint32
	OrigHost string
	OrigPort uint32
}

type directStreamLocal struct {
	Path      string
	Reserved0 string
	Reserved1 uint32
}

// mayForward says whether a forward may open now: Look and fix, and a certificate that permits forwards. A refusal
// is recorded with its target.
func (c *conn) mayForward(nc ssh.NewChannel, target string) bool {
	switch {
	case c.s.cfg.Gate.Level() != wire.LevelFix:
		c.refuse(wire.ReasonLevel, "", target)
		_ = nc.Reject(ssh.Prohibited, "that needs Look and fix")
	case !c.forward:
		c.refuse(wire.ReasonCertificate, "", target)
		_ = nc.Reject(ssh.Prohibited, "the certificate doesn't permit forwarding")
	default:
		return true
	}
	return false
}

// directTCPIP connects to one of the box's own local ports: 127.0.0.1 or ::1 ("localhost" is 127.0.0.1, never looked up).
func (c *conn) directTCPIP(ctx context.Context, nc ssh.NewChannel) {
	var p directTCPIP
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "bad request")
		return
	}
	target := net.JoinHostPort(p.Host, strconv.FormatUint(uint64(p.Port), 10))
	if !c.mayForward(nc, target) {
		return
	}
	host := p.Host
	if host == "localhost" {
		host = "127.0.0.1"
	}
	if (host != "127.0.0.1" && host != "::1") || p.Port == 0 || p.Port > 65535 {
		c.refuse(wire.ReasonLimit, "", target)
		_ = nc.Reject(ssh.Prohibited, "only 127.0.0.1 and ::1")
		return
	}
	target = net.JoinHostPort(host, strconv.FormatUint(uint64(p.Port), 10))
	d := net.Dialer{Timeout: 10 * time.Second}
	dst, err := d.DialContext(ctx, "tcp", target)
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "nothing answers there")
		return
	}
	c.splice(ctx, nc, dst, target)
}

// streamLocal connects to a socket under /run (its real path, symlinks followed, must stay there).
func (c *conn) streamLocal(ctx context.Context, nc ssh.NewChannel) {
	var p directStreamLocal
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "bad request")
		return
	}
	if !c.mayForward(nc, p.Path) {
		return
	}
	path, ok := c.socketPath(p.Path)
	if !ok {
		c.refuse(wire.ReasonLimit, "", p.Path)
		_ = nc.Reject(ssh.Prohibited, "only sockets under /run")
		return
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	dst, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "nothing answers there")
		return
	}
	c.splice(ctx, nc, dst, p.Path)
}

// socketPath checks a socket path: absolute, clean, at most 200 bytes, under SocketDir before and after following
// symlinks.
func (c *conn) socketPath(p string) (string, bool) {
	dir := filepath.Clean(c.s.cfg.SocketDir)
	under := func(dir, p string) bool { return strings.HasPrefix(p, dir+"/") }
	if len(p) > maxTarget || !filepath.IsAbs(p) || filepath.Clean(p) != p || strings.ContainsRune(p, 0) || !under(dir, p) {
		return "", false
	}
	realDir, err1 := filepath.EvalSymlinks(dir)
	real, err2 := filepath.EvalSymlinks(p)
	if err1 != nil || err2 != nil || !under(realDir, real) {
		return "", false
	}
	return real, true
}

// splice copies both ways until both ends are done or ctx ends, then records the forward with its bytes.
func (c *conn) splice(ctx context.Context, nc ssh.NewChannel, dst net.Conn, target string) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		dst.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	var n atomic.Int64
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		k, _ := io.Copy(dst, ch)
		n.Add(k)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		k, _ := io.Copy(ch, dst)
		n.Add(k)
		_ = ch.CloseWrite()
	}()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	dst.Close()
	ch.Close()
	<-done
	c.visit.Step(wire.Step{Kind: wire.StepForward, Target: wire.Ptr(target), Bytes: wire.Ptr(n.Load())})
}
