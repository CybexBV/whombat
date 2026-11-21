package gitinv

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=t",
		"GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(s), 0o755); err != nil {
		t.Fatal(err)
	}
}

// Project code controls .git/config and .gitattributes: inventorying such a repository must never run
// anything it names (fsmonitor, filter drivers, hooks).
func TestInventoryRunsNothingFromTheRepository(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "evil")
	_ = os.MkdirAll(repo, 0o755)
	marker := filepath.Join(root, "PWNED")
	evil := filepath.Join(root, "evil.sh")
	write(t, evil, "#!/bin/sh\ntouch "+marker+"\ncat\n")
	git(t, repo, "init", "-q", "-b", "main")
	write(t, filepath.Join(repo, "a.txt"), "one\n")
	write(t, filepath.Join(repo, ".gitattributes"), "*.txt filter=pwn\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "c")
	for _, kv := range [][2]string{{"core.fsmonitor", evil}, {"filter.pwn.clean", evil}, {"filter.pwn.smudge", evil},
		{"filter.pwn.process", evil}, {"filter.pwn.required", "true"}, {"core.hooksPath", root}} {
		git(t, repo, "config", kv[0], kv[1])
	}
	write(t, filepath.Join(repo, ".git", "info", "attributes"), "* filter=pwn\n")
	for _, h := range []string{"post-checkout", "pre-commit", "reference-transaction", "post-index-change"} {
		write(t, filepath.Join(root, h), "#!/bin/sh\ntouch "+marker+"\n")
	}
	// make the index stale so status-like commands would want to re-hash (and filter) content
	write(t, filepath.Join(repo, "a.txt"), "two\n")
	write(t, filepath.Join(repo, "b.txt"), "untracked\n")
	_ = os.Remove(marker)

	r := Runner{}
	found, err := Discover(root, nil)
	if err != nil || len(found) != 1 {
		t.Fatalf("discover %v %v", found, err)
	}
	inv := r.Inventory(context.Background(), found[0], "evil", root)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("inventory executed a program named by the repository")
	}
	if inv.ModifiedCount != 1 || inv.UntrackedCount != 1 || inv.UnpushedCount != 1 {
		t.Fatalf("inventory %+v", inv)
	}
	if _, err := r.CacheExcludes(context.Background(), found[0], root, func(string) bool { return true }); err != nil {
		t.Fatal(err)
	}
	if err := r.Fsck(context.Background(), found[0], root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("cache scan or fsck executed a program named by the repository")
	}
	// Control: plain git in the same repository does run it (the attack is real).
	ctl := exec.Command("git", "status", "--porcelain")
	ctl.Dir = repo
	ctl.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	_ = ctl.Run() // it fails after running the programs; what matters is that they ran
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("control: unhardened git status did not trigger the repository's programs; the test proves nothing")
	}
}

func TestCacheExcludesOnlyIgnoredCacheDirs(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "r")
	_ = os.MkdirAll(repo, 0o755)
	git(t, repo, "init", "-q", "-b", "main")
	write(t, filepath.Join(repo, ".gitignore"), "node_modules/\nbuild/\n.env\n")
	write(t, filepath.Join(repo, "node_modules", "x.js"), "1")
	write(t, filepath.Join(repo, "build", "out.bin"), "1")
	write(t, filepath.Join(repo, ".env"), "SECRET=1")
	write(t, filepath.Join(repo, "sub", "__pycache__", "a.pyc"), "1") // not ignored: kept
	f := Found{Dir: repo, Kind: "repository"}
	got, err := Runner{}.CacheExcludes(context.Background(), f, root, func(abs string) bool {
		return filepath.Base(abs) == "node_modules" || filepath.Base(abs) == "__pycache__"
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.HasSuffix(got[0], "/node_modules") {
		t.Fatalf("excludes %v", got)
	}
}

func TestRelocate(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "ws", "wt", ".git"), "gitdir: /persist/whombat/workspaces/.repos/r.git/worktrees/wt\n")
	write(t, filepath.Join(root, "ws", ".repos", "r.git", "worktrees", "wt", "gitdir"), "/persist/whombat/workspaces/wt/.git\n")
	write(t, filepath.Join(root, "ws", ".repos", "r.git", "objects", "info", "alternates"), "/persist/whombat/workspaces/clone/.git/objects\n/etc/evil/objects\n")
	n, ext, err := Relocate(root, []Mapping{{Old: "/persist/whombat/workspaces", New: filepath.Join(root, "ws")}}, root)
	if err != nil || n != 3 {
		t.Fatalf("relocate: %d %v", n, err)
	}
	if len(ext) != 1 || !strings.Contains(ext[0], "/etc/evil/objects") {
		t.Fatalf("external %v", ext)
	}
	b, _ := os.ReadFile(filepath.Join(root, "ws", "wt", ".git"))
	if !strings.Contains(string(b), filepath.Join(root, "ws", ".repos")) {
		t.Fatalf(".git %s", b)
	}
}
