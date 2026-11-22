//go:build linux

package diskusage

import "testing"

func TestParseMountinfoClassifiesUnionFUSEAsLocal(t *testing.T) {
	raw := "40 1 0:60 / /mnt/merger rw - fuse.mergerfs /mnt/d1:/mnt/d2 rw\n" +
		"41 1 0:61 / /mnt/union rw - fuse.unionfs-fuse /mnt/d1=RW:/mnt/d2=RO rw\n" +
		"42 1 0:62 / /mnt/mhdd rw - fuse.mhddfs /mnt/d1,/mnt/d2 rw\n"
	parsed := parseMountinfo([]byte(raw))
	if len(parsed) != 3 {
		t.Fatalf("expected 3 mounts, got %d: %+v", len(parsed), parsed)
	}
	for _, m := range parsed {
		if m.Virtual || m.Remote {
			t.Errorf("%s (%s): expected local non-virtual mount, got %+v", m.MountPoint, m.FSType, m)
		}
	}
}
