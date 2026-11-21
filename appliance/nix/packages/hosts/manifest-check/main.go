// Command whombat-hosts-manifest-check is the build's check of the committed agent manifest (NX-157…NX-169, Whombat
// AU-02): nix/packages/hosts/agent-manifest.json, written by the maintainers' sign-agents with hosts' rackoon-sign,
// must describe exactly the agents this build made, for the committed key, before the hub serves it.
//
//	whombat-hosts-manifest-check --manifest agent-manifest.json --key agent-update-key.pub --version V --dir AGENTS
//
// It tells three outcomes apart, because only one of them may lead to signing:
//
//	exit 0   a match: the manifest's version is V, its key is the fingerprint of the committed public key (the first
//	         16 hex digits of its SHA-256, as agents report it), it names exactly the whombat-agent-<os>-<arch> files
//	         and Whombat Helper in AGENTS, every entry's signature verifies (Ed25519 over the sha256 it names), and
//	         every file's size and sha256 are the entry's.
//	exit 3   other bytes: all of that holds, except that a built file's size or sha256 differs. The manifest is sound
//	         and signs other agents than these (changed agent code, another Go). The agents need signing.
//	exit 1   anything else: an unreadable manifest, another version or key, a bad signature, a file missing on either
//	         side. Signing again would hide this; someone must look.
//
// With --published it checks instead what may follow a manifest that servers already have (the one in the hub of the
// newest release), before anything is signed or shipped:
//
//	whombat-hosts-manifest-check --published manifest.json --key agent-update-key.pub --version V --dir AGENTS
//
// The committed key must be the published manifest's: an installed agent trusts only the key built into it. Agents
// that are other bytes than the published ones need a version V strictly later than the published one, and the same
// bytes keep its version: an agent takes an update only to a later version. Whombat Helper has a version of its own
// (the json beside its zip): another zip needs a strictly later one. Exit 0 or 1.
//
// No secret is needed: only the public half of the key is in the repository.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// manifest is rackoon-sign's manifest.json.
type manifest struct {
	Version string          `json:"version"`
	Key     string          `json:"key"`
	Files   map[string]file `json:"files"`
}

