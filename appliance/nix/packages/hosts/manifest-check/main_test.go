package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// signedWith writes four agents (Linux and Mac) and Whombat Helper into a directory and returns it with a manifest
// as rackoon-sign makes it.
func signedWith(t *testing.T, pk ed25519.PublicKey, priv ed25519.PrivateKey) (dir string, m manifest) {
	t.Helper()
	dir = t.TempDir()
	m = manifest{Version: "0.0.0-20261019212356.d2098f2", Key: fingerprint(pk), Files: map[string]file{}}
	entry := func(b []byte, f file) file {
		sum := sha256.Sum256(b)
		f.Size, f.SHA256 = int64(len(b)), hex.EncodeToString(sum[:])
		f.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sum[:]))
		return f
	}
	for _, sys := range []string{"linux", "darwin"} {
		for _, arch := range []string{"amd64", "arm64"} {
			name := prefix + sys + "-" + arch
			b := []byte("agent for " + sys + " " + arch)
			if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
				t.Fatal(err)
			}
			f := file{Arch: arch}
			if sys == "darwin" {
				f.OS = "darwin" // a Linux agent's entry has no os, as rackoon-sign writes it
			}
			m.Files[name] = entry(b, f)
		}
	}
	// Whombat Helper's zip, signed beside them, and the json that names its version.
	b := []byte("helper zip")
	if err := os.WriteFile(filepath.Join(dir, helperName), b, 0o644); err != nil {
		t.Fatal(err)
	}
	m.Files[helperName] = entry(b, file{OS: "darwin", Arch: "universal", Version: "1.0.0"})
	helperSays(t, dir, "1.0.0")
	return dir, m
}

func signed(t *testing.T) (dir, pub string, m manifest) {
	t.Helper()
	pk, priv, _ := ed25519.GenerateKey(nil)
	dir, m = signedWith(t, pk, priv)
	return dir, base64.StdEncoding.EncodeToString(pk) + "\n", m
}

