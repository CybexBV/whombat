package cardseal

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestSealOpen(t *testing.T) {
	privS, pubS, err := GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ParsePublicKey(pubS)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := ParsePrivateKey(privS)
	card := []byte("<svg>recovery key bcdef-...</svg>")
	sealed, err := Seal(nil, pub, card)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("recovery key")) {
		t.Fatal("plaintext on the medium")
	}
	got, err := Open(priv, sealed)
	if err != nil || !bytes.Equal(got, card) {
		t.Fatalf("%q %v", got, err)
	}
	otherS, _, _ := GenerateKey(rand.Reader)
	other, _ := ParsePrivateKey(otherS)
	if _, err := Open(other, sealed); err == nil {
		t.Fatal("opened with another key")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := Open(priv, sealed); err == nil {
		t.Fatal("tampered card opened")
	}
}
