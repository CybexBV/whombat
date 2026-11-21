package daemon

import (
	"context"
	"os"
	"path/filepath"

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
		svc.Watch = &ownaddress.Watch{BaseURL: mode.CTURL, Store: store, Zone: mode.Zone, Log: d.Log}
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

// ownAddressLoop serves the ACME socket and runs the order loop (and with it the certificate watch).
func (d *Daemon) ownAddressLoop(ctx context.Context) {
	svc := d.OwnAddress
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
