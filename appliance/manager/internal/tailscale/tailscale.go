// Package tailscale drives the box's tailscaled for the runtime (contracts 1.0.0 CT-1253…CT-1255; Whombat HE-51;
// MG-130…MG-134). The manager is tailscaled's operator and the only caller of its local API (the image's
// /run/tailscale is 0750 root:whombat-manager, NX-441): the runtime asks the manager's socket for Tailscale's state,
// to turn it on or off, for a fresh login link and for the certificate of the box's Tailscale name, which its direct
// listener serves HTTPS with. The certificate's key is a secret: no log line, error or state carries it.
package tailscale

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// SocketDefault is tailscaled's local API in the image (the upstream unit's --socket; nix/modules/tailscale.nix).
const SocketDefault = "/run/tailscale/tailscaled.sock"

// localAPIHost is the Host header tailscaled's local API accepts (tailscale.com/client/tailscale/apitype.LocalAPIHost).
const localAPIHost = "local-tailscaled.sock"

var (
	// ErrBusy: another change is running (409 tailscale.busy).
	ErrBusy = errors.New("a Tailscale change is already running")
	// ErrOff: Tailscale isn't on, so there is no name to have a certificate for (409 tailscale.off).
	ErrOff = errors.New("Tailscale is not on")
	// ErrNoHTTPS: the tailnet has HTTPS certificates off (409 tailscale.no_https).
	ErrNoHTTPS = errors.New("the tailnet has HTTPS certificates turned off")
	// ErrUnavailable: tailscaled didn't answer, or refused (503 unavailable).
	ErrUnavailable = errors.New("Tailscale didn't answer")
	// ErrLoginServer: not a coordination server's address the contract takes (400 bad_request; TailscaleLoginServer).
	ErrLoginServer = errors.New("not a login server address")
)

// Manager talks to tailscaled. The zero value isn't usable: use New.
type Manager struct {
	socket string
	log    *slog.Logger
	http   *http.Client
	// certHTTP has a longer deadline: the first certificate for a name is issued by Let's Encrypt through Tailscale.
	certHTTP *http.Client
	// settle bounds how long a change waits for tailscaled's next state (a login link, or running), and poll how often it
	// looks; the answer is the state at the end either way.
	settle, poll time.Duration

	mu sync.Mutex
	// keepFailedAt: when putting kept back last failed (State tries again after keepRetry, not on every read).
	keepFailedAt time.Time
	// linkAskedAt: when State last asked for a login link nobody had asked for (linkRetry).
	linkAskedAt time.Time
	// linkGrace: how long tailscaled must want a sign-in with no link before State asks for one.
	linkGrace time.Duration

	// wantFile keeps Tailscale wanted on until its first sign-in (wanted); "" keeps nothing. wantMu guards writing it,
	// resumedAt (when State last turned Tailscale on again, linkRetry) and noLinkSince (when State first saw tailscaled
	// wanting a sign-in with no link; zero: not now).
	wantFile    string
	wantMu      sync.Mutex
	resumedAt   time.Time
	noLinkSince time.Time
}

// keepRetry: how long State waits after a failed try to put kept back.
const keepRetry = 10 * time.Minute

// linkRetry: how long State waits before it asks for a missing login link again.
const linkRetry = time.Minute

// linkGrace: how long tailscaled must want a sign-in without a link before State asks for one. Right after a sign-in it
// is in that state for a moment (registered, no map yet), and a link asked for then starts a new sign-in and throws the
// one just made away.
const linkGrace = 10 * time.Second

// Config of a Manager.
type Config struct {
	// Socket is tailscaled's local API; empty: SocketDefault.
	Socket string
	Log    *slog.Logger
	// Settle: how long on and sign-in wait for a login link or for running (default 3 s); Poll: how often (250 ms).
	Settle, Poll time.Duration
	// WantFile is where the manager keeps Tailscale wanted on, and its login server, until the first sign-in (wanted).
	// Empty: nowhere (a restart before the sign-in leaves Tailscale off).
	WantFile string
}

