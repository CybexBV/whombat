// Package models is the speech models' manifest, shared by the voice service (which reads the models) and the model
// fetcher (which downloads them): the models a release names, each with either a single file or a directory of files,
// its source URLs and the sizes and sha256 digests the download must match. The image carries the manifest, never the
// downloaded models.
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
var IDs = []string{local.VoiceModelParakeet, local.VoiceModelWhisper, local.VoiceModelSupertonic}

// File is one file of a multi-file model.
type File struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Model is one download: either a single file (File, URL, Size, SHA256) or a directory of files (Dir, Files).
type Model struct {
	ID string `json:"id"`
	// File is its name in the models directory for a single-file model.
	File   string `json:"file,omitempty"`
	URL    string `json:"url,omitempty"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	// Dir is its directory name in the models directory for a multi-file model, holding Files.
	Dir   string `json:"dir,omitempty"`
	Files []File `json:"files,omitempty"`
}

// Multi reports whether the model consists of a directory of files rather than one file.
func (m Model) Multi() bool { return m.Dir != "" || len(m.Files) > 0 }

// TotalSize is the total number of bytes across the model's file or files.
func (m Model) TotalSize() int64 {
	if !m.Multi() {
		return m.Size
	}
	var total int64
	for _, f := range m.Files {
		total += f.Size
	}
	return total
}

func (m Model) entryName() string {
	if m.Multi() {
		return m.Dir
	}
	return m.File
}

// Manifest is what the release names.
type Manifest struct {
	Models []Model `json:"models"`
}

var (
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fileName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// Load reads and checks a manifest: known ids, each once; plain file or directory names with no collisions; https
// sources; positive sizes within the contract's bound; sha256 in lower-case hex.
func Load(path string) (Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	return Parse(b)
}

func validURL(u string) bool {
	// Only the VM test serves models from the machine itself.
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://127.0.0.1")
}

func validName(s string) bool {
	return fileName.MatchString(s) && !strings.HasSuffix(s, PartSuffix)
}

// Parse is Load without the file.
func Parse(b []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, fmt.Errorf("manifest: %w", err)
	}
	seen := map[string]bool{}
	seenTargets := map[string]bool{}
	for _, x := range m.Models {
		if !slices.Contains(IDs, x.ID) || seen[x.ID] {
			return Manifest{}, fmt.Errorf("manifest: model %q unknown or twice", x.ID)
		}
		hasSingle := x.File != "" || x.URL != "" || x.Size != 0 || x.SHA256 != ""
		hasMulti := x.Dir != "" || len(x.Files) > 0
		if hasSingle == hasMulti {
			return Manifest{}, fmt.Errorf("manifest: %s: must specify either a file or a directory of files", x.ID)
		}
		if hasSingle {
			switch {
			case !validName(x.File):
				return Manifest{}, fmt.Errorf("manifest: %s: not a file name: %q", x.ID, x.File)
			case seenTargets[x.File]:
				return Manifest{}, fmt.Errorf("manifest: %s: duplicate target %q", x.ID, x.File)
			case !validURL(x.URL):
				return Manifest{}, fmt.Errorf("manifest: %s: not an https source", x.ID)
			case x.Size <= 0 || x.Size > local.VoiceModelMaxBytes:
				return Manifest{}, fmt.Errorf("manifest: %s: size %d", x.ID, x.Size)
			case !sha256Hex.MatchString(x.SHA256):
				return Manifest{}, fmt.Errorf("manifest: %s: sha256 %q", x.ID, x.SHA256)
			}
			seenTargets[x.File] = true
		} else {
			if !validName(x.Dir) {
				return Manifest{}, fmt.Errorf("manifest: %s: not a directory name: %q", x.ID, x.Dir)
			}
			if seenTargets[x.Dir] {
				return Manifest{}, fmt.Errorf("manifest: %s: duplicate target %q", x.ID, x.Dir)
			}
			if len(x.Files) == 0 {
				return Manifest{}, fmt.Errorf("manifest: %s: no files", x.ID)
			}
			seenFiles := map[string]bool{}
			var total int64
			for _, f := range x.Files {
				switch {
				case !validName(f.Name) || seenFiles[f.Name]:
					return Manifest{}, fmt.Errorf("manifest: %s: bad or duplicate file name %q", x.ID, f.Name)
				case !validURL(f.URL):
					return Manifest{}, fmt.Errorf("manifest: %s/%s: not an https source", x.ID, f.Name)
				case f.Size <= 0 || f.Size > local.VoiceModelMaxBytes-total:
					return Manifest{}, fmt.Errorf("manifest: %s/%s: size %d", x.ID, f.Name, f.Size)
				case !sha256Hex.MatchString(f.SHA256):
					return Manifest{}, fmt.Errorf("manifest: %s/%s: sha256 %q", x.ID, f.Name, f.SHA256)
				}
				seenFiles[f.Name] = true
				total += f.Size
			}
			seenTargets[x.Dir] = true
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

// Path is where a complete model is (a file for a single-file model, a directory for a multi-file model).
func Path(dir string, x Model) string { return filepath.Join(dir, x.entryName()) }

// PartPath is where its download goes until it is checked (a staging file or staging directory).
func PartPath(dir string, x Model) string { return filepath.Join(dir, "."+x.entryName()+PartSuffix) }

// Present says whether the model is complete in dir: a regular file of the manifest's size for single-file models, or a
// directory containing every listed regular file at its manifest size for multi-file models. The fetcher renames a
// download into place only once every file's size and sha256 matched, so the sizes are enough here.
func Present(dir string, x Model) bool {
	if !x.Multi() {
		fi, err := os.Stat(Path(dir, x))
		return err == nil && fi.Mode().IsRegular() && fi.Size() == x.Size
	}
	root := Path(dir, x)
	fi, err := os.Stat(root)
	if err != nil || !fi.IsDir() {
		return false
	}
	for _, f := range x.Files {
		ffi, err := os.Stat(filepath.Join(root, f.Name))
		if err != nil || !ffi.Mode().IsRegular() || ffi.Size() != f.Size {
			return false
		}
	}
	return true
}

// PartialSize returns how many bytes of an incomplete download are already on disk in PartPath.
func PartialSize(dir string, x Model) int64 {
	if !x.Multi() {
		if fi, err := os.Stat(PartPath(dir, x)); err == nil && fi.Mode().IsRegular() {
			return min(fi.Size(), x.Size)
		}
		return 0
	}
	stage := PartPath(dir, x)
	var total int64
	for _, f := range x.Files {
		if fi, err := os.Stat(filepath.Join(stage, f.Name)); err == nil && fi.Mode().IsRegular() {
			total += min(fi.Size(), f.Size)
		} else if fi, err := os.Stat(filepath.Join(stage, "."+f.Name+PartSuffix)); err == nil && fi.Mode().IsRegular() {
			total += min(fi.Size(), f.Size)
		}
	}
	return min(total, x.TotalSize())
}
