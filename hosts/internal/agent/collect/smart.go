package collect

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"rackoon/internal/proto"
)

// smartData is what the agent keeps from one SMART read of a disk.
type smartData struct {
	At      time.Time
	Model   string
	Serial  string
	Passed  *bool
	TempC   *float64
	POH     *uint64
	Wear    *float64
	Written *uint64
	Realloc *uint64
	Pending *uint64
	Uncorr  *uint64
	// TempLimit is the drive's own maximum operating temperature (SCT
	// op_limit_max), 0 when unknown.
	TempLimit float64
	Standby   bool // skipped because the disk was spun down

	SelfTest        *proto.SelfTest
	ErrorLog        *uint64
	CRC             *uint64
	CritWarning     *uint64
	Spare, SpareThr *float64
	MediaErrors     *uint64
	Unsafe          *uint64
}

// errSmartUnsupported marks a disk that has no SMART (virtual disks, most
// USB sticks and card readers, devices smartctl cannot identify). It is
// skipped, not counted as a failure.
var errSmartUnsupported = errors.New("no SMART support")

// selfTestEntry is a row of the ATA or NVMe self-test log.
type selfTestEntry struct {
	Type struct {
		Value  int    `json:"value"`
		String string `json:"string"`
	} `json:"type"`
	Status struct {
		Value  int    `json:"value"`
		String string `json:"string"`
		Passed *bool  `json:"passed"`
	} `json:"status"`
	LifetimeHours uint64 `json:"lifetime_hours"`
	// NVMe
	Code struct {
		Value  int    `json:"value"`
		String string `json:"string"`
	} `json:"self_test_code"`
	Result struct {
		Value  int    `json:"value"`
		String string `json:"string"`
	} `json:"self_test_result"`
	PowerOnHours uint64 `json:"power_on_hours"`
}

