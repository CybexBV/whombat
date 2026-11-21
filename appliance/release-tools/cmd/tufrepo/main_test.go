package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/appliance/release-tools/fakegithub"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func prodFlags(dir, keys string) []string {
	return []string{"--dir", dir, "--env", "prod", "--custody", "online-pilot", "--keys-dir", keys}
}

func TestProdFlagsRefused(t *testing.T) {
	base := t.TempDir()
	dir, keys := filepath.Join(base, "updates"), filepath.Join(base, "tuf")
	refused := map[string][]string{
		"env prod alone":             {"--dir", dir, "--env", "prod"},
		"custody without keys":       {"--dir", dir, "--env", "prod", "--custody", "online-pilot"},
		"keys without custody":       {"--dir", dir, "--env", "prod", "--keys-dir", keys},
		"custody without env prod":   {"--dir", dir, "--custody", "online-pilot", "--keys-dir", keys},
		"custody with env dev":       {"--dir", dir, "--env", "dev", "--custody", "online-pilot", "--keys-dir", keys},
		"another custody":            {"--dir", dir, "--env", "prod", "--custody", "hsm", "--keys-dir", keys},
		"env production":             {"--dir", dir, "--env", "production", "--custody", "online-pilot", "--keys-dir", keys},
		"relative keys dir":          prodFlags(dir, "tuf"),
		"stray positional arguments": append(prodFlags(dir, keys), "extra"),
	}
	for name, args := range refused {
		if err := run("init", args); err == nil {
			t.Errorf("init %s: accepted", name)
		}
	}
	if _, err := os.Stat(keys); err == nil {
		t.Fatal("a refused init created the keys dir")
	}
	if err := run("init", prodFlags(dir, keys)); err != nil {
		t.Fatal(err)
	}
	if err := run("init", prodFlags(dir, keys)); err == nil || !strings.Contains(err.Error(), "already holds keys") {
		t.Fatalf("second init: %v", err)
	}
	// Development-only commands and options on a production repository.
	for _, cmd := range []string{"add-fake-release", "add-index", "add-release", "assign", "hold", "rotate-assignment-key",
		"expire-timestamp", "fixtures", "clients-keygen", "rotate"} {
		if err := run(cmd, prodFlags(dir, keys)); err == nil || !strings.Contains(err.Error(), "not available for production") {
			t.Errorf("%s: %v", cmd, err)
		}
	}
	if err := run("add-clients-role", append(prodFlags(dir, keys), "--key-file", filepath.Join(base, "k.json"))); err == nil {
		t.Error("development key file accepted for a production repository")
	}
	// The production repository without the production flags.
	for _, cmd := range []string{"publish", "status", "add-fake-release"} {
		if err := run(cmd, []string{"--dir", dir}); err == nil || !strings.Contains(err.Error(), "production repository") {
			t.Errorf("%s without prod flags: %v", cmd, err)
		}
	}
	// A development repository with the production flags.
	devDir := filepath.Join(base, "dev")
	if err := run("init", []string{"--dir", devDir}); err != nil {
		t.Fatal(err)
	}
	if err := run("publish", prodFlags(devDir, keys)); err == nil || !strings.Contains(err.Error(), "not a production") {
		t.Errorf("dev repository with prod flags: %v", err)
	}
}

