package assist

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MCP: the CLIs start `whombat-hosts assist mcp-bridge` as their stdio MCP
// server "rackoon". The bridge connects to the session's Unix socket in
// the runner's state, sends the session's token, and then pipes bytes;
// the runner answers MCP (JSON-RPC 2.0) on that connection and relays
// tools/call to the hub.

// Environment of the bridge.
const (
	EnvMCPSocket = "RACKOON_ASSIST_MCP"
	EnvMCPToken  = "RACKOON_ASSIST_MCP_TOKEN"
)

// MCPServerName is the server name the CLIs see (Claude Code names the
// tools mcp__rackoon__<tool>).
const MCPServerName = "rackoon"

// mcpVersions are the protocol revisions the server speaks (newest first).
var mcpVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

type mcpServer struct {
	r       *Runner
	session string
	path    string
	token   string
	tools   []ToolDef
	ln      net.Listener

	mu    sync.Mutex
	peers []*Peer
	once  sync.Once
}

func (r *Runner) startMCP(session string, tools []ToolDef) (*mcpServer, error) {
	path := filepath.Join(r.opts.StateDir, "run", session+".sock")
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	m := &mcpServer{r: r, session: session, path: path, token: randHex(24), tools: tools, ln: ln}
	go m.accept()
	return m, nil
}

// env is what the bridge needs to reach this server.
func (m *mcpServer) env() map[string]string {
	return map[string]string{EnvMCPSocket: m.path, EnvMCPToken: m.token}
}

func (m *mcpServer) close() {
	m.once.Do(func() {
		m.ln.Close()
		os.Remove(m.path)
		m.mu.Lock()
		for _, p := range m.peers {
			p.Close()
		}
		m.mu.Unlock()
	})
}

func (m *mcpServer) accept() {
	for {
		c, err := m.ln.Accept()
		if err != nil {
			return
		}
		go m.serveConn(c)
	}
}

func (m *mcpServer) serveConn(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(c)
	line, err := br.ReadString('\n')
	if err != nil || subtle.ConstantTimeCompare([]byte(strings.TrimSpace(line)), []byte(m.token)) != 1 {
		c.Close()
		return
	}
	c.SetReadDeadline(time.Time{})
	p := NewPeer(&bufferedConn{Reader: br, Conn: c}, m.handle, nil)
	p.V2 = true
	m.mu.Lock()
	m.peers = append(m.peers, p)
	m.mu.Unlock()
	p.Start()
}

type bufferedConn struct {
	io.Reader
	net.Conn
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.Reader.Read(p) }

func (m *mcpServer) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(raw, &p)
		v := mcpVersions[1]
		for _, s := range mcpVersions {
			if s == p.ProtocolVersion {
				v = s
			}
		}
		return map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": MCPServerName, "title": "Rackoon", "version": m.r.opts.Version},
			"instructions":    "Rackoon's tools: the monitored hosts, their alerts and metrics, read-only diagnostics on a host, and (when allowed) commands and guest actions.",
		}, nil
	case "ping":
		return struct{}{}, nil
	case "tools/list":
		tools := make([]map[string]any, 0, len(m.tools))
		for _, t := range m.tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": t.InputSchema})
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, &RPCError{Code: ErrInvalidParams, Message: err.Error()}
		}
		if len(p.Arguments) == 0 || string(p.Arguments) == "null" {
			p.Arguments = json.RawMessage("{}")
		}
		res, err := m.r.callTool(ctx, m.session, p.Name, p.Arguments)
		if err != nil {
			msg := err.Error()
			if errors.Is(err, ErrClosed) {
				msg = "Rackoon's hub is not reachable right now."
			}
			res = ToolResult{Text: msg, IsError: true}
		}
		return map[string]any{"content": []map[string]any{{"type": "text", "text": res.Text}}, "isError": res.IsError}, nil
	}
	return nil, &RPCError{Code: ErrMethodNotFound, Message: "method not found: " + method}
}

// Bridge is `whombat-hosts assist mcp-bridge`: it connects stdin and stdout
// to the session's MCP socket named in the environment.
func Bridge(in io.Reader, out io.Writer) error {
	path, token := os.Getenv(EnvMCPSocket), os.Getenv(EnvMCPToken)
	if path == "" || token == "" {
		return fmt.Errorf("%s and %s must be set (the assistant runner starts this bridge)", EnvMCPSocket, EnvMCPToken)
	}
	c, err := net.Dial("unix", path)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err := io.WriteString(c, token+"\n"); err != nil {
		return err
	}
	go func() {
		_, _ = io.Copy(c, in)
		if uc, ok := c.(*net.UnixConn); ok {
			_ = uc.CloseWrite()
		}
	}()
	_, err = io.Copy(out, c)
	return err
}
