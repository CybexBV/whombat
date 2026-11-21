package local

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func TestBluetoothVectors(t *testing.T) {
	var v struct {
		BluetoothStates []struct {
			State json.RawMessage `json:"state"`
			Valid bool            `json:"valid"`
		} `json:"bluetoothStates"`
		BluetoothPairings []struct {
			Pairing json.RawMessage `json:"pairing"`
			Valid   bool            `json:"valid"`
		} `json:"bluetoothPairings"`
		BluetoothSignals []struct {
			DBm    int   `json:"dbm"`
			Signal int64 `json:"signal"`
		} `json:"bluetoothSignals"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.BluetoothStates) == 0 || len(v.BluetoothPairings) == 0 || len(v.BluetoothSignals) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.BluetoothStates {
		// The state travels inside BluetoothStateAnswer; parse it there so the schema checks it too.
		r, err := ParseBluetoothStateAnswer([]byte(`{"v":1,"bluetooth":` + string(c.State) + `}`))
		if err != nil {
			t.Fatalf("%s: %v", c.State, err)
		}
		if got := BluetoothStateValid(r.Bluetooth); got != c.Valid {
			t.Errorf("BluetoothStateValid(%s) = %v, want %v", c.State, got, c.Valid)
		}
	}
	for _, c := range v.BluetoothPairings {
		r, err := ParseBluetoothPairingAnswer([]byte(`{"v":1,"pairing":` + string(c.Pairing) + `}`))
		if err != nil {
			t.Fatalf("%s: %v", c.Pairing, err)
		}
		if got := BluetoothPairingValid(r.Pairing); got != c.Valid {
			t.Errorf("BluetoothPairingValid(%s) = %v, want %v", c.Pairing, got, c.Valid)
		}
	}
	for _, c := range v.BluetoothSignals {
		if got := BluetoothSignalFromDBm(c.DBm); got != c.Signal {
			t.Errorf("BluetoothSignalFromDBm(%d) = %d, want %d", c.DBm, got, c.Signal)
		}
	}
}

// A name cleaned with HostText passes the Bluetooth schema (CT-670), and each error code has its HTTP status (CT-682).
func TestBluetoothNamesAndStatuses(t *testing.T) {
	name := HostText("  JBL\tFlip 6​ "+strings.Repeat("x", 100), BluetoothNameMax)
	r := BluetoothDeviceAnswer{V: 1, Device: protocol.BluetoothDevice{
		Address: "7C:96:D2:AA:BB:CC", Name: name, Kind: protocol.BluetoothKindSpeaker,
	}}
	if err := r.Validate(); err != nil {
		t.Errorf("cleaned name refused: %v", err)
	}
	for _, code := range []string{
		BluetoothErrorBadRequest, BluetoothErrorTooLarge, BluetoothErrorNoBluetooth, BluetoothErrorBusy,
		BluetoothErrorNotFound, BluetoothErrorNotPaired, BluetoothErrorUnavailable,
	} {
		if BluetoothSocketErrorStatus[code] == 0 {
			t.Errorf("no status for %s", code)
		}
	}
	if !BluetoothPairingDone(protocol.BluetoothPairingPhaseFailed) || BluetoothPairingDone(protocol.BluetoothPairingPhaseConfirm) {
		t.Error("BluetoothPairingDone")
	}
}
