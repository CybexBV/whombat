package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Security review 2, finding 2: a root CLI run (the console restore, BK-24) works in the backup user's
// directory. Whatever that user planted there — a symlinked directory, file, lock or temp name — root must
// not write, create, chown or read through it. Root mode is simulated with the test's own uid.
func rootModeConfig(t *testing.T) (*Config, string) {
	t.Helper()
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	if err := os.MkdirAll(c.SecretsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir() // stands for /etc, /persist/identity, …
	EnterRootMode(c, os.Getuid(), os.Getgid())
	t.Cleanup(func() { root.on, runtimeDirs = false, nil })
	return c, outside
}

func TestRootWriteRefusesASymlinkedDirectory(t *testing.T) {
	c, outside := rootModeConfig(t)
	if err := os.Symlink(outside, filepath.Join(c.StateDir, "keys")); err != nil {
		t.Fatal(err)
	}
	err := WriteFileAtomic(c.AdoptedManifestKeyPath(), []byte("ed25519:x\n"), 0o600)
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("root wrote through a symlinked directory: %v (err %v)", ents, err)
	}
	if err == nil {
		t.Fatal("write through a symlinked directory reported success")
	}
}

func TestRootWriteRefusesAPlantedTempOrTarget(t *testing.T) {
	c, outside := rootModeConfig(t)
	victim := filepath.Join(outside, "shadow")
	if err := os.WriteFile(victim, []byte("root-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The old temp name was predictable (<path>.tmp-<pid>) and opened without O_EXCL/O_NOFOLLOW.
	_ = os.Symlink(victim, c.StatusPath()+".tmp-"+itoa(os.Getpid()))
	_ = os.Symlink(victim, c.DestinationPath())
	_ = WriteFileAtomic(c.StatusPath(), []byte("{}"), 0o644)
	_ = WriteFileAtomic(c.DestinationPath(), []byte("{}"), 0o600)
	if b, _ := os.ReadFile(victim); string(b) != "root-only" {
		t.Fatalf("root wrote through a planted symlink: %q", b)
	}
}

func TestRootLockAndChainDoNotFollowSymlinks(t *testing.T) {
	c, outside := rootModeConfig(t)
	lockVictim, chainVictim := filepath.Join(outside, "lock-target"), filepath.Join(outside, "chain-target")
	if err := os.WriteFile(chainVictim, []byte("keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(lockVictim, filepath.Join(c.StateDir, "run.lock"))
	_ = os.Symlink(chainVictim, c.ChainPath())
	if l, err := TryLock(c); err == nil {
		l.Unlock()
	}
	_ = AppendChain(c, ChainEntry{ID: "ck-x"})
	if _, err := os.Lstat(lockVictim); err == nil {
		t.Fatal("root created the lock file through a planted symlink")
	}
	if b, _ := os.ReadFile(chainVictim); string(b) != "keep\n" {
		t.Fatalf("root appended through a planted symlink: %q", b)
	}
}

func TestRootNeverReadsASecretThroughASymlink(t *testing.T) {
	c, outside := rootModeConfig(t)
	victim := filepath.Join(outside, "management.key")
	if err := os.WriteFile(victim, []byte("MANAGEMENT-KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, c.SecretWritePath(SecretRESTPassword)); err != nil {
		t.Fatal(err)
	}
	v, _ := c.ReadSecret(SecretRESTPassword)
	if strings.Contains(v, "MANAGEMENT-KEY") {
		t.Fatal("root read a secret through a planted symlink (it would be sent as the REST password)")
	}
	// Materializing refuses the planted symlink instead of copying its target.
	c.RunDir = t.TempDir()
	if _, err := MaterializeForRoot(c, "false"); err == nil {
		t.Fatal("a symlinked secret was accepted")
	}
	if b, _ := ReadStateFile(c.SecretWritePath(SecretRESTPassword)); strings.Contains(string(b), "MANAGEMENT-KEY") {
		t.Fatal("ReadStateFile followed the symlink")
	}
}

// Root mode reads secrets only from the run's private directory: the backup user's plain values (read
// without following a symlink, checked) and the sealed ones (decrypted from the root-only directory).
func TestMaterializeForRoot(t *testing.T) {
	c, _ := rootModeConfig(t)
	c.RunDir = t.TempDir()
	if err := os.MkdirAll(c.SealedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A plain value written since the last seal, a cleared one, and a sealed one.
	if err := c.WriteSecret(SecretRESTPassword, "plain-rest"); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteSecret(SecretS3Key, ""); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(c.SealedPath(SecretS3Key), []byte("stale-sealed"), 0o600)
	_ = os.WriteFile(c.SealedPath(SecretRepositoryPassword), []byte("SEALED:repo-pw"), 0o600)
	fake := filepath.Join(t.TempDir(), "systemd-creds") // "decrypts" by dropping the SEALED: prefix
	_ = os.WriteFile(fake, []byte("#!/bin/sh\nsed 's/^SEALED://' \"$3\" > \"$4\"\n"), 0o755)
	_ = os.WriteFile(filepath.Join(c.StateDir, "ca.pem"), []byte("PEM"), 0o644)
	done, err := MaterializeForRoot(c, fake)
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{SecretRESTPassword: "plain-rest", SecretRepositoryPassword: "repo-pw", SecretS3Key: "", SecretSSHKey: ""} {
		if v, _ := c.ReadSecret(name); v != want {
			t.Fatalf("%s: %q, want %q", name, v, want)
		}
	}
	if p := c.SecretPath(SecretRESTPassword); !strings.HasPrefix(p, c.RuntimeDir) {
		t.Fatalf("root read a secret from %s", p)
	}
	d := &Destination{Kind: KindREST, Repository: "rest:https://b/", CACert: "/etc/shadow"}
	if r := c.Repo(d); r.CACert != filepath.Join(c.RuntimeDir, "ca.pem") {
		t.Fatalf("root used the CA path %q", r.CACert)
	}
	dir := c.RuntimeDir
	done()
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("private directory left behind")
	}
}

// Finding 4: clearing a secret (switching away from a REST or S3 destination) must not leave the old sealed
// value in force.
func TestClearedSecretIsNotReadFromTheSealedCredential(t *testing.T) {
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	creds := t.TempDir()
	t.Setenv("CREDENTIALS_DIRECTORY", creds)
	if err := os.WriteFile(filepath.Join(creds, "rest-password"), []byte("old-sealed-rest-password"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteSecret(SecretRESTPassword, ""); err != nil {
		t.Fatal(err)
	}
	if v, _ := c.ReadSecret(SecretRESTPassword); v != "" {
		t.Fatalf("a cleared secret still reads as %q", v)
	}
}

func itoa(n int) string {
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
