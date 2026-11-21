package manifest

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSignVerify(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	m := &Manifest{Kind: Kind, ID: "ck-1", Seq: 1, ApplianceID: "a", CreatedAt: time.Unix(1, 0).UTC()}
	b, err := Encode(m)
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := Sign(b, key)
	pub := key.Public().(ed25519.PublicKey)
	got, err := Verify(b, sig, pub)
	if err != nil || got.ID != "ck-1" {
		t.Fatalf("verify: %v", err)
	}
	// tampered bytes
	b2 := append([]byte{}, b...)
	b2[len(b2)-3] ^= 1
	if _, err := Verify(b2, sig, pub); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered: %v", err)
	}
	// another key, even a valid signature by it
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	sig2, _ := Sign(b, other)
	if _, err := Verify(b, sig2, pub); !errors.Is(err, ErrUntrustedKey) {
		t.Fatalf("other key: %v", err)
	}
	// wrong kind
	m.Kind = "x"
	b3, _ := Encode(m)
	sig3, _ := Sign(b3, key)
	if _, err := Verify(b3, sig3, pub); err == nil {
		t.Fatal("wrong kind accepted")
	}
}

func TestKeyRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "k", "manifest.ed25519")
	k1, err := LoadOrCreateKey(p)
	if err != nil {
		t.Fatal(err)
	}
	k2, _ := LoadOrCreateKey(p)
	if !k1.Equal(k2) {
		t.Fatal("key not persisted")
	}
	s := EncodeKey(k1.Public().(ed25519.PublicKey))
	pub, err := ParseKey(s)
	if err != nil || !pub.Equal(k1.Public()) {
		t.Fatalf("parse: %v", err)
	}
	if _, err := ParseKey("ed25519:AAAA"); err == nil {
		t.Fatal("short key accepted")
	}
}

// The hosts source and its backup only at their fixed places (BK-31); manifests without them still verify.
func TestHostsPaths(t *testing.T) {
	base := func() *Manifest {
		return &Manifest{Kind: Kind, Sources: []Source{{Name: "home", SnapshotPath: "files/home"}}}
	}
	if err := base().ValidatePaths(); err != nil {
		t.Fatalf("a checkpoint without the servers: %v", err)
	}
	m := base()
	m.Sources = append(m.Sources, Source{Name: "hosts", SnapshotPath: "files/hosts"})
	m.Hosts = &Hosts{Backup: File{Path: HostsBackupPath, SHA256: "ab", Size: 2}}
	if err := m.ValidatePaths(); err != nil {
		t.Fatalf("with the servers: %v", err)
	}
	for name, bad := range map[string]func(*Manifest){
		"source elsewhere":  func(m *Manifest) { m.Sources[1].SnapshotPath = "files/hostsx" },
		"backup elsewhere":  func(m *Manifest) { m.Hosts.Backup.Path = "files/hosts/../secrets/master.key" },
		"backup, no source": func(m *Manifest) { m.Sources = m.Sources[:1] },
	} {
		m := base()
		m.Sources = append(m.Sources, Source{Name: "hosts", SnapshotPath: "files/hosts"})
		m.Hosts = &Hosts{Backup: File{Path: HostsBackupPath}}
		bad(m)
		if err := m.ValidatePaths(); !errors.Is(err, ErrBadPath) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// The Hermes home's stores only in files/hermes/ or one of its profiles/<name>/ (BK-36, NX-466): no store path leaves
// them.
func TestHermesPaths(t *testing.T) {
	base := func() *Manifest {
		return &Manifest{Kind: Kind, Sources: []Source{{Name: "hermes", SnapshotPath: "files/hermes"}},
			Hermes: &Hermes{Stores: []File{{Path: HermesDir + "/state.db"}, {Path: HermesDir + "/profiles/_feedback/state.db"}}}}
	}
	if err := base().ValidatePaths(); err != nil {
		t.Fatalf("a checkpoint with the Hermes home: %v", err)
	}
	for name, bad := range map[string]func(*Manifest){
		"home, no source": func(m *Manifest) { m.Sources = nil },
		"store deeper":    func(m *Manifest) { m.Hermes.Stores[0].Path = HermesDir + "/sessions/x/state.db" },
		"store in a profile's folder": func(m *Manifest) {
			m.Hermes.Stores[1].Path = HermesDir + "/profiles/_feedback/sessions/state.db"
		},
		"hidden profile":  func(m *Manifest) { m.Hermes.Stores[1].Path = HermesDir + "/profiles/.x/state.db" },
		"store elsewhere": func(m *Manifest) { m.Hermes.Stores[0].Path = "files/secrets/master.key" },
		"store escaping":  func(m *Manifest) { m.Hermes.Stores[0].Path = HermesDir + "/profiles/../../x.db" },
		"store twice":     func(m *Manifest) { m.Hermes.Stores[1] = m.Hermes.Stores[0] },
	} {
		m := base()
		bad(m)
		if err := m.ValidatePaths(); !errors.Is(err, ErrBadPath) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}
