package daemon

// The backup service's status in the runtime's facts (MG-152): the runtime shows it, and its backup-key job locks the
// passkey copy of the backup details again when the last backup, the place or the generation changes. Without it the
// runtime read the service only when it had no report, and its job never saw a backup happen.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/backupclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// backupFactsTimeout bounds the status read inside a facts push: the update facts mustn't wait on a slow backup service.
const backupFactsTimeout = 5 * time.Second

const backupFactsUnusable = "the backup service's status is unusable (the runtime's facts go without it)"

// backupFacts is the backup service's status for the runtime's facts: nil without a backup service, when it doesn't
// answer, or when what it answers isn't the contract's (logged once). The runtime reads nil as “unknown” and then asks
// the service itself, never as “not backed up”.
func (d *Daemon) backupFacts(ctx context.Context) *local.BackupServiceStatus {
	if d.Cfg.BackupSocket == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, backupFactsTimeout)
	defer cancel()
	st, err := backupclient.Client{Socket: d.Cfg.BackupSocket}.Status(ctx)
	if err != nil {
		d.debugOnce("backup facts", "the backup service's status can't be read for the runtime's facts", err)
		return nil
	}
	if err := st.Validate(); err != nil {
		d.warnOnce(backupFactsUnusable, err)
		return nil
	}
	d.clearErr(backupFactsUnusable)
	return st
}

// backupKey is what of the status the runtime should hear about at once: everything but its age and the time it was
// read, which change on every read (the periodic resend keeps those fresh).
func backupKey(st *local.BackupServiceStatus) string {
	if st == nil {
		return "none"
	}
	c := *st
	c.UpdatedAt = ""
	if c.LastSuccess != nil {
		s := *c.LastSuccess
		s.AgeSeconds = 0
		c.LastSuccess = &s
	}
	b, _ := json.Marshal(c)
	return string(b)
}

// backupWatchLoop looks at the backup service's status every BackupWatchSec and hands the runtime its facts when the
// status differs from the one it was last handed: a backup finished or failed, one started, the place or the generation
// changed. A push that fails is tried again at the next look (and runtimeSyncLoop hands the facts over once the runtime
// is back).
func (d *Daemon) backupWatchLoop(ctx context.Context) {
	every := config.Seconds(d.Cfg.BackupWatchSec, 15*time.Second)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		key := backupKey(d.backupFacts(ctx))
		d.factsMu.Lock()
		sent := d.backupSent
		d.factsMu.Unlock()
		if key == sent {
			continue
		}
		if err := d.sendFacts(ctx); err != nil && ctx.Err() == nil {
			d.debugOnce("backup facts push", "the backup service's new status didn't reach the runtime (tried again)", err)
		}
	}
}