// New returns a Manager for tailscaled at cfg.Socket.
func New(cfg Config) *Manager {
	socket := cfg.Socket
	if socket == "" {
		socket = SocketDefault
	}
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}
	m := &Manager{socket: socket, log: log, settle: cfg.Settle, poll: cfg.Poll, wantFile: cfg.WantFile, linkGrace: linkGrace}
	if m.settle == 0 {
		m.settle = 3 * time.Second
	}
	if m.poll == 0 {
		m.poll = 250 * time.Millisecond
	}
	m.http = &http.Client{Transport: &http.Transport{DialContext: dial, DisableKeepAlives: true}, Timeout: 15 * time.Second}
	m.certHTTP = &http.Client{Transport: &http.Transport{DialContext: dial, DisableKeepAlives: true}, Timeout: 3 * time.Minute}
	return m
}

// rawStatus is the part of tailscaled's ipnstate.Status the manager reads.
type rawStatus struct {
	BackendState string
	// HaveNodeKey: the profile has a node key, which tailscaled keeps only once the box signed in.
	HaveNodeKey  bool
	AuthURL      string
	TailscaleIPs []string
	Self         *struct {
		DNSName      string
		TailscaleIPs []string
	}
	CurrentTailnet *struct {
		Name string
	}
	CertDomains []string
}

// rawPrefs is the part of tailscaled's ipn.Prefs the manager reads.
type rawPrefs struct {
	WantRunning bool
	LoggedOut   bool
	// ControlURL is the coordination server the box signs in to ("" or DefaultControlURL: Tailscale's own; CT-1306).
	ControlURL string
	// What the box keeps (kept, MG-138).
	ExitNodeID      string
	ExitNodeIP      string
	AdvertiseRoutes []string
	RunSSH          bool
	RunWebClient    bool
	ShieldsUp       bool
	RouteAll        bool
}

// kept are the prefs the box always has, whoever set others (MG-138, MG-140; tailscale.com/ipn.MaskedPrefs): the
// tailnet's routes accepted, so what its subnet routers share is reachable (the box's own networks still come first,
// NX-487); no exit node,
// so the box's own traffic (the relay, its updates) never leaves through another device; nothing advertised, so the
// box is no subnet router or exit node for the tailnet; no Tailscale SSH or web client, so the direct port stays the
// only way in from the tailnet; and shields down, so it answers there. The tailnet's DNS is the tailnet's.
var kept = map[string]any{
	"ExitNodeID": "", "ExitNodeIDSet": true,
	"ExitNodeIP": "", "ExitNodeIPSet": true,
	"AdvertiseRoutes": []string{}, "AdvertiseRoutesSet": true,
	"RunSSH": false, "RunSSHSet": true,
	"RunWebClient": false, "RunWebClientSet": true,
	"ShieldsUp": false, "ShieldsUpSet": true,
	"RouteAll": true, "RouteAllSet": true,
}

// keeps reports whether p already has what kept sets.
func (p *rawPrefs) keeps() bool {
	return p.ExitNodeID == "" && p.ExitNodeIP == "" && len(p.AdvertiseRoutes) == 0 && !p.RunSSH && !p.RunWebClient &&
		!p.ShieldsUp && p.RouteAll
}

// withKept is the masked prefs m with kept's added.
func withKept(m map[string]bool) map[string]any {
	out := make(map[string]any, len(m)+len(kept))
	for k, v := range kept {
		out[k] = v
	}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// DefaultControlURL is Tailscale's own coordination server (tailscale.com/ipn.DefaultControlURL).
const DefaultControlURL = "https://controlplane.tailscale.com"

// ownServers are the addresses of Tailscale's own coordination server: the current one and the one before it.
var ownServers = map[string]bool{"": true, DefaultControlURL: true, "https://login.tailscale.com": true}

// apiError is an answer of tailscaled other than 2xx.
type apiError struct {
	status int
	body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("tailscaled: HTTP %d: %s", e.status, e.body) }

// notRunning reports whether err means nothing answers on the socket (no socket, or nobody listening).
func notRunning(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}

func (m *Manager) call(ctx context.Context, c *http.Client, method, path string, body any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+localAPIHost+"/localapi/v0/"+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(b))}
	}
	return b, nil
}

