package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

func TestKeyAndManifest(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "cfg", "update-signing.key")
	t.Setenv("RACKOON_SIGNING_KEY", keyFile)
	key, err := loadKey()
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(keyFile)
	if err != nil || fi.Mode().Perm() != 0o600 || fi.Size() != ed25519.SeedSize {
		t.Fatalf("key file %v %v", fi, err)
	}
	again, err := loadKey()
	if err != nil || !again.Equal(key) {
		t.Fatal("key not reused")
	}
	pub := key.Public().(ed25519.PublicKey)
	if fingerprint(pub) != agent.KeyFingerprint(pub) {
		t.Fatal("fingerprint differs from the agent's")
	}

	dist := filepath.Join(dir, "dist")
	os.MkdirAll(dist, 0o755)
	os.WriteFile(filepath.Join(dist, "rackoon-agent-linux-amd64"), []byte("amd64 binary"), 0o755)
	os.WriteFile(filepath.Join(dist, "rackoon-agent-linux-arm64"), []byte("arm64 binary!"), 0o755)
	m, err := buildManifest(key, "v1.2.3", dist, []string{"rackoon-agent-linux-arm64", "rackoon-agent-linux-amd64"})
	if err != nil {
		t.Fatal(err)
	}
	f := m.Files["rackoon-agent-linux-arm64"]
	if m.Version != "v1.2.3" || m.Key != fingerprint(pub) || f.Arch != "arm64" || f.Size != 13 || len(f.SHA256) != 64 {
		t.Fatalf("manifest %+v", m)
	}
	if err := verifyManifest(pub, m, dist); err != nil {
		t.Fatal(err)
	}

	// What the hub sends from the manifest verifies on an agent built with
	// this key.
	amd := m.Files["rackoon-agent-linux-amd64"]
	sum, _ := hex.DecodeString(amd.SHA256)
	sig, _ := base64.StdEncoding.DecodeString(amd.Sig)
	u := &agent.Updater{Version: "v1.2.2", Arch: "amd64", Key: pub}
	req := proto.UpdateRequest{Version: m.Version, Arch: amd.Arch, Size: amd.Size, SHA256: sum, Signature: sig}
	if r := u.Check(req); r != nil {
		t.Fatalf("agent refuses the manifest's signature: %+v", r)
	}
	_, other, _ := ed25519.GenerateKey(nil)
	u.Key = other.Public().(ed25519.PublicKey)
	if r := u.Check(req); r == nil || r.Code != agent.CodeBadSignature {
		t.Fatalf("other key: %+v", r)
	}

	os.WriteFile(filepath.Join(dist, "rackoon-agent-linux-amd64"), []byte("amd64 binarY"), 0o755)
	if err := verifyManifest(pub, m, dist); err == nil {
		t.Fatal("tampered file verified")
	}
	if _, err := buildManifest(key, "v1", dist, []string{"rackoon-agent"}); err == nil {
		t.Fatal("name without arch accepted")
	}
	os.WriteFile(filepath.Join(dist, "whombat-agent-darwin-arm64"), []byte("mac binary"), 0o755)
	mm, err := buildManifest(key, "v1", dist, []string{"whombat-agent-darwin-arm64", "rackoon-agent-linux-amd64"})
	if err != nil {
		t.Fatal(err)
	}
	if f := mm.Files["whombat-agent-darwin-arm64"]; f.OS != "darwin" || f.Arch != "arm64" {
		t.Errorf("darwin entry %+v", f)
	}
	if f := mm.Files["rackoon-agent-linux-amd64"]; f.OS != "" || f.Arch != "amd64" {
		t.Errorf("linux entry %+v", f)
	}
	os.WriteFile(filepath.Join(dist, "whombat-agent-windows-arm64.exe"), []byte("windows binary"), 0o755)
	wm, err := buildManifest(key, "v1", dist, []string{"whombat-agent-windows-arm64.exe"})
	if err != nil {
		t.Fatal(err)
	}
	if f := wm.Files["whombat-agent-windows-arm64.exe"]; f.OS != "windows" || f.Arch != "arm64" {
		t.Errorf("windows entry %+v", f)
	}
	if _, err := buildManifest(key, "v1", dist, []string{"whombat-agent-windows-arm64"}); err == nil {
		t.Fatal("a Windows build without .exe accepted")
	}

	// Bad key files.
	os.Chmod(keyFile, 0o644)
	if _, err := loadKey(); err == nil {
		t.Fatal("world-readable key accepted")
	}
	wd, _ := os.Getwd()
	t.Setenv("RACKOON_SIGNING_KEY", filepath.Join(wd, "test.key"))
	if _, err := loadKey(); err == nil {
		t.Fatal("key inside the repository accepted")
	}
	if _, err := os.Stat(filepath.Join(wd, "test.key")); err == nil {
		os.Remove(filepath.Join(wd, "test.key"))
		t.Fatal("key created inside the repository")
	}
}

