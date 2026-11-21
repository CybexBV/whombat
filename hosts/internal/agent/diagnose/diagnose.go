// Package diagnose runs the hub's assistant's work on the host
// (docs/ASSIST.md 3): read-only checks from a fixed catalog
// (proto.StreamDiagnose) and root shell commands (proto.StreamExec).
//
// A check is named by the hub, never a command line: every check runs fixed
// argv (no shell) with arguments the agent validated itself, a clean
// environment and a time limit, and shows configuration files with their
// secrets redacted. Checks whose tool is not installed are not offered.
package diagnose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"rackoon/internal/agent/inspect"
	"rackoon/internal/agent/pkgs"
	"rackoon/internal/agent/services"
	"rackoon/internal/proto"
)

// Error codes (proto.DiagnoseResponse, proto.ExecResponse).
const (
	CodeInvalid     = "invalid_request"
	CodeUnsupported = "unsupported"
	CodeTimeout     = "timeout"
	CodeFailed      = "failed"
)

// Limits.
const (
	// MaxOutput bounds a check's and a command's output.
	MaxOutput = 256 << 10
	// CheckTimeout bounds a whole check, below the stream's 60 s so a slow
	// check still answers with what it has.
	CheckTimeout = 50 * time.Second
	// CommandTimeout bounds one command of a check.
	CommandTimeout = 30 * time.Second
)

// Diagnostics implements agent.Diagnostics.
type Diagnostics struct {
	// Inspect is the broker's host views (processes with their guest,
	// listening ports, pending updates); nil reads them with the inspect
	// and pkgs packages directly.
	Inspect func(ctx context.Context, req proto.InspectRequest) proto.InspectResponse
	Log     *slog.Logger

	// Seams for tests; New sets the real ones.
	run        func(ctx context.Context, s runSpec) runResult
	lookPath   func(name string) (string, error)
	root       string // prefix of the files read directly ("" = /)
	initSystem string // services.InitSystem()
	pkgManager func() string
	sandboxed  bool // under systemd: Exec (and tools that write) leave the sandbox through systemd-run
	now        func() time.Time
	shell      string // Exec's shell

	// A Mac's (NewMac); nil or "" are Linux's: the catalog, the checks'
	// environment, Exec's environment and its working directory.
	checks  []check
	env     func(parse bool) []string
	execEnv []string
	home    string
}

// catalog returns the host's catalog.
func (d *Diagnostics) catalog() []check {
	if d.checks != nil {
		return d.checks
	}
	return catalog
}

// cmdEnv is the checks' command environment.
func (d *Diagnostics) cmdEnv(parse bool) []string {
	if d.env != nil {
		return d.env(parse)
	}
	return env(parse)
}

// New returns the host's diagnostics. inspect may be nil.
func New(inspect func(context.Context, proto.InspectRequest) proto.InspectResponse, log *slog.Logger) *Diagnostics {
	if log == nil {
		log = slog.Default()
	}
	return &Diagnostics{
		Inspect:    inspect,
		Log:        log,
		run:        runReal,
		lookPath:   lookPath,
		initSystem: services.InitSystem(),
		pkgManager: pkgs.Detect,
		sandboxed:  underSystemd(),
		now:        time.Now,
		shell:      "/bin/sh",
	}
}

// underSystemd reports whether the agent runs as a systemd service (and
// may be sandboxed), like the broker's check.
func underSystemd() bool {
	_, err := os.Stat("/usr/bin/systemd-run")
	return os.Getenv("INVOCATION_ID") != "" && err == nil
}

var binDirs = []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"}

