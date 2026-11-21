package collect

import (
	"os"
	"path/filepath"
	"testing"
)

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// writeTree creates files (path -> content) below dir.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestParseOSRelease(t *testing.T) {
	name, ver, pretty := parseOSRelease(readTestdata(t, "os-release-debian"))
	if name != "Debian GNU/Linux" || ver != "13" || pretty != "Debian GNU/Linux 13 (trixie)" {
		t.Errorf("debian: %q %q %q", name, ver, pretty)
	}
	ubuntu := []byte(`PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
`)
	name, ver, pretty = parseOSRelease(ubuntu)
	if name != "Ubuntu" || ver != "24.04 LTS" || pretty != "Ubuntu 24.04.1 LTS" {
		t.Errorf("ubuntu: %q %q %q", name, ver, pretty)
	}
	nixos := []byte("NAME=NixOS\nVERSION_ID=\"26.05\"\nPRETTY_NAME=\"NixOS 26.05 (Yarara)\"\n")
	if name, ver, _ = parseOSRelease(nixos); name != "NixOS" || ver != "26.05" {
		t.Errorf("nixos: %q %q", name, ver)
	}
}

func TestShortCPUModel(t *testing.T) {
	cases := map[string]string{
		"AMD Ryzen Threadripper 9970X 32-Cores":          "Ryzen Threadripper 9970X",
		"AMD Ryzen Threadripper PRO 7995WX 96-Cores":     "Ryzen Threadripper PRO 7995WX",
		"AMD EPYC 7443P 24-Core Processor":               "EPYC 7443P",
		"AMD EPYC 9124 16-Core Processor":                "EPYC 9124",
		"AMD Ryzen 9 7950X 16-Core Processor":            "Ryzen 9 7950X",
		"AMD Ryzen 7 5800H with Radeon Graphics":         "Ryzen 7 5800H",
		"12th Gen Intel(R) Core(TM) i7-12700":            "Core i7-12700",
		"13th Gen Intel(R) Core(TM) i9-13900K":           "Core i9-13900K",
		"Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz":       "Core i7-8700K",
		"Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz":       "Xeon Gold 6338",
		"Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz":      "Xeon E5-2680 v4",
		"Intel(R) Xeon(R) E-2388G CPU @ 3.20GHz":         "Xeon E-2388G",
		"Intel(R) Core(TM) Ultra 7 155H":                 "Core Ultra 7 155H",
		"Intel(R) N100":                                  "N100",
		"Intel(R) Celeron(R) CPU J1900 @ 1.99GHz":        "Celeron J1900",
		"Intel(R) Pentium(R) Silver J5005 CPU @ 1.50GHz": "Pentium Silver J5005",
		"QEMU Virtual CPU version 2.5+":                  "QEMU Virtual CPU version 2.5+",
		"":                                               "",
	}
	for in, want := range cases {
		if got := shortCPUModel(in); got != want {
			t.Errorf("shortCPUModel(%q) = %q, want %q", in, got, want)
		}
	}
	if got := shortCPUModel(cpuinfoModel(readTestdata(t, "cpuinfo"))); got != "Ryzen Threadripper 9970X" {
		t.Errorf("cpuinfo testdata: %q", got)
	}
}

func TestParseDMIMemoryType(t *testing.T) {
	if got := parseDMIMemoryType(readTestdata(t, "dmidecode_16_17.txt")); got != "DDR5 ECC" {
		t.Errorf("got %q, want DDR5 ECC", got)
	}
	// QEMU: generic "RAM" type is not a memory technology.
	qemu := []byte(`Handle 0x1000, DMI type 16, 23 bytes
Physical Memory Array
	Location: Other
	Use: System Memory
	Error Correction Type: Multi-bit ECC

Handle 0x1100, DMI type 17, 40 bytes
Memory Device
	Size: 8 GB
	Type: RAM
`)
	if got := parseDMIMemoryType(qemu); got != "" {
		t.Errorf("qemu: got %q", got)
	}
	// Non-ECC desktop; an empty slot first.
	desk := []byte(`Handle 0x0010, DMI type 16, 23 bytes
Physical Memory Array
	Error Correction Type: None

Handle 0x0011, DMI type 17, 92 bytes
Memory Device
	Total Width: Unknown
	Data Width: Unknown
	Size: No Module Installed
	Type: Unknown

Handle 0x0012, DMI type 17, 92 bytes
Memory Device
	Total Width: 64 bits
	Data Width: 64 bits
	Size: 16 GB
	Type: DDR4
`)
	if got := parseDMIMemoryType(desk); got != "DDR4" {
		t.Errorf("desktop: got %q", got)
	}
	// ECC inferred from the bus width when type 16 says nothing.
	widths := []byte(`Handle 0x0012, DMI type 17, 92 bytes
Memory Device
	Total Width: 72 bits
	Data Width: 64 bits
	Size: 32 GB
	Type: DDR4
`)
	if got := parseDMIMemoryType(widths); got != "DDR4 ECC" {
		t.Errorf("widths: got %q", got)
	}
}

