// Package sshd is the support service's SSH server (Whombat RH-05…RH-07), run over each relay session: no port listens
// anywhere. Who gets in is decided here, three ways at once: an OpenSSH user certificate signed by a pinned support CA,
// valid now and naming this device; an active grant, whose level bounds every request; and on prod images the help
// code as the SSH user name, checked only once the certificate's key has proven itself. Each step support takes is
// recorded in the certificate's visit.
package sshd

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net"
	"os/user"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/fix"
	"github.com/CybexBV/whombat/appliance/support/internal/look"
	"github.com/CybexBV/whombat/appliance/support/internal/managerclient"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

// Gate is the grant (grant.Store).
type Gate interface {
	Level() string              // "look" | "fix" | "" (no active grant)
	HelpCodeRequired() bool     //
	CheckCode(user string) bool // normalised, constant time; a wrong code counts towards the lock-out
	Changed() <-chan struct{}   // closed (and replaced) on stop, expiry or level change
	Generation() uint64         // moves whenever a grant ends: a connection belongs to the grant it signed in under
}

// Recorder keeps the visits (records.Store).
type Recorder interface {
	Visit(serial uint64, keyID, who, level string) Visit // the open visit for this certificate, or a new one
}

// Visit is one certificate's visit.
type Visit interface {
	ID() string
	Connected()
	Left()
	Step(s wire.Step)
	Transcript() io.Writer // Fix output only, capped; never typed input
}

// Defaults and bounds.
const (
	MaxConns     = 8
	MaxChannels  = 4 // per connection, at once
	AuthTimeout  = 10 * time.Second
	MaxAuthTries = 3
	// MaxValidity is the longest certificate window accepted: control issues 4 h (8 h on DEV) from 60 s before issue.
	MaxValidity = 24 * time.Hour
	maxKeyID    = 200
	maxTarget   = 200
)

// Config is the server's configuration. StateDir, CAKeys, DeviceID, Gate, Recorder and LookUser are what the service
// gives; the rest has the box's defaults and is there for tests.
type Config struct {
	StateDir string                 // the host key lives here (HostKeyFile), made at the first start
	CAKeys   []ed25519.PublicKey    // the pinned support CA keys (/etc/whombat/support-ca.pub)
	DeviceID func() (string, error) // /persist/identity/device.json's deviceId
	Gate     Gate
	Recorder Recorder
	LookUser string // the account Look commands run as (whombat-support-look)
	Manager  string // the manager's socket, for Look's reads (default managerclient.SocketDefault)
	Logf     func(format string, args ...any)

	HostKey      ssh.Signer       // instead of StateDir's
	Look         *look.Runner     // instead of one for LookUser
	Fix          *fix.Runner      // instead of the box's (fix.DefaultConfig)
	Now          func() time.Time // default time.Now
	MaxConns     int              // default MaxConns
	AuthTimeout  time.Duration    // default AuthTimeout
	MaxAuthTries int              // default MaxAuthTries
	MaxValidity  time.Duration    // default MaxValidity
	SocketDir    string           // forwards to sockets only under it (default /run)
}

// Server serves SSH over relay sessions.
type Server struct {
	cfg    Config
	signer ssh.Signer
	cas    [][]byte // the CA keys, wire-encoded
	look   *look.Runner
	fix    *fix.Runner

	mu    sync.Mutex
	conns int
}

