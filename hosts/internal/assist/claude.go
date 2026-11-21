package assist

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Claude Code runs as `claude -p` with stream-json in and out: one process
// per investigation, kept running between turns (stdin stays open), and
// resumed with --resume when it ended.

func (r *Runner) claudeTokenPath() string { return filepath.Join(r.opts.StateDir, "claude.token") }

// claudeCredential is the saved OAuth token (or API key), "" when signed
// out.
func (r *Runner) claudeCredential() string {
	b, err := os.ReadFile(r.claudeTokenPath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (r *Runner) claudeSignIn() ProviderStatus {
	tok := r.claudeCredential()
	if tok == "" {
		return ProviderStatus{}
	}
	if strings.HasPrefix(tok, "sk-ant-api") {
		return ProviderStatus{SignedIn: true, Account: "API key"}
	}
	return ProviderStatus{SignedIn: true, Account: "Claude subscription"}
}

// claudeLogin saves a token after a short request proves it works.
func (r *Runner) claudeLogin(ctx context.Context, token string) error {
	token = strings.TrimSpace(token)
	if len(token) < 20 || len(token) > 4096 || strings.ContainsAny(token, " \t\r\n") || !strings.HasPrefix(token, "sk-ant-") {
		return Errf(CodeLogin, "That is not a Claude Code token: run `claude setup-token` and paste the token it prints (sk-ant-oat…).")
	}
	bin, err := r.requireBinary(Claude)
	if err != nil {
		return err
	}
	tmp := r.claudeTokenPath() + ".new"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	// cliEnv reads the saved token: probe with the new one in place.
	env := r.cliEnv(Claude, nil)
	for i, kv := range env {
		if strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH_TOKEN=") || strings.HasPrefix(kv, "ANTHROPIC_API_KEY=") {
			env = append(env[:i], env[i+1:]...)
			break
		}
	}
	if strings.HasPrefix(token, "sk-ant-api") {
		env = append(env, "ANTHROPIC_API_KEY="+token)
	} else {
		env = append(env, "CLAUDE_CODE_OAUTH_TOKEN="+token)
	}
	pctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(pctx, bin, "-p", "Reply with the single word OK.", "--output-format", "json",
		"--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", "haiku", "--max-turns", "1")
	cmd.Env = env
	cmd.Dir = filepath.Join(r.opts.StateDir, "tmp")
	out, err := cmd.Output()
	var res struct {
		IsError bool   `json:"is_error"`
		Result  string `json:"result"`
	}
	if jerr := json.Unmarshal(out, &res); err != nil || jerr != nil || res.IsError {
		os.Remove(tmp)
		msg := strings.TrimSpace(res.Result)
		if msg == "" {
			msg = firstLine(string(out), err)
		}
		return Errf(CodeLogin, "Claude Code did not accept the token: %s", msg)
	}
	r.forget(Claude)
	return os.Rename(tmp, r.claudeTokenPath())
}

// claudeArgs is the command line of a session.
func claudeArgs(p SessionStart, mcpConfig string) []string {
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--tools", "WebSearch,WebFetch",
		"--strict-mcp-config", "--mcp-config", mcpConfig,
		"--permission-mode", "dontAsk",
		"--allowedTools", "mcp__" + MCPServerName + ",WebSearch,WebFetch",
		"--disable-slash-commands",
		"--append-system-prompt", p.System}
	if p.Model != "" {
		args = append(args, "--model", p.Model)
	}
	if p.Resume != "" {
		args = append(args, "--resume", p.Resume)
	}
	return args
}

type claudeDriver struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	wmu     sync.Mutex
	closed  chan struct{}
	closing atomic.Bool // close() was called: the exit is no error

	// A message sent during a turn becomes a turn of its own after it:
	// the session's turn ends only when none is left.
	tmu     sync.Mutex
	inTurn  bool
	pending int
}

// turnEnded reports whether a result ends the session's work (no message
// waits for its own turn).
func (d *claudeDriver) turnEnded() bool {
	d.tmu.Lock()
	defer d.tmu.Unlock()
	if d.pending > 0 {
		d.pending--
		return false
	}
	d.inTurn = false
	return true
}

func (r *Runner) startClaude(bin, work string, p SessionStart, mcp *mcpServer, emit func(SessionEvent), onExit func(error)) (driver, error) {
	if r.claudeCredential() == "" {
		return nil, Errf(CodeSignedOut, "Claude Code is not signed in")
	}
	srv := map[string]any{"type": "stdio", "command": r.opts.Exe, "args": []string{"assist", "mcp-bridge"}, "env": mcp.env()}
	cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{MCPServerName: srv}})
	cmd := exec.Command(bin, claudeArgs(p, string(cfg))...)
	cmd.Env = r.cliEnv(Claude, []string{"MCP_TOOL_TIMEOUT=3600000", "MCP_TIMEOUT=30000"})
	cmd.Dir = work
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, Errf(CodeInvalid, "Claude Code did not start: %v", err)
	}
	d := &claudeDriver{cmd: cmd, stdin: stdin, closed: make(chan struct{})}
	go func() {
		sawResult := readClaude(stdout, func(ev SessionEvent) {
			if ev.Kind == EvTurnEnd && !d.turnEnded() {
				return // the next queued message is being answered
			}
			emit(ev)
		})
		err := cmd.Wait()
		close(d.closed)
		switch {
		case err == nil || d.closing.Load():
			err = nil
		case !sawResult:
			err = fmt.Errorf("Claude Code stopped: %s", firstLine(stderr.String(), err))
		default:
			err = nil // it answered; the exit after an interrupt is expected
		}
		onExit(err)
	}()
	if err := d.send(p.Prompt); err != nil {
		d.close()
		return nil, err
	}
	return d, nil
}

