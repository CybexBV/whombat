package screen

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/pelletier/go-toml/v2"
)

// AccountFileName is the screen account's file in the agent's config
// folder: the Mac account the agent signs in to Screen Sharing with, kept on
// the Mac only (root, 0600).
const AccountFileName = "screen.toml"

// Account is the Mac account the agent signs in to Screen Sharing with.
type Account struct {
	User     string `toml:"user"`
	Password string `toml:"password"`
}

// validAccount checks what Apple's sign-in can carry: a user name and a
// password of 1 to 63 bytes, one line each.
func validAccount(a Account) error {
	switch {
	case a.User == "" || a.Password == "":
		return errors.New("give the Mac's user name and password")
	case len(a.User) > 63 || len(a.Password) > 63:
		return errors.New("the user name and password are at most 63 bytes each")
	case !utf8.ValidString(a.User) || !utf8.ValidString(a.Password):
		return errors.New("the user name and password must be text")
	case strings.ContainsAny(a.User, "\x00\r\n") || strings.ContainsAny(a.Password, "\x00\r\n"):
		return errors.New("the user name and password are one line each")
	}
	return nil
}

// ReadAccount reads the screen account from configDir. With none stored the
// error is fs.ErrNotExist (errors.Is). It must be a regular file (a link is
// not followed) that only its owner can read, and root's when the agent runs
// as root: anything else is refused, as the package task does.
func ReadAccount(configDir string) (Account, error) {
	var a Account
	p := filepath.Join(configDir, AccountFileName)
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return a, fmt.Errorf("%s must be a file, not a link", p)
		}
		return a, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return a, err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o077 != 0 {
		return a, fmt.Errorf("%s must be a file only its owner can read (0600)", p)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || (os.Geteuid() == 0 && st.Uid != 0) {
		return a, fmt.Errorf("%s must belong to root", p)
	}
	b, err := io.ReadAll(io.LimitReader(f, 64<<10))
	if err != nil {
		return a, err
	}
	if err := toml.Unmarshal(b, &a); err != nil {
		return Account{}, fmt.Errorf("%s: %w", AccountFileName, err)
	}
	if err := validAccount(a); err != nil {
		return Account{}, fmt.Errorf("%s: %w", AccountFileName, err)
	}
	return a, nil
}

// writeAccount stores the account atomically, readable by its owner (root)
// only.
func writeAccount(configDir string, a Account) error {
	if err := validAccount(a); err != nil {
		return err
	}
	body, err := toml.Marshal(a)
	if err != nil {
		return err
	}
	body = append([]byte("# The Mac account Whombat's agent signs in to Screen Sharing with. Root only.\n"), body...)
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(configDir, ".screen-*.toml")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(configDir, AccountFileName))
}

// clearAccount removes the stored account (none stored is fine).
func clearAccount(configDir string) error {
	err := os.Remove(filepath.Join(configDir, AccountFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