// New makes the server: the host key (loaded, or made in StateDir), the CA keys, the Look and Fix runners.
func New(cfg Config) (*Server, error) {
	if cfg.Gate == nil || cfg.Recorder == nil || cfg.DeviceID == nil {
		return nil, errors.New("sshd: Gate, Recorder and DeviceID are required")
	}
	if len(cfg.CAKeys) == 0 {
		return nil, errors.New("sshd: no support CA key")
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.MaxConns <= 0 {
		cfg.MaxConns = MaxConns
	}
	if cfg.AuthTimeout <= 0 {
		cfg.AuthTimeout = AuthTimeout
	}
	if cfg.MaxAuthTries <= 0 {
		cfg.MaxAuthTries = MaxAuthTries
	}
	if cfg.MaxValidity <= 0 {
		cfg.MaxValidity = MaxValidity
	}
	if cfg.SocketDir == "" {
		cfg.SocketDir = "/run"
	}
	if cfg.Manager == "" {
		cfg.Manager = managerclient.SocketDefault
	}
	s := &Server{cfg: cfg, signer: cfg.HostKey, look: cfg.Look, fix: cfg.Fix}
	for _, k := range cfg.CAKeys {
		pub, err := ssh.NewPublicKey(k)
		if err != nil {
			return nil, fmt.Errorf("sshd: CA key: %w", err)
		}
		s.cas = append(s.cas, pub.Marshal())
	}
	if s.signer == nil {
		if cfg.StateDir == "" {
			return nil, errors.New("sshd: no state directory for the host key")
		}
		signer, err := LoadOrCreateHostKey(filepath.Join(cfg.StateDir, HostKeyFile))
		if err != nil {
			return nil, err
		}
		s.signer = signer
	}
	if s.look == nil {
		r, err := lookRunner(cfg.LookUser, cfg.Manager)
		if err != nil {
			return nil, err
		}
		s.look = r
	}
	if s.fix == nil {
		r, err := fix.New(fix.DefaultConfig())
		if err != nil {
			return nil, err
		}
		s.fix = r
	}
	return s, nil
}

// lookRunner runs Look as name: its uid, gid and groups (the journal's among them) from the system's accounts.
func lookRunner(name, manager string) (*look.Runner, error) {
	if name == "" {
		return nil, errors.New("sshd: no Look user")
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("sshd: Look user: %w", err)
	}
	uid, err1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, err2 := strconv.ParseUint(u.Gid, 10, 32)
	if err1 != nil || err2 != nil {
		return nil, fmt.Errorf("sshd: Look user %s has no numeric ids", name)
	}
	ids, err := u.GroupIds()
	if err != nil {
		return nil, fmt.Errorf("sshd: Look user's groups: %w", err)
	}
	var groups []uint32
	for _, id := range ids {
		g, err := strconv.ParseUint(id, 10, 32)
		if err != nil || g == 0 {
			return nil, fmt.Errorf("sshd: Look user %s is in group %q", name, id)
		}
		groups = append(groups, uint32(g))
	}
	return look.New(look.Config{Bins: look.DefaultBins(look.SystemBin), UID: uint32(uid), GID: uint32(gid),
		Groups: groups, Manager: managerclient.New(manager)})
}

// HostKey is the server's host key, `ssh-ed25519 <base64>` and nothing else.
func (s *Server) HostKey() string { return HostKeyLine(s.signer.PublicKey()) }

func (s *Server) logf(format string, args ...any) {
	s.cfg.Logf("whombat-support: ssh: "+format, args...)
}

func (s *Server) acquire() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conns >= s.cfg.MaxConns {
		return false
	}
	s.conns++
	return true
}

func (s *Server) release() {
	s.mu.Lock()
	s.conns--
	s.mu.Unlock()
}

// ServeConn serves one connection until it closes (relay.Run's serve).
func (s *Server) ServeConn(c net.Conn) {
	defer c.Close()
	if !s.acquire() {
		s.logf("refused a connection: %d are open already", s.cfg.MaxConns)
		return
	}
	defer s.release()
	if s.cfg.Gate.Level() == "" {
		return
	}
	timer := time.AfterFunc(s.cfg.AuthTimeout, func() { c.Close() })
	conn, chans, reqs, err := ssh.NewServerConn(c, s.serverConfig())
	if !timer.Stop() {
		if err == nil {
			conn.Close()
		}
		s.logf("a connection didn't sign in within %v", s.cfg.AuthTimeout)
		return
	}
	if err != nil {
		var ae *ssh.ServerAuthError
		if errors.As(err, &ae) && len(ae.Errors) > 0 {
			err = ae.Errors[len(ae.Errors)-1]
		}
		s.logf("refused a connection: %v", err)
		return
	}
	defer conn.Close()
	s.serve(conn, chans, reqs)
}

// Extensions the auth callbacks pass on in ssh.Permissions.
const (
	extSerial = "whombat-serial"
	extKeyID  = "whombat-key-id"
	extWho    = "whombat-who"
	extBefore = "whombat-valid-before"
	extPTY    = "whombat-pty"
	extFwd    = "whombat-forward"
	extLevel  = "whombat-level"
	extGen    = "whombat-generation"
)

