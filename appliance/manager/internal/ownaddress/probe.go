package ownaddress

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"time"

	"golang.org/x/crypto/acme"
)

// Prober checks the whole path before every order (MG-164, plan D5): DNS → door → relay → runtime → the ACME socket.
// It dials the box's own name on 443 with ALPN acme-tls/1, as a validator would, and expects back the one-off
// certificate it just handed the responder. A CA's failed validation costs (Let's Encrypt allows 5 an hour per name);
// a failed probe costs nothing.
type Prober struct {
	Responder *Responder
	// Addr replaces <host>:443 (tests: the DNS stand-in); empty: the real name.
	Addr string
	// Timeout bounds one probe (0: 20 s).
	Timeout time.Duration
	// Dialer dials the path (nil: a plain net.Dialer).
	Dialer interface {
		DialContext(ctx context.Context, network, addr string) (net.Conn, error)
	}
}

// ErrProbe is every probe failure: the path doesn't reach this box's ACME socket.
var ErrProbe = errors.New("the probe didn't come back to this box")

// Probe runs one probe for host.
func (p *Prober) Probe(ctx context.Context, host string) error {
	cert, err := probeCert(host)
	if err != nil {
		return err
	}
	p.Responder.SetProbe(host, cert)
	defer p.Responder.ClearProbe(host)
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	addr := p.Addr
	if addr == "" {
		addr = net.JoinHostPort(host, "443")
	}
	var d interface {
		DialContext(ctx context.Context, network, addr string) (net.Conn, error)
	} = &net.Dialer{}
	if p.Dialer != nil {
		d = p.Dialer
	}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("%w: dial: %v", ErrProbe, err)
	}
	defer raw.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(dl)
	}
	want := cert.Certificate[0]
	tc := tls.Client(raw, &tls.Config{
		ServerName: host,
		NextProtos: []string{acme.ALPNProto},
		MinVersion: tls.VersionTLS12,
		// Trust is exactly one certificate: the one made for this probe.
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 || !bytes.Equal(cs.PeerCertificates[0].Raw, want) {
				return errors.New("another certificate came back")
			}
			return nil
		},
	})
	if err := tc.HandshakeContext(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrProbe, err)
	}
	_ = tc.Close()
	return nil
}

// probeCert is a self-signed certificate for host with a fresh key and a random serial: nobody else can produce it.
func probeCert(host string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "whombat own-address probe"},
		DNSNames: []string{host}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
