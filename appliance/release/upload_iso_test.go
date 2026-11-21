// release/upload-iso (Whombat ONE-15) against a stand-in curl that records each upload and its standard input and
// answers HEADs with the served file's MD5 as its ETag: the ISO, its .sha256 and, for a Production release, the same two
// at installer/latest/ (copied on the bucket, else uploaded) and latest.json, in that order; the key only ever on curl's
// standard input; what the site already serves with the same digest isn't sent again, another digest under the same
// release id is refused (R1 #14); latest.json waits until the site serves the four files with their digests; a broken
// ISO, a foreign id or a missing setting stops before any upload.
package release_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The stand-in curl: a HEAD (-sfI) answers from $FAKE_SERVED/<path>'s size; a PUT (-T) is recorded with its standard
// input, the url and the file it would send.
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
if [[ $args == *"-X DELETE"* ]]; then
  for a in "$@"; do case $a in https://r2.example.com/*) rel=${a#https://r2.example.com/whombat-downloads/} ;; esac; done
  n=$(ls "$FAKE_LOG" | wc -l)
  { echo "argv: $args"; echo "stdin: $(cat)"; echo "env: 0"; } >"$FAKE_LOG/$n.call"
  rm -f "$FAKE_SERVED/$rel"
  exit 0
fi
src= dst= copy=
while [ $# -gt 0 ]; do
  case $1 in
    -T) src=$2; shift 2 ;;
    -o | -K | --aws-sigv4 | -X) shift 2 ;;
    -H) case $2 in x-amz-copy-source:*) copy=${2#x-amz-copy-source: /whombat-downloads/} ;; esac; shift 2 ;;
    -*) shift ;;
    *) dst=$1; shift ;;
  esac
done
# An upload that fails FAKE_FAIL_TIMES times for the key FAKE_FAIL names.
if [ -n "${FAKE_FAIL:-}" ] && [[ $dst == *"$FAKE_FAIL" ]]; then
  failed=$(cat "$FAKE_SERVED/.failed" 2>/dev/null || echo 0)
  if [ "$failed" -lt "${FAKE_FAIL_TIMES:-1}" ]; then echo $((failed + 1)) >"$FAKE_SERVED/.failed"; exit 22; fi
