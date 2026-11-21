// Package bluez is what whombat-bluetooth needs of BlueZ (org.bluez on the system bus; NX-353): the adapters and
// devices, looking for devices, pairing, trusting, connecting and removing them, and a pairing agent. DBus is the real
// one; Fake stands in for it in tests.
//
// Device and adapter paths carry addresses (/org/bluez/hci0/dev_AA_BB_…): they stay inside the service and are never
// logged (Whombat BT-10).
package bluez

import (
	"context"
	"errors"
	"fmt"
)

// Adapter is an org.bluez.Adapter1.
type Adapter struct {
	Path    string
	Address string
	// Alias is the adapter's name as BlueZ shows it (its default is the machine's pretty name or “BlueZ 5.x”).
	Alias       string
	Powered     bool
	Discovering bool
	// PowerState is BlueZ's ("on", "off", "off-enabling", "on-disabling", "off-blocked"; "" from an older BlueZ).
	PowerState string
}

// Device is an org.bluez.Device1, with its org.bluez.Battery1 when it has one.
type Device struct {
	Path    string
	Adapter string
	// Address is upper case as BlueZ gives it (AA:BB:CC:DD:EE:FF).
	Address string
	// Name is what the device calls itself ("" when it hasn't said); Alias falls back to the address.
	Name       string
	Alias      string
	Icon       string
	Class      *uint32
	Appearance *uint16
	Paired     bool
	Bonded     bool
	Trusted    bool
	Blocked    bool
	Connected  bool
	// RSSI is there while looking for devices, once the device has been seen in this round (BlueZ clears it when
	// looking stops).
	RSSI    *int16
	Battery *uint8
}

// Objects is BlueZ's object tree: every adapter and every device it knows.
type Objects struct {
	Adapters []Adapter
	Devices  []Device
}

// BlueZ is what the service calls. Every call but Pair returns within its context; Pair blocks until the pairing is
// over (the agent answers meanwhile) and CancelPairing ends it early.
type BlueZ interface {
	Objects(ctx context.Context) (Objects, error)
	// StartDiscovery sets this client's discovery filter (both transports, no duplicate data) and starts looking.
	StartDiscovery(ctx context.Context, adapter string) error
	StopDiscovery(ctx context.Context, adapter string) error
	Pair(ctx context.Context, device string) error
	CancelPairing(ctx context.Context, device string) error
	SetTrusted(ctx context.Context, device string, trusted bool) error
	Connect(ctx context.Context, device string) error
	Disconnect(ctx context.Context, device string) error
	RemoveDevice(ctx context.Context, adapter, device string) error
	// RegisterAgent makes a the default agent (capability DisplayYesNo) until UnregisterAgent.
	RegisterAgent(ctx context.Context, a Agent) error
	UnregisterAgent(ctx context.Context) error
}

// Agent is an org.bluez.Agent1 (BlueZ's doc/org.bluez.Agent.rst). A method returning an error refuses the request
// (org.bluez.Error.Rejected, or Canceled for ErrCanceled). RequestConfirmation may block until the owner answers.
type Agent interface {
	RequestPinCode(device string) (string, error)
	DisplayPinCode(device, pin string) error
	RequestPasskey(device string) (uint32, error)
	DisplayPasskey(device string, passkey uint32, entered uint16)
	RequestConfirmation(device string, passkey uint32) error
	RequestAuthorization(device string) error
	AuthorizeService(device, uuid string) error
	// Cancel: BlueZ gave up the request it last made.
	Cancel()
	Release()
}

var (
	// ErrNoBlueZ: the system bus or bluetoothd isn't there.
	ErrNoBlueZ = errors.New("bluez: bluetoothd isn't running")
	// ErrNoObject: the adapter or the device is gone.
	ErrNoObject = errors.New("bluez: no such object")
	// ErrRejected and ErrCanceled are an agent's refusals.
	ErrRejected = errors.New("bluez: rejected")
	ErrCanceled = errors.New("bluez: canceled")
)

// BlueZ's error names (org.bluez.Error.*) the service tells apart.
const (
	ErrorAuthenticationRejected = "org.bluez.Error.AuthenticationRejected"
	ErrorAuthenticationCanceled = "org.bluez.Error.AuthenticationCanceled"
	ErrorAuthenticationFailed   = "org.bluez.Error.AuthenticationFailed"
	ErrorAuthenticationTimeout  = "org.bluez.Error.AuthenticationTimeout"
	ErrorConnectionAttempt      = "org.bluez.Error.ConnectionAttemptFailed"
	ErrorAlreadyExists          = "org.bluez.Error.AlreadyExists"
	ErrorAlreadyConnected       = "org.bluez.Error.AlreadyConnected"
	ErrorInProgress             = "org.bluez.Error.InProgress"
	ErrorNotReady               = "org.bluez.Error.NotReady"
	ErrorDoesNotExist           = "org.bluez.Error.DoesNotExist"
	ErrorFailed                 = "org.bluez.Error.Failed"
)

// Error is an org.bluez.Error.* answer. Message is BlueZ's text (“Page Timeout”, “br-connection-…”); it names no
// address, but the service logs Name only.
type Error struct {
	Name    string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Name, e.Message) }

// ErrorName is err's BlueZ error name, "" when it isn't one.
func ErrorName(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Name
	}
	return ""
}