func (m *Manager) read(ctx context.Context) (*rawStatus, *rawPrefs, error) {
	st, p, _, err := m.readAll(ctx)
	return st, p, err
}

// readAll is read with tailscaled's whole prefs as it sent them (start takes them back with the server changed).
func (m *Manager) readAll(ctx context.Context) (*rawStatus, *rawPrefs, map[string]any, error) {
	b, err := m.call(ctx, m.http, http.MethodGet, "status?peers=false", nil)
	if err != nil {
		return nil, nil, nil, err
	}
	var st rawStatus
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, nil, nil, fmt.Errorf("tailscaled status: %w", err)
	}
	b, err = m.call(ctx, m.http, http.MethodGet, "prefs", nil)
	if err != nil {
		return nil, nil, nil, err
	}
	var p rawPrefs
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, nil, nil, fmt.Errorf("tailscaled prefs: %w", err)
	}
	var all map[string]any
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, nil, nil, fmt.Errorf("tailscaled prefs: %w", err)
	}
	return &st, &p, all, nil
}

// State is Tailscale as `host.tailscale` shows it. It never fails: a tailscaled that doesn't answer is
// `error`/`not_running`, any other failure `error`/`failed` (logged).
func (m *Manager) State(ctx context.Context) protocol.TailscaleStatus {
	st, p, err := m.read(ctx)
	if err != nil {
		if notRunning(err) {
			return problem(protocol.TailscaleProblemNotRunning)
		}
		m.log.Warn("tailscale: state", "err", err)
		return problem(protocol.TailscaleProblemFailed)
	}
	if st.BackendState == "Running" && !p.keeps() {
		m.keep(ctx)
	}
	if st.BackendState == "NeedsLogin" && p.WantRunning && st.AuthURL == "" {
		m.askLink(ctx)
	} else {
		m.wantMu.Lock()
		m.noLinkSince = time.Time{}
		m.wantMu.Unlock()
	}
	if st.BackendState == "Running" {
		m.signedIn(ctx)
	} else if w, found := m.readWanted(); found && w.On && !p.WantRunning {
		m.resume(w)
	}
	return statusOf(st, p)
}

// wanted is the want file: Tailscale is wanted on (by on or sign-in) and hasn't been on since, with the login server it
// was wanted with. tailscaled keeps both only for a profile that has signed in, so a box restarted before its first
// sign-in comes back off, on Tailscale's own server, and shows no sign-in link: the manager keeps them itself until
// then and turns Tailscale on again (Resume at its start, State when tailscaled restarted alone).
type wanted struct {
	V           int    `json:"v"`
	On          bool   `json:"on"`
	LoginServer string `json:"loginServer,omitempty"`
}

// readWanted is the want file; found is false without one (a box from before it, or none configured) or when it is
// unreadable (logged).
func (m *Manager) readWanted() (w wanted, found bool) {
	if m.wantFile == "" {
		return wanted{}, false
	}
	b, err := os.ReadFile(m.wantFile)
	if errors.Is(err, os.ErrNotExist) {
		return wanted{}, false
	}
	if err == nil {
		err = json.Unmarshal(b, &w)
	}
	if err != nil || w.V != 1 {
		m.log.Warn("tailscale: the want file is unreadable", "file", m.wantFile, "err", err, "v", w.V)
		return wanted{}, false
	}
	return w, true
}

// setWanted writes the want file when it changes. Not secret: 0644, so a root-run whombat-manager leaves one the
// manager still reads.
func (m *Manager) setWanted(w wanted) {
	if m.wantFile == "" {
		return
	}
	w.V = 1
	m.wantMu.Lock()
	defer m.wantMu.Unlock()
	if old, found := m.readWanted(); found && old == w {
		return
	}
	b, err := json.Marshal(w)
	if err == nil {
		err = atomicfile.WriteFile(m.wantFile, append(b, '\n'), 0o644)
	}
	if err != nil {
		m.log.Warn("tailscale: the want file wasn't written", "file", m.wantFile, "err", err)
	}
}