func TestDefaultRouteIface(t *testing.T) {
	route := []byte(`Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth1	00000000	0102000A	0003	0	0	200	00000000	0	0	0
eth0	00000000	010200C0	0003	0	0	100	00000000	0	0	0
eth0	000200C0	00000000	0001	0	0	0	00FFFFFF	0	0	0
`)
	if got := defaultRouteIface(route); got != "eth0" {
		t.Errorf("got %q, want eth0", got)
	}
	if got := defaultRouteIface([]byte("Iface\tDestination\n")); got != "" {
		t.Errorf("no default route: got %q", got)
	}
}

func TestDpkgVersion(t *testing.T) {
	status := []byte(`Package: pve-manager-doc
Status: install ok installed
Version: 1.0

Package: pve-manager
Status: install ok installed
Priority: optional
Version: 9.2.21

Package: other
Status: deinstall ok config-files
Version: 2
`)
	if got := dpkgVersion(status, "pve-manager"); got != "9.2.21" {
		t.Errorf("got %q", got)
	}
	if got := dpkgVersion(status, "other"); got != "" {
		t.Errorf("removed package: got %q", got)
	}
}

func TestCountCoresAndThreads(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{"sys/devices/system/cpu/online": "0-3\n"}
	// 2 cores x 2 threads; cpu3 is offline.
	sib := map[int]string{0: "0,2", 1: "1,3", 2: "0,2", 3: "1,3"}
	for i, s := range sib {
		base := filepath.Join("sys/devices/system/cpu", "cpu"+string(rune('0'+i)))
		files[filepath.Join(base, "topology/core_cpus_list")] = s + "\n"
		if i > 0 {
			online := "1\n"
			if i == 3 {
				online = "0\n"
			}
			files[filepath.Join(base, "online")] = online
		}
	}
	writeTree(t, dir, files)
	r := fsRoot(dir)
	if got := countCores(r); got != 2 {
		t.Errorf("cores = %d, want 2", got)
	}
	if got := parseCPUList(r.readString("/sys/devices/system/cpu/online")); got != 4 {
		t.Errorf("threads = %d", got)
	}
}

func TestParseCPUList(t *testing.T) {
	for in, want := range map[string]int{"0-63": 64, "0": 1, "0-3,8,10-11": 7, "": 0, "4": 1} {
		if got := parseCPUList(in); got != want {
			t.Errorf("parseCPUList(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestHardwareBacked(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"sys/class/net/enp1s0/device/vendor":         "0x8086\n",
		"sys/class/net/vmbr0/brif/enp1s0/port_no":    "1\n",
		"sys/class/net/docker0/brif/veth1/port_no":   "1\n",
		"sys/class/net/veth1/ifindex":                "9\n",
		"sys/class/net/tailscale0/ifindex":           "5\n",
		"sys/class/net/bond0/bonding/slaves":         "enp1s0\n",
		"sys/class/net/vlan10/lower_bond0/ifindex":   "3\n",
		"sys/class/net/incusbr0/brif/tap123/port_no": "1\n",
	})
	r := fsRoot(dir)
	for name, want := range map[string]bool{
		"enp1s0": true, "vmbr0": true, "bond0": true, "vlan10": true,
		"docker0": false, "veth1": false, "tailscale0": false, "incusbr0": false, "lo": false,
	} {
		if got := hardwareBacked(r, name, 0); got != want {
			t.Errorf("hardwareBacked(%s) = %v, want %v", name, got, want)
		}
	}
}
