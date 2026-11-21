package desk

// The box's network through the desk socket (contracts 0.102.0, CT-574; Whombat hardware-support.md HD-05…HD-07, brief
// §2.5): how the box is connected, whether the screen may change its Wi-Fi now (`mayChange`, HD-07: decided by the
// runtime), the networks around it, and a join or a forget. The console has no network and no manager access (CG-03):
// the runtime asks the manager. As with the desk's state, every answer is checked and its display strings cleaned
// before the page gets it, and every request is built here from checked fields.
//
// A network's name is an identifier as much as a word: a name that isn't displayable is left out of every list (as the
// contracts say producers do) and never "cleaned" into another network's name; a passphrase is checked, never changed,
// and never logged.
//
// The shapes are contracts 0.102.0's (`local.DeskNetworkAnswer`, `DeskWifi*`, `protocol.HostNetwork`, `WifiScan`,
// `NetworkChange`), validated by the generated parsers against the JSON Schemas, then by the contracts' consistency
// rules (`local.HostNetworkValid`, `NetworkChangeValid`; `why` exactly when the screen may not change the Wi-Fi), as the
// desk's state is (wire.go): an answer that isn't one is no answer.

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The network paths (DESK_PATHS, 0.102).
const (
	PathNetwork    = local.DeskPathNetwork
	PathWifiScan   = local.DeskPathWifiScan
	PathWifiJoin   = local.DeskPathWifiJoin
	PathWifiForget = local.DeskPathWifiForget
)

type (
	NetworkAnswer     = local.DeskNetworkAnswer
	WifiScanAnswer    = local.DeskWifiScanAnswer
	WifiJoinRequest   = local.DeskWifiJoinRequest
	WifiForgetRequest = local.DeskWifiForgetRequest
	WifiChangeAnswer  = local.DeskWifiChangeAnswer
	HostNetwork       = protocol.HostNetwork
	NetworkChange     = protocol.NetworkChange
)

const (
	// NetworkCacheFor: the network answer is kept 2 s (§2.6): /api/state's summary and the sheet's polls share it.
	NetworkCacheFor = 2 * time.Second
	// networkTimeout: the runtime asks the manager (2 s there); /api/state waits for it at most this long.
	networkTimeout = 2 * time.Second
	// wifiTimeout: a scan waits up to 10 s for a fresh one at the manager, a join for the manager's 202 (S: 15 s).
	wifiTimeout     = 15 * time.Second
	maxNetworkBytes = 32 << 10
	maxInterface    = 15
)

// The desk socket's Wi-Fi refusal codes the console checks itself (DESK_SOCKET_ERRORS, 0.102); the runtime's pass on.
const (
	ErrorNoWifi            = local.DeskErrorNoWifi
	ErrorInvalidPassphrase = local.DeskErrorInvalidPassphrase
	ErrorBadRequest        = local.DeskErrorBadRequest
)

var passphraseRe = regexp.MustCompile(`^(?:[\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$`)

// SsidValid reports whether s is a displayable Wi-Fi network name of at most 32 UTF-8 bytes (local.SsidValid, CT-564).
func SsidValid(s string) bool { return local.SsidValid(s) }

// PassphraseValid reports whether p can be a WPA2/WPA3 Personal passphrase (WifiPassphrase): 8…63 printable ASCII
// characters, or 64 hex digits.
func PassphraseValid(p string) bool { return passphraseRe.MatchString(p) }

// checkChange: the contracts' consistency (`failure` exactly in reverting, reverted and failed) and a name of at most
// 32 bytes (the schema's pattern counts code points); a previous network's name that isn't one is dropped.
func checkChange(c *NetworkChange) error {
	if !local.NetworkChangeValid(*c) || !SsidValid(c.Ssid) {
		return errors.New("network change: inconsistent")
	}
	if c.Previous != nil && !SsidValid(*c.Previous) {
		c.Previous = nil
	}
	return nil
}

// cleanNetwork cleans a valid HostNetwork in place: interface names as one line of plain text, saved networks whose
// name is over 32 bytes left out (with the current name).
func cleanNetwork(n *HostNetwork) {
	wired := make([]protocol.HostWired, 0, len(n.Wired))
	for _, w := range n.Wired {
		if w.Interface = line(w.Interface, maxInterface); w.Interface != "" {
			wired = append(wired, w)
		}
	}
	n.Wired = wired
	if w := n.Wifi; w != nil {
		w.Interface = line(w.Interface, maxInterface)
		if w.Ssid != nil && !SsidValid(*w.Ssid) {
			w.Ssid = nil
		}
		saved := make([]protocol.WifiSaved, 0, len(w.Saved))
		for _, s := range w.Saved {
			if SsidValid(s.Ssid) {
				saved = append(saved, s)
			}
		}
		w.Saved = saved
	}
	if n.Change != nil && checkChange(n.Change) != nil {
		n.Change = nil
	}
}

// ParseNetworkAnswer validates GET /v1/desk/network's answer (the schema, HostNetworkValid, `why` exactly when the
// screen may not change the Wi-Fi) and cleans it.
func ParseNetworkAnswer(data []byte) (*NetworkAnswer, error) {
	a, err := local.ParseDeskNetworkAnswer(data)
	if err != nil {
		return nil, err
	}
	if a.MayChange == (a.Why != nil) || !local.HostNetworkValid(a.Network) {
		return nil, errors.New("network: inconsistent")
	}
	cleanNetwork(&a.Network)
	return a, nil
}

