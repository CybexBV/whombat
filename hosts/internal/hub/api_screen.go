package hub

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/jpeg" // DecodeConfig of the agent's pictures
	_ "image/png"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// A Mac's screen for the Whombat server's tools (docs/WHOMBAT.md "A Mac's
// screen"):
//
//	POST /servers/{id}/screen   one screen step {op, …} (operator for status, admin for the rest; host shell switches)

// screenOps are the steps the route passes on. Only status is an
// operator's (and isn't audited); every other step needs an admin: a look
// shows what the person has open and ui.list other apps' field values.
// screenReads are the steps that only look: audited with the op and the app,
// never what they saw. screenPlaces carry places (addresses to look up, pins
// on a map): audited with the op alone, never a place.
var (
	screenOps = []string{
		proto.ScreenStatus, proto.ScreenLook, proto.ScreenClick, proto.ScreenDrag, proto.ScreenScroll,
		proto.ScreenType, proto.ScreenKeys, proto.ScreenUnlock, proto.ScreenPassword, proto.ScreenAccountSet, proto.ScreenAccountCheck,
		proto.ScreenAccountClear, proto.ScreenUIApps, proto.ScreenUIList, proto.ScreenUIPress, proto.ScreenUISet,
		proto.ScreenUIMenu, proto.ScreenUIFocus, proto.ScreenUIOpen, proto.ScreenUIAction, proto.ScreenUIQuit,
		proto.ScreenMapGeocode, proto.ScreenMapSnapshot,
	}
	screenOperatorOps = []string{proto.ScreenStatus}
	screenReads       = []string{proto.ScreenLook, proto.ScreenUIApps, proto.ScreenUIList}
	screenPlaces      = []string{proto.ScreenMapGeocode, proto.ScreenMapSnapshot}
)

// The limits of a step's fields, the agent's (docs/WHOMBAT.md "A Mac's
// screen"): the route refuses beyond them before the agent is asked.
const (
	screenTypeMax    = 2000  // type: characters
	screenValueMax   = 10000 // ui.set's value: characters
	screenKeysMax    = 500   // keys: characters (the agent: 50 chords)
	screenNameMax    = 200   // app, window, name, a menu item: characters
	screenRoleMax    = 64    // role: characters (the agent: 8 roles)
	screenTargetMax  = 2048  // ui.open's target
	screenPathMax    = 8     // ui.menu's path: items
	screenPointMax   = 16384 // x, y, to_x, to_y: pixels, 0 or more
	screenScrollMax  = 50    // dx, dy: steps each way
	screenMaxW       = 8192  // look's max_w (0: full size)
	screenIndexMax   = 1000  // index
	screenLimitMax   = 1000  // ui.list's limit (0: 300)
	screenAccountMax = 63    // account user and password: bytes (Apple's sign-in)
	screenQueriesMax = 8     // map.geocode's queries
	screenQueryMax   = 300   // one query: characters
	screenMapSideMin = 64    // map.snapshot's w and h: points (0: 600×400)
	screenMapSideMax = 1600
	screenPinsMax    = 20         // map.snapshot's pins
	screenSpanMin    = 50.0       // map.snapshot's span_m: metres
	screenSpanMax    = 20_000_000 // about half the world round
)

// screenGrace is how much longer than the agent's own limit for a step
// (proto.ScreenStepLimit: 25 s, password and unlock 60 s) the route waits:
// 30 s, password and unlock 65 s.
const screenGrace = 5 * time.Second

// isMac reports whether the server's agent reports a Mac.
func isMac(st *model.ServerState) bool {
	return st != nil && st.Report != nil && st.Report.MacOS != nil
}

