package winpc

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// facts is what factsScript prints.
type facts struct {
	Defender *struct {
		Service    bool   `json:"service"`
		Antivirus  bool   `json:"antivirus"`
		RealTime   bool   `json:"realtime"`
		Mode       string `json:"mode"`
		Tamper     *bool  `json:"tamper"`
		Signatures string `json:"signatures"`
		QuickScan  string `json:"quick_scan"`
	} `json:"defender"`
	SecurityCenter bool `json:"security_center"`
	Antivirus      []struct {
		Name  string `json:"name"`
		State int64  `json:"state"`
	} `json:"antivirus"`
	SystemDrive string `json:"system_drive"`
	BitLocker   []struct {
		Drive      string `json:"drive"`
		Protection int    `json:"protection"`
	} `json:"bitlocker"`
	Disks []struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Serial      string   `json:"serial"`
		Media       string   `json:"media"`
		Bus         string   `json:"bus"`
		Size        int64    `json:"size"`
		Health      string   `json:"health"`
		Temp        *float64 `json:"temp"`
		Wear        *float64 `json:"wear"`
		Hours       *float64 `json:"hours"`
		ReadErrors  *float64 `json:"read_errors"`
		WriteErrors *float64 `json:"write_errors"`
	} `json:"disks"`
	Partitions []struct {
		Drive string `json:"drive"`
		Disk  string `json:"disk"`
	} `json:"partitions"`
}

// readFacts is what the agent makes of factsScript's output.
type readFacts struct {
	defender    *proto.WindowsDefender
	sc          bool
	antivirus   []proto.WindowsAntivirus
	bitlocker   []proto.WindowsVolume
	disks       []proto.Disk
	driveDisk   map[string]string // "C:" -> "disk0"
	systemDrive string            // "C:"
}

// parseFacts reads factsScript's JSON.
func parseFacts(b []byte) (*readFacts, error) {
	var f facts
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("facts: %w", err)
	}
	out := &readFacts{sc: f.SecurityCenter, driveDisk: map[string]string{}, systemDrive: driveName(f.SystemDrive)}
	if d := f.Defender; d != nil {
		out.defender = &proto.WindowsDefender{Running: d.Service, Mode: defenderMode(d.Mode, d.Service), Antivirus: d.Antivirus,
			RealTime: d.RealTime, Tamper: d.Tamper, SignaturesAt: parseUTC(d.Signatures), QuickScanAt: parseUTC(d.QuickScan)}
	}
	for _, a := range f.Antivirus {
		name := clip(a.Name, 80)
		if name == "" {
			continue
		}
		on, current := productState(a.State)
		out.antivirus = append(out.antivirus, proto.WindowsAntivirus{Name: name, On: on, UpToDate: current})
	}
	if f.BitLocker != nil {
		out.bitlocker = []proto.WindowsVolume{}
		for _, v := range f.BitLocker {
			d := driveName(v.Drive)
			if d == "" {
				continue
			}
			p := proto.BitLockerUnknown
			switch v.Protection {
			case 0:
				p = proto.BitLockerOff
			case 1:
				p = proto.BitLockerOn
			}
			out.bitlocker = append(out.bitlocker, proto.WindowsVolume{Drive: d, Protection: p, System: d == out.systemDrive})
		}
		slices.SortFunc(out.bitlocker, func(a, b proto.WindowsVolume) int { return strings.Compare(a.Drive, b.Drive) })
	}
	for _, p := range f.Partitions {
		if d := driveName(p.Drive); d != "" && p.Disk != "" {
			out.driveDisk[d] = "disk" + p.Disk
		}
	}
	for _, d := range f.Disks {
		if d.ID == "" {
			continue
		}
		disk := proto.Disk{Device: "disk" + d.ID, Type: diskType(d.Media, d.Bus), Model: clip(d.Name, 120), Serial: clip(d.Serial, 64)}
		if d.Size > 0 {
			disk.CapacityBytes = uint64(d.Size)
		}
		if ok, known := diskHealthy(d.Health); known {
			disk.SmartPassed = &ok
		}
		if t := positive(d.Temp); t != nil && *t < 150 {
			disk.TempC = t
		}
		if w := d.Wear; w != nil && *w >= 0 && *w <= 100 && disk.Type != "hdd" {
			v := *w
			disk.WearPct = &v
		}
		disk.PowerOnHours = count(d.Hours)
		if r, w := count(d.ReadErrors), count(d.WriteErrors); r != nil || w != nil {
			var n uint64
			if r != nil {
				n += *r
			}
			if w != nil {
				n += *w
			}
			disk.Uncorrectable = &n
		}
		out.disks = append(out.disks, disk)
	}
	slices.SortFunc(out.disks, func(a, b proto.Disk) int { return strings.Compare(a.Device, b.Device) })
	return out, nil
}

