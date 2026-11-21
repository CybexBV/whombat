// The schema numbers release/build writes into a release tuple (release/schema-numbers), with the chain's schemaBase
// (Whombat docs/decisions/report-trackers.md), as the manager's own activation checks judge them: the bridge release
// on today's database, the release that ships only the next chain on the bridge's taken-over database, and a release
// after it. None is a schema_downgrade.
package release_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// bundle writes a compat.json and a release-manifest.json for a chain of tags after base, reading from readsFrom.
func bundle(t *testing.T, base int, tags []string, readsFrom string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	migrations := map[string]any{}
	listed := []map[string]any{}
	for _, tag := range tags {
		migrations[tag] = map[string]any{"class": "incompatible", "readers": tag, "writers": tag}
		listed = append(listed, map[string]any{"tag": tag, "when": 1, "hash": "x"})
	}
	compat := map[string]any{
		"format": 1, "postgres": map[string]any{"majors": []int{17}},
		"runtime": map[string]any{"readsFrom": readsFrom, "writesFrom": readsFrom}, "migrations": migrations,
	}
	if base > 0 {
		compat["schemaBase"] = base
	}
	manifest := map[string]any{"schema": map[string]any{"latest": tags[len(tags)-1], "migrations": listed}}
	write := func(name string, v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	return write("compat.json", compat), write("release-manifest.json", manifest)
}

// numbers runs release/schema-numbers as release/build does.
func numbers(t *testing.T, compat, manifest string) (reads, writes, count int64) {
	t.Helper()
	out, err := exec.Command("./schema-numbers", compat, manifest).CombinedOutput()
	if err != nil {
		t.Fatalf("schema-numbers: %v: %s", err, out)
	}
	if _, err := fmt.Sscan(strings.TrimSpace(string(out)), &reads, &writes, &count); err != nil {
		t.Fatalf("schema-numbers answered %q", out)
	}
	return reads, writes, count
}

func tuple(reads, writes int64) *release.ReleaseTuple {
	t := &release.ReleaseTuple{}
	t.Runtime.SchemaReads = release.IntRange{Min: reads, Max: writes}
	t.Runtime.SchemaWrites = writes
	t.Runtime.HostABI = release.IntRange{Min: 1, Max: 1}
	t.Host.ABI = 1
	return t
}

func ownChain(n int) []string {
	tags := make([]string, n)
	for i := range tags {
		tags[i] = fmt.Sprintf("%04d_m", i)
	}
	tags[n-1] = fmt.Sprintf("%04d_trackers", n-1)
	return tags
}

func TestSchemaNumbersAcrossTheBridgeAndTheNextChain(t *testing.T) {
	// Today's release: 76 migrations from 0, reading from its newest.
	today := ownChain(76)
	today[75] = "0075_kept_sites"
	c, m := bundle(t, 0, today, "0075_kept_sites")
	r0, w0, n0 := numbers(t, c, m)
	if r0 != 76 || w0 != 76 || n0 != 76 {
		t.Fatalf("today: %d %d %d", r0, w0, n0)
	}
	// The bridge: the same chain and 0076_trackers, still from 0.
	bridge := ownChain(77)
	c, m = bundle(t, 0, bridge, "0076_trackers")
	r1, w1, _ := numbers(t, c, m)
	if r1 != 77 || w1 != 77 {
		t.Fatalf("bridge: %d %d", r1, w1)
	}
	// Home at 76 migrates to 77 with a checkpoint (an incompatible migration).
	floor := int64(77)
	got := release.CheckMigratingActivation(tuple(r0, w0), tuple(r1, w1), 76,
		release.SchemaMigration{Target: 77, Readers: &floor, Writers: &floor, NeedsCheckpoint: []string{"0076_trackers"}})
	if !got.OK || !got.RequiresCheckpoint {
		t.Fatalf("bridge on Home: %+v", got)
	}
	// The next release: only the next chain, its baseline after 76, so it is 77 too; the taken-over database is at 77.
	c, m = bundle(t, 76, []string{"0000_baseline"}, "0000_baseline")
	r2, w2, n2 := numbers(t, c, m)
	if r2 != 77 || w2 != 77 || n2 != 1 {
		t.Fatalf("next chain: %d %d %d", r2, w2, n2)
	}
	if got := release.CheckActivation(tuple(r1, w1), tuple(r2, w2), 77); !got.OK || containsDowngrade(got) {
		t.Fatalf("next chain on the bridge's database: %+v", got)
	}
	// And a release after it, with one migration more: 78.
	c, m = bundle(t, 76, []string{"0000_baseline", "0001_next"}, "0001_next")
	r3, w3, _ := numbers(t, c, m)
	if r3 != 78 || w3 != 78 {
		t.Fatalf("after: %d %d", r3, w3)
	}
	floor78 := int64(78)
	if got := release.CheckMigratingActivation(tuple(r2, w2), tuple(r3, w3), 77,
		release.SchemaMigration{Target: 78, Readers: &floor78, Writers: &floor78}); !got.OK || containsDowngrade(got) {
		t.Fatalf("after on the next chain: %+v", got)
	}
	// Going back from the bridge to today's release would be a downgrade, as it should be.
	if got := release.CheckActivation(tuple(r1, w1), tuple(r0, w0), 77); !containsDowngrade(got) {
		t.Fatalf("back to today: %+v", got)
	}
}

func TestSchemaNumbersRefusesADisagreeingManifest(t *testing.T) {
	c, _ := bundle(t, 76, []string{"0000_baseline"}, "0000_baseline")
	_, m := bundle(t, 0, []string{"0000_baseline", "0001_x"}, "0001_x")
	if out, err := exec.Command("./schema-numbers", c, m).CombinedOutput(); err == nil {
		t.Fatalf("schema-numbers took a manifest of two migrations for a chain of one: %s", out)
	}
}

func containsDowngrade(c release.ActivationCheck) bool {
	for _, r := range c.Reasons {
		if r == "schema_downgrade" {
			return true
		}
	}
	return false
}
