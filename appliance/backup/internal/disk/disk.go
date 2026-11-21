// Package disk prepares an empty disk as the backup disk (BK-20): the root helper behind the owner's
// "let Whombat prepare the disk". It formats only a disk that is provably empty and unused, and only when
// exactly one such disk is attached; it never takes a device name from its caller.
package disk

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Label is the filesystem label the NixOS module mounts.
const Label = "WHOMBAT-BACKUP"

// MinBytes is the smallest disk accepted.
const MinBytes = 1 << 30

// System is the machine's view (fields point elsewhere in tests).
type System struct {
	Sys       string // "/sys"
	Dev       string // "/dev"
	Mountinfo string // "/proc/self/mountinfo"
	Blkid     string // blkid binary
	Mkfs      string // mkfs.ext4 binary
	Udevadm   string // udevadm binary ("" = don't nudge udev)
	// SystemdMount mounts the backup disk (systemd-mount).
	SystemdMount string
	// HeadBytes is how much of the start of the disk must read as zeros (default 1 MiB).
	HeadBytes int
}

// Disk is one whole block device and why it can't be used ("" = eligible).
type Disk struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	Reason string `json:"reason,omitempty"`
}

var skipPrefixes = []string{"loop", "ram", "zram", "dm-", "md", "sr", "nbd", "fd", "zd", "drbd"}

// Scan lists the whole disks and whether each is an empty, unused disk.
func (s System) Scan(ctx context.Context) ([]Disk, error) {
	ents, err := os.ReadDir(filepath.Join(s.Sys, "block"))
	if err != nil {
		return nil, err
	}
	mounted, err := s.mountedDevs()
	if err != nil {
		return nil, err
	}
	var out []Disk
	for _, e := range ents {
		name := e.Name()
		skip := false
		for _, p := range skipPrefixes {
			skip = skip || strings.HasPrefix(name, p)
		}
		if skip {
			continue
		}
		d := Disk{Name: name}
		d.Reason = s.check(ctx, &d, mounted)
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s System) read(p string) string {
	b, _ := os.ReadFile(p)
	return strings.TrimSpace(string(b))
}

func (s System) check(ctx context.Context, d *Disk, mounted map[string]bool) string {
	base := filepath.Join(s.Sys, "block", d.Name)
	if s.read(filepath.Join(base, "ro")) != "0" {
		return "read-only"
	}
	sectors, err := strconv.ParseInt(s.read(filepath.Join(base, "size")), 10, 64)
	if err != nil {
		return "size unknown"
	}
	d.Bytes = sectors * 512
	if d.Bytes < MinBytes {
		return "smaller than 1 GiB"
	}
	if holders, _ := os.ReadDir(filepath.Join(base, "holders")); len(holders) > 0 {
		return "in use"
	}
	if mounted[s.read(filepath.Join(base, "dev"))] {
		return "mounted"
	}
	subs, _ := os.ReadDir(base)
	for _, sub := range subs {
		if _, err := os.Stat(filepath.Join(base, sub.Name(), "partition")); err == nil {
			return "has partitions"
		}
	}
	dev := filepath.Join(s.Dev, d.Name)
	// blkid -p (low-level probe, no cache): exit 2 = no signature (filesystem, RAID, LVM, LUKS, partition table).
	cmd := exec.CommandContext(ctx, s.Blkid, "-p", "-o", "export", dev)
	var out bytes.Buffer
	cmd.Stdout = &out
	err = cmd.Run()
	var ee *exec.ExitError
	switch {
	case err == nil:
		typ := ""
		for _, l := range strings.Split(out.String(), "\n") {
			if strings.HasPrefix(l, "TYPE=") || strings.HasPrefix(l, "PTTYPE=") {
				typ = l
				break
			}
		}
		return "not empty (" + strings.TrimSpace(typ) + ")"
	case errors.As(err, &ee) && ee.ExitCode() == 2:
	default:
		return "can't be probed"
	}
	n := s.HeadBytes
	if n == 0 {
		n = 1 << 20
	}
	f, err := os.Open(dev)
	if err != nil {
		return "can't be read"
	}
	defer f.Close()
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, 0); err != nil {
		return "can't be read"
	}
	for _, b := range buf {
		if b != 0 {
			return "not empty (data at its start)"
		}
	}
	return ""
}

// mountedDevs are the major:minor numbers of every mounted filesystem.
func (s System) mountedDevs() (map[string]bool, error) {
	b, err := os.ReadFile(s.Mountinfo)
	if err != nil {
		return nil, err
	}
	m := map[string]bool{}
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) > 2 {
			m[f[2]] = true
		}
	}
	return m, nil
}

