package ownaddress

// Orders against Pebble, the ACME test server, through a stand-in for the path a validator takes (DNS → door → relay
// → runtime): a TCP listener on Pebble's TLS-ALPN-01 port that pipes each connection into the ACME socket.
//
// They need Pebble and its DNS stand-in (github.com/letsencrypt/pebble/v2 v2.10.3, cmd/pebble and
// cmd/pebble-challtestsrv): WHOMBAT_PEBBLE names the folder with both binaries; without it the tests are skipped.
// Run them in a managed task (they start local processes on loopback ports):
//
//	agent-resource run --task "own address: pebble" --ttl 30m -- \
//	  env WHOMBAT_PEBBLE=<folder> go test -run Pebble -count=1 ./manager/internal/ownaddress/

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type pebble struct {
	dir      string // the order's state directory
	caFile   string // the root of Pebble's own HTTPS
	dirURL   string
	mgmt     string
	door     string // the validator's way in (Pebble's tlsPort)
	open     atomic.Bool
	sock     string
	resp     *Responder
	accepted atomic.Int64
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// writeLocalhostCert makes a throwaway CA and a 127.0.0.1 certificate for Pebble's HTTPS listeners.
func writeLocalhostCert(t *testing.T, dir string) (caFile, certFile, keyFile string) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "own-address test CA"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	caFile, certFile, keyFile = filepath.Join(dir, "ca.pem"), filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	for f, b := range map[string][]byte{
		caFile:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		certFile: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		keyFile:  pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	} {
		if err := os.WriteFile(f, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return caFile, certFile, keyFile
}

func waitPort(t *testing.T, addr string) {
	t.Helper()
	for range 200 {
		if c, err := net.Dial("tcp", addr); err == nil {
			c.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never opened", addr)
}

// startPebble runs Pebble (certificates valid for validity) and its DNS stand-in, which answers 127.0.0.1 for every
// name, and a door that pipes Pebble's validation connections into a responder.
func startPebble(t *testing.T, validity time.Duration) *pebble {
	t.Helper()
	bin := os.Getenv("WHOMBAT_PEBBLE")
	if bin == "" {
		t.Skip("WHOMBAT_PEBBLE (a folder with pebble and pebble-challtestsrv) is not set")
	}
	work, err := os.MkdirTemp(os.Getenv("TMPDIR"), "pebble")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(work) })
	caFile, certFile, keyFile := writeLocalhostCert(t, work)
	dns, dnsMgmt, listen, mgmt, httpPort, door := freePort(t), freePort(t), freePort(t), freePort(t), freePort(t), freePort(t)
	cfg := map[string]any{"pebble": map[string]any{
		"listenAddress": fmt.Sprintf("127.0.0.1:%d", listen), "managementListenAddress": fmt.Sprintf("127.0.0.1:%d", mgmt),
		"certificate": certFile, "privateKey": keyFile, "httpPort": httpPort, "tlsPort": door, "ocspResponderURL": "",
		"externalAccountBindingRequired": false, "retryAfter": map[string]any{"authz": 1, "order": 1}, "keyAlgorithm": "ecdsa",
		"profiles": map[string]any{"default": map[string]any{"description": "default", "validityPeriod": int(validity / time.Second)}},
	}}
	b, _ := json.Marshal(cfg)
	cfgFile := filepath.Join(work, "pebble.json")
	if err := os.WriteFile(cfgFile, b, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var procs sync.WaitGroup
	t.Cleanup(func() { cancel(); procs.Wait() })
	run := func(name string, env []string, args ...string) {
		cmd := exec.CommandContext(ctx, filepath.Join(bin, name), args...)
		cmd.Env = append(os.Environ(), env...)
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		procs.Add(1)
		go func() {
			defer procs.Done()
			_ = cmd.Wait()
			if ctx.Err() == nil {
				t.Errorf("%s stopped:\n%s", name, out.String())
			}
		}()
	}
	run("pebble-challtestsrv", nil, "-dnsserver", fmt.Sprintf("127.0.0.1:%d", dns), "-management", fmt.Sprintf("127.0.0.1:%d", dnsMgmt),
		"-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "", "-defaultIPv4", "127.0.0.1", "-defaultIPv6", "")
	waitPort(t, fmt.Sprintf("127.0.0.1:%d", dnsMgmt))
	// No sleeping between validation attempts, no random nonce refusals, and every order validated anew.
	run("pebble", []string{"PEBBLE_VA_NOSLEEP=1", "PEBBLE_WFE_NONCEREJECT=0", "PEBBLE_AUTHZREUSE=0"},
		"-config", cfgFile, "-dnsserver", fmt.Sprintf("127.0.0.1:%d", dns))
	waitPort(t, fmt.Sprintf("127.0.0.1:%d", listen))

	p := &pebble{caFile: caFile, dirURL: fmt.Sprintf("https://127.0.0.1:%d/dir", listen), mgmt: fmt.Sprintf("https://127.0.0.1:%d", mgmt)}
	p.open.Store(true)
	p.dir = filepath.Join(work, "own-address")
	p.resp, p.sock = startResponder(t, uint32(os.Getuid()), 0)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", door))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	p.door = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				if !p.open.Load() {
					return // the route ends nowhere: the validator's connection is closed
				}
				p.accepted.Add(1)
				u, err := net.Dial("unix", p.sock)
				if err != nil {
					return
				}
				defer u.Close()
				go func() { _, _ = io.Copy(u, c) }()
				_, _ = io.Copy(c, u)
			}()
		}
	}()
	return p
}

