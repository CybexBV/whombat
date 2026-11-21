package licence_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/licence"
	"github.com/CybexBV/whombat/appliance/manager/internal/licence/licencetest"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

const day = 86400

var (
	signer = licencetest.NewSigner("unit", "lic-test-1")
	other  = licencetest.NewSigner("other", "lic-test-1") // same kid, another key: a forgery
)

func verifier(t *testing.T) licence.Verifier {
	t.Helper()
	ks := licencetest.KeySet("dev", signer)
	return licence.Verifier{Keys: &ks, Device: "dev-1"}
}

func token(iat int64, edit ...func(*protocol.LicenceClaims)) string {
	c := licencetest.Claims("dev", "dev-1", "org-1", "active", iat, 14*day)
	for _, e := range edit {
		e(&c)
	}
	return signer.Sign(c)
}

func code(err error) protocol.LicenceErrorCode {
	var le *protocol.LicenceError
	if errors.As(err, &le) {
		return le.Code
	}
	return ""
}

func TestAcceptRaisesHighWater(t *testing.T) {
	v := verifier(t)
	now := time.Now().Unix()
	h, changed, err := v.Accept(licence.Held{}, token(now-10), now+5, now)
	if err != nil || !changed {
		t.Fatalf("accept: %v %v", changed, err)
	}
	if h.HighWater != now+5 || h.Claims.Iat != now-10 {
		t.Fatalf("highWater %d (want control's now %d), iat %d", h.HighWater, now+5, h.Claims.Iat)
	}
	// A newer token with control's clock behind the held mark: the mark stays.
	h2, changed, err := v.Accept(h, token(now), now-3600, now)
	if err != nil || !changed || h2.HighWater != now+5 {
		t.Fatalf("second: %v %v hw %d", changed, err, h2.HighWater)
	}
}

// Clock rollback (LC-06): with the local clock 60 days back a fresh token still verifies (the effective time is
// max(local, highWater, control's now)), and the mark never goes down.
func TestClockRollback(t *testing.T) {
	v := verifier(t)
	now := time.Now().Unix()
	h, _, err := v.Accept(licence.Held{}, token(now), now, now)
	if err != nil {
		t.Fatal(err)
	}
	back := now - 60*day
	h2, _, err := v.Accept(h, token(now+10), now+10, back)
	if err != nil {
		t.Fatalf("token refused with the clock rolled back: %v", err)
	}
	if h2.HighWater < h.HighWater {
		t.Fatalf("highWater went down: %d < %d", h2.HighWater, h.HighWater)
	}
	// Control's clock rolled back too: its token is older than the held one → stale, nothing changes.
	h3, changed, err := v.Accept(h2, token(back), back, back)
	if !errors.Is(err, licence.ErrStale) || changed || h3.Token != h2.Token || h3.HighWater != h2.HighWater {
		t.Fatalf("stale: %v %v", changed, err)
	}
}

func TestRefusedTokens(t *testing.T) {
	v := verifier(t)
	now := time.Now().Unix()
	held, _, _ := v.Accept(licence.Held{}, token(now), now, now)
	adm := licencetest.Claims("dev", "dev-1", "org-1", "active", now, 14*day)
	for name, c := range map[string]struct {
		tok  string
		want protocol.LicenceErrorCode
	}{
		"forged (another key, same kid)": {other.Sign(licencetest.Claims("dev", "dev-1", "org-1", "active", now, 14*day)), protocol.LicenceBadSignature},
		"unknown kid":                    {licencetest.NewSigner("x", "lic-other").Sign(adm), protocol.LicenceUnknownKid},
		"foreign device":                 {token(now, func(c *protocol.LicenceClaims) { c.Sub = "dev-2" }), protocol.LicenceWrongDevice},
		"another environment":            {token(now, func(c *protocol.LicenceClaims) { c.Aud = protocol.LicenceAudience("prod") }), protocol.LicenceWrongAudience},
		"admission typ":                  {signer.SignTyp(adm, "whombat-admission+jwt"), protocol.LicenceBadHeader},
		"too long":                       {token(now, func(c *protocol.LicenceClaims) { c.Exp = now + 15*day }), protocol.LicenceBadLifetime},
		"from the future":                {token(now + day), protocol.LicenceNotYetValid},
	} {
		t.Run(name, func(t *testing.T) {
			h, changed, err := v.Accept(held, c.tok, now, now)
			if code(err) != c.want || changed || h.Token != held.Token {
				t.Fatalf("got %v (%s), changed %v", err, code(err), changed)
			}
		})
	}
}

func TestSaveLoad(t *testing.T) {
	v := verifier(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "licence.json")
	if h, dropped, err := v.Load(p, 0); err != nil || dropped != nil || h.Token != "" {
		t.Fatalf("missing file: %+v %v %v", h, dropped, err)
	}
	now := time.Now().Unix()
	h, _, _ := v.Accept(licence.Held{}, token(now), now+30, now)
	if err := licence.Save(p, h); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", st.Mode(), err)
	}
	got, dropped, err := v.Load(p, now-90*day) // a restart with the clock rolled back
	if err != nil || dropped != nil || got.Token != h.Token || got.HighWater != h.HighWater {
		t.Fatalf("load: %+v %v %v", got, dropped, err)
	}
	// Another key set (e.g. an image that dropped the key): the token is dropped, the mark kept.
	ks := licencetest.KeySet("dev", other)
	got, dropped, err = licence.Verifier{Keys: &ks, Device: "dev-1"}.Load(p, now)
	if err != nil || dropped == nil || got.Token != "" || got.HighWater != h.HighWater {
		t.Fatalf("other keys: %+v %v %v", got, dropped, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("temporary files left: %v", entries)
	}
}

func TestLoadKeys(t *testing.T) {
	dir := t.TempDir()
	p, err := licencetest.WriteKeySet(dir, licencetest.KeySet("dev", signer))
	if err != nil {
		t.Fatal(err)
	}
	if ks, err := licence.LoadKeys(p); err != nil || ks.Env != "dev" || len(ks.Keys) != 1 {
		t.Fatalf("%+v %v", ks, err)
	}
	bad := filepath.Join(dir, "bad.json")
	os.WriteFile(bad, []byte(`{"v":1,"env":"dev","keys":[],"extra":1}`), 0o444)
	if _, err := licence.LoadKeys(bad); err == nil {
		t.Fatal("a malformed key set was accepted")
	}
}
