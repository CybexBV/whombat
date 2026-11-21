// Package hosts is the backup's side of the hosts service (the servers' hub; BF-18): asking it for its own
// backup just before a checkpoint (BK-32), and handing a restored backup back to it (BK-34).
package hosts

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

// How Export and the checkpoint say the servers' backup couldn't be made: the start of the technical text a manifest
// records (Plain reads them back).
const (
	WhyUnreachable = "the hosts service's backup can't be reached"
	WhySlow        = "the hosts service's backup took too long"
	WhyFailed      = "the hosts service couldn't make its backup"
	WhyNoAnswer    = "the hosts service's backup stopped without an answer"
	WhyMissing     = "the hosts service's backup isn't in the snapshot"
	WhyUnusable    = "the hosts service's backup is unusable"
)

// Plain says in people's words why the servers aren't in a backup, from the technical text its manifest records (a
// sentence for the status and the app; the technical text stays in the manifest and the log).
func Plain(technical string) string {
	why := "something went wrong while it was made"
	switch {
	case strings.Contains(technical, "hub.db: no such file"):
		// The hub's database is made at the service's first start: a box that hasn't started it has no list yet.
		why = "the servers service hadn’t started yet"
	case strings.HasPrefix(technical, WhyUnreachable):
		why = "the servers service didn’t answer"
	case strings.HasPrefix(technical, WhySlow):
		why = "the servers service took too long to make its copy"
	case strings.HasPrefix(technical, WhyNoAnswer):
		why = "the servers service stopped before its copy was done"
	case strings.HasPrefix(technical, WhyFailed):
		why = "the servers service couldn’t make its copy"
	case strings.HasPrefix(technical, WhyMissing), strings.HasPrefix(technical, WhyUnusable):
		why = "its copy couldn’t be read"
	}
	return "The servers’ list wasn’t saved: " + why + ". Everything else was backed up."
}

// Export asks the hosts service for a fresh backup. Connecting to its backup socket starts the service's own
// backup (`whombat-hosts backup`) as its user, which writes <persist>/hosts-backup/hub.tar (hub.tar.gz from a
// hosts service from before) and answers "ok", or "failed: <why>" (NixOS: whombat-hosts-backup@.service, NX-407).
// The answer is all it sends.
func Export(ctx context.Context, socket string) error {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return fmt.Errorf("%s (%v)", WhyUnreachable, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	b, err := io.ReadAll(io.LimitReader(conn, 4096))
	answer := strings.TrimSpace(string(b))
	if first, _, _ := strings.Cut(answer, "\n"); strings.TrimSpace(first) == "ok" {
		return nil
	}
	switch {
	case ctx.Err() != nil || errors.Is(err, os.ErrDeadlineExceeded):
		// The connection's deadline is the context's, and the read can pass it a moment before the context says so.
		return fmt.Errorf("%s (%v)", WhySlow, cmp.Or(ctx.Err(), context.DeadlineExceeded))
	case answer != "":
		return fmt.Errorf("%s (%s)", WhyFailed, strings.TrimSpace(strings.TrimPrefix(answer, "failed:")))
	case err != nil:
		return fmt.Errorf("%s (%v)", WhyNoAnswer, err)
	}
	return errors.New(WhyNoAnswer)
}

// Stage puts a restored backup of the hosts service where the service applies it at its next start:
// <persist>/hosts/restore-staged.tar (restore-staged.tar.gz when it is gzipped, told by its first bytes), owned by
// its user (uid, gid), 0600 (BK-34; hosts HS-170…). A file staged earlier under the other name is removed,
// so the service never applies an older one. It runs as root at the console, in a directory the service's user
// controls, so it never follows anything there (BK-26): the data directory is opened from root's /persist without
// following a symlink and must be a directory of that user (or root); the file is written under a random name
// created with O_EXCL, handed over with fchown/fchmod, synced and renamed over whatever had the staged name (a
// planted symlink is replaced, never followed). src is root's (the restore's staging), read without following a
// symlink.
func Stage(src string, l coverage.Layout, uid, gid int) error {
	in, err := os.OpenFile(src, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", src)
	}
	name, other := coverage.HostsStagedTarFile, coverage.HostsStagedFile
	magic := make([]byte, 2)
	if n, _ := io.ReadFull(in, magic); n == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		name, other = other, name
	}
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	dfd, err := openDataDir(l, uid)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	tmp := ".restore-staged-" + hex.EncodeToString(b)
	fd, err := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return fmt.Errorf("%s: %w", l.HostsData(), err)
	}
	out := os.NewFile(uintptr(fd), filepath.Join(l.HostsData(), tmp))
	ok := false
	defer func() {
		if !ok {
			_ = out.Close()
			_ = unix.Unlinkat(dfd, tmp, 0)
		}
	}()
	if err := out.Chown(uid, gid); err != nil {
		return fmt.Errorf("hand the servers' backup to the hosts service: %w", err)
	}
	if err := out.Chmod(0o600); err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("copy the servers' backup: %w", err)
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(dfd, tmp, dfd, name); err != nil {
		return fmt.Errorf("%s: %w", filepath.Join(l.HostsData(), name), err)
	}
	ok = true
	if err := unix.Unlinkat(dfd, other, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("remove the servers' backup staged before (%s): %w", filepath.Join(l.HostsData(), other), err)
	}
	_ = unix.Fsync(dfd)
	return nil
}

// StagedPath is where Stage put the servers' backup ("" when nothing is staged).
func StagedPath(l coverage.Layout) string {
	for _, n := range coverage.HostsStagedFiles {
		p := filepath.Join(l.HostsData(), n)
		if fi, err := os.Lstat(p); err == nil && fi.Mode().IsRegular() {
			return p
		}
	}
	return ""
}

// openDataDir opens <persist>/hosts from <persist> without following a symlink: a directory of the
// service's user or root.
func openDataDir(l coverage.Layout, uid int) (int, error) {
	pfd, err := unix.Open(l.Persist, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("%s: %w", l.Persist, err)
	}
	defer unix.Close(pfd)
	dfd, err := unix.Openat(pfd, "hosts", unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return -1, fmt.Errorf("refusing %s: a symlink or not a directory", l.HostsData())
	}
	if err != nil {
		return -1, fmt.Errorf("%s: %w", l.HostsData(), err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(dfd, &st); err != nil {
		unix.Close(dfd)
		return -1, err
	}
	if int(st.Uid) != uid && st.Uid != 0 {
		unix.Close(dfd)
		return -1, fmt.Errorf("refusing %s: owned by uid %d, not the hosts service's", l.HostsData(), st.Uid)
	}
	return dfd, nil
}