// serverConfig is one connection's: it holds whether this connection has used its one help code.
func (s *Server) serverConfig() *ssh.ServerConfig {
	var codeTried bool
	cfg := &ssh.ServerConfig{
		MaxAuthTries:            s.cfg.MaxAuthTries,
		ServerVersion:           "SSH-2.0-WhombatSupport",
		PublicKeyAuthAlgorithms: []string{ssh.KeyAlgoED25519}, // certificates count as their key's algorithm
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			return s.checkKey(key)
		},
		// Only once the key has signed: tries without the certificate's private key never reach the help code.
		VerifiedPublicKeyCallback: func(meta ssh.ConnMetadata, _ ssh.PublicKey, perms *ssh.Permissions, _ string) (*ssh.Permissions, error) {
			if codeTried {
				return nil, errors.New("one help code per connection")
			}
			codeTried = true
			return s.checkCode(meta, perms)
		},
	}
	cfg.AddHostKey(s.signer)
	return cfg
}

// checkKey accepts only a user certificate from a pinned CA, valid now within a bounded window, naming this device
// among non-empty principals, without critical options, with a printable key id; and only while a grant is active.
func (s *Server) checkKey(key ssh.PublicKey) (*ssh.Permissions, error) {
	cert, ok := key.(*ssh.Certificate)
	if !ok {
		return nil, errors.New("not a certificate")
	}
	if cert.CertType != ssh.UserCert {
		return nil, errors.New("not a user certificate")
	}
	ca := cert.SignatureKey.Marshal()
	pinned := false
	for _, k := range s.cas {
		if bytes.Equal(k, ca) {
			pinned = true
		}
	}
	if !pinned {
		return nil, errors.New("a certificate from another CA")
	}
	if len(cert.ValidPrincipals) == 0 {
		return nil, errors.New("a certificate without principals")
	}
	// In seconds: a window turned into a time.Duration could overflow and pass.
	if cert.ValidBefore == ssh.CertTimeInfinity || cert.ValidBefore <= cert.ValidAfter ||
		cert.ValidBefore-cert.ValidAfter > uint64((s.cfg.MaxValidity+time.Minute)/time.Second) {
		return nil, errors.New("a certificate valid for too long")
	}
	device, err := s.cfg.DeviceID()
	if err != nil || device == "" {
		return nil, fmt.Errorf("no device id: %v", err)
	}
	checker := ssh.CertChecker{Clock: s.cfg.Now}
	if err := checker.CheckCert(device, cert); err != nil { // principal, time, the CA's signature
		return nil, err
	}
	// CheckCert lets `source-address` through (only Authenticate enforces it): control issues none, so any is refused.
	if len(cert.CriticalOptions) > 0 {
		return nil, errors.New("a certificate with critical options")
	}
	if !printable(cert.KeyId) {
		return nil, errors.New("a key id that isn't printable")
	}
	if s.cfg.Gate.Level() == "" {
		return nil, errors.New("remote help is off")
	}
	ext := map[string]string{
		extSerial: strconv.FormatUint(cert.Serial, 10),
		extKeyID:  cert.KeyId,
		extWho:    wire.Who(cert.KeyId),
		extBefore: strconv.FormatUint(cert.ValidBefore, 10),
	}
	if _, ok := cert.Permissions.Extensions["permit-pty"]; ok {
		ext[extPTY] = "1"
	}
	if _, ok := cert.Permissions.Extensions["permit-port-forwarding"]; ok {
		ext[extFwd] = "1"
	}
	return &ssh.Permissions{Extensions: ext}, nil
}

