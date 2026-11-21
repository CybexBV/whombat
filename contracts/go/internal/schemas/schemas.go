// Package schemas validates JSON against the embedded JSON Schema exported from the Zod contracts.
package schemas

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed json/*.json
var files embed.FS

// IDPrefix is the `$id` prefix of every exported schema.
const IDPrefix = "https://schemas.whombat.com/contracts/"

var (
	once     sync.Once
	compiled map[string]*jsonschema.Schema
	loadErr  error
)

func load() {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	entries, err := files.ReadDir("json")
	if err != nil {
		loadErr = err
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		data, err := files.ReadFile("json/" + e.Name())
		if err != nil {
			loadErr = err
			return
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			loadErr = fmt.Errorf("%s: %w", e.Name(), err)
			return
		}
		if err := c.AddResource(IDPrefix+e.Name(), doc); err != nil {
			loadErr = err
			return
		}
		names = append(names, strings.TrimSuffix(e.Name(), ".json"))
	}
	compiled = make(map[string]*jsonschema.Schema, len(names))
	for _, n := range names {
		s, err := c.Compile(IDPrefix + n + ".json")
		if err != nil {
			loadErr = fmt.Errorf("%s: %w", n, err)
			return
		}
		compiled[n] = s
	}
}

// Names lists the embedded schemas.
func Names() []string {
	once.Do(load)
	out := make([]string, 0, len(compiled))
	for n := range compiled {
		out = append(out, n)
	}
	return out
}

// Validate checks that data is one JSON value valid against the named schema.
func Validate(name string, data []byte) error {
	once.Do(load)
	if loadErr != nil {
		return loadErr
	}
	s, ok := compiled[name]
	if !ok {
		return fmt.Errorf("unknown schema %q", name)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("%s: invalid JSON: %w", name, err)
	}
	if err := s.Validate(inst); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// Decode validates data against the named schema, drops object members v's type doesn't declare (exact-case
// match on the json tags, CT-14: tolerant wire objects strip unknown members; strict objects were already
// refused by the schema), then unmarshals into v. Stripping first keeps encoding/json's case-insensitive
// matching from letting an unknown `KID` shadow `kid`.
func Decode(name string, data []byte, v any) error {
	if err := Validate(name, data); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return err
	}
	stripped, err := json.Marshal(strip(raw, reflect.TypeOf(v)))
	if err != nil {
		return err
	}
	return json.Unmarshal(stripped, v)
}

var rawMessage = reflect.TypeOf(json.RawMessage(nil))

// strip removes members that t (a struct, possibly behind pointers/slices) doesn't declare, recursively.
func strip(v any, t reflect.Type) any {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == rawMessage {
		return v
	}
	switch t.Kind() {
	case reflect.Struct:
		obj, ok := v.(map[string]any)
		if !ok {
			return v
		}
		out := make(map[string]any, len(obj))
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "" || name == "-" {
				continue
			}
			if val, ok := obj[name]; ok {
				out[name] = strip(val, f.Type)
			}
		}
		return out
	case reflect.Slice:
		arr, ok := v.([]any)
		if !ok {
			return v
		}
		out := make([]any, len(arr))
		for i, x := range arr {
			out[i] = strip(x, t.Elem())
		}
		return out
	}
	return v
}

// ValidateValue marshals v and validates the result against the named schema.
func ValidateValue(name string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return Validate(name, data)
}