// signedIn: tailscaled is on; once it has saved the profile (it has an id), it keeps on and the login server itself
// from now on. Running comes a moment before the profile is saved: until then the want stays.
func (m *Manager) signedIn(ctx context.Context) {
	w, found := m.readWanted()
	if !found || !w.On {
		return
	}
	b, err := m.call(ctx, m.http, http.MethodGet, "profiles/current", nil)
	if err != nil {
		m.log.Warn("tailscale: the current profile", "err", err)
		return
	}
	var profile struct{ ID string }
	if err := json.Unmarshal(b, &profile); err != nil || profile.ID == "" {
		return
	}
	m.setWanted(wanted{})
	m.log.Info("tailscale: signed in, tailscaled keeps it on from now on")
}

// resume turns Tailscale on again when it is wanted on but tailscaled isn't (it restarted before the first sign-in): in
// the background, at most once every linkRetry; a change running meanwhile answers busy and the next read tries again.
func (m *Manager) resume(w wanted) {
	m.wantMu.Lock()
	if time.Since(m.resumedAt) < linkRetry {
		m.wantMu.Unlock()
		return
	}
	m.resumedAt = time.Now()
	m.wantMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := m.On(ctx, w.LoginServer); err != nil {
			m.log.Info("tailscale: not on again yet", "err", err)
			return
		}
		m.log.Info("tailscale: on again until its first sign-in", "loginServer", w.LoginServer != "")
	}()
}

// Resume turns Tailscale on again at the manager's start while it waits for its first sign-in, and answers whether it
// did. A box from before the want file has none: reach is then the login server of the owner's reach choice when that
// wants Tailscale (nil when it doesn't), taken when tailscaled never signed in (no node key). An error means tailscaled
// didn't answer or was busy: try again.
func (m *Manager) Resume(ctx context.Context, reach *string) (bool, error) {
	w, found := m.readWanted()
	if !found {
		if reach == nil || m.wantFile == "" {
			return false, nil
		}
		st, _, err := m.read(ctx)
		if err != nil {
			return false, err
		}
		if st.HaveNodeKey || st.BackendState == "Running" {
			// It signed in before: tailscaled keeps what was chosen since, on or off.
			m.setWanted(wanted{})
			return false, nil
		}
		w = wanted{On: true, LoginServer: *reach}
	}
	if !w.On {
		return false, nil
	}
	if _, err := m.On(ctx, w.LoginServer); err != nil {
		return false, err
	}
	return true, nil
}

// askLink asks tailscaled for a login link when it needs a sign-in and nobody asked for one (MG-139): its key ran out,
// or the box was removed from the tailnet. Without it the person would see Starting and no Sign in. The link shows in
// a later read: once that state has lasted linkGrace, at most once every linkRetry, never while a change runs.
func (m *Manager) askLink(ctx context.Context) {
	now := time.Now()
	m.wantMu.Lock()
	if m.noLinkSince.IsZero() {
		m.noLinkSince = now
	}
	waited := now.Sub(m.noLinkSince)
	m.wantMu.Unlock()
	if waited < m.linkGrace {
		return
	}
	if !m.mu.TryLock() {
		return
	}
	defer m.mu.Unlock()
	if time.Since(m.linkAskedAt) < linkRetry {
		return
	}
	m.linkAskedAt = time.Now()
	if _, err := m.call(ctx, m.http, http.MethodPost, "login-interactive", nil); err != nil {
		m.log.Warn("tailscale: a login link", "err", err)
		return
	}
	m.log.Info("tailscale: signed out by the tailnet, a login link asked for")
}

// keep puts kept back on a box that is on without it (one signed in before the manager kept it, or changed by root
// since): once per read, never while a change runs, and not again for keepRetry after a failure.
func (m *Manager) keep(ctx context.Context) {
	if !m.mu.TryLock() {
		return
	}
	defer m.mu.Unlock()
	if time.Since(m.keepFailedAt) < keepRetry {
		return
	}
	if _, err := m.call(ctx, m.http, http.MethodPatch, "prefs", kept); err != nil {
		m.keepFailedAt = time.Now()
		m.log.Warn("tailscale: keep its settings", "err", err)
		return
	}
	m.log.Info("tailscale: settings kept")
}

