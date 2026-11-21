package collect

import (
	"errors"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestParseLsblkAndFilter(t *testing.T) {
	devs, err := parseLsblk(readTestdata(t, "lsblk.json"))
	if err != nil {
		t.Fatal(err)
	}
	var phys []string
	for i := range devs {
		if isPhysicalDisk(&devs[i]) {
			phys = append(phys, devs[i].kname()+":"+diskType(&devs[i]))
		}
	}
	want := "sda:hdd,sdb:hdd,nvme1n1:nvme,nvme2n1:nvme,nvme0n1:nvme"
	if got := strings.Join(phys, ","); got != want {
		t.Errorf("physical disks = %s, want %s", got, want)
	}
	// Old lsblk (< 2.37) prints sizes and flags as strings.
	old := []byte(`{"blockdevices": [{"name":"sda","kname":"sda","maj:min":"8:0","type":"disk","size":"500107862016","model":"Samsung SSD 870 EVO 500GB","serial":"X","rota":"0","tran":"sata","vendor":"ATA     "}]}`)
	devs, err = parseLsblk(old)
	if err != nil || devs[0].Size != 500107862016 || bool(devs[0].Rota) || diskType(&devs[0]) != "ssd" {
		t.Errorf("old lsblk: %+v %v", devs, err)
	}
}

func TestParseZpool(t *testing.T) {
	pools := parseZpoolList(readTestdata(t, "zpool_list.txt"))
	if len(pools) != 3 || pools[2].Name != "tank" || pools[2].Size != 3951369912320 || pools[2].Health != "ONLINE" {
		t.Fatalf("zpool list: %+v", pools)
	}
	lay := parseZpoolStatus(readTestdata(t, "zpool_status.txt"))
	if lay["tank"].Layout != "mirror" || lay["hdd"].Layout != "mirror" || lay["ci-nvme"].Layout != "stripe" {
		t.Errorf("layouts: tank=%s hdd=%s ci-nvme=%s", lay["tank"].Layout, lay["hdd"].Layout, lay["ci-nvme"].Layout)
	}
	if m := lay["hdd"].Members; len(m) != 2 || m[0].Path != "/dev/sdb1" || m[0].Class != "mirror" {
		t.Errorf("hdd members: %+v", m)
	}
	complex := []byte(`  pool: big
 state: ONLINE
config:

	NAME           STATE     READ WRITE CKSUM
	big            ONLINE       0     0     0
	  raidz2-0     ONLINE       0     0     0
	    /dev/sda1  ONLINE       0     0     0
	    /dev/sdb1  ONLINE       0     0     0
	    /dev/sdc1  ONLINE       0     0     0
	    /dev/sdd1  ONLINE       0     0     0
	  raidz2-1     ONLINE       0     0     0
	    /dev/sde1  ONLINE       0     0     0
	    /dev/sdf1  ONLINE       0     0     0
	    /dev/sdg1  ONLINE       0     0     0
	    replacing-3  DEGRADED   0     0     0
	      /dev/sdh1  FAULTED    0     0     0
	      /dev/sdi1  ONLINE     0     0     0
	special
	  mirror-2     ONLINE       0     0     0
	    /dev/nvme0n1p1  ONLINE  0     0     0
	    /dev/nvme1n1p1  ONLINE  0     0     0
	logs
	  /dev/nvme2n1p1  ONLINE       0     0     0
	cache
	  /dev/nvme3n1    ONLINE       0     0     0
	spares
	  /dev/sdj1    AVAIL

errors: No known data errors
`)
	l := parseZpoolStatus(complex)["big"]
	if l.Layout != "raidz2" {
		t.Errorf("layout %q", l.Layout)
	}
	classes := map[string]string{}
	for _, m := range l.Members {
		classes[m.Path] = m.Class
	}
	for p, c := range map[string]string{"/dev/sda1": "raidz2", "/dev/sdi1": "raidz2", "/dev/nvme0n1p1": "special", "/dev/nvme2n1p1": "log", "/dev/nvme3n1": "cache", "/dev/sdj1": "spare"} {
		if classes[p] != c {
			t.Errorf("%s class = %q, want %q", p, classes[p], c)
		}
	}
}

func TestParseMountinfoAndSwaps(t *testing.T) {
	ms := parseMountinfo(readTestdata(t, "mountinfo"))
	if len(ms) < 100 {
		t.Fatalf("only %d mounts", len(ms))
	}
	var root, efi mountEnt
	for _, m := range ms {
		switch m.MountPoint {
		case "/":
			root = m
		case "/boot/efi":
			efi = m
		}
	}
	if root.FSType != "zfs" || root.Source != "tank/ROOT/debian" {
		t.Errorf("root: %+v", root)
	}
	if efi.FSType != "vfat" || efi.Source != "/dev/nvme0n1p1" || efi.MajMin != "259:9" {
		t.Errorf("efi: %+v", efi)
	}
	esc := parseMountinfo([]byte(`40 30 8:1 / /mnt/my\040disk rw - ext4 /dev/sdb1 rw`))
	if len(esc) != 1 || esc[0].MountPoint != "/mnt/my disk" {
		t.Errorf("escaped: %+v", esc)
	}
	if sw := parseSwaps(readTestdata(t, "swaps")); len(sw) != 1 || sw[0] != "/dev/md127" {
		t.Errorf("swaps: %v", sw)
	}
}

func TestInternalMounts(t *testing.T) {
	for mp, want := range map[string]bool{
		"/": false, "/var/lib/docker": false, "/var/lib/docker/overlay2/x/merged": true,
		"/var/lib/incus": false, "/var/lib/incus/storage-pools/default/containers/c1": true,
		"/run": true, "/run/user/1000": true, "/running": false, "/srv/data/.zfs/snapshot/a": true,
		"/var/lib/lxc/100/rootfs": true, "/snap/core/1": true,
	} {
		if got := isInternalMount(mp); got != want {
			t.Errorf("isInternalMount(%q) = %v, want %v", mp, got, want)
		}
	}
}

// storageFromTestdata assembles the storage view of the sanitized capture.
func storageFromTestdata(t *testing.T) storageOut {
	t.Helper()
	devs, err := parseLsblk(readTestdata(t, "lsblk.json"))
	if err != nil {
		t.Fatal(err)
	}
	in := storageInput{
		Lsblk:    devs,
		Mounts:   parseMountinfo(readTestdata(t, "mountinfo")),
		Swaps:    parseSwaps(readTestdata(t, "swaps")),
		Zpools:   parseZpoolList(readTestdata(t, "zpool_list.txt")),
		ZpoolLay: parseZpoolStatus(readTestdata(t, "zpool_status.txt")),
		ZFSRoots: parseZFSRoots(readTestdata(t, "zfs_roots.txt")),
		Statfs: func(mount string) (statfsResult, error) {
			switch mount {
			case "/boot/efi", "/boot/efi-secondary":
				return statfsResult{Size: 1071628288, Used: 194633728}, nil
			}
			return statfsResult{}, errors.New("not mounted in test")
		},
	}
	return buildStorage(in)
}

func TestBuildStorageZFSHost(t *testing.T) {
	out := storageFromTestdata(t)
	disks := map[string]proto.Disk{}
	for _, d := range out.Disks {
		disks[d.Device] = d
	}
	if len(disks) != 5 {
		t.Fatalf("disks: %+v", out.Disks)
	}
	roles := map[string]string{
		"nvme0n1": "System · tank, mirror member · /, /boot/efi, swap",
		"nvme1n1": "System · tank, mirror member · /, /boot/efi-secondary, swap",
		"nvme2n1": "Incus storage pool · ci-nvme · /var/lib/incus",
		"sda":     "hdd, mirror member · /hdd",
		"sdb":     "hdd, mirror member · /hdd",
	}
	for dev, want := range roles {
		if got := disks[dev].Role; got != want {
			t.Errorf("%s role = %q, want %q", dev, got, want)
		}
	}
	// Mirror member: the pool allocation (scaled by the partition's share
	// of the pool size) plus the EFI partition.
	if u := disks["sda"].UsedBytes; u == nil || *u != 646636662784 {
		t.Errorf("sda used = %v", u)
	}
	if u := disks["nvme0n1"].UsedBytes; u == nil || *u < 2264002990080 || *u > 2264002990080+194633728 {
		t.Errorf("nvme0n1 used = %v", u)
	}
	if disks["nvme0n1"].Pool != "tank" || disks["nvme2n1"].Pool != "ci-nvme" || disks["sda"].Type != "hdd" || disks["nvme0n1"].Serial != "NVMESER0001" {
		t.Errorf("disk fields: %+v", disks["nvme0n1"])
	}

	pools := map[string]proto.Pool{}
	for _, p := range out.Pools {
		pools[p.Name] = p
	}
	if p := pools["tank"]; p.Layout != "mirror" || strings.Join(p.Disks, ",") != "nvme1n1,nvme0n1" || p.AllocBytes != 2264002990080 {
		t.Errorf("tank: %+v", p)
	}
	fss := map[string]proto.Filesystem{}
	for _, f := range out.Filesystems {
		fss[f.Device] = f
	}
	if f := fss["tank"]; f.Mount != "/" || f.SizeBytes != 2406112251904+1564459520000 || f.UsedBytes != 2406112251904 {
		t.Errorf("tank fs: %+v", f)
	}
	if f := fss["hdd"]; f.Mount != "/hdd" || strings.Join(f.Disks, ",") != "sda,sdb" {
		t.Errorf("hdd fs: %+v", f)
	}
	if f := fss["ci-nvme"]; f.Mount != "" || f.SizeBytes == 0 {
		t.Errorf("ci-nvme fs: %+v", f)
	}
	if f := fss["/dev/nvme0n1p1"]; f.Mount != "/boot/efi" || f.FSType != "vfat" || strings.Join(f.Disks, ",") != "nvme0n1" {
		t.Errorf("efi fs: %+v", f)
	}
	// Docker / Incus internal mounts never show up as filesystems.
	for _, f := range out.Filesystems {
		if strings.HasPrefix(f.Mount, "/var/lib/docker/") || strings.HasPrefix(f.Mount, "/var/lib/incus/") || f.FSType == "overlay" {
			t.Errorf("internal mount reported: %+v", f)
		}
	}
}

func TestBuildStorageLVMAndMD(t *testing.T) {
	// A Proxmox-style LVM install on sda plus a 2-disk md RAID1 for /srv.
	lsblk := []byte(`{"blockdevices":[
 {"name":"sda","kname":"sda","maj:min":"8:0","type":"disk","size":500107862016,"model":"Samsung SSD 870 EVO 500GB","serial":"S1","rota":false,"tran":"sata","children":[
   {"name":"sda1","kname":"sda1","maj:min":"8:1","type":"part","size":1048576},
   {"name":"sda2","kname":"sda2","maj:min":"8:2","type":"part","size":1073741824},
   {"name":"sda3","kname":"sda3","maj:min":"8:3","type":"part","size":498000000000,"children":[
     {"name":"pve-swap","kname":"dm-0","maj:min":"252:0","type":"lvm","size":8589934592},
     {"name":"pve-root","kname":"dm-1","maj:min":"252:1","type":"lvm","size":100000000000}]}]},
 {"name":"sdb","kname":"sdb","maj:min":"8:16","type":"disk","size":4000787030016,"model":"ST4000VN008","rota":true,"tran":"sata","children":[
   {"name":"sdb1","kname":"sdb1","maj:min":"8:17","type":"part","size":4000785931776,"children":[
     {"name":"md0","kname":"md0","maj:min":"9:0","type":"raid1","size":4000650000000}]}]},
 {"name":"sdc","kname":"sdc","maj:min":"8:32","type":"disk","size":4000787030016,"model":"ST4000VN008","rota":true,"tran":"sata","children":[
   {"name":"sdc1","kname":"sdc1","maj:min":"8:33","type":"part","size":4000785931776,"children":[
     {"name":"md0","kname":"md0","maj:min":"9:0","type":"raid1","size":4000650000000}]}]},
 {"name":"loop0","kname":"loop0","maj:min":"7:0","type":"loop","size":4096}
]}`)
	devs, err := parseLsblk(lsblk)
	if err != nil {
		t.Fatal(err)
	}
	mounts := parseMountinfo([]byte(`22 1 252:1 / / rw - ext4 /dev/mapper/pve-root rw
23 22 8:2 / /boot/efi rw - vfat /dev/sda2 rw
24 22 9:0 / /srv rw - xfs /dev/md0 rw
25 24 9:0 /share /export/share rw - xfs /dev/md0 rw
26 22 0:50 / /etc/pve rw - fuse /dev/fuse rw
27 22 0:60 / /var/lib/docker/overlay2/abc/merged rw - overlay overlay rw
`))
	stat := map[string]statfsResult{"/": {Size: 100e9, Used: 40e9}, "/boot/efi": {Size: 1e9, Used: 1e7}, "/srv": {Size: 4e12, Used: 1e12}}
	out := buildStorage(storageInput{
		Lsblk: devs, Mounts: mounts, Swaps: []string{"/dev/dm-0"},
		Statfs: func(m string) (statfsResult, error) {
			if s, ok := stat[m]; ok {
				return s, nil
			}
			return statfsResult{}, errors.New("x")
		},
	})
	if len(out.Disks) != 3 || len(out.Filesystems) != 3 || len(out.Pools) != 0 {
		t.Fatalf("out: %+v", out)
	}
	d := out.Disks
	if d[0].Role != "System · /, /boot/efi, swap" || d[0].Pool != "pve" || *d[0].UsedBytes != 40e9+1e7 || d[0].Type != "ssd" {
		t.Errorf("sda: %+v used=%d", d[0], *d[0].UsedBytes)
	}
	if d[1].Role != "/srv" || d[1].Pool != "md0" || *d[1].UsedBytes != 1e12 || d[1].Type != "hdd" {
		t.Errorf("sdb: %+v", d[1])
	}
	if out.Filesystems[2].Mount != "/srv" || strings.Join(out.Filesystems[2].Disks, ",") != "sdb,sdc" {
		t.Errorf("md fs: %+v", out.Filesystems[2])
	}
}

func TestLVMVG(t *testing.T) {
	for in, want := range map[string]string{"pve-root": "pve", "my--vg-data": "my-vg", "novg": ""} {
		if got := lvmVG(in); got != want {
			t.Errorf("lvmVG(%q) = %q, want %q", in, got, want)
		}
	}
}
