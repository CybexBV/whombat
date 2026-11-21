// Package wall keeps the appliance's Vault sets equal to the runtime's home-network list (Whombat VT-59; IN-58…
// IN-61). The runtime writes the list as a file; this package reads it without following links, validates it
// again (package networks), and replaces the elements of two nftables interval sets in one transaction. A file
// that is missing, unreadable or invalid in any way empties both sets.
package wall

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/vaultwall/internal/networks"
)

// Wall is one list file and the sets it fills.
type Wall struct {
	Source Source
	Sets   Sets
	// Apply runs one nft transaction (NFT.Apply; a fake in tests).
	Apply func(script string) error
	// Log receives one line per change of what is applied, and every failure.
	Log func(msg string)

	applied string // the last script applied ("" when unknown)
	summary string // the last summary logged
}

// desired reads the file and returns the script for it and a summary of what it asks for, or why it was
// refused.
func (w *Wall) desired() (script, summary string) {
	path := w.Source.Path()
	data, err := w.Source.Read()
	var nets []networks.Network
	switch {
	case errors.Is(err, ErrNoFile):
		summary = fmt.Sprintf("no %s: no Vault networks", path)
	case err != nil:
		summary = fmt.Sprintf("refused %s: %v; no Vault networks", path, err)
	default:
		if nets, err = networks.Parse(data); err != nil {
			nets = nil
			summary = fmt.Sprintf("refused %s: %v; no Vault networks", path, err)
		}
	}
	v4, v6 := networks.Elements(nets)
	if summary == "" {
		summary = fmt.Sprintf("%d Vault networks from %s (%d IPv4 and %d IPv6 elements)", len(nets), path, len(v4), len(v6))
	}
	return w.Sets.Script(v4, v6), summary
}

// Sync reads the file and applies it when it changed, or always with force (after a reload of the firewall,
// and now and then). A failed transaction leaves the kernel's old elements, so Sync then empties the sets.
func (w *Wall) Sync(force bool) error {
	script, summary := w.desired()
	if !force && script == w.applied && summary == w.summary {
		return nil
	}
	if err := w.Apply(script); err != nil {
		w.applied = ""
		w.summary = ""
		empty := w.Sets.Script(nil, nil)
		if script != empty {
			if err2 := w.Apply(empty); err2 == nil {
				w.applied = empty
				w.log(fmt.Sprintf("could not apply the Vault networks (%v); emptied the sets", err))
				return err
			}
		}
		w.log(fmt.Sprintf("could not apply the Vault networks: %v", err))
		return err
	}
	changed := script != w.applied || summary != w.summary
	w.applied, w.summary = script, summary
	if changed {
		w.log(summary)
	}
	return nil
}

// Status is the last summary (for systemd's STATUS=).
func (w *Wall) Status() string { return w.summary }

func (w *Wall) log(msg string) {
	if w.Log != nil {
		w.Log(msg)
	}
}

// Run watches the file's directory and syncs on every change of the file, on reload (forced) and every resync
// (forced, and re-arms a lost watch). The watch exists before the first read, so no change is missed. The first
// sync must leave the sets in a known state (the list, or empty when the list could not be applied: retried at the
// next sync); ready is called after it. Run returns when ctx ends.
func (w *Wall) Run(ctx context.Context, resync time.Duration, reload <-chan struct{}, ready func()) error {
	watch, err := newWatcher(w.Source.Dir, w.Source.Name)
	if err != nil {
		return err
	}
	defer watch.close()
	if err := watch.ensure(); err != nil {
		w.log(fmt.Sprintf("cannot watch %s yet (%v); checking every %s", w.Source.Dir, err, resync))
	}
	if err := w.Sync(true); err != nil && w.applied == "" {
		return err
	}
	if ready != nil {
		ready()
	}
	tick := time.NewTicker(resync)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-watch.c:
			_ = w.Sync(false)
		case <-reload:
			_ = w.Sync(true)
		case <-tick.C:
			_ = watch.ensure()
			_ = w.Sync(true)
		}
	}
}

// watcher is an inotify watch on the list's directory that signals c when the file (or the directory) changes.
type watcher struct {
	dir, name string
	fd        int
	f         *os.File
	c         chan struct{}

	mu sync.Mutex
	wd int // -1 while not watching
}

const watchMask = unix.IN_CLOSE_WRITE | unix.IN_MOVED_TO | unix.IN_MOVED_FROM | unix.IN_CREATE | unix.IN_DELETE |
	unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF | unix.IN_ONLYDIR | unix.IN_DONT_FOLLOW

func newWatcher(dir, name string) (*watcher, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, fmt.Errorf("inotify: %w", err)
	}
	w := &watcher{dir: dir, name: name, fd: fd, f: os.NewFile(uintptr(fd), "inotify"), c: make(chan struct{}, 1), wd: -1}
	go w.loop()
	return w, nil
}

func (w *watcher) ensure() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.wd >= 0 {
		return nil
	}
	wd, err := unix.InotifyAddWatch(w.fd, w.dir, watchMask)
	if err != nil {
		return err
	}
	w.wd = wd
	return nil
}

func (w *watcher) lost(wd int32) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if int(wd) == w.wd {
		w.wd = -1
	}
}

func (w *watcher) loop() {
	buf := make([]byte, 64<<10)
	for {
		n, err := w.f.Read(buf)
		if err != nil {
			return
		}
		relevant := false
		for off := 0; off+unix.SizeofInotifyEvent <= n; {
			wd := int32(binary.NativeEndian.Uint32(buf[off:]))
			mask := binary.NativeEndian.Uint32(buf[off+4:])
			size := int(binary.NativeEndian.Uint32(buf[off+12:]))
			start := off + unix.SizeofInotifyEvent
			end := min(start+size, n)
			name := strings.TrimRight(string(buf[start:end]), "\x00")
			off = start + size
			switch {
			case mask&(unix.IN_IGNORED|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0:
				w.lost(wd)
				relevant = true
			case mask&unix.IN_Q_OVERFLOW != 0, name == w.name:
				relevant = true
			}
		}
		if relevant {
			select {
			case w.c <- struct{}{}:
			default:
			}
		}
	}
}

func (w *watcher) close() { _ = w.f.Close() }
