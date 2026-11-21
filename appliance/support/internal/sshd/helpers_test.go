package sshd

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/fix"
	"github.com/CybexBV/whombat/appliance/support/internal/look"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

const device = "dev_7Hq2xYz"

// gate is a grant in memory.
type gate struct {
	mu       sync.Mutex
	level    string
	required bool
	code     string
	checks   int
	gen      uint64
	changed  chan struct{}
}

func newGate(level string) *gate { return &gate{level: level, changed: make(chan struct{})} }

func (g *gate) Level() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.level
}

func (g *gate) HelpCodeRequired() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.required
}

func (g *gate) CheckCode(user string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.checks++
	if g.level == "" {
		return false
	}
	return !g.required || wire.HelpCodeMatches(user, g.code)
}

func (g *gate) Changed() <-chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.changed
}

func (g *gate) Generation() uint64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.gen
}

// restart ends the grant and starts another at level without waking anyone in between (a stop and a new start before
// a connection looks again).
func (g *gate) restart(level string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.gen++
	g.level = level
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *gate) set(level string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if level == "" {
		g.gen++
	}
	g.level = level
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *gate) checked() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.checks
}

// recorder keeps visits in memory; every change wakes waiters.
type recorder struct {
	mu      sync.Mutex
	visits  map[uint64]*visit
	changed chan struct{}
}

func newRecorder() *recorder {
	return &recorder{visits: map[uint64]*visit{}, changed: make(chan struct{})}
}

func (r *recorder) bump() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func (r *recorder) Visit(serial uint64, keyID, who, level string) Visit {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v := r.visits[serial]; v != nil {
		return v
	}
	v := &visit{r: r, serial: serial, keyID: keyID, who: who, level: level}
	r.visits[serial] = v
	r.bump()
	return v
}

type visit struct {
	r                 *recorder
	serial            uint64
	keyID, who, level string
	connected, left   int
	steps             []wire.Step
	transcript        bytes.Buffer
}

func (v *visit) ID() string { return "v1" }
func (v *visit) Connected() {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	v.connected++
	v.r.bump()
}
func (v *visit) Left() {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	v.left++
	v.r.bump()
}
func (v *visit) Step(s wire.Step) {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	v.steps = append(v.steps, s)
	v.r.bump()
}
func (v *visit) Transcript() io.Writer { return &transcriptW{v} }

type transcriptW struct{ v *visit }

func (t *transcriptW) Write(p []byte) (int, error) {
	t.v.r.mu.Lock()
	defer t.v.r.mu.Unlock()
	return t.v.transcript.Write(p)
}

// waitFor waits until ok holds for the recorder (checked after every change), at most 10 s.
func (r *recorder) waitFor(t *testing.T, what string, ok func(*recorder) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		r.mu.Lock()
		good := ok(r)
		ch := r.changed
		r.mu.Unlock()
		if good {
			return
		}
		select {
		case <-ch:
		case <-deadline:
			t.Fatalf("waited in vain for %s", what)
		}
	}
}

func (r *recorder) steps(serial uint64) []wire.Step {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v := r.visits[serial]; v != nil {
		return append([]wire.Step(nil), v.steps...)
	}
	return nil
}

func (r *recorder) hasStep(serial uint64, ok func(wire.Step) bool) func(*recorder) bool {
	return func(r *recorder) bool {
		if v := r.visits[serial]; v != nil {
			for _, s := range v.steps {
				if ok(s) {
					return true
				}
			}
		}
		return false
	}
}

func kind(k, reason string) func(wire.Step) bool {
	return func(s wire.Step) bool {
		return string(s.Kind) == k && (reason == "" || s.Reason != nil && string(*s.Reason) == reason)
	}
}

// ca is a test support CA.
type ca struct {
	pub    ed25519.PublicKey
	signer ssh.Signer
}

func newCA(t *testing.T) ca {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return ca{pub: pub, signer: s}
}

// certOpts shape a certificate; zero values are a good one.
type certOpts struct {
	serial     uint64
	keyID      string
	principals []string
	after      time.Time
	before     time.Time
	beforeUnix uint64 // instead of before, in seconds
	infinite   bool
	certType   uint32
	noPTY      bool
	noForward  bool
	critical   map[string]string
}

