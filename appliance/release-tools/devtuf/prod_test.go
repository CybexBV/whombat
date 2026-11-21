package devtuf_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/appliance/release-tools/nixexport"
	"github.com/CybexBV/whombat/contracts/go/release"
)

var t0 = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func prodOpts(keys string, c *clock) devtuf.Options {
	return devtuf.Options{Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: keys, Now: c.now}
}

func dirs(t *testing.T) (repo, keys string) {
	base := t.TempDir()
	return filepath.Join(base, "updates"), filepath.Join(base, "secrets", "tuf")
}

func TestProdModeRefusals(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	cases := map[string]devtuf.Options{
		"prod without custody":       {Env: "prod", KeysDir: keys},
		"production without custody": {Env: "production"},
		"custody in dev":             {Env: "dev", Custody: devtuf.CustodyOnlinePilot, KeysDir: keys},
		"custody in local":           {Env: "local", Custody: devtuf.CustodyOnlinePilot, KeysDir: keys},
		"unknown custody":            {Env: "prod", Custody: "offline", KeysDir: keys},
		"no keys dir":                {Env: "prod", Custody: devtuf.CustodyOnlinePilot},
		"relative keys dir":          {Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: "keys"},
		"keys inside the repo":       {Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: filepath.Join(repo, "keys")},
		"repo inside the keys":       {Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: filepath.Dir(repo)},
	}
	for name, o := range cases {
		o.Now = c.now
		if _, err := devtuf.New(repo, o); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An open keys dir.
	os.MkdirAll(keys, 0o755)
	os.Chmod(keys, 0o755)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err == nil || !strings.Contains(err.Error(), "0700") {
		t.Errorf("open keys dir: %v", err)
	}
	// A keys dir that already holds keys (tuf-init twice).
	os.Chmod(keys, 0o700)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err != nil {
		t.Fatal(err)
	}
	if _, err := devtuf.New(filepath.Join(filepath.Dir(repo), "other"), prodOpts(keys, c)); err == nil || !strings.Contains(err.Error(), "already holds keys") {
		t.Errorf("second key set: %v", err)
	}
	keys2 := filepath.Join(filepath.Dir(keys), "tuf2")
	if _, err := devtuf.New(repo, prodOpts(keys2, c)); err == nil || !strings.Contains(err.Error(), "already holds a repository") {
		t.Errorf("second repository: %v", err)
	}
	// A symlinked keys dir.
	link := filepath.Join(filepath.Dir(keys), "link")
	os.Symlink(keys2, link)
	os.MkdirAll(keys2, 0o700)
	if _, err := devtuf.New(filepath.Join(filepath.Dir(repo), "third"), prodOpts(link, c)); err == nil {
		t.Error("symlinked keys dir accepted")
	}
}

func TestProdNeverMixesWithDev(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err != nil {
		t.Fatal(err)
	}
	if _, err := devtuf.Load(repo, devtuf.Options{Now: c.now}); err == nil || !strings.Contains(err.Error(), "production repository") {
		t.Fatalf("dev load of a prod repo: %v", err)
	}
	devRepo := filepath.Join(t.TempDir(), "dev")
	dev, err := devtuf.New(devRepo, devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	devKeys := filepath.Join(t.TempDir(), "k")
	os.MkdirAll(devKeys, 0o700)
	if _, err := devtuf.Load(devRepo, prodOpts(devKeys, c)); err == nil || !strings.Contains(err.Error(), "not a production") {
		t.Fatalf("prod load of a dev repo: %v", err)
	}
	// A development key file among the production keys.
	if err := devtuf.WriteKeyFile(filepath.Join(keys, "root-dev.json"), "root", devtuf.NewDevKey()); err != nil {
		t.Fatal(err)
	}
	if _, err := devtuf.Load(repo, prodOpts(keys, c)); err == nil || !strings.Contains(err.Error(), "not a production") {
		t.Fatalf("dev key in prod keys dir: %v", err)
	}
	os.Remove(filepath.Join(keys, "root-dev.json"))
	// A production key file among the development keys.
	entries, _ := os.ReadDir(keys)
	b, _ := os.ReadFile(filepath.Join(keys, entries[0].Name()))
	os.WriteFile(filepath.Join(devRepo, "keys", "prod.json"), b, 0o600)
	if _, err := devtuf.Load(devRepo, devtuf.Options{Now: c.now}); err == nil || !strings.Contains(err.Error(), "not a development key") {
		t.Fatalf("prod key in dev keys: %v", err)
	}
	// Assignment keys of another environment.
	pub := hex.EncodeToString(dev.AssignmentKey().Public().(ed25519.PublicKey))
	r, err := devtuf.Load(repo, prodOpts(keys, c))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetAssignmentKeysDoc(release.AssignmentKeys{V: 1, Env: "dev", Keys: []release.AssignmentKeysKeysItem{{Kid: "asg-dev-x", PublicKey: pub, State: "active"}}}); err == nil {
		t.Fatal("dev assignment keys accepted in prod")
	}
	// A key file readable by others.
	os.Chmod(filepath.Join(keys, entries[0].Name()), 0o644)
	if _, err := devtuf.Load(repo, prodOpts(keys, c)); err == nil || !strings.Contains(err.Error(), "0600") {
		t.Fatalf("open key file: %v", err)
	}
}

// fixtureRelease builds a release directory from synthetic export streams: a host closure containing the manager
// and a shared library, a runtime closure.
type fixtureRelease struct {
	host, manager, lib, runtime string
}

func storePath(name string) string { return devtuf.FakeStorePath(name) }

func newFixture(tag string) fixtureRelease {
	return fixtureRelease{
		host:    storePath("nixos-system-whombat-" + tag),
		manager: storePath("whombat-manager-" + tag),
		lib:     storePath("glibc-2.40"),
		runtime: storePath("whombat-runtime-" + tag),
	}
}

func (f fixtureRelease) streams() map[string][]byte {
	lib := nixexport.SyntheticPath{StorePath: f.lib, Files: map[string]string{"libc.so": "libc"}}
	mgr := nixexport.SyntheticPath{StorePath: f.manager, Files: map[string]string{"whombat-manager": "manager " + f.manager}, References: []string{f.lib}}
	host := nixexport.SyntheticPath{StorePath: f.host, Files: map[string]string{"init": "host " + f.host}, References: []string{f.lib, f.manager, f.host}}
	rt := nixexport.SyntheticPath{StorePath: f.runtime, Files: map[string]string{"whombat-server": "runtime " + f.runtime}, References: []string{f.lib}}
	return map[string][]byte{
		f.host:    nixexport.Synthetic(lib, mgr, host),
		f.runtime: nixexport.Synthetic(lib, rt),
	}
}

// opts are export options reading the fixture's store (its synthetic streams) with a NAR cache of its own.
func (f fixtureRelease) opts(t *testing.T, o devtuf.ExportOptions) devtuf.ExportOptions {
	t.Helper()
	o.Paths, o.NarCache = f.paths(t), filepath.Join(t.TempDir(), "nar")
	return o
}

func (f fixtureRelease) template(id, hostV, rtV string) []byte {
	t := map[string]any{
		"releaseId": id,
		"runtime": map[string]any{"version": rtV, "storePath": f.runtime, "narHash": "", "schemaReads": map[string]int{"min": 9, "max": 11},
			"schemaWrites": 10, "protocol": map[string]int{"min": 1000, "max": 1000}, "hostAbi": map[string]int{"min": 2, "max": 4}},
		"providers": []any{},
		"host":      map[string]any{"version": hostV, "storePath": f.host, "narHash": "", "abi": 3},
		"manager":   map[string]any{"version": hostV, "storePath": f.manager, "narHash": ""},
	}
	b, _ := json.Marshal(t)
	return b
}

func controlKey(t *testing.T) (ed25519.PrivateKey, string) {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k, hex.EncodeToString(k.Public().(ed25519.PublicKey))
}

func TestProdRepositoryEndToEnd(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	r, err := devtuf.New(repo, prodOpts(keys, c))
	if err != nil {
		t.Fatal(err)
	}
	// Keys: 0700 dir, one 0600 production key file per role, no assignment key.
	st, _ := os.Stat(keys)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("keys dir mode %v", st.Mode())
	}
	entries, _ := os.ReadDir(keys)
	roles := map[string]bool{}
	for _, e := range entries {
		info, _ := e.Info()
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %v", e.Name(), info.Mode())
		}
		b, _ := os.ReadFile(filepath.Join(keys, e.Name()))
		var kf map[string]any
		json.Unmarshal(b, &kf)
		if kf["development"] != false || kf["environment"] != "prod" || kf["custody"] != "online-pilot" {
			t.Fatalf("%s: %v", e.Name(), kf)
		}
		roles[kf["role"].(string)] = true
	}
	if len(entries) != 4 || !roles["root"] || !roles["targets"] || !roles["snapshot"] || !roles["timestamp"] {
		t.Fatalf("key files %v", roles)
	}
	if _, err := os.Stat(filepath.Join(repo, "keys")); err == nil {
		t.Fatal("keys inside the served repository")
	}
	if r.AssignmentKey() != nil {
		t.Fatal("prod repository made an assignment key")
	}
	if _, err := r.Assign("dev-1", "x", 1, time.Hour); err == nil {
		t.Fatal("prod repository signed an assignment")
	}
	// Expiries (updates-release-signing.md, PI-05).
	s := r.Status()
	want := map[string]time.Duration{"root": 120 * 24 * time.Hour, "targets": 90 * 24 * time.Hour, "snapshot": 7 * 24 * time.Hour, "timestamp": 24 * time.Hour}
	for role, d := range want {
		if got := s.Roles[role].Expires.Sub(t0); got != d {
			t.Errorf("%s expires after %v, want %v", role, got, d)
		}
	}
	if s.Development || s.Custody != devtuf.CustodyOnlinePilot {
		t.Fatalf("status %+v", s)
	}

	// Control's assignment key and the clients role, as tuf-init does.
	ctl, ctlPub := controlKey(t)
	r, err = devtuf.Load(repo, prodOpts(keys, c))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetAssignmentKeysDoc(release.AssignmentKeys{V: 1, Env: "prod", Keys: []release.AssignmentKeysKeysItem{{Kid: "asg-prod-2026-09", PublicKey: ctlPub, State: "active"}}}); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	ck, err := r.ClientChannelKeys()
	if err != nil || ck.Env != "prod" || !strings.HasPrefix(ck.Keys[0].Kid, "clients-prod-") {
		t.Fatalf("channel keys %+v %v", ck, err)
	}
	if entries, _ := os.ReadDir(keys); len(entries) != 5 {
		t.Fatalf("clients key not saved: %d files", len(entries))
	}

	// A real-format release.
	f := newFixture("26.10.1")
	rel := filepath.Join(t.TempDir(), "rel")
	m, err := devtuf.ExportRelease(context.Background(), rel, f.template("whombat-20261001.1", "26.10.1", "1.0.0"), f.opts(t, devtuf.ExportOptions{}))
	if err != nil {
		t.Fatal(err)
	}
	if m.Tuple.Manager.NarHash == "" || m.Tuple.Host.NarHash == "" || m.Indexes[0].Meta.ClosureSize == 0 {
		t.Fatalf("export did not fill hashes: %+v", m)
	}
	r, err = devtuf.Load(repo, prodOpts(keys, c))
	if err != nil {
		t.Fatal(err)
	}
	res, err := r.PublishRelease(rel, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Added) != 2 || res.AlreadyPublished {
		t.Fatalf("publish %+v", res)
	}
	digest, _ := release.TupleDigest(&m.Tuple)
	if res.TupleDigest != digest {
		t.Fatalf("digest %s, contract says %s", res.TupleDigest, digest)
	}
	// Idempotent.
	r, _ = devtuf.Load(repo, prodOpts(keys, c))
	if res, err := r.PublishRelease(rel, devtuf.PublishOptions{}); err != nil || !res.AlreadyPublished {
		t.Fatalf("republish %+v %v", res, err)
	}

	// The device: refresh from the exported root with the production checks, release, artifacts, assignment.
	pinned, err := devtuf.VerifiedRoot(repo, true)
	if err != nil {
		t.Fatal(err)
	}
	device := func(now time.Time, cache string) *trust.Repo {
		t.Helper()
		v, err := trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: cache, MetadataURL: "fx://m", Production: true, ResolveClients: true,
			Fetcher: trust.DirFetcher{BaseURL: "fx://m", Dir: filepath.Join(repo, "metadata")}, Now: now})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cache := t.TempDir()
	v := device(c.t, cache)
	rl, err := v.Release("whombat-20261001.1")
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range rl.Artifacts() {
		p := filepath.Join(repo, "targets", filepath.FromSlash(filepath.Dir(a.Target)), a.SHA256()+"."+filepath.Base(a.Target))
		if err := trust.VerifyFile(p, a); err != nil {
			t.Fatal(err)
		}
	}
	ks, err := v.AssignmentKeys("prod", c.t)
	if err != nil {
		t.Fatal(err)
	}
	rid := "whombat-20261001.1"
	payload := release.AssignmentPayload{Purpose: release.AssignmentPurpose, Env: "prod", Device: "dev-1", Sequence: 1, Action: "install",
		ReleaseID: &rid, TupleDigest: &digest, IssuedAt: c.t.Unix(), NotBefore: c.t.Unix(), ExpiresAt: c.t.Add(time.Hour).Unix()}
	raw, err := trust.SignAssignment(payload, "asg-prod-2026-09", ctl)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: "dev-1", Env: "prod", Now: c.t}); err != nil {
		t.Fatal(err)
	}
	// The clients role verifies; no channel is published yet.
	if err := v.ClientsError(); err == nil || !strings.Contains(err.Error(), "clients/channel.json not found") {
		t.Fatalf("clients role: %v", err)
	}

	// The timer: every 6 h snapshot and timestamp; after 15 days also the clients role; after 80 days targets.
	versions := func() map[string]devtuf.RoleState {
		r, err := devtuf.Load(repo, prodOpts(keys, c))
		if err != nil {
			t.Fatal(err)
		}
		return r.Status().Roles
	}
	refresh := func() []string {
		t.Helper()
		r, err := devtuf.Load(repo, prodOpts(keys, c))
		if err != nil {
			t.Fatal(err)
		}
		signed, err := r.Refresh(devtuf.TargetsRenewWithin, devtuf.ClientsRenewWithin)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	before := versions()
	c.t = c.t.Add(6 * time.Hour)
	if got := strings.Join(refresh(), ","); got != "snapshot,timestamp" {
		t.Fatalf("6 h refresh signed %s", got)
	}
	after := versions()
	if after["snapshot"].Version != before["snapshot"].Version+1 || after["timestamp"].Version != before["timestamp"].Version+1 ||
		after["targets"].Version != before["targets"].Version || !after["timestamp"].Expires.Equal(c.t.Add(24*time.Hour)) {
		t.Fatalf("before %+v after %+v", before, after)
	}
	c.t = t0.Add(15 * 24 * time.Hour)
	if got := strings.Join(refresh(), ","); got != "clients,snapshot,timestamp" {
		t.Fatalf("day 15 refresh signed %s", got)
	}
	c.t = t0.Add(80 * 24 * time.Hour)
	if got := strings.Join(refresh(), ","); got != "clients,targets,snapshot,timestamp" {
		t.Fatalf("day 80 refresh signed %s", got)
	}
	v = device(c.t, cache)
	if _, err := v.Release("whombat-20261001.1"); err != nil {
		t.Fatal(err)
	}
	// The root warns within 30 days of its expiry, and re-signing it is walked by devices pinned to v1.
	c.t = t0.Add(95 * 24 * time.Hour)
	r, _ = devtuf.Load(repo, prodOpts(keys, c))
	if _, err := r.Refresh(devtuf.TargetsRenewWithin, devtuf.ClientsRenewWithin); err != nil {
		t.Fatal(err)
	}
	if s := r.Status(); len(s.Warnings) != 1 || !strings.Contains(s.Warnings[0], "root expires") {
		t.Fatalf("warnings %v", s.Warnings)
	}
	if err := r.ResignRoot(); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Refresh(devtuf.TargetsRenewWithin, devtuf.ClientsRenewWithin); err != nil {
		t.Fatal(err)
	}
	c.t = t0.Add(125 * 24 * time.Hour)
	r, _ = devtuf.Load(repo, prodOpts(keys, c))
	if _, err := r.Refresh(devtuf.TargetsRenewWithin, devtuf.ClientsRenewWithin); err != nil {
		t.Fatal(err)
	}
	v = device(c.t, t.TempDir()) // a new device, pinned to root v1 (expired by now)
	if v.RootVersion != 2 {
		t.Fatalf("root version %d", v.RootVersion)
	}
}

