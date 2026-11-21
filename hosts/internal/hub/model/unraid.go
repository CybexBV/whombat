package model

import (
	"rackoon/internal/proto"
)

// The unRAID server's detail (GET /servers/{id} "unraid", docs/CONTRACT.md
// "Unraid"; Whombat's contracts HostUnraidDetail is the camelCase
// mirror). Sizes in bytes; null where unRAID does not say.

// IsUnraid reports whether the report comes from an unRAID server (the
// agent reads unRAID's state, or was installed the unRAID way).
func IsUnraid(r *proto.Report) bool {
	return r != nil && (r.Unraid != nil || r.Agent.Install == "unraid")
}

// UnraidDetail is the "unraid" block.
type UnraidDetail struct {
	Version       string               `json:"version"`
	Name          string               `json:"name"`
	License       *string              `json:"license"`
	OSUpdate      *UnraidOSUpdate      `json:"os_update"`
	Array         UnraidArray          `json:"array"`
	Pools         []UnraidPool         `json:"pools"`
	Flash         *UnraidDisk          `json:"flash"`
	Shares        []UnraidShare        `json:"shares"`
	Plugins       []UnraidPlugin       `json:"plugins"`
	Notifications []UnraidNotification `json:"notifications"`
	Docker        UnraidDocker         `json:"docker"`
	VMs           UnraidVMs            `json:"vms"`
}

// UnraidOSUpdate is a newer unRAID.
type UnraidOSUpdate struct {
	Version string `json:"version"`
}

// UnraidArray is the array.
type UnraidArray struct {
	State        string       `json:"state"` // started | stopped | starting | stopping | invalid
	StateRaw     string       `json:"state_raw"`
	StartOnBoot  bool         `json:"start_on_boot"`
	SizeBytes    uint64       `json:"size_bytes"`
	UsedBytes    uint64       `json:"used_bytes"`
	FreeBytes    uint64       `json:"free_bytes"`
	Disabled     int          `json:"disabled"`
	Invalid      int          `json:"invalid"`
	Missing      int          `json:"missing"`
	MoverRunning bool         `json:"mover_running"`
	Parity       UnraidParity `json:"parity"`
	Disks        []UnraidDisk `json:"disks"`
}

// UnraidParity is the parity state.
type UnraidParity struct {
	State    string            `json:"state"`  // idle | running | paused
	Action   *string           `json:"action"` // check | correct | rebuild | clear
	Pct      *float64          `json:"pct"`
	SpeedMBs *float64          `json:"speed_mbs"`
	ETAS     *int64            `json:"eta_s"`
	Errors   uint64            `json:"errors"`
	Last     *UnraidParityRun  `json:"last"`
	History  []UnraidParityRun `json:"history"`
	Schedule *string           `json:"schedule"`
}

// UnraidParityRun is a finished parity operation.
type UnraidParityRun struct {
	At        Time     `json:"at"`
	DurationS *int64   `json:"duration_s"`
	SpeedMBs  *float64 `json:"speed_mbs"`
	Errors    uint64   `json:"errors"`
	Result    string   `json:"result"` // ok | errors | cancelled | failed
	Action    *string  `json:"action"` // check | read_check | sync | rebuild | clear
}

// UnraidDisk is an array, pool or flash device.
type UnraidDisk struct {
	Name       string   `json:"name"`
	Slot       string   `json:"slot"` // parity | data | pool | flash
	Device     *string  `json:"device"`
	Model      *string  `json:"model"`
	Serial     *string  `json:"serial"`
	Status     string   `json:"status"` // ok | disabled | emulated | missing | new | invalid | wrong | empty
	StatusRaw  string   `json:"status_raw"`
	SizeBytes  uint64   `json:"size_bytes"`
	UsedBytes  *uint64  `json:"used_bytes"`
	FreeBytes  *uint64  `json:"free_bytes"`
	FSType     *string  `json:"fs_type"`
	TempC      *float64 `json:"temp_c"`
	SpunDown   bool     `json:"spun_down"`
	Errors     uint64   `json:"errors"`
	Rotational *bool    `json:"rotational"`
}

// UnraidPool is a pool.
type UnraidPool struct {
	Name      string       `json:"name"`
	FSType    string       `json:"fs_type"`
	Profile   *string      `json:"profile"`
	SizeBytes uint64       `json:"size_bytes"`
	UsedBytes uint64       `json:"used_bytes"`
	FreeBytes uint64       `json:"free_bytes"`
	Disks     []UnraidDisk `json:"disks"`
}

// UnraidShare is a user share.
type UnraidShare struct {
	Name        string  `json:"name"`
	Comment     string  `json:"comment"`
	UsedBytes   uint64  `json:"used_bytes"`
	FreeBytes   uint64  `json:"free_bytes"`
	Primary     string  `json:"primary"`
	Secondary   *string `json:"secondary"`
	MoverAction *string `json:"mover_action"` // to_array | to_pool
	SMB         *string `json:"smb"`          // public | secure | private
	NFS         bool    `json:"nfs"`
	Encrypted   bool    `json:"encrypted"`
}

