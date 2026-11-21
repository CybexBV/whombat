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

// ---- operating-system updates (docs/MANAGE.md 2.9, docs/REST-API.md "Manage") ----

// packagesManageRoutes check for and install the server's waiting package
// updates. Both answer 202 with a task "pkg:<16 hex>" the hub follows like
// the platforms' tasks (GET/DELETE /tasks/{task}?platform=host). Checking
// is an operator's; installing an admin's, confirmed.
var packagesManageRoutes = []manageRoute{
	{method: "POST", path: "/packages/check", op: proto.OpPackagesCheck, body: []string{}},
	{method: "POST", path: "/packages/install", op: proto.OpPackagesInstall, admin: true, body: []string{"packages", "confirm"}},
}

// packageOps are the operations of packagesManageRoutes.
var packageOps = map[string]bool{}

func init() {
	for _, rt := range packagesManageRoutes {
		packageOps[rt.op] = true
	}
	manageRoutes = append(manageRoutes, packagesManageRoutes...)
}

// packageNameRe is a package name the agent accepts (any manager's, with
// an apt architecture or an epoch).
var packageNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`)

// packagesManageHandler serves the two routes: the checks of manageHandler
// (role, re-authentication for installing, the manage switches, refusals
// audited), then the change through manageChange. An agent that doesn't
// know the operations answers unsupported, "unknown operation"; the hub
// passes that on as it is.
func (h *Hub) packagesManageHandler(rt manageRoute) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, p *principal) error {
		serverID := r.PathValue("id")
		req, confirm, _, err := parseManage(rt, r)
		if err != nil {
			return err
		}
		req.Platform = proto.PlatformHost
		if fe := validatePackages(&req); len(fe) > 0 {
			return invalidFields(fe)
		}
		gid := model.HostGuestID
		details := packagesDetails(req)
		deny := func(e *apiError) error { return h.deny(r, p, "manage.requested", serverID, gid, "", e, details) }
		if rt.admin {
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
		if req.Op == proto.OpPackagesInstall && !confirm {
			return deny(apiErr(http.StatusBadRequest, "confirm_required", "Installing updates changes the server: send \"confirm\": true."))
		}
		return h.manageChange(w, r, p, t, gid, req, details)
	}
}

// validatePackages checks packages.install's names before they go to the
// agent (which checks them again).
func validatePackages(req *proto.ManageRequest) map[string]string {
	fe := map[string]string{}
	if len(req.Packages) > proto.PackagesMax {
		fe["packages"] = "At most " + strconv.Itoa(proto.PackagesMax) + " packages at once."
		return fe
	}
	for _, n := range req.Packages {
		if !packageNameRe.MatchString(n) {
			fe["packages"] = "Give package names (\"nginx\", \"libssl3\")."
			break
		}
	}
	return fe
}

// packagesDetails are the audit details: the operation and the packages
// named (an install of everything names none).
func packagesDetails(req proto.ManageRequest) map[string]string {
	d := manageDetails(req)
	if n := len(req.Packages); n > 0 {
		d["packages"] = cleanText(strings.Join(req.Packages, ", "), 300)
		d["package_count"] = strconv.Itoa(n)
	}
	return d
}

// packageTaskDetails are a package task's results for manage.finished.
func packageTaskDetails(st *proto.TaskStatus) map[string]string {
	d := map[string]string{}
	if pr := st.Packages; pr != nil {
		d["installed"] = strconv.Itoa(pr.Installed)
		if len(pr.KeptBack) > 0 {
			d["kept_back"] = cleanText(strings.Join(pr.KeptBack, ", "), 300)
		}
		if pr.Warning != "" {
			d["warning"] = cleanText(pr.Warning, 300)
		}
	}
	return d
}

// isPackageTask: a task id of a package task.
func isPackageTask(task string) bool { return strings.HasPrefix(task, proto.PackageTaskPrefix) }

// packageResultArrays: kept_back is a list, also when the agent sent none.
func packageResultArrays(st *proto.TaskStatus) {
	if st.Packages != nil && st.Packages.KeptBack == nil {
		st.Packages.KeptBack = []string{}
	}
}
