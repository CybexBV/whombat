package devtuf_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// checkFixtures verifies every fixture case with the real client code and the expected outcome.
func checkFixtures(t *testing.T, dir string) {
	b, err := os.ReadFile(filepath.Join(dir, "fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m devtuf.FixtureManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if !m.Development {
		t.Fatal("fixtures must be marked development")
	}
	for _, c := range m.Cases {
		t.Run(c.Name, func(t *testing.T) {
			pinned, _ := os.ReadFile(filepath.Join(dir, c.PinnedRoot))
			cache := t.TempDir()
			refresh := func(meta string) (*trust.Repo, error) {
				return trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: cache, MetadataURL: "fx://m",
					Fetcher: trust.DirFetcher{BaseURL: "fx://m", Dir: filepath.Join(dir, meta)}, Now: m.VerifyAt})
			}
			if c.PrimeWith != "" {
				if _, err := refresh(c.PrimeWith); err != nil {
					t.Fatalf("prime: %v", err)
				}
			}
			repo, err := refresh(c.MetadataDir)
			want := map[string]error{"expired": trust.ErrExpired, "rollback": trust.ErrRollback, "signature": trust.ErrSignature}[c.Expect]
			if want != nil {
				if !errors.Is(err, want) {
					t.Fatalf("want %v, got %v", want, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			rel, err := repo.Release(c.Release)
			if err != nil {
				t.Fatal(err)
			}
			var artErr error
			for _, a := range rel.Artifacts() {
				rp := filepath.Join(dir, c.TargetsDir, filepath.FromSlash(filepath.Dir(a.Target)), a.SHA256()+"."+filepath.Base(a.Target))
				if err := trust.VerifyFile(rp, a); err != nil {
					artErr = err
				}
			}
			switch c.Expect {
			case "ok":
				if artErr != nil {
					t.Fatal(artErr)
				}
				ks, err := repo.AssignmentKeys(m.Env, m.VerifyAt)
				if err != nil {
					t.Fatal(err)
				}
				raw, _ := os.ReadFile(filepath.Join(dir, m.Assignment))
				if _, err := trust.VerifyAssignment(raw, ks, trust.VerifyParams{DeviceID: m.DeviceID, Env: m.Env, Now: m.VerifyAt}); err != nil && c.Name == "valid" {
					t.Fatalf("assignment: %v", err)
				}
			case "artifact":
				if !errors.Is(artErr, trust.ErrArtifact) {
					t.Fatalf("want artifact error, got %v", artErr)
				}
			}
		})
	}
}

func TestGeneratedFixtures(t *testing.T) {
	dir := t.TempDir()
	if _, err := devtuf.GenerateFixtures(dir, time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC), 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	checkFixtures(t, dir)
}
