package daemon

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
)

// setupOwnAddress builds the own address when this box has one (MG-161): a box whose environment has Link and names a
// zone, or of env dev or prod, or one switched on by WHOMBAT_OWN_ADDRESS. Its loop runs only while Link is starting, on
// or in grace (Run, whileLinkActive). Its state lives beside the journal (/persist/manager/own-address), its ACME socket
// beside the local API's (/run/whombat-manager/acme.sock). A problem here leaves the box without an own address, as on
// an older manager, and never stops the manager.
func (d *Daemon) setupOwnAddress(runtimeUID uint32) {
	if d.Link == nil || !d.Link.Available() {
		// The own address is a Link feature (LNK-05): no control in this environment, no label.
		d.Log.Info("own address: off", "why", "no Whombat Link in this environment")
		return
	}
	zone := ""
	if d.Env != nil {
		zone = d.Env.OwnAddressZone
	}
	mode, err := ownaddress.Resolve(d.Cfg.Community(), d.Dev.Env, zone, os.Getenv)
	if err != nil {
		d.Log.Warn("own address: off", "err", err)
		return
	}
	if !mode.Enabled {
		d.Log.Info("own address: off", "why", mode.Why)
		return
	}
	fail := func(err error) { d.Log.Error("own address: off after a problem", "err", err) }
	store, err := ownaddress.OpenStore(filepath.Join(filepath.Dir(filepath.Clean(d.Cfg.JournalDir)), "own-address"))
	if err != nil {
		fail(err)
		return
	}
	hc, err := ownaddress.HTTPClientWithCA(mode.CAFile)
	if err != nil {
		fail(err)
		return
	}
	svc, err := ownaddress.Open(mode, store, d.Log)
	if err != nil {
		fail(err)
		return
	}
	resp := &ownaddress.Responder{RuntimeUID: runtimeUID, Log: d.Log}
	svc.Responder = resp
	svc.Prober = &ownaddress.Prober{Responder: resp, Addr: mode.ProbeAddr}
	svc.Orderer = &ownaddress.Orderer{Directory: mode.Directory, HTTP: hc, Store: store, Responder: resp, Log: d.Log}
	if mode.CTURL != "" {
		svc.Watch = &ownaddress.Watch{BaseURL: mode.CTURL, Store: store, Log: d.Log}
	}
	d.OwnAddress = svc
	d.Broker.OwnAddress = svc
	d.Log.Info("own address: on", "why", mode.Why, "zone", mode.Zone, "directory", mode.Directory)
}

// ACMESocket is where the runtime pipes the door's acme streams: next to the local API's socket, which on a box is
// local.OwnAddressACMESocket.
func (d *Daemon) ACMESocket() string {
	return filepath.Join(filepath.Dir(d.Cfg.APISocket), "acme.sock")
}

// ownAddressLoop serves the ACME socket and runs the order loop (and with it the certificate watch), and follows
// control's view of the address now and then (a move that failed is tried again).
func (d *Daemon) ownAddressLoop(ctx context.Context) {
	svc := d.OwnAddress
	go func() {
		t := time.NewTicker(followAddressEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.followAddress(ctx)
			}
		}
	}()
	ln, err := svc.Responder.Bind(d.ACMESocket())
	if err != nil {
		// Without the socket no validation reaches the manager: the probe fails and says so in the state.
		d.Log.Error("own address: the ACME socket", "err", err)
	} else {
		served := make(chan struct{})
		go func() {
			defer close(served)
			if err := svc.Responder.Serve(ctx, ln); err != nil {
				d.Log.Error("own address: the ACME socket stopped", "err", err)
			}
		}()
		// The loop ends only once the socket is closed and its connections are done.
		defer func() { <-served }()
	}
	svc.Run(ctx)
}

// followAddressEvery: how often the box looks again at control's view of its address without a change to it.
const followAddressEvery = 30 * time.Minute

// followAddress keeps the own address with control's view in the Link state (link.status, tickets): it registers the
// label control gave a box that has none; it moves a box whose host is under prod's earlier zone to the zone control
// names (address.rename with its own label), once and only while nothing is leaving; and it takes a rename the box
// missed, when control says the box's host is the one leaving. One at a time, each with the newest state.
func (d *Daemon) followAddress(ctx context.Context) {
	if d.OwnAddress == nil || d.Control == nil || !d.linkActive() {
		return
	}
	d.addressMu.Lock()
	defer d.addressMu.Unlock()
	have, haveHost := d.OwnAddress.Label()
	if have == "" {
		d.registerLinkLabel(ctx)
		return
	}
	rec := d.Link.Snapshot()
	if rec.Label != "" && rec.Host != "" && rec.Host != haveHost && rec.AddressLeaving != nil && rec.AddressLeaving.Host == haveHost {
		// Control renamed the box and routes its host as the earlier one: the answer to the rename never arrived.
		changed, err := d.OwnAddress.Adopt(ownaddress.Address{Label: rec.Label, Host: rec.Host, Leaving: rec.AddressLeaving})
		if err != nil {
			d.warnOnce("own address: control's address in the Link state refused", err)
			return
		}
		d.clearErr("own address: control's address in the Link state refused")
		if changed {
			d.Broker.DropTickets()
			d.Log.Info("own address: took control's new address", "host", rec.Host)
		}
		return
	}
	if rec.AddressLeaving != nil || (rec.Host != "" && rec.Host != haveHost) {
		return
	}
	label, ok := d.OwnAddress.MoveWanted(rec.Zone)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := d.Broker.RenameAddress(ctx, label); err != nil {
		d.warnOnce("own address: the move to the new zone didn't happen yet (tried again later)", err)
		return
	}
	d.clearErr("own address: the move to the new zone didn't happen yet (tried again later)")
	_, host := d.OwnAddress.Label()
	d.Log.Info("own address: moved", "from", haveHost, "to", host)
}
