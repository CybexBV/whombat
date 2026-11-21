// Command rackoon-sim runs simulated Whombat agents against a real hub. It
// enrolls each host through the real enrollment flow, then streams
// synthetic reports modeled on the fixture fleet (basalt, granite,
// obsidian, quartz, shale as a Proxmox VE node of a 3-node cluster, flint,
// onyx, and marble, which goes offline). It answers console streams with a
// fake terminal, thumbnails with a generated JPEG, power actions by
// changing the simulated guest state, and (--allow-manage) guest management
// on shale from an in-memory state.
//
//	rackoon-sim --ui http://127.0.0.1:8080 --admin-user john --admin-pass '...'
//	rackoon-sim --ui http://127.0.0.1:8080 --tokens TOKEN1,TOKEN2,...   # approve in the UI
//	rackoon-sim --ui unix:/run/whombat-hosts/api.sock --service-token-file TOKEN_FILE   # a headless hub
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/hub/fakefleet"
)

const simVersion = "0.14.2-sim"

type options struct {
	ui           string
	agentURL     string
	pin          string
	adminUser    string
	adminPass    string
	serviceToken string // headless hub: the service token (file contents)
	tokens       []string
	stateDir     string
	n            int
	only         map[string]bool
	interval     time.Duration
	history      time.Duration
	offlineAfter time.Duration
	backfillTest bool
	bfEvery      time.Duration
	bfGap        time.Duration
	console      bool
	power        bool
	hostShell    bool
	hostPower    bool
	manage       bool
	updateKey    string
	updateOff    map[string]bool
	keyless      map[string]bool // with updateKey: these run without a key (update.go)
	agentVersion string
	enableRC     bool
	unraid       bool
	libvirt      bool
}

var log *slog.Logger

func main() {
	var o options
	var tokens, only string
	flag.StringVar(&o.ui, "ui", "http://127.0.0.1:8080", "hub UI/API origin")
	flag.StringVar(&o.agentURL, "agent-url", "", "hub agent URL (default: read from <ui>/install.sh)")
	flag.StringVar(&o.pin, "ca-sha256", "", "hub CA pin (default: read from <ui>/install.sh)")
	flag.StringVar(&o.adminUser, "admin-user", os.Getenv("RACKOON_SIM_ADMIN_USER"), "admin user: create enrollment tokens and approve via the API")
	flag.StringVar(&o.adminPass, "admin-pass", os.Getenv("RACKOON_SIM_ADMIN_PASS"), "admin password [RACKOON_SIM_ADMIN_PASS]")
	flag.StringVar(&tokens, "tokens", "", "comma-separated enrollment tokens (without admin credentials; approve in the UI)")
	tokenFile := flag.String("service-token-file", "", "a headless hub's service token: create and approve enrollments with it (--ui may be unix:/path)")
	flag.StringVar(&o.stateDir, "state", "./rackoon-sim-state", "directory for the simulated agents' keys and certificates")
	flag.IntVar(&o.n, "n", 8, "number of hosts (the 8 fixture hosts, then sim-09, sim-10, ...)")
	flag.StringVar(&only, "hosts", "", "only these hosts (comma separated)")
	flag.DurationVar(&o.interval, "interval", 10*time.Second, "report interval")
	flag.DurationVar(&o.history, "history", 6*time.Hour, "synthetic history to backfill on first connect (max 24h)")
	flag.DurationVar(&o.offlineAfter, "offline-after", 3*time.Minute, "marble disconnects for good after this (0: never)")
	flag.BoolVar(&o.backfillTest, "backfill-test", false, "periodically drop connections, buffer samples and backfill them")
	flag.DurationVar(&o.bfEvery, "backfill-every", 5*time.Minute, "with --backfill-test: time between drops")
	flag.DurationVar(&o.bfGap, "backfill-gap", 2*time.Minute, "with --backfill-test: how long the hub is unreachable")
	flag.BoolVar(&o.console, "allow-console", true, "agents' local remote_control.console flag")
	flag.BoolVar(&o.power, "allow-power", true, "agents' local remote_control.power flag")
	flag.BoolVar(&o.hostShell, "allow-host-shell", false, "agents' local remote_control.host_shell flag")
	flag.BoolVar(&o.hostPower, "allow-host-power", false, "agents' local remote_control.host_power flag (simulated: nothing reboots)")
	flag.BoolVar(&o.manage, "allow-manage", false, "agents' local remote_control.manage flag (shale answers guest management from an in-memory state)")
	flag.StringVar(&o.updateKey, "update-key", "", "agents report this update key and accept updates (the hub's manifest key; updates fail in the simulator)")
	updateOff := flag.String("update-off", "", "with --update-key: these hosts have updates turned off (comma separated)")
	keyless := flag.String("update-keyless", "onyx", "with --update-key: these hosts run an agent without the key, so they need the last install (comma separated)")
	flag.StringVar(&o.agentVersion, "agent-version", simVersion, "the agents' version (with --update-key, e.g. 0.0.0-20261018094703.5394c53: older than the hub's build, so they are updated)")
	flag.BoolVar(&o.unraid, "unraid", false, "also simulate blackbox, an unRAID server that answers unRAID operations with --allow-manage")
	flag.BoolVar(&o.libvirt, "libvirt", false, "also simulate kvm-lab, a libvirt (QEMU/KVM) host that answers libvirt operations with --allow-manage")
	flag.BoolVar(&o.enableRC, "enable-remote-control", false, "with --admin-user: also turn on the hub's console and power toggles of new servers (and manage with --allow-manage)")
	level := flag.String("log-level", "info", "log level")
	flag.Parse()
	var lvl slog.Level
	_ = lvl.UnmarshalText([]byte(*level))
	log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))
	if tokens != "" {
		o.tokens = strings.Split(tokens, ",")
	}
	if *tokenFile != "" {
		b, err := os.ReadFile(*tokenFile)
		if err != nil {
			log.Error("service token", "err", err)
			os.Exit(1)
		}
		o.serviceToken = strings.TrimSpace(string(b))
	}
	o.updateOff, o.keyless = hostSet(*updateOff), hostSet(*keyless)
	if only != "" {
		o.only = map[string]bool{}
		for _, h := range strings.Split(only, ",") {
			o.only[strings.TrimSpace(h)] = true
		}
	}
	if o.history > 24*time.Hour {
		o.history = 24 * time.Hour
	}
	o.ui = strings.TrimRight(o.ui, "/")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, o); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("sim failed", "err", err)
		os.Exit(1)
	}
}

