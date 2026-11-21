package desk

// The step the assistant offers on a look (Whombat look-research.md LR-07, LR-08; contracts 3.5 `DESK_PATHS.lookFix`,
// `DeskLookFixRequest`; CG-371): the step's own button on the hero and the look's card (“Restart Zigbee”). The press is
// the person's go-ahead for that one step. The runtime takes it only while the screen is unlocked (409 `locked`), from
// a person who may manage the thing (403 `not_allowed`), for a look that still offers a step (404 `not_found`).

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathLookFix is DESK_PATHS.lookFix.
const PathLookFix = local.DeskPathLookFix

// LookFixRequest is DeskLookFixRequest.
type LookFixRequest = local.DeskLookFixRequest

// LookFixRequestFor checks the look's key the page sent and builds the runtime's request. Anything the socket wouldn't
// take (the schema, DESK_REQUEST_MAX_BYTES) is 400 without asking.
func LookFixRequestFor(key string) (*LookFixRequest, error) {
	req := &LookFixRequest{V: 1, Key: key}
	if req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	if b, err := json.Marshal(req); err != nil || len(b) > local.DeskRequestMaxBytes {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	return req, nil
}

// FixLook lets the assistant take the step it offers on a look. The runtime answers an ack; its refusals pass on with
// their codes, and the state is asked again after it (the look's research is `fixing` then).
func (c *Client) FixLook(ctx context.Context, key string) (*Ack, error) {
	req, err := LookFixRequestFor(key)
	if err != nil {
		return nil, err
	}
	defer c.Invalidate()
	return post(c, ctx, PathLookFix, req, c.callTimeout, local.ParseDeskAck)
}
