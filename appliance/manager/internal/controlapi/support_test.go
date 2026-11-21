package controlapi_test

import (
	"context"
	"crypto/ed25519"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/contracts/go/device"
)

func supportClient(t *testing.T) (*fakecontrol.Control, *controlapi.Client) {
	t.Helper()
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	pub, priv, _ := ed25519.GenerateKey(nil)
	fc.Devices["dev_1"] = pub
	return fc, &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "dev_1", Key: priv}
}

// supportStatus is a plain status report (the support tests' own).
func supportStatus() device.StatusReportRequest {
	return device.StatusReportRequest{Release: "whombat-dev-20261021.17", ManagerVersion: "0.3.0-0.dev", UptimeS: 10,
		Update:      device.StatusReportRequestUpdate{State: "Healthy"},
		Health:      device.StatusReportRequestHealth{Runtime: "ok", Database: "ok", Runner: "ok", SessionEndpoint: "ok", Relay: "ok", Backup: "unconfigured"},
		RecoveryKit: "not_created"}
}

// MG-118: support.ticket is a signed device op with the body {}, verified by the contract's verifier; the answer is
// checked as SupportTicketResponse.
func TestSupportTicket(t *testing.T) {
	fc, c := supportClient(t)
	tk, err := c.SupportTicket(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exp, err := controlapi.JWSExpiry(tk.Ticket); err != nil || exp.Unix() != tk.ExpiresAt || fc.SupportTickets != 1 || len(fc.AuthErrors) != 0 {
		t.Fatalf("%+v %v %v", tk, err, fc.AuthErrors)
	}
}

// MG-119: status.report carries `support`.
func TestStatusWithSupport(t *testing.T) {
	left := int64(3600)
	key := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBP1R/FPWtslgeNqtsKOMeiASK9J6pg6a60TIETgQXtA"
	sup := &device.SupportReport{State: device.SupportReportStateLook, UntilS: &left, Connected: 1, HelpCode: true, HostKey: &key}
	{
		fc, c := supportClient(t)
		s := supportStatus()
		s.Support = sup
		if _, err := c.Status(context.Background(), s); err != nil {
			t.Fatal(err)
		}
		got := fc.StatusReports()[0].Support
		if got == nil || got.State != "look" || *got.UntilS != 3600 || got.Connected != 1 || !got.HelpCode || *got.HostKey != key {
			t.Fatalf("%+v", got)
		}
	}
	// Off: untilS null, sent as such.
	fc, c := supportClient(t)
	s := supportStatus()
	s.Support = &device.SupportReport{State: device.SupportReportStateOff}
	if _, err := c.Status(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if got := fc.StatusReports()[0].Support; got == nil || got.State != "off" || got.UntilS != nil || got.HostKey != nil {
		t.Fatalf("%+v", got)
	}
	// An invalid member never leaves: the contract's schema checks it before signing.
	s.Support = &device.SupportReport{State: "root"}
	if _, err := c.Status(context.Background(), s); err == nil {
		t.Fatal("support.state root was signed")
	}
}
