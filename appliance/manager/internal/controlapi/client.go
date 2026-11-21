// Package controlapi is the manager's device-authenticated control API client (MA-03).
//
// Requests use the @whombat/control-contracts device envelope through the vendored Go bindings
// (github.com/CybexBV/whombat/contracts/go/device): `POST /v1/device/<op>` with a
// DeviceRequestEnvelope body, `sig = Ed25519(JCS({purpose, v, aud, device, op, ts, nonce, body}))`,
// `aud = whombat-api:<env>`, ±300 s, single-use nonce. The management key never leaves the
// manager process.
package controlapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// PathPrefix is where device operations live.
const PathPrefix = "/v1/device/"

// Client is a device-authenticated control client.
type Client struct {
	BaseURL  string // e.g. https://api.dev.whombat.com
	Env      string // local | dev | prod -> audience whombat-api:<env>
	DeviceID string
	Key      ed25519.PrivateKey
	HTTP     *http.Client
	Now      func() time.Time

	famMu  sync.Mutex
	forced map[string]*http.Client // per forced address family (MG-32)
}

// Address families a request can be forced over (Go dial networks, MG-32). FamilyAny lets the resolver and
// Happy Eyeballs pick, as every other request does.
const (
	FamilyAny  = ""
	FamilyIPv4 = "tcp4"
	FamilyIPv6 = "tcp6"
)

// OtherFamily is IPv6 for IPv4 and IPv4 for IPv6; FamilyAny for an unknown family.
func OtherFamily(family string) string {
	switch family {
	case FamilyIPv4:
		return FamilyIPv6
	case FamilyIPv6:
		return FamilyIPv4
	}
	return FamilyAny
}

// familyOf is the address family of a connection's remote address (an IPv4-mapped IPv6 address is IPv4).
func familyOf(c net.Conn) string {
	a, ok := c.RemoteAddr().(*net.TCPAddr)
	switch {
	case !ok:
		return FamilyAny
	case a.IP.To4() != nil:
		return FamilyIPv4
	default:
		return FamilyIPv6
	}
}

// How long a connection to control may stay silent before the client pings it, and how long it then waits for the
// answer before it drops the connection, so the next request opens a new one. Without them a connection that died
// without a word (the box's temporary IPv6 address it was opened from expired, a router restarted) kept taking every
// request for the 15 minutes or more Linux retransmits before it gives up: a request that times out on an HTTP/2
// connection doesn't close it. Nothing reached control meanwhile, so no relay tickets and no phone reached the box.
const (
	PingAfter = 15 * time.Second
	PingWait  = 10 * time.Second
)

// HealthChecked is a copy of t whose HTTP/2 connections are pinged after `after` without a frame from the other end
// and closed when a ping isn't answered within `wait`.
func HealthChecked(t *http.Transport, after, wait time.Duration) *http.Transport {
	h := t.Clone()
	if h.HTTP2 == nil {
		h.HTTP2 = &http.HTTP2Config{}
	}
	h.HTTP2.SendPingTimeout = after
	h.HTTP2.PingTimeout = wait
	return h
}

// defaultTransport is the transport of a client without its own: Go's default, health-checked.
var defaultTransport = sync.OnceValue(func() *http.Transport {
	return HealthChecked(http.DefaultTransport.(*http.Transport), PingAfter, PingWait)
})

// httpClient is the client for family: the configured one (or a default) for FamilyAny, else a client whose
// dialer only uses that family, so a host without an A (AAAA) record or without an IPv4 (IPv6) route fails at once.
func (c *Client) httpClient(family string) *http.Client {
	timeout := 30 * time.Second
	if c.HTTP != nil && c.HTTP.Timeout > 0 {
		timeout = c.HTTP.Timeout
	}
	if family == FamilyAny {
		if c.HTTP != nil {
			return c.HTTP
		}
		return &http.Client{Transport: defaultTransport(), Timeout: timeout}
	}
	c.famMu.Lock()
	defer c.famMu.Unlock()
	if hc := c.forced[family]; hc != nil {
		return hc
	}
	base := defaultTransport()
	if c.HTTP != nil {
		if t, ok := c.HTTP.Transport.(*http.Transport); ok {
			base = t
		}
	}
	tr := base.Clone()
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	tr.DialContext = func(ctx context.Context, _, addr string) (net.Conn, error) {
		return dialer.DialContext(ctx, family, addr)
	}
	hc := &http.Client{Transport: tr, Timeout: timeout}
	if c.forced == nil {
		c.forced = map[string]*http.Client{}
	}
	c.forced[family] = hc
	return hc
}

