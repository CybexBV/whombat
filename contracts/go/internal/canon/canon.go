// Package canon produces RFC 8785 canonical JSON (the same bytes as core's canonicalJson for integer-only JSON).
package canon

import (
	"encoding/json"

	"github.com/gowebpki/jcs"
)

// JSON returns the canonical JSON of raw JSON text.
func JSON(raw []byte) ([]byte, error) {
	return jcs.Transform(raw)
}

// Value marshals v and returns its canonical JSON.
func Value(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return jcs.Transform(raw)
}
