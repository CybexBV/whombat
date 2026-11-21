// Command whombat-hosts is Whombat's hosts service (formerly the Rackoon
// hub): the API, the agent listener and the console gateway. Headless
// (serve --headless) it serves the Whombat server over a Unix socket
// (docs/WHOMBAT.md); otherwise it also serves its own web UI.
//
//	whombat-hosts serve --data /var/lib/whombat-hosts --listen :8080 --agent-listen :8443 \
//	    --public-url http://10.100.0.6:8080 --agent-url wss://10.100.0.6:8443
//	whombat-hosts user add --data /var/lib/whombat-hosts --username alice --role viewer
//	whombat-hosts user passwd --data /var/lib/whombat-hosts --username john
//	whombat-hosts user list --data /var/lib/whombat-hosts
//	whombat-hosts backup --data /var/lib/whombat-hosts --out hub.tar
//	whombat-hosts restore --data /var/lib/whombat-hosts --from hub.tar [--force]
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"rackoon/internal/hub"
	"rackoon/internal/hub/store"
	"rackoon/web"
)

// version is set with -ldflags "-X main.version=...".
var version = ""

// envPrefix is the prefix of the settings' environment variables
// (WHOMBAT_HOSTS_DATA); Rackoon's RACKOON_DATA still works.
const envPrefix = "WHOMBAT_HOSTS_"

// lookupEnv reads WHOMBAT_HOSTS_<name>, else RACKOON_<name>.
func lookupEnv(name string) (string, bool) {
	if v, ok := os.LookupEnv(envPrefix + name); ok {
		return v, true
	}
	return os.LookupEnv("RACKOON_" + name)
}

func env(name, def string) string {
	if v, ok := lookupEnv(name); ok {
		return v
	}
	return def
}

