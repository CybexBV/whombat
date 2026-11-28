// Command whombat-agent is the Whombat agent on a monitored server: it enrolls with the hosts service,
// reports metrics and inventory, and brokers consoles and power actions for
// the host's guests.
//
//	whombat-agent enroll --hub wss://hub:8443 --ca-sha256 <hex> --token <token> [--config-dir /etc/whombat-agent]
//	whombat-agent run [--config-dir /etc/whombat-agent]
//	whombat-agent allow|deny <switch>... [--config-dir /etc/whombat-agent]
//	whombat-agent policy [set watch|operate|full] [--config-dir /etc/whombat-agent]
//	whombat-agent hub [wss://HOST:PORT] [--config-dir /etc/whombat-agent]
//	whombat-agent whoami [--check [--hub wss://HOST:PORT]] [--config-dir /etc/whombat-agent]
//	whombat-agent collect --once --json [--config-dir /etc/whombat-agent]
//	whombat-agent console-test --platform incus --guest <id> --proto shell|tty|serial|vnc|spice
//	whombat-agent diagnose-test [--check NAME [--arg k=v]... | --exec COMMAND]
//	whombat-agent version
//	whombat-agent screen status|look|click|type|keys|unlock|account …|ui … (a Mac's screen)
//
// `whombat-agent update-install` is internal: a sandboxed agent (systemd)
// runs it through systemd-run to replace its own executable. So is
// `whombat-agent package-task --dir DIR`: one package check or install, in
// a transient unit (or its own session without systemd) that outlives the
// agent, and `whombat-agent app-task --dir DIR`: one update of Docker Compose
// apps, the same way.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"rackoon/internal/agent"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

func usage() {
	fmt.Fprintf(os.Stderr, `whombat-agent %s

Usage:
  whombat-agent enroll --hub wss://HOST:PORT --ca-sha256 HEX --token TOKEN [--config-dir DIR] [--force]
  whombat-agent run [--config-dir DIR] [--log-level info|debug]
  whombat-agent supervise [--config-dir DIR] [--pid-file FILE]
  whombat-agent allow SWITCH... [--config-dir DIR]   as root: allow it in agent.toml and reload the agent
  whombat-agent deny SWITCH... [--config-dir DIR]    as root: stop allowing it
  whombat-agent policy [--config-dir DIR]            what this server allows
                             (switches: console, power, host_shell, host_power, manage, diagnose, all)
  whombat-agent policy set LEVEL [--config-dir DIR] [--no-reload]
                             as root: exactly what Whombat may do (watch, operate, full)
  whombat-agent hub [URL] [--config-dir DIR]         the Whombat this server reports to; with URL, point it there
  whombat-agent whoami [--check [--hub URL]] [--config-dir DIR]
                             prints "<server id> <CA SHA-256>" (--check: and known, removed or unreachable)
  whombat-agent collect --once --json [--config-dir DIR]
  whombat-agent console-test --platform docker|incus|libvirt|pve|host --guest ID [--proto shell|tty|serial|vnc|spice|logs]
                             [--screenshot FILE [--max-width N]] [--action ACTION [--arg k=v]...]
                             [--inspect processes|ports|services|updates|snapshots]
                             [--manage OP [--task ID] [--packages A,B] [--log-start N] [--follow]] [--package-report]
  whombat-agent diagnose-test [--check NAME [--arg k=v]... | --exec COMMAND [--timeout S]]
                             the assistant's checks and commands, locally (no NAME: the catalog)
  whombat-agent version
  %s%s
`, version, screenUsage(), serviceUsage())
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	ownWrites()
	var err error
	switch os.Args[1] {
	case "enroll":
		err = cmdEnroll(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "supervise":
		err = cmdSupervise(os.Args[2:])
	case "allow":
		err = cmdSwitch("allow", true, os.Args[2:])
	case "deny":
		err = cmdSwitch("deny", false, os.Args[2:])
	case "policy":
		err = cmdPolicy(os.Args[2:])
	case "hub":
		err = cmdHub(os.Args[2:])
	case "whoami":
		err = cmdWhoami(os.Args[2:])
	case "collect":
		err = cmdCollect(os.Args[2:])
	case "console-test":
		err = cmdConsoleTest(os.Args[2:])
	case "diagnose-test":
		err = cmdDiagnoseTest(os.Args[2:])
	case "package-task":
		err = cmdPackageTask(os.Args[2:])
	case "app-task":
		err = cmdAppTask(os.Args[2:])
	case "update-install":
		err = cmdUpdateInstall(os.Args[2:])
	case "screen":
		err = cmdScreen(os.Args[2:])
	case "service":
		err = cmdService(os.Args[2:])
	case "uninstall":
		err = cmdUninstall(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("whombat-agent", version)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-agent:", err)
		os.Exit(1)
	}
}

func newLogger(level string) *slog.Logger { return newLoggerTo(os.Stderr, level) }

// newLoggerTo logs to w (the Windows service's log file, else stderr).
func newLoggerTo(w io.Writer, level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: l}
	if os.Getenv("JOURNAL_STREAM") != "" {
		// journald adds its own timestamps.
		opts.ReplaceAttr = func(groups []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey && len(groups) == 0 {
				return slog.Attr{}
			}
			return a
		}
	}
	return slog.New(slog.NewTextHandler(w, opts))
}

// loadOrDefaultConfig reads agent.toml, or returns defaults when the agent
// is not enrolled (collect and console-test work without enrollment).
func loadOrDefaultConfig(dir string) (*agent.Config, error) {
	cfg, err := agent.LoadConfig(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return &agent.Config{Dir: dir, StateDir: agent.DefaultStateDir}, nil
	}
	return cfg, err
}

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	hub := fs.String("hub", "", "hub agent endpoint, e.g. wss://10.100.0.6:8443")
	pin := fs.String("ca-sha256", "", "SHA-256 of the hub CA certificate (hex)")
	token := fs.String("token", "", "enrollment token from Whombat")
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	stateDir := fs.String("state-dir", agent.DefaultStateDir, "state directory written to agent.toml")
	force := fs.Bool("force", false, "enroll again even if already enrolled")
	timeout := fs.Duration("timeout", time.Hour, "how long to wait for approval")
	fs.Parse(args)
	if *hub == "" || *pin == "" || *token == "" {
		return errors.New("enroll needs --hub, --ca-sha256 and --token")
	}
	if *token == "-" {
		// Read the token from stdin so it does not show up in ps.
		var t string
		if _, err := fmt.Fscanln(os.Stdin, &t); err != nil {
			return fmt.Errorf("reading token from stdin: %w", err)
		}
		*token = strings.TrimSpace(t)
	}
	if err := prepareDirs(*dir, *stateDir); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), stopSignals()...)
	defer stop()
	cfg, err := agent.Enroll(ctx, agent.EnrollOptions{
		Hub:          *hub,
		CASHA256:     *pin,
		Token:        *token,
		ConfigDir:    *dir,
		StateDir:     *stateDir,
		AgentVersion: version,
		Force:        *force,
		Timeout:      *timeout,
		Logf: func(format string, a ...any) {
			fmt.Fprintf(os.Stderr, format+"\n", a...)
		},
		// install.sh's machine-readable line (Whombat SI-07): an owner has
		// to approve this server; the installer waits.
		OnPending: func(id string) {
			fmt.Println("Approve this server in Whombat (Add a server) to finish.")
			fmt.Println("whombat-agent: waiting " + id)
		},
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s, %s, %s and %s/agent.toml (remote control is off)\n",
		cfg.KeyPath(), cfg.CertPath(), cfg.CAPath(), cfg.Dir)
	return nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	level := fs.String("log-level", "info", "log level: debug, info, warn, error")
	fs.Parse(args)
	return runPlatform(*dir, *level)
}

