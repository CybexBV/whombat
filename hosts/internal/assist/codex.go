package assist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Codex runs as `codex app-server` (JSON-RPC over stdio): one app-server
// per investigation (its MCP server differs per session), another short
// one for sign-in state and the device login.

// codexFeaturesOff are Codex's own tools Rackoon turns off: the AI works
// through Rackoon's tools only (no shell or browser on the runner's host).
var codexFeaturesOff = []string{"shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "image_generation"}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// codexArgs are the app-server's configuration overrides (-c); mcp is the
// session's MCP server (nil: none).
func (r *Runner) codexArgs(mcp *mcpServer) []string {
	var args []string
	for _, f := range codexFeaturesOff {
		args = append(args, "-c", "features."+f+"=false")
	}
	args = append(args, "-c", "check_for_update_on_startup=false")
	if mcp != nil {
		env := mcp.env()
		keys := make([]string, 0, len(env))
		for k := range env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var kv []string
		for _, k := range keys {
			kv = append(kv, k+" = "+tomlString(env[k]))
		}
		p := "mcp_servers." + MCPServerName + "."
		args = append(args,
			"-c", p+"command="+tomlString(r.opts.Exe),
			"-c", p+`args=["assist", "mcp-bridge"]`,
			"-c", p+"env={"+strings.Join(kv, ", ")+"}",
			"-c", p+"startup_timeout_sec=30",
			"-c", p+"tool_timeout_sec=3600",
			// Rackoon decides on every call itself (access levels, approvals).
			"-c", p+`default_tools_approval_mode="approve"`,
			"-c", p+"required=true")
	}
	return append(args, "app-server")
}

// codexApp is a running app-server.
type codexApp struct {
	cmd    *exec.Cmd
	peer   *Peer
	stderr *tailBuffer
	done   chan struct{}
	err    error
}

type pipeRW struct {
	io.Reader
	io.WriteCloser
	closeR func() error
}

func (p *pipeRW) Close() error {
	err := p.WriteCloser.Close()
	if p.closeR != nil {
		p.closeR()
	}
	return err
}

// startCodexApp starts an app-server and initializes it.
func (r *Runner) startCodexApp(ctx context.Context, bin, dir string, mcp *mcpServer, handle Handler, notify NotifyHandler) (*codexApp, error) {
	cmd := exec.Command(bin, r.codexArgs(mcp)...)
	cmd.Env = r.cliEnv(Codex, nil)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	a := &codexApp{cmd: cmd, stderr: &tailBuffer{max: 4096}, done: make(chan struct{})}
	cmd.Stderr = a.stderr
	if err := cmd.Start(); err != nil {
		return nil, Errf(CodeInvalid, "Codex did not start: %v", err)
	}
	a.peer = NewPeer(&pipeRW{Reader: stdout, WriteCloser: stdin}, handle, notify)
	a.peer.Start()
	go func() {
		<-a.peer.Done()
		a.err = cmd.Wait()
		close(a.done)
	}()
	ictx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	init := map[string]any{"clientInfo": map[string]any{"name": "rackoon", "title": "Rackoon", "version": r.opts.Version}}
	if err := a.peer.Call(ictx, "initialize", init, nil); err != nil {
		a.close()
		return nil, Errf(CodeInvalid, "Codex did not answer: %s", firstLine(a.stderr.String(), err))
	}
	_ = a.peer.Notify("initialized", nil)
	return a, nil
}

func (a *codexApp) close() {
	a.peer.Close()
	if a.cmd.Process != nil {
		_ = syscall.Kill(-a.cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-a.done:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-a.cmd.Process.Pid, syscall.SIGKILL)
			<-a.done
		}
	}
}

type codexAccount struct {
	Account *struct {
		Type     string `json:"type"`
		Email    string `json:"email"`
		PlanType string `json:"planType"`
	} `json:"account"`
	// RequiresOpenaiAuth is false when config.toml names a model provider
	// that needs no OpenAI sign-in.
	RequiresOpenaiAuth bool `json:"requiresOpenaiAuth"`
}

func (c codexAccount) signedIn() bool { return c.Account != nil || !c.RequiresOpenaiAuth }

