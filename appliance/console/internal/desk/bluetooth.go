package desk

// The box's Bluetooth through the desk socket (contracts 0.109.0, brief §2.4; Whombat bluetooth.md BT-01…BT-11): the
// adapter, the paired devices, a scan and the pairing that runs, and whether the screen may change them now
// (`mayChange`, BT-02: decided by the runtime: the box isn't claimed, or the screen is unlocked). The console has no
// Bluetooth of its own (CG-03): the runtime asks the appliance's Bluetooth service. As with the desk's state, every
// answer is checked and its display strings cleaned before the page gets it, and every request is built here from
// checked fields.
//
// A device's address is its handle (BT-10): the page gets it and sends it back, checked against the contract's pattern,
// never changed; it is not logged (the log names what failed, never a device).
//
// The shapes are contracts 0.109.0's (`local.DeskBluetooth*`, `protocol.Bluetooth*`), validated by the generated
// parsers against the JSON Schemas, then by the contracts' consistency rules (`local.BluetoothStateValid`,
// `BluetoothPairingValid`; `why` exactly when the screen may not change Bluetooth), as the desk's state is (wire.go):
// an answer that isn't one is no answer.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The Bluetooth paths (DESK_PATHS, 0.109).
const (
	PathBluetooth           = local.DeskPathBluetooth
	PathBluetoothScan       = local.DeskPathBluetoothScan
	PathBluetoothPair       = local.DeskPathBluetoothPair
	PathBluetoothConfirm    = local.DeskPathBluetoothConfirm
	PathBluetoothCancel     = local.DeskPathBluetoothCancel
	PathBluetoothConnect    = local.DeskPathBluetoothConnect
	PathBluetoothDisconnect = local.DeskPathBluetoothDisconnect
	PathBluetoothForget     = local.DeskPathBluetoothForget
)

type (
	BluetoothAnswer         = local.DeskBluetoothAnswer
	BluetoothScanAnswer     = local.DeskBluetoothScanAnswer
	BluetoothPairingAnswer  = local.DeskBluetoothPairingAnswer
	BluetoothDeviceAnswer   = local.DeskBluetoothDeviceAnswer
	BluetoothDeviceRequest  = local.DeskBluetoothDeviceRequest
	BluetoothConfirmRequest = local.DeskBluetoothConfirmRequest
	BluetoothCancelRequest  = local.DeskBluetoothCancelRequest
	BluetoothState          = protocol.BluetoothState
	BluetoothDevice         = protocol.BluetoothDevice
	BluetoothPairing        = protocol.BluetoothPairing
)

// The refusals the page tells apart (DESK_SOCKET_ERRORS, 0.109): Bluetooth switched off or missing, and the screen
// locked (BT-02). On these paths `not_paired` is a device that isn't paired (the desk's other paths use it for nobody
// paired the screen); the page picks its words by path.
const (
	ErrorNoBluetooth = local.DeskErrorNoBluetooth
	ErrorLocked      = local.DeskErrorLocked
)

const bluetoothNameMax = local.BluetoothNameMax

const (
	// BluetoothCacheFor: the Bluetooth answer is kept 2 s for /api/state's chip (CG-201); the sheet's polls take one
	// at most BluetoothPollFor old while it looks or pairs.
	BluetoothCacheFor = 2 * time.Second
	// BluetoothPollFor is BLUETOOTH_POLL_MS (§2.1): how fresh the sheet's answer is while a scan or a pairing runs.
	BluetoothPollFor = time.Second
	// bluetoothStateTimeout: the runtime asks the Bluetooth service (2 s there).
	bluetoothStateTimeout = 2 * time.Second
	// bluetoothTimeout: a scan, pairing, confirm, cancel, disconnect or forget answers at once at the service (2 s
	// there); bluetoothConnectTimeout: a connect waits up to 15 s for the device (§2.3).
	bluetoothTimeout        = 5 * time.Second
	bluetoothConnectTimeout = 20 * time.Second
	// maxBluetoothBytes is BLUETOOTH_ANSWER_MAX_BYTES (0.109).
	maxBluetoothBytes = 64 << 10
)

var errBluetooth = errors.New("bluetooth: inconsistent")

// btName is a name as the page may draw it: the contracts' hostText (as the service's producers clean them: one space
// for any run of separators, no control or format characters, at most 80 code points), trimmed.
func btName(s string) string { return local.HostText(s, bluetoothNameMax) }