// hostSet reads a comma-separated list of hosts.
func hostSet(list string) map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.Split(list, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out[h] = true
		}
	}
	return out
}

func run(ctx context.Context, o options) error {
	var api *apiClient
	switch {
	case o.serviceToken != "":
		api = newServiceClient(o.ui, o.serviceToken)
	case o.adminUser != "":
		api = &apiClient{base: o.ui}
		if err := api.login(ctx, o.adminUser, o.adminPass); err != nil {
			return fmt.Errorf("admin login: %w", err)
		}
	}
	if (o.agentURL == "" || o.pin == "") && o.serviceToken != "" {
		var hub struct {
			AgentsURL string `json:"agents_url"`
			Pin       string `json:"ca_sha256"`
		}
		if err := api.do(ctx, http.MethodGet, "/api/v1/hub", nil, &hub); err != nil {
			return fmt.Errorf("GET /api/v1/hub (or pass --agent-url and --ca-sha256): %w", err)
		}
		if o.agentURL == "" {
			o.agentURL = hub.AgentsURL
		}
		if o.pin == "" {
			o.pin = hub.Pin
		}
		if o.agentURL == "" {
			return errors.New("the hub has no agent URL: pass --agent-url")
		}
	}
	if o.agentURL == "" || o.pin == "" {
		u, p, err := fromInstallScript(ctx, o.ui)
		if err != nil {
			return fmt.Errorf("reading %s/install.sh (or pass --agent-url and --ca-sha256): %w", o.ui, err)
		}
		if o.agentURL == "" {
			o.agentURL = u
		}
		if o.pin == "" {
			o.pin = p
		}
	}
	log.Info("hub", "agent_url", o.agentURL, "ca_sha256", o.pin)
	hosts := fakefleet.Fleet()
	if o.n > len(hosts) {
		hosts = append(hosts, fakefleet.Extra(o.n-len(hosts))...)
	} else {
		hosts = hosts[:max(o.n, 0)]
	}
	if o.unraid {
		hosts = append(hosts, fakefleet.Blackbox())
	}
	if o.libvirt {
		hosts = append(hosts, fakefleet.KVMLab())
	}
	var sel []*fakefleet.Host
	for _, h := range hosts {
		if o.only == nil || o.only[h.ID] {
			h.Policy.Console, h.Policy.Power = o.console, o.power
			sel = append(sel, h)
		}
	}
	if err := os.MkdirAll(o.stateDir, 0o700); err != nil {
		return err
	}
	var wg sync.WaitGroup
	start := time.Now()
	// Hosts enroll in parallel (each waits for its own approval), then run.
	errs := make(chan error, len(sel))
	for i, h := range sel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := ensureIdentity(ctx, o, api, h, i)
			if err != nil {
				log.Error("enrollment failed", "host", h.ID, "err", err)
				errs <- err
				return
			}
			a := &simAgent{o: o, host: h, id: id, start: start}
			a.run(ctx)
		}()
	}
	log.Info("simulating", "hosts", len(sel))
	wg.Wait()
	select {
	case err := <-errs:
		if ctx.Err() == nil {
			return err
		}
	default:
	}
	return ctx.Err()
}

