package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

const defaultAdminDSN = "host=/run/postgresql dbname=postgres user=postgres"

// cmdRestore is the app's restore (BK-39, Whombat backup-options.md BKO-11), run as root by
// whombat-backup-restore@<checkpoint>.service (quarantine.AppRestore): checked first while the box runs, then the
// runtime stopped, the fresh install set aside, the checkpoint checked and put in place, the database writable, the box
// in quarantine for the person's answers. The unit brings the schema to this release's and calls restore-end. A
// restore that fails is undone and the runtime started again; restore-result.json says why.
func cmdRestore(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("restore", flag.ExitOnError)
	snapID := fs.String("snapshot", "", "the checkpoint to restore")
	db := fs.String("db", "whombat", "the runtime's database")
	dbOwner := fs.String("db-owner", "whombat", "its owner")
	adminDSN := fs.String("admin-dsn", defaultAdminDSN, "maintenance database")
	dsn := fs.String("dsn", "host=/run/postgresql dbname=whombat user=postgres", "the runtime's database as a superuser")
	checkData := fs.String("check-data", restore.CheckStructure, "restic check --read-data level before the restore (\"\": the structure; restore --verify proves the checkpoint's data)")
	releaseSchema := fs.Int("release-schema", 0, "this release's database schema version (0: unknown): a backup with a newer one is refused")
	systemctl := fs.String("systemctl", "systemctl", "systemctl")
	lockHeld := fs.Bool("lock-held", false, "the caller holds the restore lock (the restore unit's script)")
	_ = fs.Parse(args)
	if !state.InRootMode() {
		die(64, "restore runs as root (whombat-backup-restore@<checkpoint>.service)")
	}
	if *snapID == "" || *snapID == "latest" {
		die(64, "-snapshot <checkpoint id> required")
	}
	if *lockHeld {
		quarantine.LockHeldByCaller(cfg)
	}
	err := quarantine.AppRestore(ctx, cfg, quarantine.AppOptions{CheckpointID: *snapID, DB: *db, DBOwner: *dbOwner, DSN: *dsn,
		Admin: &pgtool.Admin{DSN: *adminDSN}, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{Git: cfg.Git},
		CheckData: *checkData, ReleaseSchema: *releaseSchema, Log: logf,
		StopRuntime: func(ctx context.Context) error {
			out, err := exec.CommandContext(ctx, *systemctl, "stop", "whombat-runtime.target", "whombat-server.service",
				"whombat-runner.service").CombinedOutput()
			if err != nil {
				return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
			}
			waitRuntimeGone(cfg.RuntimeSocket, 60*time.Second)
			return nil
		},
		StartRuntime: func(ctx context.Context) { startRuntime(ctx, *systemctl) }})
	if err != nil {
		var re *quarantine.Refusal
		if errors.As(err, &re) {
			die(2, "restore refused (%s): %s", re.Reason, re.Msg)
		}
		die(1, "restore: %v", err)
	}
}

// cmdRestoreEnd is the restore unit's last step, after the schema step: -failed "" (it worked) leaves the box in
// quarantine; newer|migration|check undo the restore with that reason.
func cmdRestoreEnd(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("restore-end", flag.ExitOnError)
	snapID := fs.String("snapshot", "", "the checkpoint restored")
	failed := fs.String("failed", "", "why the schema step failed: newer, migration or check (\"\": it worked)")
	detail := fs.String("detail", "", "a short detail for the person (exit codes)")
	adminDSN := fs.String("admin-dsn", defaultAdminDSN, "maintenance database")
	lockHeld := fs.Bool("lock-held", false, "the caller holds the restore lock (the restore unit's script)")
	_ = fs.Parse(args)
	if !state.InRootMode() {
		die(64, "restore-end runs as root (whombat-backup-restore@<checkpoint>.service)")
	}
	if *lockHeld {
		quarantine.LockHeldByCaller(cfg)
	}
	if err := quarantine.End(ctx, cfg, &pgtool.Admin{DSN: *adminDSN}, *snapID, *failed, *detail); err != nil {
		die(1, "restore-end: %v", err)
	}
	if *failed != "" {
		logf("restore: undone (%s): this Whombat is back as it was", *failed)
	}
}

// cmdRestoreRecover (whombat-backup-restore-recover.service, root): before the runtime starts and after a release,
// a restore that a crash or a power cut stopped is undone, and what a released one set aside is removed.
func cmdRestoreRecover(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("restore-recover", flag.ExitOnError)
	adminDSN := fs.String("admin-dsn", defaultAdminDSN, "maintenance database")
	_ = fs.Parse(args)
	if err := quarantine.Recover(ctx, cfg, &pgtool.Admin{DSN: *adminDSN}, logf); err != nil {
		die(1, "restore-recover: %v", err)
	}
}

func startRuntime(ctx context.Context, systemctl string) {
	if out, err := exec.CommandContext(ctx, systemctl, "start", "whombat-runtime.target").CombinedOutput(); err != nil {
		logf("restore: start the runtime: %v: %s", err, strings.TrimSpace(string(out)))
	}
}

func waitRuntimeGone(socket string, limit time.Duration) {
	if socket == "" {
		return
	}
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("unix", socket, time.Second)
		if err != nil {
			return
		}
		c.Close()
		time.Sleep(time.Second)
	}
}
