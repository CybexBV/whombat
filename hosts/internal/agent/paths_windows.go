package agent

import (
	"os"
	"path/filepath"
)

// Default locations on Windows: everything the agent keeps is under
// %ProgramData%\Whombat, which the installer and the agent keep to SYSTEM and
// the administrators (winpc.SecureDataDir), with the executable in
// %ProgramFiles%\Whombat.
var (
	DefaultConfigDir = filepath.Join(WindowsDataDir, "agent")
	DefaultStateDir  = filepath.Join(WindowsDataDir, "state")
)

// WindowsDataDir is %ProgramData%\Whombat.
var WindowsDataDir = filepath.Join(programData(), "Whombat")

func programData() string {
	if p := os.Getenv("ProgramData"); p != "" && filepath.IsAbs(p) {
		return p
	}
	return `C:\ProgramData`
}
