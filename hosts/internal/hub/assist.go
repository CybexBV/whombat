package hub

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/assist"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

// ---- the assistant (docs/ASSIST.md) ---------------------------------------------
//
// The hub keeps the settings, the investigations and the tools; the runner
// (internal/assist, its own sandboxed unit) runs the CLIs. One connection
// to the runner carries everything: the hub's requests (install, sign-in,
// sessions), the runner's notifications (progress, session output) and the
// runner's tool calls.

// Access levels.
const (
	accessRead = "read"
	accessAsk  = "ask"
	accessFull = "full"
)

// Investigation states.
const (
	invStarting = "starting"
	invRunning  = "running"
	invWaiting  = "waiting"
	invIdle     = "idle"
	invDone     = "done"
	invFailed   = "failed"
	invStopped  = "stopped"
)

const (
	assistMaxRunning      = 3
	assistAutoPerHour     = 6
	assistAutoAfter       = 60 * time.Second // an alert needs attention this long before an automatic investigation
	assistUpdateEvery     = 6 * time.Hour
	assistRetention       = 180 * 24 * time.Hour
	assistApprovalTTL     = 30 * time.Minute
	assistSettingsMetaKey = "assist_settings"
)

type assistSettings struct {
	Enabled         bool   `json:"enabled"`
	Provider        string `json:"provider"`
	Access          string `json:"access"`
	AutoInvestigate string `json:"auto_investigate"`
	AutoUpdate      bool   `json:"auto_update"`
	ClaudeModel     string `json:"claude_model"`
	CodexModel      string `json:"codex_model"`
	ClaudeChannel   string `json:"claude_channel"`
}

func defaultAssistSettings() assistSettings {
	return assistSettings{Provider: assist.Claude, Access: accessFull, AutoInvestigate: "off", AutoUpdate: true, ClaudeChannel: "stable"}
}

func (s *assistSettings) normalize() {
	d := defaultAssistSettings()
	if s.Provider != assist.Claude && s.Provider != assist.Codex {
		s.Provider = d.Provider
	}
	if s.Access != accessRead && s.Access != accessAsk && s.Access != accessFull {
		s.Access = d.Access
	}
	if s.AutoInvestigate != "off" && s.AutoInvestigate != rules.SevCritical && s.AutoInvestigate != "all" {
		s.AutoInvestigate = d.AutoInvestigate
	}
	if s.ClaudeChannel != "stable" && s.ClaudeChannel != "latest" {
		s.ClaudeChannel = d.ClaudeChannel
	}
}

func (s assistSettings) model(provider string) string {
	if provider == assist.Codex {
		return s.CodexModel
	}
	return s.ClaudeModel
}

type assistant struct {
	h *Hub

	connMu sync.Mutex // one connection attempt at a time
	// dial connects to the runner (tests replace it).
	dial func(ctx context.Context) (io.ReadWriteCloser, error)

	mu        sync.Mutex
	settings  assistSettings
	peer      *assist.Peer
	connErr   string
	sandboxed bool
	status    assist.Status
	statusOK  bool
	latest    map[string]string
	checkedAt map[string]time.Time
	busy      map[string]string  // provider -> installing | removing
	progress  map[string]float64 // provider -> 0..1 while downloading
	provErr   map[string]string
	invs      map[string]*liveInv
	autoAfter time.Duration        // assistAutoAfter (tests shorten it)
	autoSeen  map[string]time.Time // alert id -> first seen needing attention
	autoTried map[string]bool      // alert ids investigated automatically
	autoTimes []time.Time
}

func newAssistant(h *Hub) *assistant {
	a := &assistant{h: h, settings: defaultAssistSettings(), latest: map[string]string{}, checkedAt: map[string]time.Time{},
		busy: map[string]string{}, progress: map[string]float64{}, provErr: map[string]string{}, invs: map[string]*liveInv{},
		autoAfter: assistAutoAfter, autoSeen: map[string]time.Time{}, autoTried: map[string]bool{}}
	a.dial = a.dialRunner
	return a
}

