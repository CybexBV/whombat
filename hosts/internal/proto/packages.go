package proto

import "time"

// Operating-system package updates (docs/MANAGE.md 2.9, Whombat's
// server-updates.md SWU-01…SWU-15): the agent refreshes the package
// manager's lists and installs the waiting updates as a task "pkg:<16 hex>"
// that runs outside the agent (a transient systemd unit, or its own
// session without systemd), so it survives an agent restart. One package
// task at a time per server. Platform "host".
const (
	// OpPackagesCheck refreshes the package lists (apt-get update, dnf
	// makecache, zypper refresh, apk update; pacman reads its cache again)
	// and reads the waiting updates again -> Task. task.stop can stop it.
	OpPackagesCheck = "packages.check"
	// OpPackagesInstall refreshes the lists and installs every waiting
	// update (apt dist-upgrade, dnf upgrade, yum update, zypper update or
	// dup on Tumbleweed, apk upgrade, pacman -Syu), or only Packages ->
	// Task. It can't be stopped once started.
	OpPackagesInstall = "packages.install"
)

// PackageTaskPrefix starts the id of a package task ("pkg:" + 16 hex
// digits).
const PackageTaskPrefix = "pkg:"

// PackagesMax bounds ManageRequest.Packages.
const PackagesMax = 200

// PackageResult is what an ended package task did (TaskStatus.Packages).
type PackageResult struct {
	// Installed: how many of the updates that were waiting are installed
	// now (0 for a check).
	Installed int `cbor:"installed" json:"installed"`
	// KeptBack: updates still waiting after an install (held packages,
	// ones the package manager kept back), at most 50 names.
	KeptBack []string `cbor:"kept_back,omitempty" json:"kept_back"`
	// Warning: one sentence about something that didn't stop the task
	// (a Proxmox enterprise repository that needs a subscription).
	Warning string `cbor:"warning,omitempty" json:"warning"`
}

// Task codes (TaskStatus.Code, PackageLast.Code): why a task ended
// without doing its work, as a refusal code.
const (
	TaskCodeBusy    = "busy"    // the package lock stayed held for two minutes
	TaskCodeTimeout = "timeout" // the task passed its limit (check 10 min, install 2 h) and was stopped
)

// PackageTask is the package task that runs now (SystemInfo.PackageTask).
type PackageTask struct {
	ID      string    `cbor:"id"`
	Op      string    `cbor:"op"` // check | install
	Started time.Time `cbor:"started"`
}

// PackageLast is the last package task that ended (SystemInfo.PackageLast),
// kept across agent restarts in the agent's state directory.
type PackageLast struct {
	Op       string    `cbor:"op"`     // check | install
	Status   string    `cbor:"status"` // ok | failed
	Finished time.Time `cbor:"finished"`
	// Installed: the updates the install put in (nil for a check, or when
	// the agent couldn't count them).
	Installed *int   `cbor:"installed,omitempty"`
	Message   string `cbor:"msg,omitempty"`
	Code      string `cbor:"code,omitempty"` // TaskCodeBusy | TaskCodeTimeout | ""
}

// Package task operations as PackageTask.Op and PackageLast.Op.
const (
	PackageOpCheck   = "check"
	PackageOpInstall = "install"
)