// root is Pebble's issuing root, made fresh at each start.
func (p *pebble) root(t *testing.T) *x509.CertPool {
	t.Helper()
	hc, err := HTTPClientWithCA(p.caFile)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := hc.Get(p.mgmt + "/roots/0")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b) {
		t.Fatalf("no root: %s", b)
	}
	return pool
}

// logLines collects the orderer's log lines.
type logLines struct {
	mu    sync.Mutex
	lines []string
}

func (l *logLines) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, string(b))
	return len(b), nil
}

func (l *logLines) has(s string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, s) {
			return true
		}
	}
	return false
}

func (p *pebble) orderer(t *testing.T) (*Orderer, *Store, *logLines) {
	t.Helper()
	st, err := OpenStore(p.dir)
	if err != nil {
		t.Fatal(err)
	}
	hc, err := HTTPClientWithCA(p.caFile)
	if err != nil {
		t.Fatal(err)
	}
	logs := &logLines{}
	return &Orderer{Directory: p.dirURL, HTTP: hc, Store: st, Responder: p.resp, OrderTimeout: time.Minute,
		Log: slog.New(slog.NewTextHandler(io.MultiWriter(logs, os.Stderr), nil))}, st, logs
}

// An order through the door: the certificate chains to Pebble's root, names the host, and its key and the account
// key exist only in the state directory, 0600. The CA finishes the order after its finalize answer, which carries no
// order URL; the orderer waits on the order's own URL.
func TestPebbleOrder(t *testing.T) {
	p := startPebble(t, 90*24*time.Hour)
	o, st, logs := p.orderer(t)
	pair, err := o.Order(context.Background(), testHost)
	if err != nil {
		t.Fatal(err)
	}
	if p.accepted.Load() == 0 {
		t.Fatal("no validation came through the door")
	}
	// Pebble always issues after its finalize answer, without a Location: the later-finishing path must have run.
	if !logs.has("waiting on the order itself") {
		t.Fatal("the order that finishes later didn't take the fallback")
	}
	blk, rest := pem.Decode([]byte(pair.CertPEM))
	leaf, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	inter := x509.NewCertPool()
	for len(rest) > 0 {
		var b *pem.Block
		if b, rest = pem.Decode(rest); b == nil {
			break
		}
		c, _ := x509.ParseCertificate(b.Bytes)
		inter.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: testHost, Roots: p.root(t), Intermediates: inter}); err != nil {
		t.Fatalf("doesn't chain to Pebble's root: %v", err)
	}
	if pair.Meta.SpkiSHA256 != SPKIHash(leaf) || !serialRe.MatchString(pair.Meta.Serial) {
		t.Fatalf("meta %+v", pair.Meta)
	}
	entries, _ := os.ReadDir(st.Dir())
	var names []string
	for _, e := range entries {
		fi, _ := e.Info()
		names = append(names, e.Name())
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s is %v", e.Name(), fi.Mode().Perm())
		}
	}
	for _, want := range []string{"account.key", pair.Meta.Serial + ".key", pair.Meta.Serial + ".pem", "ordered.json"} {
		if !strings.Contains(strings.Join(names, " "), want) {
			t.Fatalf("%s missing from %v", want, names)
		}
	}
	// A second order: a new key, a new serial, the same account.
	acct, _ := os.ReadFile(filepath.Join(st.Dir(), "account.key"))
	pair2, err := o.Order(context.Background(), testHost)
	if err != nil {
		t.Fatal(err)
	}
	acct2, _ := os.ReadFile(filepath.Join(st.Dir(), "account.key"))
	if pair2.Meta.SpkiSHA256 == pair.Meta.SpkiSHA256 || pair2.Meta.Serial == pair.Meta.Serial || !bytes.Equal(acct, acct2) {
		t.Fatal("the second order reused the key or the serial, or changed the account")
	}
}

