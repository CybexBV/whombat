package proto

// The assistant (docs/ASSIST.md) works on hosts through two hub-opened
// streams. Both are request / response; neither is stored by the hub
// except as the assistant's investigation transcript.
const (
	// StreamDiagnose: DiagnoseRequest -> DiagnoseResponse. Runs one named,
	// read-only check from the agent's catalog (DiagnoseList lists them).
	// The hub names a check and its arguments, never a command line; the
	// agent validates every argument. Needs Policy.Diagnose.
	StreamDiagnose = "diagnose"
	// StreamExec: ExecRequest -> ExecResponse. Runs one shell command as
	// root on the host (outside the agent's sandbox). Needs
	// Policy.HostShell: it is as powerful as the host shell.
	StreamExec = "exec"
)

// DiagnoseList is the check that returns the catalog (DiagnoseResponse.Checks)
// of the checks this host can run.
const DiagnoseList = "list"

// DiagnoseRequest asks for one check.
type DiagnoseRequest struct {
	Check string            `cbor:"check" json:"check"`
	Args  map[string]string `cbor:"args,omitempty" json:"args,omitempty"`
}

// DiagnoseResponse carries the check's text output, or an error code:
// remote_control_disabled, unsupported (unknown check, or its tool is not
// installed), invalid_request (an argument failed validation), timeout,
// failed (the tool ran and failed: Output still carries what it printed).
type DiagnoseResponse struct {
	Code    string `cbor:"code,omitempty" json:"code,omitempty"`
	Message string `cbor:"msg,omitempty" json:"message,omitempty"`
	// Commands is what ran, for the transcript ("smartctl -x /dev/sdc").
	Commands []string `cbor:"cmds,omitempty" json:"commands,omitempty"`
	// Output is plain text (UTF-8, at most 256 KiB; logs keep their last
	// lines). Secrets the agent recognizes (passwords, tokens, keys in
	// configuration output) are replaced with <redacted>.
	Output    string `cbor:"out,omitempty" json:"output,omitempty"`
	Truncated bool   `cbor:"truncated,omitempty" json:"truncated,omitempty"`
	// Checks: the catalog, for DiagnoseList only.
	Checks []DiagnoseCheck `cbor:"checks,omitempty" json:"checks,omitempty"`
}

// DiagnoseCheck describes one check of the catalog.
type DiagnoseCheck struct {
	Name        string        `cbor:"name" json:"name"`
	Description string        `cbor:"desc" json:"description"`
	Args        []DiagnoseArg `cbor:"args,omitempty" json:"args,omitempty"`
}

// DiagnoseArg describes one argument of a check.
type DiagnoseArg struct {
	Name        string `cbor:"name" json:"name"`
	Description string `cbor:"desc" json:"description"`
	Required    bool   `cbor:"req,omitempty" json:"required,omitempty"`
}

// ExecRequest runs Command with /bin/sh -c as root, stdin closed, in /root
// (or /), with a clean environment.
type ExecRequest struct {
	Command string `cbor:"cmd" json:"command"`
	// TimeoutS bounds the run (default 120 s, at most 1800 s); the command
	// and everything it started are killed when it passes.
	TimeoutS int `cbor:"timeout,omitempty" json:"timeout_s,omitempty"`
}

// ExecResponse is the command's outcome. Code is empty when the command
// ran (whatever its exit status), else remote_control_disabled,
// invalid_request, unsupported or failed (it could not be started).
type ExecResponse struct {
	Code     string `cbor:"code,omitempty" json:"code,omitempty"`
	Message  string `cbor:"msg,omitempty" json:"message,omitempty"`
	ExitCode int    `cbor:"exit" json:"exit_code"`
	TimedOut bool   `cbor:"timed_out,omitempty" json:"timed_out,omitempty"`
	// Output is stdout and stderr as they interleaved; the last 256 KiB
	// are kept when there is more (Truncated).
	Output     string `cbor:"out,omitempty" json:"output,omitempty"`
	Truncated  bool   `cbor:"truncated,omitempty" json:"truncated,omitempty"`
	DurationMs int64  `cbor:"ms" json:"duration_ms"`
}
