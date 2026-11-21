package desk

// Remote help on the desk (Whombat RH-04, RH-12; contracts 0.120.0 `DeskState.remoteHelp` and
// `DESK_PATHS.remoteHelpStop`, CT-943; CG-290…CG-292): while an owner lets Whombat support in, the glance says so with
// *Stop*, locked or not, paired or not, and Stop needs no unlock (it only ever takes access away).

import (
	"context"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathRemoteHelpStop is DESK_PATHS.remoteHelpStop.
const PathRemoteHelpStop = local.DeskPathRemoteHelpStop

// RemoteHelp is DeskState.remoteHelp: the level, until when (null: forever), who of Whombat support is connected now.
type RemoteHelp = local.DeskRemoteHelp

// maxWho is a support person's name (REMOTE_HELP_LIMITS.nameChars).
const maxWho = local.RemoteHelpNameChars

// cleanRemoteHelp cleans the state's remote help (the schema checked it): `until` in UTC, the name one line of at most
// 40 code points like every display string, an empty one nobody.
func cleanRemoteHelp(h *RemoteHelp) *RemoteHelp {
	if h == nil {
		return nil
	}
	if h.Until != nil {
		if t, err := time.Parse(time.RFC3339Nano, *h.Until); err == nil {
			u := t.UTC().Format(time.RFC3339)
			h.Until = &u
		}
	}
	h.Connected = optLine(h.Connected, maxWho)
	return h
}

// RemoteHelpStop stops remote help from the screen (*Stop*, RH-04): `{v: 1}`, no PIN, locked or not. The runtime
// answers the new DeskState (an ack is tolerated); anything else is 502 failed. The page gets an ack and asks for the
// state again.
func (c *Client) RemoteHelpStop(ctx context.Context) (*Ack, error) {
	defer c.Invalidate()
	ctx, cancel := context.WithTimeout(ctx, c.callTimeout)
	defer cancel()
	body, _, err := c.do(ctx, http.MethodPost, PathRemoteHelpStop, Request{V: 1}, maxStateBytes)
	if err != nil {
		return nil, err
	}
	if _, err := ParseState(body); err != nil {
		if _, err := local.ParseDeskAck(body); err != nil {
			return nil, &Error{Status: http.StatusBadGateway, Code: "failed"}
		}
	}
	return &Ack{V: 1}, nil
}
