// Package gitinv inventories git repositories inside a snapshot (unpushed commits, modified, staged and
// untracked files), computes the git side of the cache rule, relocates restored worktrees and runs
// integrity checks.
//
// Repositories are untrusted input (project code writes .git/config and .gitattributes). Git is run
// hardened (BK-10): no system/global config, no hooks, no fsmonitor, no attribute files from the tree
// (GIT_ATTR_SOURCE = empty tree), every filter driver named in the repository's config neutralized, no
// network protocols, no optional locks (snapshots are read-only). Only plumbing that never executes
// configured programs is used.
package gitinv

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// EmptyTree is git's empty tree object id (SHA-1 repositories).
const EmptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// MaxListed caps the path/commit lists recorded per repository (counts are always exact).
const MaxListed = 200

// Repo is one repository's inventory.
type Repo struct {
	Path           string   `json:"path"` // slash path relative to the snapshot root, e.g. files/workspaces/b/r/main
	Kind           string   `json:"kind"` // "repository" | "worktree" | "bare"
	Head           string   `json:"head,omitempty"`
	Branch         string   `json:"branch,omitempty"`
	Remotes        int      `json:"remotes"`
	RefsDigest     string   `json:"refsDigest"` // sha256 of `for-each-ref` (name + object) output
	UnpushedCount  int      `json:"unpushedCount"`
	Unpushed       []string `json:"unpushed,omitempty"`
	StagedCount    int      `json:"stagedCount"`
	Staged         []string `json:"staged,omitempty"`
	ModifiedCount  int      `json:"modifiedCount"`
	Modified       []string `json:"modified,omitempty"`
	UntrackedCount int      `json:"untrackedCount"`
	Untracked      []string `json:"untracked,omitempty"`
	Stashes        int      `json:"stashes"`
	Error          string   `json:"error,omitempty"`
}

// Runner runs hardened git.
type Runner struct {
	Git     string        // git binary (default "git")
	Timeout time.Duration // per command (default 2m)
	// Map maps an absolute path recorded inside git metadata (a worktree's gitdir, written while the tree
	// lived at its original place) to where it is now (inside the snapshot). Nil = identity.
	Map func(abs string) string
}

// repoEnv pins GIT_DIR/GIT_WORK_TREE for a worktree whose `.git` file names its admin dir by an absolute
// original path: git must read the snapshot's copy, never the live repository.
func (r Runner) repoEnv(f Found) ([]string, error) {
	if f.Kind != "worktree" {
		return nil, nil
	}
	b, err := os.ReadFile(filepath.Join(f.Dir, ".git"))
	if err != nil {
		return nil, err
	}
	gd := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(b)), "gitdir:"))
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(f.Dir, gd)
	}
	if r.Map != nil {
		gd = r.Map(gd)
	}
	if _, err := os.Stat(gd); err != nil {
		return nil, fmt.Errorf("worktree's repository %s is not in the snapshot: %w", gd, err)
	}
	return []string{"GIT_DIR=" + gd, "GIT_WORK_TREE=" + f.Dir}, nil
}

func (r Runner) bin() string {
	if r.Git != "" {
		return r.Git
	}
	return "git"
}

var baseConfig = []string{
	"-c", "safe.directory=*",
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.attributesFile=/dev/null",
	"-c", "core.untrackedCache=false",
	"-c", "protocol.allow=never",
	"-c", "core.checkStat=minimal",
	"-c", "core.trustctime=false",
}

func env(ceiling string) []string {
	e := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=/nonexistent",
		"XDG_CONFIG_HOME=/nonexistent",
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_ATTR_SOURCE=" + EmptyTree,
		"GIT_NO_LAZY_FETCH=1",
	}
	if ceiling != "" {
		e = append(e, "GIT_CEILING_DIRECTORIES="+ceiling)
	}
	return e
}

// runEnv executes git in dir with the hardened configuration, extra environment and extra -c pairs.
func (r Runner) runEnv(ctx context.Context, dir, ceiling string, xenv, extra []string, args ...string) ([]byte, error) {
	t := r.Timeout
	if t == 0 {
		t = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, t)
	defer cancel()
	full := append(append(append([]string{}, baseConfig...), extra...), args...)
	cmd := exec.CommandContext(ctx, r.bin(), full...)
	cmd.Dir = dir
	cmd.Env = append(env(ceiling), xenv...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return out.Bytes(), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, msg)
	}
	return out.Bytes(), nil
}

// neutralizers returns -c pairs disabling every filter driver the repository's config names (repository
// config can't be switched off, but command-line config wins over it).
func (r Runner) neutralizers(ctx context.Context, dir, ceiling string, xenv []string) []string {
	out, err := r.runEnv(ctx, dir, ceiling, xenv, nil, "config", "--null", "--get-regexp", `^filter\.`)
	if err != nil && len(out) == 0 {
		return nil // exit 1 = no such keys
	}
	names := map[string]bool{}
	for _, rec := range bytes.Split(out, []byte{0}) {
		key, _, _ := bytes.Cut(rec, []byte{'\n'})
		k := string(key)
		if !strings.HasPrefix(k, "filter.") {
			continue
		}
		k = strings.TrimPrefix(k, "filter.")
		if i := strings.LastIndex(k, "."); i > 0 {
			names[k[:i]] = true
		}
	}
	var kv []string
	for n := range names {
		for _, f := range []string{"clean", "smudge", "process"} {
			kv = append(kv, "filter."+n+"."+f+"=")
		}
		kv = append(kv, "filter."+n+".required=false")
	}
	sort.Strings(kv)
	var extra []string
	for _, p := range kv {
		extra = append(extra, "-c", p)
	}
	return extra
}

