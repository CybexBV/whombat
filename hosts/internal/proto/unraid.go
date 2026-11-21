package proto

import "time"

// unRAID (docs/MANAGE.md 2.6, docs/AGENT-PROTOCOL.md "unRAID"): the
// agent reads what unRAID's own web page reads (emhttp's ini files under
// /var/local/emhttp, the flash configuration under /boot/config, the
// plugin manager's and dockerMan's files) and changes it with the same
// commands the page uses (emcmd, mdcmd, mover, plugin, update_container,
// notify).

// PlatformUnraid is ManageRequest.Platform for the unRAID host
// operations below; it is not a guest platform (Docker and libvirt
// guests on unRAID stay docker / libvirt).
const PlatformUnraid = "unraid"

// unRAID operations. Host ops (Platform "unraid") run as an agent task
// "unraid:<16 hex>" whose output is its log, except notification.archive
// (done at once). container.update and guest.autostart are guest ops.
const (
	OpArrayStart          = "array.start"          // host: emcmd cmdStart=Start
	OpArrayStop           = "array.stop"           // host: emcmd cmdStop=Stop
	OpParityStart         = "parity.start"         // host: Correct; emcmd cmdCheck=Check[&optionCorrect=correct]
	OpParityPause         = "parity.pause"         // host: emcmd cmdCheckPause=
	OpParityResume        = "parity.resume"        // host: emcmd cmdCheckResume=
	OpParityCancel        = "parity.cancel"        // host: emcmd cmdCheckCancel=
	OpDiskSpinUp          = "disk.spin_up"         // host: Disk (a disk of the report, or "all")
	OpDiskSpinDown        = "disk.spin_down"       // host: Disk
	OpMoverStart          = "mover.start"          // host: mover start
	OpPluginCheck         = "plugin.check"         // host: plugin checkall
	OpPluginUpdate        = "plugin.update"        // host: Plugin (a .plg of /var/log/plugins, or "all")
	OpNotificationArchive = "notification.archive" // host: Notification ("" = every unread one) -> done
	OpContainersCheck     = "containers.check"     // host: dockerupdate check
	OpContainerUpdate     = "container.update"     // guest: a Docker container on unRAID with a dockerMan template
	OpGuestAutostart      = "guest.autostart"      // guest: On; Docker on unRAID, libvirt -> done
)

// UnraidTaskPrefix starts the id of an agent task running an unRAID
// command ("unraid:" + 16 hex digits).
const UnraidTaskPrefix = "unraid:"

// Unraid is the unRAID server: version, array with parity and disks,
// pools, flash, shares, plugins, unread notifications, Docker and VM
// manager state. Sizes in bytes. Report.Unraid is nil on other hosts.
type Unraid struct {
	Version  string `cbor:"version"`             // "7.3.1"
	Name     string `cbor:"name"`                // var.ini NAME: "BlackBox"
	License  string `cbor:"license,omitempty"`   // regTy: "Pro"
	OSUpdate string `cbor:"os_update,omitempty"` // a newer unRAID ("7.3.3"), from unRAID's own update check

	Array  UnraidArray   `cbor:"array"`
	Pools  []UnraidPool  `cbor:"pools,omitempty"`
	Flash  *UnraidDisk   `cbor:"flash,omitempty"`
	Shares []UnraidShare `cbor:"shares,omitempty"`

	Plugins []UnraidPlugin `cbor:"plugins,omitempty"`
	// Notifications: unread, newest first, at most 50; NotificationsUnread
	// counts all of them.
	Notifications       []UnraidNotification `cbor:"notes,omitempty"`
	NotificationsUnread int                  `cbor:"notes_n,omitempty"`

	Docker UnraidService `cbor:"docker"`
	VMs    UnraidService `cbor:"vms"`

	// Encrypted: the array or a pool is encrypted (LUKS); KeyfilePresent:
	// emhttp's keyfile is there, so a start needs no passphrase.
	Encrypted      bool `cbor:"luks,omitempty"`
	KeyfilePresent bool `cbor:"keyfile,omitempty"`
	// LANAddress is the address unRAID's web page answers on (nginx.ini
	// NGINX_LANIP), for container web page links.
	LANAddress string `cbor:"lan_ip,omitempty"`
	// PluginsCheckedAt: the newest result of unRAID's plugin check
	// (/tmp/plugins/*.plg).
	PluginsCheckedAt time.Time `cbor:"plugins_at,omitempty"`
}