// change runs f with the change lock (ErrBusy when another change runs), then answers the state once it settled.
func (m *Manager) change(ctx context.Context, what string, f func() error, settled func(protocol.TailscaleStatus) bool) (protocol.TailscaleStatus, error) {
	if !m.mu.TryLock() {
		return protocol.TailscaleStatus{}, ErrBusy
	}
	defer m.mu.Unlock()
	if err := f(); err != nil {
		m.log.Warn("tailscale: "+what, "err", err)
		return protocol.TailscaleStatus{}, ErrUnavailable
	}
	m.log.Info("tailscale: " + what)
	deadline := time.Now().Add(m.settle)
	for {
		s := m.State(ctx)
		if settled == nil || settled(s) || !time.Now().Before(deadline) {
			return s, nil
		}
		select {
		case <-ctx.Done():
			return s, nil
		case <-time.After(m.poll):
		}
	}
}

// running is Tailscale wanted on and not logged out (tailscale.com/ipn.MaskedPrefs).
var running = map[string]bool{"WantRunning": true, "WantRunningSet": true, "LoggedOut": false, "LoggedOutSet": true}

// beyondStarting: the state a change waits for (a login link, an approval, on, or a problem).
func beyondStarting(s protocol.TailscaleStatus) bool {
	return s.State != protocol.TailscaleStateStarting
}

// On turns Tailscale on with the coordination server loginServer ("" for Tailscale's own; contracts 1.1.0 CT-1306,
// MG-135): it comes back signed in as it was, or asks for a sign-in (the server's login link, which may follow in
// State). Another server than the one the box is set to starts tailscaled again on that one with a fresh sign-in, so
// the box leaves the tailnet it was in; tailscaled keeps the server in its prefs on /persist across restarts.
// tailscaled's own logout isn't used for that: it deletes the profile, and with it the operator, so the manager could
// change nothing more until tailscaled restarted.
func (m *Manager) On(ctx context.Context, loginServer string) (protocol.TailscaleStatus, error) {
	if loginServer != "" && !validLoginServer(loginServer) {
		return protocol.TailscaleStatus{}, ErrLoginServer
	}
	// Kept before tailscaled is asked: a restart before it answers still finds Tailscale wanted.
	m.setWanted(wanted{On: true, LoginServer: loginServer})
	what := "on"
	if loginServer != "" {
		what = "on with login server " + loginServer
	}
	return m.change(ctx, what, func() error {
		_, p, all, err := m.readAll(ctx)
		if err != nil {
			return err
		}
		if serverOf(p.ControlURL) != loginServer {
			want := loginServer
			if want == "" {
				want = DefaultControlURL
			}
			all["ControlURL"], all["WantRunning"], all["LoggedOut"] = want, true, false
			for k, v := range kept {
				if !strings.HasSuffix(k, "Set") {
					all[k] = v
				}
			}
			if _, err := m.call(ctx, m.http, http.MethodPost, "start", map[string]any{"UpdatePrefs": all}); err != nil {
				return err
			}
			_, err = m.call(ctx, m.http, http.MethodPost, "login-interactive", nil)
			return err
		}
		if _, err := m.call(ctx, m.http, http.MethodPatch, "prefs", withKept(running)); err != nil {
			return err
		}
		st, _, err := m.read(ctx)
		if err != nil {
			return err
		}
		if st.BackendState == "NeedsLogin" && st.AuthURL == "" {
			_, err = m.call(ctx, m.http, http.MethodPost, "login-interactive", nil)
		}
		return err
	}, beyondStarting)
}

