package hub

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- power actions -------------------------------------------------------------

var (
	vmActions = map[string]bool{proto.ActionStart: true, proto.ActionShutdown: true, proto.ActionReboot: true, proto.ActionForceStop: true,
		proto.ActionCtrlAltDel: true, proto.ActionPause: true, proto.ActionResume: true,
		proto.ActionSnapshotCreate: true, proto.ActionSnapshotRestore: true, proto.ActionSnapshotDelete: true}
	containerActions = map[string]bool{proto.ActionStart: true, proto.ActionRestart: true, proto.ActionStop: true,
		proto.ActionPause: true, proto.ActionResume: true,
		proto.ActionSnapshotCreate: true, proto.ActionSnapshotRestore: true, proto.ActionSnapshotDelete: true}
	hostActions = map[string]bool{proto.ActionHostReboot: true, proto.ActionHostShutdown: true}
	destructive = map[string]bool{proto.ActionForceStop: true, proto.ActionStop: true, proto.ActionReboot: true, proto.ActionShutdown: true,
		proto.ActionRestart: true, proto.ActionSnapshotRestore: true, proto.ActionSnapshotDelete: true,
		proto.ActionHostReboot: true, proto.ActionHostShutdown: true}
	snapshotActions = map[string]bool{proto.ActionSnapshotCreate: true, proto.ActionSnapshotRestore: true, proto.ActionSnapshotDelete: true}
	snapshotName    = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,39}$`)
)

// actionTracker allows one action in flight per guest.
type actionTracker struct {
	mu sync.Mutex
	m  map[string]string // server|guest -> action id
}

func newActionTracker() *actionTracker { return &actionTracker{m: map[string]string{}} }

func (a *actionTracker) begin(key, id string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, busy := a.m[key]; busy {
		return false
	}
	a.m[key] = id
	return true
}

func (a *actionTracker) end(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.m, key)
}

func (h *Hub) apiAction(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, gid := r.PathValue("id"), r.PathValue("guestId")
	host := gid == ""
	if host {
		gid = model.HostGuestID // POST /servers/{id}/actions: the host itself
	}
	var req struct {
		Action      string `json:"action"`
		Confirm     bool   `json:"confirm"`
		Snapshot    string `json:"snapshot"`
		Description string `json:"description"`
		Memory      bool   `json:"memory"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Action == "screenshot" {
		return apiErr(http.StatusBadRequest, "use_screenshot_endpoint", "Use GET .../screenshot for screenshots.")
	}
	if host != hostActions[req.Action] || (!host && !vmActions[req.Action] && !containerActions[req.Action]) {
		return apiErr(http.StatusBadRequest, "invalid_action", "Unknown action.")
	}
	var args map[string]string
	if snapshotActions[req.Action] {
		name := strings.TrimSpace(req.Snapshot)
		if name == "" && req.Action == proto.ActionSnapshotCreate {
			name = "whombat-" + h.now().UTC().Format("20060102-150405")
		}
		if !snapshotName.MatchString(name) {
			return apiErr(http.StatusBadRequest, "invalid_snapshot", "Snapshot names are 1 to 40 letters, digits, '.', '_' or '-'.")
		}
		args = map[string]string{proto.ArgSnapshot: name}
		if d := cleanText(req.Description, 200); d != "" && req.Action == proto.ActionSnapshotCreate {
			args[proto.ArgDescription] = d
		}
		if req.Memory && req.Action == proto.ActionSnapshotCreate {
			args[proto.ArgWithMemory] = "true"
		}
	}
	if host {
		// Rebooting the host itself: admins, its own switches, a recent sign-in.
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	details := map[string]string{"action": req.Action}
	if args != nil {
		details["snapshot"] = args[proto.ArgSnapshot]
	}
	deny := func(e *apiError) error { return h.deny(r, p, "action.requested", serverID, gid, "", e, details) }
	need := needPower
	switch {
	case req.Action == proto.ActionCtrlAltDel:
		need = needConsole
	case host:
		need = needHostPower
	}
	t, e := h.remotePrecheck(p, serverID, gid, need)
	if e != nil {
		return deny(e)
	}
	allowed := containerActions
	switch {
	case host:
		allowed = hostActions
	case t.g.Kind == "vm":
		allowed = vmActions
	}
	if !allowed[req.Action] || (t.g.Platform == proto.PlatformDocker && snapshotActions[req.Action]) {
		return deny(apiErr(http.StatusBadRequest, "invalid_action", "This action does not apply to this guest."))
	}
	if e := selfActionRefusal(t.g, req.Action); e != nil {
		return deny(e) // the guest this Whombat runs in (selfguest.go)
	}
	if destructive[req.Action] && !req.Confirm {
		return deny(apiErr(http.StatusBadRequest, "confirm_required", "Destructive actions need \"confirm\": true."))
	}
	if h.closing.Load() {
		return apiErr(http.StatusServiceUnavailable, "shutting_down", "The hub is shutting down.")
	}
	actionID := newID("act_")
	key := serverID + "|" + gid
	if !h.actions.begin(key, actionID) {
		return apiErr(http.StatusConflict, "action_in_progress", "Another action on this guest is still running.")
	}
	details["action_id"] = actionID
	auditID, err := h.auditReq(r, p, store.AuditRecord{Event: "action.requested", Outcome: "ok", Server: serverID, Guest: gid,
		Platform: t.g.Platform, Details: details})
	if err != nil {
		h.actions.end(key)
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; actions are disabled.")
	}
	user, role, ip, ua := p.user.Username, p.user.Role, clientIP(r), cleanText(r.UserAgent(), 256)
	platform, guestID := t.g.Platform, t.g.ID
	conn := t.conn
	h.bg.Add(1)
	h.notePlannedStop(serverID, gid, req.Action)
	go func() {
		defer h.bg.Done()
		start := time.Now()
		// The guest is free again once the agent answers, before the
		// finish is audited and announced: whoever reacts to
		// action.finished can start the next action straight away.
		resp, err := func() (proto.ActionResponse, error) {
			defer h.actions.end(key)
			return conn.Action(context.Background(), proto.ActionRequest{Platform: platform, GuestID: guestID, Action: req.Action, Args: args})
		}()
		result, outcome, code, msg := "ok", "ok", "", resp.Message
		switch {
		case err != nil:
			result, outcome, code, msg = "error", "error", "agent_error", "The agent did not answer: the connection was lost."
		case !resp.OK:
			result, outcome, code = "error", "error", resp.Code
			if code == "" {
				code = "agent_error"
			}
		}
		dur := float64(int64(time.Since(start).Seconds()*10)) / 10
		fin := map[string]string{"action": req.Action, "action_id": actionID, "requested_audit_id": auditID}
		if args != nil {
			fin["snapshot"] = args[proto.ArgSnapshot]
		}
		if resp.Noop {
			fin["noop"] = "true"
		}
		if resp.State != "" {
			fin["state"] = resp.State
		}
		_, _ = h.audit(context.Background(), store.AuditRecord{Event: "action.finished", Outcome: outcome, Code: code,
			User: user, Role: role, ClientIP: ip, UserAgent: ua, Server: serverID, Guest: gid, Platform: platform,
			DurationS: &dur, Details: fin})
		h.log.Info("action finished", "server", serverID, "guest", gid, "action", req.Action, "result", result, "code", code)
		ev := map[string]any{"action_id": actionID, "server": serverID, "guest": gid, "action": req.Action, "result": result,
			"message": msg, "state": nil, "noop": resp.Noop, "code": nil}
		if resp.State != "" {
			ev["state"] = resp.State
		}
		if code != "" {
			ev["code"] = code
		}
		h.bus.Publish("action.finished", ev)
	}()
	writeJSON(w, r, http.StatusAccepted, map[string]string{"action_id": actionID, "audit_id": auditID})
	return nil
}

