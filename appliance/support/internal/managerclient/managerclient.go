// Package managerclient is the support service's client of the manager's API socket (`/run/whombat-manager/api.sock`,
// SO_PEERCRED; the manager lets uid 0 use these routes, MG-118): the support route's relay ticket (device op
// `support.ticket` through the manager, cached there until 60 s before it expires) and the reads Look commands make —
// the hardware report, the network state, the update status and the box's measurements.
package managerclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/support/internal/relay"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// SocketDefault is the manager's API socket.
const SocketDefault = "/run/whombat-manager/api.sock"

// Paths on the manager's socket.
const (
	PathSupportTicket = "/v1/support/ticket"
	PathHardware      = local.ManagerPathHostHardware // POST {"v":1}
	PathNetworkState  = local.ManagerPathNetworkState // POST {"v":1}
	PathUpdateStatus  = local.ManagerPathUpdateStatus // GET
	PathHostMetrics   = local.ManagerPathHostMetrics  // POST {"v":1,"range":…,"timeZone":…}
)

// maxBody bounds an answer.
const maxBody = 4 << 20

// Client talks to the manager's socket.
type Client struct {
	socket string
	hc     *http.Client
}

// New is a client of the socket at socketPath.
func New(socketPath string) *Client {
	return &Client{socket: socketPath, hc: &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
		DisableKeepAlives: true,
	}}}
}

// Error is a refusal from the manager ({ error: { code, message } }).
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("manager: HTTP %d %s: %s", e.Status, e.Code, e.Message)
}

func (c *Client) do(ctx context.Context, method, path string, body any, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	r, err := http.NewRequestWithContext(ctx, method, "http://manager"+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(r)
	if err != nil {
		return nil, fmt.Errorf("manager: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("manager: %w", err)
	}
	if len(data) > maxBody {
		return nil, errors.New("manager: the answer is too large")
	}
	if resp.StatusCode/100 != 2 {
		e := &Error{Status: resp.StatusCode, Code: "unknown"}
		if le, err := local.ParseLocalError(data); err == nil {
			e.Code, e.Message = le.Error.Code, le.Error.Message
		}
		return nil, e
	}
	return data, nil
}

// Ticket fetches the support route's appliance ticket (POST /v1/support/ticket, `{}`); it implements
// relay.TicketSource.
func (c *Client) Ticket(ctx context.Context) (relay.Ticket, error) {
	data, err := c.do(ctx, http.MethodPost, PathSupportTicket, struct{}{}, 35*time.Second)
	if err != nil {
		return relay.Ticket{}, err
	}
	t, err := device.ParseTicketIssueResponse(data)
	if err != nil {
		return relay.Ticket{}, fmt.Errorf("manager: the ticket isn't the contract's: %w", err)
	}
	return relay.Ticket{Token: t.Ticket, ExpiresAt: time.Unix(t.ExpiresAt, 0), URL: t.Relay.URL, Worker: t.Relay.Worker}, nil
}

// json answers a JSON object.
func object(data []byte, err error) (json.RawMessage, error) {
	if err != nil {
		return nil, err
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, errors.New("manager: the answer isn't a JSON object")
	}
	return json.RawMessage(data), nil
}

// Hardware is the hardware report (HostHardwareResponse).
func (c *Client) Hardware(ctx context.Context) (json.RawMessage, error) {
	return object(c.do(ctx, http.MethodPost, PathHardware, local.HostHardwareRequest{V: 1}, 60*time.Second))
}

// NetworkState is the network state (NetworkStateResponse).
func (c *Client) NetworkState(ctx context.Context) (json.RawMessage, error) {
	return object(c.do(ctx, http.MethodPost, PathNetworkState, local.NetworkStateRequest{V: 1}, 30*time.Second))
}

// UpdateStatus is the update status (GET /v1/update/status).
func (c *Client) UpdateStatus(ctx context.Context) (json.RawMessage, error) {
	return object(c.do(ctx, http.MethodGet, PathUpdateStatus, nil, 30*time.Second))
}

// HostMetrics is the box's measurements over the last hour, in UTC (HostMetricsResponse).
func (c *Client) HostMetrics(ctx context.Context) (json.RawMessage, error) {
	req := local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"}
	return object(c.do(ctx, http.MethodPost, PathHostMetrics, req, 30*time.Second))
}
