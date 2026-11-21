package pkgs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"syscall"

	"github.com/pelletier/go-toml/v2"

	"rackoon/internal/agent/macos"
)

// Installing updates (docs/MANAGE.md 2.9, Whombat SWU-01…SWU-06): the
// command lines each package manager runs for packages.check and
// packages.install. The agent never changes repositories, never starts a
// release upgrade and never touches held packages; changed configuration
// files keep the local version.

// Package task operations.
const (
	OpCheck   = "check"
	OpInstall = "install"
)

// Step is one command of a package task.
type Step struct {
	// Kind: "repair" (finish an interrupted dpkg run), "refresh" (the
	// package lists) or "upgrade".
	Kind string
	Argv []string
	// Stdin is the step's input (softwareupdate's --stdinpass); nil:
	// stdin is closed. Never logged.
	Stdin []byte
}

// Step kinds.
const (
	StepRepair  = "repair"
	StepRefresh = "refresh"
	StepUpgrade = "upgrade"
)

// Host is what a plan depends on besides the operation.
type Host struct {
	// Tumbleweed: openSUSE Tumbleweed or Slowroll, which update with
	// `zypper dup`, not `zypper update`.
	Tumbleweed bool
	// DpkgInterrupted: an earlier dpkg run stopped halfway; it is finished
	// (`dpkg --configure -a`) before installing.
	DpkgInterrupted bool
	// AppleSilicon: softwareupdate takes an owner's name and password
	// (--user, --stdinpass) to install updates that restart the Mac.
	AppleSilicon bool
	// ScreenUser and ScreenPassword: the Mac's screen account
	// (screen.toml), that owner.
	ScreenUser, ScreenPassword string
}

// LockWait is how long a package task waits for another program's package
// lock before it gives up (SWU-04).
const LockWait = 120

// Env is the environment of every package command: no prompts (keep the
// local configuration files), services restarted automatically
// (needrestart), the C locale for the output the agent reads.
var Env = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/root",
	"LC_ALL=C",
	"TERM=dumb",
	"DEBIAN_FRONTEND=noninteractive",
	"NEEDRESTART_MODE=a",
	"APT_LISTCHANGES_FRONTEND=none",
	"UCF_FORCE_CONFFOLD=1",
	fmt.Sprintf("ZYPP_LOCK_TIMEOUT=%d", LockWait),
}

// aptOpts are apt-get's options for every command that installs.
var aptOpts = []string{"-q", "-y", "-o", fmt.Sprintf("DPkg::Lock::Timeout=%d", LockWait),
	"-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"}