func TestHelperEntry(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("RACKOON_SIGNING_KEY", filepath.Join(dir, "cfg", "update-signing.key"))
	key, err := loadKey()
	if err != nil {
		t.Fatal(err)
	}
	pub := key.Public().(ed25519.PublicKey)
	dist := filepath.Join(dir, "dist")
	os.MkdirAll(dist, 0o755)
	zip := []byte("PK\x03\x04 Whombat Helper.app")
	sum := sha256.Sum256(zip)
	os.WriteFile(filepath.Join(dist, helperZip), zip, 0o644)
	os.WriteFile(filepath.Join(dist, "whombat-agent-darwin-arm64"), []byte("mac agent"), 0o755)
	desc := func(version, sha string, size int) {
		// build.sh's description; the team is for the hub, not the manifest.
		os.WriteFile(filepath.Join(dist, helperJSON), []byte(fmt.Sprintf(
			`{"version": %q, "sha256": %q, "size": %d, "team": "AB12CD34EF"}`, version, sha, size)), 0o644)
	}
	desc("1.2.0", hex.EncodeToString(sum[:]), len(zip))
	names := []string{helperZip, "whombat-agent-darwin-arm64"}
	m, err := buildManifest(key, "0.0.0-20261117120000.abc1234", dist, names)
	if err != nil {
		t.Fatal(err)
	}
	f := m.Files[helperZip]
	if f.OS != "darwin" || f.Arch != "universal" || f.Version != "1.2.0" || f.Size != int64(len(zip)) || f.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("helper entry %+v", f)
	}
	if err := verifyManifest(pub, m, dist); err != nil {
		t.Fatal(err)
	}
	// The exact shape the appliance's manifest check expects: version on
	// the helper's entry only, no team.
	b, _ := json.Marshal(m)
	var raw struct {
		Files map[string]map[string]any `json:"files"`
	}
	json.Unmarshal(b, &raw)
	keysOf := func(e map[string]any) []string {
		var k []string
		for n := range e {
			k = append(k, n)
		}
		sort.Strings(k)
		return k
	}
	if k := keysOf(raw.Files[helperZip]); !reflect.DeepEqual(k, []string{"arch", "os", "sha256", "sig", "size", "version"}) {
		t.Fatalf("helper entry keys %v", k)
	}
	if k := keysOf(raw.Files["whombat-agent-darwin-arm64"]); !reflect.DeepEqual(k, []string{"arch", "os", "sha256", "sig", "size"}) {
		t.Fatalf("agent entry keys %v", k)
	}

	// What the hub sends from the entry verifies on a Mac's agent.
	sig, _ := base64.StdEncoding.DecodeString(f.Sig)
	req := proto.UpdateRequest{Component: proto.UpdateComponentHelper, Version: f.Version, Arch: f.Arch, Size: f.Size,
		SHA256: sum[:], Signature: sig}
	if r := agent.CheckHelper(req, pub, "1.0.0"); r != nil {
		t.Fatalf("the agent refuses the helper's signature: %+v", r)
	}

	// A description of another zip, none, or a bad version: refused.
	desc("1.2.0", hex.EncodeToString(make([]byte, 32)), len(zip))
	if _, err := buildManifest(key, "v1", dist, names); err == nil {
		t.Fatal("a description of another zip accepted")
	}
	desc("1.2.0", hex.EncodeToString(sum[:]), len(zip)+1)
	if _, err := buildManifest(key, "v1", dist, names); err == nil {
		t.Fatal("a description of another size accepted")
	}
	desc("1.2 beta", hex.EncodeToString(sum[:]), len(zip))
	if _, err := buildManifest(key, "v1", dist, names); err == nil {
		t.Fatal("a bad version accepted")
	}
	os.Remove(filepath.Join(dist, helperJSON))
	if _, err := buildManifest(key, "v1", dist, names); err == nil {
		t.Fatal("a helper without its description accepted")
	}
	// Other names that aren't an agent's stay refused.
	desc("1.2.0", hex.EncodeToString(sum[:]), len(zip))
	os.WriteFile(filepath.Join(dist, "notes.zip"), zip, 0o644)
	for _, n := range []string{helperJSON, "notes.zip", "whombat-helper-macos"} {
		if _, err := buildManifest(key, "v1", dist, []string{n}); err == nil {
			t.Errorf("%s accepted", n)
		}
	}
	// A tampered entry fails verify.
	m.Files[helperZip] = File{OS: "darwin", Arch: "arm64", Version: f.Version, Size: f.Size, SHA256: f.SHA256, Sig: f.Sig}
	if err := verifyManifest(pub, m, dist); err == nil {
		t.Fatal("a helper entry of another arch verified")
	}
}
