package activator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// The cable switched off (Wi-Fi only): a networkd file that sorts before every other wired one matches the wired
// interfaces and gives them nothing: no DHCP, no router advertisements, not even a link-local address. networkd still
// brings each link up, so the box keeps seeing whether a cable is plugged in. Removing the file gives them their usual
// configuration back. The live file is in /run (gone at a restart); the committed copy is in the helper's network state
// and network.nix puts it back before networkd starts, so the setting lasts across restarts and host updates.

// Default places and names of the cable's files and dead-man.
const (
	DefaultCableOffFile    = "/run/systemd/network/05-whombat-cable-off.network"
	DefaultCableRevertUnit = "whombat-cable-revert"
	cableCommittedName     = "cable-off.network"
)

// DefaultWiredMatch is the wired interfaces networkd configures by default (network.nix defaultInterfaceMatch).
var DefaultWiredMatch = []string{"en*", "eth*"}

// A pattern goes into a networkd file the helper writes as root: interface-name characters and globs only.
var wiredPatternRe = regexp.MustCompile(`^[A-Za-z0-9_.*?-]{1,15}$`)

// CableMatch is the wired patterns and the extra interfaces (a committed wired candidate's), checked and without
// repeats.
func CableMatch(patterns, extra []string) ([]string, error) {
	var out []string
	for _, p := range append(slices.Clone(patterns), extra...) {
		if !wiredPatternRe.MatchString(p) {
			return nil, fmt.Errorf("refusing the interface pattern %q", p)
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no wired interfaces to match")
	}
	return out, nil
}

// RenderCableOff is the networkd file that switches the matched interfaces off.
func RenderCableOff(match []string) string {
	return "# The cable is switched off: this Whombat uses Wi-Fi only (whombat-update-helper).\n" +
		"[Match]\nName=" + strings.Join(match, " ") + "\n\n" +
		"[Link]\nRequiredForOnline=no\n\n" +
		"[Network]\nDHCP=no\nIPv6AcceptRA=no\nLinkLocalAddressing=no\nLLMNR=no\nMulticastDNS=no\n"
}

// wiredNames are the interfaces in sysDir/class/net that a pattern matches (for networkctl reconfigure).
func wiredNames(sysDir string, match []string) []string {
	ents, _ := os.ReadDir(filepath.Join(sysDir, "class", "net"))
	var out []string
	for _, e := range ents {
		for _, p := range match {
			if ok, _ := filepath.Match(p, e.Name()); ok {
				out = append(out, e.Name())
				break
			}
		}
	}
	return out
}

func (n *Nix) cableOffFile() string {
	if n.C.CableOffFile != "" {
		return n.C.CableOffFile
	}
	return DefaultCableOffFile
}

func (n *Nix) cableRevertUnit() string {
	if n.C.CableRevertUnit != "" {
		return n.C.CableRevertUnit
	}
	return DefaultCableRevertUnit
}

func (n *Nix) wiredMatch(extra []string) ([]string, error) {
	p := n.C.WiredMatch
	if len(p) == 0 {
		p = DefaultWiredMatch
	}
	return CableMatch(p, extra)
}

// SetCable implements Activator.
func (n *Nix) SetCable(ctx context.Context, off bool, extra []string) error {
	match, err := n.wiredMatch(extra)
	if err != nil {
		return err
	}
	f := n.cableOffFile()
	if off {
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			return err
		}
		if err := atomicfile.WriteFile(f, []byte(RenderCableOff(match)), 0o644); err != nil {
			return err
		}
	} else if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := n.R.Run(ctx, nil, n.C.Networkctl, "reload"); err != nil {
		return err
	}
	// A reload alone leaves a link on the configuration it has; reconfigure applies the new one now.
	sys := n.C.SysDir
	if sys == "" {
		sys = "/sys"
	}
	if names := wiredNames(sys, match); len(names) > 0 {
		if _, err := n.R.Run(ctx, nil, append([]string{n.C.Networkctl, "reconfigure"}, names...)...); err != nil {
			return err
		}
	}
	return nil
}