// runAgent runs the agent of dir until ctx ends; a value on reload makes it
// read agent.toml again. When the agent needs a restart (an update or a
// rollback) it restarts the process (restartProcess), which on Windows
// ends runAgent with agent.ErrRestart.
func runAgent(ctx context.Context, reload <-chan struct{}, dir string, log *slog.Logger) error {
	cfg, cfgErr := agent.LoadConfig(dir)

	// First of all: a freshly updated binary that keeps failing (crash
	// loop, no hub connection) is rolled back here, before anything else
	// can fail. CheckPendingUpdate re-executes the previous binary then.
	exe, exeErr := agent.ExecutablePath()
	stateDir := agent.DefaultStateDir
	if cfgErr == nil {
		stateDir = cfg.StateDir
	}
	pending, err := agent.CheckPendingUpdate(stateDir, version, log)
	if errors.Is(err, agent.ErrRestart) {
		return err
	}
	if err != nil {
		log.Error("update check failed", "err", err)
	}
	if cfgErr != nil {
		return fmt.Errorf("%w (run `whombat-agent enroll` first)", cfgErr)
	}
	rt := agent.NewRuntime(cfg, version, log)
	wireAgent(rt, cfg, log)
	if exeErr == nil {
		rt.Updater = agent.NewUpdater(exe, cfg, version, log)
	} else {
		log.Warn("self-update unavailable: cannot locate the executable", "err", exeErr)
	}
	wireScreen(rt, cfg, log)
	rt.WatchUpdate(pending)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var reexec atomic.Bool
	rt.Restart = func() {
		reexec.Store(true)
		cancel()
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-reload:
				if err := rt.Reload(); err != nil {
					log.Error("reload failed", "err", err)
				}
			}
		}
	}()
	if err := rt.Run(ctx); err != nil {
		return err
	}
	if reexec.Load() {
		return restartProcess(exe, log)
	}
	return nil
}

// cmdUpdateInstall replaces an executable for a sandboxed agent (see
// agent.InstallExecutable); it runs outside the sandbox via systemd-run.
func cmdUpdateInstall(args []string) error {
	fs := flag.NewFlagSet("update-install", flag.ExitOnError)
	from := fs.String("from", "", "verified new executable")
	to := fs.String("to", "", "executable to replace")
	backup := fs.String("backup", "", "keep the replaced executable here")
	fs.Parse(args)
	if *from == "" || *to == "" || !filepath.IsAbs(*from) || !filepath.IsAbs(*to) || (*backup != "" && !filepath.IsAbs(*backup)) {
		return errors.New("update-install needs absolute --from and --to")
	}
	if !isRoot() {
		return errors.New("update-install must run as root")
	}
	return agent.InstallExecutable(*from, *to, *backup)
}

func cmdCollect(args []string) error {
	fs := flag.NewFlagSet("collect", flag.ExitOnError)
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	fs.Bool("once", true, "collect one report and exit (the only mode)")
	asJSON := fs.Bool("json", true, "print the report as JSON")
	series := fs.Bool("series", false, "also print Report.Series()")
	fs.Parse(args)
	cfg, err := loadOrDefaultConfig(*dir)
	if err != nil {
		return err
	}
	c := newCollector(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Some collectors compute rates from deltas: prime them first.
	if _, err := c.Collect(ctx); err != nil {
		return err
	}
	time.Sleep(time.Second)
	r, err := c.Collect(ctx)
	if err != nil {
		return err
	}
	r.Policy = cfg.Policy()
	if !*asJSON {
		fmt.Printf("%+v\n", r)
		return nil
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if *series {
		return enc.Encode(map[string]any{"report": r, "series": r.Series()})
	}
	return enc.Encode(r)
}
