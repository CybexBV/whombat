package service

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func TestKind(t *testing.T) {
	for _, c := range []struct {
		d    bluez.Device
		want protocol.BluetoothKind // "" when left out
	}{
		{bluez.Device{Icon: "input-keyboard"}, protocol.BluetoothKindKeyboard},
		{bluez.Device{Icon: "input-mouse"}, protocol.BluetoothKindMouse},
		{bluez.Device{Icon: "input-tablet"}, protocol.BluetoothKindMouse},
		{bluez.Device{Icon: "input-gaming"}, protocol.BluetoothKindGamepad},
		{bluez.Device{Icon: "audio-headphones"}, protocol.BluetoothKindHeadphones},
		{bluez.Device{Icon: "audio-headset"}, protocol.BluetoothKindHeadset},
		{bluez.Device{Icon: "audio-card"}, protocol.BluetoothKindSpeaker},
		{bluez.Device{Icon: "phone"}, ""},
		{bluez.Device{Icon: "computer"}, ""},
		{bluez.Device{Icon: "modem"}, ""},
		{bluez.Device{Icon: "camera-video"}, protocol.BluetoothKindOther},
		{bluez.Device{}, protocol.BluetoothKindOther},
		// Classes: a phone and a laptop without an icon; a combo keyboard; a trackpad; a gamepad; audio.
		{bluez.Device{Class: u32(0x5a020c)}, ""},
		{bluez.Device{Class: u32(0x7a010c)}, ""},
		{bluez.Device{Class: u32(0x0005c0)}, protocol.BluetoothKindKeyboard},
		{bluez.Device{Class: u32(0x002580)}, protocol.BluetoothKindMouse},
		{bluez.Device{Class: u32(0x002508)}, protocol.BluetoothKindGamepad},
		{bluez.Device{Class: u32(0x240404)}, protocol.BluetoothKindHeadset},
		{bluez.Device{Class: u32(0x240418)}, protocol.BluetoothKindHeadphones},
		{bluez.Device{Class: u32(0x240414)}, protocol.BluetoothKindSpeaker},
		{bluez.Device{Class: u32(0x240410)}, protocol.BluetoothKindOther}, // a microphone
		// The icon wins over the class's guess, but a phone's class leaves it out whatever the icon.
		{bluez.Device{Icon: "audio-card", Class: u32(0x240404)}, protocol.BluetoothKindHeadset},
		{bluez.Device{Icon: "audio-headphones", Class: u32(0x5a020c)}, ""},
		// Appearances: LE keyboards, mice, pens, gamepads, speakers, earbuds, headsets; LE phones and computers.
		{bluez.Device{Appearance: u16(0x03c1)}, protocol.BluetoothKindKeyboard},
		{bluez.Device{Appearance: u16(0x03c2)}, protocol.BluetoothKindMouse},
		{bluez.Device{Appearance: u16(0x03c7)}, protocol.BluetoothKindMouse},
		{bluez.Device{Appearance: u16(0x03c4)}, protocol.BluetoothKindGamepad},
		{bluez.Device{Appearance: u16(0x0841)}, protocol.BluetoothKindSpeaker},
		{bluez.Device{Appearance: u16(0x0941)}, protocol.BluetoothKindHeadphones},
		{bluez.Device{Appearance: u16(0x0942)}, protocol.BluetoothKindHeadset},
		{bluez.Device{Appearance: u16(0x0943)}, protocol.BluetoothKindHeadphones},
		{bluez.Device{Appearance: u16(0x0040)}, ""},
		{bluez.Device{Appearance: u16(0x0080)}, ""},
		{bluez.Device{Appearance: u16(0x00c1)}, protocol.BluetoothKindOther}, // a watch
	} {
		got, ok := kindOf(c.d)
		if (c.want == "") == ok || got != c.want {
			t.Errorf("%+v: %q %v, want %q", c.d, got, ok, c.want)
		}
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"Keychron K3":                   "Keychron K3",
		"  JBL\tFlip\n6  ":              "JBL Flip 6",
		"Evil‮worrub":                   "Evilworrub",
		"zero​width":                    "zerowidth",
		"a b":                           "a b",
		"\x00\x1b[2J":                   "[2J",
		" ":                             "",
		"WH  1000XM5":                   "WH 1000XM5",
		"日本語キーボード":                      "日本語キーボード",
		strings.Repeat("é", 90):         strings.Repeat("é", 79) + "…",
		strings.Repeat("a", 78) + " bc": strings.Repeat("a", 78) + "…",
	} {
		if got := cleanName(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if nameOf(bluez.Device{Alias: "AA-BB"}) != "AA-BB" || nameOf(bluez.Device{Name: "​", Alias: "x"}) != "x" {
		t.Error("nameOf")
	}
}

func TestBars(t *testing.T) {
	for rssi, want := range map[int16]int64{-30: 4, -60: 4, -61: 3, -70: 3, -71: 2, -80: 2, -81: 1, -90: 1, -91: 0, -127: 0} {
		if got := bars(rssi); got != want {
			t.Errorf("%d: %d, want %d", rssi, got, want)
		}
	}
}
