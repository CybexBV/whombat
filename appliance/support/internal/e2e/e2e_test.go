// Package e2e runs remote help end to end in one process: a relay worker (relaytest, following the relay's
// server) → relay.RunWith with the support route's tickets → the SSH server with a test support CA, the real grant and
// the real record → an x/crypto/ssh client with a test certificate, connected through the relay like the support tool.
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/CybexBV/whombat/appliance/support/internal/events"
	"github.com/CybexBV/whombat/appliance/support/internal/fix"
	"github.com/CybexBV/whombat/appliance/support/internal/grant"
	"github.com/CybexBV/whombat/appliance/support/internal/look"
	"github.com/CybexBV/whombat/appliance/support/internal/records"
	"github.com/CybexBV/whombat/appliance/support/internal/relay"
	"github.com/CybexBV/whombat/appliance/support/internal/relay/relaytest"
	"github.com/CybexBV/whombat/appliance/support/internal/sshd"
	"github.com/CybexBV/whombat/appliance/support/internal/wire"
)

const device = "dev_e2eBox01"

type tickets struct{ t relay.Ticket }

func (s tickets) Ticket(context.Context) (relay.Ticket, error) { return s.t, nil }

type recorder struct{ s *records.Store }

func (r recorder) Visit(serial uint64, keyID, who, level string) sshd.Visit {
	return r.s.Visit(serial, keyID, who, level)
}

type box struct {
	relay *relaytest.Relay
	grant *grant.Store
	rec   *records.Store
	ca    ssh.Signer
	host  ssh.PublicKey
}

