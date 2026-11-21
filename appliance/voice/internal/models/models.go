// Package models is the speech models' manifest, shared by the voice service (which reads the models) and the model
// fetcher (which downloads them): the models a release names, each with its file name, its source and the size and
// sha256 the download must have. The image carries the manifest, never the models (Whombat dictation.md DT-05).
package models

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// IDs are the models the contract knows, in the order Settings lists them.
var IDs = []string{local.VoiceModelParakeet, local.VoiceModelWhisper}

// Model is one download.
type Model struct {
	ID string `json:"id"`
	// File is its name in the models directory.
	File   string `json:"file"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is what the release names.
type Manifest struct {
	Models []Model `json:"models"`
}

var (
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fileName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// Load reads and checks a manifest: known ids, each once; plain file names; https sources; sizes within the
// contract's bound; sha256 in lower-case hex.
func Load(path string) (Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	return Parse(b)
}

// Parse is Load without the file.
func Parse(b []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, fmt.Errorf("manifest: %w", err)
	}
	seen := map[string]bool{}
	for _, x := range m.Models {
		switch {
		case !slices.Contains(IDs, x.ID) || seen[x.ID]:
			return Manifest{}, fmt.Errorf("manifest: model %q unknown or twice", x.ID)
		case !fileName.MatchString(x.File) || strings.HasSuffix(x.File, PartSuffix):
			return Manifest{}, fmt.Errorf("manifest: %s: not a file name: %q", x.ID, x.File)
		case !strings.HasPrefix(x.URL, "https://") && !strings.HasPrefix(x.URL, "http://127.0.0.1"):
			// Only the VM test serves models from the machine itself.
			return Manifest{}, fmt.Errorf("manifest: %s: not an https source", x.ID)
		case x.Size <= 0 || x.Size > local.VoiceModelMaxBytes:
			return Manifest{}, fmt.Errorf("manifest: %s: size %d", x.ID, x.Size)
		case !sha256Hex.MatchString(x.SHA256):
			return Manifest{}, fmt.Errorf("manifest: %s: sha256 %q", x.ID, x.SHA256)
		}
		seen[x.ID] = true
	}
	if len(m.Models) == 0 {
		return Manifest{}, errors.New("manifest: no models")
	}
	return m, nil
}

// Find is the model with id.
func (m Manifest) Find(id string) (Model, bool) {
	i := slices.IndexFunc(m.Models, func(x Model) bool { return x.ID == id })
	if i < 0 {
		return Model{}, false
	}
	return m.Models[i], true
}

// PartSuffix marks a download that isn't complete and checked yet; the voice service never reads one.
const PartSuffix = ".part"

// Path is where a complete model is.
func Path(dir string, x Model) string { return filepath.Join(dir, x.File) }

// PartPath is where its download goes until it is checked.
func PartPath(dir string, x Model) string { return filepath.Join(dir, "."+x.File+PartSuffix) }

// Present says whether the model is complete in dir: a regular file of the manifest's size. The fetcher renames a
// download into place only once its size and sha256 matched, so the size is enough here.
func Present(dir string, x Model) bool {
	fi, err := os.Stat(Path(dir, x))
	return err == nil && fi.Mode().IsRegular() && fi.Size() == x.Size
}
