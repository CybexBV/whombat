package sshd

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

func TestLookCommandRunsAndIsRecorded(t *testing.T) {
	e := newEnv(t, wire.LevelLook, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 7}))
	out, _, code := run(t, cl, "logs whombat-server -n 5")
	if code != 0 || out != "journalctl\n--no-pager\n-o\nshort-iso\n--lines=5\n--unit=whombat-server\n" {
		t.Fatalf("%d %q", code, out)
	}
	steps := e.rec.steps(7)
	if len(steps) != 1 || steps[0].Kind != wire.StepLook || *steps[0].Command != "logs" ||
		!slices.Equal(steps[0].Units, []string{"whombat-server"}) || !wire.StepValid(steps[0]) {
		t.Fatalf("%+v", steps)
	}
	v := e.rec.visits[7]
	if v.who != "Claude" || v.keyID != "Claude (op_7Hq2 via john)" || v.level != wire.LevelLook || v.connected != 1 {
		t.Fatalf("%+v", v)
	}
	if v.transcript.Len() != 0 {
		t.Fatal("Look output went into the transcript")
	}
	cl.Close()
	e.rec.waitFor(t, "left", func(r *recorder) bool { return r.visits[7].left == 1 })
}

func TestFixIsRefusedAtLook(t *testing.T) {
	e := newEnv(t, wire.LevelLook, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 8}))
	_, errs, code := run(t, cl, "restart whombat-server")
	if code != 1 || !strings.Contains(errs, "Look and fix") {
		t.Fatalf("%d %q", code, errs)
	}
	_, errs, code = run(t, cl, "cat /etc/shadow")
	if code != 1 || !strings.Contains(errs, "Look and fix") || !strings.Contains(errs, "logs") {
		t.Fatalf("%d %q", code, errs)
	}
	if _, errs, code = run(t, cl, ""); code != 1 || !strings.Contains(errs, "Look command") {
		t.Fatalf("%d %q", code, errs)
	}
	_, errs, code = run(t, cl, "logs -o json")
	if code != 2 || errs == "" {
		t.Fatalf("%d %q", code, errs)
	}
	s, _ := cl.NewSession()
	if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err == nil {
		t.Fatal("a terminal at Look")
	}
	var errb bytes.Buffer
	s.Stderr = &errb
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	if err := s.Wait(); err == nil || !strings.Contains(errb.String(), "Look and fix") {
		t.Fatalf("shell at Look: %v %q", err, errb.String())
	}
	reasons := []string{}
	for _, st := range e.rec.steps(8) {
		if st.Kind != wire.StepRefused || !wire.StepValid(st) {
			t.Fatalf("%+v", st)
		}
		reasons = append(reasons, string(*st.Reason))
	}
	if !slices.Equal(reasons, []string{"level", "level", "unknown_command", "bad_arguments", "level"}) {
		t.Fatalf("%v", reasons)
	}
}

func TestFixRunsCommandsRestartsAndShells(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 9}))
	out, errs, code := run(t, cl, "echo hi; echo oops >&2; exit 4")
	if code != 4 || out != "hi\n" || errs != "oops\n" {
		t.Fatalf("%d %q %q", code, out, errs)
	}
	out, _, code = run(t, cl, "restart whombat-voice.service")
	if code != 0 || out != "restart -- whombat-voice.service " {
		t.Fatalf("%d %q", code, out)
	}
	if _, _, code := run(t, cl, "restart -H evil"); code != 2 {
		t.Fatalf("restart with an option: %d", code)
	}
	out, _, _ = run(t, cl, "help")
	if !strings.Contains(out, "logs [UNIT") || !strings.Contains(out, "restart UNIT") {
		t.Fatalf("%q", out)
	}

	s, _ := cl.NewSession()
	s.Stdin = strings.NewReader("echo $((6*7)); exit 3\n")
	var sh bytes.Buffer
	s.Stdout = &sh
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	if err := s.Wait(); err == nil || err.(*ssh.ExitError).ExitStatus() != 3 || sh.String() != "42\n" {
		t.Fatalf("%v %q", err, sh.String())
	}
	e.rec.waitFor(t, "the shell step", e.rec.hasStep(9, kind(wire.StepShell, "")))

	var kinds []string
	for _, st := range e.rec.steps(9) {
		if !wire.StepValid(st) {
			t.Fatalf("%+v", st)
		}
		kinds = append(kinds, string(st.Kind))
	}
	if !slices.Equal(kinds, []string{"exec", "restart", "refused", "look", "shell"}) {
		t.Fatalf("%v", kinds)
	}
	steps := e.rec.steps(9)
	if *steps[0].Line != "echo hi; echo oops >&2; exit 4" || !slices.Equal(steps[1].Units, []string{"whombat-voice.service"}) {
		t.Fatalf("%+v %+v", steps[0], steps[1])
	}
	tr := e.rec.visits[9].transcript.String()
	if !strings.Contains(tr, "hi\n") || !strings.Contains(tr, "oops\n") || !strings.Contains(tr, "42\n") ||
		strings.Contains(tr, "6*7") {
		t.Fatalf("transcript %q", tr)
	}
}

