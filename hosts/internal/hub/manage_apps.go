package hub

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// ---- Docker Compose app updates (docs/MANAGE.md 2.11, docs/REST-API.md "Manage") ----

// appsManageRoutes update Compose apps: pull each one's image, recreate it,
// and put the old image back when it doesn't come up. The answer is 202
// with a task "app:<16 hex>" the hub follows like a package task (GET
// /tasks/{task}?platform=host). An admin's, confirmed.
var appsManageRoutes = []manageRoute{
	{method: "POST", path: "/apps/update", op: proto.OpAppUpdate, admin: true, body: []string{"apps", "hold_major", "expect", "confirm"}},
}

// appOps are the operations of appsManageRoutes.
var appOps = map[string]bool{}

func init() {
	for _, rt := range appsManageRoutes {
		appOps[rt.op] = true
	}
	manageRoutes = append(manageRoutes, appsManageRoutes...)
}

// appsManageHandler serves POST /servers/{id}/apps/update: the checks of
// manageHandler, the apps against the latest report, then the change.
// "apps" names Docker guests ("docker:immich_server") or their containers.
func (h *Hub) appsManageHandler(rt manageRoute) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, p *principal) error {
		serverID := r.PathValue("id")
		req, confirm, _, err := parseManage(rt, r)
		if err != nil {
			return err
		}
		req.Platform = proto.PlatformHost
		names, fe := appNames(req.Apps)
		if len(fe) > 0 {
			return invalidFields(fe)
		}
		req.Apps = names
		// What the person said yes to: the agent updates an app only while it
		// still finds it so, and checks the values itself.
		if req.AppExpect, fe = appExpect(names, req.AppExpect); len(fe) > 0 {
			return invalidFields(fe)
		}
		gid := model.HostGuestID
		if len(names) == 1 {
			gid = model.GuestID(proto.PlatformDocker, names[0])
		}
		details := appsDetails(req)
		deny := func(e *apiError) error { return h.deny(r, p, "manage.requested", serverID, gid, "", e, details) }
		if p.rank() < store.RoleRank(admin) {
			return deny(apiErr(http.StatusForbidden, "insufficient_role", model.ReasonAdmin+"."))
		}
		if err := h.requireReauth(p); err != nil {
			return err
		}
		if h.throttled(p) {
			return rateLimited(10 * time.Minute)
		}
		t, e := h.remotePrecheck(p, serverID, gid, needManage)
		if e != nil {
			return deny(e)
		}
		if e := appsKnown(t.st.Report, names); e != nil {
			return deny(e)
		}
		if !confirm {
			return deny(apiErr(http.StatusBadRequest, "confirm_required", "Updating apps restarts them: send \"confirm\": true."))
		}
		return h.manageChange(w, r, p, t, gid, req, details)
	}
}

// containerNameRe is a Docker container name the agent accepts.
var containerNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// appNames turns the request's apps into container names (duplicates go).
func appNames(in []string) ([]string, map[string]string) {
	fe := map[string]string{}
	if len(in) == 0 {
		fe["apps"] = "Name the apps to update."
		return nil, fe
	}
	if len(in) > proto.AppsMax {
		fe["apps"] = "At most " + strconv.Itoa(proto.AppsMax) + " apps at once."
		return nil, fe
	}
	var out []string
	for _, a := range in {
		name := a
		if platform, id, ok := model.SplitGuestID(a); ok {
			if platform != proto.PlatformDocker {
				fe["apps"] = "Apps are Docker containers (\"docker:immich_server\")."
				return nil, fe
			}
			name = id
		}
		if !containerNameRe.MatchString(name) {
			fe["apps"] = "Name Docker containers (\"docker:immich_server\")."
			return nil, fe
		}
		if !slices.Contains(out, name) {
			out = append(out, name)
		}
	}
	return out, nil
}

// appExpect names each expectation's app as a container, like the apps:
// one per app the request names, at most.
func appExpect(names []string, in []proto.AppExpect) ([]proto.AppExpect, map[string]string) {
	seen := map[string]bool{}
	out := make([]proto.AppExpect, 0, len(in))
	for _, e := range in {
		if platform, id, ok := model.SplitGuestID(e.App); ok && platform == proto.PlatformDocker {
			e.App = id
		}
		if !slices.Contains(names, e.App) || seen[e.App] {
			return nil, map[string]string{"expect": "Say once what was checked of each app the update names."}
		}
		seen[e.App] = true
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// appsKnown checks the apps against the server's latest report, so the
// answer can say what the agent would: an agent from before app updates
// reports no Compose apps at all (it updates itself, then can).
func appsKnown(rep *proto.Report, names []string) *apiError {
	var guests []proto.Guest
	if rep != nil && rep.Docker != nil {
		guests = rep.Docker.Guests
	}
	if !slices.ContainsFunc(guests, func(g proto.Guest) bool { return g.App != nil }) &&
		slices.ContainsFunc(guests, func(g proto.Guest) bool { return g.Project != "" }) {
		return apiErr(http.StatusConflict, "agent_outdated",
			"This server's agent can't update apps yet; it gets a newer one by itself.")
	}
	for _, n := range names {
		i := slices.IndexFunc(guests, func(g proto.Guest) bool { return g.ID == n })
		switch {
		case i < 0:
			return apiErr(http.StatusNotFound, "guest_not_found", "No container "+strconv.Quote(n)+" on this server.")
		case guests[i].WhombatService:
			return apiErr(http.StatusForbidden, "not_allowed", "That's one of Whombat's own services.")
		case guests[i].App == nil:
			return apiErr(http.StatusConflict, "not_compose", n+" wasn't started with Docker Compose.")
		case guests[i].App.Blocked != "":
			return apiErr(http.StatusConflict, "app_"+guests[i].App.Blocked, n+" can't be updated ("+guests[i].App.Blocked+").")
		case guests[i].App.Updating:
			return apiErr(http.StatusConflict, "busy", n+" is being updated right now.")
		}
	}
	return nil
}

// appsDetails are the audit details: the apps named.
func appsDetails(req proto.ManageRequest) map[string]string {
	d := manageDetails(req)
	d["apps"] = cleanText(strings.Join(req.Apps, ", "), 300)
	if req.HoldMajor {
		d["hold_major"] = "true"
	}
	return d
}

// appTaskDetails are an app task's results for manage.finished: per app,
// what happened ("immich_server updated 2.3.0 → 2.4.0").
func appTaskDetails(st *proto.TaskStatus) map[string]string {
	if len(st.Apps) == 0 {
		return nil
	}
	parts := make([]string, 0, len(st.Apps))
	for _, a := range st.Apps {
		s := a.App + " " + a.Status
		if a.From != "" || a.To != "" {
			s += " " + a.From + " → " + a.To
		}
		if a.Reason != "" {
			s += " (" + a.Reason + ")"
		}
		parts = append(parts, s)
	}
	return map[string]string{"apps_result": cleanText(strings.Join(parts, "; "), 500)}
}

// isAppTask: a task id of an app update.
func isAppTask(task string) bool { return strings.HasPrefix(task, proto.AppTaskPrefix) }

// isHostTask: a task that runs on the server itself (packages, apps).
func isHostTask(task string) bool { return isPackageTask(task) || isAppTask(task) }

// appResultArrays: apps is a list in an app task's answer.
func appResultArrays(st *proto.TaskStatus) {
	if isAppTask(st.ID) && st.Apps == nil && st.Status != "running" {
		st.Apps = []proto.AppResult{}
	}
}