var installVar = regexp.MustCompile(`(?m)^(HUB_URL|CA_SHA256)='([^']*)'`)

func fromInstallScript(ctx context.Context, ui string) (agentURL, pin string, err error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ui+"/install.sh", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("status %d", resp.StatusCode)
	}
	for _, m := range installVar.FindAllStringSubmatch(string(b), -1) {
		switch m[1] {
		case "HUB_URL":
			agentURL = m[2]
		case "CA_SHA256":
			pin = m[2]
		}
	}
	if agentURL == "" || pin == "" {
		return "", "", errors.New("HUB_URL / CA_SHA256 not found")
	}
	return agentURL, pin, nil
}

// ---- admin API client -----------------------------------------------------------

type apiClient struct {
	base  string
	c     *http.Client
	csrf  string
	token string // the service token of a headless hub
}

// newServiceClient talks to a headless hub with its service token, over
// its Unix socket when ui is "unix:/path".
func newServiceClient(ui, token string) *apiClient {
	a := &apiClient{base: ui, token: token, c: &http.Client{Timeout: 30 * time.Second}}
	if path, ok := strings.CutPrefix(ui, "unix:"); ok {
		a.base = "http://hosts"
		a.c.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		}}
	}
	return a
}

func (a *apiClient) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
		req.Header.Set("X-Whombat-Actor", "rackoon-sim|Simulator")
	} else {
		req.Header.Set("Origin", a.base)
	}
	if a.csrf != "" {
		req.Header.Set("X-CSRF-Token", a.csrf)
	}
	resp, err := a.c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && len(b) > 0 {
		return json.Unmarshal(b, out)
	}
	return nil
}

func (a *apiClient) refreshCSRF(ctx context.Context) error {
	var st struct {
		CSRF string `json:"csrf_token"`
	}
	if err := a.do(ctx, http.MethodGet, "/api/v1/auth/state", nil, &st); err != nil {
		return err
	}
	a.csrf = st.CSRF
	return nil
}

func (a *apiClient) login(ctx context.Context, user, pass string) error {
	jar, _ := cookiejar.New(nil)
	a.c = &http.Client{Jar: jar, Timeout: 30 * time.Second}
	if err := a.refreshCSRF(ctx); err != nil {
		return err
	}
	if err := a.do(ctx, http.MethodPost, "/api/v1/auth/login", map[string]string{"username": user, "password": pass}, nil); err != nil {
		return err
	}
	return a.refreshCSRF(ctx)
}

// ---- identity / enrollment ---------------------------------------------------

type identity struct {
	cert   tls.Certificate
	caPool *x509.CertPool
}

func hostDir(o options, h *fakefleet.Host) string { return filepath.Join(o.stateDir, h.ID) }

func loadIdentity(dir string) (*identity, error) {
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "agent.crt"), filepath.Join(dir, "agent.key"))
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("bad ca.crt")
	}
	return &identity{cert: cert, caPool: pool}, nil
}

