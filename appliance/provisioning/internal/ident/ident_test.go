package ident

import (
	"bytes"
	"crypto/ed25519"
	"testing"
)

// Known-answer vector from @whombat/secure-channel test/identity.test.ts ("matches the fingerprint
// known-answer vector (for the Go claim-card printer)"): Ed25519 seed 00 01 .. 1f.
func TestFingerprintKnownAnswer(t *testing.T) {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	k := &Key{Private: priv, Public: priv.Public().(ed25519.PublicKey)}
	if got := k.PeerID(); got != "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB" {
		t.Fatalf("PeerID = %s", got)
	}
	fp, err := Fingerprint(k.PeerID())
	if err != nil || fp != "KDTHE-HLBVV-XVMQ2-JPJX6-CMTJX" {
		t.Fatalf("Fingerprint = %s, %v", fp, err)
	}
	if _, err := Fingerprint("QmNotAPeer"); err == nil {
		t.Fatal("accepted a non-Ed25519 PeerId")
	}
}

func TestKeyEncodingsRoundTrip(t *testing.T) {
	k, err := Generate(nil)
	if err != nil {
		t.Fatal(err)
	}
	lp := k.Libp2pPrivateKey()
	if len(lp) != 68 || !bytes.Equal(lp[:4], []byte{0x08, 0x01, 0x12, 0x40}) {
		t.Fatalf("libp2p encoding %x", lp[:4])
	}
	back, err := ParseLibp2pPrivateKey(lp)
	if err != nil || !bytes.Equal(back.Public, k.Public) {
		t.Fatalf("libp2p round trip: %v", err)
	}
	lp[67] ^= 1
	if _, err := ParseLibp2pPrivateKey(lp); err == nil {
		t.Fatal("accepted a key whose public half doesn't match")
	}
	pemBytes, err := k.PKCS8PEM()
	if err != nil {
		t.Fatal(err)
	}
	back, err = ParsePKCS8PEM(pemBytes)
	if err != nil || !bytes.Equal(back.Public, k.Public) {
		t.Fatalf("PKCS#8 round trip: %v", err)
	}
	if len(k.PublicHex()) != 64 {
		t.Fatal("public hex length")
	}
}