// SignIn asks Tailscale for a fresh login link (sign in again, or as someone else), turning it on if it was off.
func (m *Manager) SignIn(ctx context.Context) (protocol.TailscaleStatus, error) {
	return m.change(ctx, "sign-in", func() error {
		_, p, err := m.read(ctx)
		if err != nil {
			return err
		}
		m.setWanted(wanted{On: true, LoginServer: serverOf(p.ControlURL)})
		if _, err := m.call(ctx, m.http, http.MethodPatch, "prefs", withKept(running)); err != nil {
			return err
		}
		_, err = m.call(ctx, m.http, http.MethodPost, "login-interactive", nil)
		return err
	}, beyondStarting)
}

// rawPeer is the part of tailscaled's ipnstate.PeerStatus Peers reads.
type rawPeer struct {
	DNSName        string
	OS             string
	TailscaleIPs   []string
	Online         bool
	LastSeen       time.Time
	PrimaryRoutes  []string
	ExitNodeOption bool
	// Location is set for Mullvad's exit nodes (a tailnet with the add-on has hundreds): not the person's devices.
	Location *struct{}
}

// Peers are the tailnet's other devices for the agent (contracts 3.11 CT-1635, MG-140; Whombat TN-06): online first,
// then by name, at most TAILSCALE_PEERS_MAX; none unless Tailscale is on. ErrUnavailable when tailscaled didn't answer.
func (m *Manager) Peers(ctx context.Context) ([]local.TailscalePeer, error) {
	b, err := m.call(ctx, m.http, http.MethodGet, "status", nil)
	if err != nil {
		m.log.Warn("tailscale: peers", "err", err)
		return nil, ErrUnavailable
	}
	var st struct {
		BackendState string
		Peer         map[string]rawPeer
	}
	if err := json.Unmarshal(b, &st); err != nil {
		m.log.Warn("tailscale: peers", "err", err)
		return nil, ErrUnavailable
	}
	out := []local.TailscalePeer{}
	if st.BackendState != "Running" {
		return out, nil
	}
	for _, p := range st.Peer {
		if p.Location != nil {
			continue
		}
		out = append(out, peerOf(p))
	}
	slices.SortFunc(out, func(a, b local.TailscalePeer) int {
		if a.Online != b.Online {
			if a.Online {
				return -1
			}
			return 1
		}
		an, bn := "", ""
		if a.Name != nil {
			an = *a.Name
		}
		if b.Name != nil {
			bn = *b.Name
		}
		return strings.Compare(an, bn)
	})
	if len(out) > peersMax {
		out = out[:peersMax]
	}
	return out, nil
}

// peersMax is the contract's TAILSCALE_PEERS_MAX.
const peersMax = 500

// peerOf maps one device to the contract: what the contract can't take is left out (a name it refuses is null).
func peerOf(p rawPeer) local.TailscalePeer {
	peer := local.TailscalePeer{Addresses: addresses(p.TailscaleIPs), Online: p.Online, Routes: []string{},
		ExitNode: p.ExitNodeOption, Os: text(p.OS, 32)}
	if n, ok := tailscaleName(p.DNSName); ok {
		peer.Name = &n
	}
	if !p.Online && !p.LastSeen.IsZero() && p.LastSeen.Year() > 2000 {
		at := p.LastSeen.UTC().Format(time.RFC3339)
		peer.LastSeen = &at
	}
	for _, r := range p.PrimaryRoutes {
		if pfx, err := netip.ParsePrefix(r); err == nil && len(peer.Routes) < 64 {
			peer.Routes = append(peer.Routes, pfx.Masked().String())
		}
	}
	return peer
}

// Off turns Tailscale off; signOut also signs the box out of the tailnet (it needs a new sign-in to come back).
func (m *Manager) Off(ctx context.Context, signOut bool) (protocol.TailscaleStatus, error) {
	what := "off"
	if signOut {
		what = "off and signed out"
	}
	return m.change(ctx, what, func() error {
		if _, err := m.call(ctx, m.http, http.MethodPatch, "prefs", map[string]bool{"WantRunning": false, "WantRunningSet": true}); err != nil {
			return err
		}
		m.setWanted(wanted{})
		if signOut {
			_, err := m.call(ctx, m.http, http.MethodPost, "logout", nil)
			return err
		}
		return nil
	}, nil)
}

