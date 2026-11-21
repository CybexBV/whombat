package collect

import (
	"context"
	"os"
	"sync"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

// placeCollector reports the server as a backup place every minute
// (Report.BackupPlace, docs/MANAGE.md 2.10): whether it can keep backups,
// the root's space and the Whombats it keeps backups for, read from
// Docker's containers by label and the cleanups' status files. It pulls
// and changes nothing.
type placeCollector struct {
	r *broker.BackupPlaceReader

	mu   sync.Mutex
	last *proto.BackupPlace
}

func newPlaceCollector() *placeCollector {
	return &placeCollector{r: broker.NewBackupPlaceReader()}
}

func (p *placeCollector) run(ctx context.Context) error {
	bp := p.r.Read(ctx)
	p.mu.Lock()
	p.last = bp
	p.mu.Unlock()
	return nil
}

// snapshot is the last reading with the server's LAN addresses and the
// locations backups can live in (on Unraid its shares, from the same
// report).
func (p *placeCollector) snapshot(addrs []string, u *proto.Unraid) *proto.BackupPlace {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last == nil {
		return nil
	}
	bp := *p.last
	bp.Addresses = broker.PlaceAddresses(addrs)
	bp.Clients = append([]proto.BackupPlaceClient(nil), p.last.Clients...)
	bp.Locations = proto.PlaceLocations(&bp, u, dirExists)
	return &bp
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
