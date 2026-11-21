package disk

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeMachine: /sys/block entries, /dev files (the disk contents), a mountinfo, and a blkid that finds a
// signature on the devices listed in its script.
func fakeMachine(t *testing.T, signatures map[string]string) System {
	t.Helper()
	root := t.TempDir()
	s := System{Sys: filepath.Join(root, "sys"), Dev: filepath.Join(root, "dev"), Mountinfo: filepath.Join(root, "mountinfo"),
		Blkid: filepath.Join(root, "blkid"), Mkfs: filepath.Join(root, "mkfs.ext4"), HeadBytes: 4096}
	_ = os.MkdirAll(s.Dev, 0o755)
	script := "#!/bin/sh\ndev=\"$4\"\ncase \"$dev\" in\n"
	for name, sig := range signatures {
		script += "*/" + name + ") echo 'DEVNAME=" + name + "'; echo '" + sig + "'; exit 0;;\n"
	}
	script += "esac\nexit 2\n"
	if err := os.WriteFile(s.Blkid, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.Mkfs, []byte("#!/bin/sh\necho \"$@\" > "+filepath.Join(root, "mkfs-args")+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return s
}

func addDisk(t *testing.T, s System, name string, gib int64, opts ...string) {
	t.Helper()
	base := filepath.Join(s.Sys, "block", name)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(base, "holders"), 0o755))
	ro, dev := "0", "252:"+name[len(name)-1:]
	must(os.WriteFile(filepath.Join(base, "size"), []byte(itoa(gib*2*1024*1024)), 0o644))
	contents := make([]byte, 4096)
	for _, o := range opts {
		switch o {
		case "ro":
			ro = "1"
		case "part":
			must(os.MkdirAll(filepath.Join(base, name+"1"), 0o755))
			must(os.WriteFile(filepath.Join(base, name+"1", "partition"), []byte("1"), 0o644))
		case "holder":
			must(os.WriteFile(filepath.Join(base, "holders", "dm-0"), nil, 0o644))
		case "data":
			contents[100] = 0x42
		case "mounted":
			f, _ := os.OpenFile(s.Mountinfo, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			_, _ = f.WriteString("30 1 " + dev + " / /mnt rw - ext4 /dev/" + name + " rw\n")
			f.Close()
		}
	}
	must(os.WriteFile(filepath.Join(base, "ro"), []byte(ro), 0o644))
	must(os.WriteFile(filepath.Join(base, "dev"), []byte(dev), 0o644))
	must(os.WriteFile(filepath.Join(s.Dev, name), contents, 0o644))
}

func itoa(n int64) string {
	b := []byte{}
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if len(b) == 0 {
		return "0"
	}
	return string(b)
}

func TestOnlyTheOneEmptyDiskIsFormatted(t *testing.T) {
	s := fakeMachine(t, map[string]string{"vdc": "TYPE=crypto_LUKS"})
	_ = os.WriteFile(s.Mountinfo, nil, 0o644)
	addDisk(t, s, "vda", 32, "part")   // the system disk
	addDisk(t, s, "vdc", 64)           // LUKS /persist
	addDisk(t, s, "vdd", 8, "data")    // not zero at the start
	addDisk(t, s, "vde", 8, "ro")      // read-only
	addDisk(t, s, "vdf", 8, "holder")  // part of something
	addDisk(t, s, "vdg", 8, "mounted") // mounted whole
	addDisk(t, s, "vdh", 0)            // too small
	addDisk(t, s, "loop0", 8)          // not a disk
	disks, err := s.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, d := range disks {
		reasons[d.Name] = d.Reason
	}
	want := map[string]string{"vda": "has partitions", "vdc": "not empty (TYPE=crypto_LUKS)", "vdd": "not empty (data at its start)",
		"vde": "read-only", "vdf": "in use", "vdg": "mounted", "vdh": "smaller than 1 GiB"}
	for n, w := range want {
		if reasons[n] != w {
			t.Fatalf("%s: %q, want %q (%v)", n, reasons[n], w, reasons)
		}
	}
	if _, ok := reasons["loop0"]; ok {
		t.Fatal("loop device listed")
	}
	if _, err := s.Init(context.Background(), 954, 954); err == nil || !strings.HasPrefix(err.Error(), "No empty disk") {
		t.Fatalf("%v", err)
	}
	addDisk(t, s, "vdb", 16)
	dev, err := s.Init(context.Background(), 954, 954)
	if err != nil || dev != filepath.Join(s.Dev, "vdb") {
		t.Fatalf("%s %v", dev, err)
	}
	args, _ := os.ReadFile(filepath.Join(filepath.Dir(s.Sys), "mkfs-args"))
	if !strings.Contains(string(args), "-L WHOMBAT-BACKUP") || !strings.Contains(string(args), "root_owner=954:954") ||
		!strings.HasSuffix(strings.TrimSpace(string(args)), "/vdb") {
		t.Fatalf("mkfs %s", args)
	}
	addDisk(t, s, "vdi", 16)
	if _, err := s.Init(context.Background(), 954, 954); err == nil || !strings.Contains(err.Error(), "vdb, vdi") {
		t.Fatalf("two empty disks: %v", err)
	}
}