// Init formats the one empty disk as ext4 labelled WHOMBAT-BACKUP, its root owned by uid:gid. The error is
// owner-facing when no disk or several qualify.
func (s System) Init(ctx context.Context, uid, gid int) (string, error) {
	disks, err := s.Scan(ctx)
	if err != nil {
		return "", err
	}
	var ok []Disk
	for _, d := range disks {
		if d.Reason == "" {
			ok = append(ok, d)
		}
	}
	switch len(ok) {
	case 0:
		return "", errors.New("No empty disk is attached: attach a new, empty disk of 1 GiB or more to this Whombat, then try again.")
	case 1:
	default:
		var names []string
		for _, d := range ok {
			names = append(names, d.Name)
		}
		return "", fmt.Errorf("More than one empty disk is attached (%s): attach only the one meant for backups, then try again.", strings.Join(names, ", "))
	}
	dev := filepath.Join(s.Dev, ok[0].Name)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.Mkfs, "-q", "-F", "-L", Label, "-m", "0",
		"-E", fmt.Sprintf("root_owner=%d:%d", uid, gid), dev)
	cmd.Stdin = nil
	if out, err := cmd.CombinedOutput(); err != nil {
		return dev, fmt.Errorf("mkfs.ext4 %s: %v: %s", dev, err, strings.TrimSpace(string(out)))
	}
	if s.Udevadm != "" {
		// The new label makes udev ask systemd to mount it (the module's rule); udev notices the closed
		// device by itself, this only nudges it. Never --settle: in the helper's private network namespace
		// the uevents it would wait for never arrive (found by vm-tests/backup-destinations).
		tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		_ = exec.CommandContext(tctx, s.Udevadm, "trigger", "--action=change", dev).Run()
	}
	return dev, nil
}

// MountOptions: nothing on a backup disk is executed, is a device, or is followed as a symlink (a disk can
// come from anywhere; BK-27).
const MountOptions = "nodev,nosuid,noexec,noatime,nosymfollow"

// Filesystem is one labelled filesystem.
type Filesystem struct {
	Dev, Type, Label, UUID string
}

// probe reads a device's signature (blkid -p, no cache).
func (s System) probe(ctx context.Context, dev string) (Filesystem, bool) {
	out, err := exec.CommandContext(ctx, s.Blkid, "-p", "-o", "export", dev).Output()
	if err != nil {
		return Filesystem{}, false
	}
	fs := Filesystem{Dev: dev}
	for _, l := range strings.Split(string(out), "\n") {
		k, v, _ := strings.Cut(strings.TrimSpace(l), "=")
		switch k {
		case "TYPE":
			fs.Type = v
		case "LABEL":
			fs.Label = v
		case "UUID":
			fs.UUID = v
		}
	}
	return fs, true
}

// usable: a backup disk's filesystem.
func (f Filesystem) usable() bool {
	return f.Label == Label && (f.Type == "ext4" || f.Type == "btrfs") && uuidRe.MatchString(f.UUID)
}

var uuidRe = regexp.MustCompile(`^[0-9A-Fa-f-]{8,64}$`)

// Labelled lists the filesystems labelled WHOMBAT-BACKUP (whole disks and partitions).
func (s System) Labelled(ctx context.Context) ([]Filesystem, error) {
	ents, err := os.ReadDir(filepath.Join(s.Sys, "class", "block"))
	if err != nil {
		return nil, err
	}
	var out []Filesystem
	for _, e := range ents {
		name := e.Name()
		skip := false
		for _, p := range skipPrefixes {
			skip = skip || strings.HasPrefix(name, p)
		}
		if skip {
			continue
		}
		if fs, ok := s.probe(ctx, filepath.Join(s.Dev, name)); ok && fs.usable() {
			out = append(out, fs)
		}
	}
	return out, nil
}

// mountedAt is the source device of the filesystem mounted at where ("" = none; the topmost of stacked
// mounts, the one that is visible).
func (s System) mountedAt(where string) string {
	b, err := os.ReadFile(s.Mountinfo)
	if err != nil {
		return ""
	}
	src := ""
	for _, l := range strings.Split(string(b), "\n") {
		pre, post, ok := strings.Cut(l, " - ")
		f, g := strings.Fields(pre), strings.Fields(post)
		if ok && len(f) > 4 && len(g) > 1 && f[4] == where {
			src = g[1]
		}
	}
	return src
}

// ReadPin is the pinned disk's UUID ("" = none).
func ReadPin(path string) string {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return ""
	}
	defer f.Close()
	b := make([]byte, 128)
	n, _ := f.Read(b)
	v := strings.TrimSpace(string(b[:n]))
	if !uuidRe.MatchString(v) {
		return ""
	}
	return v
}

// WritePin pins a disk's UUID (root-only directory).
func WritePin(path, uuid string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".disk-uuid-*")
	if err != nil {
		return err
	}
	if _, err := f.WriteString(uuid + "\n"); err != nil {
		f.Close()
		os.Remove(f.Name())
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return err
	}
	return os.Rename(f.Name(), path)
}

