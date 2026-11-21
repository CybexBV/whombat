package assist

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestLiveSession runs a real CLI through the runner: two turns, Rackoon's
// tools over MCP, and a resumed session. It needs the CLI installed in
// RACKOON_ASSIST_LIVE_STATE (bin/<provider>/current) and credentials:
//
//	RACKOON_ASSIST_LIVE=claude: ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
//	   (or ANTHROPIC_API_KEY) from the environment;
//	RACKOON_ASSIST_LIVE=codex: RACKOON_ASSIST_LIVE_CODEX_AUTH, an auth.json
//	   to copy into the test's CODEX_HOME (and RACKOON_ASSIST_LIVE_CODEX_CONFIG,
//	   a config.toml, for a custom model provider).
func TestLiveSession(t *testing.T) {
	provider := os.Getenv("RACKOON_ASSIST_LIVE")
	if provider == "" {
		t.Skip("set RACKOON_ASSIST_LIVE=claude|codex to run a real CLI")
	}
	src := os.Getenv("RACKOON_ASSIST_LIVE_STATE")
	state := t.TempDir()
	// Codex leaves read-only directories that would stop TempDir's cleanup
	// (and keep the copied credentials).
	t.Cleanup(func() {
		filepath.WalkDir(state, func(p string, d os.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				os.Chmod(p, 0o700)
			}
			return nil
		})
		os.Remove(filepath.Join(state, "codex", "auth.json"))
		os.Remove(filepath.Join(state, "claude.token"))
	})
	if err := os.MkdirAll(filepath.Join(state, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(src, "bin", provider), filepath.Join(state, "bin", provider)); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "whombat-hosts")
	if out, err := exec.Command("go", "build", "-o", exe, "rackoon/cmd/whombat-hosts").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	switch provider {
	case Claude:
		os.WriteFile(filepath.Join(state, "claude.token"), []byte("sk-ant-oat01-live-test-placeholder\n"), 0o600)
		testEnv = func(p string, env []string) []string {
			var out []string
			for _, kv := range env {
				if !strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH_TOKEN=") {
					out = append(out, kv)
				}
			}
			for _, k := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"} {
				if v := os.Getenv(k); v != "" {
					out = append(out, k+"="+v)
				}
			}
			return out
		}
		defer func() { testEnv = nil }()
	case Codex:
		b, err := os.ReadFile(os.Getenv("RACKOON_ASSIST_LIVE_CODEX_AUTH"))
		if err != nil {
			t.Fatal(err)
		}
		os.MkdirAll(filepath.Join(state, "codex"), 0o700)
		os.WriteFile(filepath.Join(state, "codex", "auth.json"), b, 0o600)
		if cfg := os.Getenv("RACKOON_ASSIST_LIVE_CODEX_CONFIG"); cfg != "" { // a custom model provider
			c, err := os.ReadFile(cfg)
			if err != nil {
				t.Fatal(err)
			}
			os.WriteFile(filepath.Join(state, "codex", "config.toml"), c, 0o600)
		}
	}

	hubSide, runnerSide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Serve(ctx, runnerSide, Options{StateDir: state, Exe: exe, Version: "test"})

	var mu sync.Mutex
	var events []SessionEvent
	var calls []string
	turns := make(chan SessionEvent, 8)
	hub := NewPeer(hubSide, func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		var tc ToolCall
		json.Unmarshal(raw, &tc)
		mu.Lock()
		calls = append(calls, tc.Name)
		mu.Unlock()
		switch tc.Name {
		case "list_hosts":
			return ToolResult{Text: `{"hosts":[{"id":"blackbox","name":"BlackBox","status":"warning"}]}`}, nil
		case "finish":
			return ToolResult{Text: "Recorded."}, nil
		}
		return ToolResult{Text: "unknown tool", IsError: true}, nil
	}, func(method string, raw json.RawMessage) {
		if method != NEvent {
			return
		}
		var ev SessionEvent
		json.Unmarshal(raw, &ev)
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
		t.Logf("event %s %s %s %s", ev.Kind, ev.Text, ev.Tool, ev.Error)
		if ev.Kind == EvTurnEnd || ev.Kind == EvExit {
			turns <- ev
		}
	})
	hub.Start()
	defer hub.Close()

	tools := []ToolDef{
		{Name: "list_hosts", Description: "List the monitored hosts.", InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)},
		{Name: "finish", Description: "Record the conclusion.", InputSchema: json.RawMessage(`{"type":"object","properties":{"summary":{"type":"string"},"resolved":{"type":"boolean"}},"required":["summary","resolved"],"additionalProperties":false}`)},
	}
	wait := func(what string) SessionEvent {
		t.Helper()
		select {
		case ev := <-turns:
			if ev.Error != "" {
				t.Fatalf("%s: %s", what, ev.Error)
			}
			return ev
		case <-time.After(4 * time.Minute):
			t.Fatalf("%s: no turn end", what)
		}
		return SessionEvent{}
	}
	call := func(method string, params any) {
		t.Helper()
		cctx, ccancel := context.WithTimeout(ctx, 3*time.Minute)
		defer ccancel()
		if err := hub.Call(cctx, method, params, nil); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
	}
	call(MSessionStart, SessionStart{Session: "inv_live", Provider: provider, System: "You are testing Rackoon's tool plumbing. Be brief.",
		Prompt: "Call the list_hosts tool, then call finish with summary \"ok\" and resolved true, then reply with the single word DONE.", Tools: tools})
	wait("first turn")
	call(MSessionSend, SessionSend{Session: "inv_live", Text: "Reply with the single word AGAIN."})
	wait("second turn")
	mu.Lock()
	var started string
	var texts []string
	for _, ev := range events {
		if ev.Kind == EvStarted {
			started = ev.ProviderSession
		}
		if ev.Kind == EvText {
			texts = append(texts, ev.Text)
		}
	}
	gotCalls := append([]string(nil), calls...)
	mu.Unlock()
	if started == "" || !strings.Contains(strings.Join(gotCalls, ","), "list_hosts") || !strings.Contains(strings.Join(gotCalls, ","), "finish") {
		t.Fatalf("session %q, calls %v", started, gotCalls)
	}
	if all := strings.Join(texts, "\n"); !strings.Contains(all, "DONE") || !strings.Contains(all, "AGAIN") {
		t.Fatalf("texts %q", texts)
	}
	// Close and resume the conversation.
	call(MSessionClose, SessionRef{Session: "inv_live"})
	select {
	case ev := <-turns:
		if ev.Kind != EvExit {
			t.Fatalf("expected exit, got %+v", ev)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("no exit")
	}
	call(MSessionStart, SessionStart{Session: "inv_live", Provider: provider, Resume: started, System: "You are testing Rackoon's tool plumbing. Be brief.",
		Prompt: "Which single word did you reply with last time? Answer with that word only.", Tools: tools})
	wait("resumed turn")
	mu.Lock()
	last := events[len(events)-2]
	mu.Unlock()
	if !strings.Contains(last.Text, "AGAIN") {
		t.Errorf("after resume: %+v", last)
	}
	// A message sent while the CLI works is answered before the turn ends.
	call(MSessionSend, SessionSend{Session: "inv_live", Text: "Now reply with the single word THIRD."})
	call(MSessionSend, SessionSend{Session: "inv_live", Text: "And then reply with the single word FOURTH."})
	wait("queued turns")
	time.Sleep(3 * time.Second)
	select {
	case ev := <-turns:
		t.Fatalf("a second turn end: %+v", ev)
	default:
	}
	mu.Lock()
	var tail []string
	for _, ev := range events {
		if ev.Kind == EvText {
			tail = append(tail, ev.Text)
		}
	}
	mu.Unlock()
	// Claude Code answers queued messages in turn; Codex steers the running
	// turn with them, so its answer may cover the last one only.
	if all := strings.Join(tail, "\n"); !strings.Contains(all, "FOURTH") || provider == Claude && !strings.Contains(all, "THIRD") {
		t.Errorf("queued answers: %q", tail)
	}
	_ = io.EOF
}