func (d *claudeDriver) send(text string) error {
	msg := map[string]any{"type": "user", "message": map[string]any{"role": "user",
		"content": []map[string]any{{"type": "text", "text": text}}}}
	b, _ := json.Marshal(msg)
	d.wmu.Lock()
	defer d.wmu.Unlock()
	select {
	case <-d.closed:
		return Errf(CodeNoSession, "the session ended")
	default:
	}
	if d.closing.Load() {
		return Errf(CodeNoSession, "the session is ending")
	}
	if _, err := d.stdin.Write(append(b, '\n')); err != nil {
		return err
	}
	d.tmu.Lock()
	if d.inTurn {
		d.pending++
	}
	d.inTurn = true
	d.tmu.Unlock()
	return nil
}

// interrupt ends the current turn: Claude Code records it and exits; the
// next message resumes the session.
func (d *claudeDriver) interrupt() error {
	if d.cmd.Process == nil {
		return nil
	}
	return d.cmd.Process.Signal(syscall.SIGINT)
}

// close ends the CLI: its input closes, so it finishes and exits; it is
// terminated when it does not within 10 s.
func (d *claudeDriver) close() {
	d.closing.Store(true)
	d.wmu.Lock()
	d.stdin.Close()
	d.wmu.Unlock()
	if d.cmd.Process == nil {
		return
	}
	select {
	case <-d.closed:
		return
	case <-time.After(10 * time.Second):
	}
	_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-d.closed:
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
	}
}

// claude stream-json lines (the parts used).
type claudeLine struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	Message   *struct {
		Content []claudeBlock `json:"content"`
	} `json:"message"`
	IsError      bool     `json:"is_error"`
	Result       string   `json:"result"`
	TotalCostUSD *float64 `json:"total_cost_usd"`
	Usage        *struct {
		InputTokens  int64 `json:"input_tokens"`
		CacheRead    int64 `json:"cache_read_input_tokens"`
		CacheCreate  int64 `json:"cache_creation_input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
	ParentToolUseID *string `json:"parent_tool_use_id"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// readClaude turns Claude Code's output into session events. Rackoon's
// own tools are skipped (the hub sees those calls itself).
func readClaude(r io.Reader, emit func(SessionEvent)) (sawResult bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), MaxMessage)
	started := false
	own := map[string]bool{} // tool_use ids of the CLI's own tools
	for sc.Scan() {
		var l claudeLine
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			continue
		}
		if l.ParentToolUseID != nil && *l.ParentToolUseID != "" {
			continue // a subagent's messages
		}
		switch l.Type {
		case "system":
			if l.Subtype == "init" && l.SessionID != "" && !started {
				started = true
				emit(SessionEvent{Kind: EvStarted, ProviderSession: l.SessionID})
			}
		case "assistant":
			if l.Message == nil {
				continue
			}
			for _, b := range l.Message.Content {
				switch b.Type {
				case "text":
					if t := strings.TrimSpace(b.Text); t != "" {
						emit(SessionEvent{Kind: EvText, Text: t})
					}
				case "tool_use", "server_tool_use":
					if strings.HasPrefix(b.Name, "mcp__"+MCPServerName+"__") {
						continue
					}
					own[b.ID] = true
					emit(SessionEvent{Kind: EvTool, ToolID: b.ID, Tool: b.Name, Input: b.Input})
				}
			}
		case "user":
			if l.Message == nil {
				continue
			}
			for _, b := range l.Message.Content {
				if b.Type == "tool_result" && own[b.ToolUseID] {
					emit(SessionEvent{Kind: EvToolResult, ToolID: b.ToolUseID, OK: !b.IsError, Output: blockText(b.Content)})
				}
			}
		case "result":
			sawResult = true
			ev := SessionEvent{Kind: EvTurnEnd, CostUSD: l.TotalCostUSD}
			if l.Usage != nil {
				in := l.Usage.InputTokens + l.Usage.CacheRead + l.Usage.CacheCreate
				out := l.Usage.OutputTokens
				ev.InputTokens, ev.OutputTokens = &in, &out
			}
			if l.IsError || (l.Subtype != "" && l.Subtype != "success") {
				ev.Error = strings.TrimSpace(l.Result)
				if ev.Error == "" {
					ev.Error = strings.ReplaceAll(l.Subtype, "_", " ")
				}
			}
			emit(ev)
		}
	}
	return sawResult
}

// blockText is the text of a tool_result's content (a string or blocks).
func blockText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var parts []string
		for _, b := range blocks {
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return string(raw)
}

// tailBuffer keeps the last max bytes written.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}