type screenBody struct {
	Op      string   `json:"op"`
	X       int      `json:"x"`
	Y       int      `json:"y"`
	ToX     int      `json:"to_x"`
	ToY     int      `json:"to_y"`
	Button  string   `json:"button"`
	Clicks  int      `json:"clicks"`
	DX      int      `json:"dx"`
	DY      int      `json:"dy"`
	Text    string   `json:"text"`
	Keys    string   `json:"keys"`
	MaxW    int      `json:"max_w"`
	Format  string   `json:"format"`
	App     string   `json:"app"`
	Window  string   `json:"window"`
	Name    string   `json:"name"`
	Role    string   `json:"role"`
	Index   int      `json:"index"`
	Path    []string `json:"path"`
	Limit   int      `json:"limit"`
	Target  string   `json:"target"`
	Account *struct {
		User     string `json:"user"`
		Password string `json:"password"`
	} `json:"account"`
	Action  string   `json:"action"`
	Queries []string `json:"queries"`
	W       int      `json:"w"`
	H       int      `json:"h"`
	Scale   int      `json:"scale"`
	Dark    bool     `json:"dark"`
	Pins    []struct {
		Lat float64 `json:"lat"`
		Lon float64 `json:"lon"`
	} `json:"pins"`
	Lat   *float64 `json:"lat"`
	Lon   *float64 `json:"lon"`
	SpanM float64  `json:"span_m"`
	Crop  *struct {
		X int `json:"x"`
		Y int `json:"y"`
		W int `json:"w"`
		H int `json:"h"`
	} `json:"crop"`
}

// check bounds the fields; the agent checks the rest (and answers
// invalid_request).
func (b screenBody) check() *apiError {
	text := func(field, v string, n int) *apiError {
		if utf8.RuneCountInString(v) > n || strings.ContainsRune(v, 0) || !utf8.ValidString(v) {
			return invalidFields(map[string]string{field: fmt.Sprintf("At most %d characters of text.", n)})
		}
		return nil
	}
	if !slices.Contains(screenOps, b.Op) {
		return invalidFields(map[string]string{"op": "One of " + strings.Join(screenOps, ", ") + "."})
	}
	textMax := screenValueMax
	if b.Op == proto.ScreenType {
		textMax = screenTypeMax
	}
	for _, f := range []struct {
		name string
		v    string
		n    int
	}{{"text", b.Text, textMax}, {"keys", b.Keys, screenKeysMax}, {"button", b.Button, 16}, {"format", b.Format, 8},
		{"app", b.App, screenNameMax}, {"window", b.Window, screenNameMax}, {"name", b.Name, screenNameMax},
		{"role", b.Role, screenRoleMax}, {"target", b.Target, screenTargetMax}, {"action", b.Action, screenNameMax}} {
		if e := text(f.name, f.v, f.n); e != nil {
			return e
		}
	}
	if len(b.Queries) > screenQueriesMax {
		return invalidFields(map[string]string{"queries": fmt.Sprintf("At most %d places to find.", screenQueriesMax)})
	}
	for _, q := range b.Queries {
		if e := text("queries", q, screenQueryMax); e != nil {
			return e
		}
	}
	if e := b.checkMap(); e != nil {
		return e
	}
	if len(b.Path) > screenPathMax {
		return invalidFields(map[string]string{"path": fmt.Sprintf("At most %d menu items.", screenPathMax)})
	}
	for _, p := range b.Path {
		if e := text("path", p, screenNameMax); e != nil {
			return e
		}
	}
	for name, v := range map[string]int{"x": b.X, "y": b.Y, "to_x": b.ToX, "to_y": b.ToY} {
		if v < 0 || v > screenPointMax {
			return invalidFields(map[string]string{name: "A point on the screen, in pixels (0 or more)."})
		}
	}
	for _, f := range []struct {
		name     string
		v, lo, n int
		msg      string
	}{
		{"dx", b.DX, -screenScrollMax, screenScrollMax, fmt.Sprintf("At most %d scroll steps each way.", screenScrollMax)},
		{"dy", b.DY, -screenScrollMax, screenScrollMax, fmt.Sprintf("At most %d scroll steps each way.", screenScrollMax)},
		{"clicks", b.Clicks, 0, 3, "1, 2 or 3."},
		{"max_w", b.MaxW, 0, screenMaxW, fmt.Sprintf("0 (full size) to %d pixels.", screenMaxW)},
		{"index", b.Index, 0, screenIndexMax, fmt.Sprintf("0 to %d.", screenIndexMax)},
		{"limit", b.Limit, 0, screenLimitMax, fmt.Sprintf("0 (300) to %d.", screenLimitMax)},
	} {
		if f.v < f.lo || f.v > f.n {
			return invalidFields(map[string]string{f.name: f.msg})
		}
	}
	if b.Op == proto.ScreenAccountSet {
		if b.Account == nil || b.Account.User == "" || b.Account.Password == "" {
			return invalidFields(map[string]string{"account": "Give the Mac's user name and password."})
		}
		if len(b.Account.User) > screenAccountMax || len(b.Account.Password) > screenAccountMax {
			return invalidFields(map[string]string{"account": "The user name and password are at most 63 bytes each."})
		}
		for _, v := range []string{b.Account.User, b.Account.Password} {
			if !utf8.ValidString(v) || strings.ContainsAny(v, "\x00\r\n") {
				return invalidFields(map[string]string{"account": "The user name and password are one line of text each."})
			}
		}
	} else if b.Account != nil {
		return invalidFields(map[string]string{"account": "Only account.set takes an account."})
	}
	if b.Op == proto.ScreenPassword && b.Text != "" {
		// The Mac's own password is typed by the agent from its keeping;
		// a request never carries one.
		return invalidFields(map[string]string{"text": "password types the Mac's stored password; it takes no text."})
	}
	return nil
}

