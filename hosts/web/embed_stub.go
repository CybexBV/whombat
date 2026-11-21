//go:build !embedweb

// Package web holds the built UI (web/dist). Build the hub with
// -tags embedweb after building the UI to embed it.
package web

import "io/fs"

// Dist returns nil: this build has no embedded UI (use --web-dir).
func Dist() fs.FS { return nil }
