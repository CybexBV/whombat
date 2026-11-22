package installer

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
)

// MinDiskBytes is the smallest disk the appliance installs on (CG-34: 110 GiB, so the SSDs sold as 120 GB and
// 128 GB in small machines fit; it was 128 GiB, CG-13).
const MinDiskBytes = 110 << 30

// Disk is one whole disk as the page lists it.
type Disk struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Model     string `json:"model"`
	SizeBytes int64  `json:"sizeBytes"`
	Eligible  bool   `json:"eligible"`
	Reason    string `json:"reason"` // "" | too-small | installer-medium | in-use | usb
	// Empty: no partitions and no file system on it, so erasing it loses nothing; the page then asks for a button
	// press instead of the disk's name typed. Parts is what is on a disk that isn't empty, for the page to say.
	Empty bool   `json:"empty"`
	Parts []Part `json:"parts"`
}

// Part is one partition on a disk (or the disk's own file system when it has no partitions): its label and file
// system type as blkid found them ("" when none), cleaned for display.
type Part struct {
	Label     string `json:"label"`
	FSType    string `json:"fsType"`
	SizeBytes int64  `json:"sizeBytes"`
}

// maxParts bounds what a disk's list carries; the page names a few and counts the rest.
const maxParts = 16

// lsblk --json --bytes --tree --output NAME,PATH,TYPE,SIZE,MODEL,MOUNTPOINTS,LABEL,FSTYPE,RO,TRAN
type blockDev struct {
	Name        string      `json:"name"`
	Path        string      `json:"path"`
	Type        string      `json:"type"`
	Size        json.Number `json:"size"`
	Model       *string     `json:"model"`
	Mountpoints []*string   `json:"mountpoints"`
	Label       *string     `json:"label"`
	FSType      *string     `json:"fstype"`
	RO          any         `json:"ro"`
	Tran        *string     `json:"tran"`
	Children    []blockDev  `json:"children"`
}

// LsblkArgs are the arguments ParseDisks expects the output of.
var LsblkArgs = []string{"--json", "--bytes", "--tree", "--output", "NAME,PATH,TYPE,SIZE,MODEL,MOUNTPOINTS,LABEL,FSTYPE,RO,TRAN"}

// ParseDisks turns lsblk's JSON into the page's disk list: whole disks only (no partitions, ROMs, loop, zram or
// RAM disks), each with whether it may be erased. Not eligible, in this order: the medium the installer runs from
// (a file system labelled mediumLabel, or mounted at /iso, anywhere on it), a disk in use (anything on it mounted,
// active swap, a device-mapper, LVM or RAID device on top of it, or read-only), a disk on USB (a stick or an
// external drive, never the machine's own disk; CG-34), a disk under MinDiskBytes.
func ParseDisks(data []byte, mediumLabel string) ([]Disk, error) {
	return parseDisks(data, mediumLabel, MinDiskBytes)
}

func parseDisks(data []byte, mediumLabel string, minimum int64) ([]Disk, error) {
	var doc struct {
		BlockDevices []blockDev `json:"blockdevices"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	out := []Disk{}
	for _, d := range doc.BlockDevices {
		if d.Type != "disk" || strings.HasPrefix(d.Name, "zram") || strings.HasPrefix(d.Name, "ram") ||
			strings.HasPrefix(d.Name, "loop") || d.Path == "" || !strings.HasPrefix(d.Path, "/dev/") {
			continue
		}
		size, err := d.Size.Int64()
		if err != nil {
			continue
		}
		disk := Disk{Path: screen.Clean(d.Path), Name: screen.Clean(d.Name), SizeBytes: size, Parts: parts(d, size)}
		disk.Empty = len(disk.Parts) == 0
		if d.Model != nil {
			disk.Model = strings.TrimSpace(screen.CleanName(*d.Model))
		}
		switch {
		case medium(d, mediumLabel):
			disk.Reason = "installer-medium"
		case inUse(d, true):
			disk.Reason = "in-use"
		case d.Tran != nil && *d.Tran == "usb":
			disk.Reason = "usb"
		case size < minimum:
			disk.Reason = "too-small"
		default:
			disk.Eligible = true
		}
		out = append(out, disk)
	}
	return out, nil
}

// CheckDisk uses the same exclusions as the page for a shell install. path must
// already be canonical; partitions and devices absent from the inventory fail.
func CheckDisk(data []byte, path, mediumLabel string, minimum int64) error {
	disks, err := parseDisks(data, mediumLabel, minimum)
	if err != nil {
		return err
	}
	for _, disk := range disks {
		if disk.Path != path {
			continue
		}
		if !disk.Eligible {
			return fmt.Errorf("%s cannot be erased: %s", path, disk.Reason)
		}
		return nil
	}
	return fmt.Errorf("%s is not a whole installation disk", path)
}

// parts is what is on a disk: its partitions, or its own file system when it has no partition table. A disk with
// neither is empty, as far as anyone can tell without reading its blocks.
func parts(d blockDev, size int64) []Part {
	text := func(p *string) string {
		if p == nil {
			return ""
		}
		return strings.TrimSpace(screen.CleanName(*p))
	}
	out := []Part{}
	for _, c := range d.Children {
		if c.Type != "part" {
			continue
		}
		n, _ := c.Size.Int64()
		out = append(out, Part{Label: text(c.Label), FSType: text(c.FSType), SizeBytes: n})
	}
	if len(out) == 0 && (text(d.FSType) != "" || len(d.Children) > 0) {
		// A file system, LVM or RAID member on the whole disk, or a device on top of it.
		out = append(out, Part{Label: text(d.Label), FSType: text(d.FSType), SizeBytes: size})
	}
	if len(out) > maxParts {
		out = out[:maxParts]
	}
	return out
}

func medium(d blockDev, label string) bool {
	if label != "" && d.Label != nil && *d.Label == label {
		return true
	}
	for _, m := range d.Mountpoints {
		if m != nil && *m == "/iso" {
			return true
		}
	}
	for _, c := range d.Children {
		if medium(c, label) {
			return true
		}
	}
	return false
}

func inUse(d blockDev, top bool) bool {
	for _, m := range d.Mountpoints {
		if m != nil && *m != "" {
			return true
		}
	}
	if top && isTrue(d.RO) {
		return true
	}
	switch {
	case !top && (d.Type == "lvm" || d.Type == "crypt" || d.Type == "dm" || d.Type == "mpath" || strings.HasPrefix(d.Type, "raid")):
		return true
	}
	for _, c := range d.Children {
		if inUse(c, false) {
			return true
		}
	}
	return false
}

// lsblk writes RO as a boolean (util-linux ≥ 2.37) or as "0"/"1" (older).
func isTrue(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x == "1" || x == "true"
	case float64:
		return x != 0
	}
	return false
}