func TestPublishReleaseRefuses(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err != nil {
		t.Fatal(err)
	}
	load := func() *devtuf.Repo {
		r, err := devtuf.Load(repo, prodOpts(keys, c))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	f := newFixture("26.10.1")
	export := func(id, hostV, rtV string, fx fixtureRelease, o devtuf.ExportOptions, tmpl []byte) string {
		t.Helper()
		d := filepath.Join(t.TempDir(), id)
		if tmpl == nil {
			tmpl = fx.template(id, hostV, rtV)
		}
		if _, err := devtuf.ExportRelease(context.Background(), d, tmpl, fx.opts(t, o)); err != nil {
			t.Fatal(err)
		}
		return d
	}
	good := export("whombat-20261001.1", "26.10.1", "1.0.0", f, devtuf.ExportOptions{}, nil)
	edit := func(src string, change func(m map[string]any)) string {
		d := copyDir(t, src, false)
		var m map[string]any
		b, _ := os.ReadFile(filepath.Join(d, "release.json"))
		json.Unmarshal(b, &m)
		change(m)
		b, _ = json.Marshal(m)
		os.WriteFile(filepath.Join(d, "release.json"), b, 0o644)
		return d
	}
	art := func(m map[string]any, i int) map[string]any { return m["indexes"].([]any)[i].(map[string]any) }
	meta := func(m map[string]any, i int) map[string]any { return art(m, i)["meta"].(map[string]any) }
	bad := map[string]string{
		"narHash in metadata and tuple edited": edit(good, func(m map[string]any) {
			h := "sha256:" + strings.Repeat("ab", 32)
			meta(m, 1)["narHash"] = h
			m["tuple"].(map[string]any)["runtime"].(map[string]any)["narHash"] = h
		}),
		"closure size edited":  edit(good, func(m map[string]any) { meta(m, 1)["closureSize"] = 1 }),
		"file traversal":       edit(good, func(m map[string]any) { art(m, 1)["file"] = "../runtime.paths.json" }),
		"file is the manifest": edit(good, func(m map[string]any) { art(m, 1)["file"] = "release.json" }),
		"target traversal":     edit(good, func(m map[string]any) { art(m, 1)["target"] = "runtime/../host/x" }),
		"unknown field":        edit(good, func(m map[string]any) { m["extra"] = true }),
		"id mismatch":          edit(good, func(m map[string]any) { m["releaseId"] = "rt-other" }),
		"incompatible tuple": edit(good, func(m map[string]any) {
			m["tuple"].(map[string]any)["host"].(map[string]any)["abi"] = 9
		}),
		"manager not in host": edit(good, func(m map[string]any) {
			p := storePath("whombat-manager-other")
			meta(m, 0)["managerStorePath"] = p
			m["tuple"].(map[string]any)["manager"].(map[string]any)["storePath"] = p
		}),
		"index for no component": edit(good, func(m map[string]any) { meta(m, 1)["version"] = "9.9.9" }),
		"missing component":      edit(good, func(m map[string]any) { m["indexes"] = m["indexes"].([]any)[:1] }),
	}
	// A listing that is not a closure: the runtime without its library.
	d := edit(good, func(map[string]any) {})
	var listing map[string]any
	b, _ := os.ReadFile(filepath.Join(d, "runtime.paths.json"))
	json.Unmarshal(b, &listing)
	paths := listing["paths"].([]any)
	listing["paths"] = paths[len(paths)-1:]
	b, _ = json.Marshal(listing)
	os.WriteFile(filepath.Join(d, "runtime.paths.json"), b, 0o644)
	bad["incomplete closure"] = d
	d = edit(good, func(map[string]any) {})
	os.WriteFile(filepath.Join(d, "runtime.paths.json"), []byte("not a listing"), 0o644)
	bad["not a listing"] = d
	for name, dir := range bad {
		if _, err := load().PublishRelease(dir, devtuf.PublishOptions{}); err == nil {
			t.Errorf("%s: published", name)
		} else if strings.Contains(err.Error(), "no such file") && name != "file traversal" {
			t.Errorf("%s: %v", name, err)
		}
		// Nothing half-published: no release, no incoming files left.
		if s := load().Status(); len(s.Releases) != 0 {
			t.Fatalf("%s: releases %v", name, s.Releases)
		}
	}
	filepath.Walk(filepath.Join(repo, "targets"), func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasPrefix(info.Name(), ".incoming-") {
			t.Errorf("left behind: %s", p)
		}
		return nil
	})
	if _, err := load().PublishRelease(good, devtuf.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	// Same id, different tuple.
	f2 := newFixture("26.10.2")
	other := export("whombat-20261001.1", "26.10.2", "1.0.1", f2, devtuf.ExportOptions{}, nil)
	if _, err := load().PublishRelease(other, devtuf.PublishOptions{}); err == nil || !strings.Contains(err.Error(), "different tuple") {
		t.Fatalf("same id: %v", err)
	}
	// Same target path, different bytes (a rebuilt runtime under the same version).
	f3 := f
	f3.runtime = storePath("whombat-runtime-rebuilt")
	rebuilt := export("whombat-20261001.2", "26.10.1", "1.0.0", f3, devtuf.ExportOptions{}, nil)
	if _, err := load().PublishRelease(rebuilt, devtuf.PublishOptions{}); err == nil || !strings.Contains(err.Error(), "different bytes") {
		t.Fatalf("same target: %v", err)
	}
	// A runtime-only release reuses the published host.
	var gm devtuf.ReleaseManifest
	b, _ = os.ReadFile(filepath.Join(good, "release.json"))
	json.Unmarshal(b, &gm)
	f4 := f
	f4.runtime = storePath("whombat-runtime-1.0.2")
	var tmpl map[string]any
	json.Unmarshal(f4.template("whombat-20261001.3", "26.10.1", "1.0.2"), &tmpl)
	tmpl["host"].(map[string]any)["narHash"] = gm.Tuple.Host.NarHash
	tmpl["manager"].(map[string]any)["narHash"] = gm.Tuple.Manager.NarHash
	tb, _ := json.Marshal(tmpl)
	rtOnly := export("whombat-20261001.3", "", "", f4, devtuf.ExportOptions{ReuseHost: true}, tb)
	res, err := load().PublishRelease(rtOnly, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Added) != 1 || len(res.Reused) != 1 || res.Reused[0] != devtuf.HostIndexTarget("26.10.1") {
		t.Fatalf("runtime-only %+v", res)
	}
	// --reuse-host without the hashes, and a template hash that does not match the store.
	if _, err := devtuf.ExportRelease(context.Background(), filepath.Join(t.TempDir(), "x"), f4.template("rt-d", "26.10.1", "1.0.2"), f4.opts(t, devtuf.ExportOptions{ReuseHost: true})); err == nil {
		t.Error("reuse-host without hashes")
	}
	json.Unmarshal(f.template("rt-e", "26.10.1", "1.0.0"), &tmpl)
	tmpl["runtime"].(map[string]any)["narHash"] = "sha256:" + strings.Repeat("0", 64)
	tb, _ = json.Marshal(tmpl)
	if _, err := devtuf.ExportRelease(context.Background(), filepath.Join(t.TempDir(), "y"), tb, f.opts(t, devtuf.ExportOptions{})); err == nil {
		t.Error("wrong template narHash")
	}
}

// A host release that keeps the published runtime: the image changed, the runtime is the published one, version and
// bytes. Its release directory carries the runtime's index again (the build exports what the release is made of), and
// the repository takes it, because the target has the same bytes. Nothing of the runtime is written again, also when
// the build compressed its blobs afresh. Only other bytes under the published version are refused.
func TestHostReleaseKeepsPublishedRuntime(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err != nil {
		t.Fatal(err)
	}
	load := func() *devtuf.Repo {
		r, err := devtuf.Load(repo, prodOpts(keys, c))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	// Each export has a NAR cache of its own, as a build machine whose cache was emptied in between.
	export := func(id, hostV, rtV string, fx fixtureRelease) string {
		t.Helper()
		d := filepath.Join(t.TempDir(), id)
		if _, err := devtuf.ExportRelease(context.Background(), d, fx.template(id, hostV, rtV), fx.opts(t, devtuf.ExportOptions{})); err != nil {
			t.Fatal(err)
		}
		return d
	}
	first := newFixture("26.10.1")
	if _, err := load().PublishRelease(export("whombat-20261001.1", "26.10.1", "1.0.0", first), devtuf.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	blobs := func() int {
		t.Helper()
		b, err := devtuf.ListBlobs(repo)
		if err != nil {
			t.Fatal(err)
		}
		return len(b)
	}
	before := blobs()

	kept := newFixture("26.10.2")
	kept.runtime = first.runtime
	res, err := load().PublishRelease(export("whombat-20261001.2", "26.10.2", "1.0.0", kept), devtuf.PublishOptions{})
	if err != nil {
		t.Fatalf("a host release that keeps the runtime: %v", err)
	}
	rt, host := devtuf.RuntimeIndexTarget("1.0.0"), devtuf.HostIndexTarget("26.10.2")
	if !slices.Contains(res.Reused, rt) || slices.Contains(res.Added, rt) || !slices.Contains(res.Added, host) {
		t.Fatalf("added %v, reused %v: want the host's index added and the runtime's kept", res.Added, res.Reused)
	}
	// The new host and manager went up; the runtime's path and the shared library were there.
	if got := blobs() - before; got != 2 || res.BlobsAdded != 2 {
		t.Fatalf("%d blobs more (the result says %d added): want the host's and the manager's only", got, res.BlobsAdded)
	}
	s := load().Status()
	if len(s.Releases) != 2 {
		t.Fatalf("releases %+v", s.Releases)
	}
	for _, r := range s.Releases {
		if r.Runtime != "1.0.0" {
			t.Fatalf("%s carries runtime %s", r.ID, r.Runtime)
		}
	}
	// The same version built again with other bytes is still refused.
	rebuilt := newFixture("26.10.3")
	rebuilt.runtime = storePath("whombat-runtime-built-again")
	if _, err := load().PublishRelease(export("whombat-20261001.3", "26.10.3", "1.0.0", rebuilt), devtuf.PublishOptions{}); err == nil ||
		!strings.Contains(err.Error(), "different bytes") {
		t.Fatalf("other bytes under the published version: %v", err)
	}
}
