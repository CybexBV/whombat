package collect

import (
	"encoding/hex"
	"strings"
	"time"

	golibvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

// The libvirt host view (proto.LibvirtDetail: pools, networks, unRAID's
// folders, firmware, QEMU's version, the backups folder) and each VM's
// newest Whombat backup, read every 5 minutes and again after the agent
// changed something (RefreshLibvirt).

const libvirtDetailEvery = 5 * time.Minute

// libvirtDetailState is the collector's cache of the host view.
type libvirtDetailState struct {
	at      time.Time
	dirty   bool
	detail  *proto.LibvirtDetail
	backups map[string]int64 // VM UUID (no dashes) or "name:<vm>" -> newest backup (unix)
}

// refreshDetail reads the host view when it is due and gives each guest
// its newest backup (LastBackup).
func (l *libvirtCollector) refreshDetail(conn *golibvirt.Libvirt, recs []golibvirt.DomainStatsRecord, guests []proto.Guest) *proto.LibvirtDetail {
	l.mu.Lock()
	ds := l.det
	l.mu.Unlock()
	first := ds.at.IsZero()
	if ds.detail == nil || ds.dirty || time.Since(ds.at) > libvirtDetailEvery {
		backupsDir := ""
		if l.c != nil && l.c.cfg != nil {
			backupsDir = l.c.cfg.Libvirt.BackupsDir
		}
		fsys := broker.OSLibvirtFS()
		if d, err := broker.ReadLibvirtDetail(conn, fsys, backupsDir); err == nil {
			ds = libvirtDetailState{at: time.Now(), detail: d, backups: map[string]int64{}}
			for k, v := range broker.LibvirtBackupTimes(fsys, d.BackupsDir) {
				ds.backups[strings.ReplaceAll(k, "-", "")] = v
			}
			if first {
				broker.CleanLibvirtTmpPools(conn)
			}
		} else if ds.detail == nil {
			return nil
		}
		l.mu.Lock()
		l.det = ds
		l.mu.Unlock()
	}
	uuids := map[string]string{}
	for _, rec := range recs {
		uuids[rec.Dom.Name] = hex.EncodeToString(rec.Dom.UUID[:])
	}
	for i := range guests {
		g := &guests[i]
		at, ok := ds.backups[uuids[g.ID]]
		if t, ok2 := ds.backups["name:"+g.ID]; ok2 && t > at {
			at, ok = t, true
		}
		if ok && at > 0 {
			g.LastBackup = &proto.BackupMark{Result: "ok", At: time.Unix(at, 0).UTC()}
		}
	}
	d := *ds.detail
	return &d
}

// RefreshLibvirt reads libvirt's host view and the domains again at the
// next Collect (a change went through the agent).
func (c *collector) RefreshLibvirt() {
	c.libvirt.mu.Lock()
	c.libvirt.det.dirty = true
	clear(c.libvirt.xmlCache)
	clear(c.libvirt.snaps)
	c.libvirt.mu.Unlock()
	c.libvirtSub.markDirty()
}

// libvirtNewestSnapshot is when a domain's newest snapshot was taken.
func libvirtNewestSnapshot(conn *golibvirt.Libvirt, dom golibvirt.Domain, n int) *time.Time {
	if n == 0 {
		return nil
	}
	snaps, _, err := conn.DomainListAllSnapshots(dom, 1, 0)
	if err != nil {
		return nil
	}
	var newest int64
	for _, s := range snaps {
		x, err := conn.DomainSnapshotGetXMLDesc(s, 0)
		if err != nil {
			continue
		}
		if i := strings.Index(x, "<creationTime>"); i >= 0 {
			rest := x[i+len("<creationTime>"):]
			if j := strings.Index(rest, "<"); j > 0 {
				var v int64
				for _, ch := range strings.TrimSpace(rest[:j]) {
					if ch < '0' || ch > '9' {
						v = 0
						break
					}
					v = v*10 + int64(ch-'0')
				}
				newest = max(newest, v)
			}
		}
	}
	if newest == 0 {
		return nil
	}
	t := time.Unix(newest, 0).UTC()
	return &t
}