func TestTerminalNeedsFixAndTheCertificatesPermission(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 10}))
	s, _ := cl.NewSession()
	if err := s.RequestPty("xterm", 30, 100, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	out, err := s.Output("stty size")
	if err != nil || !strings.Contains(string(out), "30 100") {
		t.Fatalf("%q %v", out, err)
	}
	cl2 := e.mustDial(t, e.ca.cert(t, certOpts{serial: 11, noPTY: true}))
	s2, _ := cl2.NewSession()
	if err := s2.RequestPty("xterm", 30, 100, ssh.TerminalModes{}); err == nil {
		t.Fatal("a terminal the certificate doesn't permit")
	}
}

func TestClientEnvironmentNeverReachesACommand(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{}))
	s, _ := cl.NewSession()
	if err := s.Setenv("LD_PRELOAD", "/tmp/x.so"); err == nil {
		t.Fatal("env accepted")
	}
	out, err := s.Output("env")
	if err != nil || strings.Contains(string(out), "LD_PRELOAD") {
		t.Fatalf("%q %v", out, err)
	}
}

func TestCertificateChecks(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	other := newCA(t)
	now := time.Now()
	_, plainKey, _ := ed25519.GenerateKey(rand.Reader)
	plain, _ := ssh.NewSignerFromKey(plainKey)
	for name, signer := range map[string]ssh.Signer{
		"a plain key":           plain,
		"another CA":            other.cert(t, certOpts{}),
		"a host certificate":    e.ca.cert(t, certOpts{certType: ssh.HostCert}),
		"no principals":         e.ca.cert(t, certOpts{principals: []string{}}),
		"another device":        e.ca.cert(t, certOpts{principals: []string{"dev_other"}}),
		"expired":               e.ca.cert(t, certOpts{after: now.Add(-2 * time.Hour), before: now.Add(-time.Hour)}),
		"not yet valid":         e.ca.cert(t, certOpts{after: now.Add(time.Hour), before: now.Add(2 * time.Hour)}),
		"forever":               e.ca.cert(t, certOpts{infinite: true}),
		"too long":              e.ca.cert(t, certOpts{before: now.Add(30 * 24 * time.Hour)}),
		"overflowing":           e.ca.cert(t, certOpts{beforeUnix: uint64(now.Unix()) + 1<<34}), // ×1e9 wraps an int64
		"since the epoch":       e.ca.cert(t, certOpts{after: time.Unix(1, 0)}),
		"a critical option":     e.ca.cert(t, certOpts{critical: map[string]string{"force-command": "id"}}),
		"a source address":      e.ca.cert(t, certOpts{critical: map[string]string{"source-address": "0.0.0.0/0"}}),
		"a key id with escapes": e.ca.cert(t, certOpts{keyID: "Claude\x1b[2J (op_1)"}),
	} {
		if _, err := e.dial(t, "support", signer); err == nil {
			t.Errorf("%s: signed in", name)
		}
	}
	if n := e.gate.checked(); n != 0 {
		t.Fatalf("the help code was asked %d times without a good certificate", n)
	}
	if len(e.rec.visits) != 0 {
		t.Fatal("a refused certificate started a visit")
	}
	// Many principals, this device among them, is fine.
	e.mustDial(t, e.ca.cert(t, certOpts{principals: []string{"dev_other", device}}))
}

