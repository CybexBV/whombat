package hub

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// listenerCert holds the agent listener's certificate. The CA issues it for
// a year and reissues it within 30 days of expiry; renew swaps the new one
// in without a restart (a hub running for a year used to keep serving the
// expired certificate).
type listenerCert struct {
	cur   atomic.Pointer[tls.Certificate]
	issue func() (tls.Certificate, error)
}

func newListenerCert(issue func() (tls.Certificate, error)) (*listenerCert, error) {
	lc := &listenerCert{issue: issue}
	if err := lc.renew(); err != nil {
		return nil, err
	}
	return lc, nil
}

// renew reloads (or reissues) the certificate.
func (lc *listenerCert) renew() error {
	c, err := lc.issue()
	if err != nil {
		return err
	}
	lc.cur.Store(&c)
	return nil
}

func (lc *listenerCert) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return lc.cur.Load(), nil
}

// notAfter is the expiry of the current certificate (zero when unknown).
func (lc *listenerCert) notAfter() time.Time {
	c := lc.cur.Load()
	if c == nil || len(c.Certificate) == 0 {
		return time.Time{}
	}
	leaf := c.Leaf
	if leaf == nil {
		var err error
		if leaf, err = x509.ParseCertificate(c.Certificate[0]); err != nil {
			return time.Time{}
		}
	}
	return leaf.NotAfter
}

// fileCert serves --tls-cert / --tls-key and reloads them when either file
// changes (ACME clients and `tailscale cert` renew them in place). Files
// are checked at most once a minute; a pair that does not load keeps the
// previous certificate.
type fileCert struct {
	certPath, keyPath string

	mu      sync.Mutex
	cert    *tls.Certificate
	checked time.Time
	mtimes  [2]time.Time
	onError func(error)
}

func newFileCert(certPath, keyPath string, onError func(error)) (*fileCert, error) {
	fc := &fileCert{certPath: certPath, keyPath: keyPath, onError: onError}
	if err := fc.load(); err != nil {
		return nil, err
	}
	return fc, nil
}

func (fc *fileCert) stat() ([2]time.Time, error) {
	var m [2]time.Time
	for i, p := range []string{fc.certPath, fc.keyPath} {
		st, err := os.Stat(p)
		if err != nil {
			return m, err
		}
		m[i] = st.ModTime()
	}
	return m, nil
}

func (fc *fileCert) load() error {
	m, err := fc.stat()
	if err != nil {
		return err
	}
	c, err := tls.LoadX509KeyPair(fc.certPath, fc.keyPath)
	if err != nil {
		return err
	}
	fc.cert, fc.mtimes, fc.checked = &c, m, time.Now()
	return nil
}

func (fc *fileCert) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if time.Since(fc.checked) >= time.Minute {
		fc.checked = time.Now()
		if m, err := fc.stat(); err == nil && m != fc.mtimes {
			if err := fc.load(); err != nil && fc.onError != nil {
				fc.onError(err)
			}
		}
	}
	return fc.cert, nil
}