// smartctlJSON is the subset of `smartctl --json -a -l devstat` we use.
type smartctlJSON struct {
	Smartctl struct {
		ExitStatus int `json:"exit_status"`
		Messages   []struct {
			String   string `json:"string"`
			Severity string `json:"severity"`
		} `json:"messages"`
	} `json:"smartctl"`
	Device struct {
		Type     string `json:"type"`
		Protocol string `json:"protocol"`
	} `json:"device"`
	SmartSupport *struct {
		Available *bool `json:"available"`
	} `json:"smart_support"`
	ModelName        string `json:"model_name"`
	ScsiModelName    string `json:"scsi_model_name"`
	SerialNumber     string `json:"serial_number"`
	RotationRate     *int   `json:"rotation_rate"`
	LogicalBlockSize uint64 `json:"logical_block_size"`
	SmartStatus      *struct {
		Passed *bool `json:"passed"`
	} `json:"smart_status"`
	Temperature *struct {
		Current    *float64 `json:"current"`
		OpLimitMax float64  `json:"op_limit_max"`
	} `json:"temperature"`
	PowerOnTime *struct {
		Hours *uint64 `json:"hours"`
	} `json:"power_on_time"`
	NVMeLog *struct {
		CriticalWarning  *uint64     `json:"critical_warning"`
		AvailableSpare   *float64    `json:"available_spare"`
		SpareThreshold   *float64    `json:"available_spare_threshold"`
		PercentageUsed   *float64    `json:"percentage_used"`
		DataUnitsWritten json.Number `json:"data_units_written"`
		MediaErrors      *uint64     `json:"media_errors"`
		NumErrLog        *uint64     `json:"num_err_log_entries"`
		UnsafeShutdowns  *uint64     `json:"unsafe_shutdowns"`
		Temperature      *float64    `json:"temperature"`
		PowerOnHours     *uint64     `json:"power_on_hours"`
	} `json:"nvme_smart_health_information_log"`
	NVMeSelfTest *struct {
		Current struct {
			Value int `json:"value"`
		} `json:"current_self_test_operation"`
		Table []selfTestEntry `json:"table"`
	} `json:"nvme_self_test_log"`
	ATASmartData *struct {
		SelfTest struct {
			Status struct {
				Value int `json:"value"`
			} `json:"status"`
		} `json:"self_test"`
	} `json:"ata_smart_data"`
	ATASelfTest *struct {
		Standard struct {
			Table []selfTestEntry `json:"table"`
		} `json:"standard"`
	} `json:"ata_smart_self_test_log"`
	ATAErrorLog *struct {
		Summary *struct {
			Count *uint64 `json:"count"`
		} `json:"summary"`
		Extended *struct {
			Count *uint64 `json:"count"`
		} `json:"extended"`
	} `json:"ata_smart_error_log"`
	ATAAttrs *struct {
		Table []struct {
			ID    int    `json:"id"`
			Name  string `json:"name"`
			Value int    `json:"value"`
			Raw   struct {
				Value uint64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	ATADevStat *struct {
		Pages []struct {
			Number int `json:"number"`
			Table  []struct {
				Name  string `json:"name"`
				Value *int64 `json:"value"`
				Flags struct {
					Valid *bool `json:"valid"`
				} `json:"flags"`
			} `json:"table"`
		} `json:"pages"`
	} `json:"ata_device_statistics"`
	SCSIPercentUsed *float64 `json:"scsi_percentage_used_endurance_indicator"`
	SCSIGrownDefect *uint64  `json:"scsi_grown_defect_list"`
}

// remainingLifeAttrs: normalized value = percent of life remaining.
var remainingLifeAttrs = map[string]bool{
	"Wear_Leveling_Count":     true, // Samsung (id 177)
	"Media_Wearout_Indicator": true, // Intel (id 233)
	"Percent_Lifetime_Remain": true, // Crucial / Micron (id 202)
	"SSD_Life_Left":           true, // Kingston, SandForce (id 231)
	"Remaining_Lifetime_Perc": true, // WD / SanDisk (id 169)
	"Percent_Life_Remaining":  true,
}

// remainingLifeIDs restricts the names above to the ids where their
// normalized value is known to mean "remaining life".
var remainingLifeIDs = map[int]bool{177: true, 233: true, 202: true, 231: true, 169: true, 248: true}

// writtenAttrs maps written-bytes attributes to their unit (0 = logical
// block size).
var writtenAttrs = map[string]uint64{
	"Total_LBAs_Written":   0,
	"Host_Writes_32MiB":    32 << 20,
	"Host_Writes_GiB":      1 << 30,
	"Total_Writes_GiB":     1 << 30,
	"Lifetime_Writes_GiB":  1 << 30,
	"Total_Host_Writes_GB": 1 << 30,
	"Host_Writes_MiB":      1 << 20,
}

// parseSmartctl converts smartctl JSON into smartData. kind is the disk
// type (nvme | ssd | hdd) from lsblk.
func parseSmartctl(b []byte, kind string) (*smartData, error) {
	var j smartctlJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return nil, fmt.Errorf("smartctl json: %w", err)
	}
	for _, m := range j.Smartctl.Messages {
		s := strings.ToUpper(m.String)
		if strings.Contains(s, "STANDBY") || strings.Contains(s, "SLEEP") {
			return &smartData{Standby: true}, nil
		}
		if strings.Contains(s, "UNABLE TO DETECT DEVICE TYPE") || strings.Contains(s, "UNKNOWN USB BRIDGE") ||
			strings.Contains(s, "LACKS SMART CAPABILITY") {
			return nil, errSmartUnsupported
		}
	}
	if j.SmartSupport != nil && j.SmartSupport.Available != nil && !*j.SmartSupport.Available {
		return nil, errSmartUnsupported
	}
	// Exit status bits: 0 command line error, 1 device open failed (or low
	// power mode), 2 some SMART command failed, 3 "DISK FAILING", 4-7
	// attributes at / past threshold and error / self-test log entries.
	// Only bits 0-1 mean "no data"; the others describe the disk.
	if j.Smartctl.ExitStatus&0x3 != 0 {
		msg := "smartctl failed"
		for _, m := range j.Smartctl.Messages {
			if m.Severity == "error" {
				msg = m.String
				break
			}
		}
		return nil, errors.New(msg)
	}
	d := &smartData{At: time.Now(), Model: strings.TrimSpace(j.ModelName), Serial: strings.TrimSpace(j.SerialNumber)}
	if d.Model == "" {
		d.Model = strings.TrimSpace(j.ScsiModelName)
	}
	if j.SmartStatus != nil && j.SmartStatus.Passed != nil {
		d.Passed = ptr(*j.SmartStatus.Passed)
	}
	if j.Smartctl.ExitStatus&0x8 != 0 {
		d.Passed = ptr(false)
	}
	if j.Temperature != nil && j.Temperature.Current != nil && *j.Temperature.Current > 0 {
		d.TempC = ptr(*j.Temperature.Current)
		d.TempLimit = j.Temperature.OpLimitMax
	}
	if j.PowerOnTime != nil && j.PowerOnTime.Hours != nil {
		d.POH = ptr(*j.PowerOnTime.Hours)
	}
	lbs := j.LogicalBlockSize
	if lbs == 0 {
		lbs = 512
	}

	if n := j.NVMeLog; n != nil {
		if n.PercentageUsed != nil {
			d.Wear = ptr(*n.PercentageUsed)
		}
		if du, ok := parseBigUint(string(n.DataUnitsWritten)); ok {
			d.Written = ptr(du * 512000)
		}
		if n.MediaErrors != nil {
			d.Uncorr = ptr(*n.MediaErrors)
		}
		if d.TempC == nil && n.Temperature != nil && *n.Temperature > 0 {
			d.TempC = ptr(*n.Temperature)
		}
		if d.POH == nil && n.PowerOnHours != nil {
			d.POH = ptr(*n.PowerOnHours)
		}
		d.CritWarning = copyPtr(n.CriticalWarning)
		d.Spare = copyPtr(n.AvailableSpare)
		d.SpareThr = copyPtr(n.SpareThreshold)
		d.MediaErrors = copyPtr(n.MediaErrors)
		d.ErrorLog = copyPtr(n.NumErrLog)
		d.Unsafe = copyPtr(n.UnsafeShutdowns)
		if st := j.NVMeSelfTest; st != nil {
			if st.Current.Value != 0 {
				d.SelfTest = &proto.SelfTest{Type: nvmeTestType(st.Current.Value), Result: "running", PowerOnHours: derefU64(d.POH)}
			} else if len(st.Table) > 0 {
				e := st.Table[0] // newest first
				d.SelfTest = &proto.SelfTest{Type: nvmeTestType(e.Code.Value), Result: nvmeTestResult(e.Result.Value), PowerOnHours: e.PowerOnHours}
			}
		}
		return d, nil
	}

	// ATA device statistics (vendor neutral) first.
	if ds := j.ATADevStat; ds != nil {
		for _, p := range ds.Pages {
			for _, e := range p.Table {
				if e.Value == nil || (e.Flags.Valid != nil && !*e.Flags.Valid) {
					continue
				}
				switch {
				case p.Number == 7 && e.Name == "Percentage Used Endurance Indicator" && kind != "hdd":
					d.Wear = ptr(float64(*e.Value))
				case p.Number == 1 && e.Name == "Logical Sectors Written" && kind != "hdd":
					d.Written = ptr(uint64(*e.Value) * lbs)
				}
			}
		}
	}
	if a := j.ATAAttrs; a != nil {
		for _, at := range a.Table {
			raw := at.Raw.Value
			switch at.ID {
			case 5:
				d.Realloc = ptr(raw & 0xffffffff)
			case 197:
				d.Pending = ptr(raw & 0xffffffff)
			case 198:
				d.Uncorr = ptr(raw & 0xffffffff)
			case 187:
				if d.Uncorr == nil && at.Name == "Reported_Uncorrect" {
					d.Uncorr = ptr(raw & 0xffffffff)
				}
			case 199: // UDMA_CRC_Error_Count: cable or connector trouble
				d.CRC = ptr(raw & 0xffffffff)
			}
			if kind == "hdd" {
				continue
			}
			if d.Wear == nil && remainingLifeAttrs[at.Name] && remainingLifeIDs[at.ID] && at.Value >= 0 && at.Value <= 100 {
				d.Wear = ptr(float64(100 - at.Value))
			}
			if unit, ok := writtenAttrs[at.Name]; ok && d.Written == nil {
				if unit == 0 {
					unit = lbs
				}
				d.Written = ptr(raw * unit)
			}
		}
	}
	if kind != "hdd" && d.Wear == nil && j.SCSIPercentUsed != nil {
		d.Wear = ptr(*j.SCSIPercentUsed)
	}
	if d.Realloc == nil && j.SCSIGrownDefect != nil {
		d.Realloc = ptr(*j.SCSIGrownDefect)
	}
	if el := j.ATAErrorLog; el != nil {
		switch {
		case el.Extended != nil && el.Extended.Count != nil:
			d.ErrorLog = ptr(*el.Extended.Count)
		case el.Summary != nil && el.Summary.Count != nil:
			d.ErrorLog = ptr(*el.Summary.Count)
		}
	}
	if sd := j.ATASmartData; sd != nil && sd.SelfTest.Status.Value>>4 == 0xf {
		d.SelfTest = &proto.SelfTest{Result: "running", PowerOnHours: derefU64(d.POH)}
	} else if st := j.ATASelfTest; st != nil && len(st.Standard.Table) > 0 {
		e := st.Standard.Table[0] // newest first
		d.SelfTest = &proto.SelfTest{Type: ataTestType(e.Type.String), Result: ataTestResult(e.Status.Value, e.Status.Passed, e.Status.String), PowerOnHours: e.LifetimeHours}
	}
	return d, nil
}

func derefU64(p *uint64) uint64 {
	if p == nil {
		return 0
	}
	return *p
}

// ataTestType maps "Short offline", "Extended offline", "Conveyance
// offline", "Short captive", "Selective offline", "Offline".
func ataTestType(s string) string {
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "short"):
		return "short"
	case strings.Contains(l, "extended") || strings.Contains(l, "long"):
		return "long"
	case strings.Contains(l, "conveyance"):
		return "conveyance"
	}
	return "offline"
}

