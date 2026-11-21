package assist

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Options configure a runner.
type Options struct {
	// StateDir holds the CLIs, their sign-ins and session files.
	StateDir string
	// Exe is the whombat-hosts executable, which the CLIs start as their MCP
	// server ("assist mcp-bridge").
	Exe     string
	Version string
	// Sandboxed: the runner runs in its own unit (rackoon-assist@.service).
	Sandboxed bool
	Log       *slog.Logger
}

// Runner serves one hub connection.
type Runner struct {
	opts Options
	log  *slog.Logger
	peer *Peer

	mu       sync.Mutex
	busy     map[string]bool            // provider -> install / uninstall running
	signed   map[string]*ProviderStatus // provider -> cached sign-in state
	logins   map[string]*codexLogin     // provider -> device login waiting for the user
	sessions map[string]*session
}

// session is one running CLI session.
type session struct {
	id, run, provider, version string
	drv                        driver
	mcp                        *mcpServer
}

// driver runs one CLI session.
type driver interface {
	send(text string) error
	interrupt() error
	close() // ends the CLI (it exits, the session ends)
}

var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Serve runs a runner on rw until the hub disconnects; every CLI it
// started is stopped then.
func Serve(ctx context.Context, rw io.ReadWriteCloser, opts Options) error {
	if opts.Log == nil {
		opts.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	for _, d := range []string{"bin", "home", "tmp", "work", "run", "claude", "codex"} {
		if err := os.MkdirAll(filepath.Join(opts.StateDir, d), 0o700); err != nil {
			return err
		}
	}
	r := &Runner{opts: opts, log: opts.Log, busy: map[string]bool{}, signed: map[string]*ProviderStatus{},
		logins: map[string]*codexLogin{}, sessions: map[string]*session{}}
	r.peer = NewPeer(rw, r.handle, nil)
	r.peer.Start()
	select {
	case <-ctx.Done():
		r.peer.Close()
		<-r.peer.Done()
	case <-r.peer.Done():
	}
	r.closeAll()
	return nil
}

func (r *Runner) closeAll() {
	r.mu.Lock()
	var ss []*session
	for _, s := range r.sessions {
		ss = append(ss, s)
	}
	var ls []*codexLogin
	for _, l := range r.logins {
		ls = append(ls, l)
	}
	r.mu.Unlock()
	for _, s := range ss {
		s.drv.close()
	}
	for _, l := range ls {
		l.cancel()
	}
}

func (r *Runner) notify(method string, params any) {
	if r.peer != nil {
		_ = r.peer.Notify(method, params)
	}
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	if len(raw) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, Errf(CodeInvalid, "invalid parameters: %v", err)
	}
	return v, nil
}

func validProvider(p string) error {
	if p != Claude && p != Codex {
		return Errf(CodeInvalid, "unknown provider %q", p)
	}
	return nil
}

