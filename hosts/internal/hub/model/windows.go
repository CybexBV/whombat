package model

import (
	"strconv"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// A Windows PC (Whombat docs/decisions/windows-servers.md): its facts in
// the server detail, its os family and the hints about its protection.

// OSFamilyWindows is a Windows PC's os family.
const OSFamilyWindows = "windows"

// WindowsDetail is GET /servers/{id}'s "windows" block.
type WindowsDetail struct {
	Product        string  `json:"product"` // "Windows 11 Pro"
	DisplayVersion *string `json:"display_version"`
	Build          *string `json:"build"`
	Edition        *string `json:"edition"`
	Server         bool    `json:"server"`
	Manufacturer   *string `json:"manufacturer"`
	Model          *string `json:"model"`
	// UpdatesCheckedAt is Windows Update's last search, UpdatesInstalledAt
	// its last install (the counts and the restart are in "system").
	UpdatesCheckedAt   *Time             `json:"updates_checked_at"`
	UpdatesInstalledAt *Time             `json:"updates_installed_at"`
	Protection         WindowsProtection `json:"protection"`
	// BitLocker per drive; null: the PC didn't say (no BitLocker there).
	BitLocker []WindowsVolume `json:"bitlocker"`
}

// WindowsProtection is the PC's antivirus: State on, off or unknown (a
// Windows Server that names no product of its own); Product the one that
// is on.
type WindowsProtection struct {
	State     string             `json:"state"`
	Product   *string            `json:"product"`
	Defender  *WindowsDefender   `json:"defender"`
	Antivirus []WindowsAntivirus `json:"antivirus"`
}

// WindowsDefender is Microsoft Defender Antivirus.
type WindowsDefender struct {
	Running      bool   `json:"running"`
	Mode         string `json:"mode"` // normal | passive | edr_block | off
	RealTime     bool   `json:"real_time"`
	Tamper       *bool  `json:"tamper"`
	SignaturesAt *Time  `json:"signatures_at"`
	QuickScanAt  *Time  `json:"quick_scan_at"`
}

// WindowsAntivirus is a product Windows Security knows.
type WindowsAntivirus struct {
	Name     string `json:"name"`
	On       bool   `json:"on"`
	UpToDate bool   `json:"up_to_date"`
}

// WindowsVolume is one drive's BitLocker.
type WindowsVolume struct {
	Drive      string `json:"drive"`
	Protection string `json:"protection"` // on | off | unknown
	System     bool   `json:"system"`
}

// Protection states.
const (
	ProtectionOn      = "on"
	ProtectionOff     = "off"
	ProtectionUnknown = "unknown"
)

// defenderName is how Windows Security names Defender.
const defenderName = "Microsoft Defender Antivirus"

// ProtectionOf decides whether the PC has an antivirus on. Defender in
// normal mode with real-time protection is on; else a product Windows
// Security lists as on. Windows Security (on Windows 10 and 11) listing
// none on is off; a Windows Server, which has no Windows Security, is off
// only when Defender is its antivirus with real-time protection off, and
// unknown when Defender doesn't run (another product may).
func ProtectionOf(w *proto.Windows) (state, product string) {
	if w == nil {
		return ProtectionUnknown, ""
	}
	d := w.Defender
	if d != nil && d.Running && d.Mode == proto.DefenderNormal && d.Antivirus && d.RealTime {
		return ProtectionOn, defenderName
	}
	for _, a := range w.Antivirus {
		if a.On {
			return ProtectionOn, a.Name
		}
	}
	switch {
	case w.SecurityCenter:
		return ProtectionOff, ""
	case d != nil && d.Running && d.Mode == proto.DefenderNormal:
		return ProtectionOff, ""
	}
	return ProtectionUnknown, ""
}

// BuildWindows builds the "windows" block (nil when the report has none).
func BuildWindows(r *proto.Report) *WindowsDetail {
	if r == nil || r.Windows == nil {
		return nil
	}
	w := r.Windows
	d := &WindowsDetail{Product: w.Product, DisplayVersion: strp(w.DisplayVersion), Build: strp(w.Build),
		Edition: strp(w.Edition), Server: w.Server, Manufacturer: strp(w.Manufacturer), Model: strp(w.Model),
		UpdatesCheckedAt: tp(w.UpdatesCheckedAt), UpdatesInstalledAt: tp(w.UpdatesInstalledAt)}
	state, product := ProtectionOf(w)
	d.Protection = WindowsProtection{State: state, Product: strp(product), Antivirus: []WindowsAntivirus{}}
	if x := w.Defender; x != nil {
		d.Protection.Defender = &WindowsDefender{Running: x.Running, Mode: x.Mode, RealTime: x.RealTime, Tamper: x.Tamper,
			SignaturesAt: tp(x.SignaturesAt), QuickScanAt: tp(x.QuickScanAt)}
	}
	for _, a := range w.Antivirus {
		d.Protection.Antivirus = append(d.Protection.Antivirus, WindowsAntivirus{Name: a.Name, On: a.On, UpToDate: a.UpToDate})
	}
	if w.BitLocker != nil {
		d.BitLocker = []WindowsVolume{}
		for _, v := range w.BitLocker {
			d.BitLocker = append(d.BitLocker, WindowsVolume{Drive: v.Drive, Protection: v.Protection, System: v.System})
		}
	}
	return d
}

// tp is a time, or null when unknown.
func tp(t time.Time) *Time {
	if t.IsZero() {
		return nil
	}
	return T(t)
}

// Hint kinds of a Windows PC. Protection off is a security opening the
// person can close in one step, so Whombat watches it from the start; old
// virus definitions start off (Windows updates them by itself).
const (
	HintWindowsProtectionOff = "windows.protection_off"
	HintWindowsSignaturesOld = "windows.signatures_old"
)

// SignaturesOldAfter is the age at which Defender's virus definitions
// count as old (Windows Security warns after a week too).
const SignaturesOldAfter = 7 * 24 * time.Hour

// LinkProtection is the PC page's protection section.
const LinkProtection = "#protection"

// windowsHints are a Windows PC's protection hints.
func windowsHints(r *proto.Report, now time.Time) []rules.Hint {
	if r == nil || r.Windows == nil {
		return nil
	}
	w := r.Windows
	var out []rules.Hint
	state, product := ProtectionOf(w)
	if state == ProtectionOff {
		code, detail := HintWindowsProtectionOff, "No antivirus is on; turn on Microsoft Defender in Windows Security"
		if d := w.Defender; d != nil && d.Mode == proto.DefenderNormal {
			code = HintWindowsProtectionOff + ".realtime"
			detail = "Turn on real-time protection in Windows Security → Virus & threat protection"
		}
		out = append(out, rules.Hint{Kind: HintWindowsProtectionOff, Severity: rules.HintWarning, Entity: "host",
			Link: LinkProtection, Code: code, Title: "Virus protection is off", Detail: detail})
	}
	if d := w.Defender; state == ProtectionOn && product == defenderName && d != nil && !d.SignaturesAt.IsZero() {
		if age := now.Sub(d.SignaturesAt); age >= SignaturesOldAfter {
			days := int(age / (24 * time.Hour))
			out = append(out, rules.Hint{Kind: HintWindowsSignaturesOld, Severity: rules.HintInfo, Entity: "host",
				Link: LinkProtection, Code: HintWindowsSignaturesOld, Params: map[string]any{"days": days},
				Title:  "Virus definitions are " + strconv.Itoa(days) + " days old",
				Detail: "Windows updates them by itself; check Windows Update"})
		}
	}
	return out
}