// lookPath finds a tool in the clean PATH the checks run with (the
// agent's own PATH may lack sbin).
func lookPath(name string) (string, error) {
	for _, d := range binDirs {
		p := filepath.Join(d, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil && filepath.IsAbs(p) {
		return p, nil
	}
	return "", fmt.Errorf("%s is not installed", name)
}

// Run implements agent.Diagnostics: one check, or the catalog for
// proto.DiagnoseList.
func (d *Diagnostics) Run(ctx context.Context, req proto.DiagnoseRequest) proto.DiagnoseResponse {
	if req.Check == proto.DiagnoseList {
		if len(req.Args) > 0 {
			return proto.DiagnoseResponse{Code: CodeInvalid, Message: `check "list" takes no arguments`}
		}
		return proto.DiagnoseResponse{Checks: d.Catalog()}
	}
	c := d.findCheck(req.Check)
	if c == nil {
		return proto.DiagnoseResponse{Code: CodeUnsupported, Message: fmt.Sprintf("unknown check %q (check %q lists them)", req.Check, proto.DiagnoseList)}
	}
	if why := c.missing(d); why != "" {
		return proto.DiagnoseResponse{Code: CodeUnsupported, Message: fmt.Sprintf("check %q is not available on this host: %s", c.name, why)}
	}
	a, err := c.parseArgs(d, req.Args)
	if err != nil {
		return errResponse(err)
	}
	ctx, cancel := context.WithTimeout(ctx, CheckTimeout)
	defer cancel()
	steps, err := c.plan(ctx, d, a)
	if err != nil {
		return errResponse(err)
	}
	return d.runSteps(ctx, steps, c.tail)
}

// Catalog returns the checks this host can run.
func (d *Diagnostics) Catalog() []proto.DiagnoseCheck {
	var out []proto.DiagnoseCheck
	for _, c := range d.catalog() {
		if c.missing(d) != "" {
			continue
		}
		dc := proto.DiagnoseCheck{Name: c.name, Description: c.desc}
		for _, a := range c.args {
			dc.Args = append(dc.Args, proto.DiagnoseArg{Name: a.name, Description: a.desc, Required: a.required})
		}
		out = append(out, dc)
	}
	return out
}

// ---- checks and arguments ----------------------------------------------------------

// check is one entry of the catalog.
type check struct {
	name, desc string
	args       []arg
	// tail keeps the end of long output (logs) instead of its start.
	tail bool
	// needs: the host must have one of each group (a tool name, or a path
	// starting with "/"); avail adds conditions tools cannot express.
	needs [][]string
	avail func(d *Diagnostics) string // "" = available, else why not
	plan  func(ctx context.Context, d *Diagnostics, a args) ([]step, error)
}

// arg is one argument of a check. parse validates the hub's value and
// returns it normalized ("" counts as absent).
type arg struct {
	name, desc string
	required   bool
	parse      func(d *Diagnostics, v string) (string, error)
}

// args are a check's validated arguments.
type args map[string]string

func (a args) has(k string) bool { return a[k] != "" }

func (d *Diagnostics) findCheck(name string) *check {
	cat := d.catalog()
	for i := range cat {
		if cat[i].name == name {
			return &cat[i]
		}
	}
	return nil
}

// missing returns why the check cannot run here ("" when it can).
func (c *check) missing(d *Diagnostics) string {
	for _, group := range c.needs {
		if !slices.ContainsFunc(group, d.has) {
			if len(group) == 1 {
				return describeNeed(group[0])
			}
			if strings.HasPrefix(group[0], "/") {
				return "none of " + strings.Join(group, ", ") + " exists"
			}
			return "none of " + strings.Join(group, ", ") + " is installed"
		}
	}
	if c.avail != nil {
		return c.avail(d)
	}
	return ""
}

func describeNeed(n string) string {
	if strings.HasPrefix(n, "/") {
		return n + " does not exist"
	}
	return n + " is not installed"
}

// has reports whether a tool is installed, or a path ("/...") exists.
func (d *Diagnostics) has(n string) bool {
	if strings.HasPrefix(n, "/") {
		return d.exists(n)
	}
	_, err := d.lookPath(n)
	return err == nil
}

func (d *Diagnostics) path(p string) string {
	if d.root == "" {
		return p
	}
	return filepath.Join(d.root, p)
}

func (d *Diagnostics) exists(p string) bool {
	_, err := os.Stat(d.path(p))
	return err == nil
}

func (d *Diagnostics) readFile(p string) ([]byte, error) { return os.ReadFile(d.path(p)) }

func (d *Diagnostics) isUnraid() bool { return d.exists("/etc/unraid-version") }

// journald reports whether the host logs to the systemd journal.
func (d *Diagnostics) journald() bool {
	return d.initSystem == services.Systemd && d.has("journalctl")
}

func (c *check) parseArgs(d *Diagnostics, in map[string]string) (args, error) {
	out := args{}
	var unknown []string
	for k := range in {
		if !slices.ContainsFunc(c.args, func(a arg) bool { return a.name == k }) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		takes := "no arguments"
		if len(c.args) > 0 {
			var names []string
			for _, a := range c.args {
				names = append(names, a.name)
			}
			takes = strings.Join(names, ", ")
		}
		return nil, invalidf("check %q has no argument %s (it takes %s)", c.name, quoteList(unknown), takes)
	}
	for _, a := range c.args {
		v := strings.TrimSpace(in[a.name])
		if v == "" {
			if a.required {
				return nil, invalidf("check %q needs the argument %q (%s)", c.name, a.name, a.desc)
			}
			continue
		}
		if strings.ContainsFunc(v, isControl) {
			return nil, invalidf("%s: control characters are not allowed", a.name)
		}
		n, err := a.parse(d, v)
		if err != nil {
			return nil, invalidf("%s: %v", a.name, err)
		}
		out[a.name] = n
	}
	return out, nil
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

func quoteList(s []string) string {
	q := make([]string, len(s))
	for i, v := range s {
		q[i] = fmt.Sprintf("%q", v)
	}
	return strings.Join(q, ", ")
}

// reqError is a refusal with its code.
type reqError struct{ code, msg string }

func (e *reqError) Error() string { return e.msg }

func invalidf(format string, a ...any) error {
	return &reqError{CodeInvalid, fmt.Sprintf(format, a...)}
}

func errResponse(err error) proto.DiagnoseResponse {
	var re *reqError
	if errors.As(err, &re) {
		return proto.DiagnoseResponse{Code: re.code, Message: re.msg}
	}
	return proto.DiagnoseResponse{Code: CodeFailed, Message: err.Error()}
}

// inspectView asks the broker's inspect view (or the packages directly).
func (d *Diagnostics) inspectView(ctx context.Context, kind string, limit int) (proto.InspectResponse, error) {
	var resp proto.InspectResponse
	if d.Inspect != nil {
		resp = d.Inspect(ctx, proto.InspectRequest{Kind: kind, Platform: proto.PlatformHost, GuestID: "host", Limit: limit})
	} else {
		var err error
		switch kind {
		case proto.InspectProcesses:
			resp.Processes, resp.Truncated, err = inspect.Processes(ctx, inspect.ProcOptions{Limit: limit})
		case proto.InspectPorts:
			resp.Ports, resp.Truncated, err = inspect.Ports(ctx, inspect.PortOptions{Limit: limit})
		case proto.InspectUpdates:
			_, resp.Updates, err = pkgs.List(ctx)
		default:
			err = fmt.Errorf("no %s view", kind)
		}
		if err != nil {
			return resp, err
		}
	}
	if resp.Code != "" {
		if resp.Message != "" {
			return resp, errors.New(resp.Message)
		}
		return resp, errors.New(resp.Code)
	}
	return resp, nil
}