func TestNoGrantNoEntry(t *testing.T) {
	e := newEnv(t, "", nil)
	if _, err := e.dial(t, "support", e.ca.cert(t, certOpts{})); err == nil {
		t.Fatal("signed in without a grant")
	}
}

// badSigner holds a good certificate but signs with another key: it never proves possession.
type badSigner struct {
	ssh.Signer
	other ssh.Signer
}

func (b badSigner) Sign(r io.Reader, data []byte) (*ssh.Signature, error) {
	return b.other.Sign(r, data)
}

func TestHelpCodeIsAskedOnlyAfterTheKeyProvesItself(t *testing.T) {
	e := newEnv(t, wire.LevelLook, nil)
	e.gate.required, e.gate.code = true, "KQ72MX"

	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	other, _ := ssh.NewSignerFromKey(otherKey)
	if _, err := e.dial(t, "KQ72MX", badSigner{e.ca.cert(t, certOpts{serial: 20}), other}); err == nil {
		t.Fatal("signed in without the certificate's key")
	}
	if n := e.gate.checked(); n != 0 {
		t.Fatalf("a try without the key counted %d codes", n)
	}

	if _, err := e.dial(t, "WRONG1", e.ca.cert(t, certOpts{serial: 21})); err == nil {
		t.Fatal("signed in with a wrong code")
	}
	if n := e.gate.checked(); n != 1 {
		t.Fatalf("one wrong try counted %d", n)
	}
	e.rec.waitFor(t, "the wrong code step", e.rec.hasStep(21, kind(wire.StepWrongCode, "")))
	if e.rec.visits[21].connected != 0 {
		t.Fatal("a wrong code connected")
	}

	cl, err := e.dial(t, "kq7·2mx", e.ca.cert(t, certOpts{serial: 22}))
	if err != nil {
		t.Fatalf("the right code (as typed) was refused: %v", err)
	}
	if _, _, code := run(t, cl, "help"); code != 0 {
		t.Fatal(code)
	}
}

func TestOneHelpCodePerConnection(t *testing.T) {
	e := newEnv(t, wire.LevelLook, nil)
	e.gate.required, e.gate.code = true, "KQ72MX"
	c, _ := e.pipe(t)
	a, b := e.ca.cert(t, certOpts{serial: 30}), e.ca.cert(t, certOpts{serial: 31})
	_, _, _, err := ssh.NewClientConn(c, "box", &ssh.ClientConfig{User: "WRONG1",
		Auth: []ssh.AuthMethod{ssh.PublicKeys(a, b)}, HostKeyCallback: ssh.FixedHostKey(e.host)})
	if err == nil {
		t.Fatal("signed in")
	}
	if n := e.gate.checked(); n != 1 {
		t.Fatalf("two keys on one connection asked %d codes", n)
	}
}

func TestAtMostMaxConns(t *testing.T) {
	e := newEnv(t, wire.LevelLook, func(c *Config) { c.MaxConns = 2 })
	e.mustDial(t, e.ca.cert(t, certOpts{}))
	e.mustDial(t, e.ca.cert(t, certOpts{}))
	if _, err := e.dial(t, "support", e.ca.cert(t, certOpts{})); err == nil {
		t.Fatal("a third connection")
	}
}

func TestSignInTimesOut(t *testing.T) {
	e := newEnv(t, wire.LevelLook, func(c *Config) { c.AuthTimeout = 50 * time.Millisecond })
	c, done := e.pipe(t)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("a silent connection stayed")
	}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadAll(c); err != nil {
		t.Fatalf("%v", err)
	}
}

func waitClosed(t *testing.T, cl *ssh.Client, what string) {
	t.Helper()
	done := make(chan struct{})
	go func() { cl.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s: the connection stayed open", what)
	}
}

