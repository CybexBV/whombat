package hub

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- unRAID (docs/MANAGE.md 2.6, docs/REST-API.md "Manage", unRAID) ------------

// unraidManageRoutes are the unRAID routes and the Docker / libvirt guest
// routes; they join manageRoutes (registered with them) and are served
// by unraidManageHandler. Host routes act on the server's unRAID
// (platform "unraid"); every unRAID command runs as a task (202) except
// archiving notifications and autostart (200).
var unraidManageRoutes = []manageRoute{
	{method: "POST", path: "/unraid/array/start", op: proto.OpArrayStart, admin: true, body: []string{"platform"}},
	{method: "POST", path: "/unraid/array/stop", op: proto.OpArrayStop, admin: true, body: []string{"confirm", "platform"}},
	{method: "POST", path: "/unraid/parity/start", op: proto.OpParityStart, body: []string{"correct", "platform"}},
	{method: "POST", path: "/unraid/parity/pause", op: proto.OpParityPause, body: []string{"platform"}},
	{method: "POST", path: "/unraid/parity/resume", op: proto.OpParityResume, body: []string{"platform"}},
	{method: "POST", path: "/unraid/parity/cancel", op: proto.OpParityCancel, body: []string{"confirm", "platform"}},
	{method: "POST", path: "/unraid/disks/{disk}/spin-up", op: proto.OpDiskSpinUp, body: []string{"platform"}},
	{method: "POST", path: "/unraid/disks/{disk}/spin-down", op: proto.OpDiskSpinDown, body: []string{"platform"}},
	{method: "POST", path: "/unraid/mover", op: proto.OpMoverStart, body: []string{"platform"}},
	{method: "POST", path: "/unraid/plugins/check", op: proto.OpPluginCheck, body: []string{"platform"}},
	{method: "POST", path: "/unraid/plugins/{plugin}/update", op: proto.OpPluginUpdate, admin: true, body: []string{"confirm", "platform"}},
	{method: "POST", path: "/unraid/notifications/archive", op: proto.OpNotificationArchive, body: []string{"id", "platform"}},
	{method: "POST", path: "/unraid/containers/check", op: proto.OpContainersCheck, body: []string{"platform"}},
	{method: "POST", path: "/guests/{guestId}/update", op: proto.OpContainerUpdate, admin: true, body: []string{"confirm", "platform"}},
	{method: "PUT", path: "/guests/{guestId}/autostart", op: proto.OpGuestAutostart, body: []string{"on", "platform"}},
}

// unraidOps are the operations of unraidManageRoutes.
var unraidOps = map[string]bool{}

func init() {
	for _, rt := range unraidManageRoutes {
		unraidOps[rt.op] = true
	}
	manageRoutes = append(manageRoutes, unraidManageRoutes...)
}

var (
	unraidDiskRe     = regexp.MustCompile(`^(all|[a-z][a-z0-9_-]{0,31})$`)
	unraidPluginRe   = regexp.MustCompile(`^(all|[A-Za-z0-9][A-Za-z0-9._+-]{0,99}\.plg)$`)
	unraidNotifyIDRe = regexp.MustCompile(`^[0-9A-Za-z_][0-9A-Za-z_.+@^%-]{0,199}$`)
)

