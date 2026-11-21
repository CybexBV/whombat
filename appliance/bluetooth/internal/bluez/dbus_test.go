package bluez

import (
	"errors"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestParseObjects(t *testing.T) {
	v := dbus.MakeVariant
	objs := parseObjects(map[dbus.ObjectPath]map[string]map[string]dbus.Variant{
		"/org/bluez":      {"org.bluez.AgentManager1": {}},
		"/org/bluez/hci1": {ifAdapter: {"Address": v("00:00:00:00:00:02"), "Powered": v(false)}},
		"/org/bluez/hci0": {ifAdapter: {"Address": v("00:00:00:00:00:01"), "Alias": v("whombat"), "Powered": v(true),
			"Discovering": v(true), "PowerState": v("on")}},
		"/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF": {
			ifDevice: {"Address": v("aa:bb:cc:dd:ee:ff"), "Adapter": v(dbus.ObjectPath("/org/bluez/hci0")), "Name": v("MX Master 3S"),
				"Alias": v("MX Master 3S"), "Icon": v("input-mouse"), "Class": v(uint32(0x2580)), "Appearance": v(uint16(0x3c2)),
				"Paired": v(true), "Bonded": v(true), "Trusted": v(true), "Connected": v(true), "RSSI": v(int16(-61))},
			ifBattery: {"Percentage": v(byte(80))},
		},
		"/org/bluez/hci0/dev_11_22_33_44_55_66": {ifDevice: {"Address": v("11:22:33:44:55:66"), "Adapter": v(dbus.ObjectPath("/org/bluez/hci0")),
			"Alias": v("11-22-33-44-55-66")}},
	})
	if len(objs.Adapters) != 2 || objs.Adapters[0].Path != "/org/bluez/hci0" || !objs.Adapters[0].Powered || objs.Adapters[0].Alias != "whombat" ||
		!objs.Adapters[0].Discovering || objs.Adapters[0].PowerState != "on" || objs.Adapters[1].Powered {
		t.Fatalf("%+v", objs.Adapters)
	}
	if len(objs.Devices) != 2 {
		t.Fatalf("%+v", objs.Devices)
	}
	d := objs.Devices[1]
	if d.Address != "AA:BB:CC:DD:EE:FF" || d.Adapter != "/org/bluez/hci0" || d.Name != "MX Master 3S" || *d.Class != 0x2580 ||
		*d.Appearance != 0x3c2 || !d.Paired || !d.Bonded || !d.Trusted || !d.Connected || *d.RSSI != -61 || *d.Battery != 80 {
		t.Fatalf("%+v", d)
	}
	n := objs.Devices[0]
	if n.Name != "" || n.Class != nil || n.Appearance != nil || n.RSSI != nil || n.Battery != nil || n.Paired {
		t.Fatalf("%+v", n)
	}
}

func TestMapErr(t *testing.T) {
	de := func(name string, body ...any) error { return dbus.Error{Name: name, Body: body} }
	if !errors.Is(mapErr(de("org.freedesktop.DBus.Error.ServiceUnknown")), ErrNoBlueZ) ||
		!errors.Is(mapErr(de("org.freedesktop.DBus.Error.AccessDenied")), ErrNoBlueZ) ||
		!errors.Is(mapErr(de("org.freedesktop.DBus.Error.UnknownObject")), ErrNoObject) ||
		!errors.Is(mapErr(de(ErrorDoesNotExist, "Does Not Exist")), ErrNoObject) {
		t.Fatal("bus errors")
	}
	err := mapErr(de(ErrorConnectionAttempt, "Page Timeout"))
	var e *Error
	if !errors.As(err, &e) || e.Name != ErrorConnectionAttempt || e.Message != "Page Timeout" || ErrorName(err) != ErrorConnectionAttempt {
		t.Fatal(err)
	}
	if mapErr(nil) != nil || ErrorName(errors.New("x")) != "" {
		t.Fatal("nil")
	}
}

type recordingAgent struct{ calls []string }

func (a *recordingAgent) RequestPinCode(string) (string, error) {
	a.calls = append(a.calls, "pin")
	return "0000", nil
}
func (a *recordingAgent) DisplayPinCode(string, string) error   { return nil }
func (a *recordingAgent) RequestPasskey(string) (uint32, error) { return 0, ErrRejected }
func (a *recordingAgent) DisplayPasskey(string, uint32, uint16) {}
func (a *recordingAgent) RequestConfirmation(string, uint32) error {
	return ErrCanceled
}
func (a *recordingAgent) RequestAuthorization(string) error     { return nil }
func (a *recordingAgent) AuthorizeService(string, string) error { return nil }
func (a *recordingAgent) Cancel()                               {}
func (a *recordingAgent) Release()                              {}

func TestAgentObject(t *testing.T) {
	o := &agentObject{}
	// No agent set: everything refused.
	if _, err := o.RequestPinCode(":1.5", "/d"); err == nil || err.Name != "org.bluez.Error.Rejected" {
		t.Fatal(err)
	}
	a := &recordingAgent{}
	o.set(a, ":1.5")
	if pin, err := o.RequestPinCode(":1.5", "/d"); err != nil || pin != "0000" {
		t.Fatal(pin, err)
	}
	// Anyone but bluetoothd: refused, and the agent never asked.
	if _, err := o.RequestPinCode(":1.9", "/d"); err == nil || len(a.calls) != 1 {
		t.Fatal(err, a.calls)
	}
	if err := o.RequestAuthorization(":1.9", "/d"); err == nil {
		t.Fatal("authorized for someone else")
	}
	if err := o.RequestConfirmation(":1.5", "/d", 1); err == nil || err.Name != "org.bluez.Error.Canceled" {
		t.Fatal(err)
	}
	if _, err := o.RequestPasskey(":1.5", "/d"); err == nil || err.Name != "org.bluez.Error.Rejected" {
		t.Fatal(err)
	}
	if err := o.AuthorizeService(":1.5", "/d", "x"); err != nil {
		t.Fatal(err)
	}
}