// PackageNameRe is a package name packages.install accepts (any manager's
// names, an apt architecture suffix, an epoch).
var PackageNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`)

// ErrNamedPacman: pacman installs every update together (a partial upgrade
// breaks Arch).
var ErrNamedPacman = errors.New("pacman updates everything together")

// Plan returns the steps of a package task. op is OpCheck or OpInstall;
// packages (install only) limits the install to those names.
func Plan(manager, op string, packages []string, h Host) ([]Step, error) {
	if op != OpCheck && op != OpInstall {
		return nil, fmt.Errorf("unknown package operation %q", op)
	}
	if op == OpCheck && len(packages) > 0 {
		return nil, errors.New("a check takes no package names")
	}
	nameOK := PackageNameRe.MatchString
	if manager == SoftwareUpdate {
		nameOK = macos.LabelRe.MatchString
	}
	for _, p := range packages {
		if !nameOK(p) {
			return nil, fmt.Errorf("%q is not a package name", p)
		}
	}
	var steps []Step
	add := func(kind string, argv ...string) { steps = append(steps, Step{Kind: kind, Argv: argv}) }
	install := op == OpInstall
	switch manager {
	case APT:
		if install && h.DpkgInterrupted {
			add(StepRepair, "dpkg", "--force-confdef", "--force-confold", "--configure", "-a")
		}
		add(StepRefresh, "apt-get", "-q", "-o", fmt.Sprintf("DPkg::Lock::Timeout=%d", LockWait), "update")
		if install {
			// dist-upgrade, never upgrade (Proxmox's rule); named packages
			// only if installed (--only-upgrade).
			argv := append([]string{"apt-get"}, aptOpts...)
			if len(packages) == 0 {
				argv = append(argv, "dist-upgrade")
			} else {
				argv = append(append(argv, "install", "--only-upgrade"), packages...)
			}
			add(StepUpgrade, argv...)
		}
	case DNF, YUM:
		if manager == DNF {
			add(StepRefresh, "dnf", "-y", "--refresh", "makecache")
		} else {
			add(StepRefresh, "yum", "-y", "makecache")
		}
		if install {
			verb := "upgrade"
			if manager == YUM {
				verb = "update"
			}
			add(StepUpgrade, append([]string{manager, "-y", verb}, packages...)...)
		}
	case Zypper:
		add(StepRefresh, "zypper", "--non-interactive", "refresh")
		if install {
			switch {
			case len(packages) > 0:
				add(StepUpgrade, append([]string{"zypper", "--non-interactive", "update", "--auto-agree-with-licenses", "--"}, packages...)...)
			case h.Tumbleweed:
				add(StepUpgrade, "zypper", "--non-interactive", "dup", "--auto-agree-with-licenses")
			default:
				add(StepUpgrade, "zypper", "--non-interactive", "update", "--auto-agree-with-licenses")
			}
		}
	case APK:
		wait := []string{"apk", "--wait", fmt.Sprint(LockWait), "--no-progress"}
		add(StepRefresh, append(wait[:len(wait):len(wait)], "update")...)
		if install {
			add(StepUpgrade, append(append(wait[:len(wait):len(wait)], "upgrade"), packages...)...)
		}
	case SoftwareUpdate:
		// A check asks Apple's servers (the one network call, made only
		// when someone asks); an install takes what that scan found. The
		// agent never adds --restart (the person restarts the Mac when it
		// suits them) or accepts a licence for them.
		if !install {
			add(StepRefresh, macos.SoftwareUpdate, "--list")
			break
		}
		argv := []string{macos.SoftwareUpdate, "--install"}
		if len(packages) == 0 {
			argv = append(argv, "--all")
		} else {
			argv = append(argv, packages...)
		}
		st := Step{Kind: StepUpgrade}
		if h.AppleSilicon && h.ScreenUser != "" && h.ScreenPassword != "" {
			argv = append(argv, "--user", h.ScreenUser, "--stdinpass")
			st.Stdin = []byte(h.ScreenPassword + "\n")
		}
		st.Argv = argv
		steps = append(steps, st)
	case Pacman:
		// No safe refresh without upgrading: a check reads the cache again.
		if install {
			if len(packages) > 0 {
				return nil, ErrNamedPacman
			}
			add(StepUpgrade, "pacman", "-Syu", "--noconfirm", "--noprogressbar")
		}
	default:
		return nil, ErrUnsupported
	}
	return steps, nil
}

// ---- the host -------------------------------------------------------------------------

// IsTrueNAS: TrueNAS installs its updates itself (its apt is switched off).
func IsTrueNAS() bool {
	return exists("/etc/truenas") || have("midclt")
}

// IsNixOS: NixOS is updated by its configuration (Whombat's appliance by
// its releases).
func IsNixOS() bool { return exists("/etc/NIXOS") }

// IsUnraid: Unraid has no package manager the agent uses.
func IsUnraid() bool { return exists("/etc/unraid-version") }

// HostOf reads what a plan needs to know about this host.
func HostOf(manager string) Host {
	var h Host
	switch manager {
	case Zypper:
		h.Tumbleweed = isTumbleweed(readFile("/etc/os-release"))
	case APT:
		h.DpkgInterrupted = dirHasFiles("/var/lib/dpkg/updates")
	case SoftwareUpdate:
		h.AppleSilicon = runtime.GOARCH == "arm64"
	}
	return h
}

// ScreenFile is the Mac's screen account in the agent's configuration
// directory: `user = "…"` and `password = "…"`, root's only (0600). The
// screen part of the agent writes it; package tasks only read it.
const ScreenFile = "screen.toml"

// ReadScreenAccount reads it from configDir. It must be a regular file
// that only root can read; anything else is ignored.
func ReadScreenAccount(configDir string) (user, password string, err error) {
	p := filepath.Join(configDir, ScreenFile)
	st, err := os.Lstat(p)
	if err != nil {
		return "", "", err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		return "", "", fmt.Errorf("%s must be a file only root can read", p)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys.Uid != 0 && os.Geteuid() == 0 {
		return "", "", fmt.Errorf("%s must belong to root", p)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", "", err
	}
	var a struct {
		User     string `toml:"user"`
		Password string `toml:"password"`
	}
	if err := toml.Unmarshal(b, &a); err != nil {
		return "", "", fmt.Errorf("%s: not readable", p)
	}
	if !screenUserRe.MatchString(a.User) || a.Password == "" || strings.ContainsAny(a.Password, "\n\r\x00") {
		return "", "", fmt.Errorf("%s: no usable account", p)
	}
	return a.User, a.Password, nil
}

// screenUserRe is a macOS short user name.
var screenUserRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)

// isTumbleweed reads os-release: ID opensuse-tumbleweed or
// opensuse-slowroll.
func isTumbleweed(osRelease string) bool {
	for _, line := range strings.Split(osRelease, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok && k == "ID" {
			v = strings.Trim(v, `"'`)
			return v == "opensuse-tumbleweed" || v == "opensuse-slowroll"
		}
	}
	return false
}

