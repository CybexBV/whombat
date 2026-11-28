package proto

import "time"

// App updates (docs/MANAGE.md 2.11): the agent
// updates Docker Compose apps one service at a time as a task "app:<16
// hex>" that runs outside the agent (a transient systemd unit, or its own
// session without systemd), so it survives an agent restart. For each app it
// keeps the running image, pulls the newest image of the app's service,
// recreates only that service with the project's own files and watches it;
// when the app doesn't come up (it stops, keeps restarting or its health
// check fails) it puts the previous image back by itself. One app task at a
// time per server. Platform "host".
const (
	// OpAppUpdate updates the apps named in ManageRequest.Apps (container
	// names) -> Task. It can't be stopped once started.
	OpAppUpdate = "app.update"
)

// AppTaskPrefix starts the id of an app task ("app:" + 16 hex digits).
const AppTaskPrefix = "app:"

// AppsMax bounds ManageRequest.Apps.
const AppsMax = 10

// App update outcomes (AppResult.Status, AppLast.Status).
const (
	AppUpdated    = "updated"     // the new image runs and passed its watch
	AppCurrent    = "current"     // the registry had nothing newer
	AppRolledBack = "rolled_back" // the new image didn't come up; the previous one runs again
	AppHeld       = "held"        // a major version jump with HoldMajor: nothing changed
	AppFailed     = "failed"      // it couldn't be updated (nothing changed), or going back failed too
)

// App update reasons (AppResult.Reason): why an app wasn't updated or was
// put back, as a code Whombat words.
const (
	AppReasonGone      = "gone"       // the container isn't there
	AppReasonNoCompose = "no_compose" // not started with Docker Compose
	AppReasonNoFiles   = "no_files"   // its Compose folder or files aren't there any more
	AppReasonPinned    = "pinned"     // the image is pinned to one digest
	AppReasonPull      = "pull"       // fetching the new image failed
	AppReasonStart     = "start"      // recreating the service failed
	AppReasonStopped   = "stopped"    // the new container stopped
	AppReasonRestarts  = "restarting" // it kept restarting
	AppReasonUnhealthy = "unhealthy"  // its health check failed
	AppReasonNoCLI     = "no_cli"     // neither `docker compose` nor docker-compose is there
	AppReasonBackFail  = "back_failed"
)

// AppResult is what an app task did to one app (TaskStatus.Apps).
type AppResult struct {
	App     string `cbor:"app" json:"app"`                         // the container's name
	Service string `cbor:"svc,omitempty" json:"service,omitempty"` // its Compose service
	Status  string `cbor:"status" json:"status"`
	Reason  string `cbor:"reason,omitempty" json:"reason,omitempty"`
	// From and To: the versions before and after (or tried), when known.
	From string `cbor:"from,omitempty" json:"from,omitempty"`
	To   string `cbor:"to,omitempty" json:"to,omitempty"`
	// Message: Docker's or Compose's own last line when something failed.
	Message string `cbor:"msg,omitempty" json:"message,omitempty"`
}

// AppLast is the last app task's outcome for one container (Guest.AppLast),
// kept across agent restarts in the agent's state directory.
type AppLast struct {
	Status   string    `cbor:"status"`
	Reason   string    `cbor:"reason,omitempty"`
	From     string    `cbor:"from,omitempty"`
	To       string    `cbor:"to,omitempty"`
	Finished time.Time `cbor:"finished"`
}

// Compose app facts on a Docker guest (Guest.App): set by agents that can
// update apps, for every container Docker Compose started. Its presence is
// the capability: an older agent sends none, and Whombat then says the
// server needs Whombat's newer helper.
type GuestApp struct {
	// Service: the Compose service ("immich-server").
	Service string `cbor:"svc"`
	// Version: the running image's version (its OCI version label, else a
	// version-like tag); NewVersion: the registry's newer image's, when an
	// update is available and its version could be read.
	Version    string `cbor:"ver,omitempty"`
	NewVersion string `cbor:"new_ver,omitempty"`
	// Blocked: why the agent can't update it (AppReasonNoFiles,
	// AppReasonPinned); "" = it can.
	Blocked string `cbor:"blocked,omitempty"`
	// Updating: an app task is updating it now.
	Updating bool     `cbor:"busy,omitempty"`
	Last     *AppLast `cbor:"last,omitempty"`
}