// cleanDevices cleans each device's name and leaves out a device whose name comes out empty.
func cleanDevices(ds []BluetoothDevice) []BluetoothDevice {
	out := make([]BluetoothDevice, 0, len(ds))
	for _, d := range ds {
		if d.Name = btName(d.Name); d.Name != "" {
			out = append(out, d)
		}
	}
	return out
}

// cleanPairing cleans the pairing's name; false: it came out empty (the pairing is left out).
func cleanPairing(p *BluetoothPairing) bool {
	p.Name = btName(p.Name)
	return p.Name != ""
}

// cleanBluetooth cleans a valid state in place.
func cleanBluetooth(s *BluetoothState) {
	if a := s.Adapter; a != nil {
		a.Name = btName(a.Name)
	}
	s.Devices = cleanDevices(s.Devices)
	if s.Scan != nil {
		s.Scan.Devices = cleanDevices(s.Scan.Devices)
	}
	if s.Pairing != nil && !cleanPairing(s.Pairing) {
		s.Pairing = nil
	}
}

// ParseBluetoothAnswer validates GET /v1/desk/bluetooth's answer (the schema, BluetoothStateValid, `why` exactly when
// the screen may not change) and cleans it.
func ParseBluetoothAnswer(data []byte) (*BluetoothAnswer, error) {
	a, err := local.ParseDeskBluetoothAnswer(data)
	if err != nil {
		return nil, err
	}
	if a.MayChange == (a.Why != nil) || !local.BluetoothStateValid(a.Bluetooth) {
		return nil, errBluetooth
	}
	cleanBluetooth(&a.Bluetooth)
	return a, nil
}

// ParseBluetoothScanAnswer validates a scan's answer and cleans its devices.
func ParseBluetoothScanAnswer(data []byte) (*BluetoothScanAnswer, error) {
	a, err := local.ParseDeskBluetoothScanAnswer(data)
	if err != nil {
		return nil, err
	}
	a.Scan.Devices = cleanDevices(a.Scan.Devices)
	return a, nil
}

// ParseBluetoothPairingAnswer validates a pairing's answer (pair, confirm, cancel: BluetoothPairingValid) and cleans
// its name.
func ParseBluetoothPairingAnswer(data []byte) (*BluetoothPairingAnswer, error) {
	a, err := local.ParseDeskBluetoothPairingAnswer(data)
	if err != nil {
		return nil, err
	}
	if !local.BluetoothPairingValid(a.Pairing) || !cleanPairing(&a.Pairing) {
		return nil, errBluetooth
	}
	return a, nil
}

// ParseBluetoothDeviceAnswer validates a connect's or a disconnect's answer and cleans the device's name.
func ParseBluetoothDeviceAnswer(data []byte) (*BluetoothDeviceAnswer, error) {
	a, err := local.ParseDeskBluetoothDeviceAnswer(data)
	if err != nil {
		return nil, err
	}
	if a.Device.Name = btName(a.Device.Name); a.Device.Name == "" {
		return nil, errBluetooth
	}
	return a, nil
}

// btCache is the Bluetooth answer and when it was asked for (a failure is kept too: a runtime that doesn't answer is
// asked again after the same time).
type btCache struct {
	answer  *BluetoothAnswer
	err     error
	at      time.Time
	fetched bool
	failing string
}

// Bluetooth is the box's Bluetooth and whether the screen may change it, from a cache at most maxAge old
// (BluetoothCacheFor for the chip, BluetoothPollFor for the sheet); ErrUnavailable when nobody answers in time, an
// *Error when the runtime refuses (404 on a runtime without Bluetooth).
func (c *Client) Bluetooth(ctx context.Context, maxAge time.Duration) (*BluetoothAnswer, error) {
	c.btMu.Lock()
	defer c.btMu.Unlock()
	now := c.now()
	b := &c.bt
	if b.fetched && now.Sub(b.at) >= 0 && now.Sub(b.at) < maxAge {
		return b.answer, b.err
	}
	ctx, cancel := context.WithTimeout(ctx, c.bluetoothStateTimeout)
	defer cancel()
	a, err := c.fetchBluetooth(ctx)
	b.answer, b.err, b.at, b.fetched = a, err, now, true
	c.reportBluetooth(err)
	return a, err
}