type file struct {
	// OS is "darwin" for a Mac's agent and Whombat Helper; absent (or "linux") for a Linux server's agent.
	OS   string `json:"os,omitempty"`
	Arch string `json:"arch"`
	// Version is Whombat Helper's own version (its entry only; the agents' is the manifest's).
	Version string `json:"version,omitempty"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Sig     string `json:"sig"`
}

const prefix = "whombat-agent-"

// agentOSes are the systems an agent's name may say.
var agentOSes = map[string]bool{"linux": true, "darwin": true}

// helperName is Whombat Helper's zip (NX-515): signed in the same manifest, for Macs, every architecture.
const helperName = "whombat-helper-macos.zip"

// helperFacts is the json beside the zip, which names its version.
const helperFacts = "whombat-helper-macos.json"

// The exit codes.
const (
	exitMatch      = 0
	exitBroken     = 1
	exitUsage      = 2
	exitOtherBytes = 3
)

// signedName says whether a file in the agents' folder is one the manifest must sign, with its system and arch.
func signedName(name string) (string, string, bool) {
	if name == helperName {
		return "darwin", "universal", true
	}
	return osArch(name)
}

// osArch splits an agent's name into its system and architecture ("whombat-agent-darwin-arm64" → darwin, arm64).
func osArch(name string) (string, string, bool) {
	sys, arch, ok := strings.Cut(strings.TrimPrefix(name, prefix), "-")
	if !strings.HasPrefix(name, prefix) || !ok || !agentOSes[sys] || arch == "" || strings.Contains(arch, "-") {
		return "", "", false
	}
	return sys, arch, true
}

func main() {
	manifestPath := flag.String("manifest", "", "the committed agent-manifest.json")
	publishedPath := flag.String("published", "", "the manifest servers already have, instead of --manifest")
	keyPath := flag.String("key", "", "the committed public key (base64, agent-update-key.pub)")
	version := flag.String("version", "", "the agents' version")
	dir := flag.String("dir", "", "the directory with the agents")
	flag.Parse()
	if (*manifestPath == "") == (*publishedPath == "") || *keyPath == "" || *version == "" || *dir == "" {
		fmt.Fprintln(os.Stderr, "usage: whombat-hosts-manifest-check (--manifest F | --published F) --key F --version V --dir D")
		os.Exit(exitUsage)
	}
	path := *manifestPath + *publishedPath
	m, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the agent manifest can't be read: %v\n", err)
		os.Exit(exitBroken)
	}
	k, err := os.ReadFile(*keyPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "the public key can't be read: %v\n", err)
		os.Exit(exitBroken)
	}
	if *publishedPath != "" {
		if err := afterPublished(m, string(k), *version, *dir); err != nil {
			fmt.Fprintf(os.Stderr, "these agents can't follow the published ones: %v\n", err)
			os.Exit(exitBroken)
		}
		fmt.Printf("agents %s can follow the published manifest %s\n", *version, path)
		return
	}
	otherBytes, err := check(m, string(k), *version, *dir)
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "the agent manifest is not one for these agents: %v. Signing again would hide this: find out why first\n", err)
		os.Exit(exitBroken)
	case len(otherBytes) > 0:
		fmt.Fprintf(os.Stderr, "the agent manifest signs other bytes than the agents built here: %s. They need signing (the maintainers' sign-agents)\n",
			strings.Join(otherBytes, "; "))
		os.Exit(exitOtherBytes)
	}
	fmt.Printf("agent manifest %s: version %s, every agent's size, sha256 and signature match\n", path, *version)
}

// fingerprint is agent.KeyFingerprint: the first 16 hex digits of SHA-256(public key).
func fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

func parseKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("the public key is not a base64 Ed25519 key")
	}
	return ed25519.PublicKey(b), nil
}

func parseManifest(manifestJSON []byte) (manifest, error) {
	var m manifest
	dec := json.NewDecoder(bytes.NewReader(manifestJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("unreadable: %w", err)
	}
	return m, nil
}

// built lists the files in dir that a manifest must sign.
func built(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if _, _, ok := signedName(e.Name()); ok && !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

// check compares the manifest with the agents in dir. err says why the manifest is not one for these agents at all;
// otherBytes lists the files whose size or sha256 differ when everything else holds. Both empty: a match.
func check(manifestJSON []byte, key, version, dir string) (otherBytes []string, err error) {
	pub, err := parseKey(key)
	if err != nil {
		return nil, err
	}
	m, err := parseManifest(manifestJSON)
	if err != nil {
		return nil, err
	}
	var problems []string
	add := func(format string, a ...any) { problems = append(problems, fmt.Sprintf(format, a...)) }
	if m.Version != version {
		add("version %q, the agents are %q", m.Version, version)
	}
	if fp := fingerprint(pub); m.Key != fp {
		add("key %q, the committed key is %q", m.Key, fp)
	}
	names, err := built(dir)
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		add("no agents in %s", dir)
	}
	for _, name := range names {
		if _, ok := m.Files[name]; !ok {
			add("%s is not in it", name)
		}
	}
	signedNames := make([]string, 0, len(m.Files))
	for name := range m.Files {
		signedNames = append(signedNames, name)
	}
	sort.Strings(signedNames)
	for _, name := range signedNames {
		f := m.Files[name]
		sys, arch, ok := signedName(name)
		if name != filepath.Base(name) || !ok {
			add("%s is not an agent's name", name)
			continue
		}
		if f.Arch != arch {
			add("%s: arch %q", name, f.Arch)
		}
		if f.OS != sys && !(f.OS == "" && sys == "linux") {
			add("%s: os %q", name, f.OS)
		}
		if (name == helperName) != (f.Version != "") {
			add("%s: version %q (only Whombat Helper's entry has one)", name, f.Version)
		}
		// The entry by itself: its signature is over the digest it names, whatever was built here.
		digest, derr := hex.DecodeString(f.SHA256)
		sig, serr := base64.StdEncoding.DecodeString(f.Sig)
		if derr != nil || len(digest) != sha256.Size || serr != nil || !ed25519.Verify(pub, digest, sig) {
			add("%s: the signature doesn't verify", name)
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			add("%s was not built", name)
			continue
		}
		sum := sha256.Sum256(b)
		switch got := hex.EncodeToString(sum[:]); {
		case f.SHA256 != got:
			otherBytes = append(otherBytes, fmt.Sprintf("%s: sha256 %s (%d bytes), built %s (%d bytes)", name, f.SHA256, f.Size, got, len(b)))
		case f.Size != int64(len(b)):
			// The same bytes under another size: no signer writes that.
			add("%s: size %d, the file it signs has %d", name, f.Size, len(b))
		}
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, "; "))
	}
	return otherBytes, nil
}

// afterPublished says why the agents in dir, to be published as version, can't follow the published manifest.
func afterPublished(publishedJSON []byte, key, version, dir string) error {
	pub, err := parseKey(key)
	if err != nil {
		return err
	}
	p, err := parseManifest(publishedJSON)
	if err != nil {
		return fmt.Errorf("the published manifest: %w", err)
	}
	var problems []string
	add := func(format string, a ...any) { problems = append(problems, fmt.Sprintf(format, a...)) }
	if fp := fingerprint(pub); p.Key != fp {
		// Installed agents check updates with the key built into them, so a new key reaches none of them.
		add("the committed key is %s, the published agents trust only %s: a new key is a planned change of its own, never part of a release", fp, p.Key)
	}
	names, err := built(dir)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		add("no agents in %s", dir)
	}
	agentsDiffer := false
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		was, known := p.Files[name]
		same := known && was.SHA256 == hex.EncodeToString(sum[:])
		if name != helperName {
			agentsDiffer = agentsDiffer || !same
			continue
		}
		if same {
			continue
		}
		// Whombat Helper: an agent refuses a helper of the installed version or an older one, so another zip under
		// the same version would never install.
		now, err := helperVersion(dir)
		switch c, ordered := compareVersions(now, was.Version); {
		case err != nil:
			add("%s: %v", helperFacts, err)
		case !known:
			// The first helper ever published: any version.
		case !ordered || c <= 0:
			add("Whombat Helper is another zip than the published one, with version %q after %q: it needs a strictly later version", now, was.Version)
		}
	}
	for name := range p.Files {
		if _, _, ok := signedName(name); ok && name != helperName {
			if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
				agentsDiffer = true // an agent that is published and no longer built
			}
		}
	}
	switch c, ordered := compareVersions(version, p.Version); {
	case !agentsDiffer && version != p.Version:
		add("the agents are the published bytes, but their version is %q, not the published %q: the same agents keep their version", version, p.Version)
	case agentsDiffer && version == p.Version:
		add("the agents are other bytes than the published ones under the same version %q: no server would take them", version)
	case agentsDiffer && (!ordered || c <= 0):
		add("version %q is not strictly later than the published %q (agents order versions by their 14-digit time): it needs a later commit", version, p.Version)
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// helperVersion reads Whombat Helper's version from the json beside its zip.
func helperVersion(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, helperFacts))
	if err != nil {
		return "", err
	}
	var facts struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &facts); err != nil || facts.Version == "" {
		return "", errors.New("it names no version")
	}
	return facts.Version, nil
}

// The order agents give versions (hosts/internal/agentver, kept the same here: this module stands alone).

// stampRe is the appliance's version: a commit's UTC time, then its short revision.
var stampRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+-(\d{14})\.([0-9a-z]+)$`)