// ataTestResult maps the self-test execution status byte (high nibble: 0
// completed, 1 aborted by the host, 2 interrupted by a reset, 3-8 failures,
// 15 in progress).
func ataTestResult(value int, passed *bool, s string) string {
	switch n := value >> 4; {
	case n == 0 && (passed == nil || *passed):
		return "passed"
	case n == 1:
		return "aborted"
	case n == 2:
		return "interrupted"
	case n == 0xf:
		return "running"
	case n >= 3 && n <= 8:
		return "failed"
	}
	if passed != nil && !*passed {
		return "failed"
	}
	l := strings.ToLower(s)
	switch {
	case strings.Contains(l, "abort"):
		return "aborted"
	case strings.Contains(l, "interrupt"):
		return "interrupted"
	case strings.Contains(l, "without error"):
		return "passed"
	}
	return "failed"
}

func nvmeTestType(code int) string {
	switch code {
	case 1:
		return "short"
	case 2:
		return "long"
	}
	return "offline" // vendor specific
}

// nvmeTestResult maps the NVMe self-test result code (0 completed, 1-4
// and 8-9 aborted, 2 aborted by a controller reset, 5-7 failed).
func nvmeTestResult(v int) string {
	switch v {
	case 0:
		return "passed"
	case 2:
		return "interrupted"
	case 1, 3, 4, 8, 9:
		return "aborted"
	}
	return "failed"
}

