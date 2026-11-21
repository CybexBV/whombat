package agent

import (
	"crypto"
	"crypto/ecdsa"
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
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RenewBefore is how long before expiry the agent asks for a new client
// certificate (Hello.CSR).
const RenewBefore = 10 * 24 * time.Hour

// NormalizePin lowercases a CA pin and strips ':' separators and spaces.
func NormalizePin(pin string) string {
	pin = strings.ToLower(strings.TrimSpace(pin))
	pin = strings.ReplaceAll(pin, ":", "")
	return strings.ReplaceAll(pin, " ", "")
}

// ValidPin reports whether pin (normalized) looks like a hex SHA-256.
func ValidPin(pin string) bool {
	b, err := hex.DecodeString(NormalizePin(pin))
	return err == nil && len(b) == sha256.Size
}

// CertPin returns the lowercase hex SHA-256 of a certificate's DER.
func CertPin(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

// GenerateKey creates an ECDSA P-256 key and writes it to path (PEM,
// PKCS#8, mode 0600).
func GenerateKey(path string) (*ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := WriteFileAtomic(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// LoadKey reads a PEM private key (PKCS#8 or SEC1 EC).
func LoadKey(path string) (crypto.Signer, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("%s: no private key found", path)
		}
		switch blk.Type {
		case "PRIVATE KEY":
			k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			s, ok := k.(crypto.Signer)
			if !ok {
				return nil, fmt.Errorf("%s: unsupported key type", path)
			}
			return s, nil
		case "EC PRIVATE KEY":
			k, err := x509.ParseECPrivateKey(blk.Bytes)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			return k, nil
		}
	}
}

// CreateCSR returns a PEM certificate signing request for key.
func CreateCSR(key crypto.Signer, commonName string) ([]byte, error) {
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: commonName},
	}, key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// ParseCertsPEM parses all CERTIFICATE blocks in b.
func ParseCertsPEM(b []byte) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, errors.New("no certificate found")
	}
	return out, nil
}

// LoadCertFile parses the first certificate of a PEM file.
func LoadCertFile(path string) (*x509.Certificate, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cs, err := ParseCertsPEM(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cs[0], nil
}

// samePublicKey reports whether the certificate carries key's public key.
func samePublicKey(c *x509.Certificate, key crypto.Signer) bool {
	type equaler interface{ Equal(crypto.PublicKey) bool }
	pk, ok := key.Public().(equaler)
	return ok && pk.Equal(c.PublicKey)
}

// VerifyClientCert checks that certPEM is a client certificate for key
// issued by ca, and returns it.
func VerifyClientCert(certPEM []byte, key crypto.Signer, ca *x509.Certificate) (*x509.Certificate, error) {
	cs, err := ParseCertsPEM(certPEM)
	if err != nil {
		return nil, err
	}
	leaf := cs[0]
	if !samePublicKey(leaf, key) {
		return nil, errors.New("certificate does not match the agent key")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	inter := x509.NewCertPool()
	for _, c := range cs[1:] {
		inter.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inter,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		return nil, fmt.Errorf("certificate not issued by the hub CA: %w", err)
	}
	return leaf, nil
}

// verifyServerChain verifies the hub's presented chain against root (no
// hostname check: the CA is private and pinned).
func verifyServerChain(peer []*x509.Certificate, root *x509.Certificate) error {
	if len(peer) == 0 {
		return errors.New("hub presented no certificate")
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	inter := x509.NewCertPool()
	for _, c := range peer[1:] {
		inter.AddCert(c)
	}
	_, err := peer[0].Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inter,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	return err
}

// PinnedTLSConfig is used on first contact (enrollment): the hub is accepted
// only if its chain contains a CA certificate whose SHA-256 equals pin and
// the leaf verifies against that CA. The CA found is stored in *found.
func PinnedTLSConfig(pin string, found **x509.Certificate) *tls.Config {
	pin = NormalizePin(pin)
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		NextProtos:         []string{"http/1.1"},
		InsecureSkipVerify: true, // replaced by VerifyConnection below
		VerifyConnection: func(cs tls.ConnectionState) error {
			for _, c := range cs.PeerCertificates {
				if c.IsCA && CertPin(c) == pin {
					if err := verifyServerChain(cs.PeerCertificates, c); err != nil {
						return fmt.Errorf("hub certificate: %w", err)
					}
					if found != nil {
						*found = c
					}
					return nil
				}
			}
			return errors.New("hub CA does not match the pinned ca_sha256")
		},
	}
}

// CATLSConfig verifies the hub against a stored CA and presents the client
// certificate returned by getCert (may be nil).
func CATLSConfig(ca *x509.Certificate, getCert func() *tls.Certificate) *tls.Config {
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		NextProtos:         []string{"http/1.1"},
		InsecureSkipVerify: true, // replaced by VerifyConnection below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if err := verifyServerChain(cs.PeerCertificates, ca); err != nil {
				return fmt.Errorf("hub certificate: %w", err)
			}
			return nil
		},
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			if getCert == nil {
				return &tls.Certificate{}, nil
			}
			if c := getCert(); c != nil {
				return c, nil
			}
			return &tls.Certificate{}, nil
		},
	}
}

// WriteFileAtomic writes data to a temp file in the same directory and
// renames it over path.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after a successful rename
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Identity is the agent's TLS identity loaded from the config directory.
type Identity struct {
	Key  crypto.Signer
	Cert *x509.Certificate
	CA   *x509.Certificate
	TLS  tls.Certificate
}

// LoadIdentity reads agent.key, agent.crt and ca.crt and checks that the CA
// matches the configured pin.
func LoadIdentity(cfg *Config) (*Identity, error) {
	key, err := LoadKey(cfg.KeyPath())
	if err != nil {
		return nil, err
	}
	ca, err := LoadCertFile(cfg.CAPath())
	if err != nil {
		return nil, err
	}
	if cfg.CASHA256 != "" && CertPin(ca) != NormalizePin(cfg.CASHA256) {
		return nil, fmt.Errorf("%s does not match ca_sha256 in %s", cfg.CAPath(), ConfigFileName)
	}
	certPEM, err := os.ReadFile(cfg.CertPath())
	if err != nil {
		return nil, err
	}
	id := &Identity{Key: key, CA: ca}
	if err := id.setCert(certPEM); err != nil {
		return nil, fmt.Errorf("%s: %w", cfg.CertPath(), err)
	}
	return id, nil
}

func (id *Identity) setCert(certPEM []byte) error {
	cs, err := ParseCertsPEM(certPEM)
	if err != nil {
		return err
	}
	if !samePublicKey(cs[0], id.Key) {
		return errors.New("certificate does not match the agent key")
	}
	tc := tls.Certificate{PrivateKey: id.Key, Leaf: cs[0]}
	for _, c := range cs {
		tc.Certificate = append(tc.Certificate, c.Raw)
	}
	id.Cert = cs[0]
	id.TLS = tc
	return nil
}

// NeedsRenewal reports whether the client certificate expires within
// RenewBefore.
func (id *Identity) NeedsRenewal(now time.Time) bool {
	return id.Cert.NotAfter.Sub(now) < RenewBefore
}