func (c codexAccount) status() ProviderStatus {
	if c.Account == nil {
		if !c.RequiresOpenaiAuth {
			return ProviderStatus{SignedIn: true, Account: "custom model provider (config.toml)"}
		}
		return ProviderStatus{}
	}
	acct := c.Account.Email
	switch {
	case c.Account.Type == "apiKey":
		acct = "API key"
	case acct == "":
		acct = "ChatGPT"
	}
	if c.Account.PlanType != "" && c.Account.Type == "chatgpt" {
		acct += " (" + c.Account.PlanType + ")"
	}
	return ProviderStatus{SignedIn: true, Account: acct}
}

// declineAll answers the app-server's requests: Rackoon gives Codex no
// shell, file changes or extra permissions; its own MCP server's
// elicitations are accepted (the hub decides on every tool call).
func declineAll(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return map[string]any{"decision": "decline"}, nil
	case "execCommandApproval", "applyPatchApproval":
		return map[string]any{"decision": "denied"}, nil
	case "mcpServer/elicitation/request":
		var p struct {
			ServerName string `json:"serverName"`
		}
		_ = json.Unmarshal(raw, &p)
		if p.ServerName == MCPServerName {
			return map[string]any{"action": "accept", "content": map[string]any{}}, nil
		}
		return map[string]any{"action": "decline"}, nil
	case "item/tool/requestUserInput":
		return map[string]any{"answers": map[string]any{}}, nil
	}
	return nil, &RPCError{Code: ErrMethodNotFound, Message: "not supported by Rackoon: " + method}
}

func (r *Runner) codexSignIn(ctx context.Context) ProviderStatus {
	bin := r.binary(Codex)
	if bin == "" {
		return ProviderStatus{}
	}
	a, err := r.startCodexApp(ctx, bin, filepath.Join(r.opts.StateDir, "tmp"), nil, declineAll, nil)
	if err != nil {
		return ProviderStatus{Error: err.Error()}
	}
	defer a.close()
	var acct codexAccount
	if err := a.peer.Call(ctx, "account/read", map[string]any{"refreshToken": false}, &acct); err != nil {
		return ProviderStatus{Error: "Codex: " + err.Error()}
	}
	return acct.status()
}

// codexLogin is a device login waiting for the user.
type codexLogin struct {
	result LoginResult
	cancel func()
}