// parseBigUint parses a decimal counter that may exceed uint64 in the JSON
// (smartctl prints 128-bit NVMe counters as plain numbers) and returns it
// saturated to uint64.
func parseBigUint(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Sign() < 0 {
		return 0, false
	}
	if !n.IsUint64() {
		return ^uint64(0), true
	}
	return n.Uint64(), true
}

// ---- NVMe health log via ioctl (fallback when smartctl is missing) ------------

const nvmeIoctlAdminCmd = 0xC0484E41 // _IOWR('N', 0x41, struct nvme_admin_cmd)

type nvmeAdminCmd struct {
	Opcode      uint8
	Flags       uint8
	Rsvd1       uint16
	NSID        uint32
	Cdw2        uint32
	Cdw3        uint32
	Metadata    uint64
	Addr        uint64
	MetadataLen uint32
	DataLen     uint32
	Cdw10       uint32
	Cdw11       uint32
	Cdw12       uint32
	Cdw13       uint32
	Cdw14       uint32
	Cdw15       uint32
	TimeoutMs   uint32
	Result      uint32
}

// nvmeHealthLog reads the SMART / Health Information log page (0x02).
func nvmeHealthLog(dev string) (*smartData, error) {
	f, err := os.OpenFile("/dev/"+dev, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, 512)
	cmd := nvmeAdminCmd{
		Opcode:    0x02,
		NSID:      0xffffffff,
		Addr:      uint64(uintptr(unsafe.Pointer(&buf[0]))),
		DataLen:   uint32(len(buf)),
		Cdw10:     (uint32(len(buf)/4-1) << 16) | 0x02,
		TimeoutMs: 5000,
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), nvmeIoctlAdminCmd, uintptr(unsafe.Pointer(&cmd)))
	runtime.KeepAlive(buf)
	if errno != 0 {
		return nil, fmt.Errorf("nvme ioctl: %w", errno)
	}
	return parseNVMeHealthLog(buf), nil
}

