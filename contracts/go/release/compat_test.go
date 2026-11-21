package release

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestCompatVectors(t *testing.T) {
	var v struct {
		Tuples     map[string]json.RawMessage `json:"tuples"`
		Activation []struct {
			Name      string          `json:"name"`
			Current   string          `json:"current"`
			Candidate string          `json:"candidate"`
			DBSchema  int64           `json:"dbSchema"`
			Expect    ActivationCheck `json:"expect"`
		} `json:"activation"`
		Migrating []struct {
			Name      string          `json:"name"`
			Current   string          `json:"current"`
			Candidate string          `json:"candidate"`
			DBSchema  int64           `json:"dbSchema"`
			Migration SchemaMigration `json:"migration"`
			Expect    ActivationCheck `json:"expect"`
		} `json:"migrating"`
		Compatible []struct {
			Name      string          `json:"name"`
			Current   string          `json:"current"`
			Candidate string          `json:"candidate"`
			DBSchema  int64           `json:"dbSchema"`
			Floors    SchemaFloors    `json:"floors"`
			Expect    ActivationCheck `json:"expect"`
		} `json:"compatible"`
		Versions []struct {
			Name   string `json:"name"`
			A      string `json:"a"`
			B      string `json:"b"`
			Expect int    `json:"expect"`
		} `json:"versions"`
		Classes []struct {
			Current   string `json:"current"`
			Candidate string `json:"candidate"`
			Expect    string `json:"expect"`
		} `json:"classes"`
		Overlaps []struct {
			Client  IntRange `json:"client"`
			Runtime IntRange `json:"runtime"`
			Expect  bool     `json:"expect"`
		} `json:"overlaps"`
		Serves []struct {
			Version struct{ Major, Minor int64 } `json:"version"`
			Expect  bool                         `json:"expect"`
		} `json:"serves"`
		Retryable []string          `json:"retryable"`
		Digests   map[string]string `json:"digests"`
		Floors    []struct {
			Name        string `json:"name"`
			Tuple       string `json:"tuple"`
			Platform    string `json:"platform"`
			BuildNumber *int64 `json:"buildNumber"`
			Expect      *int64 `json:"expect"`
		} `json:"floors"`
		AssignmentKeys []struct {
			Name   string          `json:"name"`
			Doc    json.RawMessage `json:"doc"`
			Env    string          `json:"env"`
			Now    int64           `json:"now"`
			Expect struct {
				Keys  map[string]string `json:"keys"`
				Error string            `json:"error"`
			} `json:"expect"`
		} `json:"assignmentKeys"`
	}
	vectors.Load(t, "compat.json", &v)
	tuples := map[string]*ReleaseTuple{}
	for name, raw := range v.Tuples {
		tu, err := ParseReleaseTuple(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		tuples[name] = tu
	}
	for _, c := range v.Activation {
		got := CheckActivation(tuples[c.Current], tuples[c.Candidate], c.DBSchema)
		if !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("%s: %+v, want %+v", c.Name, got, c.Expect)
		}
	}
	if len(v.Migrating) == 0 {
		t.Fatal("no migrating vectors")
	}
	for _, c := range v.Migrating {
		got := CheckMigratingActivation(tuples[c.Current], tuples[c.Candidate], c.DBSchema, c.Migration)
		if !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("%s: %+v, want %+v", c.Name, got, c.Expect)
		}
	}
	if len(v.Compatible) == 0 || len(v.Versions) == 0 {
		t.Fatal("no compatible or versions vectors")
	}
	for _, c := range v.Compatible {
		got := CheckCompatibleActivation(tuples[c.Current], tuples[c.Candidate], c.DBSchema, c.Floors)
		if !reflect.DeepEqual(got, c.Expect) {
			t.Errorf("%s: %+v, want %+v", c.Name, got, c.Expect)
		}
	}
	for _, c := range v.Versions {
		if got := CompareVersions(c.A, c.B); got != c.Expect {
			t.Errorf("%s: CompareVersions(%q, %q) = %d, want %d", c.Name, c.A, c.B, got, c.Expect)
		}
	}
	if !reflect.DeepEqual(RetryableUpdateFailures, v.Retryable) {
		t.Errorf("RetryableUpdateFailures = %v, want %v", RetryableUpdateFailures, v.Retryable)
	}
	if !IsRetryableUpdateFailure("no_space") || IsRetryableUpdateFailure("schema_incompatible") {
		t.Error("IsRetryableUpdateFailure")
	}
	for _, c := range v.Classes {
		if got := UpdateClass(tuples[c.Current], tuples[c.Candidate]); got != c.Expect {
			t.Errorf("updateClass(%s, %s) = %s, want %s", c.Current, c.Candidate, got, c.Expect)
		}
	}
	for _, c := range v.Overlaps {
		if got := ProtocolOverlap(c.Client, c.Runtime); got != c.Expect {
			t.Errorf("overlap(%+v, %+v) = %v", c.Client, c.Runtime, got)
		}
	}
	for _, c := range v.Serves {
		if got := ServesClient(tuples["base"], c.Version.Major, c.Version.Minor); got != c.Expect {
			t.Errorf("serves(%+v) = %v", c.Version, got)
		}
	}
	for name, want := range v.Digests {
		if got, err := TupleDigest(tuples[name]); err != nil || got != want {
			t.Errorf("TupleDigest(%s) = %s (%v), want %s", name, got, err, want)
		}
	}
	if len(v.Floors) == 0 {
		t.Fatal("no floor vectors")
	}
	for _, c := range v.Floors {
		min, below := ClientBelowFloor(tuples[c.Tuple].ClientFloor, c.Platform, c.BuildNumber)
		if below != (c.Expect != nil) || (below && min != *c.Expect) {
			t.Errorf("%s: (%d, %v), want %v", c.Name, min, below, c.Expect)
		}
	}
	for _, c := range v.AssignmentKeys {
		got, err := AssignmentKeyMap(c.Doc, Environment(c.Env), c.Now)
		if c.Expect.Error != "" {
			var ke *AssignmentKeysError
			if !errors.As(err, &ke) || ke.Code != c.Expect.Error {
				t.Errorf("%s: %v (%v), want error %s", c.Name, got, err, c.Expect.Error)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.Expect.Keys) {
			t.Errorf("%s: %v (%v), want %v", c.Name, got, err, c.Expect.Keys)
		}
	}
}
