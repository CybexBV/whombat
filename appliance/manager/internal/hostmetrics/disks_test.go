package hostmetrics

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/protocol"
	"golang.org/x/sys/unix"
)

// The DEV box's /persist (2026-10-11): `stat -f -c %i /persist` printed 616166a00b3b64bb for the btrfs filesystem
// d0a7d186-2a54-4375-b1c6-b726216f27cb mounted at its top level (subvolume 5).
const devUUID = "d0a7d186-2a54-4375-b1c6-b726216f27cb"

var devFsid = unix.Fsid{Val: [2]int32{0x616166a0, 0x0b3b64bb}}

type fakeFS struct {
	statfs map[string]unix.Statfs_t
	subvol map[string][2]uint64 // path → id, inode
}

func (f fakeFS) reader(proc, sys string) diskReader {
	return diskReader{persist: "/persist", system: "/", backup: "/persist/backup/disk", proc: proc, sys: sys,
		statfs: func(p string, st *unix.Statfs_t) error {
			v, ok := f.statfs[p]
			if !ok {
				return unix.ENOENT
			}
			*st = v
			return nil
		},
		subvol: func(p string) (uint64, uint64, error) {
			v, ok := f.subvol[p]
			if !ok {
				return 0, 0, errors.New("no such subvolume")
			}
			return v[0], v[1], nil
		}}
}

// devBox is the DEV box's layout: /persist at the top level (5), workspaces 258, postgres 256, with its qgroup numbers.
func devBox(t *testing.T) (fakeFS, string, string) {
	proc, sys := t.TempDir(), t.TempDir()
	q := "fs/btrfs/" + devUUID + "/qgroups/"
	tree(t, sys, map[string]string{
		"fs/btrfs/features/raid56": "0\n", // not a filesystem
		q + "inconsistent":         "0\n",
		q + "1_100/referenced":     "20501757952\n",
		q + "1_101/referenced":     "19280044032\n",
		q + "0_258/referenced":     "17369845760\n",
		q + "0_256/referenced":     "107687936\n",
		q + "0_5/referenced":       "1134030848\n",
		"fs/btrfs/" + "00000000-0000-0000-0000-000000000001/qgroups/inconsistent": "0\n", // another btrfs filesystem
	})
	tree(t, proc, map[string]string{"self/mountinfo": "66 1 8:18 / / rw,noatime shared:1 - ext4 /dev/sdb2 rw\n" +
		"93 66 0:32 / /persist rw,nosuid,nodev,noatime shared:5 - btrfs /dev/sdb3 rw,subvolid=5,subvol=/\n"})
	fs := fakeFS{
		statfs: map[string]unix.Statfs_t{
			// 93.4 GB, 42.0 GB used, 48.8 GB free for users.
			"/persist": {Type: unix.BTRFS_SUPER_MAGIC, Bsize: 4096, Frsize: 4096, Blocks: 22806016, Bfree: 12557325, Bavail: 11915705, Fsid: devFsid},
			"/":        {Type: unix.EXT4_SUPER_MAGIC, Bsize: 4096, Frsize: 4096, Blocks: 10243384, Bfree: 8849785, Bavail: 8320414},
		},
		subvol: map[string][2]uint64{"/persist": {5, 256}, "/persist/whombat/workspaces": {258, 256}, "/persist/postgres": {256, 256}},
	}
	return fs, proc, sys
}

func partsOf(d protocol.HostDisks) map[protocol.HostDiskPartKey]int64 {
	if d.Data.Parts == nil {
		return nil
	}
	m := map[protocol.HostDiskPartKey]int64{}
	for _, p := range d.Data.Parts {
		m[p.Key] = p.Bytes
	}
	return m
}

func TestDisksOfTheDevBox(t *testing.T) {
	fs, proc, sys := devBox(t)
	d := fs.reader(proc, sys).read()
	if d.Data.TotalBytes != 22806016*4096 || d.Data.UsedBytes != (22806016-12557325)*4096 || d.Data.FreeBytes != 11915705*4096 {
		t.Fatalf("data %+v", d.Data)
	}
	if d.System.TotalBytes != 10243384*4096 || d.Backup != nil {
		t.Fatalf("system %+v backup %+v", d.System, d.Backup)
	}
	want := map[protocol.HostDiskPartKey]int64{"containers": 19280044032, "whombat": 20501757952 - 17369845760,
		"work": 17369845760, "database": 107687936}
	got := partsOf(d)
	if len(got) != len(want) {
		t.Fatal(got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %d, want %d", k, got[k], v)
		}
	}
	// In the contract's order.
	var keys []protocol.HostDiskPartKey
	for _, p := range d.Data.Parts {
		keys = append(keys, p.Key)
	}
	if !slices.Equal(keys, []protocol.HostDiskPartKey{"containers", "whombat", "work", "database"}) {
		t.Fatal(keys)
	}
}