// checkMap bounds the map's and the crop's fields.
func (b screenBody) checkMap() *apiError {
	bad := func(field, msg string) *apiError { return invalidFields(map[string]string{field: msg}) }
	for name, v := range map[string]int{"w": b.W, "h": b.H} {
		if v != 0 && (v < screenMapSideMin || v > screenMapSideMax) {
			return bad(name, fmt.Sprintf("%d to %d points (0: 600×400).", screenMapSideMin, screenMapSideMax))
		}
	}
	if b.Scale < 0 || b.Scale > 2 {
		return bad("scale", "1 or 2 pixels per point (0: 2).")
	}
	if len(b.Pins) > screenPinsMax {
		return bad("pins", fmt.Sprintf("At most %d pins.", screenPinsMax))
	}
	for _, p := range b.Pins {
		if !placeOK(p.Lat, p.Lon) {
			return bad("pins", "A pin's lat is −90 to 90 and its lon −180 to 180.")
		}
	}
	if (b.Lat != nil && (*b.Lat < -90 || *b.Lat > 90)) || (b.Lon != nil && (*b.Lon < -180 || *b.Lon > 180)) {
		return bad("lat", "lat is −90 to 90 and lon −180 to 180.")
	}
	if b.SpanM != 0 && (b.SpanM < screenSpanMin || b.SpanM > screenSpanMax) {
		return bad("span_m", fmt.Sprintf("%.0f to %d metres.", screenSpanMin, screenSpanMax))
	}
	if c := b.Crop; c != nil && (c.X < 0 || c.Y < 0 || c.X > screenPointMax || c.Y > screenPointMax ||
		c.W < 1 || c.H < 1 || c.W > screenPointMax || c.H > screenPointMax) {
		return bad("crop", "x and y 0 or more, w and h 1 or more, in the screen's pixels.")
	}
	return nil
}