// ---- thumbnails and screenshots --------------------------------------------------

// thumbCache shares one in-flight capture per guest and keeps the last
// image for 2 s.
type thumbCache struct {
	mu       sync.Mutex
	inflight map[string]*thumbCall
	cache    map[string]thumbEntry
}

type thumbCall struct {
	done chan struct{}
	img  []byte
	err  *apiError
}

type thumbEntry struct {
	at  time.Time
	img []byte
}

func newThumbCache() *thumbCache {
	return &thumbCache{inflight: map[string]*thumbCall{}, cache: map[string]thumbEntry{}}
}

func (c *thumbCache) get(ctx context.Context, key string, fetch func() ([]byte, *apiError)) ([]byte, *apiError) {
	c.mu.Lock()
	if e, ok := c.cache[key]; ok && time.Since(e.at) < 2*time.Second {
		c.mu.Unlock()
		return e.img, nil
	}
	if call, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.img, call.err
		case <-ctx.Done():
			return nil, apiErr(http.StatusServiceUnavailable, "cancelled", "Cancelled.")
		}
	}
	call := &thumbCall{done: make(chan struct{})}
	c.inflight[key] = call
	c.mu.Unlock()
	call.img, call.err = fetch()
	c.mu.Lock()
	delete(c.inflight, key)
	if call.err == nil {
		if len(c.cache) > 1024 {
			c.cache = map[string]thumbEntry{}
		}
		c.cache[key] = thumbEntry{at: time.Now(), img: call.img}
	}
	c.mu.Unlock()
	close(call.done)
	return call.img, call.err
}

