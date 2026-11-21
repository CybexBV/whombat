package assist

import (
	"encoding/json"
	"time"
)

// Providers.
const (
	Claude = "claude" // Claude Code
	Codex  = "codex"  // OpenAI Codex
)

// Providers lists the providers in display order.
var Providers = []string{Claude, Codex}

// ProviderName is the display name of a provider.
func ProviderName(p string) string {
	switch p {
	case Claude:
		return "Claude Code"
	case Codex:
		return "Codex"
	}
	return p
}

// Methods the hub calls on the runner.
const (
	MStatus           = "status"            // StatusParams -> Status
	MLatest           = "latest"            // LatestParams -> LatestResult
	MInstall          = "install"           // InstallParams -> InstallResult (progress as NProgress)
	MUninstall        = "uninstall"         // ProviderParams -> {}
	MLogin            = "login"             // LoginParams -> LoginResult (Codex completes later: NLogin)
	MLogout           = "logout"            // ProviderParams -> {} (also cancels a pending login)
	MSessionStart     = "session.start"     // SessionStart -> {}
	MSessionSend      = "session.send"      // SessionSend -> {}
	MSessionInterrupt = "session.interrupt" // SessionRef -> {}
	MSessionClose     = "session.close"     // SessionRef -> {}
)

// Notifications from the runner to the hub.
const (
	NProgress = "install.progress" // Progress
	NLogin    = "login.done"       // LoginDone
	NEvent    = "session.event"    // SessionEvent
)

// MToolCall is the runner's request to the hub: run one of Rackoon's tools
// for a session (ToolCall -> ToolResult).
const MToolCall = "tool.call"

// Error codes of AppError.
const (
	CodeNotInstalled = "provider_not_installed"
	CodeSignedOut    = "provider_signed_out"
	CodeBusy         = "busy"
	CodeNoSession    = "no_session"
	CodeInvalid      = "invalid_request"
	CodeDownload     = "download_failed"
	CodeVerify       = "verify_failed"
	CodeLogin        = "login_failed"
)

// StatusParams asks for the runner's state. Refresh re-reads the sign-in
// state from the CLIs (slow: it starts them).
type StatusParams struct {
	Refresh bool `json:"refresh,omitempty"`
}

// Status is the runner's state.
type Status struct {
	Version   string                    `json:"version"`
	Sandboxed bool                      `json:"sandboxed"` // runs in its own unit (rackoon-assist@.service)
	Providers map[string]ProviderStatus `json:"providers"`
}

// ProviderStatus is one CLI's install and sign-in state.
type ProviderStatus struct {
	Installed bool         `json:"installed"`
	Version   string       `json:"version,omitempty"`
	SignedIn  bool         `json:"signed_in"`
	Account   string       `json:"account,omitempty"`
	Login     *LoginResult `json:"login,omitempty"` // a device login waiting for the user
	Error     string       `json:"error,omitempty"`
}

// ProviderParams names a provider.
type ProviderParams struct {
	Provider string `json:"provider"`
}

// LatestParams asks for the newest version of a provider (Channel: Claude
// Code's stable | latest).
type LatestParams struct {
	Provider string `json:"provider"`
	Channel  string `json:"channel,omitempty"`
}

// LatestResult is the newest version.
type LatestResult struct {
	Version string `json:"version"`
}

// InstallParams installs Version, or the newest of Channel.
type InstallParams struct {
	Provider string `json:"provider"`
	Channel  string `json:"channel,omitempty"`
	Version  string `json:"version,omitempty"`
}

// InstallResult is the version now current.
type InstallResult struct {
	Version string `json:"version"`
}

// Progress reports a download.
type Progress struct {
	Provider string `json:"provider"`
	Done     int64  `json:"done"`
	Total    int64  `json:"total"`
}

// LoginParams signs a provider in. Claude Code: Token is a long-lived
// OAuth token from `claude setup-token` (or an API key). Codex: a device
// login starts (LoginResult); NLogin tells when it ends.
type LoginParams struct {
	Provider string `json:"provider"`
	Token    string `json:"token,omitempty"`
}

// LoginResult is a pending device login (Codex).
type LoginResult struct {
	VerificationURL string    `json:"verification_url"`
	UserCode        string    `json:"user_code"`
	ExpiresAt       time.Time `json:"expires_at"`
}

// LoginDone ends a device login.
type LoginDone struct {
	Provider string `json:"provider"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// ToolDef is one of Rackoon's tools as the CLI sees it (MCP tools/list).
type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// SessionStart starts (or resumes) a CLI session for an investigation.
type SessionStart struct {
	Session string `json:"session"` // the hub's investigation id
	// Run names this CLI run; its events carry it, so the hub can tell a
	// run that is ending from the one that replaced it.
	Run      string `json:"run,omitempty"`
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
	// Resume is the provider's own session (Claude Code) or thread (Codex)
	// to continue.
	Resume string    `json:"resume,omitempty"`
	System string    `json:"system"` // instructions added to the CLI's own
	Prompt string    `json:"prompt"` // the first user message
	Tools  []ToolDef `json:"tools"`
}

// SessionSend is a further user message.
type SessionSend struct {
	Session string `json:"session"`
	Text    string `json:"text"`
}

// SessionRef names a session, and optionally the run meant (a request
// for a run that was replaced is ignored).
type SessionRef struct {
	Session string `json:"session"`
	Run     string `json:"run,omitempty"`
}

// Session event kinds.
const (
	EvStarted    = "started"     // ProviderSession is known
	EvText       = "text"        // an answer (Markdown)
	EvTool       = "tool"        // the CLI's own tool (web search): ToolID, Tool, Input
	EvToolResult = "tool_result" // ToolID, OK, Output
	EvTurnEnd    = "turn_end"    // CostUSD, tokens, Error
	EvExit       = "exit"        // the CLI ended (Error when unexpectedly)
)

// SessionEvent is a CLI's output, normalized. Rackoon's own tool calls are
// not events: they reach the hub as MToolCall.
type SessionEvent struct {
	Session         string          `json:"session"`
	Run             string          `json:"run,omitempty"`
	Kind            string          `json:"kind"`
	ProviderSession string          `json:"provider_session,omitempty"`
	Text            string          `json:"text,omitempty"`
	ToolID          string          `json:"tool_id,omitempty"`
	Tool            string          `json:"tool,omitempty"`
	Input           json.RawMessage `json:"input,omitempty"`
	OK              bool            `json:"ok,omitempty"`
	Output          string          `json:"output,omitempty"`
	CostUSD         *float64        `json:"cost_usd,omitempty"`
	InputTokens     *int64          `json:"input_tokens,omitempty"`
	OutputTokens    *int64          `json:"output_tokens,omitempty"`
	Error           string          `json:"error,omitempty"`
}

// ToolCall asks the hub to run a tool.
type ToolCall struct {
	Session string          `json:"session"`
	Name    string          `json:"name"`
	Args    json.RawMessage `json:"args"`
}

// ToolResult is the tool's answer as text for the AI.
type ToolResult struct {
	Text    string `json:"text"`
	IsError bool   `json:"is_error,omitempty"`
}