// load reads the settings and leaves investigations of a previous run
// waiting for the user.
func (a *assistant) load(ctx context.Context) error {
	if v, ok, err := a.h.store.GetMeta(ctx, assistSettingsMetaKey); err != nil {
		return err
	} else if ok {
		s := defaultAssistSettings()
		if err := json.Unmarshal([]byte(v), &s); err == nil {
			s.normalize()
			a.settings = s
		}
	}
	ids, err := a.h.store.MarkAssistInterrupted(ctx, a.h.now())
	if err != nil {
		return err
	}
	for _, id := range ids {
		a.addEventID(ctx, id, "status", map[string]any{"state": invIdle,
			"text": "The hub restarted during this investigation. Send a message to continue."})
	}
	return nil
}

func (a *assistant) getSettings() assistSettings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}

// ---- the runner connection ---------------------------------------------------------

// dialRunner connects to rackoon-assist.socket, or starts the runner as a
// child process (development: not sandboxed).
func (a *assistant) dialRunner(ctx context.Context) (io.ReadWriteCloser, error) {
	if sock := a.h.cfg.AssistSocket; sock != "" {
		var d net.Dialer
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return d.DialContext(dctx, "unix", sock)
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	state := filepath.Join(a.h.cfg.DataDir, "assist")
	cmd := exec.Command(exe, "assist", "serve", "--state", state)
	cmd.Env = append(os.Environ(), "RACKOON_ASSIST_SANDBOX=0")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			a.h.log.Info("assistant runner: " + cleanText(sc.Text(), 500))
		}
	}()
	return &childConn{Reader: stdout, in: stdin, cmd: cmd}, nil
}

type childConn struct {
	io.Reader
	in  io.WriteCloser
	cmd *exec.Cmd
}

func (c *childConn) Write(p []byte) (int, error) { return c.in.Write(p) }
func (c *childConn) Close() error {
	err := c.in.Close()
	done := make(chan struct{})
	go func() { c.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		c.cmd.Process.Kill()
	}
	return err
}

// connect returns the runner connection, connecting when needed.
func (a *assistant) connect(ctx context.Context) (*assist.Peer, error) {
	a.mu.Lock()
	p := a.peer
	a.mu.Unlock()
	if p != nil {
		return p, nil
	}
	a.connMu.Lock()
	defer a.connMu.Unlock()
	a.mu.Lock()
	p = a.peer
	a.mu.Unlock()
	if p != nil {
		return p, nil
	}
	if a.h.closing.Load() {
		return nil, errors.New("the hub is shutting down")
	}
	rw, err := a.dial(ctx)
	if err != nil {
		a.mu.Lock()
		a.connErr = "The assistant runner is not reachable: " + err.Error()
		a.mu.Unlock()
		a.publishState()
		return nil, assist.Errf("runner_unavailable", "%s", "The assistant runner is not reachable: "+err.Error())
	}
	p = assist.NewPeer(rw, a.handleRunner, a.onRunnerNotify)
	p.Start()
	a.mu.Lock()
	a.peer, a.connErr = p, ""
	a.mu.Unlock()
	go func() {
		<-p.Done()
		a.disconnected(p)
	}()
	a.h.log.Info("assistant runner connected", "socket", a.h.cfg.AssistSocket)
	return p, nil
}

// disconnected forgets a lost runner: its sessions ended with it.
func (a *assistant) disconnected(p *assist.Peer) {
	a.mu.Lock()
	if a.peer != p {
		a.mu.Unlock()
		return
	}
	a.peer, a.statusOK = nil, false
	if !a.h.closing.Load() {
		a.connErr = "The assistant runner stopped."
	}
	var live []*liveInv
	for _, inv := range a.invs {
		live = append(live, inv)
	}
	a.mu.Unlock()
	if !a.h.closing.Load() {
		a.h.log.Warn("assistant runner disconnected", "err", p.Err())
	}
	for _, inv := range live {
		a.sessionGone(inv, "The assistant runner stopped during this investigation. Send a message to continue.")
	}
	a.publishState()
}

// call sends a request to the runner, connecting first.
func (a *assistant) call(ctx context.Context, method string, params, out any) error {
	p, err := a.connect(ctx)
	if err != nil {
		return err
	}
	err = p.Call(ctx, method, params, out)
	if errors.Is(err, assist.ErrClosed) {
		<-p.Done()
		if p, err = a.connect(ctx); err != nil {
			return err
		}
		err = p.Call(ctx, method, params, out)
	}
	return err
}