// Array states (UnraidArray.State).
const (
	UnraidArrayStarted  = "started"
	UnraidArrayStopped  = "stopped"
	UnraidArrayStarting = "starting"
	UnraidArrayStopping = "stopping"
	UnraidArrayInvalid  = "invalid"
)

// UnraidArray is the unRAID array.
type UnraidArray struct {
	State       string `cbor:"state"`               // started | stopped | starting | stopping | invalid
	StateRaw    string `cbor:"raw"`                 // mdState: "STARTED"
	StartOnBoot bool   `cbor:"autostart,omitempty"` // var.ini startArray
	ConfigValid bool   `cbor:"valid,omitempty"`     // var.ini configValid: Start is possible
	// Data disks only.
	SizeBytes uint64 `cbor:"size"`
	UsedBytes uint64 `cbor:"used"`
	FreeBytes uint64 `cbor:"free"`
	// Installed slots that are disabled (DISK_DSBL, DISK_DSBL_NEW, a data
	// disk DISK_NP_DSBL), invalid (DISK_INVALID) or missing
	// (DISK_NP_MISSING). md's own counters (mdNumDisabled, ...) also count
	// parity slots without a disk; these do not.
	Disabled     int          `cbor:"dsbl,omitempty"`
	Invalid      int          `cbor:"invalid,omitempty"`
	Missing      int          `cbor:"missing,omitempty"`
	MoverRunning bool         `cbor:"mover,omitempty"`
	Parity       UnraidParity `cbor:"parity"`
	Disks        []UnraidDisk `cbor:"disks"` // parity, parity2, disk1, ... (slot order); empty slots left out
}

// UnraidParity is the parity state: the running operation, the last one,
// the history and the schedule.
type UnraidParity struct {
	State  string `cbor:"state"`            // idle | running | paused
	Action string `cbor:"action,omitempty"` // while running: check | correct | rebuild | clear
	// Running only.
	Pct      *float64 `cbor:"pct,omitempty"`
	SpeedMBs *float64 `cbor:"speed,omitempty"` // MB/s (10^6 bytes)
	ETAS     *int64   `cbor:"eta,omitempty"`
	Errors   uint64   `cbor:"errors,omitempty"` // sync errors so far (sbSyncErrs)

	Last    *UnraidParityRun  `cbor:"last,omitempty"`
	History []UnraidParityRun `cbor:"history,omitempty"` // /boot/config/parity-checks.log, newest first, at most 10
	// Schedule in plain words ("Monthly, day 1 at 00:30, no
	// corrections"); "" = no scheduled check.
	Schedule string `cbor:"schedule,omitempty"`
	// Disks: parity disks installed (0: the array has no parity).
	Disks int `cbor:"disks"`
}

// UnraidParityRun is one finished parity operation.
type UnraidParityRun struct {
	At        time.Time `cbor:"at"`
	DurationS *int64    `cbor:"dur,omitempty"`
	SpeedMBs  *float64  `cbor:"speed,omitempty"`
	Errors    uint64    `cbor:"errors"`
	Result    string    `cbor:"result"`           // ok | errors | cancelled | failed
	Action    string    `cbor:"action,omitempty"` // check | read_check | sync | rebuild | clear
}

// unRAID disk slots (UnraidDisk.Slot).
const (
	UnraidSlotParity = "parity"
	UnraidSlotData   = "data"
	UnraidSlotPool   = "pool"
	UnraidSlotFlash  = "flash"
)

