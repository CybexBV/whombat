// Command rackoon-sign signs agent builds for self-update.
//
//	rackoon-sign pubkey                       print the public key (base64) for -ldflags
//	rackoon-sign fingerprint                  print the key fingerprint
//	rackoon-sign manifest --version V --dir D FILE...
//	                                          write D/manifest.json for D/FILE...
//	                                          (agents, and whombat-helper-macos.zip)
//	rackoon-sign verify --dir D               check D/manifest.json against the files
//
// The key is a raw 32-byte Ed25519 seed in $RACKOON_SIGNING_KEY or
// ~/.config/rackoon/update-signing.key, created (0600) on first use. It
// must never be inside the repository.
//
// manifest.json:
//
//	{"version": "<V>", "key": "<fingerprint>",
//	 "files": {"whombat-agent-linux-amd64": {"arch": "amd64", "size": N,
//	           "sha256": "<hex>", "sig": "<base64 Ed25519 signature of the raw 32-byte digest>"},
//	           "whombat-agent-darwin-arm64": {"os": "darwin", "arch": "arm64", …},
//	           "whombat-helper-macos.zip": {"os": "darwin", "arch": "universal",
//	           "version": "1.0.0", "size": N, "sha256": …, "sig": …}}}
//
// Whombat Helper's zip (macos/helper/build.sh) is signed like the agents;
// its version comes from whombat-helper-macos.json beside it (not signed
// itself), whose sha256 and size must be the zip's. Only the helper's entry
// has a version. Any other name must end in -linux-<arch> or -darwin-<arch>.
//
// The fingerprint is the first 16 hex digits of SHA-256(public key), as
// agents report it in AgentInfo.UpdateKey.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Manifest is dist/agent/manifest.json.
type Manifest struct {
	Version string          `json:"version"`
	Key     string          `json:"key"`
	Files   map[string]File `json:"files"`
}

// File is one signed agent binary, or Whombat Helper's zip. OS is
// "darwin" for a macOS build; absent means linux.
type File struct {
	OS   string `json:"os,omitempty"`
	Arch string `json:"arch"`
	// Version is the helper's own (its entry only).
	Version string `json:"version,omitempty"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Sig     string `json:"sig"`
}

// Whombat Helper's zip and its description (macos/helper/build.sh).
const (
	helperZip  = "whombat-helper-macos.zip"
	helperJSON = "whombat-helper-macos.json"
	helperArch = "universal"
)

// helperVersionRe is a helper version as the hub accepts it.
var helperVersionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$`)

