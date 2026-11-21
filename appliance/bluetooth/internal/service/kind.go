package service

import (
	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// kindOf is the device's kind from BlueZ's Icon, then its LE Appearance, then its Class of Device (NX-353); false
// for phones and computers, which never cross the wire (Whombat BT-01).
func kindOf(d bluez.Device) (protocol.BluetoothKind, bool) {
	switch d.Icon {
	case "phone", "computer", "modem":
		return "", false
	}
	if d.Class != nil {
		// Major classes 1 (computer) and 2 (phone).
		if m := (*d.Class >> 8) & 0x1f; m == 0x01 || m == 0x02 {
			return "", false
		}
	}
	if d.Appearance != nil {
		// Categories 1 (phone) and 2 (computer).
		if c := *d.Appearance >> 6; c == 0x01 || c == 0x02 {
			return "", false
		}
	}
	switch d.Icon {
	case "input-keyboard":
		return protocol.BluetoothKindKeyboard, true
	case "input-mouse", "input-tablet":
		return protocol.BluetoothKindMouse, true
	case "input-gaming":
		return protocol.BluetoothKindGamepad, true
	case "audio-headphones":
		return protocol.BluetoothKindHeadphones, true
	case "audio-headset":
		return protocol.BluetoothKindHeadset, true
	}
	if d.Appearance != nil {
		if k, ok := appearanceKind(*d.Appearance); ok {
			return k, true
		}
	}
	if d.Class != nil {
		if k, ok := classKind(*d.Class); ok {
			return k, true
		}
	}
	if d.Icon == "audio-card" {
		// BlueZ's “other audio device”: loudspeakers, portable and car audio, HiFi.
		return protocol.BluetoothKindSpeaker, true
	}
	return protocol.BluetoothKindOther, true
}

// appearanceKind reads the Bluetooth SIG's appearance values (Assigned Numbers §2.6): HID (0x03C0…), audio sinks
// (0x0840…) and wearable audio (0x0940…).
func appearanceKind(a uint16) (protocol.BluetoothKind, bool) {
	switch a >> 6 {
	case 0x0f: // HID
		switch a & 0x3f {
		case 0x01:
			return protocol.BluetoothKindKeyboard, true
		case 0x02, 0x05, 0x07, 0x09: // mouse, digitizer tablet, digital pen, touchpad
			return protocol.BluetoothKindMouse, true
		case 0x03, 0x04: // joystick, gamepad
			return protocol.BluetoothKindGamepad, true
		}
	case 0x21: // audio sink: speakers, soundbars
		return protocol.BluetoothKindSpeaker, true
	case 0x25: // wearable audio
		switch a & 0x3f {
		case 0x01, 0x03: // earbud, headphones
			return protocol.BluetoothKindHeadphones, true
		case 0x02: // headset
			return protocol.BluetoothKindHeadset, true
		}
		return protocol.BluetoothKindHeadphones, true
	}
	return "", false
}

// classKind reads a Class of Device (Assigned Numbers §2.8): audio/video (major 4) and peripherals (major 5).
func classKind(c uint32) (protocol.BluetoothKind, bool) {
	minor := (c >> 2) & 0x3f
	switch (c >> 8) & 0x1f {
	case 0x04:
		switch minor {
		case 0x01, 0x02: // wearable headset, hands-free
			return protocol.BluetoothKindHeadset, true
		case 0x06:
			return protocol.BluetoothKindHeadphones, true
		case 0x05, 0x07, 0x08, 0x0a: // loudspeaker, portable audio, car audio, HiFi
			return protocol.BluetoothKindSpeaker, true
		}
	case 0x05:
		switch {
		case minor&0x10 != 0: // the keyboard bit (a combo keyboard with a touchpad too)
			return protocol.BluetoothKindKeyboard, true
		case minor&0x20 != 0: // pointing device
			return protocol.BluetoothKindMouse, true
		}
		switch minor & 0x0f {
		case 0x01, 0x02: // joystick, gamepad
			return protocol.BluetoothKindGamepad, true
		case 0x05: // digitizer tablet
			return protocol.BluetoothKindMouse, true
		}
	}
	return "", false
}

// cleanName is a display text of at most 80 code points (the contract's HostText, CT-560); "" when nothing is left.
func cleanName(s string) string { return local.HostText(s, local.BluetoothNameMax) }

// nameOf is the name the device gives itself, else BlueZ's alias (which falls back to the address); "" for neither.
func nameOf(d bluez.Device) string {
	if n := cleanName(d.Name); n != "" {
		return n
	}
	return cleanName(d.Alias)
}

// bars maps RSSI (dBm) to 0–4 bars (the contract's BluetoothSignalFromDBm).
func bars(rssi int16) int64 { return local.BluetoothSignalFromDBm(int(rssi)) }
