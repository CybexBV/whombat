package macos

import (
	"errors"
	"regexp"
	"strings"

	"rackoon/internal/proto"
)

// DiskList is `diskutil list -plist`: the whole disks and how APFS
// containers sit on them.
type DiskList struct {
	WholeDisks []string
	// Containers: APFS container ("disk3") -> the whole disks holding it
	// ("disk0"), from its physical stores.
	Containers map[string][]string
	// Volumes: mounted volume ("disk3s1") -> its mount point.
	Volumes map[string]string
}

var (
	diskIDRe    = regexp.MustCompile(`^disk[0-9]+$`)
	sliceRe     = regexp.MustCompile(`^(disk[0-9]+)(s[0-9]+)+$`)
	devSliceRe  = regexp.MustCompile(`^/dev/(disk[0-9]+)(?:s[0-9]+)*$`)
	maxDiskList = 256
)

// WholeDiskOf is the whole disk of a slice ("disk3s1s1" -> "disk3"), or
// the name itself.
func WholeDiskOf(id string) string {
	if m := sliceRe.FindStringSubmatch(id); m != nil {
		return m[1]
	}
	return id
}

// ContainerOfDevice is the whole disk ("disk3") of a mounted device
// ("/dev/disk3s3s1"), "" for anything else (devfs, map auto_home, a
// network share).
func ContainerOfDevice(dev string) string {
	if m := devSliceRe.FindStringSubmatch(dev); m != nil {
		return m[1]
	}
	return ""
}

// ParseDiskutilList reads `diskutil list -plist`.
func ParseDiskutilList(b []byte) (*DiskList, error) {
	v, err := ParsePlist(b)
	if err != nil {
		return nil, err
	}
	d := asDict(v)
	if d == nil {
		return nil, errors.New("diskutil list: not a dictionary")
	}
	l := &DiskList{Containers: map[string][]string{}, Volumes: map[string]string{}}
	for _, w := range d.strings("WholeDisks") {
		if diskIDRe.MatchString(w) && len(l.WholeDisks) < maxDiskList {
			l.WholeDisks = append(l.WholeDisks, w)
		}
	}
	for _, it := range d.list("AllDisksAndPartitions") {
		e := asDict(it)
		id := e.str("DeviceIdentifier")
		if !diskIDRe.MatchString(id) {
			continue
		}
		if stores := e.list("APFSPhysicalStores"); stores != nil {
			var whole []string
			seen := map[string]bool{}
			for _, s := range stores {
				if w := WholeDiskOf(asDict(s).str("DeviceIdentifier")); diskIDRe.MatchString(w) && !seen[w] {
					seen[w] = true
					whole = append(whole, w)
				}
			}
			l.Containers[id] = whole
		}
		for _, key := range []string{"APFSVolumes", "Partitions"} {
			for _, vol := range e.list(key) {
				vd := asDict(vol)
				if mp := vd.str("MountPoint"); mp != "" && len(l.Volumes) < 4*maxDiskList {
					l.Volumes[vd.str("DeviceIdentifier")] = mp
				}
			}
		}
		if mp := e.str("MountPoint"); mp != "" {
			l.Volumes[id] = mp
		}
	}
	return l, nil
}

// IsContainer reports whether a whole disk is a synthesized APFS
// container (its space is counted on the physical disks below it).
func (l *DiskList) IsContainer(id string) bool {
	_, ok := l.Containers[id]
	return ok
}

// DiskInfo is `diskutil info -plist <disk>` of a whole disk.
type DiskInfo struct {
	Device             string // "disk0"
	MediaName          string
	Bus                string // "Apple Fabric", "PCI-Express", "USB", "SATA", "Disk Image"
	Internal           bool
	InternalKnown      bool
	SolidState         bool
	SolidStateKnown    bool
	Virtual            bool // a disk image or a synthesized container
	ParentWholeDisk    string
	APFSContainer      string
	APFSPhysicalStores []string // whole physical disk identifiers ("disk0")
	RAIDMaster         bool
	RAIDSlice          bool
	CoreStorage        bool
	Size               uint64
	SMARTStatus        string // "Verified", "Failing", "Not Supported", ""
	SMART              map[string]int64
}