func TestProdCommands(t *testing.T) {
	base := t.TempDir()
	dir, keys := filepath.Join(base, "updates"), filepath.Join(base, "tuf")
	must := func(cmd string, extra ...string) {
		t.Helper()
		if err := run(cmd, append(prodFlags(dir, keys), extra...)); err != nil {
			t.Fatalf("%s: %v", cmd, err)
		}
	}
	must("init")
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	doc := filepath.Join(base, "assignment-keys.json")
	b, _ := json.Marshal(map[string]any{"v": 1, "env": "prod", "keys": []any{map[string]any{"kid": "asg-prod-2026-09",
		"publicKey": hex.EncodeToString(pub), "state": "active", "notBefore": nil, "notAfter": nil}}})
	os.WriteFile(doc, b, 0o644)
	must("set-assignment-keys", "--doc", doc)
	devDoc := filepath.Join(base, "dev-keys.json")
	os.WriteFile(devDoc, []byte(strings.Replace(string(b), `"prod"`, `"dev"`, 1)), 0o644)
	if err := run("set-assignment-keys", append(prodFlags(dir, keys), "--doc", devDoc)); err == nil {
		t.Error("dev assignment keys accepted")
	}
	must("add-clients-role")
	must("clients-keys", "--out", filepath.Join(base, "channel-keys.json"))
	must("refresh")
	must("status")
	must("resign-root")
	root := filepath.Join(base, "tuf-root.json")
	must("export-root", "--out", root)
	rb, _ := os.ReadFile(root)
	cur, _ := os.ReadFile(filepath.Join(dir, "metadata", "root.json"))
	if strings.TrimSpace(string(rb)) != strings.TrimSpace(string(cur)) {
		t.Fatal("export-root differs from metadata/root.json")
	}
	r, err := devtuf.Load(dir, devtuf.Options{Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: keys})
	if err != nil {
		t.Fatal(err)
	}
	s := r.Status()
	if s.Roles["root"].Version != 2 || !r.HasClientsRole() || len(r.AssignmentKeysDoc().Keys) != 1 {
		t.Fatalf("status %+v", s)
	}
	var ck map[string]any
	cb, _ := os.ReadFile(filepath.Join(base, "channel-keys.json"))
	json.Unmarshal(cb, &ck)
	if ck["env"] != "prod" {
		t.Fatalf("channel keys %v", ck)
	}
}

