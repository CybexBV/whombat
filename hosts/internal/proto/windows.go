package proto

import "time"

// Windows agents (Whombat docs/decisions/windows-servers.md). Everything is
// additive: Linux and macOS agents never send these, older hubs ignore them.

// Windows is Report.Windows: the PC's own facts, sent only by Windows agents.
// Its updates waiting and a restart Windows Update needs are SystemInfo's
// (UpdatesPending, SecurityUpdates, RebootRequired), as on Linux.
type Windows struct {
	Product        string `cbor:"product"`                   // "Windows 11 Pro"
	DisplayVersion string `cbor:"display_version,omitempty"` // "24H2"
	Build          string `cbor:"build,omitempty"`           // "26100.2605"
	Edition        string `cbor:"edition,omitempty"`         // "Professional" (EditionID)
	Server         bool   `cbor:"server,omitempty"`          // a Windows Server installation
	Manufacturer   string `cbor:"manufacturer,omitempty"`
	Model          string `cbor:"model,omitempty"`
	// Windows Update's own last successful check and install (zero: unknown).
	UpdatesCheckedAt   time.Time `cbor:"updates_checked,omitempty"`
	UpdatesInstalledAt time.Time `cbor:"updates_installed,omitempty"`
	// Defender is Microsoft Defender Antivirus as it says itself; nil when
	// it can't be read (not installed, or another antivirus switched it
	// off).
	Defender *WindowsDefender `cbor:"defender,omitempty"`
	// SecurityCenter: Windows Security Center answered (client Windows,
	// never Windows Server), so Antivirus is every antivirus product it
	// knows, Defender among them.
	SecurityCenter bool               `cbor:"sc,omitempty"`
	Antivirus      []WindowsAntivirus `cbor:"av,omitempty"`
	// BitLocker per volume with a drive letter; nil when it can't be read
	// (Windows Home without device encryption, a read that failed).
	BitLocker []WindowsVolume `cbor:"bitlocker,omitempty"`
}

// Defender running modes (WindowsDefender.Mode).
const (
	DefenderNormal   = "normal"    // Defender is the antivirus
	DefenderPassive  = "passive"   // another antivirus is; Defender only scans when asked
	DefenderEDRBlock = "edr_block" // passive, with endpoint detection blocking
	DefenderOff      = "off"       // not running
)

// WindowsDefender is Microsoft Defender Antivirus (Get-MpComputerStatus).
type WindowsDefender struct {
	Running      bool      `cbor:"running"`            // its service runs (AMServiceEnabled)
	Mode         string    `cbor:"mode,omitempty"`     // Defender* (AMRunningMode)
	Antivirus    bool      `cbor:"av"`                 // AntivirusEnabled
	RealTime     bool      `cbor:"realtime"`           // RealTimeProtectionEnabled
	Tamper       *bool     `cbor:"tamper,omitempty"`   // IsTamperProtected
	SignaturesAt time.Time `cbor:"sigs_at,omitempty"`  // AntivirusSignatureLastUpdated
	QuickScanAt  time.Time `cbor:"quick_at,omitempty"` // QuickScanEndTime
}

// WindowsAntivirus is one antivirus product Windows Security Center knows.
type WindowsAntivirus struct {
	Name     string `cbor:"name"`
	On       bool   `cbor:"on"`
	UpToDate bool   `cbor:"up_to_date"`
}

// BitLocker protection states (WindowsVolume.Protection).
const (
	BitLockerOn      = "on"
	BitLockerOff     = "off"
	BitLockerUnknown = "unknown" // locked, or BitLocker can't say
)

// WindowsVolume is one volume's BitLocker protection.
type WindowsVolume struct {
	Drive      string `cbor:"drive"` // "C:"
	Protection string `cbor:"protection"`
	System     bool   `cbor:"system,omitempty"` // the volume Windows runs from
}
