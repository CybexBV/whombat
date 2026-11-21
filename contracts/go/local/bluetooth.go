package local

import "github.com/CybexBV/whombat/contracts/go/protocol"

// BluetoothSignalFromDBm gives the signal bars 0…4 for a strength (RSSI) in dBm (CT-670), like bluetoothSignalFromDbm
// in @whombat/protocol/session: ≥ −60 → 4, ≥ −70 → 3, ≥ −80 → 2, ≥ −90 → 1, else 0.
func BluetoothSignalFromDBm(dbm int) int64 {
	switch {
	case dbm >= -60:
		return 4
	case dbm >= -70:
		return 3
	case dbm >= -80:
		return 2
	case dbm >= -90:
		return 1
	}
	return 0
}

// BluetoothPairingDone reports whether a pairing's phase is final (done or failed), like bluetoothPairingDone in
// @whombat/protocol/session.
func BluetoothPairingDone(phase protocol.BluetoothPairingPhase) bool {
	return phase == protocol.BluetoothPairingPhaseDone || phase == protocol.BluetoothPairingPhaseFailed
}

// BluetoothPairingValid reports whether a pairing is consistent (CT-672), like bluetoothPairingValid in
// @whombat/protocol/session: Code exactly in phases code and confirm, Typed only in code and at most the code's
// length, Failure exactly in failed.
func BluetoothPairingValid(p protocol.BluetoothPairing) bool {
	showsCode := p.Phase == protocol.BluetoothPairingPhaseCode || p.Phase == protocol.BluetoothPairingPhaseConfirm
	if showsCode != (p.Code != nil) {
		return false
	}
	if p.Typed != nil && (p.Phase != protocol.BluetoothPairingPhaseCode || *p.Typed > int64(len(*p.Code))) {
		return false
	}
	return (p.Phase == protocol.BluetoothPairingPhaseFailed) == (p.Failure != nil)
}

// BluetoothStateValid reports whether a Bluetooth state is consistent (CT-673), like bluetoothStateValid in
// @whombat/protocol/session: Missing exactly when there is no adapter or it is off; every address once among the
// paired devices and once in the scan, and no paired device in the scan; no scan while a pairing runs; a consistent
// pairing. Validate the JSON first.
func BluetoothStateValid(s protocol.BluetoothState) bool {
	usable := s.Adapter != nil && s.Adapter.Powered
	if usable == (s.Missing != nil) {
		return false
	}
	paired := make(map[string]bool, len(s.Devices))
	for _, d := range s.Devices {
		if paired[d.Address] {
			return false
		}
		paired[d.Address] = true
	}
	if s.Scan != nil {
		found := make(map[string]bool, len(s.Scan.Devices))
		for _, d := range s.Scan.Devices {
			if found[d.Address] || paired[d.Address] {
				return false
			}
			found[d.Address] = true
		}
		if s.Pairing != nil && !BluetoothPairingDone(s.Pairing.Phase) {
			return false
		}
	}
	return s.Pairing == nil || BluetoothPairingValid(*s.Pairing)
}