fi
n=$(ls "$FAKE_LOG" | wc -l)
{ echo "argv: $args"; echo "stdin: $(cat)"; echo "env: $(env | grep -c -e '^R2_' -e '^AWS_' || true)"; } >"$FAKE_LOG/$n.call"
rel=${dst#https://r2.example.com/whombat-downloads/}
mkdir -p "$(dirname "$FAKE_SERVED/$rel")"
if [ -n "$copy" ]; then
  # A bucket without CopyObject answers 501 (FAKE_NO_COPY).
  [ -z "${FAKE_NO_COPY:-}" ] || exit 22
  cp "$FAKE_SERVED/$copy" "$FAKE_SERVED/$rel"
else
  cp "$src" "$FAKE_SERVED/$rel"
fi
`

type isoWorld struct {
	dir, served, log, bin, creds string
	sha                          string
}

func newISOWorld(t *testing.T, id string) *isoWorld {
	t.Helper()
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("no jq")
	}
	base := t.TempDir()
	w := &isoWorld{dir: filepath.Join(base, id), served: filepath.Join(base, "served"), log: filepath.Join(base, "log"),
		bin: filepath.Join(base, "bin"), creds: filepath.Join(base, "credentials.env")}
	for _, d := range []string{filepath.Join(w.dir, "iso"), w.served, w.log, w.bin} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	iso := []byte(strings.Repeat("whombat installer\n", 1000))
	sum := sha256.Sum256(iso)
	w.sha = hex.EncodeToString(sum[:])
	// The build's own name for its file; the site always says whombat-installer.iso.
	write(t, filepath.Join(w.dir, "iso", "whombat-installer-x86_64.iso"), iso, 0o644)
	meta, _ := json.Marshal(map[string]any{"v": 1, "releaseId": id, "file": "whombat-installer-x86_64.iso", "sha256": w.sha, "size": len(iso)})
	write(t, filepath.Join(w.dir, "iso.json"), meta, 0o644)
	write(t, filepath.Join(w.bin, "curl"), []byte(fakeCurl), 0o755)
	write(t, w.creds, []byte("R2_ENDPOINT=https://r2.example.com\nR2_ACCESS_KEY_ID=made-up-id\nR2_SECRET_ACCESS_KEY=made-up-secret\n"), 0o600)
	return w
}

func write(t *testing.T, p string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(p, b, mode); err != nil {
		t.Fatal(err)
	}
}

func (w *isoWorld) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("./upload-iso", append([]string{w.dir}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+w.bin+":"+os.Getenv("PATH"), "FAKE_SERVED="+w.served, "FAKE_LOG="+w.log,
		"WHOMBAT_R2_CREDENTIALS="+w.creds, "WHOMBAT_INSTALLER_BUCKET=whombat-downloads",
		"WHOMBAT_INSTALLER_BASE_URL=https://downloads.example.com", "TMPDIR="+t.TempDir())
	out, err := cmd.CombinedOutput()
	return string(out), err
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

func TestUploadISOProduction(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.1")
	out, err := w.run(t, "--production")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	calls := w.calls(t)
	if len(calls) != 5 {
		t.Fatalf("%d uploads:\n%s", len(calls), strings.Join(calls, "\n"))
	}
	// The checksum goes to the fixed links before the ISO (R3 B2), latest.json last.
	for i, key := range []string{"installer/whombat-20261120.1/whombat-installer.iso",
		"installer/whombat-20261120.1/whombat-installer.iso.sha256", "installer/latest/whombat-installer.iso.sha256",
		"installer/latest/whombat-installer.iso", "installer/latest.json"} {
		if !strings.Contains(calls[i], "https://r2.example.com/whombat-downloads/"+key) {
			t.Fatalf("upload %d isn't %s:\n%s", i, key, calls[i])
		}
	}
	// The fixed link's ISO is the bucket's copy of the release's own, not a second upload.
	if !strings.Contains(calls[3], "x-amz-copy-source: /whombat-downloads/installer/whombat-20261120.1/whombat-installer.iso") ||
		strings.Contains(calls[3], " -T ") {
		t.Fatalf("the latest ISO wasn't copied on the bucket:\n%s", calls[3])
	}
	for _, key := range []string{"installer/latest/whombat-installer.iso", "installer/latest/whombat-installer.iso.sha256"} {
		got, _ := os.ReadFile(filepath.Join(w.served, key))
		want, _ := os.ReadFile(filepath.Join(w.served, strings.Replace(key, "latest", "whombat-20261120.1", 1)))
		if len(got) == 0 || string(got) != string(want) {
			t.Fatalf("%s isn't the release's own", key)
		}
	}
	for _, c := range calls {
		argv, _, _ := strings.Cut(c, "\nstdin:")
		if strings.Contains(argv, "made-up") || !strings.Contains(c, `stdin: user = "made-up-id:made-up-secret"`) ||
			!strings.Contains(c, "env: 0") || !strings.Contains(argv, "--aws-sigv4 aws:amz:auto:s3") {
			t.Fatalf("the key went elsewhere than curl's standard input:\n%s", c)
		}
	}
	if strings.Contains(out, "made-up") {
		t.Fatalf("the key is in the output:\n%s", out)
	}
	sha, _ := os.ReadFile(filepath.Join(w.served, "installer/whombat-20261120.1/whombat-installer.iso.sha256"))
	if string(sha) != w.sha+"  whombat-installer.iso\n" {
		t.Fatalf(".sha256: %q", sha)
	}
	var latest map[string]any
	b, _ := os.ReadFile(filepath.Join(w.served, "installer/latest.json"))
	if err := json.Unmarshal(b, &latest); err != nil {
		t.Fatal(err)
	}
	if latest["releaseId"] != "whombat-20261120.1" || latest["sha256"] != w.sha || latest["file"] != "whombat-installer.iso" ||
		latest["url"] != "https://downloads.example.com/installer/whombat-20261120.1/whombat-installer.iso" ||
		latest["latestUrl"] != "https://downloads.example.com/installer/latest/whombat-installer.iso" {
		t.Fatalf("latest.json %v", latest)
	}
	// Again: the release's ISO and its .sha256 are there; only the latest/ ones and latest.json go up again.
	if out, err := w.run(t, "--production"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if n := len(w.calls(t)); n != 8 {
		t.Fatalf("a second run sent %d files", n-5)
	}
}

func TestUploadISOWithoutCopy(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.8")
	cmd := exec.Command("./upload-iso", w.dir, "--production")
	cmd.Env = append(os.Environ(), "PATH="+w.bin+":"+os.Getenv("PATH"), "FAKE_SERVED="+w.served, "FAKE_LOG="+w.log,
		"WHOMBAT_R2_CREDENTIALS="+w.creds, "WHOMBAT_INSTALLER_BUCKET=whombat-downloads", "FAKE_NO_COPY=1",
		"WHOMBAT_INSTALLER_BASE_URL=https://downloads.example.com", "TMPDIR="+t.TempDir())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	calls := w.calls(t)
	// Each refused copy, then the file uploaded to the fixed link itself (the checksum first).
	if len(calls) != 7 || !strings.Contains(calls[3], " -T ") || !strings.Contains(calls[5], " -T ") ||
		!strings.HasSuffix(strings.Split(calls[5], "\n")[0], "https://r2.example.com/whombat-downloads/installer/latest/whombat-installer.iso -o /dev/null") {
		t.Fatalf("%d calls:\n%s", len(calls), strings.Join(calls, "\n"))
	}
}

func TestUploadISOBetaAndRefusals(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.2")
	if out, err := w.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if calls := w.calls(t); len(calls) != 2 {
		t.Fatalf("a Beta release sent %d files (no latest/, no latest.json)", len(calls))
	}
	if _, err := os.Stat(filepath.Join(w.served, "installer/latest.json")); err == nil {
		t.Fatal("a Beta release wrote latest.json")
	}
	dry := newISOWorld(t, "whombat-20261120.3")
	if out, err := dry.run(t, "--dry-run", "--production"); err != nil || !strings.Contains(out, "would upload installer/latest.json") {
		t.Fatalf("dry run: %v\n%s", err, out)
	}
	if len(dry.calls(t)) != 0 {
		t.Fatal("a dry run uploaded")
	}

	broken := newISOWorld(t, "whombat-20261120.4")
	write(t, filepath.Join(broken.dir, "iso", "whombat-installer-x86_64.iso"), []byte(strings.Repeat("whombat installeR\n", 1000)), 0o644)
	dev := newISOWorld(t, "whombat-dev-20261120.5")
	for name, c := range map[string]struct {
		w    *isoWorld
		args []string
	}{
		"a changed ISO":        {broken, nil},
		"a DEV image's id":     {dev, nil},
		"a bucket that isn't":  {newISOWorld(t, "whombat-20261120.6"), []string{"--bucket", "Not_A_Bucket"}},
		"a plain-http address": {newISOWorld(t, "whombat-20261120.7"), []string{"--base-url", "http://downloads.example.com"}},
	} {
		if out, err := c.w.run(t, c.args...); err == nil {
			t.Errorf("%s: uploaded\n%s", name, out)
		}
		if len(c.w.calls(t)) != 0 {
			t.Errorf("%s: something was sent", name)
		}
	}
}

func (w *isoWorld) runWith(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("./upload-iso", append([]string{w.dir}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+w.bin+":"+os.Getenv("PATH"), "FAKE_SERVED="+w.served, "FAKE_LOG="+w.log,
		"WHOMBAT_R2_CREDENTIALS="+w.creds, "WHOMBAT_INSTALLER_BUCKET=whombat-downloads",
		"WHOMBAT_INSTALLER_BASE_URL=https://downloads.example.com", "TMPDIR="+t.TempDir(), "UPLOAD_RETRY_DELAY=0")
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// change gives the world's release another ISO of the same size, and its iso.json.
func (w *isoWorld) change(t *testing.T, id string) {
	t.Helper()
	iso := []byte(strings.Repeat("whombat installeR\n", 1000))
	sum := sha256.Sum256(iso)
	w.sha = hex.EncodeToString(sum[:])
	write(t, filepath.Join(w.dir, "iso", "whombat-installer-x86_64.iso"), iso, 0o644)
	meta, _ := json.Marshal(map[string]any{"v": 1, "releaseId": id, "file": "whombat-installer-x86_64.iso", "sha256": w.sha, "size": len(iso)})
	write(t, filepath.Join(w.dir, "iso.json"), meta, 0o644)
}

// The digest decides, not the size (R1 #14): another ISO of the same size under a release id the site has is refused,
// and so is a checksum file of the same length that names another digest; nothing is sent then.
func TestUploadISOComparesDigests(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.9")
	if out, err := w.run(t, "--production"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	sent := len(w.calls(t))
	w.change(t, "whombat-20261120.9")
	out, err := w.run(t, "--production")
	if err == nil || !strings.Contains(out, "never names two installers") {
		t.Fatalf("another ISO under the same release id: %v\n%s", err, out)
	}
	if n := len(w.calls(t)); n != sent {
		t.Fatalf("%d files sent for a refused release", n-sent)
	}

	sha := newISOWorld(t, "whombat-20261120.10")
	// Served already: a checksum file of the same length, for another ISO.
	other := strings.Repeat("0", 64) + "  whombat-installer.iso\n"
	if err := os.MkdirAll(filepath.Join(sha.served, "installer/whombat-20261120.10"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(sha.served, "installer/whombat-20261120.10/whombat-installer.iso.sha256"), []byte(other), 0o644)
	out, err = sha.run(t, "--production")
	if err == nil || !strings.Contains(out, "whombat-installer.iso.sha256") {
		t.Fatalf("a stale checksum file: %v\n%s", err, out)
	}
	if n := len(sha.calls(t)); n != 0 {
		t.Fatalf("%d files sent before the stale checksum stopped it", n)
	}

	noTag := newISOWorld(t, "whombat-20261120.11")
	if out, err := noTag.run(t); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	sent = len(noTag.calls(t))
	if out, err := noTag.runWith(t, []string{"FAKE_NO_ETAG=1"}); err == nil || !strings.Contains(out, "no digest") {
		t.Fatalf("a site without ETags: %v\n%s", err, out)
	}
	if len(noTag.calls(t)) != sent {
		t.Fatal("sent over a file it couldn't compare")
	}
}

// latest.json goes up only once the site serves both latest/ files as they are here: a cache still serving the ISO
// before leaves latest.json as it was.
func TestUploadISOVerifiesLatestFirst(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.12")
	out, err := w.runWith(t, []string{"FAKE_STALE=installer/latest/whombat-installer.iso"}, "--production")
	if err == nil || !strings.Contains(out, "latest.json is left as it was") {
		t.Fatalf("a stale latest ISO: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(w.served, "installer/latest.json")); err == nil {
		t.Fatal("latest.json went up before the site served the latest ISO")
	}
	for _, c := range w.calls(t) {
		if strings.Contains(c, "installer/latest.json") {
			t.Fatal("latest.json was sent")
		}
	}
	// Once the site serves it, the same run finishes.
	if out, err := w.run(t, "--production"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(w.served, "installer/latest.json")); err != nil {
		t.Fatal("no latest.json after the site served the ISO")
	}
}

// The fixed links only move forward and as a pair (R2 B2): a rerun of an older release's promotion leaves them (and
// latest.json) at the newer one; a checksum upload that fails is tried again, and failing still stops the run before
// latest.json.
func TestUploadISOLatestOnlyForward(t *testing.T) {
	w := newISOWorld(t, "whombat-20261120.13")
	// The site's latest is a newer release already.
	newer := []byte(`{"v":1,"releaseId":"whombat-20261121.1","file":"whombat-installer.iso"}`)
	if err := os.MkdirAll(filepath.Join(w.served, "installer", "latest"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(w.served, "installer/latest.json"), newer, 0o644)
	write(t, filepath.Join(w.served, "installer/latest/whombat-installer.iso"), []byte("the newer ISO"), 0o644)
	out, err := w.run(t, "--production")
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 3 || !strings.Contains(out, "newer than whombat-20261120.13") {
		t.Fatalf("an older release's promotion: %v\n%s", err, out)
	}
	for _, c := range w.calls(t) {
		if strings.Contains(c, "installer/latest") {
			t.Fatalf("the fixed links moved back:\n%s", c)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(w.served, "installer/latest.json")); string(b) != string(newer) {
		t.Fatal("latest.json changed")
	}
	if _, err := os.Stat(filepath.Join(w.served, "installer/whombat-20261120.13/whombat-installer.iso")); err != nil {
		t.Fatal("the release's own ISO isn't up")
	}

	retried := newISOWorld(t, "whombat-20261120.14")
	if out, err := retried.runWith(t, []string{"FAKE_FAIL=installer/latest/whombat-installer.iso.sha256", "FAKE_FAIL_TIMES=1"}, "--production"); err != nil {
		t.Fatalf("one failed checksum upload: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(retried.served, "installer/latest.json")); err != nil {
		t.Fatal("no latest.json after the retried checksum")
	}

	stuck := newISOWorld(t, "whombat-20261120.15")
	out, err = stuck.runWith(t, []string{"FAKE_FAIL=installer/latest/whombat-installer.iso.sha256", "FAKE_FAIL_TIMES=9"}, "--production")
	if err == nil || !strings.Contains(out, "failed three times") {
		t.Fatalf("a checksum upload that keeps failing: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(stuck.served, "installer/latest.json")); err == nil {
		t.Fatal("latest.json went up with the checksum missing")
	}
	// Once uploads go through again, the same run puts the pair right, then latest.json.
	os.Remove(filepath.Join(stuck.served, ".failed"))
	if out, err := stuck.run(t, "--production"); err != nil {
		t.Fatalf("again: %v\n%s", err, out)
	}
	sum, _ := os.ReadFile(filepath.Join(stuck.served, "installer/latest/whombat-installer.iso.sha256"))
	if !strings.HasPrefix(string(sum), stuck.sha) {
		t.Fatalf("the fixed checksum %q isn't the ISO's", sum)
	}
}

// The fixed pair is swapped checksum first, then the ISO, and a step that fails puts the previous release's pair back
// (or removes the fixed files when there was none): the two fixed links never name different ISOs (R3 B2). A
// latest.json the site can't give, or that names no release, stops the run before anything changes.
func TestUploadISOSwapsThePairOrPutsItBack(t *testing.T) {
	prev := newISOWorld(t, "whombat-20261120.16")
	if out, err := prev.run(t, "--production"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	read := func(w *isoWorld, key string) string {
		b, _ := os.ReadFile(filepath.Join(w.served, key))
		return string(b)
	}
	before := map[string]string{}
	for _, k := range []string{"installer/latest/whombat-installer.iso", "installer/latest/whombat-installer.iso.sha256", "installer/latest.json"} {
		before[k] = read(prev, k)
	}
	// The next release, on the same site: its ISO won't go to the fixed link (the copy and the upload fail).
	next := &isoWorld{dir: filepath.Join(filepath.Dir(prev.dir), "whombat-20261120.17"), served: prev.served, log: prev.log,
		bin: prev.bin, creds: prev.creds}
	if err := os.MkdirAll(filepath.Join(next.dir, "iso"), 0o755); err != nil {
		t.Fatal(err)
	}
	next.change(t, "whombat-20261120.17")
	out, err := next.runWith(t, []string{"FAKE_FAIL=installer/latest/whombat-installer.iso", "FAKE_FAIL_TIMES=99"}, "--production")
	if err == nil || !strings.Contains(out, "whombat-20261120.16's again") {
		t.Fatalf("a failed ISO swap: %v\n%s", err, out)
	}
	for k, v := range before {
		if read(prev, k) != v {
			t.Fatalf("%s isn't the previous release's after the failed swap", k)
		}
	}
	if _, err := os.Stat(filepath.Join(prev.served, "installer/whombat-20261120.17/whombat-installer.iso")); err != nil {
		t.Fatal("the new release's own ISO isn't up")
	}

	// Both swapped, then latest.json fails: both go back.
	out, err = next.runWith(t, []string{"FAKE_FAIL=installer/latest.json", "FAKE_FAIL_TIMES=99"}, "--production")
	if err == nil || !strings.Contains(out, "whombat-20261120.16's again") || !strings.Contains(out, "copied installer/whombat-20261120.17/whombat-installer.iso to") {
		t.Fatalf("a failed latest.json after the swap: %v\n%s", err, out)
	}
	for k, v := range before {
		if read(prev, k) != v {
			t.Fatalf("%s isn't the previous release's after the failed latest.json", k)
		}
	}
	os.Remove(filepath.Join(prev.served, ".failed"))

	// No previous release: the fixed files go rather than disagree.
	first := newISOWorld(t, "whombat-20261120.18")
	out, err = first.runWith(t, []string{"FAKE_FAIL=installer/latest/whombat-installer.iso", "FAKE_FAIL_TIMES=99"}, "--production")
	if err == nil || !strings.Contains(out, "the fixed links are removed") {
		t.Fatalf("a failed first swap: %v\n%s", err, out)
	}
	for _, k := range []string{"installer/latest/whombat-installer.iso", "installer/latest/whombat-installer.iso.sha256", "installer/latest.json"} {
		if _, err := os.Stat(filepath.Join(first.served, k)); err == nil {
			t.Fatalf("%s is served after a failed first swap", k)
		}
	}

	// A latest.json the site can't give, or one that names no release: nothing at the fixed links changes.
	for name, c := range map[string]struct {
		body string
		env  []string
	}{
		"not a manifest": {body: "<html>oops</html>"},
		"no release id":  {body: `{"v":1,"releaseId":"latest"}`},
		"a 503":          {body: `{"v":1,"releaseId":"whombat-20261101.1"}`, env: []string{"FAKE_STATUS_KEY=installer/latest.json"}},
	} {
		w := newISOWorld(t, "whombat-20261120.19")
		if err := os.MkdirAll(filepath.Join(w.served, "installer"), 0o755); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(w.served, "installer/latest.json"), []byte(c.body), 0o644)
		out, err := w.runWith(t, c.env, "--production")
		if err == nil || !strings.Contains(out, "the fixed links are left as they are") {
			t.Fatalf("%s: %v\n%s", name, err, out)
		}
		for _, call := range w.calls(t) {
			if strings.Contains(call, "installer/latest") {
				t.Fatalf("%s: the fixed links changed:\n%s", name, call)
			}
		}
	}
}