func (r *Runner) codexLogin(ctx context.Context) (LoginResult, error) {
	bin, err := r.requireBinary(Codex)
	if err != nil {
		return LoginResult{}, err
	}
	r.mu.Lock()
	if l := r.logins[Codex]; l != nil {
		res := l.result
		r.mu.Unlock()
		return res, nil
	}
	r.mu.Unlock()
	completed := make(chan LoginDone, 1)
	notify := func(method string, raw json.RawMessage) {
		if method != "account/login/completed" {
			return
		}
		var p struct {
			Success bool    `json:"success"`
			Error   *string `json:"error"`
		}
		_ = json.Unmarshal(raw, &p)
		d := LoginDone{Provider: Codex, OK: p.Success}
		if p.Error != nil {
			d.Error = *p.Error
		}
		select {
		case completed <- d:
		default:
		}
	}
	a, err := r.startCodexApp(ctx, bin, filepath.Join(r.opts.StateDir, "tmp"), nil, declineAll, notify)
	if err != nil {
		return LoginResult{}, err
	}
	var res struct {
		LoginID         string `json:"loginId"`
		UserCode        string `json:"userCode"`
		VerificationURL string `json:"verificationUrl"`
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	err = a.peer.Call(cctx, "account/login/start", map[string]any{"type": "chatgptDeviceCode"}, &res)
	cancel()
	if err != nil || res.UserCode == "" {
		a.close()
		if err == nil {
			err = errors.New("no device code")
		}
		return LoginResult{}, Errf(CodeLogin, "Codex could not start the sign-in: %v", err)
	}
	out := LoginResult{VerificationURL: res.VerificationURL, UserCode: res.UserCode, ExpiresAt: time.Now().Add(15 * time.Minute)}
	stop := make(chan struct{})
	var once sync.Once
	l := &codexLogin{result: out, cancel: func() { once.Do(func() { close(stop) }) }}
	r.mu.Lock()
	r.logins[Codex] = l
	r.mu.Unlock()
	go func() {
		var d LoginDone
		select {
		case d = <-completed:
		case <-stop:
			d = LoginDone{Provider: Codex, Error: "Sign-in cancelled."}
			cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = a.peer.Call(cctx, "account/login/cancel", map[string]any{"loginId": res.LoginID}, nil)
			cancel()
		case <-time.After(time.Until(out.ExpiresAt)):
			d = LoginDone{Provider: Codex, Error: "The code expired before the sign-in finished."}
		case <-a.done:
			d = LoginDone{Provider: Codex, Error: "Codex stopped during the sign-in."}
		}
		a.close()
		r.mu.Lock()
		if r.logins[Codex] == l {
			delete(r.logins, Codex)
		}
		delete(r.signed, Codex)
		r.mu.Unlock()
		r.notify(NLogin, d)
	}()
	return out, nil
}

func (r *Runner) codexLogout(ctx context.Context) error {
	bin := r.binary(Codex)
	if bin == "" {
		return nil
	}
	a, err := r.startCodexApp(ctx, bin, filepath.Join(r.opts.StateDir, "tmp"), nil, declineAll, nil)
	if err != nil {
		return err
	}
	defer a.close()
	return a.peer.Call(ctx, "account/logout", nil, nil)
}

// codexDriver is one investigation's app-server and thread.
type codexDriver struct {
	app    *codexApp
	thread string
	emit   func(SessionEvent)

	mu     sync.Mutex
	turn   string   // the turn in progress ("": none)
	queued []string // messages that arrived while a turn could not take them
}

func (r *Runner) startCodex(bin, work string, p SessionStart, mcp *mcpServer, emit func(SessionEvent), onExit func(error)) (driver, error) {
	d := &codexDriver{emit: emit}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a, err := r.startCodexApp(ctx, bin, work, mcp, declineAll, d.onNotify)
	if err != nil {
		return nil, err
	}
	d.app = a
	var acct codexAccount
	if err := a.peer.Call(ctx, "account/read", map[string]any{"refreshToken": false}, &acct); err != nil || !acct.signedIn() {
		a.close()
		return nil, Errf(CodeSignedOut, "Codex is not signed in")
	}
	params := map[string]any{"cwd": work, "approvalPolicy": "never", "sandbox": "read-only", "developerInstructions": p.System}
	if p.Model != "" {
		params["model"] = p.Model
	}
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	method := "thread/start"
	if p.Resume != "" {
		method, params["threadId"] = "thread/resume", p.Resume
	}
	if err := a.peer.Call(ctx, method, params, &started); err != nil || started.Thread.ID == "" {
		a.close()
		if err == nil {
			err = errors.New("no thread")
		}
		return nil, Errf(CodeInvalid, "Codex could not start the conversation: %s", firstLine(a.stderr.String(), err))
	}
	d.thread = started.Thread.ID
	emit(SessionEvent{Kind: EvStarted, ProviderSession: d.thread})
	go func() {
		<-a.done
		var err error
		if a.err != nil && !strings.Contains(a.err.Error(), "signal") {
			err = fmt.Errorf("Codex stopped: %s", firstLine(a.stderr.String(), a.err))
		}
		onExit(err)
	}()
	if err := d.send(p.Prompt); err != nil {
		a.close()
		return nil, err
	}
	return d, nil
}

func textInput(text string) []map[string]any {
	return []map[string]any{{"type": "text", "text": text}}
}

// send starts a turn, or steers the running one.
func (d *codexDriver) send(text string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	d.mu.Lock()
	turn := d.turn
	d.mu.Unlock()
	if turn != "" {
		err := d.app.peer.Call(ctx, "turn/steer", map[string]any{"threadId": d.thread, "expectedTurnId": turn, "input": textInput(text)}, nil)
		if err == nil {
			return nil
		}
		d.mu.Lock()
		if d.turn != "" { // still running: deliver it after the turn
			d.queued = append(d.queued, text)
			d.mu.Unlock()
			return nil
		}
		d.mu.Unlock()
	}
	var res struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := d.app.peer.Call(ctx, "turn/start", map[string]any{"threadId": d.thread, "input": textInput(text)}, &res); err != nil {
		return Errf(CodeInvalid, "Codex did not take the message: %v", err)
	}
	d.mu.Lock()
	if d.turn == "" {
		d.turn = res.Turn.ID
	}
	d.mu.Unlock()
	return nil
}

func (d *codexDriver) interrupt() error {
	d.mu.Lock()
	turn := d.turn
	d.queued = nil
	d.mu.Unlock()
	if turn == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return d.app.peer.Call(ctx, "turn/interrupt", map[string]any{"threadId": d.thread, "turnId": turn}, nil)
}

func (d *codexDriver) close() { d.app.close() }

type codexItem struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Text      string          `json:"text"`
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Status    string          `json:"status"`
	Result    *struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Query            string          `json:"query"`
	Command          json.RawMessage `json:"command"`
	AggregatedOutput string          `json:"aggregatedOutput"`
	ExitCode         *int            `json:"exitCode"`
}