// parseNVMeHealthLog decodes the 512-byte NVMe SMART log.
func parseNVMeHealthLog(b []byte) *smartData {
	d := &smartData{At: time.Now()}
	le128 := func(off int) uint64 {
		lo := binary.LittleEndian.Uint64(b[off:])
		hi := binary.LittleEndian.Uint64(b[off+8:])
		if hi != 0 {
			return ^uint64(0)
		}
		return lo
	}
	d.Passed = ptr(b[0] == 0)
	if k := binary.LittleEndian.Uint16(b[1:]); k > 0 {
		d.TempC = ptr(float64(int(k) - 273))
	}
	d.Wear = ptr(float64(b[5]))
	d.Written = ptr(le128(48) * 512000)
	d.POH = ptr(le128(128))
	d.Uncorr = ptr(le128(160))
	return d
}

// ---- collector -----------------------------------------------------------------

type diskTemp struct {
	dev     string
	typ     string
	tempC   float64
	limitC  float64
	standby bool // the value is from before the disk spun down
}

// smartCollector reads SMART data of every physical disk every 10 min.
// One disk without SMART (a virtual disk, a USB stick, a controller that
// refuses) does not fail the collector: unsupported disks are skipped,
// failures are reported per disk, and the collector only fails when every
// disk failed. A disk in standby is not woken (smartctl -n standby); it
// keeps its previous values, marked Standby.
type smartCollector struct {
	toggle toggleFn
	disks  *diskCollector

	mu   sync.Mutex
	data map[string]*smartData
	typ  map[string]string
}

func newSMARTCollector(toggle toggleFn, disks *diskCollector) *smartCollector {
	return &smartCollector{toggle: toggle, disks: disks, data: map[string]*smartData{}, typ: map[string]string{}}
}