func splitZ(b []byte) []string {
	var out []string
	for _, p := range bytes.Split(b, []byte{0}) {
		if len(p) > 0 {
			out = append(out, string(p))
		}
	}
	return out
}

func lines(b []byte) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func capList(s []string) []string {
	sort.Strings(s)
	if len(s) > MaxListed {
		return s[:MaxListed]
	}
	return s
}

// Found is a repository location found by Discover.
type Found struct {
	Dir  string // absolute directory (working tree root, or the bare repository)
	Kind string
}

// Discover walks root and returns repositories: working trees (a `.git` directory or file) and bare
// repositories (HEAD + objects/ + refs/). It doesn't descend into .git directories, bare repositories or
// skipped paths (absolute).
func Discover(root string, skip func(abs string) bool) ([]Found, error) {
	var found []Found
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			return nil // unreadable subtree: the backup itself reports it through restic
		}
		if !d.IsDir() {
			return nil
		}
		if skip != nil && p != root && skip(p) {
			return filepath.SkipDir
		}
		if d.Name() == ".git" {
			return filepath.SkipDir
		}
		if fi, err := os.Lstat(filepath.Join(p, ".git")); err == nil {
			kind := "repository"
			if fi.Mode().IsRegular() {
				kind = "worktree"
			}
			found = append(found, Found{Dir: p, Kind: kind})
			return nil // keep descending: nested repositories are inventoried too
		}
		if isBare(p) {
			found = append(found, Found{Dir: p, Kind: "bare"})
			return filepath.SkipDir
		}
		return nil
	})
	return found, err
}

// isBare: a git directory without a work tree — a bare repository, a mirror (`<repo>.git`) or a
// workspace repository (`.repos/<repo>/<branch>.git`) whose checkouts are worktrees.
func isBare(p string) bool {
	if fi, err := os.Lstat(filepath.Join(p, "HEAD")); err != nil || !fi.Mode().IsRegular() {
		return false
	}
	for _, n := range []string{"objects", "refs"} {
		if fi, err := os.Lstat(filepath.Join(p, n)); err != nil || !fi.IsDir() {
			return false
		}
	}
	if strings.HasSuffix(p, ".git") {
		return true
	}
	b, err := os.ReadFile(filepath.Join(p, "config"))
	return err == nil && bytes.Contains(b, []byte("bare = true"))
}

// Inventory inventories one repository. rel is its recorded path; ceiling stops git's discovery above the
// snapshot root.
func (r Runner) Inventory(ctx context.Context, f Found, rel, ceiling string) Repo {
	repo := Repo{Path: rel, Kind: f.Kind}
	xenv, err := r.repoEnv(f)
	if err != nil {
		repo.Error = err.Error()
		return repo
	}
	ex := r.neutralizers(ctx, f.Dir, ceiling, xenv)
	g := func(args ...string) ([]byte, error) { return r.runEnv(ctx, f.Dir, ceiling, xenv, ex, args...) }
	var errs []string
	note := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}

	if out, err := g("rev-parse", "--verify", "-q", "HEAD"); err == nil {
		repo.Head = strings.TrimSpace(string(out))
	}
	if out, err := g("symbolic-ref", "-q", "--short", "HEAD"); err == nil {
		repo.Branch = strings.TrimSpace(string(out))
	}
	var out []byte
	out, err = g("remote")
	note(err)
	repo.Remotes = len(lines(out))
	refs, err := g("for-each-ref", "--format=%(objectname) %(refname)")
	note(err)
	sum := sha256.Sum256(refs)
	repo.RefsDigest = hex.EncodeToString(sum[:])

	// Unpushed: on commits reachable from local branches (a worktree: from its HEAD) and from no
	// remote-tracking ref. Without remotes that is every commit on a branch — work that exists nowhere else.
	revArgs := []string{"rev-list", "--branches", "--not", "--remotes"}
	if f.Kind == "worktree" {
		revArgs = []string{"rev-list", "HEAD", "--not", "--remotes"}
	}
	if repo.Head != "" || f.Kind != "worktree" {
		out, err = g(revArgs...)
		note(err)
		u := lines(out)
		repo.UnpushedCount = len(u)
		repo.Unpushed = capList(u)
	}
	if out, err := g("rev-list", "--walk-reflogs", "--count", "refs/stash"); err == nil {
		fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &repo.Stashes)
	}

	if f.Kind != "bare" {
		if repo.Head != "" {
			out, err = g("diff-index", "--cached", "--name-only", "-z", "HEAD")
			note(err)
			s := splitZ(out)
			repo.StagedCount, repo.Staged = len(s), capList(s)
		}
		out, err = g("ls-files", "-m", "-z")
		note(err)
		m := splitZ(out)
		repo.ModifiedCount, repo.Modified = len(m), capList(m)
		out, err = g("ls-files", "--others", "--exclude-standard", "-z")
		note(err)
		u := splitZ(out)
		repo.UntrackedCount, repo.Untracked = len(u), capList(u)
	}
	if len(errs) > 0 {
		repo.Error = strings.Join(errs, "; ")
	}
	return repo
}