// ErrUnavailable wraps network/5xx/429 failures (callers back off; never fatal).
var ErrUnavailable = errors.New("control unavailable")

// HTTPError is a non-2xx response.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("control HTTP %d: %s", e.Status, e.Body) }

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Audience returns the control audience for the client's environment.
func (c *Client) Audience() string { return "whombat-api:" + c.Env }

// Do performs one signed device operation.
func (c *Client) Do(ctx context.Context, op device.DeviceOpName, body, out any) error {
	_, err := c.do(ctx, op, body, out, FamilyAny)
	return err
}

// DefaultAnswerMaxBytes is how much of control's answer the client reads unless an op allows more (Forward).
const DefaultAnswerMaxBytes = 1 << 20

// ErrTooLarge: the signed request is above its op's limit (device.DeviceRequestMaxBytesFor); nothing was sent.
var ErrTooLarge = errors.New("the device request is larger than control accepts for this op")

// ErrAnswerTooLarge: control's answer is above what the caller allows for the op.
var ErrAnswerTooLarge = errors.New("control's answer is larger than allowed for this op")

// Forward performs one signed device operation and returns control's answer body as sent (a 2xx), read up to
// maxAnswer bytes, with its own timeout for the whole exchange (the feedback drop's ops, MG-39: a pull answer may
// carry 64 MiB of envelopes, a card sync 4 MiB of cards). Errors are Do's, plus ErrTooLarge and ErrAnswerTooLarge.
func (c *Client) Forward(ctx context.Context, op device.DeviceOpName, body any, maxAnswer int64, timeout time.Duration) ([]byte, error) {
	hc := *c.httpClient(FamilyAny)
	hc.Timeout = timeout
	var raw json.RawMessage
	err := c.sendN(ctx, op, body, &raw, &hc, maxAnswer)
	return raw, err
}

// do performs one signed device operation over family (FamilyAny: whichever the dialer picks) and returns the family
// the request actually went over (FamilyAny when no connection was made or its address isn't TCP).
func (c *Client) do(ctx context.Context, op device.DeviceOpName, body, out any, family string) (string, error) {
	var mu sync.Mutex
	used := FamilyAny
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(i httptrace.GotConnInfo) {
		mu.Lock()
		used = familyOf(i.Conn)
		mu.Unlock()
	}})
	usedFamily := func() string { mu.Lock(); defer mu.Unlock(); return used }
	err := c.send(ctx, op, body, out, c.httpClient(family))
	return usedFamily(), err
}

func (c *Client) send(ctx context.Context, op device.DeviceOpName, body, out any, hc *http.Client) error {
	return c.sendN(ctx, op, body, out, hc, DefaultAnswerMaxBytes)
}

func (c *Client) sendN(ctx context.Context, op device.DeviceOpName, body, out any, hc *http.Client, maxAnswer int64) error {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	env, err := device.SignDeviceRequest(c.Audience(), c.DeviceID, op, c.now().Unix(), hex.EncodeToString(nonce), body, c.Key)
	if err != nil {
		return fmt.Errorf("sign %s: %w", op, err)
	}
	return c.post(ctx, env, out, hc, maxAnswer)
}