func (d *codexDriver) onNotify(method string, raw json.RawMessage) {
	switch method {
	case "turn/started":
		var p struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(raw, &p) == nil && p.Turn.ID != "" {
			d.mu.Lock()
			d.turn = p.Turn.ID
			d.mu.Unlock()
		}
	case "item/completed":
		var p struct {
			Item codexItem `json:"item"`
		}
		if json.Unmarshal(raw, &p) != nil {
			return
		}
		d.item(p.Item)
	case "thread/tokenUsage/updated":
		// Reported at the end of the turn instead.
	case "error":
		var p struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			WillRetry bool `json:"willRetry"`
		}
		if json.Unmarshal(raw, &p) == nil && !p.WillRetry && p.Error.Message != "" {
			d.emit(SessionEvent{Kind: EvText, Text: "⚠ " + p.Error.Message})
		}
	case "turn/completed":
		var p struct {
			Turn struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(raw, &p)
		ev := SessionEvent{Kind: EvTurnEnd}
		if p.Turn.Status == "failed" && p.Turn.Error != nil {
			ev.Error = p.Turn.Error.Message
		}
		d.mu.Lock()
		d.turn = ""
		var next string
		if len(d.queued) > 0 {
			next, d.queued = strings.Join(d.queued, "\n\n"), nil
		}
		d.mu.Unlock()
		if next != "" {
			go d.send(next)
			return
		}
		d.emit(ev)
	}
}

func (d *codexDriver) item(it codexItem) {
	switch it.Type {
	case "agentMessage":
		if t := strings.TrimSpace(it.Text); t != "" {
			d.emit(SessionEvent{Kind: EvText, Text: t})
		}
	case "mcpToolCall":
		if it.Server == MCPServerName {
			return // the hub ran it
		}
		var out []string
		if it.Result != nil {
			for _, c := range it.Result.Content {
				out = append(out, c.Text)
			}
		}
		if it.Error != nil {
			out = append(out, it.Error.Message)
		}
		d.emit(SessionEvent{Kind: EvTool, ToolID: it.ID, Tool: it.Server + "." + it.Tool, Input: it.Arguments})
		d.emit(SessionEvent{Kind: EvToolResult, ToolID: it.ID, OK: it.Status == "completed" && it.Error == nil, Output: strings.Join(out, "\n")})
	case "webSearch":
		in, _ := json.Marshal(map[string]string{"query": it.Query})
		d.emit(SessionEvent{Kind: EvTool, ToolID: it.ID, Tool: "WebSearch", Input: in})
		d.emit(SessionEvent{Kind: EvToolResult, ToolID: it.ID, OK: true})
	case "commandExecution":
		// Turned off (features.shell_tool); shown if a version runs one anyway.
		in, _ := json.Marshal(map[string]json.RawMessage{"command": it.Command})
		d.emit(SessionEvent{Kind: EvTool, ToolID: it.ID, Tool: "codex.shell", Input: in})
		d.emit(SessionEvent{Kind: EvToolResult, ToolID: it.ID, OK: it.ExitCode != nil && *it.ExitCode == 0, Output: it.AggregatedOutput})
	}
}