// handleRunner answers the runner's requests: tool calls.
func (a *assistant) handleRunner(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	if method != assist.MToolCall {
		return nil, &assist.RPCError{Code: assist.ErrMethodNotFound, Message: "unknown method " + method}
	}
	var tc assist.ToolCall
	if err := json.Unmarshal(raw, &tc); err != nil {
		return nil, &assist.RPCError{Code: assist.ErrInvalidParams, Message: err.Error()}
	}
	return a.toolCall(ctx, tc), nil
}

func (a *assistant) onRunnerNotify(method string, raw json.RawMessage) {
	switch method {
	case assist.NProgress:
		var p assist.Progress
		if json.Unmarshal(raw, &p) == nil && p.Total > 0 {
			a.mu.Lock()
			a.progress[p.Provider] = min(1, float64(p.Done)/float64(p.Total))
			a.mu.Unlock()
			a.publishState()
		}
	case assist.NLogin:
		var d assist.LoginDone
		if json.Unmarshal(raw, &d) != nil {
			return
		}
		a.mu.Lock()
		if d.OK {
			delete(a.provErr, d.Provider)
		} else if d.Error != "" {
			a.provErr[d.Provider] = d.Error
		}
		a.mu.Unlock()
		outcome := "ok"
		if !d.OK {
			outcome = "error"
		}
		a.h.auditSystem(context.Background(), store.AuditRecord{Event: "assistant.signed_in", Outcome: outcome,
			Details: map[string]string{"provider": d.Provider, "error": cleanText(d.Error, 300)}})
		go a.refresh(context.Background(), true)
	case assist.NEvent:
		var ev assist.SessionEvent
		if json.Unmarshal(raw, &ev) == nil {
			a.sessionEvent(ev)
		}
	}
}

// refresh asks the runner for its state and publishes it.
func (a *assistant) refresh(ctx context.Context, signIn bool) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var st assist.Status
	if err := a.call(ctx, assist.MStatus, assist.StatusParams{Refresh: signIn}, &st); err != nil {
		a.publishState()
		return err
	}
	a.mu.Lock()
	a.status, a.statusOK, a.sandboxed = st, true, st.Sandboxed
	a.mu.Unlock()
	a.publishState()
	return nil
}

// ready reports whether a provider is installed and signed in (from the
// last status).
func (a *assistant) ready(provider string) error {
	a.mu.Lock()
	ps, known := a.status.Providers[provider]
	ok := a.statusOK
	a.mu.Unlock()
	if !ok || !known {
		if err := a.refresh(context.Background(), false); err != nil {
			return err
		}
		a.mu.Lock()
		ps = a.status.Providers[provider]
		a.mu.Unlock()
	}
	name := assist.ProviderName(provider)
	switch {
	case !ps.Installed:
		return apiErr(409, "provider_not_installed", name+" is not installed: install it under Settings › Assistant.")
	case !ps.SignedIn:
		return apiErr(409, "provider_signed_out", name+" is not signed in: sign in under Settings › Assistant.")
	}
	return nil
}

// ---- state for the UI ----------------------------------------------------------------

type assistLoginJSON struct {
	VerificationURL string `json:"verification_url"`
	UserCode        string `json:"user_code"`
	ExpiresAt       string `json:"expires_at"`
}

type providerStateJSON struct {
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	Installed       bool             `json:"installed"`
	Version         *string          `json:"version"`
	Latest          *string          `json:"latest"`
	UpdateAvailable bool             `json:"update_available"`
	CheckedAt       *string          `json:"checked_at"`
	Busy            *string          `json:"busy"`
	Progress        *float64         `json:"progress"`
	SignedIn        bool             `json:"signed_in"`
	Account         *string          `json:"account"`
	Login           *assistLoginJSON `json:"login"`
	Error           *string          `json:"error"`
}

type assistantStateJSON struct {
	Settings assistSettings `json:"settings"`
	Runner   struct {
		Connected bool    `json:"connected"`
		Sandboxed bool    `json:"sandboxed"`
		Error     *string `json:"error"`
	} `json:"runner"`
	Providers map[string]providerStateJSON `json:"providers"`
	Running   int                          `json:"running"`
}