func (c *Client) post(ctx context.Context, env *device.DeviceRequestEnvelope, out any, hc *http.Client, maxAnswer int64) error {
	op := env.Op
	// Control refuses a request whose signed bytes are above the op's limit (CT-91); say so without a round trip.
	if msg, err := device.SigningBytes(env); err != nil {
		return fmt.Errorf("sign %s: %w", op, err)
	} else if len(msg) > device.DeviceRequestMaxBytesFor(op) {
		return fmt.Errorf("%s: %w (%d > %d bytes)", op, ErrTooLarge, len(msg), device.DeviceRequestMaxBytesFor(op))
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(c.BaseURL, "/")+PathPrefix+string(op), bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer+1))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if int64(len(data)) > maxAnswer {
		if resp.StatusCode/100 == 2 {
			return fmt.Errorf("%s: %w (over %d bytes)", op, ErrAnswerTooLarge, maxAnswer)
		}
		data = data[:maxAnswer]
	}
	if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("%w: %w", ErrUnavailable, &HTTPError{resp.StatusCode, string(data)})
	}
	if resp.StatusCode/100 != 2 {
		return &HTTPError{resp.StatusCode, string(data)}
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = data
		return nil
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// AdmissionTicket fetches an appliance admission ticket (ticket.issue).
func (c *Client) AdmissionTicket(ctx context.Context, class string) (*device.TicketIssueResponse, error) {
	var t device.TicketIssueResponse
	if err := c.Do(ctx, device.DeviceOpNameTicketIssue, device.TicketIssueRequest{Class: protocol.RelayClass(class)}, &t); err != nil {
		return nil, err
	}
	if err := t.Validate(); err != nil {
		return nil, fmt.Errorf("ticket.issue response: %w", err)
	}
	return &t, nil
}

// SupportTicket fetches an appliance ticket for the device's support route (support.ticket {}, contracts 0.120.0
// CT-940, remote help RH-06, MG-118): the support service's relay worker connects with it.
func (c *Client) SupportTicket(ctx context.Context) (*device.SupportTicketResponse, error) {
	var t device.SupportTicketResponse
	if err := c.Do(ctx, device.DeviceOpNameSupportTicket, device.SupportTicketRequest{}, &t); err != nil {
		return nil, err
	}
	if err := t.Validate(); err != nil {
		return nil, fmt.Errorf("support.ticket response: %w", err)
	}
	return &t, nil
}

// ClaimLookup leases (or renews) the claim-code lookup number of an unclaimed device (claim.lookup,
// CC-03). A claimed device gets 409 with details.code already_claimed (IsAlreadyClaimed).
func (c *Client) ClaimLookup(ctx context.Context) (*device.ClaimLookupResponse, error) {
	r, _, err := c.ClaimLookupOver(ctx, FamilyAny)
	return r, err
}

// ClaimLookupOver is ClaimLookup over one address family (FamilyAny, FamilyIPv4 or FamilyIPv6) and returns the
// family the request went over. Control keeps one network tag per family (control CL-36), so the manager renews
// over both on a dual-stack network (MG-32).
func (c *Client) ClaimLookupOver(ctx context.Context, family string) (*device.ClaimLookupResponse, string, error) {
	var r device.ClaimLookupResponse
	used, err := c.do(ctx, device.DeviceOpNameClaimLookup, device.ClaimLookupRequest{}, &r, family)
	if err != nil {
		return nil, used, err
	}
	if err := r.Validate(); err != nil {
		return nil, used, fmt.Errorf("claim.lookup response: %w", err)
	}
	return &r, used, nil
}

// LicenceRenew asks control for a fresh licence token (licence.renew {}, LC-05, CT-77). The caller verifies the
// token against the pinned key set; this only checks the response's shape.
func (c *Client) LicenceRenew(ctx context.Context) (*device.LicenceRenewResponse, error) {
	var r device.LicenceRenewResponse
	if err := c.Do(ctx, device.DeviceOpNameLicenceRenew, device.LicenceRenewRequest{}, &r); err != nil {
		return nil, err
	}
	if err := r.Validate(); err != nil {
		return nil, fmt.Errorf("licence.renew response: %w", err)
	}
	return &r, nil
}

// Licence renewal outcomes (the manager's LicenceRenewNowResult.error, docs/local-ipc.md).
const (
	LicenceUnreachable    = "unreachable"
	LicenceUnclaimed      = "device_unclaimed"
	LicenceRevoked        = "device_revoked"
	LicenceDevicesReached = "devices_allowed_reached"
	LicenceRateLimited    = "rate_limited"
	LicenceRefused        = "control_refused"
)

// LicenceRefusal names why licence.renew failed (CL-41): device_revoked (403), device_unclaimed (409 conflict),
// devices_allowed_reached (403 entitlement_withheld), rate_limited (429), unreachable (network, 5xx), or
// control_refused for anything else.
func LicenceRefusal(err error) string {
	var he *HTTPError
	code, detail := ErrorCodes(err)
	switch {
	case IsRevoked(err):
		return LicenceRevoked
	case errors.As(err, &he) && he.Status == http.StatusTooManyRequests:
		return LicenceRateLimited
	case errors.Is(err, ErrUnavailable):
		return LicenceUnreachable
	case detail == LicenceUnclaimed || code == LicenceUnclaimed:
		return LicenceUnclaimed
	case detail == LicenceDevicesReached:
		return LicenceDevicesReached
	}
	return LicenceRefused
}

// ErrorCodes returns control's error code and details.code of a refusal ({error: {code, details: {code}}}).
func ErrorCodes(err error) (code, detail string) {
	var he *HTTPError
	if !errors.As(err, &he) {
		return "", ""
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				Code string `json:"code"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(he.Body), &body)
	return body.Error.Code, body.Error.Details.Code
}

// IsAlreadyClaimed: control says the device is claimed (409 claim_conflict / already_claimed).
func IsAlreadyClaimed(err error) bool {
	var he *HTTPError
	_, detail := ErrorCodes(err)
	return errors.As(err, &he) && he.Status == http.StatusConflict && detail == "already_claimed"
}

// IsRevoked: control retired the device (403 device_revoked); every device op answers so from then on.
func IsRevoked(err error) bool {
	var he *HTTPError
	code, _ := ErrorCodes(err)
	return errors.As(err, &he) && he.Status == http.StatusForbidden && code == "device_revoked"
}

// Assignment results (CT-28).
const (
	ResultAssigned  = "assigned"
	ResultUnchanged = "unchanged"
	ResultNone      = "none"
)

// Assignment polls update.assignment. raw is the signed assignment (verbatim, verified by the
// caller) and is present exactly when result is "assigned" (device.AssignmentResultValid).
func (c *Client) Assignment(ctx context.Context, current string, lastSequence int64) (result string, raw []byte, nextCheck time.Duration, err error) {
	var resp struct {
		Result     string          `json:"result"`
		Assignment json.RawMessage `json:"assignment"`
		NextCheckS int64           `json:"nextCheckS"`
	}
	if err := c.Do(ctx, device.DeviceOpNameUpdateAssignment, device.UpdateAssignmentRequest{Current: current, LastSequence: lastSequence}, &resp); err != nil {
		return "", nil, 0, err
	}
	present := len(resp.Assignment) > 0 && string(resp.Assignment) != "null"
	switch resp.Result {
	case ResultAssigned, ResultUnchanged, ResultNone:
	default:
		return "", nil, 0, fmt.Errorf("update.assignment: unknown result %q", resp.Result)
	}
	if (resp.Result == ResultAssigned) != present {
		return "", nil, 0, fmt.Errorf("update.assignment: result %q inconsistent with the assignment (CT-28)", resp.Result)
	}
	next := time.Duration(resp.NextCheckS) * time.Second
	if !present {
		return resp.Result, nil, next, nil
	}
	return resp.Result, resp.Assignment, next, nil
}

// Progress reports an update journal transition (update.progress).
func (c *Client) Progress(ctx context.Context, p device.UpdateProgressRequest) error {
	return c.Do(ctx, device.DeviceOpNameUpdateProgress, p, nil)
}

// Status posts the periodic device status (status.report) and returns the suggested interval.
func (c *Client) Status(ctx context.Context, s device.StatusReportRequest) (time.Duration, error) {
	var resp device.StatusReportResponse
	if err := c.Do(ctx, device.DeviceOpNameStatusReport, s, &resp); err != nil {
		return 0, err
	}
	return time.Duration(resp.NextReportS) * time.Second, nil
}

// JWSExpiry reads `exp` from a compact JWS payload without verifying it (the relay verifies
// tickets; the manager only needs expiry for caching).
func JWSExpiry(jws string) (time.Time, error) {
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return time.Time{}, errors.New("not a compact JWS")
	}
	p, err := b64(parts[1])
	if err != nil {
		return time.Time{}, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(p, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, errors.New("no exp claim")
	}
	return time.Unix(claims.Exp, 0), nil
}
