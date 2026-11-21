// Package activator performs the privileged effects of helper operations. Callers pass only values
// the helper derived from verified TUF metadata (store paths, provider names) or validated network
// candidates; implementations never interpret strings as commands.
package activator

import (
	"context"
	"errors"
	"io"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// RuntimeSet is the runtime bundle plus provider bundles of one tuple.
type RuntimeSet struct {
	Runtime   string            `json:"runtime"`
	Providers map[string]string `json:"providers"` // provider name -> store path
}

// Generation is one generation of a profile (the system profile, the runtime profile).
type Generation struct {
	Number    int    `json:"number"`
	StorePath string `json:"storePath"`
	// Current: the generation the profile points to (`nix-env` refuses to delete it).
	Current bool `json:"current,omitempty"`
}

// GCResult is what a store collection deleted (`nix-store --gc`'s summary) and the free space it left on the store's
// file system; FreedBytes and FreeBytes are -1 when unknown.
type GCResult struct {
	Paths      int
	FreedBytes int64
	FreeBytes  int64
}

// NarPath is one store path imported from its NAR (closure indexes, UP-X14): the facts the export frame carries.
// The helper takes them from its own verified index.
type NarPath struct {
	StorePath  string
	NarSize    int64
	References []string
	Deriver    string
}

// ErrNoSpace is returned (wrapped) when an import fails for lack of disk space.
var ErrNoSpace = errors.New("no space left for import")

// Activator is implemented by `nix` (real appliance) and `fake` (directory-based, tests).
type Activator interface {
	// HasStorePath reports whether storePath is present and valid in the store.
	HasStorePath(ctx context.Context, storePath string) (bool, error)
	// InvalidPaths returns the given store paths that are not valid in the store (read-only; order kept).
	InvalidPaths(ctx context.Context, storePaths []string) ([]string, error)
	// ImportNar imports one store path from its verified NAR (exactly p.NarSize bytes from nar) and checks that the
	// path became valid. The references must be valid already (import order).
	ImportNar(ctx context.Context, p NarPath, nar io.Reader) error
	// SetRuntime points the runtime and provider profiles at the set (no restart).
	SetRuntime(ctx context.Context, set RuntimeSet) error
	// RestartRuntime restarts the runtime units so they run the current profiles.
	RestartRuntime(ctx context.Context) error
	// StartBackupRestore starts whombat-backup-restore@<checkpoint> without waiting for it (BK-39).
	StartBackupRestore(ctx context.Context, checkpoint string) error
	// RestartAfterRestore restarts the runtime units and the hosts service once a restore's quarantine ended.
	RestartAfterRestore(ctx context.Context) error
	// SetBootSystem makes hostStorePath the system profile and default boot entry.
	SetBootSystem(ctx context.Context, hostStorePath string) error
	// HostGenerations lists the system profile's generations.
	HostGenerations(ctx context.Context) ([]Generation, error)
	// DeleteHostGenerations deletes generations by number and rewrites the boot entries so their
	// kernels/initrds leave the boot partition.
	DeleteHostGenerations(ctx context.Context, numbers []int) error
	// RuntimeGenerations lists the runtime profile's generations (UP-X18).
	RuntimeGenerations(ctx context.Context) ([]Generation, error)
	// DeleteRuntimeGenerations deletes runtime-profile generations by number (never the current one).
	DeleteRuntimeGenerations(ctx context.Context, numbers []int) error
	// CollectGarbage deletes the store paths no GC root reaches, at low priority (UP-X19). It deletes no generation
	// and no profile: the profiles, the booted and current systems and running processes stay the roots.
	CollectGarbage(ctx context.Context) (GCResult, error)
	// ScheduleReboot reboots shortly after the current operation replied.
	ScheduleReboot(ctx context.Context) error
	// BlessBoot marks the currently booted entry good (boot counting).
	BlessBoot(ctx context.Context) error
	// CurrentSystem returns the booted system store path.
	CurrentSystem(ctx context.Context) (string, error)
	// ApplyNetwork applies a candidate, keeping the previous configuration for RevertNetwork.
	ApplyNetwork(ctx context.Context, c *netconfig.Candidate) error
	// ArmNetworkRevert schedules an automatic revert (dead-man) after seconds.
	ArmNetworkRevert(ctx context.Context, seconds int) error
	// DisarmNetworkRevert cancels the dead-man and commits the applied configuration.
	DisarmNetworkRevert(ctx context.Context) error
	// RevertNetwork restores the configuration from before ApplyNetwork and disarms.
	RevertNetwork(ctx context.Context) error
	// ArmWifiRevert schedules the Wi-Fi dead-man after seconds: `whombat-update-helper wifi-revert-deadman` as root,
	// which undoes the pending Wi-Fi change (NX-245). DisarmWifiRevert cancels it (no error when none is armed).
	ArmWifiRevert(ctx context.Context, seconds int) error
	DisarmWifiRevert(ctx context.Context) error
	// SetCable switches the wired interfaces off (off: each link stays up but takes no address, so a plugged cable is
	// still seen) or gives them their usual configuration back, now and until the next start. The interfaces
	// are the configured wired patterns and extra (a committed wired candidate's interface).
	SetCable(ctx context.Context, off bool, extra []string) error
	// CommitCable keeps the setting across restarts and host updates (the copy network.nix restores at boot).
	CommitCable(ctx context.Context, off bool, extra []string) error
	// CableState reports whether the cable is switched off now (live) and in the setting kept across restarts.
	CableState(ctx context.Context) (live, committed bool, err error)
	// ArmCableRevert schedules the cable's dead-man after seconds: `whombat-update-helper cable-revert-deadman` as root,
	// which undoes the pending cable change. DisarmCableRevert cancels it (no error when none is armed).
	ArmCableRevert(ctx context.Context, seconds int) error
	DisarmCableRevert(ctx context.Context) error
	// SchemaCheck runs the runtime's read-only `whombat schema-check --json --env` as the runtime user.
	SchemaCheck(ctx context.Context, runtimeStorePath string) (*proto.Schema, error)
	// Migrate runs `whombat migrate --json --env [--checkpoint id]` of that runtime as the runtime user.
	Migrate(ctx context.Context, runtimeStorePath, checkpointID string) (*proto.Schema, error)
}
