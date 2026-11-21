package wifi

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// MaxProfileBytes bounds a profile file this package reads (iwd's are a few hundred bytes).
const MaxProfileBytes = 64 * 1024

// ProfileName is iwd's file name for a network's profile (iwd storage_get_network_file_path): the SSID itself when
// it has only ASCII letters, digits, '-', '_' and ' ', else '=' and its bytes in lowercase hex; then '.' and the
// kind ("psk", "open", "8021x").
func ProfileName(ssid string, sec Security) (string, error) {
	if !ValidSSID(ssid) {
		return "", ErrBadSSID
	}
	switch sec {
	case SecurityOpen, SecurityPSK, SecurityEAP:
	default:
		return "", fmt.Errorf("wifi: no profile file for %q networks", sec)
	}
	if plainName(ssid) {
		return ssid + "." + string(sec), nil
	}
	return "=" + hex.EncodeToString([]byte(ssid)) + "." + string(sec), nil
}

func plainName(ssid string) bool {
	for i := 0; i < len(ssid); i++ {
		c := ssid[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '-' || c == '_' || c == ' ') {
			return false
		}
	}
	return true
}

// ParseProfileName is ProfileName's reverse; ok is false for any other file (iwd's own temporary files, hotspot
// directories, names iwd would refuse).
func ParseProfileName(name string) (ssid string, sec Security, ok bool) {
	dot := strings.IndexByte(name, '.')
	if dot <= 0 {
		return "", "", false
	}
	sec = Security(name[dot+1:])
	if sec != SecurityOpen && sec != SecurityPSK && sec != SecurityEAP {
		return "", "", false
	}
	base := name[:dot]
	if base[0] == '=' {
		b, err := hex.DecodeString(base[1:])
		if err != nil || !ValidSSID(string(b)) {
			return "", "", false
		}
		return string(b), sec, true
	}
	if len(base) > 32 || !plainName(base) {
		return "", "", false
	}
	return base, sec, true
}

// Profile is a network profile as this package writes one (iwd.network(5)): a passphrase or a raw key for a psk
// network, whether it is hidden, and AutoConnect (on unless NoAutoConnect).
type Profile struct {
	Passphrase    string // 8…63 printable ASCII, or 64 hex digits (written as PreSharedKey); a secret
	Hidden        bool
	NoAutoConnect bool
}

// String leaves the passphrase out.
func (p Profile) String() string {
	return fmt.Sprintf("profile (hidden %v, autoconnect %v, passphrase given %v)", p.Hidden, !p.NoAutoConnect, p.Passphrase != "")
}

// GoString leaves the passphrase out (%#v).
func (p Profile) GoString() string { return p.String() }

// Render returns the profile file's content for a network of kind sec.
func (p Profile) Render(sec Security) ([]byte, error) {
	var b strings.Builder
	switch sec {
	case SecurityPSK:
		switch {
		case IsHexKey(p.Passphrase):
			fmt.Fprintf(&b, "[Security]\nPreSharedKey=%s\n\n", strings.ToLower(p.Passphrase))
		case ValidPassphrase(p.Passphrase):
			fmt.Fprintf(&b, "[Security]\nPassphrase=%s\n\n", escapeValue(p.Passphrase))
		default:
			return nil, ErrInvalidPassphrase
		}
	case SecurityOpen:
		if p.Passphrase != "" {
			return nil, errors.New("wifi: an open network takes no passphrase")
		}
	default:
		return nil, ErrNotSupported
	}
	// Always a group: iwd can't load an empty file (ell refuses empty data).
	fmt.Fprintf(&b, "[Settings]\nAutoConnect=%v\n", !p.NoAutoConnect)
	if p.Hidden {
		b.WriteString("Hidden=true\n")
	}
	return []byte(b.String()), nil
}

// escapeValue escapes a value the way ell's settings do (escape_value): a backslash doubled, leading blanks as \s
// and \t (ell strips them), the rest as it is (ell keeps trailing blanks).
func escapeValue(v string) string {
	var b strings.Builder
	lead := true
	for i := 0; i < len(v); i++ {
		switch c := v[i]; {
		case c == ' ' && lead:
			b.WriteString(`\s`)
		case c == '\t' && lead:
			b.WriteString(`\t`)
		case c == '\\':
			b.WriteString(`\\`)
			lead = false
		default:
			b.WriteByte(c)
			if c != ' ' && c != '\t' {
				lead = false
			}
		}
	}
	return b.String()
}

// ProfilePath is the profile file of a network in dir (StateDir on the appliance).
func ProfilePath(dir, ssid string, sec Security) (string, error) {
	name, err := ProfileName(ssid, sec)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// WriteProfile writes a network's profile into dir, 0600, atomically (iwd ignores the dot-named temporary file and
// loads the profile when it is renamed into place). dir must exist.
func WriteProfile(dir, ssid string, sec Security, p Profile) error {
	data, err := p.Render(sec)
	if err != nil {
		return err
	}
	return WriteProfileData(dir, ssid, sec, data)
}

// WriteProfileData writes a profile's raw content (one ReadProfile returned) into dir, 0600, atomically.
func WriteProfileData(dir, ssid string, sec Security, data []byte) error {
	path, err := ProfilePath(dir, ssid, sec)
	if err != nil {
		return err
	}
	if len(data) > MaxProfileBytes {
		return errors.New("wifi: profile too large")
	}
	return atomicfile.WriteFile(path, data, 0o600)
}

// ReadProfile returns a network's profile file in dir; an error wrapping os.ErrNotExist when there is none.
func ReadProfile(dir, ssid string, sec Security) ([]byte, error) {
	path, err := ProfilePath(dir, ssid, sec)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("wifi: %s is not a regular file", filepath.Base(path))
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxProfileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxProfileBytes {
		return nil, errors.New("wifi: profile too large")
	}
	return b, nil
}

// RemoveProfile removes a network's profile file from dir (nothing when there is none).
func RemoveProfile(dir, ssid string, sec Security) error {
	path, err := ProfilePath(dir, ssid, sec)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// CopyProfile copies a network's profile from srcDir to dstDir (the installer: the network it joined into the
// installed system's /var/lib/iwd), creating dstDir 0700 when it is missing.
func CopyProfile(srcDir, dstDir, ssid string, sec Security) error {
	data, err := ReadProfile(srcDir, ssid, sec)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dstDir, 0o700); err != nil {
		return err
	}
	return WriteProfileData(dstDir, ssid, sec, data)
}
