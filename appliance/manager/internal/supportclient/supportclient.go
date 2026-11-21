// Package supportclient reads the support service's state for status.report (remote help, MG-119): `GET /v1/state` on
// /run/whombat-support/api.sock (contracts 0.120.0 local `SUPPORT_PATHS.state`, CT-938), the only path the manager's uid
// may use there. What control gets from it is metadata only (RH-09): the state, the seconds left, how many are
// connected, whether a help code is needed and the service's SSH host key. The help code, the names and the visits are
// dropped as soon as the answer is checked: never kept, logged or sent.
package supportclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// StateTimeout bounds one state read: the service answers from memory.
const StateTimeout = 3 * time.Second

// stateMax bounds the answer (eight connections and a grant are well under 4 KiB).
const stateMax = 64 << 10

// Bounds of the report (DeviceStatusReport.support): at most 8 connected, a week left, a host key of 120 characters.
const (
	connectedMax = local.RemoteHelpConnectedMax
	untilMaxS    = local.RemoteHelpDurationWeekS
	hostKeyMax   = 120
)

// Client reads the support service's socket.
type Client struct {
	Socket string
}

// ErrAbsent: no support service listens (an image without it, or the service is down).
var ErrAbsent = errors.New("the support service doesn't answer")

// State is the service's SupportState, checked against the contract (local.ParseSupportState, then
// local.SupportStateValid), with the help code, who granted it and who is connected blanked out. A host key with a
// comment or surrounding space is taken bare (`ssh-ed25519 <base64>`) before the check.
func (c Client) State(ctx context.Context) (*local.SupportState, error) {
	ctx, cancel := context.WithTimeout(ctx, StateTimeout)
	defer cancel()
	hc := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", c.Socket)
	}}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://support"+local.SupportPathState, nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAbsent, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, stateMax+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAbsent, err)
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return nil, fmt.Errorf("the support service answered %d %s", resp.StatusCode, codeOf(e.Error.Code))
	}
	if len(data) > stateMax {
		return nil, errors.New("the support service's state is too large")
	}
	data = bareHostKey(data)
	st, err := local.ParseSupportState(data)
	if err != nil {
		return nil, errors.New("the support service's state isn't the contract's")
	}
	if !local.SupportStateValid(withCodeSlot(*st)) {
		return nil, errors.New("the support service's state is inconsistent")
	}
	if g := st.Grant; g != nil {
		g.HelpCode, g.GrantedBy = nil, protocol.RemoteHelpGrantedBy{}
	}
	for i := range st.Connected {
		st.Connected[i].Who = ""
	}
	return st, nil
}

// withCodeSlot is st as the contract's check expects it: the support service never gives the manager the help code
// (RH-09, NX-414), so on a box that needs one a stand-in fills its place for the check only; the rest is checked as is.
func withCodeSlot(st local.SupportState) local.SupportState {
	if g := st.Grant; g != nil && g.HelpCode == nil && st.HelpCodeRequired {
		gc := *g
		slot := "000000"
		gc.HelpCode = &slot
		st.Grant = &gc
	}
	return st
}

// bareHostKey rewrites the answer's `hostKey` without a comment or surrounding space (the lead's rule: control takes the
// bare key only); anything else is left as it is for the contract's check.
func bareHostKey(data []byte) []byte {
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil {
		return data
	}
	var k string
	if json.Unmarshal(m["hostKey"], &k) != nil {
		return data
	}
	if b := bareKey(k); b != k {
		m["hostKey"], _ = json.Marshal(b)
		if out, err := json.Marshal(m); err == nil {
			return out
		}
	}
	return data
}

var hostKeyRe = regexp.MustCompile(`^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$`)

var codeRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// codeOf keeps an error code to the shape codes have, so nothing else from the answer reaches a log line.
func codeOf(s string) string {
	if codeRe.MatchString(s) {
		return s
	}
	return "(no code)"
}

// Report is status.report's `support` from a state read at now (CT-944, RH-09): `off` with `untilS` null without a grant
// or once its `until` has passed (the service ends it within a second; the report never says a grant runs that is
// over), else the grant's level with the whole seconds left (null: forever); the connections counted up to 8; the help
// code needed; the host key when it is an ssh-ed25519 public key (anything else is left out, as unusable).
func Report(st *local.SupportState, now time.Time) *device.SupportReport {
	r := &device.SupportReport{State: device.SupportReportStateOff, HelpCode: st.HelpCodeRequired,
		Connected: int64(min(len(st.Connected), connectedMax))}
	if g := st.Grant; g != nil {
		left, forever := int64(0), g.Until == nil
		if !forever {
			until, _ := time.Parse(time.RFC3339Nano, *g.Until)
			// At most a week (the longest grant): a clock that moved can't make the report invalid.
			left = min(int64(until.Sub(now)/time.Second), untilMaxS)
		}
		if forever || left > 0 {
			r.State = device.SupportReportState(g.Level)
			if !forever {
				r.UntilS = &left
			}
		}
	}
	if st.HostKey != nil {
		if k := bareKey(*st.HostKey); ValidHostKey(k) {
			r.HostKey = &k
		}
	}
	return r
}

// bareKey is a public key line without its comment and surrounding space (`ssh-ed25519 <base64>`).
func bareKey(line string) string {
	f := strings.Fields(line)
	if len(f) < 2 {
		return strings.TrimSpace(line)
	}
	return f[0] + " " + f[1]
}

// ValidHostKey: `ssh-ed25519 <base64>` and nothing else (no comment), at most 120 characters, whose key blob is an
// Ed25519 public key in the SSH wire format (string "ssh-ed25519", string of 32 bytes).
func ValidHostKey(s string) bool {
	const prefix = "ssh-ed25519 "
	// The pattern first: Go's base64 decoder skips line breaks.
	if len(s) > hostKeyMax || !hostKeyRe.MatchString(s) {
		return false
	}
	blob, err := base64.StdEncoding.Strict().DecodeString(s[len(prefix):])
	if err != nil {
		return false
	}
	next := func() ([]byte, bool) {
		if len(blob) < 4 {
			return nil, false
		}
		n := binary.BigEndian.Uint32(blob)
		if uint64(len(blob)-4) < uint64(n) {
			return nil, false
		}
		v := blob[4 : 4+n]
		blob = blob[4+n:]
		return v, true
	}
	alg, ok := next()
	if !ok || !bytes.Equal(alg, []byte("ssh-ed25519")) {
		return false
	}
	key, ok := next()
	return ok && len(key) == 32 && len(blob) == 0
}

// Key is what control should hear about at once when it changes (MG-120): whether the service answers, the grant (on,
// off, its level and end), how many are connected, the host key, and whether a help code is needed. Only the seconds
// running down ride the next periodic report. nil (no answer) has its own key.
func Key(st *local.SupportState) string {
	if st == nil {
		return "absent"
	}
	k := fmt.Sprintf("available=%t code=%t connected=%d", st.Available, st.HelpCodeRequired, min(len(st.Connected), connectedMax))
	if st.HostKey != nil {
		k += " key=" + bareKey(*st.HostKey)
	}
	if g := st.Grant; g != nil {
		k += " grant=" + string(g.Level) + " since=" + g.Since
		if g.Until != nil {
			k += " until=" + *g.Until
		}
	}
	return k
}
