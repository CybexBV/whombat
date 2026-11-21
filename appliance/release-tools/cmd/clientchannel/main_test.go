package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/release-tools/clientchannel"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// The production pilot's repository takes the client channel with --env prod --custody online-pilot --keys-dir
// (PI-17): signed with the clients key from the keys directory, as a prod channel, plus the plain channel.json.
func TestPublishIntoTheProductionRepository(t *testing.T) {
	base := t.TempDir()
	repo, keys := filepath.Join(base, "updates"), filepath.Join(base, "secrets", "tuf")
	prod := devtuf.Options{Env: "prod", Custody: devtuf.CustodyOnlinePilot, KeysDir: keys}
	r, err := devtuf.New(repo, prod)
	if err != nil {
		t.Fatal(err)
	}
	if r, err = devtuf.Load(repo, prod); err != nil {
		t.Fatal(err)
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}

	// A bundle as the latest tested job writes it (bundle --out).
	src := filepath.Join(base, "claude")
	if err := os.WriteFile(src, []byte("#!/bin/sh\necho '9.9.9 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	built, err := clientchannel.Build(context.Background(), clientchannel.Input{Provider: release.ClientProviderClaude,
		Version: "9.9.9", Arch: release.ClientArchX8664, PublishedAt: now.Add(-24 * time.Hour), TestedAt: now.Add(-time.Hour),
		FixturesDigest: "sha256:" + strings.Repeat("1", 64), Adapter: release.IntRange{Min: 1, Max: 1},
		SourceURL: "https://downloads.claude.ai/claude-code-releases/9.9.9/linux-x64/claude", SourceFile: src,
		SourceFormat: "binary"}, filepath.Join(base, "work"))
	if err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(base, "claude-9.9.9-x86_64.json")
	b, _ := json.Marshal(built)
	if err := os.WriteFile(bundle, b, 0o644); err != nil {
		t.Fatal(err)
	}

	flags := []string{"--repo", repo, "--env", "prod", "--custody", devtuf.CustodyOnlinePilot, "--keys-dir", keys}
	// Refused: no production flags, some of them, a development key file.
	for name, args := range map[string][]string{
		"no flags":     {"--repo", repo, "--bundle", bundle},
		"no custody":   {"--repo", repo, "--env", "prod", "--keys-dir", keys, "--bundle", bundle},
		"dev key file": append(append([]string{}, flags...), "--key-file", filepath.Join(base, "k.json"), "--bundle", bundle),
	} {
		if err := run("publish", args); err == nil {
			t.Fatalf("%s: published", name)
		}
	}
	if err := run("publish", append(append([]string{}, flags...), "--bundle", bundle)); err != nil {
		t.Fatal(err)
	}
	if err := run("show", flags); err != nil {
		t.Fatal(err)
	}
	if err := run("refresh", flags); err != nil { // valid for 7 days: nothing to do
		t.Fatal(err)
	}

	r, err = devtuf.Load(repo, prod)
	if err != nil {
		t.Fatal(err)
	}
	cur, err := (&clientchannel.Publisher{Repo: r}).Current()
	if err != nil || cur == nil {
		t.Fatalf("channel %v %v", cur, err)
	}
	if cur.Payload.Env != "prod" || cur.Payload.Sequence != 1 || len(cur.Payload.Bundles) != 1 ||
		!strings.HasPrefix(cur.KeyID, "clients-prod-") {
		t.Fatalf("channel %+v key %s", cur.Payload, cur.KeyID)
	}
	ck, err := r.ClientChannelKeys()
	if err != nil || ck.Keys[0].Kid != cur.KeyID {
		t.Fatalf("signed by %s, the pinned document names %+v (%v)", cur.KeyID, ck, err)
	}
	if _, err := os.Stat(filepath.Join(repo, clientchannel.PlainChannelPath)); err != nil {
		t.Fatalf("plain channel: %v", err)
	}
	if _, err := r.ClientTargetContent(built.Bundle.Artifact.Target); err != nil {
		t.Fatalf("artifact target: %v", err)
	}
}

// Codex is no longer followed or fetched (IN-432): both refuse at once, without asking upstream.
func TestCodexIsNoLongerFollowed(t *testing.T) {
	for _, args := range [][]string{
		{"--provider", "codex"},
		{"--provider", "codex", "--version", "0.157.1", "--dir", t.TempDir()},
	} {
		cmd := "latest"
		if len(args) > 2 {
			cmd = "fetch"
		}
		if err := run(cmd, args); !errors.Is(err, clientchannel.ErrNotPublished) {
			t.Fatalf("%s %v: %v", cmd, args, err)
		}
	}
}

