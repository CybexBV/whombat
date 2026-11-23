// release/upload-iso (Whombat ENV-22) against a stand-in curl that records each signed request and its standard input,
// answers HEADs with the served file's MD5 as its ETag and lists the bucket from a folder: one installer at the root of
// the site, named by its version (one more than latest.json's, v0.1 when it names none), its .sha256, then
// installer/latest.json, then every older installer removed; the key only ever on curl's standard input; what the site
// serves with the same digest isn't sent again, another digest under the same name is refused (R1 #14); latest.json
// waits until the site serves both files with their digests; a newer release's installer stays; a broken ISO, a
// foreign id or a missing setting stops before anything is sent.
package release_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The stand-in curl: a HEAD (-sI) answers from $FAKE_SERVED/<path>; a plain GET serves the file; a signed request is
// recorded with its standard input and lists, deletes, copies or uploads in $FAKE_SERVED.
const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
url=${@: -1}
if [[ $args == *"-sI"* ]]; then
  rel=${url#https://downloads.example.com/}
  rel=${rel%%\?*}
  # A site that answers something else than 200 or 404 for one key (FAKE_STATUS_KEY).
  [ "${FAKE_STATUS_KEY:-}" != "$rel" ] || { printf 'HTTP/2 503\r\n\r\n'; exit 0; }
  [ -f "$FAKE_SERVED/$rel" ] || { printf 'HTTP/2 404\r\n\r\n'; exit 0; }
  printf 'HTTP/2 200\r\ncontent-length: %s\r\n' "$(stat -c %s "$FAKE_SERVED/$rel")"
  if [ -z "${FAKE_NO_ETAG:-}" ]; then
    tag=$(md5sum "$FAKE_SERVED/$rel" | cut -d' ' -f1)
    # A cache that still serves the file before (FAKE_STALE names its key).
    [ "${FAKE_STALE:-}" != "$rel" ] || tag=0123456789abcdef0123456789abcdef
    printf 'etag: "%s"\r\n' "$tag"
  fi
  printf '\r\n'
  exit 0
fi
if [[ $args != *"--aws-sigv4"* ]]; then
  # A GET of what the site serves (small files).
  rel=${url#https://downloads.example.com/}
  rel=${rel%%\?*}
  [ -f "$FAKE_SERVED/$rel" ] || exit 22
  cat "$FAKE_SERVED/$rel"
  exit 0
fi
n=$(ls "$FAKE_LOG" | wc -l)
{ echo "argv: $args"; echo "stdin: $(cat)"; echo "env: $(env | grep -c -e '^R2_' -e '^AWS_' || true)"; } >"$FAKE_LOG/$n.call"
if [[ $url == *"?list-type=2"* ]]; then
  # A key without the right to list (FAKE_NO_LIST).
  [ -z "${FAKE_NO_LIST:-}" ] || exit 22
  prefix=$(sed -n 's/.*[?&]prefix=\([^&]*\).*/\1/p' <<<"$url" | sed 's#%2F#/#g')
  echo '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>'
  (cd "$FAKE_SERVED" && find . -type f ! -name .failed | sed 's#^\./##' | sort) | while read -r k; do
    [[ $k != "$prefix"* ]] || echo "<Contents><Key>$k</Key></Contents>"
  done
  echo '</ListBucketResult>'
  exit 0
fi
rel=${url#https://r2.example.com/whombat-downloads/}
if [[ $args == *"-X DELETE"* ]]; then
  [ "${FAKE_FAIL_DELETE:-}" != "$rel" ] || exit 22
  rm -f "$FAKE_SERVED/$rel"
  exit 0
fi
src= copy=
while [ $# -gt 0 ]; do
  case $1 in
    -T) src=$2; shift 2 ;;
    -o | -K | --aws-sigv4 | -X) shift 2 ;;
    -H) case $2 in x-amz-copy-source:*) copy=${2#x-amz-copy-source: /whombat-downloads/} ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
# An upload that fails FAKE_FAIL_TIMES times for the key FAKE_FAIL names.
if [ -n "${FAKE_FAIL:-}" ] && [ "$rel" = "$FAKE_FAIL" ]; then
  failed=$(cat "$FAKE_SERVED/.failed" 2>/dev/null || echo 0)
  if [ "$failed" -lt "${FAKE_FAIL_TIMES:-1}" ]; then echo $((failed + 1)) >"$FAKE_SERVED/.failed"; exit 22; fi
fi
mkdir -p "$(dirname "$FAKE_SERVED/$rel")"
if [ -n "$copy" ]; then
  # A bucket without CopyObject answers 501 (FAKE_NO_COPY).
  [ -z "${FAKE_NO_COPY:-}" ] || exit 22
  cp "$FAKE_SERVED/$copy" "$FAKE_SERVED/$rel"
else
  cp "$src" "$FAKE_SERVED/$rel"
fi
`

const site = "https://downloads.example.com"

type isoWorld struct {
	dir, served, log, bin, creds string
	sha                          string
}

// newISOWorld is a release folder with its ISO, a stand-in curl and an empty site; worlds made with on share a site.
func newISOWorld(t *testing.T, id string) *isoWorld {
	t.Helper()
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("no jq")
	}
	base := t.TempDir()
	w := &isoWorld{dir: filepath.Join(base, id), served: filepath.Join(base, "served"), log: filepath.Join(base, "log"),
		bin: filepath.Join(base, "bin"), creds: filepath.Join(base, "credentials.env")}
	for _, d := range []string{w.served, w.log, w.bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(w.bin, "curl"), []byte(fakeCurl), 0o755)
	write(t, w.creds, []byte("R2_ENDPOINT=https://r2.example.com\nR2_ACCESS_KEY_ID=made-up-id\nR2_SECRET_ACCESS_KEY=made-up-secret\n"), 0o600)
	w.build(t, id, "whombat installer\n")
	return w
}

// on is another release on the same site, with an ISO made of line.
func (w *isoWorld) on(t *testing.T, id, line string) *isoWorld {
	t.Helper()
	o := &isoWorld{dir: filepath.Join(filepath.Dir(w.dir), id), served: w.served, log: w.log, bin: w.bin, creds: w.creds}
	o.build(t, id, line)
	return o
}

// build writes the release's ISO (its lines) under the build's own name, and its iso.json.
func (w *isoWorld) build(t *testing.T, id, line string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(w.dir, "iso"), 0o755); err != nil {
		t.Fatal(err)
	}
	iso := []byte(strings.Repeat(line, 1000))
	sum := sha256.Sum256(iso)
	w.sha = hex.EncodeToString(sum[:])
	write(t, filepath.Join(w.dir, "iso", "whombat-installer-x86_64.iso"), iso, 0o644)
	meta, _ := json.Marshal(map[string]any{"v": 1, "releaseId": id, "file": "whombat-installer-x86_64.iso", "sha256": w.sha, "size": len(iso)})
	write(t, filepath.Join(w.dir, "iso.json"), meta, 0o644)
}

func write(t *testing.T, p string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, mode); err != nil {
		t.Fatal(err)
	}
}

func (w *isoWorld) runWith(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("./upload-iso", append([]string{w.dir}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+w.bin+":"+os.Getenv("PATH"), "FAKE_SERVED="+w.served, "FAKE_LOG="+w.log,
		"WHOMBAT_R2_CREDENTIALS="+w.creds, "WHOMBAT_INSTALLER_BUCKET=whombat-downloads",
		"WHOMBAT_INSTALLER_BASE_URL="+site, "TMPDIR="+t.TempDir(), "UPLOAD_RETRY_DELAY=0", "WHOMBAT_INSTALLER_SETTLE=0")
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (w *isoWorld) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	return w.runWith(t, nil, args...)
}

func (w *isoWorld) mustRun(t *testing.T, args ...string) string {
	t.Helper()
	out, err := w.run(t, args...)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	return out
}

func (w *isoWorld) calls(t *testing.T) []string {
	t.Helper()
	entries, _ := os.ReadDir(w.log)
	var out []string
	for i := range entries {
		b, err := os.ReadFile(filepath.Join(w.log, strconv.Itoa(i)+".call"))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, string(b))
	}
	return out
}

// changes are the signed requests that change the bucket: uploads, copies and removals, not listings.
func (w *isoWorld) changes(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, c := range w.calls(t) {
		if !strings.Contains(c, "?list-type=2") {
			out = append(out, c)
		}
	}
	return out
}

// files is what the site serves, sorted.
func (w *isoWorld) files(t *testing.T) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(w.served, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() != ".failed" {
			rel, _ := filepath.Rel(w.served, p)
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func (w *isoWorld) read(t *testing.T, key string) string {
	t.Helper()
	b, _ := os.ReadFile(filepath.Join(w.served, key))
	return string(b)
}

func (w *isoWorld) latest(t *testing.T) map[string]any {
	t.Helper()
	var latest map[string]any
	if err := json.Unmarshal([]byte(w.read(t, "installer/latest.json")), &latest); err != nil {
		t.Fatalf("latest.json: %v", err)
	}
	return latest
}

// oldLayout serves an installer as the tools before ENV-22 left it: installer/<id>/, installer/latest/ and a version-1
// latest.json naming it.
func (w *isoWorld) oldLayout(t *testing.T, id string, iso []byte) {
	t.Helper()
	sum := sha256.Sum256(iso)
	sha := hex.EncodeToString(sum[:])
	for _, dir := range []string{"installer/" + id, "installer/latest"} {
		write(t, filepath.Join(w.served, dir, "whombat-installer.iso"), iso, 0o644)
		write(t, filepath.Join(w.served, dir, "whombat-installer.iso.sha256"), []byte(sha+"  whombat-installer.iso\n"), 0o644)
	}
	latest, _ := json.Marshal(map[string]any{"v": 1, "releaseId": id, "file": "whombat-installer.iso", "sha256": sha,
		"url": site + "/installer/" + id + "/whombat-installer.iso", "latestUrl": site + "/installer/latest/whombat-installer.iso"})
	write(t, filepath.Join(w.served, "installer/latest.json"), latest, 0o644)
}

func TestUploadISOFirstVersion(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.1")
	out := w.mustRun(t, "--production")
	changes := w.changes(t)
	// The ISO, its checksum, latest.json last: nothing names a file before it is there.
	want := []string{"whombat-installer-v0.1.iso", "whombat-installer-v0.1.iso.sha256", "installer/latest.json"}
	if len(changes) != len(want) {
		t.Fatalf("%d changes:\n%s", len(changes), strings.Join(changes, "\n"))
	}
	for i, key := range want {
		if !strings.Contains(strings.SplitN(changes[i], "\n", 2)[0], "https://r2.example.com/whombat-downloads/"+key) {
			t.Fatalf("change %d isn't %s:\n%s", i, key, changes[i])
		}
	}
	for _, c := range w.calls(t) {
		argv, _, _ := strings.Cut(c, "\nstdin:")
		if strings.Contains(argv, "made-up") || !strings.Contains(c, `stdin: user = "made-up-id:made-up-secret"`) ||
			!strings.Contains(c, "env: 0") || !strings.Contains(argv, "--aws-sigv4 aws:amz:auto:s3") {
			t.Fatalf("the key went elsewhere than curl's standard input:\n%s", c)
		}
	}
	if strings.Contains(out, "made-up") {
		t.Fatalf("the key is in the output:\n%s", out)
	}
	if got := w.read(t, "whombat-installer-v0.1.iso.sha256"); got != w.sha+"  whombat-installer-v0.1.iso\n" {
		t.Fatalf(".sha256: %q", got)
	}
	latest := w.latest(t)
	if latest["v"] != 2.0 || latest["version"] != "v0.1" || latest["releaseId"] != "whombat-20261120.1" ||
		latest["sha256"] != w.sha || latest["file"] != "whombat-installer-v0.1.iso" ||
		latest["url"] != site+"/whombat-installer-v0.1.iso" || latest["sha256Url"] != site+"/whombat-installer-v0.1.iso.sha256" {
		t.Fatalf("latest.json %v", latest)
	}
	if !strings.Contains(out, `"version": "v0.1"`) || !strings.Contains(out, `"url": "`+site+`/whombat-installer-v0.1.iso"`) {
		t.Fatalf("its answer:\n%s", out)
	}
	// Again: everything is there with the same digest, latest.json too (its time kept), so nothing changes.
	w.mustRun(t, "--production")
	if n := len(w.changes(t)); n != len(want) {
		t.Fatalf("a run again changed %d files", n-len(want))
	}
}

// The next release's installer is the next version, and every older installer goes once latest.json names it: the
// layout before ENV-22 (installer/<id>/, installer/latest/) and the version before. Other files of the bucket stay.
func TestUploadISONextVersionRemovesOlder(t *testing.T) {
	w := newISOWorld(t, "whombat-20261121.1")
	w.oldLayout(t, "whombat-20261120.5", []byte("an installer before"))
	write(t, filepath.Join(w.served, "installer/whombat-20261119.3/whombat-installer.iso"), []byte("older still"), 0o644)
	write(t, filepath.Join(w.served, "installer/notes.txt"), []byte("not an installer"), 0o644)
	write(t, filepath.Join(w.served, "phone/whombat.apk"), []byte("not an installer"), 0o644)
	out := w.mustRun(t, "--production")
	if got, want := strings.Join(w.files(t), " "), "installer/latest.json installer/notes.txt phone/whombat.apk whombat-installer-v0.1.iso whombat-installer-v0.1.iso.sha256"; got != want {
		t.Fatalf("the site serves %s, want %s\n%s", got, want, out)
	}
	// A removal comes after latest.json names the new installer.
	changes := w.changes(t)
	if !strings.Contains(changes[2], "installer/latest.json") || !strings.Contains(changes[3], "-X DELETE") {
		t.Fatalf("removed before latest.json moved:\n%s", strings.Join(changes, "\n"))
	}
	if !strings.Contains(out, "installer/whombat-20261120.5/whombat-installer.iso") || !strings.Contains(out, `"removed": [`) {
		t.Fatalf("its answer doesn't name what it removed:\n%s", out)
	}

	next := w.on(t, "whombat-20261122.4", "the next installer\n")
	next.mustRun(t, "--production")
	if got, want := strings.Join(w.files(t), " "), "installer/latest.json installer/notes.txt phone/whombat.apk whombat-installer-v0.2.iso whombat-installer-v0.2.iso.sha256"; got != want {
		t.Fatalf("after v0.2 the site serves %s, want %s", got, want)
	}
	if l := w.latest(t); l["version"] != "v0.2" || l["releaseId"] != "whombat-20261122.4" || l["sha256"] != next.sha {
		t.Fatalf("latest.json %v", l)
	}
	// A release without an ISO of its own keeps the installer and its number: its host's, run again.
	before := len(w.changes(t))
	next.mustRun(t, "--production")
	if n := len(w.changes(t)); n != before {
		t.Fatalf("the same installer again changed %d files", n-before)
	}
}

// The installer latest.json names before ENV-22 is the same ISO: the bucket copies it to its new name, else it is
// uploaded.
func TestUploadISOCopiesTheSameISO(t *testing.T) {
	for _, noCopy := range []bool{false, true} {
		w := newISOWorld(t, "whombat-20261123.4")
		iso, _ := os.ReadFile(filepath.Join(w.dir, "iso", "whombat-installer-x86_64.iso"))
		w.oldLayout(t, "whombat-20261123.4", iso)
		var env []string
		if noCopy {
			env = []string{"FAKE_NO_COPY=1"}
		}
		if out, err := w.runWith(t, env, "--production"); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		changes := w.changes(t)
		copied := strings.Contains(changes[0], "x-amz-copy-source: /whombat-downloads/installer/whombat-20261123.4/whombat-installer.iso")
		// Without CopyObject the ISO is uploaded next; with it, the checksum is.
		uploaded := strings.HasSuffix(strings.SplitN(changes[1], "\n", 2)[0], "/whombat-installer-v0.1.iso")
		if !copied || noCopy != uploaded {
			t.Fatalf("no copy %v:\n%s", noCopy, strings.Join(w.changes(t), "\n"))
		}
		if w.read(t, "whombat-installer-v0.1.iso") != string(iso) || len(w.files(t)) != 3 {
			t.Fatalf("no copy %v: the site serves %v", noCopy, w.files(t))
		}
	}
}

// --version sets a higher version by hand (v1.0 on John's word); the next follows it. Never one at or below the site's.
func TestUploadISOVersionByHand(t *testing.T) {
	w := newISOWorld(t, "whombat-20261201.1")
	w.mustRun(t, "--production", "--version", "v1.0")
	next := w.on(t, "whombat-20261202.1", "after one\n")
	next.mustRun(t, "--production")
	if l := w.latest(t); l["version"] != "v1.1" || strings.Join(w.files(t), " ") != "installer/latest.json whombat-installer-v1.1.iso whombat-installer-v1.1.iso.sha256" {
		t.Fatalf("latest.json %v, files %v", l, w.files(t))
	}
	sent := len(w.changes(t))
	third := w.on(t, "whombat-20261203.1", "a third\n")
	for _, v := range []string{"v1.1", "v0.9", "1.2", "v1.2.3"} {
		if out, err := third.run(t, "--production", "--version", v); err == nil {
			t.Fatalf("--version %s went up:\n%s", v, out)
		}
	}
	if len(w.changes(t)) != sent {
		t.Fatal("a refused version sent something")
	}
}

// The installer only moves forward (R2 B2): when latest.json names a newer release nothing is sent (exit 3).
func TestUploadISOOnlyForward(t *testing.T) {
	newer := newISOWorld(t, "whombat-20261121.1")
	newer.mustRun(t, "--production")
	older := newer.on(t, "whombat-20261120.13", "an older one\n")
	before := strings.Join(newer.files(t), " ")
	sent := len(newer.changes(t))
	out, err := older.run(t, "--production")
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 3 || !strings.Contains(out, "newer than whombat-20261120.13") ||
		!strings.Contains(out, `"latestKept": "whombat-20261121.1"`) || !strings.Contains(out, `"keptVersion": "v0.1"`) {
		t.Fatalf("an older release's promotion: %v\n%s", err, out)
	}
	if len(newer.changes(t)) != sent || strings.Join(newer.files(t), " ") != before {
		t.Fatal("an older release changed the site")
	}
}

func TestUploadISORefusals(t *testing.T) {
	broken := newISOWorld(t, "whombat-20261120.4")
	write(t, filepath.Join(broken.dir, "iso", "whombat-installer-x86_64.iso"), []byte(strings.Repeat("whombat installeR\n", 1000)), 0o644)
	for name, c := range map[string]struct {
		w    *isoWorld
		args []string
	}{
		"a Beta release":       {newISOWorld(t, "whombat-20261120.2"), nil},
		"a changed ISO":        {broken, []string{"--production"}},
		"a DEV image's id":     {newISOWorld(t, "whombat-dev-20261120.5"), []string{"--production"}},
		"a bucket that isn't":  {newISOWorld(t, "whombat-20261120.6"), []string{"--production", "--bucket", "Not_A_Bucket"}},
		"a plain-http address": {newISOWorld(t, "whombat-20261120.7"), []string{"--production", "--base-url", "http://downloads.example.com"}},
	} {
		if out, err := c.w.run(t, c.args...); err == nil {
			t.Errorf("%s: uploaded\n%s", name, out)
		}
		if len(c.w.calls(t)) != 0 {
			t.Errorf("%s: something was sent", name)
		}
	}

	dry := newISOWorld(t, "whombat-20261120.3")
	dry.oldLayout(t, "whombat-20261120.1", []byte("an installer before"))
	out, err := dry.run(t, "--dry-run", "--production")
	if err != nil || !strings.Contains(out, "would upload installer/latest.json") || !strings.Contains(out, "whombat-installer-v0.1.iso") ||
		!strings.Contains(out, "would wait") {
		t.Fatalf("dry run: %v\n%s", err, out)
	}
	if len(dry.calls(t)) != 0 {
		t.Fatal("a dry run sent something")
	}

	// A latest.json the site can't give, or that names no release: nothing changes.
	for name, c := range map[string]struct {
		body string
		env  []string
	}{
		"not a manifest": {body: "<html>oops</html>"},
		"no release id":  {body: `{"v":2,"releaseId":"latest"}`},
		"no version":     {body: `{"v":2,"releaseId":"whombat-20261101.1","version":"0.3"}`},
		"a 503":          {body: `{"v":2,"releaseId":"whombat-20261101.1"}`, env: []string{"FAKE_STATUS_KEY=installer/latest.json"}},
	} {
		w := newISOWorld(t, "whombat-20261120.19")
		write(t, filepath.Join(w.served, "installer/latest.json"), []byte(c.body), 0o644)
		out, err := w.runWith(t, c.env, "--production")
		if err == nil || !strings.Contains(out, "nothing is changed") {
			t.Fatalf("%s: %v\n%s", name, err, out)
		}
		if len(w.calls(t)) != 0 {
			t.Fatalf("%s: something was sent", name)
		}
	}
}

// The digest decides, not the size (R1 #14): a file of the next version that latest.json doesn't name (left by a run
// that stopped), a checksum file of the same length for another ISO, or a site without ETags: nothing is sent over it.
func TestUploadISOComparesDigests(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.9")
	w.mustRun(t, "--production")
	write(t, filepath.Join(w.served, "whombat-installer-v0.2.iso"), []byte(strings.Repeat("whombat installeR\n", 1000)), 0o644)
	sent := len(w.changes(t))
	next := w.on(t, "whombat-20261120.11", "the next\n")
	out, err := next.run(t, "--production")
	if err == nil || !strings.Contains(out, "never names two installers") {
		t.Fatalf("a stray file under the next version: %v\n%s", err, out)
	}
	if n := len(w.changes(t)); n != sent {
		t.Fatalf("%d files sent over a stray one", n-sent)
	}

	sha := newISOWorld(t, "whombat-20261120.12")
	write(t, filepath.Join(sha.served, "whombat-installer-v0.1.iso.sha256"), []byte(strings.Repeat("0", 64)+"  whombat-installer-v0.1.iso\n"), 0o644)
	if out, err := sha.run(t, "--production"); err == nil || !strings.Contains(out, "whombat-installer-v0.1.iso.sha256") {
		t.Fatalf("a stale checksum file: %v\n%s", err, out)
	}
	if len(sha.changes(t)) != 0 {
		t.Fatal("sent before the stale checksum stopped it")
	}

	noTag := newISOWorld(t, "whombat-20261120.14")
	noTag.mustRun(t, "--production")
	sent = len(noTag.changes(t))
	if out, err := noTag.runWith(t, []string{"FAKE_NO_ETAG=1"}, "--production"); err == nil || !strings.Contains(out, "no digest") {
		t.Fatalf("a site without ETags: %v\n%s", err, out)
	}
	if len(noTag.changes(t)) != sent {
		t.Fatal("sent over a file it couldn't compare")
	}
}

// Until latest.json names the new installer the one before stays whole: a cache still serving another ISO, or a
// latest.json that won't go up, leaves latest.json and the older files as they were; a run again carries on.
func TestUploadISOStopsBeforeLatest(t *testing.T) {
	w := newISOWorld(t, "whombat-20261121.2")
	w.oldLayout(t, "whombat-20261120.5", []byte("an installer before"))
	before := w.read(t, "installer/latest.json")
	out, err := w.runWith(t, []string{"FAKE_STALE=whombat-installer-v0.1.iso"}, "--production")
	if err == nil || !strings.Contains(out, "latest.json is left as it was") {
		t.Fatalf("a stale ISO: %v\n%s", err, out)
	}
	if w.read(t, "installer/latest.json") != before || w.read(t, "installer/latest/whombat-installer.iso") == "" {
		t.Fatal("latest.json moved, or the installer before went, while the site served another ISO")
	}
	out, err = w.runWith(t, []string{"FAKE_FAIL=installer/latest.json", "FAKE_FAIL_TIMES=9"}, "--production")
	if err == nil || !strings.Contains(out, "still names the installer before") {
		t.Fatalf("a latest.json that won't go up: %v\n%s", err, out)
	}
	if w.read(t, "installer/latest.json") != before || w.read(t, "installer/latest/whombat-installer.iso") == "" {
		t.Fatal("latest.json moved, or the installer before went, without the upload")
	}
	os.Remove(filepath.Join(w.served, ".failed"))
	w.mustRun(t, "--production")
	if l := w.latest(t); l["version"] != "v0.1" || len(w.files(t)) != 3 {
		t.Fatalf("a run again: latest.json %v, files %v", l, w.files(t))
	}
}

// After latest.json names the new installer, a removal or a listing that fails stops the run; a run again removes the
// rest and leaves latest.json as it is.
func TestUploadISORemovesTheRestAgain(t *testing.T) {
	w := newISOWorld(t, "whombat-20261121.3")
	w.oldLayout(t, "whombat-20261120.5", []byte("an installer before"))
	out, err := w.runWith(t, []string{"FAKE_FAIL_DELETE=installer/latest/whombat-installer.iso"}, "--production")
	if err == nil || !strings.Contains(out, "run this again to remove the rest") {
		t.Fatalf("a removal that fails: %v\n%s", err, out)
	}
	if l := w.latest(t); l["version"] != "v0.1" {
		t.Fatalf("latest.json %v", l)
	}
	if out, err := w.runWith(t, []string{"FAKE_NO_LIST=1"}, "--production"); err == nil || !strings.Contains(out, "couldn't be listed") {
		t.Fatalf("a listing that fails: %v\n%s", err, out)
	}
	latest := w.read(t, "installer/latest.json")
	w.mustRun(t, "--production")
	if w.read(t, "installer/latest.json") != latest || len(w.files(t)) != 3 {
		t.Fatalf("a run again: files %v", w.files(t))
	}
}
