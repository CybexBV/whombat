package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/internal/ops"
)

// The edition comes from the image's configuration (UP-X27); an older image's has none (commercial).
func TestLoadEdition(t *testing.T) {
	d := t.TempDir()
	dev := filepath.Join(d, "device.json")
	if err := os.WriteFile(dev, []byte(`{"deviceId":"wb-test","env":"dev"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	load := func(edition *string) (*Loaded, error) {
		c := map[string]any{"managerUser": strconv.Itoa(os.Getuid()), "deviceFile": dev, "pinnedRoot": filepath.Join(d, "root.json"),
			"mirrorDir": d, "stagingDir": d, "assignmentPath": filepath.Join(d, "a"), "networkCandidatesDir": d,
			"stateDir": filepath.Join(d, "st"), "activator": "fake", "fakeRoot": filepath.Join(d, "fake")}
		if edition != nil {
			c["edition"] = *edition
		}
		b, _ := json.Marshal(c)
		p := filepath.Join(d, "helper.json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return Load(p)
	}
	s := func(v string) *string { return &v }
	for _, tc := range []struct {
		edition *string
		want    string
	}{{nil, ""}, {s("commercial"), ops.EditionCommercial}, {s("community"), ops.EditionCommunity}} {
		l, err := load(tc.edition)
		if err != nil || l.Ops.Edition != tc.want {
			t.Fatalf("%v: %+v %v", tc.edition, l, err)
		}
	}
	if _, err := load(s("enterprise")); err == nil {
		t.Fatal("an unknown edition loaded")
	}
}

// A box on the GitHub repository names the helper's metadata folder; without it the helper keeps <stateDir>/tuf.
func TestLoadMetadataDir(t *testing.T) {
	d := t.TempDir()
	dev := filepath.Join(d, "device.json")
	if err := os.WriteFile(dev, []byte(`{"deviceId":"wb-test","env":"dev"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	load := func(dir string) (*Loaded, error) {
		c := map[string]any{"managerUser": strconv.Itoa(os.Getuid()), "deviceFile": dev, "pinnedRoot": filepath.Join(d, "root.json"),
			"mirrorDir": d, "stagingDir": d, "assignmentPath": filepath.Join(d, "a"), "networkCandidatesDir": d,
			"stateDir": filepath.Join(d, "st"), "activator": "fake", "fakeRoot": filepath.Join(d, "fake")}
		if dir != "" {
			c["metadataDir"] = dir
		}
		b, _ := json.Marshal(c)
		p := filepath.Join(d, "helper.json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return Load(p)
	}
	if l, err := load(""); err != nil || l.Ops.MetadataDir != "" {
		t.Fatalf("none: %+v %v", l, err)
	}
	gh := filepath.Join(d, "st", "tuf-github")
	if l, err := load(gh); err != nil || l.Ops.MetadataDir != gh {
		t.Fatalf("own: %+v %v", l, err)
	}
	if _, err := load("tuf-github"); err == nil {
		t.Fatal("a relative metadataDir loaded")
	}
}
