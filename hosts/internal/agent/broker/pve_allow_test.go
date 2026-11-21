package broker

import (
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestPVEKeyType(t *testing.T) {
	cases := []struct {
		kind, key string
		want      pveKey
	}{
		{"vm", "memory", keyPlain},
		{"vm", "cipassword", keyPlain},
		{"vm", "scsi0", keyDisk},
		{"vm", "scsi30", keyDisk},
		{"vm", "scsi31", 0},
		{"vm", "scsi01", 0},
		{"vm", "ide3", keyDisk},
		{"vm", "ide4", 0},
		{"vm", "sata5", keyDisk},
		{"vm", "virtio15", keyDisk},
		{"vm", "virtio16", 0},
		{"vm", "efidisk0", keyEFI},
		{"vm", "efidisk1", 0},
		{"vm", "tpmstate0", keyEFI},
		{"vm", "net31", keyNet},
		{"vm", "net32", 0},
		{"vm", "ipconfig7", keyPlain},
		{"vm", "serial3", keySerial},
		{"vm", "serial4", 0},
		{"vm", "unused255", keyUnused},
		{"vm", "unused256", 0},
		{"vm", "args", 0},
		{"vm", "hookscript", 0},
		{"vm", "hostpci0", 0},
		{"vm", "usb0", 0},
		{"vm", "parallel0", 0},
		{"vm", "virtiofs0", 0},
		{"vm", "affinity", 0},
		{"vm", "cicustom", 0},
		{"vm", "rootfs", 0},
		{"vm", "hostname", 0},
		{"vm", "delete", 0},
		{"vm", "digest", 0},
		{"vm", "skiplock", 0},
		{"container", "hostname", keyPlain},
		{"container", "rootfs", keyRootFS},
		{"container", "mp255", keyDisk},
		{"container", "mp256", 0},
		{"container", "features", keyFeatures},
		{"container", "unprivileged", keyCreate},
		{"container", "password", keyCreate},
		{"container", "ostemplate", keyCreate},
		{"container", "dev0", 0},
		{"container", "lxc.apparmor.profile", 0},
		{"container", "entrypoint", 0},
		{"container", "env", 0},
		{"container", "hookscript", 0},
		{"container", "scsi0", 0},
		{"container", "name", 0},
	}
	for _, tc := range cases {
		if got := pveKeyType(tc.kind, tc.key); got != tc.want {
			t.Errorf("%s %s: %d, want %d", tc.kind, tc.key, got, tc.want)
		}
	}
}

func TestPVERestricted(t *testing.T) {
	cases := []struct {
		kind, key, value string
		want             bool
	}{
		{"vm", "memory", "4096", false},
		{"vm", "args", "-cpu host", true},
		{"vm", "scsi0", "local-zfs:vm-100-disk-0,size=32G", false},
		{"vm", "scsi1", "/dev/disk/by-id/nvme-X,size=1T", true},
		{"vm", "scsi1", "file=/dev/sdb", true},
		{"vm", "serial0", "socket", false},
		{"vm", "serial0", "/dev/ttyS0", true},
		{"vm", "unused0", "local-zfs:vm-100-disk-1", false},
		{"container", "mp0", "local-zfs:subvol-200-disk-1,mp=/data", false},
		{"container", "mp0", "/mnt/data,mp=/data", true},
		{"container", "mp0", "volume=/dev/sdb1,mp=/data", true},
		{"container", "features", "nesting=1,keyctl=1", false},
		{"container", "features", "nesting=1,mount=nfs;cifs", true},
		{"container", "unprivileged", "1", true},
		{"container", "arch", "amd64", true},
		{"container", "lxc.cgroup2.devices.allow", "c 10:200 rwm", true},
	}
	for _, tc := range cases {
		if got := pveRestricted(tc.kind, tc.key, tc.value); got != tc.want {
			t.Errorf("%s %s=%s: %v, want %v", tc.kind, tc.key, tc.value, got, tc.want)
		}
	}
}

func TestCheckText(t *testing.T) {
	for v, ok := range map[string]bool{"plain": true, "naïve ünïcode ✓": true, "tab\there": false, "esc\x1b": false, "del\x7f": false,
		"c1\u0085": false, "nul\x00": false, "bad\xff": false, "cr\r": false, strings.Repeat("a", maxValueLen+1): false} {
		if err := checkText("k", v, false); (err == nil) != ok {
			t.Errorf("%q: %v", v, err)
		}
	}
	if checkText("description", "a\nb", true) != nil || checkText("name", "a\nb", false) == nil {
		t.Fatal("newlines")
	}
}

func TestSplitVolume(t *testing.T) {
	for vol, ok := range map[string]bool{
		"local:iso/debian.iso":                     true,
		"pbs:backup/vm/100/2026-10-17T01:00:00Z":   true,
		"local-zfs:vm-100-disk-0":                  true,
		"local:iso/../x":                           false,
		"local:/etc/passwd":                        false,
		"/var/lib/vz/x.iso":                        false,
		"1local:iso/x.iso":                         false,
		"local:":                                   false,
		"local:iso/x.iso,media=cdrom":              false,
		"local:iso/a b.iso":                        false,
		"local:iso/x\n.iso":                        false,
		"loc al:iso/x.iso":                         false,
		"local:iso/" + strings.Repeat("x", 600):    false,
		"nfs:import/haos_ova-16.2.qcow2":           true,
		"local:vztmpl/debian-13-standard.tar.zst":  true,
		"cephfs:snippets/hook.sh":                  true, // shape only; callers check the content
		"local:backup/vzdump-qemu-100.vma.zst.bak": true,
	} {
		if _, _, got := splitVolume(vol); got != ok {
			t.Errorf("%q: %v, want %v", vol, got, ok)
		}
	}
}

func TestCheckFirewallOption(t *testing.T) {
	for kv, code := range map[[2]string]string{
		{"enable", "1"}: "", {"enable", "true"}: proto.CodeInvalidValue, {"policy_in", "DROP"}: "", {"policy_out", "drop"}: proto.CodeInvalidValue,
		{"log_level_in", "info"}: "", {"log_level_out", "loud"}: proto.CodeInvalidValue, {"log_ratelimit", "enable=1"}: proto.CodeNotAllowed,
	} {
		err := checkFirewallOption(kv[0], kv[1])
		got := ""
		if err != nil {
			got = err.(*fieldsError).code
		}
		if got != code {
			t.Errorf("%s=%s: %q, want %q", kv[0], kv[1], got, code)
		}
	}
}

func TestCheckDownloadURL(t *testing.T) {
	for u, ok := range map[string]bool{
		"https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso": true,
		"http://10.0.0.5:8080/images/x.iso":                                    true,
		"https://example.org/x.iso?token=abc":                                  true,
		"ftp://example.org/x.iso":                                              false,
		"file:///etc/shadow":                                                   false,
		"https://user@example.org/x.iso":                                       false,
		"https://user:pass@example.org/x.iso":                                  false,
		"https://example.org/x y.iso":                                          false,
		"https:example.org/x.iso":                                              false,
		"//example.org/x.iso":                                                  false,
		"":                                                                     false,
	} {
		if err := checkDownloadURL(u); (err == nil) != ok {
			t.Errorf("%q: %v", u, err)
		}
	}
}
