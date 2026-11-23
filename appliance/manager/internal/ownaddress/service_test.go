package ownaddress

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"errors"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"golang.org/x/crypto/acme"
)

// selfSigned is a stand-in for a CA's chain: a leaf for host over [nb, na] with a new key.
func selfSigned(t *testing.T, host string, nb, na time.Time) ([][]byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{SerialNumber: serial, DNSNames: []string{host}, NotBefore: nb, NotAfter: na}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return [][]byte{der}, key
}

type fakeProber struct{ errs []error }

func (p *fakeProber) Probe(context.Context, string) error {
	if len(p.errs) == 0 {
		return nil
	}
	err := p.errs[0]
	p.errs = p.errs[1:]
	return err
}

type fakeOrderer struct {
	t     *testing.T
	store *Store
	now   func() time.Time
	life  time.Duration
	errs  []error
	n     int
	hosts []string
	// during runs inside an order, before it ends (a rename while the certificate is ordered).
	during func()
}

func (o *fakeOrderer) Order(_ context.Context, host string) (*Pair, error) {
	o.hosts = append(o.hosts, host)
	if o.during != nil {
		f := o.during
		o.during = nil
		f()
	}
	if len(o.errs) > 0 {
		err := o.errs[0]
		o.errs = o.errs[1:]
		return nil, err
	}
	o.n++
	now := o.now().Truncate(time.Second)
	chain, key := selfSigned(o.t, host, now, now.Add(o.life))
	return o.store.SavePair(chain, key)
}

func newService(t *testing.T, c *clock) (*Service, *Store, *fakeProber, *fakeOrderer) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "own-address")
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	mode := Mode{Enabled: true, Zone: "dev.whombat.app", Directory: "https://ca.example.com/dir"}
	s, err := Open(mode, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &fakeProber{}
	o := &fakeOrderer{t: t, store: st, now: c.now, life: 90 * 24 * time.Hour}
	s.Prober, s.Orderer, s.Now = p, o, c.now
	return s, st, p, o
}

func register(t *testing.T, s *Service) {
	t.Helper()
	if err := s.Accept(&device.AddressRegisterResponse{Label: "maple-otter-river", Host: testHost, RegisteredAt: 1_790_000_000}); err != nil {
		t.Fatal(err)
	}
}

// step runs the loop, recording every wait (and the state while it waits), advancing the clock by it, until n waits.
func step(t *testing.T, s *Service, c *clock, n int) (waits []time.Duration, states []local.OwnAddressStateResponse) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Sleep = func(ctx context.Context, _ <-chan struct{}, d time.Duration) bool {
		waits = append(waits, d)
		states = append(states, s.State())
		if len(waits) >= n {
			cancel()
			return false
		}
		c.add(d)
		return true
	}
	s.Run(ctx)
	return waits, states
}