func mapCaptureError(code, msg string) *apiError {
	switch code {
	case "guest_not_running":
		return apiErr(http.StatusConflict, "guest_not_running", "The guest is powered off.")
	case "unsupported", "no_screen":
		return apiErr(http.StatusNotFound, "no_screen", "This guest has no screen to capture.")
	case "remote_control_disabled":
		return apiErr(http.StatusForbidden, "console_disabled", model.ReasonAgent+".")
	case "unknown_guest", "guest_not_found":
		return errGuestNotFound
	case "busy":
		e := apiErr(http.StatusServiceUnavailable, "busy", "The screen is in use (a SPICE client is connected); try again later.")
		if msg != "" {
			e.Detail = msg
		}
		return e
	}
	if msg == "" {
		msg = "The agent could not capture the screen."
	}
	return apiErr(http.StatusBadGateway, "agent_error", msg)
}

// MaxThumbWidth is the maximum thumbnail width in pixels.
const MaxThumbWidth = 320

// normalizeJPEG checks that img is a JPEG at most maxW wide, re-encoding a
// downscaled copy when it is wider or not a JPEG.
// decodeSem bounds concurrent full image decodes (agent images are untrusted).
var decodeSem = make(chan struct{}, 2)

// maxDecodePixels bounds the size of an agent image the hub re-encodes.
const maxDecodePixels = 8_000_000