func stillOpen(t *testing.T, cl *ssh.Client) {
	t.Helper()
	if _, _, code := run(t, cl, "help"); code != 0 {
		t.Fatalf("help: %d", code)
	}
}

// Any change of level closes the connections made before it, both ways: one made at Look that saw Look and fix come
// and go again must not keep a root shell it opened in between.
func TestGrantChangesCloseConnections(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	fixConn := e.mustDial(t, e.ca.cert(t, certOpts{serial: 40}))
	e.gate.set(wire.LevelLook)
	waitClosed(t, fixConn, "down to Look")
	lookConn := e.mustDial(t, e.ca.cert(t, certOpts{serial: 41}))
	e.gate.set(wire.LevelFix)
	waitClosed(t, lookConn, "up to Look and fix")
	again := e.mustDial(t, e.ca.cert(t, certOpts{serial: 41}))
	if _, _, code := run(t, again, "echo up"); code != 0 {
		t.Fatal("Look and fix isn't live on a connection made at Look and fix")
	}
	e.gate.set("")
	waitClosed(t, again, "stopped")
}

// A stop and a new grant before the connection looks again still close it: it belonged to the grant that ended.
func TestANewGrantDoesNotInheritConnections(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	old := e.mustDial(t, e.ca.cert(t, certOpts{serial: 42}))
	e.gate.restart(wire.LevelFix)
	waitClosed(t, old, "a new grant")
	fresh := e.mustDial(t, e.ca.cert(t, certOpts{serial: 43}))
	stillOpen(t, fresh)
}

func TestStoppingKillsRunningCommands(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{}))
	s, _ := cl.NewSession()
	r, _ := s.StdoutPipe()
	if err := s.Start("echo $$; exec sleep 600"); err != nil {
		t.Fatal(err)
	}
	var pid int
	buf := make([]byte, 32)
	n, _ := r.Read(buf)
	pid, _ = strconv.Atoi(strings.TrimSpace(string(buf[:n])))
	e.gate.set("")
	waitClosed(t, cl, "stopped")
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil || strings.Contains(string(b), ") Z ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d outlived the grant", pid)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestTheConnectionEndsWithItsCertificate(t *testing.T) {
	before := time.Now().Add(time.Hour).Truncate(time.Second)
	e := newEnv(t, wire.LevelLook, func(c *Config) {
		c.Now = func() time.Time { return before.Add(-100 * time.Millisecond) }
	})
	cl := e.mustDial(t, e.ca.cert(t, certOpts{before: before}))
	waitClosed(t, cl, "the certificate expired")
}

func TestForwards(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	sock := filepath.Join(e.cfg.SocketDir, "x.sock")
	ul, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ul.Close()
	go func() {
		for {
			c, err := ul.Accept()
			if err != nil {
				return
			}
			go func() { io.WriteString(c, "sock"); c.Close() }()
		}
	}()

	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 50}))
	c, err := cl.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(c, "ping")
	got := make([]byte, 4)
	if _, err := io.ReadFull(c, got); err != nil || string(got) != "ping" {
		t.Fatalf("%q %v", got, err)
	}
	c.Close()
	e.rec.waitFor(t, "the forward step", e.rec.hasStep(50, func(s wire.Step) bool {
		return s.Kind == wire.StepForward && *s.Target == ln.Addr().String() && *s.Bytes == 8
	}))

	u, err := cl.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(u); string(b) != "sock" {
		t.Fatalf("%q", b)
	}
	u.Close()
	e.rec.waitFor(t, "the socket step", e.rec.hasStep(50, func(s wire.Step) bool {
		return s.Kind == wire.StepForward && *s.Target == sock
	}))

	outside := filepath.Join(t.TempDir(), "o.sock")
	ol, _ := net.Listen("unix", outside)
	defer ol.Close()
	link := filepath.Join(e.cfg.SocketDir, "link.sock")
	os.Symlink(outside, link)
	for _, target := range [][2]string{{"tcp", "10.0.0.1:22"}, {"tcp", "192.0.2.1:80"}, {"unix", outside},
		{"unix", link}, {"unix", e.cfg.SocketDir + "/../" + filepath.Base(outside)}} {
		if c, err := cl.Dial(target[0], target[1]); err == nil {
			c.Close()
			t.Errorf("%v: forwarded", target)
		}
	}
	e.rec.waitFor(t, "the refusals", func(r *recorder) bool {
		n := 0
		for _, s := range r.visits[50].steps {
			if s.Kind == wire.StepRefused && *s.Reason == wire.ReasonLimit && s.Target != nil {
				n++
			}
		}
		return n == 5
	})

	look := newEnv(t, wire.LevelLook, nil)
	lc := look.mustDial(t, look.ca.cert(t, certOpts{serial: 51}))
	if _, err := lc.Dial("tcp", ln.Addr().String()); err == nil {
		t.Fatal("a forward at Look")
	}
	look.rec.waitFor(t, "the Look refusal", look.rec.hasStep(51, kind(wire.StepRefused, wire.ReasonLevel)))

	nofwd := e.mustDial(t, e.ca.cert(t, certOpts{serial: 52, noForward: true}))
	if _, err := nofwd.Dial("tcp", ln.Addr().String()); err == nil {
		t.Fatal("a forward the certificate doesn't permit")
	}
	e.rec.waitFor(t, "the certificate refusal", e.rec.hasStep(52, kind(wire.StepRefused, wire.ReasonCertificate)))
}

