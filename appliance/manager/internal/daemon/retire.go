package daemon

import (
	"context"
	"encoding/json"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
)

// ReregisterRequest is what the manager writes to Cfg.ReregisterRequest when control retired a
// self-installed appliance that was never claimed (MG-30, CL-33: retired after 7 days unclaimed and unseen).
// Root (whombat-self-provision.service, NX-35) checks it again, gives the appliance new keys and registers
// it again; control takes the same serial with new keys (CL-34).
type ReregisterRequest struct {
	V        int    `json:"v"`
	DeviceID string `json:"deviceId"`
	Reason   string `json:"reason"`
	At       string `json:"at"`
}

// onRetired asks for a re-registration only when every local fact says there is nothing to lose: the
// image allows it (a request path is configured, i.e. selfRegister), the device registered itself, the
// manager never saw a claim, and the runtime answers that it is not claimed. Anything else stays retired
// and needs a person (factory reset or support).
func (d *Daemon) onRetired(ctx context.Context) {
	if d.Cfg.ReregisterRequest == "" || d.Dev.Model != device.SelfInstalledModel {
		d.Log.Error("retired appliance: it needs a factory reset or support to be registered again")
		return
	}
	d.lease.mu.Lock()
	claimed := d.lease.claimed
	d.lease.mu.Unlock()
	f, err := d.Runtime.RuntimeFacts(ctx)
	if claimed || err != nil || f.Claimed {
		d.Log.Error("retired self-installed appliance that may be claimed: not registering it again", "runtimeFactsErr", err)
		return
	}
	b, _ := json.Marshal(ReregisterRequest{V: 1, DeviceID: d.Dev.DeviceID, Reason: "device_retired",
		At: time.Now().UTC().Format(time.RFC3339)})
	if err := writeFileAtomic(d.Cfg.ReregisterRequest, append(b, '\n')); err != nil {
		d.Log.Error("re-registration request", "err", err)
		return
	}
	d.Log.Warn("retired while never claimed: asked for new keys and a new self-registration", "request", d.Cfg.ReregisterRequest)
}