func start(t *testing.T, env string) *box {
	t.Helper()
	dir := t.TempDir()
	r := relaytest.New("wrk-1")
	t.Cleanup(r.Close)
	tok := relaytest.Token("support-route")
	r.Allow(tok, "wrk-1")

	ev := events.Open(filepath.Join(dir, "events.json"), time.Now, t.Logf)
	rec, err := records.Open(records.Options{Dir: filepath.Join(dir, "visits"), Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rec.Close)
	g, err := grant.Open(grant.Options{Path: filepath.Join(dir, "grant.json"), Environment: env, Events: ev, Logf: t.Logf,
		NewCode: func() (string, error) { return "KQ72MX", nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(g.Close)

	caPub, caPriv, _ := ed25519.GenerateKey(rand.Reader)
	caSigner, _ := ssh.NewSignerFromKey(caPriv)

	binDir := t.TempDir()
	bins := look.DefaultBins(binDir)
	for _, p := range []string{bins.Journalctl, bins.Systemctl, bins.Ps, bins.Df, bins.Lsblk, bins.Free, bins.IP,
		bins.Cat, bins.Uname, bins.Uptime, bins.Readlink} {
		os.WriteFile(p, []byte("#!/bin/sh\nprintf '%s\\n' \"$(basename \"$0\")\" \"$@\"\n"), 0o755)
	}
	lr, err := look.New(look.Config{Bins: bins, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), KeepGroups: true,
		Path: "/usr/bin:/bin"})
	if err != nil {
		t.Fatal(err)
	}
	fr, err := fix.New(fix.Config{Bash: "/bin/bash", Sh: "/bin/sh", Systemctl: "/bin/true", Path: "/usr/bin:/bin",
		Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := sshd.New(sshd.Config{StateDir: dir, CAKeys: []ed25519.PublicKey{caPub},
		DeviceID: func() (string, error) { return device, nil }, Gate: g, Recorder: recorder{rec}, Look: lr, Fix: fr,
		Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	host, _, _, _, err := ssh.ParseAuthorizedKey([]byte(srv.HostKey()))
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- relay.RunWith(ctx, tickets{relay.Ticket{Token: tok, ExpiresAt: time.Now().Add(5 * time.Minute),
			URL: r.URL, Worker: "wrk-1"}}, srv.ServeConn, relay.Options{Logf: t.Logf})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("the relay worker didn't stop")
		}
	})
	wctx, wcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer wcancel()
	if err := r.WaitControl(wctx); err != nil {
		t.Fatal(err)
	}
	return &box{relay: r, grant: g, rec: rec, ca: caSigner, host: host}
}

func (b *box) cert(t *testing.T, serial uint64, principals ...string) ssh.Signer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	user, _ := ssh.NewSignerFromKey(priv)
	now := time.Now()
	c := &ssh.Certificate{Key: user.PublicKey(), Serial: serial, CertType: ssh.UserCert, KeyId: "Claude (op_e2e via john)",
		ValidPrincipals: principals, ValidAfter: uint64(now.Add(-time.Minute).Unix()),
		ValidBefore: uint64(now.Add(4 * time.Hour).Unix()),
		Permissions: ssh.Permissions{Extensions: map[string]string{"permit-pty": "", "permit-port-forwarding": ""}}}
	if err := c.SignCert(rand.Reader, b.ca); err != nil {
		t.Fatal(err)
	}
	s, _ := ssh.NewCertSigner(c, user)
	return s
}

// connect is the support tool: a relay session, then SSH with the box's host key pinned.
func (b *box) connect(t *testing.T, user string, signer ssh.Signer) (*ssh.Client, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := b.relay.Open(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	conn, chans, reqs, err := ssh.NewClientConn(c, device, &ssh.ClientConfig{User: user,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(b.host), Timeout: 10 * time.Second})
	if err != nil {
		return nil, err
	}
	cl := ssh.NewClient(conn, chans, reqs)
	t.Cleanup(func() { cl.Close() })
	return cl, nil
}

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

func stepKinds(t *testing.T, rec *records.Store) []string {
	t.Helper()
	visits, err := rec.List("", 20)
	if err != nil || len(visits) != 1 {
		t.Fatalf("%d visits, %v", len(visits), err)
	}
	var kinds []string
	for _, s := range visits[0].Steps {
		if !wire.StepValid(s) {
			t.Fatalf("invalid step %+v", s)
		}
		k := string(s.Kind)
		if s.Reason != nil {
			k += ":" + string(*s.Reason)
		}
		if s.Command != nil {
			k += ":" + string(*s.Command)
		}
		kinds = append(kinds, k)
	}
	return kinds
}

func TestRemoteHelpThroughTheRelay(t *testing.T) {
	b := start(t, wire.EnvProd)
	if _, err := b.grant.Start(wire.LevelLook, wire.Ptr(int64(3600)), wire.Person{AccountID: "acc_1", Name: "John"}); err != nil {
		t.Fatal(err)
	}
	claude := b.cert(t, 1001, device)

	// A Look command with the help code as the user name, the way an owner reads it out.
	cl, err := b.connect(t, "KQ7·2MX", claude)
	if err != nil {
		t.Fatalf("the right help code: %v", err)
	}
	out, _, code := run(t, cl, "status whombat-voice")
	if code != 0 || !strings.HasPrefix(out, "systemctl\n--no-pager\nshow\n") || !strings.Contains(out, "--unit=whombat-voice\n") {
		t.Fatalf("%d %q", code, out)
	}

	// A Fix command at Look is refused and recorded.
	_, errs, code := run(t, cl, "restart whombat-voice")
	if code != 1 || !strings.Contains(errs, "Look and fix") {
		t.Fatalf("%d %q", code, errs)
	}

	// A wrong help code with a good certificate counts once and is recorded.
	if _, err := b.connect(t, "WRONG1", claude); err == nil {
		t.Fatal("a wrong help code got in")
	}
	if g := b.grant.Grant(); g == nil || g.WrongCodes != 1 {
		t.Fatalf("%+v", g)
	}

	// A certificate for another device gets nowhere and never reaches the help code.
	if _, err := b.connect(t, "KQ72MX", b.cert(t, 1002, "dev_someoneElse")); err == nil {
		t.Fatal("another device's certificate got in")
	}
	if g := b.grant.Grant(); g == nil || g.WrongCodes != 1 {
		t.Fatalf("a refused certificate counted a code: %+v", g)
	}

	want := []string{"connected", "look:status", "refused:level", "wrong_code"}
	if got := stepKinds(t, b.rec); !slices.Equal(got, want) {
		t.Fatalf("steps %v, want %v", got, want)
	}

	// Stopping ends the connection at once.
	if err := b.grant.Stop(wire.StopOwner, &wire.Person{AccountID: "acc_1", Name: "John"}); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { cl.Wait(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the connection outlived the grant")
	}
}

func TestLookAndFixThroughTheRelay(t *testing.T) {
	b := start(t, wire.EnvDev)
	if _, err := b.grant.Start(wire.LevelFix, nil, wire.Person{AccountID: "acc_1", Name: "John"}); err != nil {
		t.Fatal(err)
	}
	cl, err := b.connect(t, "support", b.cert(t, 2001, device))
	if err != nil {
		t.Fatal(err)
	}
	out, _, code := run(t, cl, "echo fixed")
	if code != 0 || out != "fixed\n" {
		t.Fatalf("%d %q", code, out)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			c.Write([]byte("local"))
			c.Close()
		}
	}()
	c, err := cl.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := c.Read(buf); err != nil || string(buf) != "local" {
		t.Fatalf("%q %v", buf, err)
	}
	c.Close()
	visits, _ := b.rec.List("", 1)
	if len(visits) != 1 || visits[0].Who != "Claude" || visits[0].Level != wire.LevelFix {
		t.Fatalf("%+v", visits)
	}
	rc, err := b.rec.Transcript(visits[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	var tr bytes.Buffer
	tr.ReadFrom(rc)
	if !strings.Contains(tr.String(), "fixed\n") {
		t.Fatalf("transcript %q", tr.String())
	}
}