func normalizeJPEG(img []byte, maxW int) ([]byte, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(img))
	if err != nil {
		return nil, err
	}
	if format == "jpeg" && cfg.Width <= maxW {
		return img, nil
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxDecodePixels {
		return nil, image.ErrFormat
	}
	decodeSem <- struct{}{}
	defer func() { <-decodeSem }()
	src, _, err := image.Decode(bytes.NewReader(img))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > maxW {
		h = h * maxW / w
		w = maxW
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		sy := b.Min.Y + y*b.Dy()/h
		for x := 0; x < w; x++ {
			dst.Set(x, y, src.At(b.Min.X+x*b.Dx()/w, sy))
		}
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 75}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// screenNeed is what a still picture of a guest's screen needs: console,
// or for the host the host shell switches, and only a Mac's host has a
// screen (its signed-in desktop).
func (h *Hub) screenNeed(serverID, gid string) (string, *apiError) {
	if gid != model.HostGuestID {
		return needConsole, nil
	}
	if st, ok := h.snapshotOne(serverID); ok && !isMac(st) {
		return "", apiErr(http.StatusNotFound, "no_screen", "This server's host has no screen.")
	}
	return needScreen, nil
}

func (h *Hub) apiThumbnail(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, gid := r.PathValue("id"), r.PathValue("guestId")
	if e := h.consoleTransport(r); e != nil {
		return e
	}
	need, e := h.screenNeed(serverID, gid)
	if e != nil {
		return e
	}
	t, e := h.remotePrecheck(p, serverID, gid, need)
	if e != nil {
		return h.deny(r, p, "screens.thumbnail", serverID, gid, "", e, nil)
	}
	if t.g.Kind != "vm" && !(gid == model.HostGuestID && isMac(t.st)) {
		return apiErr(http.StatusNotFound, "no_screen", "Containers have no screen; show the terminal placeholder.")
	}
	if t.g.State == proto.StateStopped {
		return apiErr(http.StatusConflict, "guest_not_running", "The guest is powered off.")
	}
	if !h.limits.thumbs.take(p.key()) {
		return rateLimited(time.Minute)
	}
	// screens.viewed: recorded on the first thumbnail per user and server
	// within 10 minutes (once per view, not per thumbnail).
	if h.limits.screens.take(p.key() + "|" + serverID) {
		h.auditReq(r, p, store.AuditRecord{Event: "screens.viewed", Outcome: "ok", Server: serverID})
	}
	img, ae := h.thumbs.get(r.Context(), serverID+"|"+gid, func() ([]byte, *apiError) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		resp, err := t.conn.Thumbnail(ctx, proto.ThumbnailRequest{Platform: t.g.Platform, GuestID: t.g.ID, MaxWidth: MaxThumbWidth, Format: "jpeg"})
		if err != nil {
			return nil, apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
		}
		if len(resp.Image) == 0 {
			return nil, mapCaptureError(resp.Code, resp.Message)
		}
		out, err := normalizeJPEG(resp.Image, MaxThumbWidth)
		if err != nil {
			return nil, apiErr(http.StatusBadGateway, "agent_error", "The agent sent an invalid image.")
		}
		return out, nil
	})
	if ae != nil {
		return ae
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(img)))
	_, _ = w.Write(img)
	return nil
}

func (h *Hub) apiScreenshot(w http.ResponseWriter, r *http.Request, p *principal) error {
	serverID, gid := r.PathValue("id"), r.PathValue("guestId")
	if e := h.consoleTransport(r); e != nil {
		return e
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	need, e := h.screenNeed(serverID, gid)
	if e != nil {
		return e
	}
	t, e := h.remotePrecheck(p, serverID, gid, need)
	if e != nil {
		return h.deny(r, p, "console.screenshot", serverID, gid, "", e, nil)
	}
	if t.g.Kind != "vm" && !(gid == model.HostGuestID && isMac(t.st)) {
		return apiErr(http.StatusNotFound, "no_screen", "Containers have no screen.")
	}
	if t.g.State == proto.StateStopped {
		return apiErr(http.StatusConflict, "guest_not_running", "The guest is powered off.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	resp, err := t.conn.Thumbnail(ctx, proto.ThumbnailRequest{Platform: t.g.Platform, GuestID: t.g.ID, Format: "png"})
	rec := store.AuditRecord{Event: "console.screenshot", Outcome: "ok", Server: serverID, Guest: gid, Platform: t.g.Platform}
	if err != nil || len(resp.Image) == 0 {
		ae := apiErr(http.StatusBadGateway, "agent_error", "The agent did not answer.")
		if err == nil {
			ae = mapCaptureError(resp.Code, resp.Message)
		}
		rec.Outcome, rec.Code = "error", ae.Code
		h.auditReq(r, p, rec)
		return ae
	}
	if _, format, err := image.DecodeConfig(bytes.NewReader(resp.Image)); err != nil || format != "png" {
		rec.Outcome, rec.Code = "error", "invalid_image"
		h.auditReq(r, p, rec)
		return apiErr(http.StatusBadGateway, "agent_error", "The agent sent an invalid image.")
	}
	if _, err := h.auditReq(r, p, rec); err != nil {
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable.")
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+Slug(t.g.Name)+"-"+h.now().UTC().Format("20060102-150405")+`.png"`)
	_, _ = w.Write(resp.Image)
	return nil
}