func readFile(p string) string {
	b, _ := os.ReadFile(p)
	return string(b)
}

func dirHasFiles(p string) bool {
	ents, err := os.ReadDir(p)
	return err == nil && len(ents) > 0
}

// ---- reading the output ----------------------------------------------------------------

// EnterpriseWarning is SWU-06's sentence.
const EnterpriseWarning = "The Proxmox enterprise repository refused (it needs a subscription); the other repositories were used."

// RefreshOutcome reads `apt-get update`'s output. A Proxmox enterprise
// repository that refuses with 401 (no subscription) is a warning when
// every other repository answered; any other failure is the line to stop
// with (apt's own last error line).
func RefreshOutcome(out string, exit int) (warning, failure string) {
	enterprise := false
	var errs []string
	lines := strings.Split(out, "\n")
	for i, raw := range lines {
		l := strings.TrimSpace(raw)
		if l == "" {
			continue
		}
		mentions := strings.Contains(l, "enterprise.proxmox.com")
		if mentions {
			next := ""
			if i+1 < len(lines) {
				next = lines[i+1]
			}
			if has401(l) || (strings.HasPrefix(l, "Err:") && has401(next)) {
				enterprise = true
			}
		}
		msg, isErr := aptError(l)
		if !isErr {
			continue
		}
		if mentions || aptGenericError(msg) {
			continue
		}
		errs = append(errs, l)
	}
	if enterprise {
		warning = EnterpriseWarning
	}
	if exit == 0 {
		return warning, ""
	}
	if len(errs) > 0 {
		return warning, errs[len(errs)-1]
	}
	if enterprise {
		return warning, ""
	}
	return "", LastLine(out)
}

var http401Re = regexp.MustCompile(`(^|\s)401(\s|$)`)

func has401(s string) bool { return http401Re.MatchString(s) }

// aptError returns the message of an error line ("E: …", apt 3's
// "Error: …").
func aptError(l string) (string, bool) {
	for _, p := range []string{"E: ", "Error: "} {
		if m, ok := strings.CutPrefix(l, p); ok {
			return m, true
		}
	}
	return "", false
}

// aptGenericError: lines apt adds after a repository failed, naming none.
func aptGenericError(msg string) bool {
	return strings.HasPrefix(msg, "Some index files failed to download")
}

// LastLine is the last non-empty line of out (the package manager's own
// words when it fails), preferring an error line.
func LastLine(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	last := ""
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		if last == "" {
			last = l
		}
		if _, ok := aptError(l); ok || strings.HasPrefix(l, "error:") || strings.HasPrefix(l, "ERROR:") || strings.HasPrefix(l, "Error:") {
			return truncate(l, 300)
		}
	}
	return truncate(last, 300)
}

// lockErrors are what the package managers print when another program
// holds their lock.
var lockErrors = []string{
	"Could not get lock",                       // apt
	"Unable to acquire the dpkg frontend lock", // apt
	"Unable to lock directory",                 // apt
	"unable to lock database",                  // pacman, apk
	"Unable to lock database",                  // apk
	"System management is locked",              // zypper
	"another copy is running as pid",           // yum
	"Failed to obtain the transaction lock",    // dnf5
}

// IsLockError: the command failed because another program held the
// package lock.
func IsLockError(out string) bool {
	for _, s := range lockErrors {
		if strings.Contains(out, s) {
			return true
		}
	}
	return false
}

// KeptBackFromOutput is what apt says it kept back ("The following
// packages have been kept back:", apt 3's "Not upgrading:"): held packages
// and upgrades that would remove something, which never count as waiting.
func KeptBackFromOutput(manager, out string) []string {
	if manager != APT {
		return nil
	}
	var names []string
	in := false
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		switch {
		case t == "The following packages have been kept back:" || t == "Not upgrading:":
			in = true
			continue
		case in && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && t != "":
			for _, n := range strings.Fields(t) {
				if PackageNameRe.MatchString(n) && !slices.Contains(names, n) {
					names = append(names, n)
				}
			}
			continue
		}
		in = false
	}
	return names
}

// pacmanCountRe: pacman's "Packages (12) linux-6.6.2.arch1-1 …" line.
var pacmanCountRe = regexp.MustCompile(`(?m)^Packages \((\d+)\)`)

// InstalledFromOutput is the number of packages an upgrade step says it
// put in, when the manager prints one the agent can read (pacman; its
// cached list before `-Syu` is older than what it installs). ok is false
// otherwise.
func InstalledFromOutput(manager, out string) (n int, ok bool) {
	if manager != Pacman {
		return 0, false
	}
	m := pacmanCountRe.FindAllStringSubmatch(out, -1)
	if len(m) == 0 {
		return 0, false
	}
	_, err := fmt.Sscan(m[len(m)-1][1], &n)
	return n, err == nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
