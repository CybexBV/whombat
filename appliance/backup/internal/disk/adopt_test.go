package disk

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A machine for Adopt/Attach: signatures in sig/<name> (blkid prints them), mkfs writes one, systemd-mount
// records the mount in the mountinfo file.
func pinMachine(t *testing.T) (System, string) {
	t.Helper()
	root := t.TempDir()
	s := System{Sys: filepath.Join(root, "sys"), Dev: filepath.Join(root, "dev"), Mountinfo: filepath.Join(root, "mountinfo"),
		Blkid: filepath.Join(root, "blkid"), Mkfs: filepath.Join(root, "mkfs.ext4"), SystemdMount: filepath.Join(root, "systemd-mount"), HeadBytes: 4096}
	for _, d := range []string{s.Dev, filepath.Join(root, "sig"), filepath.Join(s.Sys, "class", "block"), filepath.Join(root, "mnt")} {
		_ = os.MkdirAll(d, 0o755)
	}
	_ = os.WriteFile(s.Mountinfo, nil, 0o644)
	sig := filepath.Join(root, "sig")
	write := func(p, body string) {
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(s.Blkid, `f="`+sig+`/$(basename "$4")"; [ -f "$f" ] || exit 2; cat "$f"`+"\n")
	write(s.Mkfs, `for a; do dev="$a"; done; n=$(basename "$dev"); printf 'TYPE=ext4\nLABEL=WHOMBAT-BACKUP\nUUID=11111111-2222-3333-4444-555555555555\n' | tee "`+sig+`/$n" > "`+sig+`/11111111-2222-3333-4444-555555555555"`+"\n")
	write(s.SystemdMount, `for a; do case "$a" in --options=*) opts="${a#--options=}";; -*) ;; *) if [ -z "$what" ]; then what="$a"; else where="$a"; fi;; esac; done
echo "$opts" > "`+root+`/mount-options"
echo "60 1 8:16 / $where rw - ext4 $what rw" >> "`+s.Mountinfo+`"
`)
	return s, root
}

func labelled(t *testing.T, s System, root, name, uuid string) {
	t.Helper()
	addDisk(t, s, name, 8, "data")
	_ = os.WriteFile(filepath.Join(s.Sys, "class", "block", name), nil, 0o644)
	body := "TYPE=ext4\nLABEL=WHOMBAT-BACKUP\nUUID=" + uuid + "\n"
	_ = os.WriteFile(filepath.Join(root, "sig", name), []byte(body), 0o644)
	_ = os.WriteFile(filepath.Join(root, "sig", uuid), []byte(body), 0o644)
}

// Security review 2, finding 3: a disk labelled WHOMBAT-BACKUP is mounted only once the owner configured
// it (pinned by UUID), only that one afterwards, with nosymfollow, and its folder is never a symlink.
func TestOnlyThePinnedDiskIsMounted(t *testing.T) {
	s, root := pinMachine(t)
	ctx := context.Background()
	pin, where := filepath.Join(root, "backup-root", "disk-uuid"), filepath.Join(root, "mnt")
	labelled(t, s, root, "sdb", "aaaaaaaa-0000-0000-0000-000000000001")
	// Nothing configured: a labelled stick is not mounted.
	if msg, err := s.Attach(ctx, pin, where, os.Getuid(), os.Getgid()); err != nil || !strings.Contains(msg, "nothing mounted") {
		t.Fatalf("%q %v", msg, err)
	}
	if b, _ := os.ReadFile(s.Mountinfo); len(b) != 0 {
		t.Fatalf("mounted without a pin: %s", b)
	}
	// Two labelled disks: the owner is asked to attach only one.
	labelled(t, s, root, "sdc", "aaaaaaaa-0000-0000-0000-000000000002")
	if _, err := s.Adopt(ctx, pin, where, false, os.Getuid(), os.Getgid()); err == nil || !strings.Contains(err.Error(), "More than one disk labelled") {
		t.Fatalf("%v", err)
	}
	// With allowInit, the one empty disk is formatted and pinned — never a labelled one.
	addDisk(t, s, "vdb", 16)
	dev, err := s.Adopt(ctx, pin, where, true, os.Getuid(), os.Getgid())
	if err != nil || filepath.Base(dev) != "vdb" {
		t.Fatalf("%s %v", dev, err)
	}
	if ReadPin(pin) != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("pin %q", ReadPin(pin))
	}
	if opts, _ := os.ReadFile(filepath.Join(root, "mount-options")); strings.TrimSpace(string(opts)) != MountOptions ||
		!strings.Contains(MountOptions, "nosymfollow") {
		t.Fatalf("mount options %q", opts)
	}
	if fi, err := os.Lstat(filepath.Join(where, "whombat")); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Fatalf("folder %v %v", fi, err)
	}
	// Unmounted: Attach mounts the pinned one again, not the other labelled disks.
	_ = os.WriteFile(s.Mountinfo, nil, 0o644)
	if msg, err := s.Attach(ctx, pin, where, os.Getuid(), os.Getgid()); err != nil || !strings.Contains(msg, "11111111") {
		t.Fatalf("%q %v", msg, err)
	}
	if b, _ := os.ReadFile(s.Mountinfo); !strings.Contains(string(b), "by-uuid/11111111-2222-3333-4444-555555555555") {
		t.Fatalf("mounted %s", b)
	}
	// What got mounted isn't the pinned disk (another device answered): refused.
	_ = os.WriteFile(s.Mountinfo, nil, 0o644)
	_ = os.WriteFile(filepath.Join(root, "sig", "sdz"), []byte("TYPE=ext4\nLABEL=WHOMBAT-BACKUP\nUUID=bbbbbbbb-0000-0000-0000-000000000009\n"), 0o644)
	_ = os.WriteFile(s.SystemdMount, []byte("#!/bin/sh\ncase \"$1\" in --umount) exit 0;; esac\nfor a; do where=\"$a\"; done\necho \"60 1 8:16 / $where rw - ext4 /dev/sdz rw\" >> \""+s.Mountinfo+"\"\n"), 0o755)
	if _, err := s.Attach(ctx, pin, where, os.Getuid(), os.Getgid()); err == nil || !strings.Contains(err.Error(), "isn't 11111111") {
		t.Fatalf("%v", err)
	}
}

func TestPrepareFolderRefusesASymlink(t *testing.T) {
	where, victim := t.TempDir(), t.TempDir()
	_ = os.Chmod(victim, 0o711)
	if err := os.Symlink(victim, filepath.Join(where, "whombat")); err != nil {
		t.Fatal(err)
	}
	if err := PrepareFolder(where, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("a symlinked folder was accepted")
	}
	if fi, _ := os.Stat(victim); fi.Mode().Perm() != 0o711 {
		t.Fatalf("the symlink's target was changed: %v", fi.Mode())
	}
}
