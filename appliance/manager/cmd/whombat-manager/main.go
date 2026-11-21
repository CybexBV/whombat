// Command whombat-manager is the appliance device manager (MA-11, docs/decisions/manager.md).
//
//	whombat-manager --config /etc/whombat/manager.json [--recovery]         run (systemd Type=notify)
//	whombat-manager --config … provision --factory-release <releaseId>      first boot: record the factory tuple
//	whombat-manager --config … status                                      print the update status
//	whombat-manager --config … check                                       ask control for an update now (MG-67)
//	whombat-manager --config … tailscale state|on [--login-server URL]|off [--sign-out]|sign-in|cert|peers   Tailscale as the runtime gets it (MG-130, MG-135, MG-140)
//	whombat-manager ask-off --journal <dir>                                the recovery menu: “Ask before updating” off
//	whombat-manager reach link|tailscale|tailscale-on [--file F]           the recovery menu: how this Whombat is reached (LNK-12)
//	whombat-manager environment show|set <env> [--if-absent]|undo|recover|write-run
//	                                                                       the box's environment (LNK-01a), root; set
//	                                                                       moves the box there (ONE-06), undo puts the
//	                                                                       newest move back (MG-178), manager stopped
//	whombat-manager keygen --out <path>                                    development: new management key
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/factory"
	"github.com/CybexBV/whombat/appliance/manager/internal/identity"
	"github.com/CybexBV/whombat/appliance/manager/internal/tailscale"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func main() {
	cfgPath := flag.String("config", "/etc/whombat/manager.json", "manager configuration")
	recoveryMode := flag.Bool("recovery", false, "known-good recovery mode: finish rollbacks, never activate")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(*cfgPath, *recoveryMode, flag.Args(), log); err != nil {
		log.Error("whombat-manager", "err", err)
		var ec exitCode
		if errors.As(err, &ec) {
			os.Exit(ec.code)
		}
		os.Exit(1)
	}
}

// exitCode gives an error its own exit status: the provisioning unit tells the console why a box can't start (NX-526).
type exitCode struct {
	code int
	err  error
}

func (e exitCode) Error() string { return e.err.Error() }
func (e exitCode) Unwrap() error { return e.err }

// provision's exit statuses besides 0 and 1 (nix/modules/provisioning.nix reads them).
const (
	exitNotListed   = 3 // no update channel lists the factory release
	exitUnreachable = 4 // the update repository can't be read
)

// provision records the release the box was installed with as current and known-good (MG-20), from whichever channel
// lists it: a release only the other channel lists moves the box to that channel first (MG-182).
func provision(ctx context.Context, d *daemon.Daemon, id string) error {
	// The channel as the helper keeps it, asked once: a helper that doesn't answer must not look like a release no
	// channel lists (the top level of a repository with channels lists none).
	if _, err := d.Channel.Load(ctx); err != nil {
		return fmt.Errorf("the update helper's channel: %w", err)
	}
	// Nothing runs that a channel change should wake (the daemon isn't running in this process).
	d.Channel.Changed = nil
	f := factory.Finder{TUF: d.TUF, Follow: func(ctx context.Context, ch string) error {
		_, err := d.Channel.Set(ctx, ch)
		return err
	}}
	found, err := f.Find(ctx, id)
	switch {
	case errors.Is(err, factory.ErrNotListed):
		return exitCode{exitNotListed, err}
	case errors.Is(err, factory.ErrUnreachable):
		return exitCode{exitUnreachable, err}
	case err != nil:
		return err
	}
	if found.Moved {
		fmt.Printf("%s is listed in the %s channel only: this Whombat follows the %s channel\n", id, found.Channel, found.Channel)
	}
	return d.Engine.Provision(found.Release)
}

