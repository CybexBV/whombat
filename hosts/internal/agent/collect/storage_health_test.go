package collect

import (
	"errors"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestZpoolHealth(t *testing.T) {
	pools := parseZpoolList([]byte("tank\t3951369912320\t2241236758528\tDEGRADED\t39\nfast\t1992864825344\t434844131328\tONLINE\t-\n"))
	if pools[0].Frag == nil || *pools[0].Frag != 39 || pools[1].Frag != nil {
		t.Errorf("frag: %+v", pools)
	}
	lay := parseZpoolStatus(readTestdata(t, "zpool_status_degraded.txt"))
	tank := lay["tank"]
	if tank.ScrubState != "finished" || tank.ScrubErrors != 3 || tank.ScrubEnd.IsZero() {
		t.Errorf("tank scan: %q %d %v", tank.ScrubState, tank.ScrubErrors, tank.ScrubEnd)
	}
	if want := time.Date(2026, 10, 4, 0, 28, 20, 0, time.Local).UTC(); !tank.ScrubEnd.Equal(want) {
		t.Errorf("scrub end %v, want %v", tank.ScrubEnd, want)
	}
	if tank.Read != 12 || tank.Write != 3 || tank.Cksum != 2 {
		t.Errorf("errors: %d %d %d", tank.Read, tank.Write, tank.Cksum)
	}
	if strings.Join(tank.Faulted, ",") != "sdb1,11893473632745728734" {
		t.Errorf("faulted: %v", tank.Faulted)
	}
	if !strings.HasPrefix(tank.Status, "One or more devices could not be used because the label is missing or invalid. Sufficient") || strings.Contains(tank.Status, "Replace") {
		t.Errorf("status: %q", tank.Status)
	}
	if tank.Layout != "raidz1" || len(tank.Members) != 5 {
		t.Errorf("layout still parsed: %q %+v", tank.Layout, tank.Members)
	}
	if f := lay["fast"]; f.ScrubState != "scanning" || f.Status != "" || len(f.Faulted) != 0 {
		t.Errorf("fast: %+v", f)
	}
	if n := lay["new"]; n.ScrubState != "none" || !strings.HasPrefix(n.Status, "Some supported and requested features") {
		t.Errorf("new: %+v", n)
	}
	if o := lay["old"]; o.ScrubState != "canceled" || o.ScrubEnd.IsZero() {
		t.Errorf("old: %+v", o)
	}
	// Healthy pools.
	ok := parseZpoolStatus(readTestdata(t, "zpool_status.txt"))["hdd"]
	if ok.ScrubState != "finished" || ok.ScrubErrors != 0 || ok.Read+ok.Write+ok.Cksum != 0 || len(ok.Faulted) != 0 || ok.Status != "" {
		t.Errorf("hdd: %+v", ok)
	}
	// Into the report.
	out := buildStorage(storageInput{Zpools: pools[:1], ZpoolLay: lay})
	p := out.Pools[0]
	if p.ScrubState != "finished" || p.ReadErrors != 12 || p.CksumErrors != 2 || len(p.Faulted) != 2 || p.FragPct == nil || p.Status == "" {
		t.Errorf("pool: %+v", p)
	}
}

func TestFilesystemHealth(t *testing.T) {
	mounts := parseMountinfo([]byte(strings.Join([]string{
		"30 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 ro,errors=remount-ro",
		"31 30 259:3 / /srv rw,relatime shared:2 - xfs /dev/nvme0n1p3 rw,attr2",
		"32 30 259:4 / /data ro,relatime shared:3 - ext4 /dev/nvme0n1p4 ro",
		"33 30 259:5 / /media ro,relatime shared:4 - ext4 /dev/nvme0n1p5 ro",
		"34 30 0:50 / /mnt/nas rw,relatime shared:5 - nfs4 nas:/export rw,vers=4.2",
		"35 30 0:51 / /mnt/hung rw,relatime shared:6 - cifs //nas/share rw",
		"36 30 0:52 / /var/log rw,relatime shared:7 - tmpfs tmpfs rw,size=131072k",
		"37 30 0:53 / /tmp rw,relatime shared:8 - tmpfs tmpfs rw",
		"38 30 0:54 / /snap/core/1 ro,relatime shared:9 - squashfs /dev/loop0 ro",
		"39 30 0:55 / /mnt/btr rw,relatime shared:10 - btrfs /dev/sdz1 rw",
	}, "\n")))
	in := storageInput{
		Mounts: mounts,
		Fstab:  parseFstab([]byte("# comment\nUUID=1 / ext4 errors=remount-ro 0 1\n/dev/nvme0n1p4 /data ext4 ro 0 2\nnas:/export /mnt/nas nfs4 defaults 0 0\n")),
		SeenRW: map[string]bool{"/media": true},
		Unraid: true,
		Statfs: func(m string) (statfsResult, error) {
			if m == "/mnt/hung" {
				return statfsResult{}, errors.New("statfs /mnt/hung: timed out after 5s")
			}
			return statfsResult{Size: 1000, Used: 400, Inodes: 100, InodesFree: 75}, nil
		},
	}
	fs := map[string]proto.Filesystem{}
	for _, f := range buildStorage(in).Filesystems {
		fs[f.Mount] = f
	}
	// / was remounted read-only by the kernel (superblock "ro"), fstab says rw.
	if r := fs["/"]; !r.ReadOnly || r.InodesTotal != 100 || r.InodesUsed != 25 {
		t.Errorf("/: %+v", r)
	}
	if fs["/srv"].ReadOnly || fs["/data"].ReadOnly {
		t.Errorf("rw / ro-by-fstab: %+v %+v", fs["/srv"], fs["/data"])
	}
	// Not in fstab, but this agent saw it read-write before.
	if !fs["/media"].ReadOnly {
		t.Errorf("/media: %+v", fs["/media"])
	}
	if n := fs["/mnt/nas"]; !n.Remote || n.Device != "nas:/export" || n.SizeBytes != 1000 || n.Error != "" {
		t.Errorf("nfs: %+v", n)
	}
	if h, ok := fs["/mnt/hung"]; !ok || !h.Remote || h.SizeBytes != 0 || !strings.Contains(h.Error, "timed out") {
		t.Errorf("hung cifs: %+v", h)
	}
	if l, ok := fs["/var/log"]; !ok || l.FSType != "tmpfs" {
		t.Errorf("unraid /var/log: %+v", l)
	}
	if _, ok := fs["/tmp"]; ok {
		t.Error("other tmpfs reported")
	}
	if _, ok := fs["/snap/core/1"]; ok {
		t.Error("squashfs reported")
	}
	if b := fs["/mnt/btr"]; b.InodesTotal != 0 {
		t.Errorf("btrfs has no inode count: %+v", b)
	}
	in.Unraid = false
	for _, f := range buildStorage(in).Filesystems {
		if f.Mount == "/var/log" {
			t.Error("tmpfs /var/log outside Unraid")
		}
	}
}

// The agent's sandbox makes every mount read-only per mount (the
// superblock stays rw) and covers /home: neither may show up as a problem.
func TestSandboxMounts(t *testing.T) {
	ms := parseMountinfo([]byte(strings.Join([]string{
		"3854 872 0:27 / / ro,nosuid,relatime shared:559 master:1 - zfs tank/ROOT/debian rw,xattr,posixacl",
		"3950 3854 259:3 / /data ro,nosuid,relatime shared:2368 master:143 - ext4 /dev/nvme0n1p3 rw",
		"3960 3854 259:4 / /home ro,relatime shared:2369 master:144 - ext4 /dev/nvme0n1p4 rw",
		"3961 3960 0:60 / /home/u/nas rw,relatime shared:2370 master:145 - nfs4 nas:/u rw",
		"4020 3960 0:25 /systemd/inaccessible/dir /home ro,nosuid,nodev,noexec shared:2600 master:5 - tmpfs tmpfs rw,mode=755",
	}, "\n")))
	vis := visibleMounts(ms)
	var mps []string
	for _, m := range vis {
		mps = append(mps, m.MountPoint+"("+m.FSType+")")
	}
	if strings.Join(mps, ",") != "/(zfs),/data(ext4),/home(tmpfs)" {
		t.Errorf("visible: %v", mps)
	}
	out := buildStorage(storageInput{Mounts: vis, Fstab: map[string]string{"/data": "defaults"},
		Statfs: func(string) (statfsResult, error) { return statfsResult{Size: 10, Used: 1}, nil }})
	for _, f := range out.Filesystems {
		if f.ReadOnly || f.Remote || f.Mount == "/home/u/nas" {
			t.Errorf("sandbox artefact reported: %+v", f)
		}
	}
}

// On a host's own mount table only the binfmt_misc automount point is
// covered (by binfmt_misc itself).
func TestVisibleMountsHost(t *testing.T) {
	ms := parseMountinfo(readTestdata(t, "mountinfo"))
	v := visibleMounts(ms)
	if len(v) != len(ms)-1 {
		t.Fatalf("visible %d of %d", len(v), len(ms))
	}
	for _, m := range v {
		if m.FSType == "autofs" {
			t.Errorf("covered automount kept: %+v", m)
		}
	}
}
