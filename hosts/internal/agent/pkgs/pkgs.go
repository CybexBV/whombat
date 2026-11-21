// Package pkgs lists pending package updates from the package manager's
// local cache (apt, dnf/yum, zypper, apk, pacman; on a Mac softwareupdate's
// last scan). It never refreshes the
// package lists itself. The host collector reports the counts every 6
// hours; the inspect RPC returns the list on demand.
package pkgs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"rackoon/internal/agent/macos"
	"rackoon/internal/proto"
)

// ErrUnsupported is returned when no known package manager is present.
var ErrUnsupported = errors.New("no supported package manager")

// Package managers.
const (
	APT    = "apt"
	DNF    = "dnf"
	YUM    = "yum"
	Zypper = "zypper"
	APK    = "apk"
	Pacman = "pacman"
	// SoftwareUpdate is macOS's softwareupdate (install.go, macos.go).
	SoftwareUpdate = "softwareupdate"
)

// Result is one check of the package manager's cache.
type Result struct {
	Manager string
	Updates []proto.PackageUpdate // sorted: security first, then by name
	// SecurityKnown: the manager tells which updates are security fixes
	// (apt from the origin, dnf/yum from updateinfo). Otherwise Security
	// is false everywhere and the count is unknown.
	SecurityKnown bool
}

// Security returns the number of security updates.
func (r *Result) Security() int {
	n := 0
	for _, u := range r.Updates {
		if u.Security {
			n++
		}
	}
	return n
}

// List returns the package manager ("apt", "dnf", ...) and its pending
// updates (Security set where the manager tells).
func List(ctx context.Context) (manager string, updates []proto.PackageUpdate, err error) {
	r, err := Check(ctx)
	if r == nil {
		return "", nil, err
	}
	return r.Manager, r.Updates, err
}

// Detect returns the host's package manager, or "" when none is known.
// On Unraid (Slackware without a package database the agent can use) and
// NixOS there is none.
func Detect() string {
	if runtime.GOOS == "darwin" {
		if exists(macos.SoftwareUpdate) {
			return SoftwareUpdate
		}
		return ""
	}
	if exists("/etc/unraid-version") || exists("/etc/NIXOS") {
		return ""
	}
	switch {
	case have("apt-get") && exists("/var/lib/dpkg/status"):
		return APT
	case have("dnf"):
		return DNF
	case have("yum"):
		return YUM
	case have("zypper"):
		return Zypper
	case have("apk") && exists("/lib/apk/db/installed"):
		return APK
	case have("pacman") && exists("/var/lib/pacman/local"):
		return Pacman
	}
	return ""
}

// Check runs the package manager's own "what would be upgraded" query
// against its cached package lists.
func Check(ctx context.Context) (*Result, error) {
	m := Detect()
	if m == "" {
		return nil, ErrUnsupported
	}
	r := &Result{Manager: m}
	var err error
	switch m {
	case APT:
		var out []byte
		out, err = run(ctx, 2*time.Minute, "apt-get", "-s", "-q",
			"-o", "Debug::NoLocking=1", "-o", "APT::Get::Show-User-Simulation-Note=false", "dist-upgrade")
		if err == nil {
			r.Updates = ParseAptSimulate(out)
			r.SecurityKnown = true
		}
	case DNF, YUM:
		r.Updates, err = checkRPM(ctx, m)
		if err == nil {
			r.SecurityKnown = markRPMSecurity(ctx, m, r.Updates)
		}
	case Zypper:
		var out []byte
		out, err = run(ctx, 2*time.Minute, "zypper", "--non-interactive", "--no-refresh", "list-updates")
		if err == nil {
			r.Updates = ParseZypper(out)
		}
	case APK:
		var out []byte
		out, err = run(ctx, time.Minute, "apk", "--no-network", "version", "-l", "<")
		if err == nil {
			r.Updates = ParseAPK(out)
		}
	case SoftwareUpdate:
		// What softwareupdate's last scan found: no network call.
		var l []macos.ListedUpdate
		l, err = macos.ListUpdates(ctx, false)
		if err == nil {
			r.Updates = macos.PackageUpdates(l)
			r.SecurityKnown = true
		}
	case Pacman:
		var out []byte
		out, err = run(ctx, time.Minute, "pacman", "-Qu")
		// pacman -Qu exits 1 when nothing is upgradable.
		if err != nil && exitCode(err) == 1 && len(strings.TrimSpace(string(out))) == 0 {
			err = nil
		}
		if err == nil {
			r.Updates = ParsePacman(out)
		}
	}
	if err != nil {
		return r, err
	}
	sortUpdates(r.Updates)
	return r, nil
}

