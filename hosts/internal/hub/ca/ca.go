// Package ca is the hub's private certificate authority: it issues the
// agent listener's server certificate and the agents' client certificates
// (docs/AGENT-PROTOCOL.md).
package ca

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Lifetimes.
const (
	CALifetime         = 10 * 365 * 24 * time.Hour
	ServerCertLifetime = 365 * 24 * time.Hour
	ClientCertLifetime = 30 * 24 * time.Hour
	// URIPrefix is the URI SAN prefix of client certificates;
	// LegacyURIPrefix is Rackoon's, still accepted.
	URIPrefix       = "whombat:server:"
	LegacyURIPrefix = "rackoon:server:"
)

// File names in the data directory.
const (
	caCertFile     = "ca.crt"
	caKeyFile      = "ca.key"
	serverCertFile = "agent-listener.crt"
	serverKeyFile  = "agent-listener.key"
)

// CA is the loaded certificate authority.
type CA struct {
	Cert    *x509.Certificate
	CertPEM []byte
	key     *ecdsa.PrivateKey
	// Pin is the lowercase hex SHA-256 of the CA certificate's DER.
	Pin string
}

// LoadOrCreate loads dir/ca.crt and dir/ca.key, creating them on first start.
func LoadOrCreate(dir string) (*CA, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	certPath, keyPath := filepath.Join(dir, caCertFile), filepath.Join(dir, caKeyFile)
	certPEM, err1 := os.ReadFile(certPath)
	keyPEM, err2 := os.ReadFile(keyPath)
	if err1 == nil && err2 == nil {
		return parse(certPEM, keyPEM)
	}
	if !errors.Is(err1, os.ErrNotExist) && err1 != nil {
		return nil, err1
	}
	if !errors.Is(err2, os.ErrNotExist) && err2 != nil {
		return nil, err2
	}
	if err1 == nil || err2 == nil {
		return nil, fmt.Errorf("ca: only one of %s and %s exists", certPath, keyPath)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          randSerial(),
		Subject:               pkix.Name{CommonName: "Whombat hosts CA", Organization: []string{"Whombat"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(CALifetime),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	kb, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb})
	if err := writeFile(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}
	if err := writeFile(certPath, certPEM, 0o644); err != nil {
		return nil, err
	}
	return parse(certPEM, keyPEM)
}

func writeFile(path string, b []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func parse(certPEM, keyPEM []byte) (*CA, error) {
	cb, _ := pem.Decode(certPEM)
	if cb == nil {
		return nil, errors.New("ca: bad certificate PEM")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return nil, err
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return nil, errors.New("ca: bad key PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(kb.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("ca: key is not ECDSA")
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, errors.New("ca: the key does not belong to the certificate")
	}
	sum := sha256.Sum256(cert.Raw)
	return &CA{Cert: cert, CertPEM: certPEM, key: key, Pin: hex.EncodeToString(sum[:])}, nil
}

func randSerial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err)
	}
	return n.Add(n, big.NewInt(1))
}

// SerialHex formats a certificate serial as lowercase hex.
func SerialHex(n *big.Int) string { return strings.ToLower(n.Text(16)) }

// Pool returns a cert pool containing the CA.
func (c *CA) Pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c.Cert)
	return p
}