// pinnedTLS trusts the hub when its chain's root hashes to pin (first
// contact) or verifies against pool. Host names are not checked.
func pinnedTLS(pin string, pool *x509.CertPool, client *tls.Certificate) *tls.Config {
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // verified below: pinned private CA, no host names
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("no certificate")
			}
			leaf, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			roots := pool
			if roots == nil {
				roots = x509.NewCertPool()
				for _, r := range raw[1:] {
					sum := sha256.Sum256(r)
					if hex.EncodeToString(sum[:]) == pin {
						c, err := x509.ParseCertificate(r)
						if err != nil {
							return err
						}
						roots.AddCert(c)
					}
				}
			}
			_, err = leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
			if err != nil {
				return fmt.Errorf("hub certificate not trusted (pin %s): %w", pin, err)
			}
			return nil
		},
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			if client == nil {
				return &tls.Certificate{}, nil
			}
			return client, nil
		},
	}
}

func agentHTTPS(agentURL string) string {
	u, _ := url.Parse(agentURL)
	return "https://" + u.Host
}

func ensureIdentity(ctx context.Context, o options, api *apiClient, h *fakefleet.Host, i int) (*identity, error) {
	dir := hostDir(o, h)
	if id, err := loadIdentity(dir); err == nil {
		return id, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	var token string
	switch {
	case api != nil:
		var en struct {
			Token string `json:"token"`
		}
		if err := api.do(ctx, http.MethodPost, "/api/v1/enrollments", map[string]any{}, &en); err != nil {
			return nil, err
		}
		token = en.Token
	case i < len(o.tokens):
		token = strings.TrimSpace(o.tokens[i])
	default:
		return nil, errors.New("no enrollment token: pass --admin-user/--admin-pass or one --tokens entry per host")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: h.ID}}, key)
	if err != nil {
		return nil, err
	}
	kb, _ := x509.MarshalPKCS8PrivateKey(key)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb})
	if err := os.WriteFile(filepath.Join(dir, "agent.key"), keyPEM, 0o600); err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: pinnedTLS(o.pin, nil, nil)}}
	r := h.Report(time.Now(), 0, simVersion)
	body, _ := json.Marshal(map[string]string{
		"token": token, "csr": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})),
		"hostname": h.ID, "machine_id": r.Host.MachineID, "os": r.Host.OSPretty, "address": h.Address,
		"agent_version": o.agentVersion,
	})
	base := agentHTTPS(o.agentURL)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/agent/v1/enroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	var er struct {
		ID     string `json:"enrollment_id"`
		Secret string `json:"poll_secret"`
		Code   string `json:"code"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&er)
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return nil, fmt.Errorf("enroll: %d %s", resp.StatusCode, er.Code)
	}
	if api != nil {
		if err := api.do(ctx, http.MethodPost, "/api/v1/enrollments/"+er.ID+"/approve",
			map[string]string{"group": h.Group, "name": h.ID}, nil); err != nil {
			return nil, err
		}
		patch := map[string]any{"location": h.Location}
		if o.enableRC {
			patch["remote_control"] = map[string]bool{"console": true, "power": true, "manage": o.manage}
		}
		if err := api.do(ctx, http.MethodPatch, "/api/v1/servers/"+h.ID, patch, nil); err != nil {
			log.Warn("setting the location", "host", h.ID, "err", err)
		}
		log.Info("enrolled and approved", "host", h.ID, "enrollment", er.ID)
	} else {
		log.Info("enrollment pending: approve it in the UI", "host", h.ID, "enrollment", er.ID, "group", h.Group)
	}
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/agent/v1/enroll/"+er.ID, nil)
		req.Header.Set("Authorization", "Bearer "+er.Secret)
		resp, err := hc.Do(req)
		if err == nil {
			var pr struct {
				State string `json:"state"`
				Cert  string `json:"certificate"`
				CA    string `json:"ca"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&pr)
			resp.Body.Close()
			switch {
			case resp.StatusCode == http.StatusOK && pr.State == "approved":
				if err := os.WriteFile(filepath.Join(dir, "agent.crt"), []byte(pr.Cert), 0o600); err != nil {
					return nil, err
				}
				if err := os.WriteFile(filepath.Join(dir, "ca.crt"), []byte(pr.CA), 0o644); err != nil {
					return nil, err
				}
				return loadIdentity(dir)
			case resp.StatusCode == http.StatusForbidden:
				return nil, errors.New("enrollment rejected")
			case resp.StatusCode != http.StatusAccepted:
				return nil, fmt.Errorf("enrollment poll: %d", resp.StatusCode)
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