// mount mounts a backup disk with systemd-mount: a transient mount unit bound to the device, so it is
// unmounted when the device goes. The device is the one just probed (its node: right after formatting udev
// may not have made the by-uuid link yet); what got mounted is checked against the UUID afterwards.
func (s System) mount(ctx context.Context, fs Filesystem, where string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, s.SystemdMount, "--no-ask-password", "--collect", "--fsck=no",
		"--type="+fs.Type, "--options="+MountOptions, fs.Dev, where).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemd-mount %s: %v: %s", fs.UUID, err, strings.TrimSpace(string(out)))
	}
	if got, ok := s.probe(ctx, s.mountedAt(where)); !ok || got.UUID != fs.UUID {
		_ = exec.CommandContext(ctx, s.SystemdMount, "--umount", where).Run()
		return fmt.Errorf("the disk mounted at %s isn't %s: unmounted", where, fs.UUID)
	}
	return nil
}

// PrepareFolder makes <where>/whombat, the backup user's folder on the disk, without following a symlink
// (a symlink or anything but a directory there is refused and left alone).
func PrepareFolder(where string, uid, gid int) error {
	dfd, err := unix.Open(where, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	open := func() (int, error) {
		return unix.Openat(dfd, "whombat", unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	}
	fd, err := open()
	if errors.Is(err, unix.ENOENT) {
		if err = unix.Mkdirat(dfd, "whombat", 0o700); err == nil || errors.Is(err, unix.EEXIST) {
			fd, err = open()
		}
	}
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return fmt.Errorf("%s/whombat is a symlink or not a folder: the disk isn't used", where)
	}
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return err
	}
	return unix.Fchmod(fd, 0o700)
}

// Attach mounts the pinned backup disk when it is attached (at boot and whenever a filesystem labelled
// WHOMBAT-BACKUP appears). Nothing is mounted before a disk was pinned, and never another disk than the
// pinned one, whatever its label.
func (s System) Attach(ctx context.Context, pinPath, where string, uid, gid int) (string, error) {
	pin := ReadPin(pinPath)
	if pin == "" {
		return "no backup disk is configured: nothing mounted", nil
	}
	if s.mountedAt(where) != "" {
		return "the backup disk is mounted", PrepareFolder(where, uid, gid)
	}
	fs, ok := s.probe(ctx, filepath.Join(s.Dev, "disk", "by-uuid", pin))
	if !ok {
		return "the pinned backup disk isn't attached", nil
	}
	if !fs.usable() || fs.UUID != pin {
		return "", fmt.Errorf("the disk with the pinned UUID %s isn't a backup disk (label %q, type %q): not mounted", pin, fs.Label, fs.Type)
	}
	if err := s.mount(ctx, fs, where); err != nil {
		return "", err
	}
	return "mounted the backup disk " + pin, PrepareFolder(where, uid, gid)
}

// Adopt is the owner's configuration of the disk destination: the mounted backup disk, or the one attached
// disk labelled WHOMBAT-BACKUP, or (init) the one empty disk formatted, is pinned and mounted. The error is
// owner-facing when no disk or several qualify.
func (s System) Adopt(ctx context.Context, pinPath, where string, init bool, uid, gid int) (string, error) {
	if dev := s.mountedAt(where); dev != "" {
		fs, ok := s.probe(ctx, dev)
		if !ok || !fs.usable() {
			return "", fmt.Errorf("the disk mounted at %s isn't a backup disk", where)
		}
		if ReadPin(pinPath) != fs.UUID {
			if err := WritePin(pinPath, fs.UUID); err != nil {
				return "", err
			}
		}
		return fs.Dev, PrepareFolder(where, uid, gid)
	}
	var fs Filesystem
	if init {
		dev, err := s.Init(ctx, uid, gid)
		switch {
		case err == nil:
			f, ok := s.probe(ctx, dev)
			if !ok || !f.usable() {
				return dev, fmt.Errorf("%s: no backup filesystem after formatting", dev)
			}
			fs = f
		case strings.HasPrefix(err.Error(), "No empty disk"):
			init = false // a disk the owner prepared is used as it is
		default:
			return dev, err
		}
	}
	if !init {
		labelled, err := s.Labelled(ctx)
		if err != nil {
			return "", err
		}
		switch len(labelled) {
		case 0:
			return "", errors.New("No disk labelled WHOMBAT-BACKUP is attached: attach one, or attach an empty disk and let Whombat prepare it.")
		case 1:
			fs = labelled[0]
		default:
			var devs []string
			for _, l := range labelled {
				devs = append(devs, filepath.Base(l.Dev))
			}
			return "", fmt.Errorf("More than one disk labelled WHOMBAT-BACKUP is attached (%s): attach only the one meant for backups, then try again.", strings.Join(devs, ", "))
		}
	}
	if err := WritePin(pinPath, fs.UUID); err != nil {
		return fs.Dev, err
	}
	if err := s.mount(ctx, fs, where); err != nil {
		return fs.Dev, err
	}
	return fs.Dev, PrepareFolder(where, uid, gid)
}
