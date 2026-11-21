package restore

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/CybexBV/whombat/appliance/backup/pkg/fsutil"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// ReadHermes describes the agent's Hermes home under root (a staged `hermes` snapshot; BK-36, NX-466): its SQLite
// stores — each `*.db` directly in the home and in each of Hermes's named profiles (profiles/<name>/, the outsiders'
// `_feedback`) and its `-wal` — hashed, and the number of skills (`SKILL.md`) in its skills/, outside its hidden
// folders (`.archive`, `.hub`). The checkpoint records it in the manifest; the restore check compares a restored tree
// with it. It never follows a symlink.
func ReadHermes(root string) (*manifest.Hermes, error) {
	h := &manifest.Hermes{Stores: []manifest.File{}}
	dirs := []string{""}
	ents, err := os.ReadDir(filepath.Join(root, "profiles"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, e := range ents {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, path.Join("profiles", e.Name()))
		}
	}
	for _, d := range dirs {
		files, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(d)))
		if err != nil {
			if d == "" && os.IsNotExist(err) {
				break
			}
			return nil, err
		}
		for _, f := range files {
			if !f.Type().IsRegular() || !(strings.HasSuffix(f.Name(), ".db") || strings.HasSuffix(f.Name(), ".db-wal")) {
				continue
			}
			sum, size, err := fsutil.SHA256File(filepath.Join(root, filepath.FromSlash(d), f.Name()))
			if err != nil {
				return nil, err
			}
			h.Stores = append(h.Stores, manifest.File{Path: path.Join(manifest.HermesDir, d, f.Name()), SHA256: sum, Size: size})
		}
	}
	sort.Slice(h.Stores, func(i, j int) bool { return h.Stores[i].Path < h.Stores[j].Path })
	skills := filepath.Join(root, "skills")
	err = filepath.WalkDir(skills, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == skills && os.IsNotExist(err) {
				return filepath.SkipDir
			}
			return err
		}
		if d.IsDir() && p != skills && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		if d.Type().IsRegular() && d.Name() == "SKILL.md" {
			h.Skills++
		}
		return nil
	})
	return h, err
}

// verifyHermes is the `hermes` check: every SQLite store the manifest names is back byte for byte (so the person's
// sessions are), and the home's skills/ holds as many skills.
func verifyHermes(root string, m *manifest.Manifest) (string, error) {
	got, err := ReadHermes(filepath.Join(root, manifest.FilesDir, "hermes"))
	if err != nil {
		return "", err
	}
	have := map[string]manifest.File{}
	for _, f := range got.Stores {
		have[f.Path] = f
	}
	var problems []string
	for _, w := range m.Hermes.Stores {
		if f, ok := have[w.Path]; !ok {
			problems = append(problems, w.Path+": missing")
		} else if f.SHA256 != w.SHA256 || f.Size != w.Size {
			problems = append(problems, w.Path+": differs from the checkpoint")
		}
	}
	if got.Skills != m.Hermes.Skills {
		problems = append(problems, fmt.Sprintf("the home holds %d skills, the checkpoint %d", got.Skills, m.Hermes.Skills))
	}
	if len(problems) > 0 {
		if len(problems) > 5 {
			problems = append(problems[:5], fmt.Sprintf("and %d more", len(problems)-5))
		}
		return "", fmt.Errorf("%s", strings.Join(problems, "; "))
	}
	return fmt.Sprintf("the Hermes home with %d SQLite stores as recorded, %d skills", len(m.Hermes.Stores), got.Skills), nil
}