// ParseScanAnswer validates a scan; a network whose name is over 32 bytes is left out.
func ParseScanAnswer(data []byte) (*WifiScanAnswer, error) {
	a, err := local.ParseDeskWifiScanAnswer(data)
	if err != nil {
		return nil, err
	}
	nets := make([]protocol.WifiNetwork, 0, len(a.Scan.Networks))
	for _, n := range a.Scan.Networks {
		if SsidValid(n.Ssid) {
			nets = append(nets, n)
		}
	}
	a.Scan.Networks = nets
	return a, nil
}

// ParseChangeAnswer validates a join's or a forget's answer.
func ParseChangeAnswer(data []byte) (*WifiChangeAnswer, error) {
	a, err := local.ParseDeskWifiChangeAnswer(data)
	if err != nil {
		return nil, err
	}
	if err := checkChange(&a.Change); err != nil {
		return nil, err
	}
	return a, nil
}

// netCache is the network answer, kept NetworkCacheFor (a failure too: a runtime that doesn't answer is asked again
// after the same 2 s).
type netCache struct {
	answer  *NetworkAnswer
	err     error
	at      time.Time
	fetched bool
	failing string
}

// Network is how the box is connected and whether the screen may change its Wi-Fi, from a cache of NetworkCacheFor;
// ErrUnavailable when nobody answers in time, an *Error when the runtime refuses (e.g. 404 on a runtime without the
// network, 503 `unavailable` when the manager doesn't answer it).
func (c *Client) Network(ctx context.Context) (*NetworkAnswer, error) {
	c.netMu.Lock()
	defer c.netMu.Unlock()
	now := c.now()
	n := &c.net
	if n.fetched && now.Sub(n.at) >= 0 && now.Sub(n.at) < NetworkCacheFor {
		return n.answer, n.err
	}
	ctx, cancel := context.WithTimeout(ctx, c.networkTimeout)
	defer cancel()
	a, err := c.fetchNetwork(ctx)
	n.answer, n.err, n.at, n.fetched = a, err, now, true
	c.reportNetwork(err)
	return a, err
}

func (c *Client) fetchNetwork(ctx context.Context) (*NetworkAnswer, error) {
	body, _, err := c.do(ctx, http.MethodGet, PathNetwork, nil, maxNetworkBytes)
	if err != nil {
		return nil, err
	}
	a, err := ParseNetworkAnswer(body)
	if err != nil {
		return nil, &validationError{err}
	}
	return a, nil
}

// reportNetwork logs a change between answering and failing once (never an answer's contents).
func (c *Client) reportNetwork(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
		var ve *validationError
		if errors.As(err, &ve) {
			msg = "the runtime's answer isn't a valid network state"
		}
	}
	if msg == c.net.failing {
		return
	}
	switch {
	case msg == "":
		c.logf("desk: the runtime answers the network")
	case c.net.failing == "" || !errors.Is(err, ErrUnavailable):
		c.logf("desk: no network state (%s)", msg)
	}
	c.net.failing = msg
}

// InvalidateNetwork drops the cached network answer (after a join or a forget: the change shows at the next poll).
func (c *Client) InvalidateNetwork() {
	c.netMu.Lock()
	c.net.fetched = false
	c.netMu.Unlock()
}

// WifiScan asks for the networks around the box (the manager waits up to 10 s for a fresh scan).
func (c *Client) WifiScan(ctx context.Context) (*WifiScanAnswer, error) {
	ctx, cancel := context.WithTimeout(ctx, c.wifiTimeout)
	defer cancel()
	body, _, err := c.do(ctx, http.MethodPost, PathWifiScan, Request{V: 1}, maxNetworkBytes)
	if err != nil {
		return nil, err
	}
	a, err := ParseScanAnswer(body)
	if err != nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "failed"}
	}
	return a, nil
}

// WifiJoin joins or switches to a network (HD-07: the runtime refuses with 409 `locked` when the screen may not). The
// passphrase is passed on as typed and never kept or logged; a name or passphrase that can't be one is refused here.
func (c *Client) WifiJoin(ctx context.Context, ssid string, passphrase *string, hidden bool) (*WifiChangeAnswer, error) {
	if !SsidValid(ssid) {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorBadRequest}
	}
	if passphrase != nil && !PassphraseValid(*passphrase) {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorInvalidPassphrase}
	}
	req := WifiJoinRequest{V: 1, Ssid: ssid, Passphrase: passphrase}
	if hidden {
		req.Hidden = &hidden
	}
	if req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorBadRequest}
	}
	return c.change(ctx, PathWifiJoin, req)
}

// WifiForget forgets a saved network.
func (c *Client) WifiForget(ctx context.Context, ssid string) (*WifiChangeAnswer, error) {
	if !SsidValid(ssid) {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorBadRequest}
	}
	req := WifiForgetRequest{V: 1, Ssid: ssid}
	if req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: ErrorBadRequest}
	}
	return c.change(ctx, PathWifiForget, req)
}

func (c *Client) change(ctx context.Context, path string, req any) (*WifiChangeAnswer, error) {
	defer c.InvalidateNetwork()
	ctx, cancel := context.WithTimeout(ctx, c.wifiTimeout)
	defer cancel()
	body, _, err := c.do(ctx, http.MethodPost, path, req, maxAnswerBytes)
	if err != nil {
		return nil, err
	}
	a, err := ParseChangeAnswer(body)
	if err != nil {
		return nil, &Error{Status: http.StatusBadGateway, Code: "failed"}
	}
	return a, nil
}