func placeOK(lat, lon float64) bool {
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

func (b screenBody) request() proto.ScreenRequest {
	r := proto.ScreenRequest{Op: b.Op, X: b.X, Y: b.Y, ToX: b.ToX, ToY: b.ToY, Button: b.Button, Clicks: b.Clicks,
		DX: b.DX, DY: b.DY, Text: b.Text, Keys: b.Keys, MaxW: b.MaxW, Format: b.Format, App: b.App, Window: b.Window,
		Name: b.Name, Role: b.Role, Index: b.Index, Path: b.Path, Limit: b.Limit, Target: b.Target,
		Action: b.Action, Queries: b.Queries, W: b.W, H: b.H, Scale: b.Scale, Dark: b.Dark, Lat: b.Lat, Lon: b.Lon,
		SpanM: b.SpanM}
	if b.Account != nil {
		r.Account = &proto.ScreenAccount{User: b.Account.User, Password: b.Account.Password}
	}
	for _, p := range b.Pins {
		r.Pins = append(r.Pins, proto.MapPin{Lat: p.Lat, Lon: p.Lon})
	}
	if c := b.Crop; c != nil {
		r.Crop = &proto.ScreenCrop{X: c.X, Y: c.Y, W: c.W, H: c.H}
	}
	return r
}

// auditDetails is what the audit log keeps of a step: where and what, typed
// text only as its length, never the password.
func (b screenBody) auditDetails() map[string]string {
	d := map[string]string{}
	set := func(k, v string) {
		if v != "" {
			d[k] = cleanText(v, 300)
		}
	}
	switch b.Op {
	case proto.ScreenClick, proto.ScreenDrag, proto.ScreenScroll:
		d["x"], d["y"] = strconv.Itoa(b.X), strconv.Itoa(b.Y)
		if b.Op == proto.ScreenDrag {
			d["to_x"], d["to_y"] = strconv.Itoa(b.ToX), strconv.Itoa(b.ToY)
		}
		if b.Op == proto.ScreenScroll {
			d["dx"], d["dy"] = strconv.Itoa(b.DX), strconv.Itoa(b.DY)
		}
		set("button", b.Button)
		if b.Clicks > 1 {
			d["clicks"] = strconv.Itoa(b.Clicks)
		}
	case proto.ScreenType:
		d["characters"] = strconv.Itoa(utf8.RuneCountInString(b.Text))
	case proto.ScreenKeys:
		set("keys", b.Keys)
	case proto.ScreenAccountSet:
		set("user", b.Account.User)
	case proto.ScreenUISet:
		d["characters"] = strconv.Itoa(utf8.RuneCountInString(b.Text))
	case proto.ScreenPassword:
		return d // the prompt's app is added from the answer; nothing typed is kept
	}
	set("app", b.App)
	set("name", b.Name)
	set("action", b.Action)
	set("role", b.Role)
	if b.Index > 0 {
		d["index"] = strconv.Itoa(b.Index)
	}
	if len(b.Path) > 0 {
		set("path", strings.Join(b.Path, " > "))
	}
	set("target", b.Target)
	return d
}

// apiScreen is POST /servers/{id}/screen: one step on a Mac's screen.
func (h *Hub) apiScreen(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID := r.PathValue("id")
	var body screenBody
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	body.Op = strings.TrimSpace(body.Op)
	if e := body.check(); e != nil {
		return e
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	operatorOp := slices.Contains(screenOperatorOps, body.Op)
	details := body.auditDetails()
	switch {
	case slices.Contains(screenReads, body.Op):
		// What a look asked for, never what it saw: the op and the app.
		details = map[string]string{}
		if body.App != "" {
			details["app"] = cleanText(body.App, 200)
		}
	case slices.Contains(screenPlaces, body.Op):
		// Where people are is never kept: not the addresses looked up, not
		// the places on a map.
		details = map[string]string{}
	}
	details["op"] = body.Op
	deny := func(e *apiError) error {
		return h.deny(r, p, "screen.denied", serverID, model.HostGuestID, "", e, details)
	}
	if !operatorOp {
		if p.rank() < store.RoleRank(admin) {
			return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
		}
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	if st, ok := h.snapshotOne(serverID); ok && st.Report != nil && !isMac(st) {
		return apiErr(http.StatusNotImplemented, "unsupported", "This server isn't a Mac.")
	}
	need := needScreen
	if body.Op == proto.ScreenStatus {
		need = needScreenStatus
	}
	t, e := h.remotePrecheck(p, serverID, model.HostGuestID, need)
	if e != nil {
		return deny(e)
	}
	if !isMac(t.st) {
		return apiErr(http.StatusNotImplemented, "unsupported", "This server isn't a Mac.")
	}
	if !operatorOp {
		// Fail closed: a step is recorded, or it doesn't run.
		if err := h.store.Ping(r.Context()); err != nil {
			return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; the screen can't be driven.")
		}
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), proto.ScreenStepLimit(body.Op)+screenGrace)
	start := time.Now()
	resp, err := t.conn.Screen(ctx, body.request())
	cancel()
	auditID := ""
	if !operatorOp {
		if body.Op == proto.ScreenPassword && err == nil && resp.Element != nil && resp.Element.App != "" {
			details["app"] = cleanText(resp.Element.App, 200) // whose prompt took it
		}
		dur := float64(int64(time.Since(start).Seconds()*10)) / 10
		rec := store.AuditRecord{Event: "screen." + body.Op, Outcome: "ok", Server: serverID, Guest: model.HostGuestID,
			Platform: proto.PlatformHost, DurationS: &dur, Details: details}
		switch {
		case err != nil:
			rec.Outcome, rec.Code = "error", "agent_error"
		case !resp.OK:
			rec.Outcome, rec.Code = "error", resp.Code
		}
		auditID, _ = h.auditReq(r, p, rec)
	}
	h.log.Debug("screen", "server", serverID, "op", body.Op, "ok", err == nil && resp.OK, "code", resp.Code)
	if err != nil {
		return apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
	}
	switch resp.Code {
	case "remote_control_disabled":
		return apiErr(http.StatusForbidden, "host_shell_disabled", model.ReasonAgentShell+".")
	case "unsupported":
		// The agent says why: no screen, or a Whombat Helper older than the
		// step (it updates itself).
		msg := cleanText(resp.Message, 300)
		if msg == "" {
			msg = "This server's agent can't reach a screen (not a Mac, or an older agent)."
		}
		return apiErr(http.StatusNotImplemented, "unsupported", msg)
	case "invalid_request":
		msg := resp.Message
		if msg == "" {
			msg = "The step isn't valid."
		}
		e := apiErr(http.StatusBadRequest, "invalid_value", msg)
		return e
	}
	out, aerr := screenAnswer(serverID, body.Op, resp)
	if aerr != nil {
		return aerr
	}
	if auditID != "" {
		out["audit_id"] = auditID
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// screenAnswer turns the agent's answer into JSON. Everything the agent
// sends is checked and bounded: names and values come from other apps.
func screenAnswer(serverID, op string, resp proto.ScreenResponse) (map[string]any, *apiError) {
	out := map[string]any{"server": serverID, "op": op, "ok": resp.OK}
	if !resp.OK {
		code := cleanText(resp.Code, 64)
		if code == "" {
			code = "failed"
		}
		out["code"], out["message"] = code, cleanText(resp.Message, 1000)
	} else if msg := cleanText(resp.Message, 1000); msg != "" {
		// What the agent says about a step that worked: that the Mac locks
		// again when the screen session ends, that a pressed app is busy.
		out["message"] = msg
	}
	if len(resp.Image) > 0 {
		cfg, format, err := image.DecodeConfig(bytes.NewReader(resp.Image))
		if err != nil || (format != "png" && format != "jpeg") || cfg.Width != resp.W || cfg.Height != resp.H {
			return nil, apiErr(http.StatusBadGateway, "agent_error", "The agent sent an invalid picture.")
		}
		out["image_b64"], out["format"] = base64.StdEncoding.EncodeToString(resp.Image), format
		out["w"], out["h"] = cfg.Width, cfg.Height
	}
	if resp.ScreenW > 0 && resp.ScreenH > 0 {
		out["screen_w"], out["screen_h"] = resp.ScreenW, resp.ScreenH
	}
	if resp.Elements != nil || op == proto.ScreenUIList && resp.OK {
		els := make([]map[string]any, 0, len(resp.Elements))
		for i, e := range resp.Elements {
			if i >= 1000 {
				break
			}
			els = append(els, uiElementJSON(e))
		}
		out["elements"] = els
	}
	if resp.Apps != nil || op == proto.ScreenUIApps && resp.OK {
		apps := make([]map[string]any, 0, len(resp.Apps))
		for i, a := range resp.Apps {
			if i >= 500 {
				break
			}
			wins := []string{}
			for j, w := range a.Windows {
				if j >= 50 {
					break
				}
				wins = append(wins, cleanText(w, 200))
			}
			apps = append(apps, map[string]any{"name": cleanText(a.Name, 200), "bundle_id": cleanText(a.BundleID, 200),
				"pid": a.PID, "active": a.Active, "windows": wins})
		}
		out["apps"] = apps
	}
	if resp.Element != nil {
		out["element"] = uiElementJSON(*resp.Element)
	}
	if resp.Status != nil {
		out["status"] = screenStatusJSON(*resp.Status)
	}
	if resp.Helper != nil {
		out["helper"] = screenHelperJSON(*resp.Helper)
	}
	if resp.Truncated {
		out["truncated"] = true
	}
	if resp.Places != nil || op == proto.ScreenMapGeocode && resp.OK {
		places := make([]any, 0, len(resp.Places))
		for i, p := range resp.Places {
			if i >= screenQueriesMax {
				break
			}
			if p == nil || !placeOK(p.Lat, p.Lon) || !realNumber(p.AccuracyM) || p.AccuracyM < 0 {
				places = append(places, nil)
				continue
			}
			places = append(places, map[string]any{"lat": p.Lat, "lon": p.Lon, "accuracy_m": math.Round(p.AccuracyM)})
		}
		out["places"] = places
	}
	if resp.Points != nil || op == proto.ScreenMapSnapshot && resp.OK {
		points := make([]any, 0, len(resp.Points))
		for i, p := range resp.Points {
			if i >= screenPinsMax {
				break
			}
			if p == nil || !realNumber(p.X) || !realNumber(p.Y) {
				points = append(points, nil)
				continue
			}
			points = append(points, map[string]any{"x": p.X, "y": p.Y})
		}
		out["points"] = points
	}
	if resp.Lat != nil && resp.Lon != nil && placeOK(*resp.Lat, *resp.Lon) {
		out["lat"], out["lon"] = *resp.Lat, *resp.Lon
	}
	if realNumber(resp.SpanM) && resp.SpanM > 0 {
		out["span_m"] = math.Round(resp.SpanM)
	}
	return out, nil
}

func realNumber(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func uiElementJSON(e proto.UIElement) map[string]any {
	actions := []string{}
	for i, a := range e.Actions {
		if i >= 16 {
			break
		}
		actions = append(actions, cleanText(a, 64))
	}
	return map[string]any{"id": cleanText(e.ID, 128), "role": cleanText(e.Role, 64), "subrole": cleanText(e.Subrole, 64),
		"title": cleanText(e.Title, 200), "desc": cleanText(e.Description, 200), "value": cleanText(e.Value, 200),
		"ident": cleanText(e.Identifier, 200), "enabled": e.Enabled, "focused": e.Focused,
		"x": e.X, "y": e.Y, "w": e.W, "h": e.H, "actions": actions, "app": cleanText(e.App, 200), "window": cleanText(e.Window, 200)}
}

// screenStatusJSON is a Mac's screen as the REST API shows it.
func screenStatusJSON(s proto.MacScreen) map[string]any {
	out := map[string]any{"sharing": s.Sharing, "account": cleanText(s.Account, 64), "sign_in": cleanText(s.SignIn, 16),
		"sign_in_at": nil, "locked": s.Locked, "w": s.Width, "h": s.Height}
	if !s.SignInAt.IsZero() {
		out["sign_in_at"] = s.SignInAt.UTC().Format(time.RFC3339)
	}
	return out
}

// screenHelperJSON is Whombat Helper as the REST API shows it; idle_s
// (seconds since the last input at the Mac itself) is null when unknown or
// outside the status step.
func screenHelperJSON(h proto.MacHelper) map[string]any {
	return map[string]any{"installed": h.Installed, "version": cleanText(h.Version, 64), "running": h.Running,
		"ax": h.Accessibility, "user": cleanText(h.User, 64), "idle_s": h.IdleS}
}