// Cert is the certificate chain and key for the box's Tailscale name (`tailscale cert`), issued or renewed by
// tailscaled as needed. ErrOff unless Tailscale is on; ErrNoHTTPS when the tailnet has certificates off.
func (m *Manager) Cert(ctx context.Context) (*local.TailscaleCertResponse, error) {
	st, p, err := m.read(ctx)
	if err != nil {
		m.log.Warn("tailscale: cert", "err", err)
		return nil, ErrUnavailable
	}
	s := statusOf(st, p)
	if s.State != protocol.TailscaleStateOn || s.Name == nil {
		return nil, ErrOff
	}
	if !s.Https {
		return nil, ErrNoHTTPS
	}
	name := *s.Name
	b, err := m.call(ctx, m.certHTTP, http.MethodGet, "cert/"+url.PathEscape(name)+"?type=pair", nil)
	if err != nil {
		// tailscaled's message may name the domain, never the key; it answers 500 for every failure.
		m.log.Warn("tailscale: cert", "name", name, "err", err)
		return nil, ErrUnavailable
	}
	resp, err := certResponse(name, b)
	if err != nil {
		m.log.Warn("tailscale: cert", "name", name, "err", err)
		return nil, ErrUnavailable
	}
	return resp, nil
}

// certResponse splits tailscaled's `type=pair` answer (the key's PEM, then the chain's) and reads the leaf's end.
func certResponse(name string, pair []byte) (*local.TailscaleCertResponse, error) {
	var keyPEM, certPEM []byte
	var leaf *x509.Certificate
	rest := pair
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		enc := pem.EncodeToMemory(blk)
		switch {
		case blk.Type == "CERTIFICATE":
			if leaf == nil {
				c, err := x509.ParseCertificate(blk.Bytes)
				if err != nil {
					return nil, fmt.Errorf("the certificate doesn't parse: %w", err)
				}
				leaf = c
			}
			certPEM = append(certPEM, enc...)
		case strings.HasSuffix(blk.Type, "PRIVATE KEY") && keyPEM == nil:
			keyPEM = enc
		default:
			return nil, fmt.Errorf("unexpected PEM block %q", blk.Type)
		}
	}
	if leaf == nil || keyPEM == nil {
		return nil, errors.New("no certificate and key in tailscaled's answer")
	}
	if err := leaf.VerifyHostname(name); err != nil {
		return nil, fmt.Errorf("the certificate isn't for %s", name)
	}
	resp := &local.TailscaleCertResponse{V: 1, Name: name, CertPem: string(certPEM), KeyPem: string(keyPEM),
		NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339)}
	if err := resp.Validate(); err != nil {
		return nil, fmt.Errorf("the certificate breaks its contract: %w", err)
	}
	return resp, nil
}

// statusOf maps tailscaled's status and prefs to the contract's TailscaleStatus (CT-1253).
func statusOf(st *rawStatus, p *rawPrefs) protocol.TailscaleStatus {
	s := statusOfBackend(st, p)
	if p != nil && s.State != protocol.TailscaleStateError {
		if srv := serverOf(p.ControlURL); srv != "" {
			s.LoginServer = &srv
		}
	}
	return s
}