// ServerCertificate returns the agent listener's certificate (chain
// including the CA), issuing a new one when missing, expiring within 30
// days, or not covering hosts.
func (c *CA) ServerCertificate(dir string, hosts []string) (tls.Certificate, error) {
	certPath, keyPath := filepath.Join(dir, serverCertFile), filepath.Join(dir, serverKeyFile)
	if tc, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		leaf, err := x509.ParseCertificate(tc.Certificate[0])
		if err == nil && time.Until(leaf.NotAfter) > 30*24*time.Hour && covers(leaf, hosts) &&
			leaf.CheckSignatureFrom(c.Cert) == nil {
			tc.Leaf = leaf
			tc.Certificate = append(tc.Certificate[:1], c.Cert.Raw)
			return tc, nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: randSerial(),
		Subject:      pkix.Name{CommonName: "Whombat hosts agent listener"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(ServerCertLifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else if h != "" {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.Cert, &key.PublicKey, c.key)
	if err != nil {
		return tls.Certificate{}, err
	}
	kb, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := writeFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, err
	}
	leaf, _ := x509.ParseCertificate(der)
	return tls.Certificate{Certificate: [][]byte{der, c.Cert.Raw}, PrivateKey: key, Leaf: leaf}, nil
}

func covers(leaf *x509.Certificate, hosts []string) bool {
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			if !slices.ContainsFunc(leaf.IPAddresses, func(x net.IP) bool { return x.Equal(ip) }) {
				return false
			}
		} else if h != "" && !slices.Contains(leaf.DNSNames, h) {
			return false
		}
	}
	return true
}

// ParseCSR parses and verifies a PEM certificate signing request. Only
// ECDSA (P-256/P-384) and Ed25519 keys are accepted.
func ParseCSR(csrPEM []byte) (*x509.CertificateRequest, error) {
	b, _ := pem.Decode(csrPEM)
	if b == nil || b.Type != "CERTIFICATE REQUEST" && b.Type != "NEW CERTIFICATE REQUEST" {
		return nil, errors.New("csr: not a PEM certificate request")
	}
	csr, err := x509.ParseCertificateRequest(b.Bytes)
	if err != nil {
		return nil, fmt.Errorf("csr: %w", err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("csr: %w", err)
	}
	switch k := csr.PublicKey.(type) {
	case *ecdsa.PublicKey:
		if k.Curve != elliptic.P256() && k.Curve != elliptic.P384() {
			return nil, errors.New("csr: unsupported curve")
		}
	case ed25519.PublicKey:
	default:
		return nil, errors.New("csr: unsupported key type")
	}
	return csr, nil
}

// Issued is a newly issued client certificate.
type Issued struct {
	PEM      []byte
	Serial   string
	NotAfter time.Time
}

// SignClient issues a client certificate for a server id from a CSR: CN =
// server id, URI SAN whombat:server:<id>, 30 days.
func (c *CA) SignClient(csrPEM []byte, serverID string, now time.Time) (Issued, error) {
	csr, err := ParseCSR(csrPEM)
	if err != nil {
		return Issued{}, err
	}
	u, err := url.Parse(URIPrefix + serverID)
	if err != nil {
		return Issued{}, err
	}
	serial := randSerial()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: serverID},
		URIs:         []*url.URL{u},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(ClientCertLifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.Cert, csr.PublicKey.(crypto.PublicKey), c.key)
	if err != nil {
		return Issued{}, err
	}
	return Issued{
		PEM:      pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		Serial:   SerialHex(serial),
		NotAfter: tmpl.NotAfter.UTC(),
	}, nil
}

// ClientIdentity extracts the server id from a verified client certificate
// (URI SAN whombat:server:<id> or Rackoon's rackoon:server:<id>, else the
// CN).
func ClientIdentity(cert *x509.Certificate) string {
	for _, u := range cert.URIs {
		for _, pfx := range []string{URIPrefix, LegacyURIPrefix} {
			if s := u.String(); strings.HasPrefix(s, pfx) {
				return strings.TrimPrefix(s, pfx)
			}
		}
	}
	return cert.Subject.CommonName
}

// PinOf returns the pin (hex SHA-256 of DER) of a PEM certificate.
func PinOf(certPEM []byte) (string, error) {
	b, _ := pem.Decode(certPEM)
	if b == nil {
		return "", errors.New("bad PEM")
	}
	sum := sha256.Sum256(b.Bytes)
	return hex.EncodeToString(sum[:]), nil
}

// Equal reports whether two PEM certificates are the same.
func Equal(a, b []byte) bool {
	pa, _ := pem.Decode(a)
	pb, _ := pem.Decode(b)
	return pa != nil && pb != nil && bytes.Equal(pa.Bytes, pb.Bytes)
}
