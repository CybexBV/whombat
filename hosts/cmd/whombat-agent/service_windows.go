package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"rackoon/internal/agent"
	"rackoon/internal/agent/winpc"
)

// isRoot: the commands that change the agent's own settings run elevated
// (PowerShell opened as administrator), or as the service itself.
func isRoot() bool { return windows.GetCurrentProcessToken().IsElevated() }

// agentCommand is how PowerShell runs the installed agent: it isn't on the
// PATH, install.ps1 leaves the PATH alone.
const agentCommand = `& "$env:ProgramFiles\Whombat\whombat-agent.exe"`

// asRoot is how to run cmd ("whombat-agent policy set full") as an
// administrator.
func asRoot(cmd string) string {
	return "an administrator: in PowerShell opened as administrator, run " +
		agentCommand + strings.TrimPrefix(cmd, "whombat-agent")
}

// prepareDirs keeps the agent to %ProgramData%\Whombat, the one folder it
// keeps safe, before it reads or writes anything there: its settings
// folder (dir) and its state folder (stateDir, or the one dir's agent.toml
// names) must be in it, and the folder is made the agent's own, with
// whatever someone else could have written moved aside (winpc.PrepareDataDir).
// The person hears what was moved: on the screen, and in Windows'
// Application log for the service.
func prepareDirs(dir, stateDir string) error {
	moved, err := winpc.PrepareDataDir(agent.WindowsDataDir, dir, stateDir, configuredStateDir)
	for _, m := range moved {
		msg := fmt.Sprintf("Someone else could change %s, so the Whombat agent moved it to %s and doesn't use it.", m.From, m.To)
		fmt.Fprintln(os.Stderr, msg)
		eventLog(windows.EVENTLOG_WARNING_TYPE, msg)
	}
	return err
}

// configuredStateDir is the state folder dir's agent.toml names.
func configuredStateDir(dir string) (string, bool) {
	cfg, err := agent.LoadConfig(dir)
	if err != nil {
		return "", false
	}
	return cfg.StateDir, true
}

// ownWrites makes the administrators the owner of every file and folder
// this process makes. The agent trusts only what SYSTEM or the
// administrators own (winpc), and where Windows gives what an
// administrator makes to that administrator's own account instead (its
// policy “Default owner for objects created by members of the
// Administrators group”), the settings `policy set` writes would otherwise
// be moved aside at the service's next start. Without administrator
// rights it changes nothing.
func ownWrites() {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_QUERY, &tok); err != nil {
		return
	}
	defer tok.Close()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return
	}
	owner := struct{ Owner *windows.SID }{admins} // TOKEN_OWNER
	_ = windows.SetTokenInformation(tok, windows.TokenOwner, (*byte)(unsafe.Pointer(&owner)), uint32(unsafe.Sizeof(owner)))
}

// openService opens the agent's service; nil, nil when there is none.
func openService() (*mgr.Mgr, *mgr.Service, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, nil, fmt.Errorf("cannot reach the service manager: %w", err)
	}
	s, err := m.OpenService(serviceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		m.Disconnect()
		return nil, nil, nil
	}
	if err != nil {
		m.Disconnect()
		return nil, nil, err
	}
	return m, s, nil
}

// serviceRunning: the agent's service exists and runs.
func serviceRunning() (bool, error) {
	m, s, err := openService()
	if err != nil || s == nil {
		return false, err
	}
	defer m.Disconnect()
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return false, err
	}
	return st.State == svc.Running, nil
}

// restartAgent restarts the agent's service after its hub changed. false:
// it doesn't run, the change applies when it starts.
func restartAgent(dir string) (bool, error) {
	if filepath.Clean(dir) != filepath.Clean(agent.DefaultConfigDir) {
		return false, nil
	}
	if up, err := serviceRunning(); err != nil || !up {
		return false, err
	}
	if err := stopService(); err != nil {
		return false, fmt.Errorf("stopping the service failed: %w", err)
	}
	if err := startService(); err != nil {
		return false, fmt.Errorf("starting the service failed: %w", err)
	}
	return true, nil
}

// reloadAgent makes the agent's service read agent.toml again. false: it
// doesn't run, the change applies when it starts.
func reloadAgent(dir string) (bool, error) {
	if filepath.Clean(dir) != filepath.Clean(agent.DefaultConfigDir) {
		return false, nil
	}
	m, s, err := openService()
	if err != nil || s == nil {
		return false, err
	}
	defer m.Disconnect()
	defer s.Close()
	if st, err := s.Query(); err != nil || st.State != svc.Running {
		return false, err
	}
	if _, err := s.Control(svc.ParamChange); err != nil {
		return false, fmt.Errorf("asking the service to reload: %w", err)
	}
	return true, nil
}

// waitState waits up to timeout for the service to reach want.
func waitState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the service didn't get there in %s", timeout)
		}
		<-tick.C
	}
}

func stopService() error {
	m, s, err := openService()
	if err != nil || s == nil {
		return err
	}
	defer m.Disconnect()
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil {
			return err
		}
	}
	return waitState(s, svc.Stopped, 30*time.Second)
}

func startService() error {
	m, s, err := openService()
	if err != nil {
		return err
	}
	if s == nil {
		return errors.New("the agent's service isn't installed (whombat-agent service install)")
	}
	defer m.Disconnect()
	defer s.Close()
	if err := s.Start(); err != nil {
		return err
	}
	return waitState(s, svc.Running, 30*time.Second)
}