func TestWhatIsNeverAllowed(t *testing.T) {
	e := newEnv(t, wire.LevelFix, nil)
	cl := e.mustDial(t, e.ca.cert(t, certOpts{serial: 60}))
	s, _ := cl.NewSession()
	if err := s.RequestSubsystem("sftp"); err == nil {
		t.Fatal("sftp")
	}
	s2, _ := cl.NewSession()
	if ok, _ := s2.SendRequest("auth-agent-req@openssh.com", true, nil); ok {
		t.Fatal("agent forwarding")
	}
	if _, err := cl.Listen("tcp", "127.0.0.1:0"); err == nil {
		t.Fatal("remote forwarding")
	}
	if _, _, err := cl.OpenChannel("x11", nil); err == nil {
		t.Fatal("an x11 channel")
	}
	e.rec.waitFor(t, "three refusals", func(r *recorder) bool {
		n := 0
		for _, s := range r.visits[60].steps {
			if s.Kind == wire.StepRefused && *s.Reason == wire.ReasonLimit {
				n++
			}
		}
		return n == 3
	})
}

func TestHostKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, HostKeyFile)
	a, err := LoadOrCreateHostKey(path)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("%v", st.Mode())
	}
	b, err := LoadOrCreateHostKey(path)
	if err != nil || !bytes.Equal(a.PublicKey().Marshal(), b.PublicKey().Marshal()) {
		t.Fatalf("the key changed: %v", err)
	}
	line := HostKeyLine(a.PublicKey())
	if !strings.HasPrefix(line, "ssh-ed25519 AAAA") || strings.ContainsAny(line, "\n") || strings.Count(line, " ") != 1 {
		t.Fatalf("%q", line)
	}
	os.Chmod(path, 0o644)
	if _, err := LoadOrCreateHostKey(path); err == nil {
		t.Fatal("a key others can read was used")
	}
	e := newEnv(t, wire.LevelLook, func(c *Config) { c.StateDir = dir; os.Chmod(path, 0o600) })
	if e.srv.HostKey() != line {
		t.Fatal("the server doesn't use the state directory's key")
	}
}

func TestNewRefusesWithoutCAOrLookUser(t *testing.T) {
	g := newGate(wire.LevelLook)
	base := Config{StateDir: t.TempDir(), DeviceID: func() (string, error) { return device, nil }, Gate: g, Recorder: newRecorder()}
	if _, err := New(base); err == nil {
		t.Fatal("no CA key accepted")
	}
	base.CAKeys = []ed25519.PublicKey{newCA(t).pub}
	if _, err := New(base); err == nil {
		t.Fatal("no Look user accepted")
	}
	base.LookUser = "root"
	if _, err := New(base); err == nil {
		t.Fatal("Look as root accepted")
	}
}
