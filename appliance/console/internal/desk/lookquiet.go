package desk

// Quieting a look from the screen (Whombat quiet-notices.md QN-20; contracts 0.122.0 `DESK_PATHS.lookQuiet`,
// `DeskLookQuietRequest`, CT-1065; CG-330…): *Ignore* (until it changes) and *Not now* (until 09:00 tomorrow) on a
// look's card. The runtime takes it only while the screen is unlocked (409 `locked`) and from a person who may manage
// the thing (403 `not_allowed`), for a look and line it still has (404 `not_found`).

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathLookQuiet is DESK_PATHS.lookQuiet.
const PathLookQuiet = local.DeskPathLookQuiet

// LookQuietRequest is DeskLookQuietRequest.
type LookQuietRequest = local.DeskLookQuietRequest

// LookQuietRequestFor checks what the page sent and builds the runtime's request: the look's key, its line's check and
// subject as the state gave them (sent back unchanged: the runtime finds the line by them, CG-331) and how, `ignore` or
// `snooze`. Anything the socket wouldn't take (the schema, DESK_REQUEST_MAX_BYTES) is 400 without asking.
func LookQuietRequestFor(key, check string, subject *string, how string) (*LookQuietRequest, error) {
	req := &LookQuietRequest{V: 1, Key: key, How: local.DeskLookQuietHow(how),
		Notice: local.DeskLookQuietRequestNotice{Check: check, Subject: subject}}
	if !slices.Contains(local.DeskLookQuietHowValues, req.How) || req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	if b, err := json.Marshal(req); err != nil || len(b) > local.DeskRequestMaxBytes {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	return req, nil
}

// QuietLook ignores a look until it changes (`ignore`) or puts it off until tomorrow (`snooze`) for the whole Whombat
// (QN-14). The runtime answers an ack; its refusals pass on with their codes, and the state is asked again after it.
func (c *Client) QuietLook(ctx context.Context, key, check string, subject *string, how string) (*Ack, error) {
	req, err := LookQuietRequestFor(key, check, subject, how)
	if err != nil {
		return nil, err
	}
	defer c.Invalidate()
	return post(c, ctx, PathLookQuiet, req, c.callTimeout, local.ParseDeskAck)
}