func envBool(name string, def bool) bool {
	v, ok := lookupEnv(name)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage:
  whombat-hosts serve [flags]          run the hub (whombat-hosts serve -h for flags)
  whombat-hosts user add|passwd|list   manage accounts (offline, on the data dir)
  whombat-hosts backup --out FILE      write a backup (a tar, gzipped for .tar.gz: database snapshot and CA; works while the hub runs)
  whombat-hosts restore --from FILE    restore a backup into the data dir (stop the hub first)
  whombat-hosts assist serve|mcp-bridge  the assistant's runner (systemd starts it; docs/ASSIST.md)
  whombat-hosts version
`)
}

func main() {
	if version != "" {
		hub.Version = version
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "user":
		err = user(os.Args[2:])
	case "backup":
		err = backup(os.Args[2:])
	case "restore":
		err = restore(os.Args[2:])
	case "assist":
		err = assistCmd(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("whombat-hosts", hub.Version)
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-hosts:", err)
		os.Exit(1)
	}
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var cfg hub.Config
	fs.StringVar(&cfg.DataDir, "data", env("DATA", "/var/lib/whombat-hosts"), "data directory (database, CA) [WHOMBAT_HOSTS_DATA]")
	fs.StringVar(&cfg.Listen, "listen", env("LISTEN", ":8080"), "UI and API listen address: host:port, or unix:/path for a Unix socket [WHOMBAT_HOSTS_LISTEN]")
	socketMode := fs.String("socket-mode", env("SOCKET_MODE", "0660"), "file mode of the --listen unix: socket [WHOMBAT_HOSTS_SOCKET_MODE]")
	fs.BoolVar(&cfg.Headless, "headless", envBool("HEADLESS", false), "serve only the data API for the Whombat server: no web UI, users, sign-in or assistant (docs/WHOMBAT.md) [WHOMBAT_HOSTS_HEADLESS]")
	fs.StringVar(&cfg.ServiceTokenFile, "service-token-file", env("SERVICE_TOKEN_FILE", ""), "the Whombat server's bearer token; created (0640) when missing [WHOMBAT_HOSTS_SERVICE_TOKEN_FILE]")
	fs.StringVar(&cfg.AgentListen, "agent-listen", env("AGENT_LISTEN", ":8443"), "agent listener address, always TLS [WHOMBAT_HOSTS_AGENT_LISTEN]")
	fs.StringVar(&cfg.PublicURL, "public-url", env("PUBLIC_URL", ""), "UI origin as browsers see it, e.g. http://10.100.0.6:8080 [WHOMBAT_HOSTS_PUBLIC_URL]")
	fs.StringVar(&cfg.AgentURL, "agent-url", env("AGENT_URL", ""), "hub URL for agents, e.g. wss://10.100.0.6:8443; auto: the LAN address of the default route's interface [WHOMBAT_HOSTS_AGENT_URL]")
	fs.StringVar(&cfg.TLSCert, "tls-cert", env("TLS_CERT", ""), "serve the UI over HTTPS with this certificate [WHOMBAT_HOSTS_TLS_CERT]")
	fs.StringVar(&cfg.TLSKey, "tls-key", env("TLS_KEY", ""), "key for --tls-cert [WHOMBAT_HOSTS_TLS_KEY]")
	fs.StringVar(&cfg.WebDir, "web-dir", env("WEB_DIR", ""), "serve the UI from this directory instead of the embedded build [WHOMBAT_HOSTS_WEB_DIR]")
	fs.StringVar(&cfg.AgentDist, "agent-dist", env("AGENT_DIST", ""), "directory with whombat-agent-linux-{amd64,arm64} for install.sh [WHOMBAT_HOSTS_AGENT_DIST]")
	fs.StringVar(&cfg.AssistSocket, "assist-socket", env("ASSIST_SOCKET", ""), "Unix socket of the assistant runner (rackoon-assist.socket); empty: run it as a child process [WHOMBAT_HOSTS_ASSIST_SOCKET]")
	origins := fs.String("allowed-origins", env("ALLOWED_ORIGINS", ""), "extra browser origins, comma separated [WHOMBAT_HOSTS_ALLOWED_ORIGINS]")
	proxies := fs.String("trusted-proxies", env("TRUSTED_PROXIES", "127.0.0.0/8,::1"), "proxies whose X-Forwarded-For/-Proto are believed, comma-separated CIDRs [WHOMBAT_HOSTS_TRUSTED_PROXIES]")
	fs.BoolVar(&cfg.InsecureConsoles, "insecure-consoles", envBool("INSECURE_CONSOLES", false), "allow consoles over plain HTTP (keystrokes and screens unencrypted) [WHOMBAT_HOSTS_INSECURE_CONSOLES]")
	proxyProto := fs.Bool("agent-proxy-protocol", envBool("AGENT_PROXY_PROTOCOL", true), "accept a PROXY protocol header from loopback peers on the agent listener [WHOMBAT_HOSTS_AGENT_PROXY_PROTOCOL]")
	fs.StringVar(&cfg.OIDC.Issuer, "oidc-issuer", env("OIDC_ISSUER", ""), "single sign-on: OpenID Connect issuer URL; off when empty [WHOMBAT_HOSTS_OIDC_ISSUER]")
	fs.StringVar(&cfg.OIDC.ClientID, "oidc-client-id", env("OIDC_CLIENT_ID", ""), "single sign-on: client ID [WHOMBAT_HOSTS_OIDC_CLIENT_ID]")
	fs.StringVar(&cfg.OIDC.ClientSecretFile, "oidc-client-secret-file", env("OIDC_CLIENT_SECRET_FILE", ""), "single sign-on: file holding the client secret; empty for a public client [WHOMBAT_HOSTS_OIDC_CLIENT_SECRET_FILE]")
	fs.StringVar(&cfg.OIDC.Name, "oidc-name", env("OIDC_NAME", "single sign-on"), "single sign-on: provider name on the sign-in button [WHOMBAT_HOSTS_OIDC_NAME]")
	oidcScopes := fs.String("oidc-scopes", env("OIDC_SCOPES", "openid,profile,email"), "single sign-on: scopes, comma separated [WHOMBAT_HOSTS_OIDC_SCOPES]")
	fs.StringVar(&cfg.OIDC.UsernameClaim, "oidc-username-claim", env("OIDC_USERNAME_CLAIM", "preferred_username"), "single sign-on: claim with the Rackoon user name [WHOMBAT_HOSTS_OIDC_USERNAME_CLAIM]")
	fs.StringVar(&cfg.OIDC.RoleClaim, "oidc-role-claim", env("OIDC_ROLE_CLAIM", ""), "single sign-on: claim whose values give the role, e.g. groups; empty: roles are set in Rackoon [WHOMBAT_HOSTS_OIDC_ROLE_CLAIM]")
	oidcRoleMap := fs.String("oidc-role-map", env("OIDC_ROLE_MAP", ""), "single sign-on: claim values to roles, e.g. rackoon-admins=admin,rackoon-ops=operator,*=viewer [WHOMBAT_HOSTS_OIDC_ROLE_MAP]")
	fs.BoolVar(&cfg.OIDC.AutoCreate, "oidc-auto-create", envBool("OIDC_AUTO_CREATE", false), "single sign-on: create unknown users at their first sign-in (else an admin adds them first) [WHOMBAT_HOSTS_OIDC_AUTO_CREATE]")
	selfMACs := fs.String("self-macs", env("SELF_MACS", ""), "MAC addresses of the machine the hosts service runs on, comma separated; empty: read from /sys/class/net (finds the guest that is this Whombat) [WHOMBAT_HOSTS_SELF_MACS]")
	updGrace := fs.String("agent-update-grace", env("AGENT_UPDATE_GRACE", "2m"), "the first automatic agent update round this long after the start [WHOMBAT_HOSTS_AGENT_UPDATE_GRACE]")
	updEvery := fs.String("agent-update-interval", env("AGENT_UPDATE_INTERVAL", "15m"), "then an automatic agent update round this often [WHOMBAT_HOSTS_AGENT_UPDATE_INTERVAL]")
	updKick := fs.String("agent-update-after-connect", env("AGENT_UPDATE_AFTER_CONNECT", "1m"), "a round this long after an older agent connected [WHOMBAT_HOSTS_AGENT_UPDATE_AFTER_CONNECT]")
	level := fs.String("log-level", env("LOG_LEVEL", "info"), "debug, info, warn or error [WHOMBAT_HOSTS_LOG_LEVEL]")
	format := fs.String("log-format", env("LOG_FORMAT", "text"), "text or json [WHOMBAT_HOSTS_LOG_FORMAT]")
	_ = fs.Parse(args)
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	mode, err := strconv.ParseUint(*socketMode, 8, 32)
	if err != nil || mode > 0o777 {
		return fmt.Errorf("--socket-mode: want an octal mode such as 0660, got %q", *socketMode)
	}
	cfg.SocketMode = os.FileMode(mode)
	for _, d := range []struct {
		flag, v string
		to      *time.Duration
	}{{"agent-update-grace", *updGrace, &cfg.AgentUpdateGrace}, {"agent-update-interval", *updEvery, &cfg.AgentUpdateInterval},
		{"agent-update-after-connect", *updKick, &cfg.AgentUpdateKick}} {
		v, err := time.ParseDuration(d.v)
		if err != nil || v < time.Second {
			return fmt.Errorf("--%s: want a duration of at least 1s such as 2m, got %q", d.flag, d.v)
		}
		*d.to = v
	}
	tp, err := hub.ParseCIDRs(*proxies)
	if err != nil {
		return fmt.Errorf("--trusted-proxies: %w", err)
	}
	cfg.TrustedProxies = tp
	cfg.AgentProxyProtocol = proxyProto
	if *selfMACs != "" {
		if cfg.SelfMACs = hub.ParseSelfMACs(*selfMACs); len(cfg.SelfMACs) == 0 {
			return fmt.Errorf("--self-macs: no MAC address in %q", *selfMACs)
		}
	}
	cfg.OIDC.Scopes = strings.FieldsFunc(*oidcScopes, func(r rune) bool { return r == ',' || r == ' ' })
	if cfg.OIDC.RoleMap, err = hub.ParseOIDCRoleMap(*oidcRoleMap); err != nil {
		return fmt.Errorf("--oidc-role-map: %w", err)
	}
	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
		}
	}
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(*level)); err != nil {
		return fmt.Errorf("--log-level: %w", err)
	}
	log := hub.NewLogger(os.Stderr, lvl, *format == "json")
	slog.SetDefault(log)
	switch {
	case cfg.Headless:
		cfg.WebDir = "" // no UI
	case cfg.WebDir == "":
		cfg.WebFS = web.Dist()
	default:
		if _, err := os.Stat(filepath.Join(cfg.WebDir, "index.html")); err != nil {
			log.Warn("--web-dir has no index.html", "dir", cfg.WebDir)
		}
	}
	if !cfg.Headless && cfg.WebDir == "" && cfg.WebFS == nil {
		log.Warn("no web UI in this build: use --web-dir or build with -tags embedweb")
	}
	h, err := hub.New(cfg, log, os.Stderr)
	if err != nil {
		return err
	}
	defer h.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = h.Run(ctx)
	if errors.Is(err, hub.ErrRestart) {
		// The staged backup is applied when the service manager starts
		// the hub again (Restart=always; HS-179).
		log.Info("hub stopped to apply a restored backup")
		return nil
	}
	log.Info("hub stopped")
	return err
}

func user(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: whombat-hosts user add|passwd|delete|list --data DIR [--username NAME] [--role ROLE]")
	}
	fs := flag.NewFlagSet("user "+args[0], flag.ExitOnError)
	data := fs.String("data", env("DATA", "/var/lib/whombat-hosts"), "data directory [WHOMBAT_HOSTS_DATA]")
	name := fs.String("username", "", "user name")
	role := fs.String("role", store.RoleViewer, "viewer, operator or admin")
	_ = fs.Parse(args[1:])
	st, err := store.Open(filepath.Join(*data, "hub.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	switch args[0] {
	case "list":
		users, err := st.ListUsers(ctx)
		if err != nil {
			return err
		}
		for _, u := range users {
			fmt.Printf("%-24s %s\n", u.Username, u.Role)
		}
		return nil
	case "add":
		if store.RoleRank(*role) < 0 {
			return fmt.Errorf("unknown role %q", *role)
		}
		pw, generated, err := readPassword()
		if err != nil {
			return err
		}
		if err := hub.ValidateCredentials(*name, pw); err != nil {
			return err
		}
		hash, err := hub.HashPassword(pw)
		if err != nil {
			return err
		}
		wid := make([]byte, 32)
		_, _ = rand.Read(wid)
		if _, err := st.CreateUser(ctx, store.User{Username: *name, Role: *role, PasswordHash: hash, WebAuthnID: wid,
			CreatedAt: time.Now()}, false); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return fmt.Errorf("user %q exists", *name)
			}
			return err
		}
		cliAudit(ctx, st, store.AuditRecord{Event: "user.created", Outcome: "ok",
			Details: map[string]string{"username": *name, "role": *role, "via": "cli"}})
		fmt.Printf("created %s (%s)\n", *name, *role)
		if generated {
			fmt.Printf("password: %s\n", pw)
		}
		return nil
	case "delete":
		u, err := st.GetUserByName(ctx, *name)
		if err != nil {
			return fmt.Errorf("user %q: %w", *name, err)
		}
		// The store refuses to delete the last admin.
		if err := st.DeleteUser(ctx, u.ID); err != nil {
			return err
		}
		cliAudit(ctx, st, store.AuditRecord{Event: "user.deleted", Outcome: "ok",
			Details: map[string]string{"username": u.Username, "via": "cli"}})
		fmt.Printf("deleted %s\n", u.Username)
		return nil
	case "passwd":
		u, err := st.GetUserByName(ctx, *name)
		if err != nil {
			return fmt.Errorf("user %q: %w", *name, err)
		}
		pw, generated, err := readPassword()
		if err != nil {
			return err
		}
		if err := hub.ValidateCredentials(u.Username, pw); err != nil {
			return err
		}
		hash, err := hub.HashPassword(pw)
		if err != nil {
			return err
		}
		if err := st.SetPassword(ctx, u.ID, hash, time.Now()); err != nil {
			return err
		}
		if err := st.DeleteUserSessions(ctx, u.ID, nil); err != nil {
			return err
		}
		cliAudit(ctx, st, store.AuditRecord{Event: "auth.password_changed", Outcome: "ok",
			Details: map[string]string{"username": u.Username, "via": "cli"}})
		fmt.Printf("password of %s changed; all sessions signed out\n", u.Username)
		if generated {
			fmt.Printf("password: %s\n", pw)
		}
		return nil
	}
	return fmt.Errorf("unknown user command %q", args[0])
}

// readPassword reads a password from the terminal (twice) or one line of
// stdin; an empty answer generates one.
func readPassword() (pw string, generated bool, err error) {
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "Password (empty to generate): ")
		a, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", false, err
		}
		if len(a) > 0 {
			fmt.Fprint(os.Stderr, "Again: ")
			b, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return "", false, err
			}
			if string(a) != string(b) {
				return "", false, errors.New("passwords differ")
			}
			return string(a), false, nil
		}
	} else {
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if line = strings.TrimRight(line, "\r\n"); line != "" {
			return line, false, nil
		}
	}
	b := make([]byte, 15)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), true, nil
}

func backup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	data := fs.String("data", env("DATA", "/var/lib/whombat-hosts"), "data directory [WHOMBAT_HOSTS_DATA]")
	out := fs.String("out", "", "backup file to write: a tar (hub.tar), gzipped when it ends in .tar.gz or .tgz; - for a tar on stdout")
	_ = fs.Parse(args)
	if *out == "" {
		return errors.New("--out is required")
	}
	ctx := context.Background()
	if *out == "-" {
		return hub.BackupOffline(ctx, *data, os.Stdout, false)
	}
	gz := strings.HasSuffix(*out, ".tar.gz") || strings.HasSuffix(*out, ".tgz")
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := hub.BackupOffline(ctx, *data, f, gz); err != nil {
		f.Close()
		os.Remove(*out)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Backup written to %s. It contains the CA key: keep it as safe as the hub itself.\n", *out)
	return nil
}

func restore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ExitOnError)
	data := fs.String("data", env("DATA", "/var/lib/whombat-hosts"), "data directory [WHOMBAT_HOSTS_DATA]")
	from := fs.String("from", "", "backup file (a tar or .tar.gz)")
	force := fs.Bool("force", false, "replace an existing database (kept as hub.db.pre-restore-*.bak)")
	_ = fs.Parse(args)
	if *from == "" {
		return errors.New("--from is required")
	}
	f, err := os.Open(*from)
	if err != nil {
		return err
	}
	defer f.Close()
	m, err := hub.Restore(context.Background(), *data, f, *force)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Restored the backup of %s (hub %s, schema v%d) into %s. Start the hub; it makes a new agent listener certificate.\n",
		m.CreatedAt.Format(time.RFC3339), m.HubVersion, m.Schema, *data)
	return nil
}

// cliAudit records an account change made with the command line (the
// operating-system user who ran it is the actor).
func cliAudit(ctx context.Context, st *store.Store, rec store.AuditRecord) {
	who := os.Getenv("SUDO_USER")
	if who == "" {
		who = os.Getenv("USER")
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	rec.ID = fmt.Sprintf("au_%x", b)
	rec.At = time.Now()
	rec.User = "cli:" + who
	rec.UserAgent = "whombat-hosts " + hub.Version
	if err := st.AppendAudit(ctx, rec); err != nil {
		fmt.Fprintln(os.Stderr, "warning: the audit record was not written:", err)
	}
}
