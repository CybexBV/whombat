package listing

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// A backup's entry says what it holds from its manifest's coverage: the covered classes only, the servers only when
// their archive is in it, never an id the server's list would refuse, nothing for a manifest from before coverage.
func TestCoveredFromTheManifest(t *testing.T) {
	m := &manifest.Manifest{Hosts: &manifest.Hosts{}, Coverage: []manifest.CoverageItem{
		{ID: "database", Covered: true}, {ID: "attachments", Covered: true}, {ID: "servers", Covered: true},
		{ID: "identity", Covered: false}, {ID: "bad id", Covered: true}, {ID: strings.Repeat("x", 33), Covered: true},
		{ID: "database", Covered: true},
	}}
	if got := coveredOf(m); !slices.Equal(got, []string{"database", "attachments", "servers"}) {
		t.Fatalf("covered %v", got)
	}
	m.Hosts = nil // the servers' export failed: the class is in the layout, the archive isn't in the backup
	if got := coveredOf(m); slices.Contains(got, "servers") {
		t.Fatalf("servers covered without their archive: %v", got)
	}
	if got := coveredOf(&manifest.Manifest{}); got != nil {
		t.Fatalf("an old manifest: %v", got)
	}
	many := &manifest.Manifest{}
	for i := range 40 {
		many.Coverage = append(many.Coverage, manifest.CoverageItem{ID: fmt.Sprintf("class-%d", i), Covered: true})
	}
	if got := coveredOf(many); len(got) != 32 {
		t.Fatalf("%d ids", len(got))
	}
}

// On the wire `covered` is the runtime's BackupCheckpoint.covered (optional, an array of at most 32 ids of 1 to 32
// characters `[A-Za-z0-9_.:-]`): an array of strings when the backup covers something, and absent, never null or
// empty, when it doesn't (the runtime's schema doesn't take null).
func TestCoveredOnTheWire(t *testing.T) {
	wire := func(e Entry) map[string]any {
		t.Helper()
		b, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := &manifest.Manifest{Hosts: &manifest.Hosts{}, Coverage: []manifest.CoverageItem{
		{ID: "database", Covered: true}, {ID: "attachments", Covered: true}, {ID: "servers", Covered: true},
	}}
	got, ok := wire(Entry{Covered: coveredOf(m)})["covered"].([]any)
	if !ok || len(got) != 3 || got[0] != "database" || got[2] != "servers" {
		t.Fatalf("covered %v", got)
	}
	runtimeID := regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`) // the runtime's LocalIdent
	for _, id := range got {
		if s, _ := id.(string); !runtimeID.MatchString(s) || len(s) > 32 {
			t.Fatalf("an id the runtime refuses: %q", id)
		}
	}
	for _, e := range []Entry{{}, {Covered: coveredOf(&manifest.Manifest{})}, {Covered: []string{}}} {
		if v, ok := wire(e)["covered"]; ok {
			t.Fatalf("covered of a backup that covers nothing: %v", v)
		}
	}
}