func (c ca) cert(t *testing.T, o certOpts) ssh.Signer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	user, _ := ssh.NewSignerFromKey(priv)
	if o.serial == 0 {
		o.serial = 42
	}
	if o.keyID == "" {
		o.keyID = "Claude (op_7Hq2 via john)"
	}
	if o.principals == nil {
		o.principals = []string{device}
	}
	if o.after.IsZero() {
		o.after = time.Now().Add(-time.Minute)
	}
	if o.before.IsZero() {
		o.before = time.Now().Add(4 * time.Hour)
	}
	if o.certType == 0 {
		o.certType = ssh.UserCert
	}
	ext := map[string]string{}
	if !o.noPTY {
		ext["permit-pty"] = ""
	}
	if !o.noForward {
		ext["permit-port-forwarding"] = ""
	}
	cert := &ssh.Certificate{Key: user.PublicKey(), Serial: o.serial, CertType: o.certType, KeyId: o.keyID,
		ValidPrincipals: o.principals, ValidAfter: uint64(o.after.Unix()), ValidBefore: uint64(o.before.Unix()),
		Permissions: ssh.Permissions{CriticalOptions: o.critical, Extensions: ext}}
	if o.beforeUnix != 0 {
		cert.ValidBefore = o.beforeUnix
	}
	if o.infinite {
		cert.ValidBefore = ssh.CertTimeInfinity
	}
	if err := cert.SignCert(rand.Reader, c.signer); err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewCertSigner(cert, user)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// fakeBins are Look's binaries as scripts printing their name and arguments.
func fakeBins(t *testing.T) look.Bins {
	t.Helper()
	dir := t.TempDir()
	b := look.DefaultBins(dir)
	for _, p := range []string{b.Journalctl, b.Systemctl, b.Ps, b.Df, b.Lsblk, b.Free, b.IP, b.Cat, b.Uname, b.Uptime, b.Readlink} {
		os.WriteFile(p, []byte("#!/bin/sh\nprintf '%s\\n' \"$(basename \"$0\")\" \"$@\"\n"), 0o755)
	}
	return b
}

type env struct {
	srv  *Server
	gate *gate
	rec  *recorder
	ca   ca
	host ssh.PublicKey
	cfg  Config
}

// newEnv is a server at level with fake Look binaries, a real Fix runner (as the test's user) and a fake systemctl.
func newEnv(t *testing.T, level string, tweak func(*Config)) *env {
	t.Helper()
	e := &env{gate: newGate(level), rec: newRecorder(), ca: newCA(t)}
	lr, err := look.New(look.Config{Bins: fakeBins(t), UID: uint32(os.Getuid()), GID: uint32(os.Getgid()),
		KeepGroups: true, Path: "/usr/bin:/bin", Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	sysctl := filepath.Join(t.TempDir(), "systemctl")
	os.WriteFile(sysctl, []byte("#!/bin/sh\nprintf '%s ' \"$@\"\n"), 0o755)
	fr, err := fix.New(fix.Config{Bash: "/bin/bash", Sh: "/bin/sh", Systemctl: sysctl, Path: "/usr/bin:/bin", Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e.cfg = Config{StateDir: t.TempDir(), CAKeys: []ed25519.PublicKey{e.ca.pub},
		DeviceID: func() (string, error) { return device, nil }, Gate: e.gate, Recorder: e.rec, Look: lr, Fix: fr,
		Logf: t.Logf, SocketDir: t.TempDir()}
	if tweak != nil {
		tweak(&e.cfg)
	}
	e.srv, err = New(e.cfg)
	if err != nil {
		t.Fatal(err)
	}
	e.host = e.srv.signer.PublicKey()
	return e
}

// pipe is a loopback TCP pair: the server serves one end.
func (e *env) pipe(t *testing.T) (net.Conn, chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { e.srv.ServeConn(server); close(done) }()
	t.Cleanup(func() { client.Close() })
	return client, done
}

// dial signs in with signer as user.
func (e *env) dial(t *testing.T, user string, signer ssh.Signer) (*ssh.Client, error) {
	t.Helper()
	c, _ := e.pipe(t)
	conn, chans, reqs, err := ssh.NewClientConn(c, "box", &ssh.ClientConfig{User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(e.host), Timeout: 10 * time.Second})
	if err != nil {
		return nil, err
	}
	cl := ssh.NewClient(conn, chans, reqs)
	t.Cleanup(func() { cl.Close() })
	return cl, nil
}

func (e *env) mustDial(t *testing.T, signer ssh.Signer) *ssh.Client {
	t.Helper()
	cl, err := e.dial(t, "support", signer)
	if err != nil {
		t.Fatal(err)
	}
	return cl
}

// run runs one exec and answers its output, error output and exit status.
func run(t *testing.T, cl *ssh.Client, line string) (string, string, int) {
	t.Helper()
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var out, errb bytes.Buffer
	s.Stdout, s.Stderr = &out, &errb
	err = s.Run(line)
	code := 0
	if ee, ok := err.(*ssh.ExitError); ok {
		code = ee.ExitStatus()
	} else if err != nil {
		t.Fatalf("%q: %v", line, err)
	}
	return out.String(), errb.String(), code
}