func sortUpdates(u []proto.PackageUpdate) {
	sort.SliceStable(u, func(i, j int) bool {
		if u[i].Security != u[j].Security {
			return u[i].Security
		}
		return u[i].Name < u[j].Name
	})
}

// checkRPM runs `dnf|yum check-update` from the cache. Exit status 100
// means "updates available", 0 "none".
func checkRPM(ctx context.Context, m string) ([]proto.PackageUpdate, error) {
	out, err := run(ctx, 2*time.Minute, m, "--cacheonly", "--quiet", "check-update")
	if err != nil && exitCode(err) != 100 {
		return nil, err
	}
	return ParseCheckUpdate(out), nil
}

// markRPMSecurity flags security updates from `updateinfo list security`
// (cache only). It reports whether that worked.
func markRPMSecurity(ctx context.Context, m string, ups []proto.PackageUpdate) bool {
	if len(ups) == 0 {
		return true
	}
	out, err := run(ctx, time.Minute, m, "--cacheonly", "--quiet", "updateinfo", "list", "--security")
	if err != nil {
		return false
	}
	sec := ParseUpdateinfo(out)
	for i := range ups {
		if sec[ups[i].Name] {
			ups[i].Security = true
		}
	}
	return true
}

// ---- parsers -------------------------------------------------------------------

// ParseAptSimulate parses `apt-get -s dist-upgrade`:
//
//	Inst chromium [154.0-1~deb13u1] (155.0-1~deb13u1 Debian-Security:13/stable-security [amd64]) []
//
// Packages that would be newly installed (no current version) are
// dependencies of upgrades, not updates themselves, and are skipped.
func ParseAptSimulate(b []byte) []proto.PackageUpdate {
	var out []proto.PackageUpdate
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "Inst ")
		if !ok {
			continue
		}
		name, rest, _ := strings.Cut(rest, " ")
		rest = strings.TrimSpace(rest)
		if !strings.HasPrefix(rest, "[") {
			continue // new install
		}
		cur, rest, ok := strings.Cut(rest[1:], "]")
		if !ok {
			continue
		}
		i := strings.Index(rest, "(")
		j := strings.LastIndex(rest, ")")
		if i < 0 || j < i {
			continue
		}
		inner := rest[i+1 : j]
		if k := strings.LastIndex(inner, " ["); k >= 0 { // architecture
			inner = inner[:k]
		}
		newVer, origins, _ := strings.Cut(inner, " ")
		u := proto.PackageUpdate{Name: name, Current: cur, New: newVer}
		for n, o := range strings.Split(origins, ", ") {
			o = strings.TrimSpace(o)
			if n == 0 {
				u.Source = o
			}
			if isSecurityOrigin(o) {
				u.Security = true
				u.Source = o
			}
		}
		out = append(out, u)
	}
	return out
}

// isSecurityOrigin: "Debian-Security:13/stable-security",
// "Ubuntu:24.04/noble-security", "Debian:12/oldstable-security".
func isSecurityOrigin(o string) bool {
	l := strings.ToLower(o)
	return strings.Contains(l, "-security") || strings.HasPrefix(l, "debian-security")
}

// ParseCheckUpdate parses `dnf check-update` / `yum check-update`:
//
//	kernel.x86_64          6.11.5-300.fc41        updates
//
// The list ends at "Obsoleting Packages"; repository metadata lines and
// blank lines are skipped. dnf does not print the installed version.
func ParseCheckUpdate(b []byte) []proto.PackageUpdate {
	var out []proto.PackageUpdate
	seen := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "Obsoleting") || strings.HasPrefix(t, "Security:") {
			break
		}
		f := strings.Fields(t)
		if len(f) != 3 || strings.HasSuffix(t, ":") {
			continue
		}
		dot := strings.LastIndex(f[0], ".")
		if dot <= 0 || !strings.ContainsAny(f[1], "0123456789") {
			continue
		}
		name := f[0][:dot]
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, proto.PackageUpdate{Name: name, New: f[1], Source: f[2]})
	}
	return out
}