func (c *Client) fetchBluetooth(ctx context.Context) (*BluetoothAnswer, error) {
	body, _, err := c.do(ctx, http.MethodGet, PathBluetooth, nil, maxBluetoothBytes)
	if err != nil {
		return nil, err
	}
	a, err := ParseBluetoothAnswer(body)
	if err != nil {
		return nil, &validationError{err}
	}
	return a, nil
}

// reportBluetooth logs a change between answering and failing once (never an answer's contents: no names, no
// addresses).
func (c *Client) reportBluetooth(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
		var ve *validationError
		if errors.As(err, &ve) {
			msg = "the runtime's answer isn't a valid Bluetooth state"
		}
	}
	if msg == c.bt.failing {
		return
	}
	switch {
	case msg == "":
		c.logf("desk: the runtime answers Bluetooth")
	case c.bt.failing == "" || !errors.Is(err, ErrUnavailable):
		c.logf("desk: no Bluetooth state (%s)", msg)
	}
	c.bt.failing = msg
}

// InvalidateBluetooth drops the cached answer (after any change: it shows at the next poll).
func (c *Client) InvalidateBluetooth() {
	c.btMu.Lock()
	c.bt.fetched = false
	c.btMu.Unlock()
}

// validator is a request the contract's schema checks (an address's and a pairing id's patterns).
type validator interface{ Validate() error }

// btPost checks the request against its schema (400 `bad_request` before anything reaches the socket), sends it and
// drops the cached answer.
func btPost[T any](c *Client, ctx context.Context, path string, req validator, timeout time.Duration,
	parse func([]byte) (*T, error)) (*T, error) {
	if req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorBadRequest}
	}
	defer c.InvalidateBluetooth()
	return postUpTo(c, ctx, path, req, timeout, maxBluetoothBytes, parse)
}

// BluetoothScan starts looking for devices, or keeps looking a minute more (BT-07).
func (c *Client) BluetoothScan(ctx context.Context) (*BluetoothScanAnswer, error) {
	return btPost(c, ctx, PathBluetoothScan, &Request{V: 1}, c.bluetoothTimeout, ParseBluetoothScanAnswer)
}

// BluetoothPair starts pairing the device with that address (it runs in the background; the page follows the state).
func (c *Client) BluetoothPair(ctx context.Context, address string) (*BluetoothPairingAnswer, error) {
	return btPost(c, ctx, PathBluetoothPair, &BluetoothDeviceRequest{V: 1, Address: address}, c.bluetoothTimeout,
		ParseBluetoothPairingAnswer)
}

// BluetoothConfirm answers “Does {name} show {code}?” (BT-04).
func (c *Client) BluetoothConfirm(ctx context.Context, pairingID string, accept bool) (*BluetoothPairingAnswer, error) {
	return btPost(c, ctx, PathBluetoothConfirm, &BluetoothConfirmRequest{V: 1, PairingID: pairingID, Accept: accept},
		c.bluetoothTimeout, ParseBluetoothPairingAnswer)
}

// BluetoothCancel stops a pairing.
func (c *Client) BluetoothCancel(ctx context.Context, pairingID string) (*BluetoothPairingAnswer, error) {
	return btPost(c, ctx, PathBluetoothCancel, &BluetoothCancelRequest{V: 1, PairingID: pairingID}, c.bluetoothTimeout,
		ParseBluetoothPairingAnswer)
}

// BluetoothConnect connects a paired device (the service waits up to 15 s for it).
func (c *Client) BluetoothConnect(ctx context.Context, address string) (*BluetoothDeviceAnswer, error) {
	return btPost(c, ctx, PathBluetoothConnect, &BluetoothDeviceRequest{V: 1, Address: address},
		c.bluetoothConnectTimeout, ParseBluetoothDeviceAnswer)
}

// BluetoothDisconnect disconnects a paired device; it stays paired (BT-05).
func (c *Client) BluetoothDisconnect(ctx context.Context, address string) (*BluetoothDeviceAnswer, error) {
	return btPost(c, ctx, PathBluetoothDisconnect, &BluetoothDeviceRequest{V: 1, Address: address}, c.bluetoothTimeout,
		ParseBluetoothDeviceAnswer)
}

// BluetoothForget removes a paired device (it has to be paired again, BT-05).
func (c *Client) BluetoothForget(ctx context.Context, address string) (*Ack, error) {
	return btPost(c, ctx, PathBluetoothForget, &BluetoothDeviceRequest{V: 1, Address: address}, c.bluetoothTimeout,
		local.ParseDeskAck)
}
