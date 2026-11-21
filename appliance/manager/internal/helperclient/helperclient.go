// Package helperclient calls the update helper socket with per-operation timeouts.
package helperclient

import (
	"context"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// Client is a helper client.
type Client struct{ Socket string }

// Do sends one typed operation.
func (c Client) Do(ctx context.Context, req proto.Request) (*proto.Result, error) {
	timeout := 5 * time.Minute
	switch req.Op {
	case proto.OpStageRuntime, proto.OpStageHost:
		timeout = 2 * time.Hour // imports of large closures
	case proto.OpActivateHostOnReboot:
		timeout = 30 * time.Minute // switch-to-configuration boot
	case proto.OpCollectGarbage:
		timeout = proto.CollectTimeout + 5*time.Minute // the helper stops the collection first (UP-X19)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req.V = proto.Version
	return proto.Do(ctx, c.Socket, req)
}