// serviceRecovery restarts a failed agent: after 5 s, 10 s, then every
// 30 s; the count starts again after a day without failures.
var serviceRecovery = []mgr.RecoveryAction{
	{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
	{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
}

const serviceResetPeriod = 24 * 60 * 60 // seconds

// installService registers (or updates) the agent's service: it starts
// at boot, runs as LocalSystem (root, as on Linux) and is started again
// when it fails or ends to restart.
func installService(exe, dir string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("cannot reach the service manager: %w", err)
	}
	defer m.Disconnect()
	args := []string{"run"}
	if filepath.Clean(dir) != filepath.Clean(agent.DefaultConfigDir) {
		args = append(args, "--config-dir", dir)
	}
	conf := mgr.Config{
		StartType:   mgr.StartAutomatic,
		DisplayName: "Whombat agent",
		Description: "Tells Whombat how this PC is doing and does what you allow from there.",
	}
	s, err := m.OpenService(serviceName)
	switch {
	case err == nil:
		old, err := s.Config()
		if err != nil {
			s.Close()
			return err
		}
		old.StartType, old.DisplayName, old.Description = conf.StartType, conf.DisplayName, conf.Description
		old.BinaryPathName = commandLine(exe, args)
		old.ServiceStartName = "LocalSystem"
		if err := s.UpdateConfig(old); err != nil {
			s.Close()
			return fmt.Errorf("updating the service: %w", err)
		}
	case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
		s, err = m.CreateService(serviceName, exe, conf, args...)
		if err != nil {
			return fmt.Errorf("creating the service: %w", err)
		}
	default:
		return err
	}
	defer s.Close()
	if err := s.SetRecoveryActions(serviceRecovery, serviceResetPeriod); err != nil {
		return fmt.Errorf("setting the service's recovery: %w", err)
	}
	// An agent that ends with an error code (an update's restart) is
	// started again too, not only one that crashes.
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("setting the service's recovery: %w", err)
	}
	return nil
}

// commandLine is exe and args as the service manager runs them.
func commandLine(exe string, args []string) string {
	parts := []string{windows.EscapeArg(exe)}
	for _, a := range args {
		parts = append(parts, windows.EscapeArg(a))
	}
	return strings.Join(parts, " ")
}

// removeService stops and deletes the agent's service. false: there was
// none.
func removeService() (bool, error) {
	if err := stopService(); err != nil {
		return false, fmt.Errorf("stopping the service: %w", err)
	}
	m, s, err := openService()
	if err != nil || s == nil {
		return false, err
	}
	defer m.Disconnect()
	defer s.Close()
	if err := s.Delete(); err != nil {
		return false, fmt.Errorf("deleting the service: %w", err)
	}
	return true, nil
}

func serviceUsage() string {
	return `
  whombat-agent service install|start|stop|restart|remove [--config-dir DIR]
                             as administrator: the agent's Windows service
  whombat-agent uninstall [--purge]
                             as administrator: remove the agent from this PC (--purge: its identity too)`
}

// cmdService manages the agent's Windows service (install.ps1 runs
// `service install` and `service start`).
func cmdService(args []string) error {
	if len(args) == 0 {
		return errors.New("service needs install, start, stop, restart or remove")
	}
	fs := flag.NewFlagSet("service", flag.ExitOnError)
	dir := fs.String("config-dir", agent.DefaultConfigDir, "configuration directory")
	fs.Parse(args[1:])
	if !isRoot() {
		return fmt.Errorf("this changes the agent's service, so run it as %s", asRoot("whombat-agent service "+args[0]))
	}
	switch args[0] {
	case "install":
		exe, err := agent.ExecutablePath()
		if err != nil {
			return err
		}
		if err := prepareDirs(*dir, ""); err != nil {
			return err
		}
		return installService(exe, *dir)
	case "start":
		return startService()
	case "stop":
		return stopService()
	case "restart":
		if err := stopService(); err != nil {
			return err
		}
		return startService()
	case "remove":
		_, err := removeService()
		return err
	}
	return fmt.Errorf("unknown service command %q", args[0])
}

// cmdUninstall removes the agent from this PC: its service, its program
// folder and its state. Its identity (the key and certificate in
// %ProgramData%\Whombat\agent) stays unless --purge, as install.sh
// --uninstall does elsewhere.
func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	purge := fs.Bool("purge", false, "also remove the agent's identity")
	fs.Parse(args)
	if !isRoot() {
		return fmt.Errorf("this removes the agent, so run it as %s", asRoot("whombat-agent uninstall"))
	}
	if _, err := removeService(); err != nil {
		return err
	}
	exe, err := agent.ExecutablePath()
	if err != nil {
		return err
	}
	if err := removeProgram(exe); err != nil {
		return err
	}
	for _, p := range []string{agent.DefaultStateDir, filepath.Join(agent.WindowsDataDir, "logs")} {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	if *purge {
		if err := os.RemoveAll(agent.WindowsDataDir); err != nil {
			return err
		}
		fmt.Println("Agent and identity removed. Delete the PC in Whombat to revoke its certificate.")
		return nil
	}
	fmt.Println(`Agent removed; its identity stays in ` + agent.DefaultConfigDir + ` (uninstall --purge removes it). Delete the PC in Whombat to revoke it.`)
	return nil
}

// removeProgram removes the agent's program folder. The running
// executable can't be deleted, but it can move: to Windows' own temporary
// folder, from where it goes at the next restart.
func removeProgram(exe string) error {
	dir := filepath.Dir(exe)
	if !strings.EqualFold(filepath.Base(dir), "Whombat") {
		// Not install.ps1's folder: leave the person's own place alone.
		return nil
	}
	tmp := filepath.Join(os.Getenv("SystemRoot"), "Temp", fmt.Sprintf("whombat-agent-%d.exe", time.Now().UnixNano()))
	if err := os.Rename(exe, tmp); err == nil {
		if p, err := windows.UTF16PtrFromString(tmp); err == nil {
			_ = windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
		}
	}
	return os.RemoveAll(dir)
}