// semverRe is MAJOR[.MINOR[.PATCH]][-PRERELEASE][+BUILD], with an optional leading v.
var semverRe = regexp.MustCompile(`^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

// compareVersions orders a and b: -1 when a is older, 0 the same, 1 newer. ordered is false when agents can't order
// them: one of them is neither form, or two builds of the same second differ.
func compareVersions(a, b string) (c int, ordered bool) {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == "" || b == "" {
		return 0, false
	}
	if a == b {
		return 0, true
	}
	sa, sb := stampRe.FindStringSubmatch(a), stampRe.FindStringSubmatch(b)
	if sa != nil && sb != nil {
		if sa[1] == sb[1] {
			return 0, false
		}
		return strings.Compare(sa[1], sb[1]), true
	}
	if sa != nil || sb != nil {
		return 0, false
	}
	ma, mb := semverRe.FindStringSubmatch(a), semverRe.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return 0, false
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(orZero(ma[i]))
		y, _ := strconv.Atoi(orZero(mb[i]))
		if x != y {
			return sign(x - y), true
		}
	}
	pa, pb := ma[4], mb[4]
	switch {
	case pa == pb:
		return 0, true
	case pa == "":
		return 1, true
	case pb == "":
		return -1, true
	}
	fa, fb := strings.Split(pa, "."), strings.Split(pb, ".")
	for i := 0; i < len(fa) && i < len(fb); i++ {
		if c := compareIdent(fa[i], fb[i]); c != 0 {
			return c, true
		}
	}
	return sign(len(fa) - len(fb)), true
}

// compareIdent is semver's pre-release identifier order: numbers numerically and before words, words by their bytes.
func compareIdent(x, y string) int {
	nx, ex := strconv.Atoi(x)
	ny, ey := strconv.Atoi(y)
	switch {
	case ex == nil && ey == nil:
		return sign(nx - ny)
	case ex == nil:
		return -1
	case ey == nil:
		return 1
	}
	return strings.Compare(x, y)
}

func orZero(s string) string {
	if s == "" {
		return "0"
	}
	return s
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