func run(cfgPath string, recovery bool, args []string, log *slog.Logger) error {
	if len(args) >= 1 && args[0] == "keygen" {
		fs := flag.NewFlagSet("keygen", flag.ExitOnError)
		out := fs.String("out", "", "key file to create (refuses to overwrite)")
		fs.Parse(args[1:])
		k, err := identity.Generate(*out)
		if err != nil {
			return err
		}
		fmt.Printf("%x\n", k.Public)
		return nil
	}
	if len(args) >= 1 && args[0] == "ask-off" {
		// The recovery menu at the box, with no manager running: it has no configuration, only the data volume.
		fs := flag.NewFlagSet("ask-off", flag.ExitOnError)
		dir := fs.String("journal", "", "the update journal's folder on the mounted data volume")
		socket := fs.String("socket", "/run/whombat-manager/api.sock", "refused while a manager answers here")
		fs.Parse(args[1:])
		return askOff(*dir, *socket)
	}
	if len(args) >= 1 && args[0] == "reach" {
		// The recovery menu at the box, as root, with no manager running: the choice goes into the root-owned file the
		// manager acts on at its next start.
		return reachCmd(args[1:])
	}
	if len(args) >= 1 && args[0] == "environment" {
		// Root's: no configuration needed (the bridge release and whombat-environment.service run it).
		return environmentCmd(args[1:])
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	if len(args) >= 1 && args[0] == "check" {
		// The running manager polls; this only asks it over its local API (root or the manager's user).
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		res, err := broker.Check(ctx, cfg.APISocket)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(res)
	}
	if len(args) >= 1 && args[0] == "tailscale" {
		// Tailscale as the runtime gets it through the manager (MG-130), for root and the manager's user: state, on,
		// off [--sign-out], sign-in, cert (the name and the end of its certificate, never the key).
		return tailscaleCmd(cfg.TailscaleSocket, cfg.TailscaleWantFile(), args[1:], log)
	}
	d, err := daemon.New(cfg, recovery, log)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	switch {
	case len(args) == 0:
		return d.Run(ctx)
	case args[0] == "status":
		st, err := d.Engine.Load()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(broker.StatusOf(st))
	case args[0] == "provision":
		fs := flag.NewFlagSet("provision", flag.ExitOnError)
		id := fs.String("factory-release", "", "release id of the factory image tuple")
		fs.Parse(args[1:])
		return provision(ctx, d, *id)
	}
	return fmt.Errorf("unknown command %q", args[0])
}

// askOff turns the owner's “Ask before updating” off in a journal no manager runs on (update.AskOffAtTheBox) and says
// what happens next, for the person at the box's screen. A running manager keeps its own copy of the journal and would
// write over the change, so it refuses while one answers; there the apps turn the switch off.
func askOff(dir, socket string) error {
	if dir == "" {
		return errors.New("usage: whombat-manager ask-off --journal <folder>")
	}
	if c, err := net.DialTimeout("unix", socket, time.Second); err == nil {
		c.Close()
		return errors.New("the manager is running: turn Ask before updating off in the apps instead")
	}
	waiting, changed, err := update.AskOffAtTheBox(dir, time.Now())
	if err != nil {
		return err
	}
	switch {
	case !changed:
		fmt.Println("Ask before updating was already off. Nothing was changed.")
	case waiting != "":
		fmt.Println("Ask before updating is off. The update that waited installs by itself once this Whombat runs again.")
	default:
		fmt.Println("Ask before updating is off. Updates install by themselves again.")
	}
	return nil
}

func tailscaleCmd(socket, wantFile string, args []string, log *slog.Logger) error {
	if socket == "" {
		return errors.New("this box has no Tailscale (tailscaleSocket is \"-\")")
	}
	if len(args) == 0 {
		return errors.New("usage: whombat-manager tailscale state|on [--login-server URL]|off [--sign-out]|sign-in|cert|peers")
	}
	// The daemon's want file: on and off here are kept for the next start as the runtime's are.
	m := tailscale.New(tailscale.Config{Socket: socket, Log: log, WantFile: wantFile})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	var st protocol.TailscaleStatus
	var err error
	switch args[0] {
	case "state":
		st = m.State(ctx)
	case "on":
		fs := flag.NewFlagSet("on", flag.ExitOnError)
		server := fs.String("login-server", "", "the coordination server to sign in to (default: Tailscale's own; MG-135)")
		fs.Parse(args[1:])
		st, err = m.On(ctx, *server)
	case "off":
		fs := flag.NewFlagSet("off", flag.ExitOnError)
		signOut := fs.Bool("sign-out", false, "also sign the box out of the tailnet")
		fs.Parse(args[1:])
		st, err = m.Off(ctx, *signOut)
	case "sign-in":
		st, err = m.SignIn(ctx)
	case "cert":
		c, err := m.Cert(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"name": c.Name, "notAfter": c.NotAfter})
	case "peers":
		// The tailnet's other devices as the runtime gets them for the agent (MG-140).
		peers, err := m.Peers(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(peers)
	default:
		return fmt.Errorf("unknown tailscale command %q", args[0])
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(st)
}
