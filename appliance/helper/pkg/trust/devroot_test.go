package trust

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// The blocklist covers every key of the committed development roots.
func TestDevelopmentKeyIDsMatchFixtures(t *testing.T) {
	files, _ := filepath.Glob("../../../release-tools/fixtures/dev/*/metadata/*root.json")
	files = append(files, "../../../release-tools/fixtures/dev/pinned-root.json",
		// The community edition's test root, and what community images pin (UP-X27).
		"../../../release-tools/fixtures/community-test/metadata/1.root.json", "../../../manifest/community/tuf-root.json")
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		r, err := metadata.Root().FromBytes(b)
		if err != nil {
			t.Fatal(err)
		}
		for id := range r.Signed.Keys {
			if !DevelopmentKeyIDs[id] {
				t.Errorf("%s: development key %s is not in DevelopmentKeyIDs", f, id)
			}
		}
	}
}

// Regression for L-4 (W4-SEC part 2): a production device refuses the development root.
func TestProductionRefusesDevelopmentRoot(t *testing.T) {
	pinned, err := os.ReadFile("../../../release-tools/fixtures/dev/pinned-root.json")
	if err != nil {
		t.Fatal(err)
	}
	dir := "../../../release-tools/fixtures/dev/valid/metadata"
	cfg := Config{PinnedRoot: pinned, MetadataDir: t.TempDir(), MetadataURL: "m://x", Fetcher: DirFetcher{BaseURL: "m://x", Dir: absPath(t, dir)},
		Production: true}
	if _, err := Refresh(cfg); !errors.Is(err, ErrDevelopmentRoot) {
		t.Fatalf("prod accepted the development root: %v", err)
	}
}

func absPath(t *testing.T, p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return a
}