func (r *Runner) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case MStatus:
		p, err := decode[StatusParams](raw)
		if err != nil {
			return nil, err
		}
		return r.status(ctx, p.Refresh), nil
	case MLatest:
		p, err := decode[LatestParams](raw)
		if err != nil {
			return nil, err
		}
		v, err := r.Latest(ctx, p.Provider, p.Channel)
		return LatestResult{Version: v}, err
	case MInstall:
		p, err := decode[InstallParams](raw)
		if err != nil {
			return nil, err
		}
		v, err := r.Install(ctx, p)
		return InstallResult{Version: v}, err
	case MUninstall:
		p, err := decode[ProviderParams](raw)
		if err == nil {
			err = validProvider(p.Provider)
		}
		if err != nil {
			return nil, err
		}
		return struct{}{}, r.Uninstall(p.Provider)
	case MLogin:
		p, err := decode[LoginParams](raw)
		if err != nil {
			return nil, err
		}
		return r.login(ctx, p)
	case MLogout:
		p, err := decode[ProviderParams](raw)
		if err == nil {
			err = validProvider(p.Provider)
		}
		if err != nil {
			return nil, err
		}
		return struct{}{}, r.logout(ctx, p.Provider)
	case MSessionStart:
		p, err := decode[SessionStart](raw)
		if err != nil {
			return nil, err
		}
		return struct{}{}, r.startSession(p)
	case MSessionSend:
		p, err := decode[SessionSend](raw)
		if err != nil {
			return nil, err
		}
		s, err := r.session(p.Session)
		if err != nil {
			return nil, err
		}
		return struct{}{}, s.drv.send(p.Text)
	case MSessionInterrupt:
		p, err := decode[SessionRef](raw)
		if err != nil {
			return nil, err
		}
		s, err := r.session(p.Session)
		if err != nil {
			return nil, err
		}
		if p.Run != "" && p.Run != s.run {
			return struct{}{}, nil
		}
		return struct{}{}, s.drv.interrupt()
	case MSessionClose:
		p, err := decode[SessionRef](raw)
		if err != nil {
			return nil, err
		}
		if s, err := r.session(p.Session); err == nil && (p.Run == "" || p.Run == s.run) {
			s.drv.close()
		}
		return struct{}{}, nil
	}
	return nil, &RPCError{Code: ErrMethodNotFound, Message: "method not found: " + method}
}

func (r *Runner) session(id string) (*session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sessions[id]; ok {
		return s, nil
	}
	return nil, Errf(CodeNoSession, "no running session %s", id)
}

// versionsInUse are the versions of a provider that sessions run.
func (r *Runner) versionsInUse(provider string) map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]bool{}
	for _, s := range r.sessions {
		if s.provider == provider {
			out[s.version] = true
		}
	}
	return out
}

// forget drops the cached sign-in state of a provider.
func (r *Runner) forget(provider string) {
	r.mu.Lock()
	delete(r.signed, provider)
	r.mu.Unlock()
}

// status reports every provider; refresh (or an unknown state) asks the
// CLIs for their sign-in.
func (r *Runner) status(ctx context.Context, refresh bool) Status {
	st := Status{Version: r.opts.Version, Sandboxed: r.opts.Sandboxed, Providers: map[string]ProviderStatus{}}
	for _, p := range Providers {
		ps := ProviderStatus{Version: r.installedVersion(p)}
		ps.Installed = ps.Version != ""
		r.mu.Lock()
		cached := r.signed[p]
		if l := r.logins[p]; l != nil {
			res := l.result
			ps.Login = &res
		}
		r.mu.Unlock()
		if ps.Installed && (cached == nil || refresh) {
			c := r.signInState(ctx, p)
			cached = &c
			r.mu.Lock()
			r.signed[p] = cached
			r.mu.Unlock()
		}
		if cached != nil {
			ps.SignedIn, ps.Account, ps.Error = cached.SignedIn, cached.Account, cached.Error
		}
		if !ps.Installed {
			// The Claude Code token is ours and stays valid without the CLI.
			ps.SignedIn = p == Claude && r.claudeCredential() != ""
		}
		st.Providers[p] = ps
	}
	return st
}

func (r *Runner) signInState(ctx context.Context, provider string) ProviderStatus {
	switch provider {
	case Claude:
		return r.claudeSignIn()
	case Codex:
		ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		return r.codexSignIn(ctx)
	}
	return ProviderStatus{}
}

func (r *Runner) login(ctx context.Context, p LoginParams) (any, error) {
	switch p.Provider {
	case Claude:
		if err := r.claudeLogin(ctx, p.Token); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	case Codex:
		return r.codexLogin(ctx)
	}
	return nil, Errf(CodeInvalid, "unknown provider %q", p.Provider)
}

