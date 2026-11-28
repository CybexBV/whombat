package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
)

// fakeTakeOver stands in for the Windows takeover: it records the folders
// it was asked for and does what do says.
func fakeTakeOver(t *testing.T, do func(dir string) error) *[]string {
	t.Helper()
	var asked []string
	takeOver = func(dir string) error {
		asked = append(asked, dir)
		return do(dir)
	}
	t.Cleanup(func() { takeOver = secureDataDir })
	return &asked
}

func writeConfig(t *testing.T, dir string) {
	t.Helper()
	if err := agent.WriteInitialConfig(&agent.Config{Dir: dir, Hub: "wss://10.100.1.5:8443", CASHA256: "ab", StateDir: agent.DefaultStateDir}); err != nil {
		t.Fatal(err)
	}
}

// writeIdentity leaves an identity in dir, as someone could have before the
// install: a certificate that is its own authority.
func writeIdentity(t *testing.T, dir string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "planted"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	cfg := &agent.Config{Dir: dir}
	for _, p := range []string{cfg.CertPath(), cfg.CAPath()} {
		if err := os.WriteFile(p, cert, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// Every command that reads or writes the agent's settings makes the folder
// its own first, and reads and writes nothing when it can't.
func TestCommandsTakeTheFolderOverFirst(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir)
	refused := errors.New("the agent's folder isn't safe to use")
	asked := fakeTakeOver(t, func(string) error { return refused })
	commands := map[string][]string{
		"whoami":     {"whoami", "--config-dir", dir},
		"hub":        {"hub", "--config-dir", dir},
		"hub URL":    {"hub", "wss://10.100.1.9:8443", "--config-dir", dir, "--no-restart"},
		"policy":     {"policy", "--config-dir", dir},
		"policy set": {"policy", "set", "full", "--config-dir", dir, "--no-reload"},
		"allow":      {"allow", "manage", "--config-dir", dir},
		"deny":       {"deny", "diagnose", "--config-dir", dir},
		"collect":    {"collect", "--config-dir", dir},
	}
	run := map[string]func([]string) error{
		"whoami": cmdWhoami, "hub": cmdHub, "policy": cmdPolicy, "collect": cmdCollect,
		"allow": func(a []string) error { return cmdSwitch("allow", true, a) },
		"deny":  func(a []string) error { return cmdSwitch("deny", false, a) },
	}
	before, err := os.ReadFile(filepath.Join(dir, agent.ConfigFileName))
	if err != nil {
		t.Fatal(err)
	}
	for name, args := range commands {
		*asked = nil
		if err := run[args[0]](args[1:]); !errors.Is(err, refused) {
			t.Errorf("%s went on without its folder: %v", name, err)
		}
		if !slices.Equal(*asked, []string{dir}) {
			t.Errorf("%s took over %q, want %q", name, *asked, dir)
		}
	}
	if after, _ := os.ReadFile(filepath.Join(dir, agent.ConfigFileName)); string(after) != string(before) {
		t.Errorf("agent.toml changed:\n%s", after)
	}
}

// A settings folder someone else made before the install is moved aside by
// the takeover: the commands then find no identity, so install.ps1 enrolls
// the PC afresh, and nothing is written into the folder that was moved.
func TestCommandsUseNothingTheTakeoverMovedAside(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agent")
	writeConfig(t, dir)
	writeIdentity(t, dir)
	if _, _, err := agent.Whoami(dir); err != nil {
		t.Fatalf("the identity left there doesn't read: %v", err)
	}
	aside := dir + ".set-aside"
	fakeTakeOver(t, func(d string) error {
		if _, err := os.Stat(d); err == nil {
			return os.Rename(d, aside)
		}
		return nil
	})
	if err := cmdWhoami([]string{"--config-dir", dir}); err == nil || !strings.Contains(err.Error(), "enroll this server first") {
		t.Fatalf("whoami after the takeover: %v", err)
	}
	if err := cmdHub([]string{"wss://10.100.1.9:8443", "--config-dir", dir, "--no-restart"}); err == nil || !strings.Contains(err.Error(), "enroll this server first") {
		t.Fatalf("hub after the takeover: %v", err)
	}
	if cfg, err := agent.LoadConfig(aside); err != nil || cfg.Hub != "wss://10.100.1.5:8443" {
		t.Fatalf("the folder set aside was changed: %v %v", cfg, err)
	}
}
