// Package control registers a device's public identities with control's provisioning endpoint
// (`devices.register`, POST /v1/provisioning/devices, @whombat/control-contracts 0.3.0 CT-18) and then its
// claim verifier (`devices.registerClaimVerifier`, POST /v1/provisioning/devices/:device/claim-verifier,
// contracts 0.5.1 CT-43). The body is
// the contracts' DeviceRegistration, signed by both device keys with the vendored Go binding. Control
// assigns the device id. The bearer token is a factory-station credential that never lands on the
// device's disk.
//
// A self-installed appliance (CC-10) registers the same signed body at `POST /v1/devices/self-register`
// without any credential (SelfClient); control accepts it only where self-registration is enabled.
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
)

// Path of devices.register (CONTROL_PREFIX + path in @whombat/control-contracts).
const Path = "/v1/provisioning/devices"

// SelfRegisterPath is the credential-free self-registration of CC-10 (contracts 0.7.0).
const SelfRegisterPath = "/v1/devices/self-register"

// VerifierPath is devices.registerClaimVerifier (CT-43) for a device id.
func VerifierPath(deviceID string) string {
	return Path + "/" + url.PathEscape(deviceID) + "/claim-verifier"
}

// ErrVerifierConflict means control already holds a different claim verifier for the device.
var ErrVerifierConflict = errors.New("control: a different claim verifier is registered (claim_verifier_exists)")

// ErrConflict means control already has a device with this serial or key material: a duplicate
// identity or serial (a cloned image, a re-used serial). Provisioning must stop.
var ErrConflict = errors.New("control: conflicting registration (duplicate serial or key)")

// Client talks to control.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// Register posts a signed registration and returns control's answer (device id, route, env).
func (c *Client) Register(ctx context.Context, reg *device.DeviceRegistration) (*device.DeviceRegistrationResponse, error) {
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	return register(ctx, c.HTTP, strings.TrimRight(c.BaseURL, "/")+Path, c.Token, reg)
}

// SelfClient registers a self-installed appliance (CC-10): no bearer token.
type SelfClient struct {
	BaseURL string
	HTTP    *http.Client
}

// ErrSelfRegistrationClosed means control does not take self-registrations (SELF_REGISTRATION off, 403/404).
var ErrSelfRegistrationClosed = errors.New("control: self-registration is not enabled here")

// ErrRateLimited means control's per-address self-registration budget is spent (429); try again later.
var ErrRateLimited = errors.New("control: too many registrations from this address; try again later")

// Register posts the signed registration to the self-register endpoint.
func (c *SelfClient) Register(ctx context.Context, reg *device.DeviceRegistration) (*device.DeviceRegistrationResponse, error) {
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	return register(ctx, c.HTTP, strings.TrimRight(c.BaseURL, "/")+SelfRegisterPath, "", reg)
}

func register(ctx context.Context, hc *http.Client, url, token string, reg *device.DeviceRegistration) (*device.DeviceRegistrationResponse, error) {
	if err := reg.Validate(); err != nil {
		return nil, fmt.Errorf("registration: %w", err)
	}
	body, err := json.Marshal(reg)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated:
		var r device.DeviceRegistrationResponse
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("control: bad response: %w", err)
		}
		if r.Device == "" || r.ApplianceRoute == "" || r.Env != reg.Env {
			return nil, errors.New("control: response does not match the registration")
		}
		return &r, nil
	case http.StatusConflict:
		return nil, fmt.Errorf("%w: %s", ErrConflict, strings.TrimSpace(string(data)))
	case http.StatusTooManyRequests:
		return nil, fmt.Errorf("%w: %s", ErrRateLimited, strings.TrimSpace(string(data)))
	case http.StatusForbidden, http.StatusNotFound:
		if token == "" {
			return nil, fmt.Errorf("%w (HTTP %d): %s", ErrSelfRegistrationClosed, resp.StatusCode, strings.TrimSpace(string(data)))
		}
		return nil, fmt.Errorf("control: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	default:
		return nil, fmt.Errorf("control: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
}

// RegisterClaimVerifier registers the device's claim verifier (devices.registerClaimVerifier, CT-43):
// 201 created or 200 for the identical value again; 409 a different verifier exists.
func (c *Client) RegisterClaimVerifier(ctx context.Context, deviceID, verifier string) error {
	if c.HTTP == nil {
		c.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	body := device.ClaimVerifierRegistration{ClaimVerifier: verifier}
	if err := body.Validate(); err != nil {
		return fmt.Errorf("claim verifier: %w", err)
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+VerifierPath(deviceID), bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("control: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated:
		return nil
	case http.StatusConflict:
		return fmt.Errorf("%w: %s", ErrVerifierConflict, strings.TrimSpace(string(data)))
	default:
		return fmt.Errorf("control: claim verifier: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
}