// UnraidPlugin is an installed plugin.
type UnraidPlugin struct {
	Name       string  `json:"name"`
	File       string  `json:"file"`
	Version    string  `json:"version"`
	Update     *string `json:"update"`
	Author     *string `json:"author"`
	SupportURL *string `json:"support_url"`
}

// UnraidNotification is an unread notification of unRAID's.
type UnraidNotification struct {
	ID          string `json:"id"`
	At          Time   `json:"at"`
	Importance  string `json:"importance"` // alert | warning | normal
	Event       string `json:"event"`
	Subject     string `json:"subject"`
	Description string `json:"description"`
}

// UnraidDocker is unRAID's Docker service.
type UnraidDocker struct {
	Enabled      bool     `json:"enabled"`
	ImageUsedPct *float64 `json:"image_used_pct"`
}

// UnraidVMs is unRAID's VM manager.
type UnraidVMs struct {
	Enabled bool `json:"enabled"`
}

// buildUnraid builds the block from the report (nil for other servers).
func buildUnraid(r *proto.Report) *UnraidDetail {
	if r == nil || r.Unraid == nil {
		return nil
	}
	u := r.Unraid
	d := &UnraidDetail{Version: u.Version, Name: u.Name, License: strp(u.License),
		Pools: []UnraidPool{}, Shares: []UnraidShare{}, Plugins: []UnraidPlugin{}, Notifications: []UnraidNotification{},
		Docker: UnraidDocker{Enabled: u.Docker.Enabled, ImageUsedPct: r1p(u.Docker.ImageUsedPct)}, VMs: UnraidVMs{Enabled: u.VMs.Enabled}}
	if u.OSUpdate != "" {
		d.OSUpdate = &UnraidOSUpdate{Version: u.OSUpdate}
	}
	a := u.Array
	p := a.Parity
	d.Array = UnraidArray{State: a.State, StateRaw: a.StateRaw, StartOnBoot: a.StartOnBoot, SizeBytes: a.SizeBytes, UsedBytes: a.UsedBytes,
		FreeBytes: a.FreeBytes, Disabled: a.Disabled, Invalid: a.Invalid, Missing: a.Missing, MoverRunning: a.MoverRunning,
		Parity: UnraidParity{State: orStr(p.State, "idle"), Action: strp(p.Action), Pct: r1p(p.Pct), SpeedMBs: r1p(p.SpeedMBs), ETAS: p.ETAS,
			Errors: p.Errors, Last: unraidRun(p.Last), History: []UnraidParityRun{}, Schedule: strp(p.Schedule)},
		Disks: unraidDisks(a.Disks)}
	for i := range p.History {
		d.Array.Parity.History = append(d.Array.Parity.History, *unraidRun(&p.History[i]))
	}
	for _, x := range u.Pools {
		d.Pools = append(d.Pools, UnraidPool{Name: x.Name, FSType: x.FSType, Profile: strp(x.Profile), SizeBytes: x.SizeBytes,
			UsedBytes: x.UsedBytes, FreeBytes: x.FreeBytes, Disks: unraidDisks(x.Disks)})
	}
	if u.Flash != nil {
		f := unraidDisk(*u.Flash)
		d.Flash = &f
	}
	for _, s := range u.Shares {
		d.Shares = append(d.Shares, UnraidShare{Name: s.Name, Comment: s.Comment, UsedBytes: s.UsedBytes, FreeBytes: s.FreeBytes,
			Primary: s.Primary, Secondary: strp(s.Secondary), MoverAction: strp(s.MoverAction), SMB: strp(s.SMB), NFS: s.NFS, Encrypted: s.Encrypted})
	}
	for _, x := range u.Plugins {
		d.Plugins = append(d.Plugins, UnraidPlugin{Name: x.Name, File: x.File, Version: x.Version, Update: strp(x.Update),
			Author: strp(x.Author), SupportURL: strp(x.SupportURL)})
	}
	for _, n := range u.Notifications {
		d.Notifications = append(d.Notifications, UnraidNotification{ID: n.ID, At: Time(n.At), Importance: n.Importance,
			Event: n.Event, Subject: n.Subject, Description: n.Description})
	}
	return d
}

func unraidRun(r *proto.UnraidParityRun) *UnraidParityRun {
	if r == nil {
		return nil
	}
	return &UnraidParityRun{At: Time(r.At), DurationS: r.DurationS, SpeedMBs: r1p(r.SpeedMBs), Errors: r.Errors, Result: r.Result, Action: strp(r.Action)}
}

func unraidDisks(in []proto.UnraidDisk) []UnraidDisk {
	out := make([]UnraidDisk, 0, len(in))
	for _, x := range in {
		out = append(out, unraidDisk(x))
	}
	return out
}

func unraidDisk(x proto.UnraidDisk) UnraidDisk {
	return UnraidDisk{Name: x.Name, Slot: x.Slot, Device: strp(x.Device), Model: strp(x.Model), Serial: strp(x.Serial),
		Status: x.Status, StatusRaw: x.StatusRaw, SizeBytes: x.SizeBytes, UsedBytes: x.UsedBytes, FreeBytes: x.FreeBytes,
		FSType: strp(x.FSType), TempC: r1p(x.TempC), SpunDown: x.SpunDown, Errors: x.Errors, Rotational: x.Rotational}
}

func orStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