func (a *assistant) state() assistantStateJSON {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out assistantStateJSON
	out.Settings = a.settings
	out.Runner.Connected, out.Runner.Sandboxed = a.peer != nil, a.sandboxed
	out.Runner.Error = sp(a.connErr)
	out.Providers = map[string]providerStateJSON{}
	for _, p := range assist.Providers {
		ps := a.status.Providers[p]
		j := providerStateJSON{ID: p, Name: assist.ProviderName(p), Installed: ps.Installed, Version: sp(ps.Version),
			Latest: sp(a.latest[p]), SignedIn: ps.SignedIn, Account: sp(ps.Account), Busy: sp(a.busy[p])}
		j.UpdateAvailable = ps.Installed && a.latest[p] != "" && newerVersion(a.latest[p], ps.Version)
		if t, ok := a.checkedAt[p]; ok {
			s := t.UTC().Format(time.RFC3339)
			j.CheckedAt = &s
		}
		if a.busy[p] != "" {
			if v, ok := a.progress[p]; ok {
				j.Progress = &v
			}
		}
		if l := ps.Login; l != nil {
			j.Login = &assistLoginJSON{VerificationURL: l.VerificationURL, UserCode: l.UserCode, ExpiresAt: l.ExpiresAt.UTC().Format(time.RFC3339)}
		}
		e := a.provErr[p]
		if e == "" {
			e = ps.Error
		}
		j.Error = sp(e)
		out.Providers[p] = j
	}
	for _, inv := range a.invs {
		switch inv.row.State {
		case invStarting, invRunning, invWaiting:
			out.Running++
		}
	}
	return out
}

func (a *assistant) publishState() {
	a.h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "assistant.state", a.state())
}