func (s *smartCollector) run(ctx context.Context) error {
	if !s.toggle.enabled(true) {
		s.mu.Lock()
		s.data = map[string]*smartData{}
		s.mu.Unlock()
		return nil
	}
	devs := s.disks.devices()
	_, lookErr := lookPath("smartctl")
	haveSmartctl := lookErr == nil
	var errs []string
	ok, needSmartctl := 0, 0
	for _, d := range devs {
		if ctx.Err() != nil {
			errs = append(errs, ctx.Err().Error())
			break
		}
		var sd *smartData
		var err error
		if haveSmartctl {
			sd, err = runSmartctl(ctx, d)
			// USB bridges smartctl does not recognize usually speak SAT.
			if err != nil && d.Tran == "usb" {
				if sd2, err2 := runSmartctl(ctx, d, "-d", "sat"); err2 == nil {
					sd, err = sd2, nil
				} else {
					err = errSmartUnsupported // USB sticks and readers have no SMART
				}
			}
		} else if d.Type == "nvme" {
			sd, err = nvmeHealthLog(d.Dev)
		} else {
			needSmartctl++
			continue
		}
		s.mu.Lock()
		switch {
		case errors.Is(err, errSmartUnsupported):
			delete(s.data, d.Dev)
		case err != nil:
			errs = append(errs, d.Dev+": "+err.Error())
		case sd.Standby:
			ok++
			s.typ[d.Dev] = d.Type
			if prev := s.data[d.Dev]; prev != nil {
				cp := *prev
				cp.Standby = true
				s.data[d.Dev] = &cp
			} else {
				s.data[d.Dev] = &smartData{At: time.Now(), Standby: true}
			}
		default:
			ok++
			s.typ[d.Dev] = d.Type
			s.data[d.Dev] = sd
		}
		s.mu.Unlock()
	}
	// Forget disks that are gone.
	s.mu.Lock()
	present := map[string]bool{}
	for _, d := range devs {
		present[d.Dev] = true
	}
	for k := range s.data {
		if !present[k] {
			delete(s.data, k)
		}
	}
	s.mu.Unlock()
	if needSmartctl > 0 {
		errs = append([]string{fmt.Sprintf("smartctl not found (install smartmontools); %d disks unread", needSmartctl)}, errs...)
	}
	switch {
	case len(errs) == 0:
		return nil
	case ok == 0:
		return errors.New(strings.Join(errs, "; "))
	}
	return partial(strings.Join(errs, "; "))
}

func runSmartctl(ctx context.Context, d diskRef, extra ...string) (*smartData, error) {
	args := append([]string{"--json", "-a", "-l", "devstat", "-n", "standby"}, extra...)
	args = append(args, "/dev/"+d.Dev)
	out, err := runCmd(ctx, 30*time.Second, "smartctl", args...)
	if len(out) == 0 {
		return nil, err
	}
	return parseSmartctl(out, d.Type)
}

// enrich merges SMART data into the disks of a report.
func (s *smartCollector) enrich(disks []proto.Disk) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range disks {
		d := &disks[i]
		sd := s.data[d.Device]
		if sd != nil {
			if d.Model == "" {
				d.Model = sd.Model
			}
			if d.Serial == "" {
				d.Serial = sd.Serial
			}
			d.SmartPassed = copyPtr(sd.Passed)
			d.TempC = copyPtr(sd.TempC)
			d.PowerOnHours = copyPtr(sd.POH)
			d.Reallocated = copyPtr(sd.Realloc)
			d.Pending = copyPtr(sd.Pending)
			d.Uncorrectable = copyPtr(sd.Uncorr)
			if d.Type != "hdd" {
				d.WearPct = copyPtr(sd.Wear)
				d.WrittenBytes = copyPtr(sd.Written)
			}
			d.SelfTest = copyPtr(sd.SelfTest)
			d.ErrorLogCount = copyPtr(sd.ErrorLog)
			d.CRCErrors = copyPtr(sd.CRC)
			d.CriticalWarning = copyPtr(sd.CritWarning)
			d.SparePct = copyPtr(sd.Spare)
			d.SpareThreshold = copyPtr(sd.SpareThr)
			d.MediaErrors = copyPtr(sd.MediaErrors)
			d.UnsafeShutdowns = copyPtr(sd.Unsafe)
			d.Standby = sd.Standby
		}
		if d.Type != "hdd" {
			model := d.Model
			if sd != nil && sd.Model != "" {
				model = sd.Model
			}
			d.RatedTBW = ratedTBW(model)
		}
	}
}

// diskTemps returns the latest SMART temperatures (for the sensors
// collector).
func (s *smartCollector) diskTemps() []diskTemp {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []diskTemp
	for dev, sd := range s.data {
		if sd.TempC != nil {
			out = append(out, diskTemp{dev: dev, typ: s.typ[dev], tempC: *sd.TempC, limitC: sd.TempLimit, standby: sd.Standby})
		}
	}
	return out
}

func copyPtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
