package sshkey

import (
	"crypto/ed25519"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	k, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	pemb := MarshalPrivate(k, "whombat-backup@apl-1")
	back, err := ParsePrivate(pemb)
	if err != nil {
		t.Fatal(err)
	}
	if !back.Equal(k) {
		t.Fatal("round trip changed the key")
	}
	line := AuthorizedKey(k.Public().(ed25519.PublicKey), "whombat-backup@apl-1")
	pk, err := ParsePublicKey(line)
	if err != nil {
		t.Fatal(err)
	}
	if pk.Type != "ssh-ed25519" || !strings.HasPrefix(pk.Fingerprint(), "SHA256:") || len(pk.Fingerprint()) != 50 {
		t.Fatalf("%+v %s", pk, pk.Fingerprint())
	}
	if !IsFingerprint(pk.Fingerprint()) {
		t.Fatal("own fingerprint not recognised")
	}
}

func TestParsePublicKeyForms(t *testing.T) {
	k, _ := Generate()
	bare := Ed25519Public(k.Public().(ed25519.PublicKey)).String()
	for _, line := range []string{bare, "nas.local " + bare, "[nas.local]:2222,10.0.0.5 " + bare + " comment here", "  " + bare + "  "} {
		pk, err := ParsePublicKey(line)
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if pk.String() != bare {
			t.Fatalf("%q parsed as %q", line, pk.String())
		}
	}
	for _, bad := range []string{"", "nas.local", "ssh-ed25519", "ssh-ed25519 !!!", "@revoked nas " + bare,
		"ssh-ed25519-cert-v01@openssh.com AAAA", "ssh-dss AAAAB3NzaC1kc3M=",
		"ssh-rsa " + strings.SplitN(bare, " ", 2)[1]} { // blob names another type
		if _, err := ParsePublicKey(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if got := KnownHostsLine("nas", 22, Ed25519Public(k.Public().(ed25519.PublicKey))); !strings.HasPrefix(got, "nas ssh-ed25519 ") {
		t.Fatal(got)
	}
	if got := KnownHostsLine("nas", 2222, Ed25519Public(k.Public().(ed25519.PublicKey))); !strings.HasPrefix(got, "[nas]:2222 ssh-ed25519 ") {
		t.Fatal(got)
	}
}

// OpenSSH itself reads the private key and agrees on the public key and fingerprint.
func TestOpenSSHAgrees(t *testing.T) {
	kg, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen not installed")
	}
	dir := t.TempDir()
	k, _ := Generate()
	path := filepath.Join(dir, "id")
	if err := os.WriteFile(path, MarshalPrivate(k, "c"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(kg, "-y", "-f", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen -y: %v: %s", err, out)
	}
	want := Ed25519Public(k.Public().(ed25519.PublicKey))
	if !strings.HasPrefix(strings.TrimSpace(string(out)), want.String()) {
		t.Fatalf("ssh-keygen derived %q, want %q", out, want.String())
	}
	if err := os.WriteFile(path+".pub", []byte(want.String()+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err = exec.Command(kg, "-l", "-E", "sha256", "-f", path+".pub").CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen -l: %v: %s", err, out)
	}
	if !strings.Contains(string(out), want.Fingerprint()) {
		t.Fatalf("ssh-keygen fingerprint %q, ours %q", out, want.Fingerprint())
	}
	// And a key made by ssh-keygen parses.
	other := filepath.Join(dir, "other")
	if out, err := exec.Command(kg, "-q", "-t", "ed25519", "-N", "", "-C", "x", "-f", other).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	b, _ := os.ReadFile(other)
	pk, err := ParsePrivate(b)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := os.ReadFile(other + ".pub")
	if !strings.HasPrefix(string(pub), Ed25519Public(pk.Public().(ed25519.PublicKey)).String()) {
		t.Fatal("ssh-keygen's key parsed to another public key")
	}
}