// newerVersion reports whether dotted version a is newer than b.
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(strings.SplitN(a, "-", 2)[0], "."), strings.Split(strings.SplitN(b, "-", 2)[0], ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// ---- installs, updates, sign-in -----------------------------------------------------

// install installs (or updates to) the newest version in the background.
func (a *assistant) install(provider, user string) error {
	a.mu.Lock()
	if a.busy[provider] != "" {
		a.mu.Unlock()
		return apiErr(409, "busy", assist.ProviderName(provider)+" is already being installed.")
	}
	a.busy[provider], a.progress[provider] = "installing", 0
	delete(a.provErr, provider)
	channel := ""
	if provider == assist.Claude {
		channel = a.settings.ClaudeChannel
	}
	a.mu.Unlock()
	a.publishState()
	a.h.bg.Add(1)
	go func() {
		defer a.h.bg.Done()
		var res assist.InstallResult
		err := a.call(context.Background(), assist.MInstall, assist.InstallParams{Provider: provider, Channel: channel}, &res)
		a.mu.Lock()
		delete(a.busy, provider)
		delete(a.progress, provider)
		if err != nil {
			a.provErr[provider] = err.Error()
		} else {
			a.latest[provider], a.checkedAt[provider] = res.Version, a.h.now()
		}
		a.mu.Unlock()
		rec := store.AuditRecord{Event: "assistant.installed", Outcome: "ok", User: user,
			Details: map[string]string{"provider": provider, "version": res.Version}}
		if err != nil {
			rec.Outcome, rec.Details["error"] = "error", cleanText(err.Error(), 300)
			a.h.log.Warn("assistant: install failed", "provider", provider, "err", err)
		} else {
			a.h.log.Info("assistant: installed", "provider", provider, "version", res.Version)
		}
		a.h.auditSystem(context.Background(), rec)
		_ = a.refresh(context.Background(), true)
	}()
	return nil
}

// checkUpdates records the newest versions and installs them when
// auto-update is on.
func (a *assistant) checkUpdates(ctx context.Context) {
	if err := a.refresh(ctx, false); err != nil {
		return
	}
	s := a.getSettings()
	for _, p := range assist.Providers {
		a.mu.Lock()
		ps := a.status.Providers[p]
		busy := a.busy[p] != ""
		a.mu.Unlock()
		if !ps.Installed || busy {
			continue
		}
		var res assist.LatestResult
		channel := ""
		if p == assist.Claude {
			channel = s.ClaudeChannel
		}
		if err := a.call(ctx, assist.MLatest, assist.LatestParams{Provider: p, Channel: channel}, &res); err != nil {
			a.h.log.Info("assistant: update check failed", "provider", p, "err", err)
			continue
		}
		a.mu.Lock()
		a.latest[p], a.checkedAt[p] = res.Version, a.h.now()
		a.mu.Unlock()
		if s.AutoUpdate && newerVersion(res.Version, ps.Version) {
			a.h.log.Info("assistant: updating", "provider", p, "from", ps.Version, "to", res.Version)
			_ = a.install(p, "auto-update")
		}
	}
	a.publishState()
}

// ---- background work ------------------------------------------------------------------

// run checks for updates and starts automatic investigations until ctx
// ends.
func (a *assistant) run(ctx context.Context) {
	if a.getSettings().Enabled {
		go a.refresh(ctx, true)
	}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	nextCheck := a.h.now().Add(2 * time.Minute)
	nextPrune := a.h.now().Add(10 * time.Minute)
	for {
		select {
		case <-ctx.Done():
			a.shutdown()
			return
		case <-tick.C:
		}
		now := a.h.now()
		s := a.getSettings()
		a.mu.Lock()
		connected := a.peer != nil
		a.mu.Unlock()
		if !now.Before(nextCheck) {
			nextCheck = now.Add(assistUpdateEvery)
			if s.Enabled || connected {
				a.checkUpdates(ctx)
			}
		}
		if !now.Before(nextPrune) {
			nextPrune = now.Add(24 * time.Hour)
			if n, err := a.h.store.PruneAssistSessions(ctx, now.Add(-assistRetention)); err == nil && n > 0 {
				a.h.log.Info("assistant: old investigations deleted", "count", n)
			}
		}
		a.autoInvestigate(now)
	}
}

func (a *assistant) shutdown() {
	a.mu.Lock()
	p := a.peer
	a.mu.Unlock()
	if p != nil {
		p.Close()
	}
}

// autoInvestigate starts one investigation for an alert that has needed
// attention for a minute, when the settings ask for it.
func (a *assistant) autoInvestigate(now time.Time) {
	s := a.getSettings()
	if !s.Enabled || s.AutoInvestigate == "off" {
		return
	}
	a.mu.Lock()
	ps := a.status.Providers[s.Provider]
	ready := a.statusOK && ps.Installed && ps.SignedIn
	running := 0
	for _, inv := range a.invs {
		if inv.row.Auto && (inv.row.State == invStarting || inv.row.State == invRunning || inv.row.State == invWaiting) {
			running++
		}
	}
	var recent []time.Time
	for _, t := range a.autoTimes {
		if now.Sub(t) < time.Hour {
			recent = append(recent, t)
		}
	}
	a.autoTimes = recent
	a.mu.Unlock()
	hosts := map[string]*model.ServerState{}
	for _, st := range a.h.snapshot() {
		hosts[st.ID] = st
	}
	attention := map[string]bool{}
	var candidate *rules.Alert
	for _, al := range a.h.alerts.AllOpen() {
		if al.Server == "" || hosts[al.Server] == nil {
			continue
		}
		if s.AutoInvestigate == rules.SevCritical && al.Severity != rules.SevCritical {
			continue
		}
		if b := model.BuildAlertFor(al, hosts[al.Server], now); !b.Attention {
			continue
		}
		attention[al.ID] = true
		a.mu.Lock()
		seen, ok := a.autoSeen[al.ID]
		if !ok {
			a.autoSeen[al.ID], seen = now, now
		}
		tried := a.autoTried[al.ID]
		a.mu.Unlock()
		if !tried && now.Sub(seen) >= a.autoAfter && candidate == nil {
			c := al
			candidate = &c
		}
	}
	a.mu.Lock()
	for id := range a.autoSeen {
		if !attention[id] {
			delete(a.autoSeen, id)
		}
	}
	a.mu.Unlock()
	if candidate == nil || !ready || running > 0 || len(recent) >= assistAutoPerHour {
		return
	}
	a.mu.Lock()
	a.autoTried[candidate.ID] = true
	a.mu.Unlock()
	if prev, err := a.h.store.ListAssistSessions(context.Background(), store.AssistFilter{AlertID: candidate.ID, Limit: 1}); err == nil && len(prev) > 0 {
		return // already investigated (by hand, or before a restart)
	}
	a.mu.Lock()
	a.autoTimes = append(a.autoTimes, now)
	a.mu.Unlock()
	if _, err := a.start(context.Background(), startRequest{AlertID: candidate.ID, By: "auto", Auto: true}); err != nil {
		a.h.log.Info("assistant: automatic investigation not started", "alert", candidate.ID, "err", err)
	}
}

// ---- settings ------------------------------------------------------------------------

type assistSettingsPatch struct {
	Enabled         *bool   `json:"enabled"`
	Provider        *string `json:"provider"`
	Access          *string `json:"access"`
	AutoInvestigate *string `json:"auto_investigate"`
	AutoUpdate      *bool   `json:"auto_update"`
	ClaudeModel     *string `json:"claude_model"`
	CodexModel      *string `json:"codex_model"`
	ClaudeChannel   *string `json:"claude_channel"`
}

var modelRe = func(s string) bool {
	if len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune(".-_:[]", c)) {
			return false
		}
	}
	return true
}

