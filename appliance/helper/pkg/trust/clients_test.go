package trust_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func clientsCfg(r *devtuf.Repo, cache string, now time.Time) trust.Config {
	c := cfg(r, cache, now)
	c.ResolveClients = true
	return c
}

func TestClientChannelThroughDelegation(t *testing.T) {
	c := &clock{t: time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)}
	r := newRepo(t, c)
	cache := filepath.Join(t.TempDir(), "cache")

	// No delegation yet: the refresh works, the channel is unavailable.
	repo, err := trust.Refresh(clientsCfg(r, cache, c.t))
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(repo.ClientsError(), trust.ErrClientsUnavailable) {
		t.Fatalf("want unavailable, got %v", repo.ClientsError())
	}

	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	art := "clients/codex/0.158.0/linux-x86_64.tar.gz"
	if err := r.PublishClients(nil, map[string][]byte{release.ClientChannelTarget: []byte(`{"x":1}`), art: []byte("tarball")}); err != nil {
		t.Fatal(err)
	}
	repo, err = trust.Refresh(clientsCfg(r, cache, c.t))
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.ClientsError(); err != nil {
		t.Fatal(err)
	}
	a, err := repo.ClientTarget(art)
	if err != nil || a.Length != int64(len("tarball")) || len(a.SHA256()) != 64 {
		t.Fatalf("artifact: %+v %v", a, err)
	}
	if _, err := repo.ClientTarget("clients/claude/1.0.0/linux-x86_64.tar.gz"); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("unknown target: %v", err)
	}
	// The release view is unchanged and a refresh without ResolveClients never reports the channel.
	if _, err := repo.Release("rt-1"); err != nil {
		t.Fatal(err)
	}
	plain, err := trust.Refresh(cfg(r, filepath.Join(t.TempDir(), "helper"), c.t))
	if err != nil || plain.ClientsError() == nil {
		t.Fatalf("helper view: %v %v", err, plain.ClientsError())
	}

	// A newer role version replaces the targets; a removed artifact is gone.
	if err := r.PublishClients(nil, map[string][]byte{art: nil}); err != nil {
		t.Fatal(err)
	}
	repo, err = trust.Refresh(clientsCfg(r, cache, c.t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ClientTarget(art); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("removed artifact still trusted: %v", err)
	}
}

func TestClientsRoleCannotSignOutsideItsPaths(t *testing.T) {
	c := &clock{t: time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)}
	r := newRepo(t, c)
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	if err := r.PublishClients(nil, map[string][]byte{"releases/evil.json": []byte("{}")}); err == nil {
		t.Fatal("the publisher accepted a path outside the delegation")
	}
	if err := r.PublishClientsUnchecked(nil, map[string][]byte{
		release.ClientChannelTarget: []byte(`{}`), "releases/evil.json": []byte("{}"), "clients/a/b/c/d.tar.gz": []byte("deep"),
	}); err != nil {
		t.Fatal(err)
	}
	repo, err := trust.Refresh(clientsCfg(r, filepath.Join(t.TempDir(), "cache"), c.t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ClientTarget("releases/evil.json"); err == nil {
		t.Fatal("a clients-role target outside clients/ was trusted")
	}
	if _, err := repo.ClientTarget("clients/a/b/c/d.tar.gz"); err == nil {
		t.Fatal("a clients-role target outside the path patterns was trusted")
	}
	if ids := repo.ReleaseIDs(); len(ids) != 1 {
		t.Fatalf("release ids %v", ids)
	}
}

func TestClientsRoleWrongKeyRefused(t *testing.T) {
	c := &clock{t: time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)}
	r := newRepo(t, c)
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if err := r.PublishClients(other, map[string][]byte{release.ClientChannelTarget: []byte(`{}`)}); err == nil {
		t.Fatal("published with a key that does not hold the role")
	}
	if err := r.PublishClients(nil, map[string][]byte{release.ClientChannelTarget: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	// Expired role metadata: the channel becomes unavailable, the refresh itself still succeeds.
	later := c.t.Add(devtuf.ClientsExpiry + time.Hour)
	c.t = later
	if err := r.PublishSnapshot(); err != nil {
		t.Fatal(err)
	}
	repo, err := trust.Refresh(clientsCfg(r, filepath.Join(t.TempDir(), "cache"), later))
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(repo.ClientsError(), trust.ErrClientsUnavailable) {
		t.Fatalf("expired clients role: %v", repo.ClientsError())
	}
}