// driveName is "C:" for "C", "c:" or "C:\".
func driveName(s string) string {
	s = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(s), `\`))
	s = strings.TrimSuffix(s, ":")
	if len(s) != 1 || !(s[0] >= 'A' && s[0] <= 'Z' || s[0] >= 'a' && s[0] <= 'z') {
		return ""
	}
	return strings.ToUpper(s) + ":"
}

// defenderMode reads AMRunningMode ("Normal", "Passive Mode", "SxS
// Passive Mode", "EDR Block Mode", "Not running").
func defenderMode(mode string, running bool) string {
	m := strings.ToLower(mode)
	switch {
	case strings.Contains(m, "edr"):
		return proto.DefenderEDRBlock
	case strings.Contains(m, "passive"):
		return proto.DefenderPassive
	case strings.Contains(m, "normal"):
		return proto.DefenderNormal
	case strings.Contains(m, "not running"), !running:
		return proto.DefenderOff
	}
	return ""
}

// productState reads Security Center's productState: its second byte
// says whether the product is on (0x10 or 0x11), its last whether its
// signatures are up to date (0x00).
func productState(state int64) (on, upToDate bool) {
	scan := (state >> 8) & 0xff
	return scan == 0x10 || scan == 0x11, state&0xff == 0
}

// diskType is nvme, ssd or hdd from the storage stack's media and bus
// type, by name or by number.
func diskType(media, bus string) string {
	switch strings.ToLower(strings.TrimSpace(bus)) {
	case "nvme", "17":
		return "nvme"
	}
	switch strings.ToLower(strings.TrimSpace(media)) {
	case "ssd", "4", "scm", "5":
		return "ssd"
	case "hdd", "3":
		return "hdd"
	}
	return "ssd"
}

// diskHealthy reads HealthStatus: Healthy, Warning, Unhealthy (or 0, 1,
// 2); Unknown says nothing.
func diskHealthy(h string) (ok, known bool) {
	switch strings.ToLower(strings.TrimSpace(h)) {
	case "healthy", "0":
		return true, true
	case "warning", "1", "unhealthy", "2":
		return false, true
	}
	return false, false
}

func positive(v *float64) *float64 {
	if v == nil || *v <= 0 {
		return nil
	}
	x := *v
	return &x
}

func count(v *float64) *uint64 {
	if v == nil || *v < 0 {
		return nil
	}
	n := uint64(*v)
	return &n
}

func parseUTC(s string) time.Time {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil || t.Year() < 1980 {
		return time.Time{}
	}
	return t.UTC()
}

// updatesRead is what updatesScript prints.
type updatesRead struct {
	Updates []struct {
		Title      string   `json:"title"`
		KB         []string `json:"kb"`
		Severity   string   `json:"severity"`
		Categories []string `json:"categories"`
		Size       int64    `json:"size"`
	} `json:"updates"`
	Error     string `json:"error"`
	Reboot    bool   `json:"reboot"`
	Searched  string `json:"searched"`
	Installed string `json:"installed"`
	CBSReboot bool   `json:"cbs_reboot"`
	WUReboot  bool   `json:"wu_reboot"`
}

// Windows Update's categories by id (their names are in the PC's
// language).
const (
	categorySecurity = "0fa1201d-4330-4fa8-8ae9-b877473b6441" // Security Updates
	categoryCritical = "e6cf1350-c01b-414d-a61f-263d14d133b4" // Critical Updates
)

// maxUpdates bounds the waiting updates the agent keeps for the updates
// view.
const maxUpdates = 200

// windowsUpdates is what the agent makes of updatesScript's output.
type windowsUpdates struct {
	pending   *int
	security  *int
	list      []proto.PackageUpdate
	reboot    bool
	checked   time.Time
	installed time.Time
	err       string
}

// parseUpdates reads updatesScript's JSON. A search that failed leaves
// the counts unknown; the restart and the times are read on their own.
func parseUpdates(b []byte) (*windowsUpdates, error) {
	var u updatesRead
	if err := json.Unmarshal(b, &u); err != nil {
		return nil, fmt.Errorf("updates: %w", err)
	}
	out := &windowsUpdates{reboot: u.Reboot || u.CBSReboot || u.WUReboot, checked: parseUTC(u.Searched),
		installed: parseUTC(u.Installed), err: clip(u.Error, 300)}
	if u.Error == "" && u.Updates != nil {
		n, sec := 0, 0
		out.list = []proto.PackageUpdate{}
		for _, x := range u.Updates {
			title := clip(x.Title, 200)
			if title == "" {
				continue
			}
			n++
			security := strings.TrimSpace(x.Severity) != "" || slices.ContainsFunc(x.Categories, func(c string) bool {
				c = strings.ToLower(strings.TrimSpace(c))
				return c == categorySecurity || c == categoryCritical
			})
			if security {
				sec++
			}
			if len(out.list) < maxUpdates {
				pu := proto.PackageUpdate{Name: title, Security: security, Source: "Windows Update"}
				if len(x.KB) > 0 && strings.TrimSpace(x.KB[0]) != "" {
					pu.New = "KB" + strings.TrimPrefix(strings.TrimSpace(x.KB[0]), "KB")
				}
				out.list = append(out.list, pu)
			}
		}
		out.pending, out.security = &n, &sec
	}
	return out, nil
}

// rebootReason says why Windows needs a restart, for SystemInfo.
func rebootReason(u *windowsUpdates) string {
	if u == nil || !u.reboot {
		return ""
	}
	return "Windows Update needs a restart to finish"
}