// A validation that can't reach the box fails as validation_failed; the next order, with the path open again, works.
func TestPebbleRetryAfterAFailedValidation(t *testing.T) {
	p := startPebble(t, 90*24*time.Hour)
	o, _, _ := p.orderer(t)
	p.open.Store(false)
	_, err := o.Order(context.Background(), testHost)
	var oe *OrderError
	if !errors.As(err, &oe) || oe.Code != "validation_failed" {
		t.Fatalf("err = %v, want validation_failed", err)
	}
	p.open.Store(true)
	if _, err := o.Order(context.Background(), testHost); err != nil {
		t.Fatalf("the retry: %v", err)
	}
}

// The whole loop against Pebble: probe, order, then a renewal at two thirds of a short lifetime with a new key.
func TestPebbleRenewsAtTwoThirds(t *testing.T) {
	p := startPebble(t, 30*time.Second)
	o, st, _ := p.orderer(t)
	s, err := Open(Mode{Enabled: true, Zone: "dev.whombat.app", Directory: p.dirURL}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.Responder, s.Orderer = p.resp, o
	s.Prober = &Prober{Responder: p.resp, Addr: p.door, Timeout: 5 * time.Second}
	register(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	var first, second *Pair
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		cur := s.pair
		s.mu.Unlock()
		switch {
		case cur == nil:
		case first == nil:
			first = cur
		case cur.Meta.Serial != first.Meta.Serial:
			second = cur
		}
		if second != nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if first == nil || second == nil {
		t.Fatalf("no renewal within 90 s: state %+v", s.State())
	}
	if renewed := time.Now(); renewed.Before(first.RenewAt()) {
		t.Fatalf("renewed at %s, before two thirds (%s)", renewed, first.RenewAt())
	}
	if second.Meta.SpkiSHA256 == first.Meta.SpkiSHA256 {
		t.Fatal("the renewal kept the key")
	}
	if st := s.State(); st.Acme.State != "valid" || st.Cert == nil || st.Cert.Serial != second.Meta.Serial {
		t.Fatalf("state %+v", st)
	}
}

// A rename against Pebble: the loop orders the new host's certificate through the door at once, and the old host keeps
// the pair it had, with no order for it.
func TestPebbleRename(t *testing.T) {
	p := startPebble(t, 90*24*time.Hour)
	o, st, _ := p.orderer(t)
	s, err := Open(Mode{Enabled: true, Zone: "dev.whombat.app", Directory: p.dirURL}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.Responder, s.Orderer = p.resp, o
	s.Prober = &Prober{Responder: p.resp, Addr: p.door, Timeout: 5 * time.Second}
	register(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	waitCert := func(host string) *local.OwnAddressCertResponse {
		t.Helper()
		for deadline := time.Now().Add(60 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			if c, ok := s.Cert(""); ok && c.Host == host {
				return c
			}
		}
		t.Fatalf("no certificate for %s within 60 s: state %+v", host, s.State())
		return nil
	}
	first := waitCert(testHost)
	const renamed = "home-box.dev.whombat.app"
	if _, err := s.Adopt(Address{Label: "home-box", Host: renamed,
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: testHost, Until: time.Now().Add(30 * 24 * time.Hour).Unix()}}); err != nil {
		t.Fatal(err)
	}
	second := waitCert(renamed)
	blk, _ := pem.Decode([]byte(second.CertPem))
	leaf, err := x509.ParseCertificate(blk.Bytes)
	if err != nil || leaf.VerifyHostname(renamed) != nil {
		t.Fatalf("the new pair doesn't name %s: %v", renamed, err)
	}
	if c, ok := s.Cert(testHost); !ok || c.Serial != first.Serial {
		t.Fatal("the old host lost its pair")
	}
	if ordered, _ := st.Ordered(); len(ordered) != 2 {
		t.Fatalf("%d orders, want 2", len(ordered))
	}
}
