package broker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"rackoon/internal/agent/systemdrun"
)

// placeFS writes below a backup place's root.
type placeFS interface {
	mkdirAll(ctx context.Context, path string, mode os.FileMode) error
	// writeFile replaces a file atomically (a temporary file renamed).
	writeFile(ctx context.Context, path string, data []byte, mode os.FileMode) error
	remove(ctx context.Context, path string) error // a missing file is fine
	removeAll(ctx context.Context, path string) error
	// copyTree copies a file or folder to a target that isn't there,
	// keeping modes, times and (as root) owners, synced to disk.
	copyTree(ctx context.Context, src, dst string) error
	// rename renames within one file system.
	rename(ctx context.Context, from, to string) error
}

// directFS writes with the agent's own rights (Unraid, tests).
type directFS struct{}

func (directFS) mkdirAll(_ context.Context, path string, mode os.FileMode) error {
	return os.MkdirAll(path, mode)
}

func (directFS) writeFile(_ context.Context, path string, data []byte, mode os.FileMode) error {
	tmp := path + ".whombat-tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (directFS) remove(_ context.Context, path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (directFS) removeAll(_ context.Context, path string) error { return os.RemoveAll(path) }

func (directFS) copyTree(ctx context.Context, src, dst string) error {
	return copyTreeDirect(ctx, src, dst)
}

func (directFS) rename(_ context.Context, from, to string) error { return os.Rename(from, to) }

// outsideFS writes through a short transient unit (systemd-run): the
// agent's sandbox keeps the file system read-only except its own folders.
// The paths are the manager's own (a checked client name below the root)
// and go in as arguments, the content on standard input.
type outsideFS struct{}

// outsideScript does one file operation: mkdir, write, rm, rmtree, copy
// (cp -a, then sync) or rename; the third argument is a mode or the
// target.
const outsideScript = `set -e
umask 077
op="$1"; path="$2"; mode="$3"
case "$op" in
mkdir) mkdir -p "$path"; chmod "$mode" "$path" ;;
write) tmp="$path.whombat-tmp"; cat > "$tmp"; chmod "$mode" "$tmp"; mv -f "$tmp" "$path" ;;
rm) rm -f -- "$path" ;;
rmtree) rm -rf -- "$path" ;;
copy) cp -a -- "$path" "$3"; sync ;;
rename) mv -T -- "$path" "$3" ;;
*) echo "unknown operation" >&2; exit 2 ;;
esac`

func (f outsideFS) run(ctx context.Context, op, path string, mode os.FileMode, stdin []byte) error {
	return f.runArg(ctx, op, path, fmt.Sprintf("%o", mode), stdin)
}

func (outsideFS) runArg(ctx context.Context, op, path, arg string, stdin []byte) error {
	if op != "copy" {
		// A copy of the backups takes as long as it takes (the move's
		// budget); everything else is quick.
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
	}
	argv := []string{"/usr/bin/systemd-run", "--quiet", "--wait", "--collect", "--pipe", "--service-type=exec",
		"--description=Whombat backup place files", "--"}
	argv = append(argv, systemdrun.Literal("/bin/sh", "-c", outsideScript, "sh", op, path, arg)...)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = baseEnv()
	cmd.Dir = "/"
	cmd.Stdin = bytes.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		if s := strings.TrimSpace(out.String()); s != "" {
			return errors.New(firstLine(s, 200))
		}
		return err
	}
	return nil
}

func (f outsideFS) mkdirAll(ctx context.Context, path string, mode os.FileMode) error {
	if st, err := os.Stat(path); err == nil && st.IsDir() {
		return nil
	}
	return f.run(ctx, "mkdir", path, mode, nil)
}

func (f outsideFS) writeFile(ctx context.Context, path string, data []byte, mode os.FileMode) error {
	return f.run(ctx, "write", path, mode, data)
}

func (f outsideFS) remove(ctx context.Context, path string) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return f.run(ctx, "rm", path, 0, nil)
}