// UnraidDisk is an array, pool or flash device as disks.ini lists it.
type UnraidDisk struct {
	Name   string `cbor:"name"`           // parity, parity2, disk1, cache, cache2, flash
	Slot   string `cbor:"slot"`           // parity | data | pool | flash
	Pool   string `cbor:"pool,omitempty"` // pool members: the pool's name
	Device string `cbor:"dev,omitempty"`  // sdb, nvme0n1
	Model  string `cbor:"model,omitempty"`
	Serial string `cbor:"serial,omitempty"`
	// Status: ok | disabled | emulated | missing | new | invalid | wrong |
	// empty; StatusRaw: DISK_OK, DISK_DSBL, ...
	Status     string   `cbor:"status"`
	StatusRaw  string   `cbor:"raw"`
	SizeBytes  uint64   `cbor:"size"`
	UsedBytes  *uint64  `cbor:"used,omitempty"` // devices with a file system (data disks, a pool's first device, flash)
	FreeBytes  *uint64  `cbor:"free,omitempty"`
	FSType     string   `cbor:"fs,omitempty"` // xfs, btrfs, zfs, luks:btrfs, vfat
	TempC      *float64 `cbor:"temp,omitempty"`
	SpunDown   bool     `cbor:"down,omitempty"`
	Errors     uint64   `cbor:"errors,omitempty"` // numErrors
	Rotational *bool    `cbor:"rot,omitempty"`
}

// UnraidPool is a pool (disks.ini type Cache; names from
// /boot/config/pools/*.cfg).
type UnraidPool struct {
	Name      string       `cbor:"name"`
	FSType    string       `cbor:"fs"`                // btrfs, zfs, xfs, luks:btrfs
	Profile   string       `cbor:"profile,omitempty"` // raid1, raid10, raidz1, mirror, single
	Status    string       `cbor:"status,omitempty"`  // ONLINE, DEGRADED (monitor.ini poolsstatus)
	SizeBytes uint64       `cbor:"size"`
	UsedBytes uint64       `cbor:"used"`
	FreeBytes uint64       `cbor:"free"`
	Disks     []UnraidDisk `cbor:"disks"`
}

// UnraidShare is a user share (shares.ini, sec.ini, sec_nfs.ini).
type UnraidShare struct {
	Name      string `cbor:"name"`
	Comment   string `cbor:"comment,omitempty"`
	UsedBytes uint64 `cbor:"used"`
	FreeBytes uint64 `cbor:"free"`
	Primary   string `cbor:"primary"`             // "array" or a pool
	Secondary string `cbor:"secondary,omitempty"` // "array", a pool, or "" (none)
	// MoverAction: where the mover moves files: to_array | to_pool | "".
	MoverAction string `cbor:"mover,omitempty"`
	SMB         string `cbor:"smb,omitempty"` // public | secure | private; "" = not exported
	NFS         bool   `cbor:"nfs,omitempty"`
	Encrypted   bool   `cbor:"luks,omitempty"`
}

// UnraidPlugin is an installed plugin (/var/log/plugins/*.plg) and the
// newer version unRAID's check found (/tmp/plugins/*.plg).
type UnraidPlugin struct {
	Name       string `cbor:"name"`
	File       string `cbor:"file"` // "tailscale.plg"
	Version    string `cbor:"version"`
	Update     string `cbor:"update,omitempty"` // the newer version
	Author     string `cbor:"author,omitempty"`
	SupportURL string `cbor:"support,omitempty"`
}

// UnraidNotification is an unread notification of unRAID's own
// (<notify path>/unread/<id>.notify).
type UnraidNotification struct {
	ID          string    `cbor:"id"` // the file name without .notify
	At          time.Time `cbor:"at"`
	Importance  string    `cbor:"importance"` // alert | warning | normal
	Event       string    `cbor:"event"`
	Subject     string    `cbor:"subject"`
	Description string    `cbor:"desc,omitempty"`
}

// UnraidService is unRAID's Docker or VM manager.
type UnraidService struct {
	Enabled bool `cbor:"enabled"`
	// ImageUsedPct: docker.img in use (monitor.ini [system] docker).
	ImageUsedPct *float64 `cbor:"img_pct,omitempty"`
}