// ParseUpdateinfo parses `dnf updateinfo list --security`:
//
//	FEDORA-2026-1a2b3c  Important/Sec.  openssl-libs-1:3.2.2-9.fc41.x86_64
//
// and returns the package names it mentions.
func ParseUpdateinfo(b []byte) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		if name := rpmName(f[len(f)-1]); name != "" {
			out[name] = true
		}
	}
	return out
}

// rpmName extracts the name from "openssl-libs-1:3.2.2-9.fc41.x86_64"
// (NAME-[EPOCH:]VERSION-RELEASE.ARCH).
func rpmName(nevra string) string {
	if dot := strings.LastIndex(nevra, "."); dot > 0 {
		nevra = nevra[:dot] // arch
	}
	i := strings.LastIndex(nevra, "-") // release
	if i <= 0 {
		return ""
	}
	j := strings.LastIndex(nevra[:i], "-") // version
	if j <= 0 {
		return ""
	}
	return nevra[:j]
}

// ParseZypper parses `zypper list-updates`:
//
//	S | Repository | Name | Current Version | Available Version | Arch
//	--+------------+------+-----------------+-------------------+-------
//	v | repo-oss   | curl | 8.6.0-1.1       | 8.6.0-2.1         | x86_64
func ParseZypper(b []byte) []proto.PackageUpdate {
	var out []proto.PackageUpdate
	header := false
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.Contains(line, "|") {
			continue
		}
		f := strings.Split(line, "|")
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		if !header {
			if len(f) >= 5 && f[2] == "Name" {
				header = true
			}
			continue
		}
		if len(f) < 5 || strings.HasPrefix(f[0], "--") || f[2] == "" {
			continue
		}
		out = append(out, proto.PackageUpdate{Name: f[2], Current: f[3], New: f[4], Source: f[1]})
	}
	return out
}

// ParseAPK parses `apk version -l '<'`:
//
//	Installed:                                Available:
//	busybox-1.36.1-r15                      < 1.36.1-r19
func ParseAPK(b []byte) []proto.PackageUpdate {
	var out []proto.PackageUpdate
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || f[1] != "<" {
			continue
		}
		name, cur := splitAPKVersion(f[0])
		if name == "" {
			continue
		}
		out = append(out, proto.PackageUpdate{Name: name, Current: cur, New: f[2]})
	}
	return out
}

// splitAPKVersion splits "py3-foo-1.2.3-r0" into "py3-foo" and "1.2.3-r0".
func splitAPKVersion(s string) (name, version string) {
	r := strings.LastIndex(s, "-r")
	if r <= 0 {
		return "", ""
	}
	v := strings.LastIndex(s[:r], "-")
	if v <= 0 {
		return "", ""
	}
	return s[:v], s[v+1:]
}

// ParsePacman parses `pacman -Qu`: "linux 6.6.1.arch1-1 -> 6.6.2.arch1-1"
// (ignored packages end with "[ignored]" and are skipped).
func ParsePacman(b []byte) []proto.PackageUpdate {
	var out []proto.PackageUpdate
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[2] != "->" || strings.Contains(line, "[ignored]") {
			continue
		}
		out = append(out, proto.PackageUpdate{Name: f[0], Current: f[1], New: f[3]})
	}
	return out
}

// ---- change detection ------------------------------------------------------------

// stampPaths change when packages are installed or the lists refreshed.
var stampPaths = map[string][]string{
	APT:    {"/var/lib/dpkg/status", "/var/lib/apt/lists", "/var/cache/apt/pkgcache.bin"},
	DNF:    {"/var/lib/rpm", "/var/lib/dnf", "/var/cache/dnf", "/var/cache/libdnf5"},
	YUM:    {"/var/lib/rpm", "/var/lib/yum", "/var/cache/yum"},
	Zypper: {"/var/lib/rpm", "/var/cache/zypp/raw"},
	APK:    {"/lib/apk/db/installed", "/var/cache/apk"},
	Pacman: {"/var/lib/pacman/local", "/var/lib/pacman/sync"},
}

// Stamp returns a value that changes when the package database or the
// cached package lists of manager change (an upgrade, `apt update`), so
// the caller can re-check before the 6-hour interval. It only stats files.
func Stamp(manager string) string {
	var b strings.Builder
	for _, p := range stampPaths[manager] {
		if st, err := os.Stat(p); err == nil {
			fmt.Fprintf(&b, "%s=%d;", p, st.ModTime().UnixNano())
		}
	}
	return b.String()
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func have(name string) bool {
	_, err := lookPath(name)
	return err == nil
}
