// Command whombat-manager-recovery is started by systemd when whombat-manager fails (OnFailure=).
// It execs the known-good manager (the whombat-manager of a host the update helper recorded, from the
// read-only Nix store; M-3) with --recovery; without one it runs the recovery daemon built into itself.
// See docs/decisions/manager.md "systemd units".
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/knowngood"
	"github.com/CybexBV/whombat/appliance/manager/internal/recovery"
)

func main() {
	cfgPath := flag.String("config", "/etc/whombat/manager.json", "manager configuration")
	helperSocket := flag.String("helper-socket", "", "update helper socket (default: from the configuration)")
	storeDir := flag.String("store-dir", knowngood.StoreDir, "Nix store (tests)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	var cfg *config.Config
	socket := *helperSocket
	if c, err := config.Load(*cfgPath); err == nil {
		cfg = c
		if socket == "" {
			socket = c.HelperSocket
		}
	} else {
		log.Warn("recovery: configuration", "err", err)
	}
	var src recovery.Source
	if socket != "" {
		src = recovery.HelperSource(socket)
	}
	err := recovery.Launch(src, *storeDir, *cfgPath, recovery.SyscallExec, func() error {
		if cfg == nil {
			c, err := config.Load(*cfgPath)
			if err != nil {
				return err
			}
			cfg = c
		}
		d, err := daemon.New(cfg, true, log)
		if err != nil {
			return err
		}
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		return d.Run(ctx)
	})
	if err != nil {
		log.Error("recovery manager", "err", err)
		os.Exit(1)
	}
}