func (f outsideFS) copyTree(ctx context.Context, src, dst string) error {
	return f.runArg(ctx, "copy", filepath.Clean(src), filepath.Clean(dst), nil)
}

func (f outsideFS) rename(ctx context.Context, from, to string) error {
	return f.runArg(ctx, "rename", filepath.Clean(from), filepath.Clean(to), nil)
}

func (f outsideFS) removeAll(ctx context.Context, path string) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return f.run(ctx, "rmtree", filepath.Clean(path), 0, nil)
}

// placeCleanupScript runs in the cleanup container (restic's image, which
// is Alpine: sh, date, sleep, sed, grep, tr, du, ls, wc, awk): restic forgets
// what the person's windows don't keep and prunes, never by count (HS-251,
// BK-09).
// With only the days (a cleanup set before there were windows) it runs once
// a week, the first time a week after it first started; with the windows
// (daily, weekly days, monthly months, limit bytes) once a day. Over the
// limit it forgets with ever shorter windows, never the last 7 days, until
// the backups fit. The next run survives restarts in the status file, which
// is written atomically to /state/<client>.cleanup.json. It sleeps at most an
// hour at a time, so a changed clock or a long suspend doesn't push a run far
// out. Each time it wakes it also tidies the kit user's keys folder
// (/state/<client>.kit/keys): of each Whombat's kit files it keeps the newest
// proto.PlaceKitKeep, newest by when the backup app stored them, since
// anyone may write one there and a date inside could be made up. Only files
// named by a sha256 that are kit records count; nothing else is touched.
const placeCleanupScript = `#!/bin/sh
# Whombat's cleanup of one Whombat's backups on this server.
client="$1"
days="$2"
daily="${3:-0}"
weekly="${4:-0}"
monthly="${5:-0}"
limit="${6:-0}"
repo="/data/$client"
pass="/state/$client.pass"
status="/state/$client.cleanup.json"
kit="/state/$client.kit/keys"
period=604800
keep="$days"
if [ $# -ge 6 ]; then
  period=86400
  keep="$days,$daily,$weekly,$monthly,$limit"
fi
child=""
trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null; fi; exit 0' TERM INT

last_at=""
last_ok=null
last_err=""
over=false
next=""
if [ -f "$status" ]; then
  last_at=$(sed -n 's/.*"last_run_at":"\([^"]*\)".*/\1/p' "$status")
  if grep -q '"last_ok":true' "$status"; then last_ok=true; elif grep -q '"last_ok":false' "$status"; then last_ok=false; fi
  last_err=$(sed -n 's/.*"last_error":"\([^"]*\)".*/\1/p' "$status")
  if grep -q '"over_limit":true' "$status"; then over=true; fi
  next=$(sed -n 's/.*"next_run_epoch":\([0-9][0-9]*\).*/\1/p' "$status")
fi

write_status() {
  if [ -n "$last_at" ]; then at="\"$last_at\""; else at=null; fi
  tmp="$status.tmp"
  if printf '{"keep_within_days":%s,"keep":"%s","running":%s,"last_run_at":%s,"last_ok":%s,"last_error":"%s","over_limit":%s,"next_run_epoch":%s}\n' \
    "$days" "$keep" "$1" "$at" "$last_ok" "$last_err" "$over" "$next" > "$tmp"; then
    mv -f "$tmp" "$status"
  fi
}

# forget KEEP-FLAGS...: one forget and prune; its log in /tmp/cleanup.log.
forget() {
  restic -r "$repo" --password-file "$pass" --no-cache forget --group-by '' "$@" --prune --retry-lock 2h >>/tmp/cleanup.log 2>&1 &
  child=$!
  wait "$child"
  rc=$?
  child=""
  return "$rc"
}

windows() {
  set -- --keep-within "${1}d"
  if [ "$daily" -gt 0 ]; then set -- "$@" --keep-within-daily "${daily}d"; fi
  if [ "$weekly" -gt 0 ]; then set -- "$@" --keep-within-weekly "${weekly}d"; fi
  if [ "$monthly" -gt 0 ]; then set -- "$@" --keep-within-monthly "${monthly}m"; fi
  echo "$@"
}

size() { du -sk "$repo" 2>/dev/null | cut -f1; }

# The kit files: of each Whombat's, the newest 10 by when they were stored (ls -t) stay.
kit_tidy() {
  [ -d "$kit" ] || return 0
  ls -t "$kit" 2>/dev/null | while IFS= read -r name; do
    case "$name" in
      *[!0-9a-f]*) continue ;;
    esac
    [ "${#name}" -eq 64 ] || continue
    f="$kit/$name"
    if [ -L "$f" ] || [ ! -f "$f" ]; then continue; fi
    bytes=$(wc -c <"$f" | tr -d ' ')
    [ "$bytes" -le 65536 ] 2>/dev/null || continue
    grep -q '"kind"[[:space:]]*:[[:space:]]*"whombat\.kit-envelope/1"' "$f" || continue
    app=$(sed -n 's/.*"appliance"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]\{1,128\}\)".*/\1/p' "$f" | head -n 1)
    if [ -n "$app" ]; then printf '%s %s\n' "$app" "$name"; fi
  done | awk -v keep=10 '{ if (++n[$1] > keep) print $2 }' | while IFS= read -r name; do
    rm -f -- "$kit/$name"
  done
}

# Over the limit: ever shorter windows (months 6, 3, none; weeks 4, none; days 7), the last 7 days always kept.
fit() {
  over=false
  [ "$limit" -gt 0 ] || return 0
  for step in m6 m3 m0 w28 w0 d7; do
    used=$(size)
    if [ -n "$used" ] && [ $((used * 1024)) -le "$limit" ]; then return 0; fi
    case "$step" in
      m6) [ "$monthly" -gt 6 ] && monthly=6 || continue ;;
      m3) [ "$monthly" -gt 3 ] && monthly=3 || continue ;;
      m0) [ "$monthly" -gt 0 ] && monthly=0 || continue ;;
      w28) [ "$weekly" -gt 28 ] && weekly=28 || continue ;;
      w0) [ "$weekly" -gt 0 ] && weekly=0 || continue ;;
      d7) [ "$daily" -gt 7 ] && daily=7 || continue ;;
    esac
    all="$days"
    if [ "$all" -lt 7 ]; then all=7; fi
    # shellcheck disable=SC2046
    forget $(windows "$all") || return 1
  done
  used=$(size)
  if [ -n "$used" ] && [ $((used * 1024)) -gt "$limit" ]; then over=true; fi
  return 0
}

now=$(date +%s)
case "$next" in
''|*[!0-9]*) next=$((now + period)) ;;
esac
if [ "$next" -gt $((now + period)) ]; then next=$((now + period)); fi
write_status false

while :; do
  kit_tidy
  now=$(date +%s)
  if [ "$now" -ge "$next" ]; then
    write_status true
    : >/tmp/cleanup.log
    d0="$daily"; w0="$weekly"; m0="$monthly"
    # shellcheck disable=SC2046
    if forget $(windows "$days") && fit; then
      rc=0
    else
      rc=1
    fi
    daily="$d0"; weekly="$w0"; monthly="$m0"
    last_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "$rc" -eq 0 ]; then
      last_ok=true
      last_err=""
    else
      last_ok=false
      last_err=$(grep -v '^$' /tmp/cleanup.log | tail -n 1 | tr -d '\000-\037"\\' | cut -c1-300)
      if [ -z "$last_err" ]; then last_err="restic stopped with an error"; fi
    fi
    now=$(date +%s)
    next=$((now + period))
    write_status false
  fi
  left=$((next - now))
  if [ "$left" -gt 3600 ]; then left=3600; fi
  if [ "$left" -lt 1 ]; then left=1; fi
  sleep "$left" &
  child=$!
  wait "$child"
  child=""
done
`
