package winpc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The agent reads what Windows only says through its management interfaces
// (Defender, Security Center, BitLocker, the storage stack, Windows Update)
// with fixed PowerShell scripts built into the agent: Windows PowerShell 5.1
// is on every supported Windows, and its CIM and COM support keep the agent
// free of cgo. A script is written to the agent's state folder, which only
// SYSTEM and the administrators can change, and run from there by a short
// -Command, so the machine's script execution policy doesn't apply and no
// encoded command line is needed.

// errNotWindows: the scripts run on Windows only.
var errNotWindows = errors.New("not a Windows PC")

// maxScriptOutput bounds what a script may print.
const maxScriptOutput = 4 << 20

// SystemRoot is %SystemRoot% (C:\Windows).
func SystemRoot() string {
	if p := os.Getenv("SystemRoot"); p != "" && filepath.IsAbs(p) {
		return p
	}
	return `C:\Windows`
}

// PowerShellPath is Windows PowerShell 5.1, by its full path.
func PowerShellPath() string {
	return filepath.Join(SystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

// psQuote quotes s for a single-quoted PowerShell string. PowerShell also
// takes the typographic single quotes (‘ ’ ‚ ‛) as quotes, so each is
// doubled like the plain one.
func psQuote(s string) string {
	var b strings.Builder
	b.WriteByte('\'')
	for _, r := range s {
		switch r {
		case '\'', '\u2018', '\u2019', '\u201a', '\u201b':
			b.WriteRune(r)
		}
		b.WriteRune(r)
	}
	b.WriteByte('\'')
	return b.String()
}

// scriptCommand is the -Command that runs a script file without the
// execution policy: its text as a script block.
func scriptCommand(path string) string {
	return "& ([scriptblock]::Create([IO.File]::ReadAllText(" + psQuote(path) + ")))"
}

// runScript writes script to dir/name and runs it, returning what it
// printed on stdout.
func runScript(ctx context.Context, dir, name, script string, timeout time.Duration) ([]byte, error) {
	if runtime.GOOS != "windows" {
		return nil, errNotWindows
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name)
	if b, err := os.ReadFile(path); err != nil || string(b) != script {
		if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, PowerShellPath(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", scriptCommand(path))
	cmd.Dir = SystemRoot()
	var out, errb limitedBuffer
	out.max, errb.max = maxScriptOutput, 4096
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("%s took longer than %s", name, timeout)
	}
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s: %s", name, clip(msg, 300))
	}
	return out.Bytes(), nil
}

// limitedBuffer keeps the first max bytes written.
type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func itoa(n int) string { return strconv.Itoa(n) }