// ParseDiskutilInfo reads `diskutil info -plist`.
func ParseDiskutilInfo(b []byte) (*DiskInfo, error) {
	v, err := ParsePlist(b)
	if err != nil {
		return nil, err
	}
	d := asDict(v)
	if d == nil {
		return nil, errors.New("diskutil info: not a dictionary")
	}
	di := &DiskInfo{
		Device:          d.str("DeviceIdentifier"),
		MediaName:       clip(strings.TrimSpace(d.str("MediaName")), 128),
		Bus:             clip(d.str("BusProtocol"), 64),
		ParentWholeDisk: d.str("ParentWholeDisk"),
		APFSContainer:   d.str("APFSContainerReference"),
		SMARTStatus:     clip(strings.TrimSpace(d.str("SMARTStatus")), 64),
	}
	di.Internal, di.InternalKnown = d.bool("Internal")
	di.SolidState, di.SolidStateKnown = d.bool("SolidState")
	di.RAIDMaster, _ = d.bool("RAIDMaster")
	di.RAIDSlice, _ = d.bool("RAIDSlice")
	di.CoreStorage = d.str("CoreStorageLogicalVolumeUUID") != "" || d.str("Content") == "Apple_CoreStorage"
	di.Virtual = d.str("VirtualOrPhysical") == "Virtual" || di.Bus == "Disk Image" || di.APFSContainer == di.Device && di.Device != ""
	if stores := d.list("APFSPhysicalStores"); len(stores) > 0 {
		seen := map[string]bool{}
		for _, s := range stores {
			sd := asDict(s)
			raw := sd.str("APFSPhysicalStore")
			if raw == "" {
				raw = sd.str("DeviceIdentifier")
			}
			if w := WholeDiskOf(raw); diskIDRe.MatchString(w) && !seen[w] {
				seen[w] = true
				di.APFSPhysicalStores = append(di.APFSPhysicalStores, w)
			}
		}
	}
	for _, k := range []string{"TotalSize", "Size", "IOKitSize"} {
		if n, ok := d.int(k); ok && n > 0 {
			di.Size = uint64(n)
			break
		}
	}
	if sm := d.dict("SMARTDeviceSpecificKeysMayVaryNotGuaranteed"); len(sm) > 0 {
		di.SMART = map[string]int64{}
		for k, v := range sm {
			if n, ok := v.(int64); ok {
				di.SMART[k] = n
			}
		}
	}
	return di, nil
}

// SmartPassed maps diskutil's SMART verdict: Verified passed; Failing (or
// any other verdict) failed; "Not Supported" or none is unknown (a USB
// enclosure that doesn't pass SMART through says nothing about the disk).
func SmartPassed(status string) *bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "verified":
		return ptr(true)
	case "", "not supported", "unsupported":
		return nil
	}
	return ptr(false)
}

// NVMe data units are 1000 blocks of 512 bytes.
const nvmeDataUnit = 512 * 1000

// Disk turns the info into the report's disk.
func (di *DiskInfo) Disk() proto.Disk {
	d := proto.Disk{Device: di.Device, Model: di.MediaName, CapacityBytes: di.Size}
	switch {
	case di.SolidStateKnown && !di.SolidState:
		d.Type = "hdd"
	case di.SolidStateKnown && di.SolidState:
		if di.Bus == "Apple Fabric" || di.Bus == "PCI-Express" || di.Bus == "PCI" || strings.Contains(strings.ToLower(di.Bus), "nvme") {
			d.Type = "nvme"
		} else {
			d.Type = "ssd"
		}
	case di.Internal && (di.Bus == "Apple Fabric" || strings.Contains(strings.ToLower(di.Bus), "nvme")):
		d.Type = "nvme"
	}
	d.SmartPassed = SmartPassed(di.SMARTStatus)
	s := di.SMART
	u := func(k string) *uint64 {
		if v, ok := s[k]; ok && v >= 0 {
			n := uint64(v)
			return &n
		}
		return nil
	}
	f := func(k string) *float64 {
		if v, ok := s[k]; ok && v >= 0 {
			x := float64(v)
			return &x
		}
		return nil
	}
	if s != nil {
		d.WearPct = f("PERCENTAGE_USED")
		if w := u("DATA_UNITS_WRITTEN_0"); w != nil {
			n := *w * nvmeDataUnit
			d.WrittenBytes = &n
		}
		d.PowerOnHours = u("POWER_ON_HOURS_0")
		d.MediaErrors = u("MEDIA_ERRORS_0")
		d.UnsafeShutdowns = u("UNSAFE_SHUTDOWNS_0")
		d.ErrorLogCount = u("NUM_ERROR_INFO_LOG_ENTRIES_0")
		d.SparePct = f("AVAILABLE_SPARE")
		d.SpareThreshold = f("AVAILABLE_SPARE_THRESHOLD")
		d.CriticalWarning = u("CRITICAL_WARNING")
		// NVMe reports Kelvin.
		if k, ok := s["TEMPERATURE"]; ok && k > 200 && k < 450 {
			c := float64(k - 273)
			d.TempC = &c
		}
	}
	return d
}
