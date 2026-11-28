package model

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestWindowsProtection(t *testing.T) {
	on := &proto.WindowsDefender{Running: true, Mode: proto.DefenderNormal, Antivirus: true, RealTime: true}
	rtOff := &proto.WindowsDefender{Running: true, Mode: proto.DefenderNormal, Antivirus: true}
	passive := &proto.WindowsDefender{Running: true, Mode: proto.DefenderPassive, Antivirus: true, RealTime: true}
	stopped := &proto.WindowsDefender{Mode: proto.DefenderOff}
	other := []proto.WindowsAntivirus{{Name: "Example Antivirus", On: true, UpToDate: true}}
	for _, c := range []struct {
		name    string
		w       *proto.Windows
		state   string
		product string
	}{
		{"defender on", &proto.Windows{Defender: on, SecurityCenter: true}, ProtectionOn, defenderName},
		{"real-time off, nothing else", &proto.Windows{Defender: rtOff, SecurityCenter: true,
			Antivirus: []proto.WindowsAntivirus{{Name: defenderName}}}, ProtectionOff, ""},
		{"another product on", &proto.Windows{Defender: passive, SecurityCenter: true, Antivirus: other}, ProtectionOn, "Example Antivirus"},
		{"security center lists none on", &proto.Windows{Defender: stopped, SecurityCenter: true}, ProtectionOff, ""},
		{"server, defender real-time off", &proto.Windows{Server: true, Defender: rtOff}, ProtectionOff, ""},
		{"server, defender not running", &proto.Windows{Server: true, Defender: stopped}, ProtectionUnknown, ""},
		{"nothing read yet", &proto.Windows{}, ProtectionUnknown, ""},
		{"no block", nil, ProtectionUnknown, ""},
	} {
		state, product := ProtectionOf(c.w)
		if state != c.state || product != c.product {
			t.Errorf("%s: %s %q, want %s %q", c.name, state, product, c.state, c.product)
		}
	}
}

func TestWindowsDetailAndHints(t *testing.T) {
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	tamper := true
	r := &proto.Report{}
	r.Agent.OS = "windows"
	r.Windows = &proto.Windows{Product: "Windows 11 Pro", DisplayVersion: "24H2", Build: "26100.2605",
		UpdatesCheckedAt: now.Add(-time.Hour),
		Defender: &proto.WindowsDefender{Running: true, Mode: proto.DefenderNormal, Antivirus: true, RealTime: true, Tamper: &tamper,
			SignaturesAt: now.Add(-9 * 24 * time.Hour)},
		SecurityCenter: true,
		BitLocker:      []proto.WindowsVolume{{Drive: "C:", Protection: proto.BitLockerOn, System: true}},
	}
	if OSFamily(r) != OSFamilyWindows || DetailView(r) != "windows" {
		t.Fatalf("family %q view %q", OSFamily(r), DetailView(r))
	}
	d := BuildWindows(r)
	if d == nil || d.Product != "Windows 11 Pro" || d.Protection.State != ProtectionOn || d.Protection.Defender == nil ||
		d.Protection.Defender.SignaturesAt == nil || d.UpdatesInstalledAt != nil || d.UpdatesCheckedAt == nil ||
		len(d.BitLocker) != 1 || !d.BitLocker[0].System {
		t.Fatalf("detail = %+v", d)
	}
	hs := windowsHints(r, now)
	if len(hs) != 1 || hs[0].Kind != HintWindowsSignaturesOld || hs[0].Params["days"] != 9 {
		t.Fatalf("hints = %+v", hs)
	}
	r.Windows.Defender.SignaturesAt = now.Add(-time.Hour)
	if hs := windowsHints(r, now); len(hs) != 0 {
		t.Errorf("fresh definitions: %+v", hs)
	}
	r.Windows.Defender.RealTime = false
	hs = windowsHints(r, now)
	if len(hs) != 1 || hs[0].Kind != HintWindowsProtectionOff || hs[0].Link != LinkProtection ||
		hs[0].Code != HintWindowsProtectionOff+".realtime" {
		t.Fatalf("protection off: %+v", hs)
	}
	// No antivirus at all: the plain code, whose words say to turn Defender on.
	r.Windows.Defender = nil
	r.Windows.SecurityCenter = true
	if hs := windowsHints(r, now); len(hs) != 1 || hs[0].Code != HintWindowsProtectionOff {
		t.Fatalf("no antivirus: %+v", hs)
	}
	// A PC without BitLocker says nothing about it: null, not an empty list.
	r.Windows.BitLocker = nil
	if d := BuildWindows(r); d.BitLocker != nil {
		t.Errorf("bitlocker = %+v", d.BitLocker)
	}
	// Before its first Windows block, the agent's system still names it.
	if OSFamily(&proto.Report{Agent: proto.AgentInfo{OS: "windows"}}) != OSFamilyWindows {
		t.Error("an agent's os alone")
	}
	if BuildWindows(&proto.Report{}) != nil || windowsHints(&proto.Report{}, now) != nil {
		t.Error("a Linux report has no Windows block")
	}
}