// MG-44: add-release and check-newer refuse an older release of the same id family; check-newer reads a repository on
// this machine or over HTTP without keys and says what it verified.
func TestCheckNewer(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	if err := run("init", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	if err := run("add-fake-release", []string{"--dir", dir, "--id", "whombat-dev-20260928.1", "--host-version", "whombat-dev-20260928.1",
		"--runtime-version", "0.1.0-e847497", "--manager-version", "0.1.0"}); err != nil {
		t.Fatal(err)
	}
	// Tuples to add: made in another repository (add-release takes a tuple file).
	scratch, err := devtuf.New(filepath.Join(base, "scratch"), devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	tuple := func(id, host, rt string) string {
		t.Helper()
		f := devtuf.StandardRelease(id, host, rt)
		f.ManagerVersion = "0.2.0-20260929090000.5d6e7f8"
		tp, err := scratch.AddFakeRelease(f)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(tp)
		p := filepath.Join(base, id+".json")
		os.WriteFile(p, b, 0o644)
		return p
	}
	older := tuple("whombat-dev-20260929.1", "whombat-dev-20260929.1", "0.1.0-195421a")
	newer := tuple("whombat-dev-20260929.2", "whombat-dev-20260929.2", "0.2.0-20260929080000.1a2b3c4")
	if err := run("check-newer", []string{"--dir", dir, "--tuple", older}); err == nil || !strings.Contains(err.Error(), "runtime 0.1.0-195421a < 0.1.0-e847497") {
		t.Fatalf("check-newer older: %v", err)
	}
	if err := run("add-release", []string{"--dir", dir, "--tuple", older}); err == nil || !strings.Contains(err.Error(), "--allow-downgrade-from whombat-dev-20260928.1") {
		t.Fatalf("add-release older: %v", err)
	}
	if err := run("check-newer", []string{"--dir", dir, "--tuple", older, "--allow-downgrade-from", "whombat-dev-20260928.1"}); err != nil {
		t.Fatalf("check-newer custody rollback: %v", err)
	}
	if err := run("check-newer", []string{"--dir", dir, "--tuple", newer}); err != nil {
		t.Fatalf("check-newer newer: %v", err)
	}
	if err := run("check-newer", []string{"--dir", dir, "--id", "whombat-dev-20260929.3", "--host-version", "whombat-dev-20260928.1",
		"--runtime-version", "0.2.0-20260929080000.1a2b3c4", "--manager-version", "0.2.0-20260929090000.5d6e7f8"}); err != nil {
		t.Fatalf("check-newer by flags: %v", err)
	}
	if err := run("check-newer", []string{"--dir", dir, "--tuple", newer, "--id", "x"}); err == nil {
		t.Fatal("--tuple with --id accepted")
	}
	// Before a build (release/ship): a template from `nix eval` whose store paths aren't built and whose NAR hashes are
	// empty or zero. Only the id and the three versions are read.
	template := func(id, rt, narHash string) string {
		p := filepath.Join(base, id+".template.json")
		b, _ := json.Marshal(map[string]any{"releaseId": id,
			"runtime": map[string]any{"version": rt, "storePath": "/nix/store/00000000000000000000000000000000-whombat-runtime-unbuilt",
				"narHash": narHash, "schemaReads": map[string]int{"min": 49, "max": 49}, "schemaWrites": 49},
			"providers": []any{}, "host": map[string]any{"version": id, "storePath": "/nix/store/not-built", "narHash": narHash, "abi": 1},
			"manager": map[string]any{"version": "0.2.0-20260929090000.5d6e7f8", "storePath": "", "narHash": narHash}})
		os.WriteFile(p, b, 0o644)
		return p
	}
	for _, nar := range []string{"", "sha256:" + strings.Repeat("0", 64)} {
		if err := run("check-newer", []string{"--dir", dir, "--tuple", template("whombat-dev-20260929.4", "0.2.0-20260929080000.1a2b3c4", nar)}); err != nil {
			t.Fatalf("unbuilt template (narHash %q): %v", nar, err)
		}
		if err := run("check-newer", []string{"--dir", dir, "--tuple", template("whombat-dev-20260929.5", "0.1.0-195421a", nar)}); err == nil ||
			!strings.Contains(err.Error(), "runtime 0.1.0-195421a < 0.1.0-e847497") {
			t.Fatalf("unbuilt older template (narHash %q): %v", nar, err)
		}
	}
	if err := run("add-release", []string{"--dir", dir, "--tuple", newer}); err != nil {
		t.Fatal(err)
	}
	// Now the older one doesn't sort after the newest either.
	if err := run("check-newer", []string{"--dir", dir, "--tuple", older, "--allow-downgrade-from", "whombat-dev-20260929.2"}); err == nil ||
		!strings.Contains(err.Error(), "doesn't sort after whombat-dev-20260929.2") {
		t.Fatalf("an old id as a rollback: %v", err)
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if s := r.Status(); len(s.Releases) != 2 || s.Releases[1].ID != "whombat-dev-20260929.2" || s.Releases[1].Manager != "0.2.0-20260929090000.5d6e7f8" {
		t.Fatalf("status %+v", s.Releases)
	}
	// Over HTTP: the repository's own first root (said so), or a given root; no keys.
	srv := httptest.NewServer(http.FileServer(http.Dir(filepath.Join(dir, "metadata"))))
	defer srv.Close()
	later := tuple("whombat-dev-20260929.3", "whombat-dev-20260929.3", "0.2.0-20260929100000.9a8b7c6")
	if err := run("check-newer", []string{"--metadata-url", srv.URL + "/", "--tuple", later}); err != nil {
		t.Fatalf("over HTTP: %v", err)
	}
	if err := run("check-newer", []string{"--metadata-url", srv.URL, "--tuple", older}); err == nil || !strings.Contains(err.Error(), "whombat-dev-20260929.2") {
		t.Fatalf("over HTTP, older: %v", err)
	}
	if err := run("check-newer", []string{"--metadata-url", srv.URL, "--tuple", later, "--root", filepath.Join(dir, "metadata", "1.root.json")}); err != nil {
		t.Fatalf("over HTTP from a pinned root: %v", err)
	}
	foreign := filepath.Join(base, "scratch", "metadata", "1.root.json")
	if err := run("check-newer", []string{"--metadata-url", srv.URL, "--tuple", later, "--root", foreign}); err == nil {
		t.Fatal("verified against a foreign root")
	}
	// A published repository must be fresh (MG-50): an expired timestamp fails over HTTP; the repository here only warns.
	if err := run("expire-timestamp", []string{"--dir", dir, "--at", "2026-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := run("check-newer", []string{"--metadata-url", srv.URL, "--tuple", later, "--root", filepath.Join(dir, "metadata", "1.root.json")}); err == nil ||
		!strings.Contains(err.Error(), "timestamp expired") {
		t.Fatalf("over HTTP, expired: %v", err)
	}
	if err := run("check-newer", []string{"--dir", dir, "--tuple", later}); err != nil {
		t.Fatalf("here, expired: %v", err)
	}
	if err := run("publish-timestamp", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	// A production id in a development repository, over HTTP too.
	prodID := template("whombat-20260929.1", "0.2.0-20260929100000.9a8b7c6", "")
	if err := run("check-newer", []string{"--metadata-url", srv.URL, "--tuple", prodID}); err == nil || !strings.Contains(err.Error(), "production release id") {
		t.Fatalf("a production id over HTTP to a dev repository: %v", err)
	}
	for name, args := range map[string][]string{
		"keys over HTTP":    {"--metadata-url", srv.URL, "--tuple", later, "--keys-dir", filepath.Join(base, "k")},
		"custody over HTTP": {"--metadata-url", srv.URL, "--tuple", later, "--custody", "online-pilot"},
		"dir and URL":       {"--metadata-url", srv.URL, "--tuple", later, "--dir", dir},
		"prod flags on dev": append(prodFlags(dir, filepath.Join(base, "k")), "--tuple", later),
		"no repository":     {"--tuple", later},
	} {
		if err := run("check-newer", args); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A production repository: the prod flags (its keys aren't read), and never without them.
	pdir, keys := filepath.Join(base, "updates"), filepath.Join(base, "tuf")
	if err := run("init", prodFlags(pdir, keys)); err != nil {
		t.Fatal(err)
	}
	if err := run("check-newer", append(prodFlags(pdir, keys), "--tuple", prodID)); err != nil {
		t.Fatalf("prod: %v", err)
	}
	// A production repository signs whombat-YYYYMMDD.N only (MG-50, PI-23).
	for _, id := range []string{"whombat-dev-20260929.9", "hotfix-1", "whombat-2026092.1"} {
		if err := run("check-newer", append(prodFlags(pdir, keys), "--tuple", template(id, "0.2.0-20260929100000.9a8b7c6", ""))); err == nil ||
			!strings.Contains(err.Error(), "a production release id is whombat-YYYYMMDD.N") {
			t.Errorf("prod, %s: %v", id, err)
		}
	}
	if err := run("check-newer", []string{"--dir", pdir, "--tuple", prodID}); err == nil || !strings.Contains(err.Error(), "production repository") {
		t.Fatalf("prod without the flags: %v", err)
	}
}

// UP-X14: features names closure-index; nar-list reads a repository (with or without the production flags).
func TestFeaturesAndNarList(t *testing.T) {
	if err := run("features", nil); err != nil {
		t.Fatal(err)
	}
	if len(features) == 0 || features[0] != "closure-index" {
		t.Fatalf("features %v", features)
	}
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	if err := run("init", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	if err := run("nar-list", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	if err := run("nar-list", nil); err == nil {
		t.Fatal("nar-list without --dir")
	}
}

// UP-X24: add-index publishes a component's closure index from one file, as the dev stack and the VM tests do: a
// fixture document (NAR hash of "nar:" + the file) gets its blob, a placeholder for a path the box has (any other NAR
// hash) none; a host's index names its manager. A device resolves the release through them.
func TestAddIndex(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	if err := run("init", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	nar := func(b []byte) string {
		sum := sha256.Sum256(devtuf.FakeNar(b))
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	host, mgr, rt := devtuf.FakeStorePath("nixos-system-whombat-0.0.0-dev"), devtuf.FakeStorePath("whombat-manager-0.0.0-dev"),
		devtuf.FakeStorePath("whombat-runtime-rt-dev-1")
	hostDoc, rtDoc := []byte(`{"fake":true,"kind":"host-generation"}`), []byte(`{"fake":true,"kind":"runtime-bundle"}`)
	hostFile, rtFile := filepath.Join(base, "host.json"), filepath.Join(base, "rt.json")
	os.WriteFile(hostFile, hostDoc, 0o644)
	os.WriteFile(rtFile, rtDoc, 0o644)
	placeholder := "sha256:" + strings.Repeat("ab", 32)
	if err := run("add-index", []string{"--dir", dir, "--kind", "host", "--target", "host/0.0.0-dev/whombat-host.closure", "--file", hostFile,
		"--version", "0.0.0-dev", "--store-path", host, "--nar-hash", nar(hostDoc), "--manager-store-path", mgr}); err != nil {
		t.Fatal(err)
	}
	if err := run("add-index", []string{"--dir", dir, "--kind", "runtime", "--target", "runtime/rt-dev-1/whombat-runtime.closure", "--file", rtFile,
		"--version", "1.0.0", "--store-path", rt, "--nar-hash", placeholder}); err != nil {
		t.Fatal(err)
	}
	if err := run("add-index", []string{"--dir", dir, "--kind", "host", "--target", "host/x/whombat-host.closure", "--file", hostFile,
		"--version", "x", "--store-path", host, "--nar-hash", nar(hostDoc)}); err == nil || !strings.Contains(err.Error(), "manager") {
		t.Fatalf("a host index without its manager: %v", err)
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	f := devtuf.StandardRelease("rt-dev-1", "0.0.0-dev", "1.0.0")
	tp, err := r.AddFakeRelease(f) // a tuple of the same shape, its components replaced by the indexes above
	if err != nil {
		t.Fatal(err)
	}
	tp.Host.StorePath, tp.Host.NarHash = host, nar(hostDoc)
	tp.Manager.StorePath = mgr
	tp.Runtime.StorePath, tp.Runtime.NarHash = rt, placeholder
	tp.Providers = []release.ReleaseTupleProvidersItem{}
	if err := r.AddRelease(tp); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	dev, err := trust.Refresh(trust.Config{PinnedRoot: r.InitialRoot(), MetadataDir: t.TempDir(), MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: r.MetadataDir()}})
	if err != nil {
		t.Fatal(err)
	}
	rel, err := dev.Release("rt-dev-1")
	if err != nil {
		t.Fatal(err)
	}
	read := func(ia *trust.Artifact) *trust.ClosureIndex {
		t.Helper()
		p, _ := r.TargetFilePath(ia.Target)
		b, _ := os.ReadFile(p)
		ci, err := trust.ParseClosureIndex(b, *ia)
		if err != nil {
			t.Fatal(err)
		}
		return ci
	}
	hci, rci := read(rel.HostIndex), read(rel.RuntimeIndex)
	if len(hci.Paths) != 2 || hci.Paths[0].StorePath != mgr || hci.Paths[1].StorePath != host || len(rci.Paths) != 1 {
		t.Fatalf("host %+v runtime %+v", hci.Paths, rci.Paths)
	}
	if _, ok := r.BlobPath(nar(hostDoc)); !ok {
		t.Fatal("no blob for the fixture document")
	}
	if _, ok := r.BlobPath(placeholder); ok {
		t.Fatal("a blob for the placeholder")
	}
}

// The workflow's commands (LNK-25): gh-resign with the keys from the environment, gh-expiry with annotations.
func TestGitHubWorkflowCommands(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "repo")
	r, err := devtuf.New(dir, devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	for env, f := range map[string]string{"TUF_SNAPSHOT_KEY": "snapshot-0.json", "TUF_TIMESTAMP_KEY": "timestamp-0.json"} {
		b, err := os.ReadFile(filepath.Join(dir, "keys", f))
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv(env, string(b))
	}
	before := r.Versions()["timestamp"]
	if err := runGitHub("gh-resign", []string{"--metadata", filepath.Join(dir, "metadata")}); err != nil {
		t.Fatal(err)
	}
	after, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if after.Versions()["timestamp"] != before+1 {
		t.Fatalf("timestamp %d after %d", after.Versions()["timestamp"], before)
	}
	// A role file that doesn't verify (Muse 2): what is signed still serves its last good version, and the workflow is
	// told (its output skipped, which ends the run red after Pages is deployed).
	ghOut := filepath.Join(t.TempDir(), "github-output")
	t.Setenv("GITHUB_OUTPUT", ghOut)
	if err := runGitHub("gh-resign", []string{"--metadata", filepath.Join(dir, "metadata"), "--annotations"}); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(dir, "metadata")
	v := after.RoleVersions()[trust.ChannelDevelopment]
	good, err := os.ReadFile(filepath.Join(meta, fmt.Sprintf("%d.development.json", v)))
	if err != nil {
		t.Fatal(err)
	}
	broken := strings.Replace(string(good), fmt.Sprintf(`"version": %d`, v), fmt.Sprintf(`"version": %d`, v+1), 1)
	if err := os.WriteFile(filepath.Join(meta, fmt.Sprintf("%d.development.json", v+1)), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("gh-resign", []string{"--metadata", meta, "--annotations"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(ghOut); string(b) != "skipped=0\nskipped=1\n" {
		t.Fatalf("the workflow's output %q", b)
	}
	t.Setenv("TUF_SNAPSHOT_KEY", "")
	if err := runGitHub("gh-resign", []string{"--metadata", filepath.Join(dir, "metadata")}); err == nil {
		t.Fatal("re-signed without a key")
	}
	if err := runGitHub("gh-expiry", []string{"--metadata", filepath.Join(dir, "metadata"), "--annotations", "--warn-days", "400,100"}); err != nil {
		t.Fatal(err)
	}
}

// --channel lists a release in one channel role only (a Beta-only release, as install-vm serves it); without channel
// roles it is refused.
func TestAddInChannel(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "repo")
	if err := run("init", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	add := []string{"--dir", dir, "--channel", "development", "--id", "whombat-20261120.1", "--host-version", "26.05.1", "--runtime-version", "1.0.0"}
	if err := run("add-fake-release", add); err == nil || !strings.Contains(err.Error(), "add-channels") {
		t.Fatalf("a channel the repository lacks: %v", err)
	}
	if err := runGitHub("add-channels", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	if err := run("add-fake-release", add); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ids := func(ch string) []string {
		rs, err := r.ChannelReleases(ch)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, x := range rs {
			out = append(out, x.ID)
		}
		return out
	}
	if d, p := ids(trust.ChannelDevelopment), ids(trust.ChannelProduction); len(d) != 1 || d[0] != "whombat-20261120.1" || len(p) != 0 {
		t.Fatalf("development %v, production %v", d, p)
	}
	if top := r.Status(); len(top.Releases) != 0 {
		t.Fatalf("the top level lists %v", top.Releases)
	}
}

// exportDir is a release directory of made-up store paths, as `tufrepo export-release` writes one.
func exportDir(t *testing.T, id, hostV, rtV string) string {
	t.Helper()
	p := func(name string) string { return devtuf.FakeStorePath(name + "-" + id) }
	lib := nixexport.SyntheticPath{StorePath: devtuf.FakeStorePath("glibc-2.40"), Files: map[string]string{"libc.so": "libc"}}
	mgr := nixexport.SyntheticPath{StorePath: p("whombat-manager"), Files: map[string]string{"whombat-manager": id}, References: []string{lib.StorePath}}
	host := nixexport.SyntheticPath{StorePath: p("nixos-system-whombat"), Files: map[string]string{"init": id},
		References: []string{lib.StorePath, mgr.StorePath, p("nixos-system-whombat")}}
	rt := nixexport.SyntheticPath{StorePath: p("whombat-runtime"), Files: map[string]string{"whombat-server": id}, References: []string{lib.StorePath}}
	paths, err := devtuf.NewStreamPaths(nixexport.Synthetic(lib, mgr, host), nixexport.Synthetic(lib, rt))
	if err != nil {
		t.Fatal(err)
	}
	tmpl, _ := json.Marshal(map[string]any{
		"releaseId": id,
		"runtime": map[string]any{"version": rtV, "storePath": rt.StorePath, "narHash": "", "schemaReads": map[string]int{"min": 9, "max": 11},
			"schemaWrites": 10, "protocol": map[string]int{"min": 1000, "max": 1000}, "hostAbi": map[string]int{"min": 2, "max": 4}},
		"providers": []any{},
		"host":      map[string]any{"version": hostV, "storePath": host.StorePath, "narHash": "", "abi": 3},
		"manager":   map[string]any{"version": hostV, "storePath": mgr.StorePath, "narHash": ""},
	})
	dir := filepath.Join(t.TempDir(), id)
	if _, err := devtuf.ExportRelease(context.Background(), dir, tmpl, devtuf.ExportOptions{Paths: paths, NarCache: filepath.Join(t.TempDir(), "nar")}); err != nil {
		t.Fatal(err)
	}
	return dir
}

// publish-release --channel lists a release directory in one channel role of a repository directory, as gh-publish
// signs it but with no GitHub: the tuple and its indexes where a box of the GitHub layout looks for them, version-2
// indexes, nothing at the top level. A channel takes release ids only, in order. The upgrade gates serve such a
// repository to their box.
func TestPublishReleaseInChannel(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "repo")
	if _, err := devtuf.New(dir, devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub}); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("add-channels", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	const first, second = "whombat-20261120.1", "whombat-20261120.2"
	publish := func(id, hostV, rtV string) error {
		return run("publish-release", []string{"--dir", dir, "--channel", trust.ChannelProduction, "--release-dir", exportDir(t, id, hostV, rtV)})
	}
	if err := publish(first, first, "1.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := publish("rt-fixture-1", "whombat-20261120.3", "1.0.3"); err == nil || !strings.Contains(err.Error(), "channel release id") {
		t.Fatalf("an id no channel signs: %v", err)
	}
	if err := publish(second, second, "1.0.2"); err != nil {
		t.Fatal(err)
	}
	if err := publish("whombat-20261119.9", "whombat-20261119.9", "1.0.0"); err == nil {
		t.Fatal("an older release was listed after a newer one")
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	listed := func(ch string) (out []string) {
		rs, err := r.ChannelReleases(ch)
		if err != nil {
			t.Fatal(err)
		}
		for _, x := range rs {
			out = append(out, x.ID)
		}
		return out
	}
	if p, d := listed(trust.ChannelProduction), listed(trust.ChannelDevelopment); fmt.Sprint(p) != fmt.Sprint([]string{first, second}) || len(d) != 0 {
		t.Fatalf("production %v, development %v", p, d)
	}
	if top := r.Status(); len(top.Releases) != 0 {
		t.Fatalf("the top level lists %v", top.Releases)
	}
	// What a box fetches: every file of the release under its id, every blob by its file name.
	files, err := r.ReleaseFiles(trust.ChannelProduction, second)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, f := range files {
		kinds[f.Kind]++
		at := filepath.Join(dir, "targets", f.Tag, f.Name)
		if f.Kind == "blob" {
			at = f.Local
		}
		if st, err := os.Stat(at); err != nil || st.Size() != f.Length {
			t.Fatalf("%s %s/%s: %v", f.Kind, f.Tag, f.Name, err)
		}
	}
	if kinds["tuple"] != 1 || kinds["index"] != 2 || kinds["blob"] == 0 {
		t.Fatalf("the release's files: %v", kinds)
	}
}

func TestPauseAndResumeCommands(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	prodKeyFile := filepath.Join(base, "production.key.json")
	if _, err := devtuf.New(dir, devtuf.Options{Env: "local"}); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("add-channels", []string{"--dir", dir, "--production-key-out", prodKeyFile}); err != nil {
		t.Fatal(err)
	}
	// Production is default; offline key is required.
	if err := runGitHub("pause", []string{"--dir", dir}); err == nil {
		t.Fatal("paused offline production channel without --key-file")
	}
	if err := runGitHub("pause", []string{"--dir", dir, "--channel", "beta"}); err == nil {
		t.Fatal("accepted unknown channel")
	}
	if err := runGitHub("pause", []string{"--dir", dir, "--key-file", prodKeyFile}); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !r.ChannelPaused(trust.ChannelProduction) || r.ChannelPaused(trust.ChannelDevelopment) {
		t.Fatal("production should be paused and development unpaused")
	}
	// Development uses the repository's own key.
	if err := runGitHub("pause", []string{"--dir", dir, "--channel", trust.ChannelDevelopment}); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("resume", []string{"--dir", dir, "--key-file", prodKeyFile}); err != nil {
		t.Fatal(err)
	}
	r, err = devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.ChannelPaused(trust.ChannelProduction) || !r.ChannelPaused(trust.ChannelDevelopment) {
		t.Fatal("expected production resumed and development paused")
	}
	if err := runGitHub("resume", []string{"--dir", dir, "--channel", trust.ChannelDevelopment}); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubPauseAndResumeCommands(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	t.Setenv("WHOMBAT_RELEASES_TOKEN", "tok")
	base := t.TempDir()
	dir := filepath.Join(base, "work")
	origin := filepath.Join(base, "origin.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", origin).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if _, err := devtuf.New(dir, devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub}); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("add-channels", []string{"--dir", dir}); err != nil {
		t.Fatal(err)
	}
	gh := fakegithub.New("CybexBV", "whombat-releases", "tok", filepath.Join(base, "pages"))
	defer gh.Close()
	common := []string{"--dir", dir, "--api", gh.APIURL}
	if err := runGitHub("gh-init", append(append([]string{}, common...), "--remote", origin)); err != nil {
		t.Fatal(err)
	}
	if err := runGitHub("gh-pause", common); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil || !r.ChannelPaused(trust.ChannelProduction) {
		t.Fatalf("after gh-pause: paused=%v err=%v", r != nil && r.ChannelPaused(trust.ChannelProduction), err)
	}
	if err := runGitHub("gh-resume", common); err != nil {
		t.Fatal(err)
	}
	r, err = devtuf.Load(dir, devtuf.Options{})
	if err != nil || r.ChannelPaused(trust.ChannelProduction) {
		t.Fatalf("after gh-resume: paused=%v err=%v", r != nil && r.ChannelPaused(trust.ChannelProduction), err)
	}
}
