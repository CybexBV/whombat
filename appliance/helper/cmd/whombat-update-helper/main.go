// Command whombat-update-helper is the root, socket-activated update helper (MA-11, MG-03).
//
//	whombat-update-helper --config /etc/whombat/update-helper.json                 (socket-activated)
//	whombat-update-helper --config ... --listen /run/test/helper.sock                (development)
//	whombat-update-helper --config ... revert-network-deadman                        (dead-man timer)
//	whombat-update-helper --config ... wifi-revert-deadman                           (Wi-Fi dead-man timer, NX-245)
//	whombat-update-helper --config ... cable-revert-deadman                          (the cable's dead-man timer)
//	whombat-update-helper --config ... seed-factory <releaseId>                       (provisioning)
//	whombat-update-helper --config ... set-channel production|development [--if-unset]  (bridges, recovery menu;
//	                                    --if-unset: only when the box has no channel recorded, ONE-03)
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/internal/ops"
	"github.com/CybexBV/whombat/appliance/helper/internal/server"
)

func main() {
	cfgPath := flag.String("config", "/etc/whombat/update-helper.json", "helper configuration file")
	listen := flag.String("listen", "", "listen on this socket path instead of socket activation (development)")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(*cfgPath, *listen, flag.Args(), log); err != nil {
		log.Error("whombat-update-helper", "err", err)
		os.Exit(1)
	}
}

func run(cfgPath, listen string, args []string, log *slog.Logger) error {
	l, err := server.Load(cfgPath)
	if err != nil {
		return err
	}
	h, err := ops.New(l.Ops, l.Activator)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if len(args) == 1 && args[0] == "revert-network-deadman" {
		return h.RevertNetworkDeadman(ctx)
	}
	if len(args) == 1 && args[0] == "wifi-revert-deadman" {
		return h.RevertWifiDeadman(ctx)
	}
	if len(args) == 1 && args[0] == "cable-revert-deadman" {
		return h.RevertCableDeadman(ctx)
	}
	if len(args) == 2 && args[0] == "seed-factory" {
		return h.SeedFactory(ctx, args[1])
	}
	if len(args) == 2 && args[0] == "set-channel" {
		return h.SetChannel(args[1])
	}
	if len(args) == 3 && args[0] == "set-channel" && args[2] == "--if-unset" {
		wrote, err := h.SetChannelIfUnset(args[1])
		if err == nil && wrote {
			log.Info("set-channel: recorded", "channel", args[1])
		}
		return err
	}
	if len(args) != 0 {
		return fmt.Errorf("unexpected arguments %v", args)
	}
	var ln *net.UnixListener
	if listen != "" {
		_ = os.Remove(listen)
		a, err := net.ResolveUnixAddr("unix", listen)
		if err != nil {
			return err
		}
		if ln, err = net.ListenUnix("unix", a); err != nil {
			return err
		}
	} else if ln, err = server.ListenerFromSystemd(); err != nil {
		return err
	}
	s := &server.Server{H: h, ManagerUID: l.ManagerUID, IdleTimeout: l.Idle, Log: log}
	return s.Serve(ctx, ln)
}
