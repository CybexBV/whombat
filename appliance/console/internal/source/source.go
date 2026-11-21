// Package source reads what the console shows (CC-08, NX-32): the runtime's state file, the footer and why the first
// start can't finish (CG-409). Both the
// text console on tty1 and the graphical console's server (CG-03) use it. Every read is bounded, refuses anything
// but a regular file and never follows a final symlink.
package source

import (
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
)

// Load reads and validates the state file; anything wrong is the starting screen.
func Load(path string) screen.Screen {
	data, err := ReadLimited(path, screen.MaxFileSize+1)
	if err != nil {
		return screen.StartingScreen
	}
	s, err := screen.Parse(data)
	if err != nil {
		return screen.StartingScreen
	}
	return s
}

// LoadStart reads the start problem file (CG-409; "" none): nil when there is none or it isn't valid.
func LoadStart(path string) *screen.Start {
	if path == "" {
		return nil
	}
	data, err := ReadLimited(path, screen.MaxStartFileSize+1)
	if err != nil {
		return nil
	}
	s, err := screen.ParseStart(data)
	if err != nil {
		return nil
	}
	return s
}

// ReadLimited opens a regular file without following a final symlink and reads at most limit bytes.
func ReadLimited(path string, limit int64) ([]byte, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	return io.ReadAll(io.LimitReader(f, limit))
}

// LoadFooter reads the footer (the appliance banner, base.nix) as cleaned lines; "" is the built-in banner.
func LoadFooter(path string) ([]string, error) {
	text := screen.Banner
	if path != "" {
		b, err := ReadLimited(path, 4096)
		if err != nil {
			return nil, err
		}
		text = string(b)
	}
	var out []string
	for _, l := range strings.Split(strings.Trim(text, "\n"), "\n") {
		out = append(out, screen.Clean(l))
	}
	return out, nil
}