func printable(s string) bool {
	if s == "" || len(s) > maxKeyID || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

// checkCode asks the grant about the help code (the SSH user name), exactly once per connection; never logged.
func (s *Server) checkCode(meta ssh.ConnMetadata, perms *ssh.Permissions) (*ssh.Permissions, error) {
	gen := s.cfg.Gate.Generation() // before the level: a grant that ends in between closes the connection at once
	level := s.cfg.Gate.Level()
	if level == "" {
		return nil, errors.New("remote help is off")
	}
	if !s.cfg.Gate.CheckCode(meta.User()) {
		if s.cfg.Gate.HelpCodeRequired() {
			e := perms.Extensions
			serial, _ := strconv.ParseUint(e[extSerial], 10, 64)
			s.cfg.Recorder.Visit(serial, e[extKeyID], e[extWho], level).Step(wire.Step{Kind: wire.StepWrongCode})
		}
		return nil, errors.New("a wrong help code")
	}
	perms.Extensions[extLevel] = level
	perms.Extensions[extGen] = strconv.FormatUint(gen, 10)
	return perms, nil
}

// conn is one signed-in connection.
type conn struct {
	s       *Server
	ssh     *ssh.ServerConn
	visit   Visit
	level   string // the grant's level when it signed in
	gen     uint64 // the grant's generation when it signed in
	pty     bool   // the certificate permits a terminal
	forward bool   // the certificate permits forwards
}

func (s *Server) serve(sc *ssh.ServerConn, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	e := sc.Permissions.Extensions
	serial, _ := strconv.ParseUint(e[extSerial], 10, 64)
	before, _ := strconv.ParseInt(e[extBefore], 10, 64)
	gen, _ := strconv.ParseUint(e[extGen], 10, 64)
	c := &conn{s: s, ssh: sc, level: e[extLevel], gen: gen, pty: e[extPTY] == "1", forward: e[extFwd] == "1"}
	c.visit = s.cfg.Recorder.Visit(serial, e[extKeyID], e[extWho], c.level)
	c.visit.Connected()
	defer c.visit.Left()

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); c.watch(ctx) }()
	go func() {
		defer wg.Done()
		for r := range reqs {
			c.global(r)
		}
	}()
	// The certificate's end is the visit's: the connection doesn't outlive it.
	expiry := time.AfterFunc(time.Unix(before, 0).Sub(s.cfg.Now()), func() {
		s.logf("a certificate expired; closing its connection")
		sc.Close()
	})
	defer expiry.Stop()

	// At most MaxChannels channels at once per connection: Look's commands and Fix's sessions and forwards all hold one.
	slots := make(chan struct{}, MaxChannels)
	for nc := range chans {
		select {
		case slots <- struct{}{}:
		default:
			_ = nc.Reject(ssh.ResourceShortage, "too many open channels")
			continue
		}
		release := func() { <-slots }
		switch nc.ChannelType() {
		case "session":
			wg.Add(1)
			go func() { defer wg.Done(); defer release(); c.session(ctx, nc) }()
		case "direct-tcpip":
			wg.Add(1)
			go func() { defer wg.Done(); defer release(); c.directTCPIP(ctx, nc) }()
		case "direct-streamlocal@openssh.com":
			wg.Add(1)
			go func() { defer wg.Done(); defer release(); c.streamLocal(ctx, nc) }()
		default:
			release()
			_ = nc.Reject(ssh.UnknownChannelType, "not here")
		}
	}
	cancel()
	sc.Close()
	wg.Wait()
}

// watch closes the connection once its grant changed at all: stopped or expired (even when a new grant started before
// this woke), or its level changed either way. A connection made at Look that saw the level go up and down again could
// otherwise keep a root shell or a forward it opened in between; the tools reconnect at the new level.
func (c *conn) watch(ctx context.Context) {
	g := c.s.cfg.Gate
	for {
		changed := g.Changed()
		level := g.Level()
		if level == "" || g.Generation() != c.gen || level != c.level {
			c.s.logf("the grant changed (%q); closing a connection", level)
			c.ssh.Close()
			return
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return
		}
	}
}

// global answers connection requests: none is granted (no remote forwarding).
func (c *conn) global(r *ssh.Request) {
	switch r.Type {
	case "tcpip-forward", "streamlocal-forward@openssh.com":
		c.refuse(wire.ReasonLimit, "remote forwarding", "")
	}
	if r.WantReply {
		_ = r.Reply(false, nil)
	}
}

// refuse records a refused step.
func (c *conn) refuse(reason, line, target string) {
	st := wire.Step{Kind: wire.StepRefused, Reason: wire.Ptr(refusal(reason))}
	if line != "" {
		st.Line = wire.Ptr(line)
	}
	if target != "" {
		st.Target = wire.Ptr(look.Truncate(target, maxTarget))
	}
	c.visit.Step(st)
}