func statusOfBackend(st *rawStatus, p *rawPrefs) protocol.TailscaleStatus {
	s := protocol.TailscaleStatus{Addresses: []string{}}
	want := p != nil && p.WantRunning
	switch st.BackendState {
	case "Running":
		var dns string
		ips := st.TailscaleIPs
		if st.Self != nil {
			dns = st.Self.DNSName
			if len(st.Self.TailscaleIPs) > 0 {
				ips = st.Self.TailscaleIPs
			}
		}
		name, ok := tailscaleName(dns)
		if !ok {
			return problem(protocol.TailscaleProblemFailed)
		}
		s.State, s.Name = protocol.TailscaleStateOn, &name
		s.Addresses = addresses(ips)
		if st.CurrentTailnet != nil {
			s.Tailnet = text(st.CurrentTailnet.Name, 120)
		}
		s.Https = slices.ContainsFunc(st.CertDomains, func(d string) bool { return strings.EqualFold(d, name) })
	case "NeedsMachineAuth":
		s.State = protocol.TailscaleStateNeedsApproval
	case "NeedsLogin":
		// Turned off with a link still pending is off: the link is the next sign-in's (MG-139).
		if u, ok := loginURL(st.AuthURL); ok && want {
			s.State, s.LoginURL = protocol.TailscaleStateNeedsSignIn, &u
		} else if want {
			s.State = protocol.TailscaleStateStarting
		} else {
			s.State = protocol.TailscaleStateOff
		}
	case "NoState", "Starting":
		if want {
			s.State = protocol.TailscaleStateStarting
		} else {
			s.State = protocol.TailscaleStateOff
		}
	case "Stopped":
		s.State = protocol.TailscaleStateOff
	default:
		return problem(protocol.TailscaleProblemFailed)
	}
	return s
}

func problem(p protocol.TailscaleProblem) protocol.TailscaleStatus {
	return protocol.TailscaleStatus{State: protocol.TailscaleStateError, Addresses: []string{}, Problem: &p}
}

var (
	nameRe  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
	loginRe = regexp.MustCompile(`^https?://[\x21-\x7e]+$`)
	// serverRe is the contract's TailscaleLoginServer (normalized: lower-case host, no trailing slash).
	serverRe = regexp.MustCompile(`^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$`)
)

// validLoginServer: an address the contract's TailscaleLoginServer takes.
func validLoginServer(u string) bool { return len(u) <= 300 && serverRe.MatchString(u) }

// serverOf is the coordination server tailscaled is set to as the contract names it: "" for Tailscale's own (or an
// address the contract can't carry, which only someone with root on the box could have set).
func serverOf(controlURL string) string {
	u := strings.TrimSuffix(controlURL, "/")
	if ownServers[u] || !validLoginServer(u) {
		return ""
	}
	return u
}

// tailscaleName is the box's MagicDNS name without its trailing dot, lower-case (TailscaleName).
func tailscaleName(dns string) (string, bool) {
	n := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(dns), "."))
	return n, len(n) >= 3 && len(n) <= 253 && nameRe.MatchString(n)
}

// loginURL is tailscaled's AuthURL when it is a link the contract takes (TailscaleLoginUrl: https, or http for a
// coordination server of the owner's own on their network, CT-1306).
func loginURL(u string) (string, bool) {
	return u, len(u) >= 12 && len(u) <= 500 && loginRe.MatchString(u)
}

// addresses are the valid IP addresses of ips, IPv4 first, at most four (TAILSCALE_ADDRESSES_MAX).
func addresses(ips []string) []string {
	var v4, v6 []string
	for _, ip := range ips {
		a, err := netip.ParseAddr(ip)
		if err != nil || a.Zone() != "" {
			continue
		}
		if a.Is4() {
			v4 = append(v4, a.String())
		} else {
			v6 = append(v6, a.String())
		}
	}
	out := append(v4, v6...)
	if len(out) > 4 {
		out = out[:4]
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// text is s without control, format or separator characters other than a space, trimmed, at most max runes; nil
// when nothing is left (the contract's host text).
func text(s string, max int) *string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if r != ' ' && (unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Z) || r == unicode.ReplacementChar) {
			continue
		}
		if n == max {
			break
		}
		b.WriteRune(r)
		n++
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return nil
	}
	return &out
}

// Valid is what the schema can't say about a TailscaleStatus (contracts tailscaleStatusValid, CT-1253).
func Valid(s protocol.TailscaleStatus) bool {
	if s.State != protocol.TailscaleStateNeedsSignIn && s.LoginURL != nil {
		return false
	}
	if (s.State == protocol.TailscaleStateOn) != (s.Name != nil) {
		return false
	}
	if s.State != protocol.TailscaleStateOn && (len(s.Addresses) > 0 || s.Tailnet != nil || s.Https) {
		return false
	}
	return (s.State == protocol.TailscaleStateError) == (s.Problem != nil)
}
