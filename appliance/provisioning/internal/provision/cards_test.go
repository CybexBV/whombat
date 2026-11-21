package provision

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/provisioning/internal/cardseal"
)

// Regression for I-3 (W4-SEC part 2): with a station card key, the secret cards never reach the medium in
// the clear (flash keeps deleted and overwritten blocks); the medium holds ciphertext the station opens.
func TestSecretCardsSealedForStation(t *testing.T) {
	srv, _ := fakeControl(t)
	o := opts(t, srv.URL, "SN-0101")
	privS, pubS, err := cardseal.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	o.CardRecipient, _ = cardseal.ParsePublicKey(pubS)
	o.ScratchDir = t.TempDir()
	if _, err := Provision(context.Background(), o); err != nil {
		t.Fatal(err)
	}
	enr := o.Enroller.(*fakeEnroller)
	key := strings.SplitN(enr.enrolled[0], "=", 2)[1]
	ents, _ := os.ReadDir(o.CardDir)
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
		b, _ := os.ReadFile(filepath.Join(o.CardDir, e.Name()))
		if bytes.Contains(b, []byte(key)) {
			t.Fatalf("%s holds the recovery key in the clear", e.Name())
		}
		if strings.HasSuffix(e.Name(), ".svg") || strings.HasSuffix(e.Name(), ".pdf") {
			t.Fatalf("clear card %s on the medium", e.Name())
		}
	}
	priv, _ := cardseal.ParsePrivateKey(privS)
	sealed, err := os.ReadFile(filepath.Join(o.CardDir, "disk-recovery-dev_SN-0101.svg"+cardseal.Suffix))
	if err != nil {
		t.Fatalf("no sealed recovery card (%v)", names)
	}
	card, err := cardseal.Open(priv, sealed)
	if err != nil || !bytes.Contains(card, []byte(strings.SplitN(key, "-", 2)[0])) {
		t.Fatalf("station cannot open the card: %v", err)
	}
	if _, err := os.Stat(filepath.Join(o.CardDir, "record-dev_SN-0101.json")); err != nil {
		t.Fatal("public record missing")
	}
	if ents, _ := os.ReadDir(o.ScratchDir); len(ents) != 0 {
		t.Fatalf("scratch left behind: %v", ents)
	}
}

// Regression for N-4 (re-review): the library refuses prod without a card recipient, whatever the caller
// (`provision --env prod` bypassed the station's check and wrote clear cards).
func TestProdRefusesClearCards(t *testing.T) {
	srv, _ := fakeControl(t)
	o := opts(t, srv.URL, "SN-0102")
	o.Environment = "prod"
	if _, err := Provision(context.Background(), o); !errors.Is(err, ErrClearCardsInProd) {
		t.Fatalf("prod without a card recipient: %v", err)
	}
	if ents, _ := os.ReadDir(o.CardDir); len(ents) != 0 {
		t.Fatalf("cards written: %v", ents)
	}
}