// CommitCable implements Activator.
func (n *Nix) CommitCable(_ context.Context, off bool, extra []string) error {
	p := n.netState(cableCommittedName)
	if !off {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
		return atomicfile.SyncDir(n.C.NetworkStateDir)
	}
	match, err := n.wiredMatch(extra)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(n.C.NetworkStateDir, 0o700); err != nil {
		return err
	}
	// 0644 like the live file: network.nix installs it into /run/systemd/network as it is.
	return atomicfile.WriteFile(p, []byte(RenderCableOff(match)), 0o644)
}

// CableState implements Activator.
func (n *Nix) CableState(context.Context) (live, committed bool, err error) {
	return present(n.cableOffFile()), present(n.netState(cableCommittedName)), nil
}

func present(p string) bool { _, err := os.Stat(p); return err == nil }

// ArmCableRevert implements Activator: a transient timer running the helper's own cable-revert-deadman, armed before
// a guarded cable change (the Wi-Fi dead-man's pattern). A timer left from an earlier change is stopped first.
func (n *Nix) ArmCableRevert(ctx context.Context, seconds int) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.cableRevertUnit()+".timer")
	_, err := n.R.Run(ctx, nil, n.C.SystemdRun, "--unit="+n.cableRevertUnit(), "--collect",
		"--on-active="+strconv.Itoa(seconds), n.C.HelperBinary, "cable-revert-deadman")
	return err
}

// DisarmCableRevert implements Activator.
func (n *Nix) DisarmCableRevert(ctx context.Context) error {
	_, _ = n.R.Run(ctx, nil, n.C.Systemctl, "stop", "--", n.cableRevertUnit()+".timer")
	return nil
}

// The fake keeps network/cable-live, network/cable-committed (the rendered files) and network/cable-deadman.

// SetCable implements Activator.
func (f *Fake) SetCable(_ context.Context, off bool, extra []string) error {
	if err := f.fail("cable-set"); err != nil {
		return err
	}
	match, err := CableMatch(DefaultWiredMatch, extra)
	if err != nil {
		return err
	}
	if off {
		if err := atomicfile.WriteFile(f.netPath("cable-live"), []byte(RenderCableOff(match)), 0o644); err != nil {
			return err
		}
	} else {
		_ = os.Remove(f.netPath("cable-live"))
	}
	f.event("cable-set off=%v", off)
	return nil
}

// CommitCable implements Activator.
func (f *Fake) CommitCable(_ context.Context, off bool, extra []string) error {
	if err := f.fail("cable-commit"); err != nil {
		return err
	}
	match, err := CableMatch(DefaultWiredMatch, extra)
	if err != nil {
		return err
	}
	if off {
		if err := atomicfile.WriteFile(f.netPath("cable-committed"), []byte(RenderCableOff(match)), 0o644); err != nil {
			return err
		}
	} else {
		_ = os.Remove(f.netPath("cable-committed"))
	}
	f.event("cable-commit off=%v", off)
	return nil
}

// CableState implements Activator.
func (f *Fake) CableState(context.Context) (live, committed bool, err error) {
	return present(f.netPath("cable-live")), present(f.netPath("cable-committed")), nil
}

// ArmCableRevert implements Activator.
func (f *Fake) ArmCableRevert(_ context.Context, seconds int) error {
	if err := f.fail("cable-arm"); err != nil {
		return err
	}
	f.event("cable-arm %d", seconds)
	return atomicfile.WriteFile(f.netPath("cable-deadman"), []byte(strconv.Itoa(seconds)), 0o644)
}

// DisarmCableRevert implements Activator.
func (f *Fake) DisarmCableRevert(context.Context) error {
	if err := os.Remove(f.netPath("cable-deadman")); err == nil {
		f.event("cable-disarm")
	}
	return nil
}

// CableDeadmanArmed reports whether the cable's dead-man is armed.
func (f *Fake) CableDeadmanArmed() bool { return present(f.netPath("cable-deadman")) }

// SimulateCableRestart is a restart of the fake host for the cable: the live setting goes back to the committed one
// (network.nix's restore) and the dead-man's timer is gone.
func (f *Fake) SimulateCableRestart() {
	_ = os.Remove(f.netPath("cable-deadman"))
	if b, err := os.ReadFile(f.netPath("cable-committed")); err == nil {
		_ = atomicfile.WriteFile(f.netPath("cable-live"), b, 0o644)
	} else {
		_ = os.Remove(f.netPath("cable-live"))
	}
}