// helperVersion reads whombat-helper-macos.json in dir ({"version",
// "sha256", "size"}, other fields ignored) and checks that it describes
// the zip whose digest and size are sum and size.
func helperVersion(dir string, sum []byte, size int64) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, helperJSON))
	if err != nil {
		return "", fmt.Errorf("%s needs %s beside it: %w", helperZip, helperJSON, err)
	}
	var d struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
		Size    int64  `json:"size"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return "", fmt.Errorf("%s: %w", helperJSON, err)
	}
	switch {
	case !strings.EqualFold(strings.TrimSpace(d.SHA256), hex.EncodeToString(sum)) || d.Size != size:
		return "", fmt.Errorf("%s doesn't describe %s (sha256 or size differ): build them together", helperJSON, helperZip)
	case !helperVersionRe.MatchString(d.Version):
		return "", fmt.Errorf("%s: invalid version %q", helperJSON, d.Version)
	}
	return d.Version, nil
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "pubkey":
		var k ed25519.PrivateKey
		if k, err = loadKey(); err == nil {
			fmt.Println(base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey)))
		}
	case "fingerprint":
		var k ed25519.PrivateKey
		if k, err = loadKey(); err == nil {
			fmt.Println(fingerprint(k.Public().(ed25519.PublicKey)))
		}
	case "manifest":
		err = cmdManifest(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "rackoon-sign:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: rackoon-sign pubkey | fingerprint | manifest --version V --dir D FILE... | verify --dir D")
	os.Exit(2)
}

// fingerprint matches agent.KeyFingerprint.
func fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

// keyPath is $RACKOON_SIGNING_KEY or ~/.config/rackoon/update-signing.key.
func keyPath() (string, error) {
	if p := os.Getenv("RACKOON_SIGNING_KEY"); p != "" {
		return filepath.Abs(p)
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "rackoon", "update-signing.key"), nil
}

// insideWorkTree reports whether path lies in the current git work tree
// (the key must never be committed).
func insideWorkTree(path string) bool {
	wd, err := os.Getwd()
	if err != nil {
		return false
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			rel, err := filepath.Rel(dir, path)
			return err == nil && !strings.HasPrefix(rel, "..")
		}
		if dir == filepath.Dir(dir) {
			return false
		}
	}
}

// loadKey reads the signing key, creating it on first use.
func loadKey() (ed25519.PrivateKey, error) {
	path, err := keyPath()
	if err != nil {
		return nil, err
	}
	if insideWorkTree(path) {
		return nil, fmt.Errorf("refusing to use a signing key inside the repository (%s)", path)
	}
	seed, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		seed = make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		if _, err := f.Write(seed); err != nil {
			f.Close()
			return nil, err
		}
		if err := f.Close(); err != nil {
			return nil, err
		}
		fmt.Fprintf(os.Stderr, "rackoon-sign: created a new update signing key %s (keep it; agents built with it accept only updates it signs)\n", path)
	} else if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(path); err == nil && fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is readable by others (mode %v); chmod 600 it", path, fi.Mode().Perm())
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s: want a raw %d-byte Ed25519 seed, got %d bytes", path, ed25519.SeedSize, len(seed))
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// osArchOf takes the system and the architecture from
// "whombat-agent-<os>-<arch>" (any "<name>-linux-<arch>" or
// "<name>-darwin-<arch>"). The system is "" for linux (the manifest's
// default) and "darwin" for macOS.
func osArchOf(name string) (goos, arch string, err error) {
	for _, o := range []string{"linux", "darwin"} {
		sep := "-" + o + "-"
		if i := strings.LastIndex(name, sep); i >= 0 && i+len(sep) < len(name) {
			if o == "linux" {
				o = ""
			}
			return o, name[i+len(sep):], nil
		}
	}
	return "", "", fmt.Errorf("%s: name must end in -linux-<arch> or -darwin-<arch>", name)
}

func hashFile(path string) ([]byte, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return h.Sum(nil), n, err
}

func cmdManifest(args []string) error {
	fs := flag.NewFlagSet("manifest", flag.ExitOnError)
	version := fs.String("version", "", "agent version (as built into the binaries)")
	dir := fs.String("dir", "dist/agent", "directory with the binaries; manifest.json is written here")
	fs.Parse(args)
	if *version == "" || fs.NArg() == 0 {
		return errors.New("manifest needs --version and at least one file")
	}
	key, err := loadKey()
	if err != nil {
		return err
	}
	m, err := buildManifest(key, *version, *dir, fs.Args())
	if err != nil {
		return err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	out := filepath.Join(*dir, "manifest.json")
	tmp := out + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, out); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "rackoon-sign: wrote %s (version %s, key %s, %d files)\n", out, m.Version, m.Key, len(m.Files))
	return nil
}

func buildManifest(key ed25519.PrivateKey, version, dir string, names []string) (*Manifest, error) {
	m := &Manifest{Version: version, Key: fingerprint(key.Public().(ed25519.PublicKey)), Files: map[string]File{}}
	sort.Strings(names)
	for _, name := range names {
		if name != filepath.Base(name) {
			return nil, fmt.Errorf("%s: give file names inside --dir", name)
		}
		var goos, arch string
		var err error
		if name != helperZip {
			if goos, arch, err = osArchOf(name); err != nil {
				return nil, err
			}
		}
		sum, size, err := hashFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		f := File{
			OS:     goos,
			Arch:   arch,
			Size:   size,
			SHA256: hex.EncodeToString(sum),
			Sig:    base64.StdEncoding.EncodeToString(ed25519.Sign(key, sum)),
		}
		if name == helperZip {
			f.OS, f.Arch = "darwin", helperArch
			if f.Version, err = helperVersion(dir, sum, size); err != nil {
				return nil, err
			}
		}
		m.Files[name] = f
	}
	return m, nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	dir := fs.String("dir", "dist/agent", "directory with manifest.json and the binaries")
	fs.Parse(args)
	key, err := loadKey()
	if err != nil {
		return err
	}
	b, err := os.ReadFile(filepath.Join(*dir, "manifest.json"))
	if err != nil {
		return err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	if err := verifyManifest(key.Public().(ed25519.PublicKey), &m, *dir); err != nil {
		return err
	}
	fmt.Printf("manifest %s: version %s, key %s, %d files OK\n", filepath.Join(*dir, "manifest.json"), m.Version, m.Key, len(m.Files))
	return nil
}

func verifyManifest(pub ed25519.PublicKey, m *Manifest, dir string) error {
	if m.Key != fingerprint(pub) {
		return fmt.Errorf("manifest key %s is not this key (%s)", m.Key, fingerprint(pub))
	}
	for name, f := range m.Files {
		sum, size, err := hashFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		sig, err := base64.StdEncoding.DecodeString(f.Sig)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if size != f.Size || hex.EncodeToString(sum) != f.SHA256 || !ed25519.Verify(pub, sum, sig) {
			return fmt.Errorf("%s does not match the manifest", name)
		}
		if name == helperZip && (f.OS != "darwin" || f.Arch != helperArch || !helperVersionRe.MatchString(f.Version)) {
			return fmt.Errorf("%s: the entry needs os darwin, arch %s and the helper's version", name, helperArch)
		}
	}
	return nil
}
