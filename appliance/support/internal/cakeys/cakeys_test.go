package cakeys

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func key(t *testing.T) ed25519.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub
}

func write(t *testing.T, s string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "support-ca.pub")
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLineRoundTrip(t *testing.T) {
	k := key(t)
	l := Line(k)
	// The contract's SshEd25519PublicKey.
	if !regexp.MustCompile(`^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$`).MatchString(l) {
		t.Fatalf("line %q", l)
	}
	got, err := Parse(l + " support-ca@whombat")
	if err != nil || !got.Equal(k) {
		t.Fatalf("%v %v", got, err)
	}
}

func TestRead(t *testing.T) {
	a, b := key(t), key(t)
	keys, err := Read(write(t, "# DEV support CA\n\n"+Line(a)+" dev\n  "+Line(b)+"\n"))
	if err != nil || len(keys) != 2 || !keys[0].Equal(a) || !keys[1].Equal(b) {
		t.Fatalf("%v %v", keys, err)
	}
	// No file, and the placeholder: no keys, not an error.
	if keys, err := Read(filepath.Join(t.TempDir(), "absent")); keys != nil || err != nil {
		t.Fatalf("absent: %v %v", keys, err)
	}
	if keys, err := Read(write(t, "# PLACEHOLDER: no key\n")); len(keys) != 0 || err != nil {
		t.Fatalf("placeholder: %v %v", keys, err)
	}
}

func TestReadRefusesTheWholeFile(t *testing.T) {
	good := Line(key(t))
	for name, s := range map[string]string{
		"rsa":       good + "\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 x\n",
		"no base64": good + "\nssh-ed25519 !!!!\n",
		"short":     "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAEEFBQUFBQUFBQUFBQUFBQUE=\n",
		"type lies": "ssh-ed25519 AAAAB3NzaC1yc2EAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
		"key only":  "ssh-ed25519\n",
		"trailing":  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
	} {
		if keys, err := Read(write(t, s)); err == nil {
			t.Errorf("%s: %v", name, keys)
		}
	}
	many := ""
	for range maxKeys + 1 {
		many += good + "\n"
	}
	if _, err := Read(write(t, many)); err == nil {
		t.Error("too many keys")
	}
}