// The client job mirrors DEV's channel into the GitHub repository (Sol 4, LNK-50): the same signed document and
// artifacts (the same sequence, so a box that moves keeps it), withdrawn artifacts dropped, nothing done twice, and
// never a move back.
func TestMirrorIntoTheGitHubRepository(t *testing.T) {
	base := t.TempDir()
	legacy, gh := filepath.Join(base, "dev"), filepath.Join(base, "github")
	r, err := devtuf.New(legacy, devtuf.Options{Env: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if r, err = devtuf.Load(legacy, devtuf.Options{}); err != nil {
		t.Fatal(err)
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	bundle := func(v string) string {
		src := filepath.Join(base, "claude-"+v)
		if err := os.WriteFile(src, []byte("#!/bin/sh\necho '"+v+" (Claude Code)'\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC().Truncate(time.Second)
		built, err := clientchannel.Build(context.Background(), clientchannel.Input{Provider: release.ClientProviderClaude,
			Version: v, Arch: release.ClientArchX8664, PublishedAt: now.Add(-24 * time.Hour), TestedAt: now.Add(-time.Hour),
			FixturesDigest: "sha256:" + strings.Repeat("1", 64), Adapter: release.IntRange{Min: 1, Max: 1},
			SourceURL: "https://downloads.claude.ai/claude-code-releases/" + v + "/linux-x64/claude", SourceFile: src,
			SourceFormat: "binary"}, filepath.Join(base, "work-"+v))
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(base, "claude-"+v+".json")
		b, _ := json.Marshal(built)
		if err := os.WriteFile(out, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if err := run("publish", []string{"--repo", legacy, "--bundle", bundle("9.9.1")}); err != nil {
		t.Fatal(err)
	}
	if _, err := devtuf.Continue(legacy, gh, devtuf.ContinueOptions{KeysDir: filepath.Join(base, "keys"),
		OfflineKeysDir: filepath.Join(base, "offline")}); err != nil {
		t.Fatal(err)
	}
	channel := func(dir string) ([]byte, *devtuf.Repo) {
		t.Helper()
		r, err := devtuf.Load(dir, devtuf.Options{})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := r.ClientTargetContent(release.ClientChannelTarget)
		if err != nil {
			t.Fatal(err)
		}
		return raw, r
	}
	same := func() *devtuf.Repo {
		t.Helper()
		a, _ := channel(legacy)
		b, r := channel(gh)
		if string(a) != string(b) {
			t.Fatal("the mirror's channel isn't the source's")
		}
		return r
	}
	// DEV publishes twice (sequence 3 now), then withdraws the first bundle: each mirror follows it.
	if err := run("publish", []string{"--repo", legacy, "--bundle", bundle("9.9.2")}); err != nil {
		t.Fatal(err)
	}
	if err := run("mirror", []string{"--from", legacy, "--repo", gh}); err != nil {
		t.Fatal(err)
	}
	r = same()
	old := release.ClientBundleTarget(release.ClientProviderClaude, "9.9.1", release.ClientOsLinux, release.ClientArchX8664)
	if _, ok := r.ClientTargets()[old]; !ok {
		t.Fatalf("the mirror lacks %s: %v", old, r.ClientTargets())
	}
	if err := run("publish", []string{"--repo", legacy, "--withdraw", "claude/9.9.1"}); err != nil {
		t.Fatal(err)
	}
	if err := run("mirror", []string{"--from", legacy, "--repo", gh}); err != nil {
		t.Fatal(err)
	}
	r = same()
	if _, ok := r.ClientTargets()[old]; ok {
		t.Fatalf("the withdrawn %s stayed in the mirror", old)
	}
	for p := range r.ClientTargets() {
		if _, err := r.ClientTargetContent(p); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	src, _ := devtuf.Load(legacy, devtuf.Options{})
	if _, changed, err := clientchannel.Mirror(src, r, nil, time.Now()); err != nil || changed {
		t.Fatalf("mirroring it again: changed %v %v", changed, err)
	}
	// A channel published into the mirror itself is ahead: the mirror refuses to move it back.
	if err := run("publish", []string{"--repo", gh}); err != nil {
		t.Fatal(err)
	}
	if err := run("mirror", []string{"--from", legacy, "--repo", gh}); err == nil || !strings.Contains(err.Error(), "move back") {
		t.Fatalf("moved the mirror back: %v", err)
	}
}
