package daemon_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// A commercial box of env dev has an own address (MG-161): the service is built, its state lives beside the journal,
// and the ACME socket sits beside the local API's. WHOMBAT_OWN_ADDRESS=off leaves the manager as before it.
func TestOwnAddressOnByEnv(t *testing.T) {
	h := startDaemon(t, nil)
	d := h.d
	if d.OwnAddress == nil {
		t.Fatal("no own address on a dev box")
	}
	if got, want := d.OwnAddress.Store.Dir(), filepath.Join(filepath.Dir(h.cfg.JournalDir), "own-address"); got != want {
		t.Fatalf("state in %s, want %s", got, want)
	}
	if fi, err := os.Stat(d.OwnAddress.Store.Dir()); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("state directory: %v %v", fi, err)
	}
	sock := filepath.Join(filepath.Dir(h.cfg.APISocket), "acme.sock")
	if d.ACMESocket() != sock {
		t.Fatal(d.ACMESocket())
	}
	h.eventually("the ACME socket", func() bool {
		fi, err := os.Stat(sock)
		return err == nil && fi.Mode().Type() == os.ModeSocket && fi.Mode().Perm() == 0o660
	}, func() string { return sock })
	if st := d.OwnAddress.State(); !st.Enabled || st.Acme.State != "idle" {
		t.Fatalf("state %+v", st)
	}
}

func TestOwnAddressSwitchedOff(t *testing.T) {
	t.Setenv("WHOMBAT_OWN_ADDRESS", "off")
	h := startDaemon(t, nil)
	if h.d.OwnAddress != nil || h.d.Broker.OwnAddress != nil {
		t.Fatal("an own address with WHOMBAT_OWN_ADDRESS=off")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(h.cfg.APISocket), "acme.sock")); !os.IsNotExist(err) {
		t.Fatalf("an ACME socket: %v", err)
	}
}

// selfOrderer issues a self-signed pair for any host at once: the order loop without a CA.
type selfOrderer struct{ store *ownaddress.Store }

func (o selfOrderer) Order(_ context.Context, host string) (*ownaddress.Pair, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{SerialNumber: serial, DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(90 * 24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return o.store.SavePair([][]byte{der}, key)
}

type okProber struct{}

func (okProber) Probe(context.Context, string) error { return nil }

// A box of prod's zones under box.whombat.app moves by itself once control names whombat.app (here through the state a
// ticket carries): one address.rename with its own label, the old host answering with its pair while the new host's
// certificate is ordered. Nothing more happens after.
func TestOwnAddressMovesItself(t *testing.T) {
	t.Parallel()
	label := "maple-otter-river"
	const oldHost, newHost = "maple-otter-river.box.whombat.app", "maple-otter-river.whombat.app"
	h := startDaemonWith(t, nil, func(d *daemon.Daemon) {
		svc := d.OwnAddress
		svc.Mode.Zone = "whombat.app" // a prod environment's zones; the test's box is otherwise of env dev
		svc.Prober, svc.Orderer, svc.Watch = okProber{}, selfOrderer{svc.Store}, nil
	}, func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) {
		fc.Zone = "box.whombat.app"
		fc.Link = &device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: 1790000000, Label: &label}
	})
	svc := h.d.OwnAddress
	var first string
	h.eventually("a certificate for the old host", func() bool {
		c, ok := svc.Cert("")
		if ok && c.Host == oldHost {
			first = c.Serial
		}
		return first != ""
	}, func() string { return fmt.Sprintf("%+v", svc.State()) })
	h.fc.Set(func(f *fakecontrol.Control) {
		if f.RenameCalls != 0 {
			t.Error("moved before control named the new zone")
		}
		f.Zone = "whombat.app"
	})
	if code, body := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusOK {
		t.Fatalf("ticket: %d %s", code, body)
	}
	h.eventually("the move and the new host's certificate", func() bool {
		c, ok := svc.Cert("")
		return ok && c.Host == newHost
	}, func() string { return fmt.Sprintf("%+v", svc.State()) })
	st := svc.State()
	if st.Leaving == nil || st.Leaving.Host != oldHost {
		t.Fatalf("%+v", st)
	}
	if c, ok := svc.Cert(oldHost); !ok || c.Serial != first {
		t.Fatal("the old host lost its pair")
	}
	if r := h.d.Link.Snapshot(); r.Host != newHost {
		t.Fatalf("link state %+v", r)
	}
	// Control's next answers name the new host and the leaving one: no second move.
	if code, _ := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusOK {
		t.Fatal(code)
	}
	time.Sleep(500 * time.Millisecond)
	h.fc.Set(func(f *fakecontrol.Control) {
		if f.RenameCalls != 1 {
			t.Errorf("%d renames, want 1", f.RenameCalls)
		}
	})
}

// The owner renamed the moved box, and control took it, but the answer never reached the box. Control's next state
// names the new host and still the first one as leaving (not the box's): the box takes control's host, orders its
// certificate, and keeps answering at the first host with its pair; the name in between stops.
func TestOwnAddressTakesARenameItMissed(t *testing.T) {
	t.Parallel()
	label := "maple-otter-river"
	const oldHost, newHost, homeHost = "maple-otter-river.box.whombat.app", "maple-otter-river.whombat.app", "home.whombat.app"
	h := startDaemonWith(t, nil, func(d *daemon.Daemon) {
		svc := d.OwnAddress
		svc.Mode.Zone = "whombat.app"
		svc.Prober, svc.Orderer, svc.Watch = okProber{}, selfOrderer{svc.Store}, nil
	}, func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) {
		fc.Zone = "box.whombat.app"
		fc.Link = &device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: 1790000000, Label: &label}
	})
	svc := h.d.OwnAddress
	var first string
	h.eventually("a certificate for the first host", func() bool {
		c, ok := svc.Cert("")
		if ok && c.Host == oldHost {
			first = c.Serial
		}
		return first != ""
	}, func() string { return fmt.Sprintf("%+v", svc.State()) })
	h.fc.Set(func(f *fakecontrol.Control) { f.Zone = "whombat.app" })
	if code, body := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusOK {
		t.Fatalf("ticket: %d %s", code, body)
	}
	h.eventually("the move", func() bool {
		c, ok := svc.Cert("")
		return ok && c.Host == newHost
	}, func() string { return fmt.Sprintf("%+v", svc.State()) })

	// The rename happens at control; its answer is lost.
	h.fc.Set(func(f *fakecontrol.Control) {
		for dev := range f.Addresses {
			f.Addresses[dev] = device.AddressRegisterResponse{Label: "home", Host: homeHost, RegisteredAt: 1790000500}
		}
	})
	if code, body := post(t, h, local.ManagerPathTicket, ticketBody); code != http.StatusOK {
		t.Fatalf("ticket: %d %s", code, body)
	}
	h.eventually("control's host and its certificate", func() bool {
		c, ok := svc.Cert("")
		return ok && c.Host == homeHost
	}, func() string { return fmt.Sprintf("%+v", svc.State()) })
	if st := svc.State(); st.Leaving == nil || st.Leaving.Host != oldHost {
		t.Fatalf("%+v", st)
	}
	if c, ok := svc.Cert(oldHost); !ok || c.Serial != first {
		t.Fatal("the first host lost its pair")
	}
	if _, ok := svc.Cert(newHost); ok {
		t.Fatal("the name in between still answers")
	}
	h.fc.Set(func(f *fakecontrol.Control) {
		if f.RenameCalls != 1 {
			t.Errorf("%d renames, want only the move", f.RenameCalls)
		}
	})
}