func (r *Runner) logout(ctx context.Context, provider string) error {
	r.mu.Lock()
	l := r.logins[provider]
	r.mu.Unlock()
	if l != nil {
		l.cancel()
	}
	defer r.forget(provider)
	switch provider {
	case Claude:
		err := os.Remove(r.claudeTokenPath())
		if os.IsNotExist(err) {
			err = nil
		}
		return err
	case Codex:
		return r.codexLogout(ctx)
	}
	return nil
}

// cliEnv is the environment of a CLI: a home, config and temporary
// directory in the runner's state, no self-updates.
func (r *Runner) cliEnv(provider string, extra []string) []string {
	st := r.opts.StateDir
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + filepath.Join(st, "home"),
		"TMPDIR=" + filepath.Join(st, "tmp"),
		"LANG=C.UTF-8",
		"NO_COLOR=1",
		"TERM=dumb",
	}
	switch provider {
	case Claude:
		env = append(env, "CLAUDE_CONFIG_DIR="+filepath.Join(st, "claude"), "DISABLE_UPDATES=1", "DISABLE_AUTOUPDATER=1",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_TELEMETRY=1")
		if tok := r.claudeCredential(); tok != "" {
			if strings.HasPrefix(tok, "sk-ant-api") {
				env = append(env, "ANTHROPIC_API_KEY="+tok)
			} else {
				env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+tok)
			}
		}
	case Codex:
		env = append(env, "CODEX_HOME="+filepath.Join(st, "codex"))
	}
	// A proxy or private CA the runner was given applies to the CLIs too.
	for _, k := range []string{"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy",
		"all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"} {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	env = append(env, extra...)
	if testEnv != nil {
		env = testEnv(provider, env)
	}
	return env
}

// testEnv adjusts the CLIs' environment in live tests.
var testEnv func(provider string, env []string) []string

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// startSession starts a CLI session and its MCP server.
func (r *Runner) startSession(p SessionStart) error {
	if !sessionIDRe.MatchString(p.Session) {
		return Errf(CodeInvalid, "invalid session id")
	}
	if err := validProvider(p.Provider); err != nil {
		return err
	}
	bin, err := r.requireBinary(p.Provider)
	if err != nil {
		return err
	}
	if old, err := r.session(p.Session); err == nil {
		old.drv.close()
		r.waitGone(p.Session, 10*time.Second)
	}
	work := filepath.Join(r.opts.StateDir, "work", p.Session)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	mcp, err := r.startMCP(p.Session, p.Tools)
	if err != nil {
		return err
	}
	s := &session{id: p.Session, run: p.Run, provider: p.Provider, version: r.installedVersion(p.Provider), mcp: mcp}
	emit := func(ev SessionEvent) {
		ev.Session, ev.Run = p.Session, p.Run
		r.notify(NEvent, ev)
	}
	onExit := func(err error) {
		r.mu.Lock()
		if r.sessions[p.Session] == s {
			delete(r.sessions, p.Session)
		}
		r.mu.Unlock()
		mcp.close()
		ev := SessionEvent{Kind: EvExit}
		if err != nil {
			ev.Error = err.Error()
		}
		emit(ev)
	}
	r.mu.Lock()
	r.sessions[p.Session] = s
	r.mu.Unlock()
	switch p.Provider {
	case Claude:
		s.drv, err = r.startClaude(bin, work, p, mcp, emit, onExit)
	case Codex:
		s.drv, err = r.startCodex(bin, work, p, mcp, emit, onExit)
	}
	if err != nil {
		r.mu.Lock()
		delete(r.sessions, p.Session)
		r.mu.Unlock()
		mcp.close()
		return err
	}
	return nil
}

func (r *Runner) waitGone(id string, d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if _, err := r.session(id); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// callTool relays one MCP tool call to the hub.
func (r *Runner) callTool(ctx context.Context, session, name string, args json.RawMessage) (ToolResult, error) {
	var res ToolResult
	err := r.peer.Call(ctx, MToolCall, ToolCall{Session: session, Name: name, Args: args}, &res)
	return res, err
}
