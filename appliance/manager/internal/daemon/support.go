package daemon

// Remote help (Whombat RH-06, RH-09; MG-118…MG-120): the support service's tickets go through the broker
// (local.ManagerPathSupportTicket); status.report carries `support` from the service's state when its socket answers; and a
// change control should know at once (turned on, changed, stopped) asks for a report within seconds, so support tools can
// connect soon after an owner turns remote help on.

import (
	"context"
	"errors"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/supportclient"
	"github.com/CybexBV/whombat/contracts/go/device"
)

// supportReport is status.report's `support` now: nil when the support service doesn't answer (an image without it, the
// service restarting) or answers something invalid (logged once, without its contents). The status loop checks it with
// the whole report. With it comes the state's supportclient.Key, which the status loop keeps once control took the
// report (supportTold).
func (d *Daemon) supportReport(ctx context.Context) (*device.SupportReport, string) {
	if d.Cfg.SupportSocket == "" {
		return nil, ""
	}
	st, err := supportclient.Client{Socket: d.Cfg.SupportSocket}.State(ctx)
	if err != nil {
		if !errors.Is(err, supportclient.ErrAbsent) {
			d.warnOnce("the support service's state is unusable (status.report goes without remote help)", err)
		}
		return nil, supportclient.Key(nil)
	}
	r := supportclient.Report(st, time.Now())
	d.clearErr("the support service's state is unusable (status.report goes without remote help)")
	return r, supportclient.Key(st)
}

// supportWatchLoop looks at the support service's state every SupportWatchSec and asks for a status.report when what
// control should know changed (supportclient.Key): without it control would learn of a grant only at the next periodic
// report, up to 15 minutes later, and refuse support.open until then (MG-120).
//
// A look is compared with the look before it, except once: the first look after control took a report is compared
// with what that report said. The start-up report goes out before the watch's first look, so an owner who turned
// remote help on or off in between would otherwise be the watch's starting point, and control would hear of it only
// at the next periodic report.
func (d *Daemon) supportWatchLoop(ctx context.Context) {
	every := config.Seconds(d.Cfg.SupportWatchSec, 10*time.Second)
	if d.supportEvery > 0 {
		every = d.supportEvery
	}
	c := supportclient.Client{Socket: d.Cfg.SupportSocket}
	last := ""
	compared := false // a look was compared with what control was told
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		st, _ := c.State(ctx)
		key := supportclient.Key(st)
		was := last
		if !compared {
			if told := d.supportTold.Load(); told != nil {
				was, compared = *told, true
			}
		}
		if was != "" && key != was {
			select {
			case d.statusNow <- struct{}{}:
			default: // a report is already asked for: it reads the support state when it is sent
			}
		}
		last = key
	}
}