// CacheExcludes returns absolute paths of git-ignored cache directories in the working tree at dir
// (coverage.CacheDirNames / ConditionalCacheDirs via isCache).
func (r Runner) CacheExcludes(ctx context.Context, f Found, ceiling string, isCache func(abs string) bool) ([]string, error) {
	dir := f.Dir
	xenv, err := r.repoEnv(f)
	if err != nil {
		return nil, err
	}
	ex := r.neutralizers(ctx, dir, ceiling, xenv)
	out, err := r.runEnv(ctx, dir, ceiling, xenv, ex, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
	if err != nil {
		return nil, err
	}
	var res []string
	for _, p := range splitZ(out) {
		if !strings.HasSuffix(p, "/") {
			continue
		}
		abs := filepath.Join(dir, filepath.FromSlash(strings.TrimSuffix(p, "/")))
		if isCache(abs) {
			res = append(res, abs)
		}
	}
	sort.Strings(res)
	return res, nil
}

// Fsck runs a full object check in the repository (for a worktree, its common repository).
func (r Runner) Fsck(ctx context.Context, f Found, ceiling string) error {
	xenv, err := r.repoEnv(f)
	if err != nil {
		return err
	}
	_, err = r.runEnv(ctx, f.Dir, ceiling, xenv, nil, "fsck", "--full", "--strict", "--no-progress", "--no-dangling")
	return err
}

// ErrExternalReference means a restored repository still points outside the restore root.
var ErrExternalReference = errors.New("repository references a path outside the restore root")

// Mapping maps an original absolute prefix to its restored location.
type Mapping struct{ Old, New string }

// Relocate rewrites absolute paths in restored git metadata under dir according to maps: a worktree's
// `.git` file (gitdir:), a repository's worktrees/*/gitdir and objects/info/alternates. Absolute paths
// that end up outside within are reported (never followed: they could reach live data).
func Relocate(dir string, maps []Mapping, within string) (changed int, external []string, err error) {
	inside := func(p string) bool { return p == within || strings.HasPrefix(p, within+"/") }
	rewrite := func(path, prefix string) error {
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var outLines []string
		dirty := false
		for _, l := range strings.Split(string(b), "\n") {
			if prefix != "" && !strings.HasPrefix(l, prefix) {
				outLines = append(outLines, l)
				continue
			}
			val := strings.TrimPrefix(l, prefix)
			if filepath.IsAbs(val) {
				for _, m := range maps {
					if val == m.Old || strings.HasPrefix(val, m.Old+"/") {
						val = m.New + strings.TrimPrefix(val, m.Old)
						dirty = true
						break
					}
				}
				if !inside(val) {
					external = append(external, path+": "+val)
				}
			}
			outLines = append(outLines, prefix+val)
		}
		if dirty {
			changed++
			mode := fs.FileMode(0o644)
			if fi, err := os.Stat(path); err == nil {
				mode = fi.Mode().Perm()
			}
			if err := os.Chmod(path, mode|0o200); err != nil {
				return err
			}
			return os.WriteFile(path, []byte(strings.Join(outLines, "\n")), mode|0o200)
		}
		return nil
	}
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		name := d.Name()
		switch {
		case name == ".git" && d.Type().IsRegular():
			return rewrite(p, "gitdir: ")
		case name == "gitdir" && d.Type().IsRegular() && filepath.Base(filepath.Dir(filepath.Dir(p))) == "worktrees":
			return rewrite(p, "")
		case name == "alternates" && d.Type().IsRegular() && filepath.Base(filepath.Dir(p)) == "info":
			return rewrite(p, "")
		}
		return nil
	})
	return changed, external, err
}

// Bundle writes a git bundle with every ref of the repository (an open, self-contained format: `git clone
// x.bundle`). Returns false when the repository has no refs to bundle.
func (r Runner) Bundle(ctx context.Context, f Found, ceiling, out string) (bool, error) {
	xenv, err := r.repoEnv(f)
	if err != nil {
		return false, err
	}
	refs, err := r.runEnv(ctx, f.Dir, ceiling, xenv, nil, "for-each-ref", "--count=1")
	if err != nil {
		return false, err
	}
	if len(bytes.TrimSpace(refs)) == 0 {
		return false, nil
	}
	if _, err := r.runEnv(ctx, f.Dir, ceiling, xenv, nil, "bundle", "create", out, "--all"); err != nil {
		return false, err
	}
	_, err = r.runEnv(ctx, f.Dir, ceiling, xenv, nil, "bundle", "verify", "--quiet", out)
	return true, err
}