// apply validates a patch and returns the new settings and what changed.
func (a *assistant) apply(p assistSettingsPatch) (assistSettings, []string, error) {
	s := a.getSettings()
	var changed []string
	set := func(name string, ok bool) {
		if ok {
			changed = append(changed, name)
		}
	}
	if p.Enabled != nil {
		set("enabled", s.Enabled != *p.Enabled)
		s.Enabled = *p.Enabled
	}
	if p.Provider != nil {
		if *p.Provider != assist.Claude && *p.Provider != assist.Codex {
			return s, nil, apiErr(400, "invalid_provider", "provider must be claude or codex.")
		}
		set("provider", s.Provider != *p.Provider)
		s.Provider = *p.Provider
	}
	if p.Access != nil {
		if *p.Access != accessRead && *p.Access != accessAsk && *p.Access != accessFull {
			return s, nil, apiErr(400, "invalid_access", "access must be read, ask or full.")
		}
		set("access", s.Access != *p.Access)
		s.Access = *p.Access
	}
	if p.AutoInvestigate != nil {
		v := *p.AutoInvestigate
		if v != "off" && v != rules.SevCritical && v != "all" {
			return s, nil, apiErr(400, "invalid_auto_investigate", "auto_investigate must be off, critical or all.")
		}
		set("auto_investigate", s.AutoInvestigate != v)
		s.AutoInvestigate = v
	}
	if p.AutoUpdate != nil {
		set("auto_update", s.AutoUpdate != *p.AutoUpdate)
		s.AutoUpdate = *p.AutoUpdate
	}
	for _, m := range []struct {
		name string
		in   *string
		dst  *string
	}{{"claude_model", p.ClaudeModel, &s.ClaudeModel}, {"codex_model", p.CodexModel, &s.CodexModel}} {
		if m.in == nil {
			continue
		}
		v := strings.TrimSpace(*m.in)
		if !modelRe(v) {
			return s, nil, apiErr(400, "invalid_model", "A model is a name such as opus, sonnet or gpt-5-codex.")
		}
		set(m.name, *m.dst != v)
		*m.dst = v
	}
	if p.ClaudeChannel != nil {
		if *p.ClaudeChannel != "stable" && *p.ClaudeChannel != "latest" {
			return s, nil, apiErr(400, "invalid_channel", "claude_channel must be stable or latest.")
		}
		set("claude_channel", s.ClaudeChannel != *p.ClaudeChannel)
		s.ClaudeChannel = *p.ClaudeChannel
	}
	return s, changed, nil
}

func (a *assistant) saveSettings(ctx context.Context, s assistSettings) error {
	b, _ := json.Marshal(s)
	if err := a.h.store.SetMeta(ctx, assistSettingsMetaKey, string(b)); err != nil {
		return err
	}
	a.mu.Lock()
	was := a.settings.Enabled
	a.settings = s
	a.mu.Unlock()
	if was && !s.Enabled {
		a.stopAll("The assistant was turned off.")
	}
	if s.Enabled && !was {
		go a.refresh(context.Background(), true)
	}
	a.publishState()
	return nil
}

func fmtList(l []string) string { return strings.Join(l, ", ") }