func helperSays(t *testing.T, dir, version string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, helperFacts), []byte(`{"version":"`+version+`","sha256":"x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, m manifest, pub, version, dir string) ([]string, error) {
	t.Helper()
	b, _ := json.Marshal(m)
	return check(b, pub, version, dir)
}

func TestMatches(t *testing.T) {
	dir, pub, m := signed(t)
	if other, err := run(t, m, pub, m.Version, dir); err != nil || len(other) != 0 {
		t.Fatal(other, err)
	}
}

// Other bytes: the manifest is sound and only what was built differs. The one outcome that may lead to signing.
func TestOtherBytes(t *testing.T) {
	cases := map[string]struct {
		change func(dir string)
		want   string
	}{
		"a changed agent":    {func(d string) { write(t, d, prefix+"linux-amd64", "agent for amd65") }, prefix + "linux-amd64"},
		"the helper changed": {func(d string) { write(t, d, helperName, "another zip") }, helperName},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			dir, pub, m := signed(t)
			c.change(dir)
			other, err := run(t, m, pub, m.Version, dir)
			if err != nil || len(other) != 1 || !strings.Contains(other[0], c.want) {
				t.Fatalf("want other bytes for %s and no error, got %v, %v", c.want, other, err)
			}
		})
	}
}

// Everything else is a manifest that is not one for these agents: never a reason to sign.
func TestBroken(t *testing.T) {
	_, otherPub, _ := signed(t)
	cases := map[string]struct {
		change func(dir string, m *manifest, pub *string, version *string)
		want   string
	}{
		"another version": {func(_ string, _ *manifest, _ *string, v *string) { *v = "0.0.0-20261020000000.abcdef0" }, "version"},
		"another key":     {func(_ string, _ *manifest, p *string, _ *string) { *p = otherPub }, "key"},
		"a bad signature": {func(_ string, m *manifest, _ *string, _ *string) {
			f := m.Files[prefix+"linux-arm64"]
			f.Sig = m.Files[prefix+"linux-amd64"].Sig
			m.Files[prefix+"linux-arm64"] = f
		}, "signature"},
		"an entry's sha256 edited to the built one": {func(d string, m *manifest, _ *string, _ *string) {
			write(t, d, prefix+"linux-amd64", "agent for amd65")
			sum := sha256.Sum256([]byte("agent for amd65"))
			f := m.Files[prefix+"linux-amd64"]
			f.SHA256, f.Size = hex.EncodeToString(sum[:]), 15
			m.Files[prefix+"linux-amd64"] = f
		}, "signature"},
		"a missing agent": {func(_ string, m *manifest, _ *string, _ *string) { delete(m.Files, prefix+"linux-arm64") }, "arm64 is not in it"},
		"an agent not built": {func(d string, _ *manifest, _ *string, _ *string) {
			os.Remove(filepath.Join(d, prefix+"linux-arm64"))
		}, "not built"},
		"a wrong size": {func(_ string, m *manifest, _ *string, _ *string) {
			f := m.Files[prefix+"linux-amd64"]
			f.Size++
			m.Files[prefix+"linux-amd64"] = f
		}, "size"},
		"a Mac agent said to be Linux": {func(_ string, m *manifest, _ *string, _ *string) {
			f := m.Files[prefix+"darwin-arm64"]
			f.OS = ""
			m.Files[prefix+"darwin-arm64"] = f
		}, "os"},
		"a missing Mac agent": {func(_ string, m *manifest, _ *string, _ *string) { delete(m.Files, prefix+"darwin-amd64") }, "darwin-amd64 is not in it"},
		"another system's name": {func(_ string, m *manifest, _ *string, _ *string) {
			m.Files[prefix+"windows-amd64"] = m.Files[prefix+"linux-amd64"]
		}, "not an agent's name"},
		"the helper unsigned": {func(_ string, m *manifest, _ *string, _ *string) { delete(m.Files, helperName) }, "whombat-helper-macos.zip is not in it"},
		"the helper without its version": {func(_ string, m *manifest, _ *string, _ *string) {
			f := m.Files[helperName]
			f.Version = ""
			m.Files[helperName] = f
		}, "version"},
		"a wrong arch": {func(_ string, m *manifest, _ *string, _ *string) {
			f := m.Files[prefix+"linux-amd64"]
			f.Arch = "arm64"
			m.Files[prefix+"linux-amd64"] = f
		}, "arch"},
		// Other bytes and something else wrong: still broken.
		"a changed agent under another version": {func(d string, _ *manifest, _ *string, v *string) {
			write(t, d, prefix+"linux-amd64", "agent for amd65")
			*v = "0.0.0-20261020000000.abcdef0"
		}, "version"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			dir, pub, m := signed(t)
			version := m.Version
			c.change(dir, &m, &pub, &version)
			_, err := run(t, m, pub, version, dir)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want an error with %q, got %v", c.want, err)
			}
		})
	}
}

func TestUnknownFieldsAndBadKey(t *testing.T) {
	dir, pub, m := signed(t)
	if _, err := check([]byte(`{"version":"x","extra":1}`), pub, m.Version, dir); err == nil {
		t.Fatal("an unknown field passed")
	}
	if _, err := run(t, m, "not a key", m.Version, dir); err == nil || !strings.Contains(err.Error(), "public key") {
		t.Fatalf("a bad key: %v", err)
	}
}

// What may follow agents that servers already have.
func TestAfterPublished(t *testing.T) {
	const later, sameSecond, earlier = "0.0.0-20261019212357.aaaaaaa", "0.0.0-20261019212356.bbbbbbb", "0.0.0-20261019212355.ccccccc"
	_, otherPub, _ := signed(t)
	cases := map[string]struct {
		change  func(dir string, pub *string, version *string)
		refused string // "" = allowed
	}{
		"the same agents under the same version": {func(string, *string, *string) {}, ""},
		"the same agents under another version":  {func(_ string, _ *string, v *string) { *v = later }, "keep their version"},
		"changed agents under a later version": {func(d string, _ *string, v *string) {
			write(t, d, prefix+"linux-amd64", "new agent")
			*v = later
		}, ""},
		"changed agents under the same version": {func(d string, _ *string, _ *string) {
			write(t, d, prefix+"linux-amd64", "new agent")
		}, "same version"},
		"changed agents a second earlier": {func(d string, _ *string, v *string) {
			write(t, d, prefix+"linux-amd64", "new agent")
			*v = earlier
		}, "not strictly later"},
		"changed agents in the same second": {func(d string, _ *string, v *string) {
			write(t, d, prefix+"linux-amd64", "new agent")
			*v = sameSecond
		}, "not strictly later"},
		"changed agents with a version agents can't order": {func(d string, _ *string, v *string) {
			write(t, d, prefix+"linux-amd64", "new agent")
			*v = "dev"
		}, "not strictly later"},
		"an agent no longer built, the same version": {func(d string, _ *string, _ *string) {
			os.Remove(filepath.Join(d, prefix+"darwin-amd64"))
		}, "same version"},
		"another key": {func(_ string, p *string, _ *string) { *p = otherPub }, "new key"},
		"another helper with a later version": {func(d string, _ *string, _ *string) {
			write(t, d, helperName, "another zip")
			helperSays(t, d, "1.0.1")
		}, ""},
		"another helper with the same version": {func(d string, _ *string, _ *string) {
			write(t, d, helperName, "another zip")
		}, "Whombat Helper"},
		"another helper with an older version": {func(d string, _ *string, _ *string) {
			write(t, d, helperName, "another zip")
			helperSays(t, d, "0.9.9")
		}, "Whombat Helper"},
		"another helper without its json": {func(d string, _ *string, _ *string) {
			write(t, d, helperName, "another zip")
			os.Remove(filepath.Join(d, helperFacts))
		}, helperFacts},
		"the same helper keeps its version whatever the json says": {func(d string, _ *string, _ *string) {
			helperSays(t, d, "0.9.9")
		}, ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			dir, pub, m := signed(t)
			published, _ := json.Marshal(m)
			version := m.Version
			c.change(dir, &pub, &version)
			err := afterPublished(published, pub, version, dir)
			switch {
			case c.refused == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case c.refused != "" && (err == nil || !strings.Contains(err.Error(), c.refused)):
				t.Fatalf("want a refusal with %q, got %v", c.refused, err)
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b    string
		c       int
		ordered bool
	}{
		{"0.0.0-20261019212356.d2098f2", "0.0.0-20261019212356.d2098f2", 0, true},
		{"0.0.0-20261019212357.aaaaaaa", "0.0.0-20261019212356.d2098f2", 1, true},
		{"0.0.0-20261019212356.aaaaaaa", "0.0.0-20261019212356.d2098f2", 0, false},
		{"0.0.0-20261019212356.d2098f2", "1.0.0", 0, false},
		{"1.0.7", "1.0.6", 1, true},
		{"1.0.6", "1.0.10", -1, true},
		{"1.0.6-rc.1", "1.0.6", -1, true},
		{"dev", "1.0.6", 0, false},
	}
	for _, c := range cases {
		if got, ordered := compareVersions(c.a, c.b); got != c.c || ordered != c.ordered {
			t.Errorf("compareVersions(%q, %q) = %d, %v; want %d, %v", c.a, c.b, got, ordered, c.c, c.ordered)
		}
	}
}

// The exit codes are what the build and the release tools read.
func TestExitCodes(t *testing.T) {
	if os.Getenv("MANIFEST_CHECK_MAIN") == "1" {
		os.Args = append([]string{"manifest-check"}, strings.Split(os.Getenv("MANIFEST_CHECK_ARGS"), "\n")...)
		main()
		return
	}
	exit := func(args ...string) int {
		cmd := exec.Command(os.Args[0], "-test.run=TestExitCodes")
		cmd.Env = append(os.Environ(), "MANIFEST_CHECK_MAIN=1", "MANIFEST_CHECK_ARGS="+strings.Join(args, "\n"))
		err := cmd.Run()
		if e, ok := err.(*exec.ExitError); ok {
			return e.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		return 0
	}
	dir, pub, m := signed(t)
	files := t.TempDir()
	b, _ := json.Marshal(m)
	write(t, files, "manifest.json", string(b))
	write(t, files, "key.pub", pub)
	manifestFile, keyFile := filepath.Join(files, "manifest.json"), filepath.Join(files, "key.pub")
	build := []string{"--manifest", manifestFile, "--key", keyFile, "--version", m.Version, "--dir", dir}
	if got := exit(build...); got != exitMatch {
		t.Fatalf("a match exits %d", got)
	}
	if got := exit("--published", manifestFile, "--key", keyFile, "--version", m.Version, "--dir", dir); got != exitMatch {
		t.Fatalf("the published agents again exit %d", got)
	}
	write(t, dir, prefix+"linux-amd64", "new agent")
	if got := exit(build...); got != exitOtherBytes {
		t.Fatalf("other bytes exit %d", got)
	}
	if got := exit("--published", manifestFile, "--key", keyFile, "--version", m.Version, "--dir", dir); got != exitBroken {
		t.Fatalf("other bytes under the published version exit %d", got)
	}
	if got := exit("--manifest", manifestFile, "--key", keyFile, "--version", "0.0.0-20270101000000.abcdef0", "--dir", dir); got != exitBroken {
		t.Fatalf("another version exits %d", got)
	}
	if got := exit("--manifest", filepath.Join(files, "missing.json"), "--key", keyFile, "--version", m.Version, "--dir", dir); got != exitBroken {
		t.Fatalf("a missing manifest exits %d", got)
	}
	if got := exit("--key", keyFile); got != exitUsage {
		t.Fatalf("a wrong call exits %d", got)
	}
}

// Windows builds join a manifest that signs none yet: the build is unsigned until the next signing, not broken.
func TestWindowsNotSignedYet(t *testing.T) {
	pk, priv, _ := ed25519.GenerateKey(nil)
	dir, m := signedWith(t, pk, priv)
	pub := base64.StdEncoding.EncodeToString(pk)
	write(t, dir, prefix+"windows-amd64.exe", "agent for windows amd64")
	write(t, dir, prefix+"windows-arm64.exe", "agent for windows arm64")
	other, err := run(t, m, pub, m.Version, dir)
	if err != nil || len(other) != 2 || !strings.Contains(other[0], "windows") {
		t.Fatalf("other %v, err %v", other, err)
	}

	// Signed: a match.
	for _, arch := range []string{"amd64", "arm64"} {
		name := prefix + "windows-" + arch + ".exe"
		b, _ := os.ReadFile(filepath.Join(dir, name))
		sum := sha256.Sum256(b)
		m.Files[name] = file{OS: "windows", Arch: arch, Size: int64(len(b)), SHA256: hex.EncodeToString(sum[:]),
			Sig: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sum[:]))}
	}
	if other, err := run(t, m, pub, m.Version, dir); err != nil || len(other) != 0 {
		t.Fatalf("signed: other %v, err %v", other, err)
	}

	// Once Windows is signed, a Windows build missing from the manifest is a problem again.
	delete(m.Files, prefix+"windows-arm64.exe")
	if _, err := run(t, m, pub, m.Version, dir); err == nil || !strings.Contains(err.Error(), "windows-arm64.exe is not in it") {
		t.Fatalf("err %v", err)
	}
}

func TestWindowsNames(t *testing.T) {
	for name, want := range map[string][2]string{
		prefix + "windows-amd64.exe": {"windows", "amd64"},
		prefix + "windows-arm64.exe": {"windows", "arm64"},
		prefix + "linux-arm64":       {"linux", "arm64"},
	} {
		if sys, arch, ok := osArch(name); !ok || sys != want[0] || arch != want[1] {
			t.Errorf("%s: %s %s %v", name, sys, arch, ok)
		}
	}
	for _, bad := range []string{prefix + "windows-amd64", prefix + "linux-amd64.exe", prefix + "windows-amd64.exe.new", prefix + "windows-.exe"} {
		if _, _, ok := osArch(bad); ok {
			t.Errorf("%s taken for an agent", bad)
		}
	}
}

// Agents of a new system follow a published manifest without them only under a later version.
func TestAfterPublishedWithWindows(t *testing.T) {
	pk, priv, _ := ed25519.GenerateKey(nil)
	dir, m := signedWith(t, pk, priv)
	pub := base64.StdEncoding.EncodeToString(pk)
	write(t, dir, prefix+"windows-amd64.exe", "agent for windows amd64")
	b, _ := json.Marshal(m)
	if err := afterPublished(b, pub, m.Version, dir); err == nil {
		t.Fatal("new agents under the published version")
	}
	if err := afterPublished(b, pub, "0.0.0-20261128120000.abcdef1", dir); err != nil {
		t.Fatalf("a later version: %v", err)
	}
}