// unraidManageHandler serves one unRAID route: the same checks as
// manageHandler (role, re-authentication for admin routes, the manage
// switches, refusals audited), then the change through manageChange.
func (h *Hub) unraidManageHandler(rt manageRoute) handlerFunc {
	guestOp := strings.Contains(rt.path, "{guestId}")
	return func(w http.ResponseWriter, r *http.Request, p *principal) error {
		serverID := r.PathValue("id")
		req, confirm, _, err := parseManage(rt, r)
		if err != nil {
			return err
		}
		// A "platform" in the body may say unraid (or, for a guest, its
		// own platform); the route decides.
		given := req.Platform
		gid := model.HostGuestID
		if guestOp {
			gid = r.PathValue("guestId")
			platform, id, ok := model.SplitGuestID(gid)
			if !ok {
				return errGuestNotFound
			}
			if given != "" && given != proto.PlatformUnraid && given != platform {
				return invalidFields(map[string]string{"platform": "platform is unraid or the guest's own."})
			}
			req.Platform, req.GuestID = platform, id
		} else {
			if given != "" && given != proto.PlatformUnraid {
				return invalidFields(map[string]string{"platform": "platform is unraid."})
			}
			req.Platform = proto.PlatformUnraid
		}
		if v := r.PathValue("plugin"); v != "" {
			req.Plugin = v
		}
		if fe := validateUnraid(&req); len(fe) > 0 {
			return invalidFields(fe)
		}
		details := unraidDetails(req)
		deny := func(e *apiError) error { return h.deny(r, p, "manage.requested", serverID, gid, "", e, details) }
		if rt.admin {
			// Starting and stopping the array, plugin and container
			// updates: admins with a recent sign-in.
			if p.rank() < store.RoleRank(admin) {
				return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
			}
			if err := h.requireReauth(p); err != nil {
				return err
			}
		}
		if h.throttled(p) {
			return rateLimited(10 * time.Minute)
		}
		t, e := h.remotePrecheck(p, serverID, gid, needManage)
		if e != nil {
			return deny(e)
		}
		unraid := model.IsUnraid(t.st.Report)
		switch {
		case !guestOp && !unraid:
			return apiErr(http.StatusNotImplemented, "unsupported", "This server does not run Unraid.")
		case req.Op == proto.OpContainerUpdate && (req.Platform != proto.PlatformDocker || !unraid):
			return apiErr(http.StatusNotImplemented, "unsupported", "Whombat updates containers from their Unraid template only.")
		case req.Op == proto.OpGuestAutostart && req.Platform == proto.PlatformDocker && !unraid:
			return apiErr(http.StatusNotImplemented, "unsupported", "Autostart of Docker containers is an Unraid feature.")
		case req.Op == proto.OpGuestAutostart && req.Platform != proto.PlatformDocker && req.Platform != proto.PlatformLibvirt:
			return apiErr(http.StatusNotImplemented, "unsupported", "Autostart is set here for Docker containers on Unraid and libvirt VMs.")
		}
		if e := unraidConfirm(req, confirm); e != nil {
			return deny(e)
		}
		if guestOp {
			// The guest this Whombat runs in (selfguest.go: the shared allow
			// list has neither container.update nor guest.autostart).
			if e := selfManageRefusal(t.st, req.Op, gid, ""); e != nil {
				return deny(e)
			}
		}
		return h.manageChange(w, r, p, t, gid, req, details)
	}
}

// validateUnraid checks the request's values before they go to the agent
// (which checks them again against unRAID's state).
func validateUnraid(req *proto.ManageRequest) map[string]string {
	fe := map[string]string{}
	switch req.Op {
	case proto.OpDiskSpinUp, proto.OpDiskSpinDown:
		if !unraidDiskRe.MatchString(req.Disk) {
			fe["disk"] = "Give a disk of the array or a pool (\"disk1\", \"cache\"), or all."
		}
	case proto.OpPluginUpdate:
		if !unraidPluginRe.MatchString(req.Plugin) {
			fe["plugin"] = "Give a plugin file (\"tailscale.plg\"), or all."
		}
	case proto.OpNotificationArchive:
		if req.Notification != "" && !unraidNotifyIDRe.MatchString(req.Notification) {
			fe["id"] = "Not a notification id."
		}
	case proto.OpGuestAutostart:
		if req.On == nil {
			fe["on"] = "Send on: true or false."
		}
	}
	return fe
}

// unraidConfirm: stopping the array, updating a plugin and updating a
// container need "confirm": true (Whombat asks first).
func unraidConfirm(req proto.ManageRequest, confirm bool) *apiError {
	need := func(detail string) *apiError { return apiErr(http.StatusBadRequest, "confirm_required", detail) }
	switch {
	case confirm:
	case req.Op == proto.OpArrayStop:
		return need("Stopping the array takes its shares, containers and VMs offline: send \"confirm\": true.")
	case req.Op == proto.OpPluginUpdate:
		return need("Updating a plugin changes the server: send \"confirm\": true.")
	case req.Op == proto.OpContainerUpdate:
		return need("Updating a container restarts it: send \"confirm\": true.")
	}
	return nil
}

// unraidDetails are the audit details of an unRAID request.
func unraidDetails(req proto.ManageRequest) map[string]string {
	d := manageDetails(req)
	if req.Plugin != "" {
		d["plugin"] = cleanText(req.Plugin, 120)
	}
	if req.Notification != "" {
		d["notification"] = cleanText(req.Notification, 200)
	}
	if req.Op == proto.OpParityStart {
		d["correct"] = strconv.FormatBool(req.Correct)
	}
	if req.On != nil {
		d["on"] = strconv.FormatBool(*req.On)
	}
	return d
}

// defaultUnraidPlatform is the platform of host requests without one on
// an unRAID server without Incus (its tasks).
func defaultUnraidPlatform(r *proto.Report) bool {
	return model.IsUnraid(r) && r.PVE == nil && r.Incus == nil
}
