package conformance

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/internal/schemas"
	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func parsers() map[string]func([]byte) (any, error) {
	all := map[string]func([]byte) (any, error){}
	for _, m := range []map[string]func([]byte) (any, error){protocol.Parsers, release.Parsers, device.Parsers, local.Parsers} {
		for k, v := range m {
			all[k] = v
		}
	}
	return all
}

func TestEverySchemaHasAParser(t *testing.T) {
	p := parsers()
	names := schemas.Names()
	sort.Strings(names)
	if len(names) != len(p) {
		t.Fatalf("%d schemas, %d parsers", len(names), len(p))
	}
	for _, n := range names {
		if p[n] == nil {
			t.Errorf("no parser for %s", n)
		}
	}
}

func TestSchemaVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Schema string          `json:"schema"`
			Name   string          `json:"name"`
			Valid  bool            `json:"valid"`
			Value  json.RawMessage `json:"value"`
			Output json.RawMessage `json:"output"`
		} `json:"cases"`
	}
	vectors.Load(t, "schemas.json", &v)
	p := parsers()
	for _, c := range v.Cases {
		parse := p[c.Schema]
		if parse == nil {
			t.Fatalf("no parser for %s", c.Schema)
		}
		got, err := parse(c.Value)
		if (err == nil) != c.Valid {
			t.Errorf("%s/%s: valid=%v, err=%v", c.Schema, c.Name, c.Valid, err)
			continue
		}
		if !c.Valid {
			continue
		}
		// Round trip: the Go value marshals back to something the schema accepts.
		out, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("%s/%s: %v", c.Schema, c.Name, err)
		}
		if err := schemas.Validate(c.Schema, out); err != nil {
			t.Errorf("%s/%s: round trip: %v\n%s", c.Schema, c.Name, err, out)
		}
		// The parsed value equals the expected output (unknown members stripped, CT-14).
		want := c.Output
		if len(want) == 0 {
			want = c.Value
		}
		var a, b any
		_ = json.Unmarshal(out, &a)
		_ = json.Unmarshal(want, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s/%s: parsed to %s, want %s", c.Schema, c.Name, out, want)
		}
	}
}
