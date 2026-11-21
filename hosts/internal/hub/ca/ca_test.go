package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func csrPEM(t *testing.T, key any) []byte {
	t.Helper()
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "x"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
}

func TestLoadOrCreateIsStable(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if a.Pin == "" || a.Pin != b.Pin {
		t.Fatalf("pin changed: %q %q", a.Pin, b.Pin)
	}
	if pin, _ := PinOf(a.CertPEM); pin != a.Pin {
		t.Fatal("PinOf disagrees with the CA pin")
	}
	if st, err := os.Stat(filepath.Join(dir, "ca.key")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("ca.key mode: %v %v", st.Mode(), err)
	}
	if time.Until(a.Cert.NotAfter) < 9*365*24*time.Hour || !a.Cert.IsCA {
		t.Fatalf("CA certificate: not after %v, CA %v", a.Cert.NotAfter, a.Cert.IsCA)
	}
}

func TestSignClient(t *testing.T) {
	c, err := LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	now := time.Now()
	iss, err := c.SignClient(csrPEM(t, key), "thetitan", now)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := pem.Decode(iss.PEM)
	cert, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if ClientIdentity(cert) != "thetitan" || SerialHex(cert.SerialNumber) != iss.Serial {
		t.Fatalf("identity %q serial %q", ClientIdentity(cert), iss.Serial)
	}
	if d := cert.NotAfter.Sub(now); d < ClientCertLifetime-time.Minute || d > ClientCertLifetime+time.Minute {
		t.Fatalf("lifetime %v", d)
	}
	if _, err := cert.Verify(x509.VerifyOptions{Roots: c.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("does not verify against the CA: %v", err)
	}
	// Serials are unique.
	iss2, _ := c.SignClient(csrPEM(t, key), "thetitan", now)
	if iss2.Serial == iss.Serial {
		t.Fatal("serial reused")
	}
}

func TestParseCSRRejects(t *testing.T) {
	if _, err := ParseCSR([]byte("garbage")); err == nil {
		t.Error("garbage accepted")
	}
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	if _, err := ParseCSR(csrPEM(t, rk)); err == nil {
		t.Error("RSA key accepted (only ECDSA and Ed25519 are)")
	}
	p224, _ := ecdsa.GenerateKey(elliptic.P224(), rand.Reader)
	if _, err := ParseCSR(csrPEM(t, p224)); err == nil {
		t.Error("P-224 accepted")
	}
	good, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	csr := csrPEM(t, good)
	b, _ := pem.Decode(csr)
	b.Bytes[len(b.Bytes)-1] ^= 0xff // break the signature
	if _, err := ParseCSR(pem.EncodeToMemory(b)); err == nil {
		t.Error("CSR with a bad signature accepted")
	}
}

func TestServerCertificateReissue(t *testing.T) {
	dir := t.TempDir()
	c, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, err := c.ServerCertificate(dir, []string{"hub.example", "10.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := c.ServerCertificate(dir, []string{"hub.example", "10.0.0.1"})
	if a.Leaf.SerialNumber.Cmp(b.Leaf.SerialNumber) != 0 {
		t.Fatal("a valid certificate was reissued")
	}
	if len(a.Certificate) != 2 {
		t.Fatalf("chain has %d certificates, want leaf + CA", len(a.Certificate))
	}
	// A new host name is not covered: reissued.
	n, _ := c.ServerCertificate(dir, []string{"other.example"})
	if n.Leaf.SerialNumber.Cmp(a.Leaf.SerialNumber) == 0 || n.Leaf.VerifyHostname("other.example") != nil {
		t.Fatal("certificate not reissued for a new host")
	}
}

func TestClientIdentityPrefixes(t *testing.T) {
	for uri, want := range map[string]string{"whombat:server:pve-02": "pve-02", "rackoon:server:pve-01": "pve-01", "other:x": "cn"} {
		u, _ := url.Parse(uri)
		if got := ClientIdentity(&x509.Certificate{Subject: pkix.Name{CommonName: "cn"}, URIs: []*url.URL{u}}); got != want {
			t.Errorf("%s: %q, want %q", uri, got, want)
		}
	}
}
