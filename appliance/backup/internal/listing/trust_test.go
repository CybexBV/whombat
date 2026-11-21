package listing

import (
	"crypto/ed25519"
	"fmt"
	"os"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Once one of an earlier Whombat's backups was brought back, its key is trusted only for the backups it had made by
// then; the box's own, and a key adopted later from another Whombat, aren't bounded.
func TestAdoptedKeyBound(t *testing.T) {
	old, _, _ := ed25519.GenerateKey(nil)
	other, _, _ := ed25519.GenerateKey(nil)
	k := Keys{Adopted: old, Until: &Bound{Key: manifest.EncodeKey(old), ManifestSHA256: "restored", Known: []string{"earlier"}}}
	for sha, want := range map[string]bool{"restored": true, "earlier": true, "later": false} {
		if got := k.Trusts(false, sha); got != want {
			t.Fatalf("%s: %v", sha, got)
		}
	}
	if !k.Trusts(true, "later") {
		t.Fatal("the box's own backup isn't trusted")
	}
	k.Adopted = other
	if !k.Trusts(false, "later") {
		t.Fatal("the bound of one Whombat's key applied to another's")
	}
	if !(Keys{Adopted: old}).Trusts(false, "later") {
		t.Fatal("no bound, yet not trusted")
	}
}

// The Whombats before the adopted one (its kit's `adopted`, BK-79) are trusted only up to their own bounds, whatever
// the adopted key's; and keys nobody gave aren't trusted at all.
func TestEarlierKeysBound(t *testing.T) {
	own, _, _ := ed25519.GenerateKey(nil)
	b, _, _ := ed25519.GenerateKey(nil)
	a, _, _ := ed25519.GenerateKey(nil)
	stranger, _, _ := ed25519.GenerateKey(nil)
	k := Keys{Own: own, Adopted: b, Earlier: []Earlier{{Key: a, Bound: Bound{Key: manifest.EncodeKey(a),
		ManifestSHA256: "a-restored", Known: []string{"a-earlier"}}}}}
	for _, c := range []struct {
		key  ed25519.PublicKey
		sha  string
		want bool
	}{
		{own, "anything", true}, {b, "b-later", true}, {a, "a-restored", true}, {a, "a-earlier", true},
		{a, "a-later", false}, {stranger, "a-earlier", false}, {nil, "a-earlier", false},
	} {
		if got := k.TrustsKey(c.key, c.sha); got != c.want {
			t.Errorf("%s by %x: %v", c.sha, c.key[:min(len(c.key), 4)], got)
		}
	}
	if !k.IsEarlier(a) || k.IsEarlier(b) || k.IsEarlier(own) {
		t.Fatal("IsEarlier")
	}
	if fp := k.fingerprint(); fp == (Keys{Own: own, Adopted: b}).fingerprint() {
		t.Fatal("the earlier keys don't change the fingerprint")
	}
}

// What a kit carries of the Whombats this one was brought back from: the adopted one only once bounded (something of
// it is back), then the earlier ones, each with at most MaxKnown of its newest backups, never this box's own key.
func TestCarried(t *testing.T) {
	own, _, _ := ed25519.GenerateKey(nil)
	b, _, _ := ed25519.GenerateKey(nil)
	a, _, _ := ed25519.GenerateKey(nil)
	many := make([]string, kit.MaxKnown+5)
	for i := range many {
		many[i] = fmt.Sprintf("%064x", i)
	}
	aBound := Bound{Key: manifest.EncodeKey(a), ApplianceID: "wb-a", CheckpointID: "ck-a", Seq: 3, ManifestSHA256: many[0], Known: many}
	k := Keys{Own: own, Adopted: b, Earlier: []Earlier{{Key: a, Bound: aBound}}}
	got := k.Carried()
	if len(got) != 1 || got[0].ManifestKey != aBound.Key || len(got[0].Until.Known) != kit.MaxKnown ||
		got[0].Until.Known[0] != many[0] || got[0].ApplianceID != "wb-a" {
		t.Fatalf("not bounded: %+v", got)
	}
	k.Until = &Bound{Key: manifest.EncodeKey(b), CheckpointID: "ck-b", Seq: 7, ManifestSHA256: many[1], Known: many[1:2]}
	got = k.Carried()
	if len(got) != 2 || got[0].ManifestKey != manifest.EncodeKey(b) || got[0].Until.CheckpointID != "ck-b" || got[1].ManifestKey != aBound.Key {
		t.Fatalf("bounded: %+v", got)
	}
	m := kit.Material{Kind: kit.MaterialKind, ApplianceID: "c", Repository: "rest:http://nas/c/", RepositoryPassword: "pw",
		ManifestKey: manifest.EncodeKey(own), Adopted: got}
	if err := m.Validate(); err != nil {
		t.Fatalf("what is carried isn't a valid material: %v", err)
	}
	k.Until.Key = manifest.EncodeKey(a) // a bound left from another key: the adopted one isn't bounded
	if got := k.Carried(); len(got) != 1 || got[0].ManifestKey != aBound.Key {
		t.Fatalf("a stale bound: %+v", got)
	}
	if got := (Keys{Own: own, Earlier: []Earlier{{Key: own, Bound: Bound{Key: manifest.EncodeKey(own)}}}}).Carried(); len(got) != 0 {
		t.Fatalf("its own key: %+v", got)
	}
}

// A new adopt replaces what an earlier one recorded (BK-78): the adopted key, its bound, the kit's head and the earlier
// Whombats; a bound this box recorded itself for a key the new kit names stays (never loosened).
func TestAdoptReplaces(t *testing.T) {
	c := &state.Config{Persist: t.TempDir()}
	c.Defaults()
	b, _, _ := ed25519.GenerateKey(nil)
	a, _, _ := ed25519.GenerateKey(nil)
	x, _, _ := ed25519.GenerateKey(nil)
	sha := func(n int) string { return fmt.Sprintf("%064x", n) }
	carried := []kit.Adopted{{ApplianceID: "wb-a", ManifestKey: manifest.EncodeKey(a),
		Until: kit.Until{CheckpointID: "ck-a", Seq: 1, ManifestSHA256: sha(1), Known: []string{sha(1)}}}}
	// B's kit: B adopted, A before it with B's cut-off, B's head.
	if err := Adopt(c, b, &restore.ExpectedHead{Seq: 4, ManifestSHA256: sha(4)}, carried); err != nil {
		t.Fatal(err)
	}
	k, err := LoadKeys(c)
	if err != nil || !k.Adopted.Equal(b) || k.Until != nil || len(k.Earlier) != 1 || !k.Earlier[0].Key.Equal(a) ||
		k.Earlier[0].Bound.CheckpointID != "ck-a" {
		t.Fatalf("after B's kit: %v %+v", err, k)
	}
	if !k.TrustsKey(a, sha(1)) || k.TrustsKey(a, sha(9)) {
		t.Fatal("A's cut-off")
	}
	// X's kit (nothing before it, no head): B and A are gone, and so is B's head.
	if err := Adopt(c, x, nil, nil); err != nil {
		t.Fatal(err)
	}
	k, _ = LoadKeys(c)
	if !k.Adopted.Equal(x) || k.Until != nil || len(k.Earlier) != 0 {
		t.Fatalf("after X's kit: %+v", k)
	}
	for _, p := range []string{HeadPath(c), EarlierPath(c), BoundPath(c)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s stays: %v", p, err)
		}
	}
	// This box brought one of X's backups back (X bounded here), then opens B's kit and X's again: X's bound is the
	// box's own and stays.
	if err := SaveBound(c, Bound{Key: manifest.EncodeKey(x), CheckpointID: "ck-x", ManifestSHA256: sha(7), SetAside: "s"}); err != nil {
		t.Fatal(err)
	}
	if err := Adopt(c, b, nil, append(carried, kit.Adopted{ManifestKey: manifest.EncodeKey(x),
		Until: kit.Until{CheckpointID: "ck-x2", Seq: 9, ManifestSHA256: sha(9)}})); err != nil {
		t.Fatal(err)
	}
	k, _ = LoadKeys(c)
	if len(k.Earlier) != 2 || !k.TrustsKey(x, sha(7)) || k.TrustsKey(x, sha(9)) {
		t.Fatalf("X's own bound: %+v", k.Earlier)
	}
	if err := Adopt(c, x, nil, nil); err != nil {
		t.Fatal(err)
	}
	if k, _ = LoadKeys(c); k.Until == nil || k.Until.CheckpointID != "ck-x" || k.Until.SetAside != "" || k.TrustsKey(x, sha(9)) {
		t.Fatalf("X adopted again: %+v", k.Until)
	}
}
