// Where a release's source is (release/lib/source.sh): the same cases as harness/src/lib/source.test.ts, which tries
// the harness's own form of it.
package release_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// repository makes a git repository with one commit per map of files and returns its folder and the commits' ids.
func repository(t *testing.T, dir string, commits ...map[string]string) (string, []string) {
	t.Helper()
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	git("init", "-q", "-b", "main")
	git("config", "user.email", "test@example.com")
	git("config", "user.name", "test")
	var revs []string
	for _, files := range commits {
		for path, text := range files {
			p := filepath.Join(dir, path)
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		git("add", "-A")
		git("commit", "-q", "-m", "commit")
		revs = append(revs, git("rev-parse", "HEAD"))
	}
	return dir, revs
}

func inFolder(files map[string]string) map[string]string {
	out := map[string]string{}
	for path, text := range files {
		out["appliance/"+path] = text
	}
	return out
}

type sourceWorld struct{ old, oldRev, whombat, before, folderRev, other string }

// The old appliance repository, and Whombat: first without the appliance, then with it as a folder.
func world(t *testing.T) sourceWorld {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	own := map[string]string{"flake.nix": "{ }\n", "nix/profiles/prod.nix": "{ }\n", "release/note": "own\n"}
	folder := inFolder(map[string]string{"flake.nix": "{ }\n", "nix/profiles/prod.nix": "{ }\n", "release/note": "folder\n"})
	old, oldRevs := repository(t, filepath.Join(base, "whombat-appliance"), own)
	whombat, revs := repository(t, filepath.Join(base, "whombat"), map[string]string{"package.json": "{}\n"}, folder)
	other, _ := repository(t, filepath.Join(base, "other"), map[string]string{"README.md": "nothing\n"})
	return sourceWorld{old, oldRevs[0], whombat, revs[0], revs[1], other}
}

// source runs one function of release/lib/source.sh with `root` set to an appliance folder.
func source(t *testing.T, root, archives, call string) (string, error) {
	t.Helper()
	lib, err := filepath.Abs("lib/source.sh")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", "-euo", "pipefail", "-c", `root=$1; . "$2"; eval "$3"`, "source", root, lib, call)
	cmd.Env = append(os.Environ(), "WB_ARCHIVE_GIT="+archives)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func mustSource(t *testing.T, root, archives, call string) string {
	t.Helper()
	out, err := source(t, root, archives, call)
	if err != nil {
		t.Fatalf("%s: %v: %s", call, err, out)
	}
	return out
}

func TestSourceOfTheAppliancesOwnRepository(t *testing.T) {
	w := world(t)
	if got := mustSource(t, w.old, "", "source_find "+w.oldRev); got != w.old {
		t.Fatalf("found in %q, want %q", got, w.old)
	}
	if got := mustSource(t, w.old, "", "source_dir "+w.old+" "+w.oldRev); got != "" {
		t.Fatalf("the appliance is in %q, want the top", got)
	}
	if got, want := mustSource(t, w.old, "", "source_flake "+w.oldRev), "git+file://"+w.old+"?rev="+w.oldRev; got != want {
		t.Fatalf("flake %q, want %q", got, want)
	}
	if got := mustSource(t, w.old, "", "source_show "+w.oldRev+" release/note"); got != "own" {
		t.Fatalf("release/note is %q", got)
	}
	want := `{"repository":"whombat-appliance","rev":"` + w.oldRev + `","dirty":false}`
	if got := mustSource(t, w.old, "", "source_record "+w.oldRev+" false"); got != want {
		t.Fatalf("record %s, want %s", got, want)
	}
}

func TestSourceOfWhombatWithTheApplianceInItsFolder(t *testing.T) {
	w := world(t)
	root := filepath.Join(w.whombat, "appliance")
	if got := mustSource(t, root, "", "source_find "+w.folderRev); got != w.whombat {
		t.Fatalf("found in %q, want %q", got, w.whombat)
	}
	if got, want := mustSource(t, root, "", "source_flake "+w.folderRev), "git+file://"+w.whombat+"?rev="+w.folderRev+"&dir=appliance"; got != want {
		t.Fatalf("flake %q, want %q", got, want)
	}
	if got := mustSource(t, root, "", "source_show "+w.folderRev+" release/note"); got != "folder" {
		t.Fatalf("release/note is %q", got)
	}
	want := `{"repository":"whombat","rev":"` + w.folderRev + `","dir":"appliance","dirty":true}`
	if got := mustSource(t, root, "", "source_record "+w.folderRev+" true"); got != want {
		t.Fatalf("record %s, want %s", got, want)
	}
}

func TestSourceInTheArchivesInOrder(t *testing.T) {
	w := world(t)
	root := filepath.Join(w.whombat, "appliance")
	archives := w.other + ":" + w.old
	if got := mustSource(t, root, archives, "source_find "+w.oldRev); got != w.old {
		t.Fatalf("found in %q, want the archive %q", got, w.old)
	}
	if got, want := mustSource(t, root, archives, "source_flake "+w.oldRev), "git+file://"+w.old+"?rev="+w.oldRev; got != want {
		t.Fatalf("flake %q, want %q", got, want)
	}
	// The checkout comes first, even when an archive has the commit too.
	if got := mustSource(t, root, w.whombat, "source_find "+w.folderRev); got != w.whombat {
		t.Fatalf("found in %q, want the checkout", got)
	}
}

func TestSourceRefusesWhatNobodyHasAndWhatHoldsNoAppliance(t *testing.T) {
	w := world(t)
	out, err := source(t, w.whombat, w.old, "source_find 0123456789012345678901234567890123456789")
	if err == nil || !strings.Contains(out, "WB_ARCHIVE_GIT") {
		t.Fatalf("an unknown commit: %v: %s", err, out)
	}
	out, err = source(t, w.whombat, "", "source_flake "+w.before)
	if err == nil || !strings.Contains(out, "holds no appliance") {
		t.Fatalf("a commit without the appliance: %v: %s", err, out)
	}
}

func TestSourceOfTheWorkingTree(t *testing.T) {
	w := world(t)
	if got, want := mustSource(t, w.old, "", "source_tree_flake"), "path:"+w.old; got != want {
		t.Fatalf("flake %q, want %q", got, want)
	}
	root := filepath.Join(w.whombat, "appliance")
	if got, want := mustSource(t, root, "", "source_tree_flake"), "git+file://"+w.whombat+"?dir=appliance"; got != want {
		t.Fatalf("flake %q, want %q", got, want)
	}
}

func TestSourceArchivesFromTheEnvironment(t *testing.T) {
	w := world(t)
	if got := mustSource(t, w.old, "/a:/b::", "source_archives"); got != "/a\n/b" {
		t.Fatalf("archives %q", got)
	}
	if got := mustSource(t, w.old, "", "source_archives"); got != "" {
		t.Fatalf("an empty list gave %q", got)
	}
}
