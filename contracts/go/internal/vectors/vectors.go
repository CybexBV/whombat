// Package vectors loads the conformance vectors in testdata/vectors (copied from ../vectors by `pnpm gen`).
package vectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Load unmarshals testdata/vectors/<name> into v.
func Load(t testing.TB, name string, v any) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "testdata", "vectors", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