func TestServiceWaitsForALabel(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, _, _, o := newService(t, c)
	_, states := step(t, s, c, 2)
	if states[0].Acme.State != local.OwnAddressAcmeStateIdle || states[0].Label != nil || states[0].Cert != nil || o.n != 0 {
		t.Fatalf("before a label: %+v, %d orders", states[0], o.n)
	}
	if err := states[0].Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestServiceOrdersAndRenewsAtTwoThirds(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, st, _, o := newService(t, c)
	register(t, s)
	waits, states := step(t, s, c, 2)
	if o.n != 2 || waits[0] != 60*24*time.Hour || states[0].Acme.State != local.OwnAddressAcmeStateValid {
		t.Fatalf("waits %v, %d orders, state %+v", waits, o.n, states[0])
	}
	if states[0].Cert == nil || states[1].Cert == nil || states[0].Cert.Serial == states[1].Cert.Serial ||
		states[0].Cert.SpkiSHA256 == states[1].Cert.SpkiSHA256 {
		t.Fatal("the renewal kept the serial or the key")
	}
	for _, r := range states {
		if err := r.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	// Both pairs are on disk (the previous one for a runtime that fetched it a moment before), each file 0600.
	saved, _ := st.State()
	if saved.Previous != states[0].Cert.Serial || saved.Current != states[1].Cert.Serial {
		t.Fatalf("saved %+v", saved)
	}
	entries, _ := os.ReadDir(st.Dir())
	for _, e := range entries {
		fi, _ := e.Info()
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s is %v", e.Name(), fi.Mode().Perm())
		}
	}
	if fi, _ := os.Stat(st.Dir()); fi.Mode().Perm() != 0o700 {
		t.Fatalf("the directory is %v", fi.Mode().Perm())
	}
	ordered, _ := st.Ordered()
	if len(ordered) != 2 || ordered[0].Serial != saved.Current {
		t.Fatalf("ordered %+v", ordered)
	}
	cert, ok := s.Cert("")
	if !ok || cert.Serial != saved.Current || cert.Host != testHost || cert.Validate() != nil {
		t.Fatalf("cert %+v", cert)
	}
	// A restart reads the current pair and waits for its renewal without ordering.
	s2, err := Open(s.Mode, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	o2 := &fakeOrderer{t: t, store: st, now: c.now, life: 90 * 24 * time.Hour}
	s2.Prober, s2.Orderer, s2.Now = &fakeProber{}, o2, c.now
	waits, states = step(t, s2, c, 1)
	if o2.n != 0 || states[0].Cert.Serial != saved.Current || states[0].Acme.State != local.OwnAddressAcmeStateValid {
		t.Fatalf("after a restart: %d orders, %+v", o2.n, states[0])
	}
	// Another directory's pair (staging before production) is replaced at once.
	s2.Mode.Directory = "https://other.example.com/dir"
	_, _ = step(t, s2, c, 1)
	if o2.n != 1 {
		t.Fatalf("%d orders for a pair of another directory", o2.n)
	}
}

func TestServiceRetriesWithBackoff(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, _, p, o := newService(t, c)
	register(t, s)
	p.errs = []error{ErrProbe, ErrProbe}
	rate := &acme.Error{StatusCode: http.StatusTooManyRequests, Header: http.Header{"Retry-After": {"3600"}}}
	o.errs = []error{&acme.AuthorizationError{Identifier: testHost}, rate, errors.New("boom")}
	waits, states := step(t, s, c, 6)
	// The probes right after the label are tried again within seconds and don't count towards the backoff.
	want := []time.Duration{probeSoon, probeSoon, time.Minute, time.Hour, 2 * time.Minute}
	for i, w := range want {
		if waits[i] != w {
			t.Fatalf("waits %v, want %v first", waits, want)
		}
	}
	codes := []string{"probe_failed", "probe_failed", "validation_failed", "rate_limited", "order_failed"}
	for i, code := range codes {
		r := states[i]
		if r.Acme.State != local.OwnAddressAcmeStateFailing || r.Acme.Error == nil || *r.Acme.Error != code || r.Acme.NextAttemptAt == nil {
			t.Fatalf("state %d: %+v, want failing %s", i, r.Acme, code)
		}
		if err := r.Validate(); err != nil {
			t.Fatal(err)
		}
	}
	if states[5].Acme.State != local.OwnAddressAcmeStateValid || states[5].Acme.Error != nil || o.n != 1 {
		t.Fatalf("after the retries: %+v, %d orders", states[5].Acme, o.n)
	}
}

func TestServiceRetryCapsAtSixHours(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, _, p, _ := newService(t, c)
	register(t, s)
	soon := int(probeSoonFor / probeSoon)
	for range soon + 12 {
		p.errs = append(p.errs, ErrProbe)
	}
	waits, _ := step(t, s, c, soon+12)
	for i := range soon {
		if waits[i] != probeSoon {
			t.Fatalf("wait %d right after the label: %v", i, waits[i])
		}
	}
	waits = waits[soon:]
	if waits[0] != time.Minute || waits[9] != 6*time.Hour || waits[11] != 6*time.Hour || waits[8] != 256*time.Minute {
		t.Fatalf("waits %v", waits)
	}
}

// A label control gave a while after the start gets the quick probes too: the runtime declares it to the relay only
// once it read it from the manager.
func TestServiceProbesSoonAfterALateLabel(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, _, p, o := newService(t, c)
	p.errs = []error{ErrProbe, ErrProbe}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var waits []time.Duration
	s.Sleep = func(ctx context.Context, _ <-chan struct{}, d time.Duration) bool {
		waits = append(waits, d)
		if len(waits) == 1 {
			// No label yet: an hour later control gives one.
			c.add(time.Hour)
			register(t, s)
			return true
		}
		if len(waits) >= 4 {
			cancel()
			return false
		}
		c.add(d)
		return true
	}
	s.Run(ctx)
	if len(waits) != 4 || waits[1] != probeSoon || waits[2] != probeSoon || o.n != 1 {
		t.Fatalf("waits %v, %d orders", waits, o.n)
	}
}

func TestAcceptChecksTheHost(t *testing.T) {
	c := &clock{t: time.Now()}
	s, st, _, _ := newService(t, c)
	for _, r := range []device.AddressRegisterResponse{
		{Label: "maple-otter-river", Host: "maple-otter-river.box.whombat.app"}, // another zone
		{Label: "maple-otter-river", Host: "other-name-here.dev.whombat.app"},   // another label
		{Label: "Maple-otter-river", Host: "Maple-otter-river.dev.whombat.app"}, // out of shape
	} {
		if err := s.Accept(&r); !errors.Is(err, ErrHostMismatch) {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	if saved, _ := st.State(); saved.Label != "" {
		t.Fatal("a refused answer was saved")
	}
	register(t, s)
	if saved, _ := st.State(); saved.Label != "maple-otter-river" || saved.Host != testHost || saved.RegisteredAt != 1_790_000_000 {
		t.Fatalf("saved %+v", saved)
	}
	if l, h := s.Label(); l != "maple-otter-river" || h != testHost {
		t.Fatal(l, h)
	}
	// A box whose zone moved forgets the name at the next start.
	s2, err := Open(Mode{Enabled: true, Zone: "box.whombat.app"}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if l, _ := s2.Label(); l != "" {
		t.Fatal("kept a name of another zone")
	}
}

func TestCTWithoutAWatch(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
	s, _, _, _ := newService(t, c)
	r, err := s.CT()
	if err != nil {
		t.Fatal(err)
	}
	if r.LastFreshAt != nil || len(r.Certs) != 0 || len(r.Ordered) != 0 || r.Validate() != nil {
		t.Fatalf("%+v", r)
	}
}