func TestDiskParts(t *testing.T) {
	q := "fs/btrfs/" + devUUID + "/qgroups/"
	t.Run("counts being recounted", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		tree(t, sys, map[string]string{q + "inconsistent": "1\n"})
		if d := fs.reader(proc, sys).read(); d.Data.Parts != nil || d.Data.UsedBytes == 0 {
			t.Fatal(d.Data)
		}
	})
	t.Run("quotas off", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		if err := os.RemoveAll(filepath.Join(sys, q)); err != nil {
			t.Fatal(err)
		}
		if d := fs.reader(proc, sys).read(); d.Data.Parts != nil {
			t.Fatal(d.Data.Parts)
		}
	})
	t.Run("not btrfs", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		st := fs.statfs["/persist"]
		st.Type = unix.EXT4_SUPER_MAGIC
		fs.statfs["/persist"] = st
		if d := fs.reader(proc, sys).read(); d.Data.Parts != nil {
			t.Fatal(d.Data.Parts)
		}
	})
	t.Run("another filesystem's fsid", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		st := fs.statfs["/persist"]
		st.Fsid.Val[1] ^= 1
		fs.statfs["/persist"] = st
		if d := fs.reader(proc, sys).read(); d.Data.Parts != nil {
			t.Fatal(d.Data.Parts)
		}
	})
	t.Run("no statx subvolume ids", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		fs.subvol = map[string][2]uint64{}
		if d := fs.reader(proc, sys).read(); d.Data.Parts != nil {
			t.Fatal(d.Data.Parts)
		}
	})
	t.Run("workspaces aren't a subvolume", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		fs.subvol["/persist/whombat/workspaces"] = [2]uint64{5, 4711} // a directory of the top level
		got := partsOf(fs.reader(proc, sys).read())
		if _, ok := got["work"]; ok || got["whombat"] != 20501757952 {
			t.Fatal(got)
		}
	})
	t.Run("the workspaces' qgroup unreadable", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		if err := os.RemoveAll(filepath.Join(sys, q, "0_258")); err != nil {
			t.Fatal(err)
		}
		got := partsOf(fs.reader(proc, sys).read())
		if _, ok := got["work"]; ok {
			t.Fatal(got)
		}
		if _, ok := got["whombat"]; ok {
			t.Fatal("whombat without work would count the work folders as Whombat's", got)
		}
		if got["containers"] != 19280044032 || got["database"] != 107687936 {
			t.Fatal(got)
		}
	})
	t.Run("never more than used", func(t *testing.T) {
		fs, proc, sys := devBox(t)
		st := fs.statfs["/persist"]
		st.Bfree = st.Blocks - 5_000_000 // 20.5 GB used, the parts add up to 39.8 GB
		fs.statfs["/persist"] = st
		d := fs.reader(proc, sys).read()
		var sum int64
		for _, p := range d.Data.Parts {
			sum += p.Bytes
		}
		if len(d.Data.Parts) != 4 || sum > d.Data.UsedBytes || sum < d.Data.UsedBytes-4 {
			t.Fatalf("parts %v sum %d used %d", d.Data.Parts, sum, d.Data.UsedBytes)
		}
		// Proportionally: the containers keep their share of what the parts counted.
		const counted = 19280044032 + 20501757952 + 107687936
		want := float64(19280044032) * float64(d.Data.UsedBytes) / counted
		if c := float64(partsOf(d)["containers"]); c > want || c < want-1 {
			t.Fatal(c, want)
		}
	})
}

func TestFitParts(t *testing.T) {
	p := []protocol.HostDiskPart{{Key: "containers", Bytes: 600}, {Key: "work", Bytes: 400}}
	if got := fitParts(slices.Clone(p), 1000); !slices.Equal(got, p) {
		t.Fatal(got)
	}
	if got := fitParts(slices.Clone(p), 500); got[0].Bytes != 300 || got[1].Bytes != 200 {
		t.Fatal(got)
	}
	big := []protocol.HostDiskPart{{Key: "containers", Bytes: maxSafe}, {Key: "work", Bytes: maxSafe}}
	if got := fitParts(big, maxSafe-1); got[0].Bytes+got[1].Bytes > maxSafe-1 || got[0].Bytes < maxSafe/2-2 {
		t.Fatal(got)
	}
	if got := fitParts(slices.Clone(p), 0); got[0].Bytes != 0 || got[1].Bytes != 0 {
		t.Fatal(got)
	}
}

func TestBackupDisk(t *testing.T) {
	fs, proc, sys := devBox(t)
	fs.statfs["/persist/backup/disk"] = unix.Statfs_t{Type: unix.EXT4_SUPER_MAGIC, Bsize: 4096, Blocks: 1000, Bfree: 400, Bavail: 300}
	// The directory is there, but nothing is mounted on it: no backup disk.
	if d := fs.reader(proc, sys).read(); d.Backup != nil {
		t.Fatal(d.Backup)
	}
	tree(t, proc, map[string]string{"self/mountinfo": "93 66 0:32 / /persist rw - btrfs /dev/sdb3 rw\n" +
		"120 93 8:33 / /persist/backup/disk rw,nosymfollow - ext4 /dev/sdc1 rw\n"})
	d := fs.reader(proc, sys).read()
	if d.Backup == nil || d.Backup.TotalBytes != 4096000 || d.Backup.UsedBytes != 600*4096 || d.Backup.FreeBytes != 300*4096 {
		t.Fatal(d.Backup)
	}
	if unescapeMount(`/mnt/my\040disk`) != "/mnt/my disk" || unescapeMount(`/a\\b`) != `/a\\b` || unescapeMount(`/x\0`) != `/x\0` {
		t.Fatal("mountinfo escapes")
	}
}
