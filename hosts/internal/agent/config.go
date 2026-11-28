package agent

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"

	"rackoon/internal/proto"
)

// ConfigFileName is the agent's configuration in its configuration
// directory (DefaultConfigDir: paths_unix.go, paths_windows.go).
const ConfigFileName = "agent.toml"

// Config is /etc/whombat-agent/agent.toml. Remote control is decided here, on the
// host: the hub cannot turn it on remotely.
type Config struct {
	// Hub is the hub's agent endpoint, e.g. "wss://10.100.0.6:8443".
	Hub string `toml:"hub"`
	// CASHA256 pins the hub's CA certificate (hex SHA-256 of its DER).
	CASHA256 string `toml:"ca_sha256"`
	// StateDir holds the offline sample buffer.
	StateDir string `toml:"state_dir"`

	RemoteControl RemoteControl `toml:"remote_control"`
	Update        UpdateConfig  `toml:"update"`
	Collectors    Collectors    `toml:"collectors"`
	PVE           PVEConfig     `toml:"pve"`
	Libvirt       LibvirtConfig `toml:"libvirt"`

	// Dir is the directory the config was loaded from (key, certs live here).
	Dir string `toml:"-"`
}

// RemoteControl is the local opt-in for consoles and power actions. Every
// switch but Diagnose is off unless set in agent.toml.
type RemoteControl struct {
	// Console: guest consoles and screenshots, Docker container shells and
	// logs, the host's journal and its process, port, service and package
	// lists (inspect).
	Console bool `toml:"console"`
	// Power: guest power actions (incl. pause / resume) and snapshots.
	Power bool `toml:"power"`
	// HostShell: a root login shell on the host itself. Console does not
	// imply it.
	HostShell bool `toml:"host_shell"`
	// HostPower: reboot and shut down the host itself.
	HostPower bool `toml:"host_power"`
	// Manage: change guests' configuration, create, clone, back up,
	// restore and delete guests, storage content (Proxmox VE, Incus). On
	// Proxmox VE the agent then creates a second API token with a limited
	// role (docs/MANAGE.md) and removes it again when this is off.
	Manage bool `toml:"manage"`
	// Diagnose: the read-only checks the hub's assistant runs (logs,
	// SMART, arrays, services, ...; docs/ASSIST.md 3.1). Unlike the other
	// switches it is on when absent, at the owner's request (the
	// assistant only uses it while an admin has turned the assistant on);
	// false turns it off. Its shell commands need HostShell.
	Diagnose *bool `toml:"diagnose"`
}

// UpdateConfig is [update]: signed self-updates pushed by the hub.
type UpdateConfig struct {
	// Allow accepts updates (default true). They also need a binary built
	// with an update key (UpdatePublicKey); without one, self-update is off.
	Allow *bool `toml:"allow"`
}

// Collectors toggles optional collectors. nil means auto-detect (enabled
// when the platform's socket / API / tool is present). They are applied
// on reload (SIGHUP) without a restart.
type Collectors struct {
	Docker  *bool `toml:"docker"`
	Incus   *bool `toml:"incus"`
	Libvirt *bool `toml:"libvirt"`
	PVE     *bool `toml:"pve"`
	SMART   *bool `toml:"smart"`
	// Updates: pending package updates from the package manager's cache
	// (apt-get -s, dnf --cacheonly, ...) every 6 hours. Default on.
	Updates *bool `toml:"updates"`
	// UPS: NUT (upsc) and apcupsd (apcaccess) when installed.
	UPS *bool `toml:"ups"`
	// GPU: nvidia-smi and amdgpu / i915 sysfs when present.
	GPU *bool `toml:"gpu"`
	// ImageUpdates: compare running containers' image digests with their
	// registry (anonymous HEAD requests, at most every 12 hours per image).
	// Default on; the only collector that contacts the internet.
	ImageUpdates *bool `toml:"image_updates"`
}

// PVEConfig configures the Proxmox VE collector.
type PVEConfig struct {
	// URL of the local API, default "https://127.0.0.1:8006/api2/json".
	URL string `toml:"url"`
	// TokenFile holds "USER@REALM!TOKENID=SECRET" for a read-only
	// (PVEAuditor) API token. Default /etc/whombat-agent/pve-token. When missing
	// and the agent runs as root on a PVE node, the agent creates the user
	// whombat@pve and the token itself.
	TokenFile string `toml:"token_file"`
	// ManageTokenFile holds the token of whombat-manage@pve, which the
	// agent creates while [remote_control] manage is on and removes when it
	// is off (docs/MANAGE.md 2.2). Default /etc/whombat-agent/pve-manage-token.
	ManageTokenFile string `toml:"manage_token_file"`
}

// LibvirtConfig configures managing libvirt VMs (docs/MANAGE.md 2.7).
type LibvirtConfig struct {
	// BackupsDir is where Whombat's VM backups go (one folder per VM, one
	// per backup). Default: <unRAID's domains folder or the first
	// directory pool>/.whombat-backups.
	BackupsDir string `toml:"backups_dir"`
}

// Enabled resolves a collector toggle: explicit setting, else detected.
func Enabled(toggle *bool, detected bool) bool {
	if toggle != nil {
		return *toggle
	}
	return detected
}

// LoadConfig reads dir/agent.toml and applies defaults.
func LoadConfig(dir string) (*Config, error) {
	c := &Config{Dir: dir}
	b, err := os.ReadFile(filepath.Join(dir, ConfigFileName))
	if err != nil {
		return nil, err
	}
	if err := toml.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("%s: %w", ConfigFileName, err)
	}
	c.Dir = dir
	c.applyDefaults()
	return c, nil
}

// Save writes the config to Dir/agent.toml (mode 0600).
func (c *Config) Save() error {
	b, err := toml.Marshal(c)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(c.Dir, ConfigFileName), b, 0o600)
}

func (c *Config) applyDefaults() {
	if c.StateDir == "" {
		c.StateDir = DefaultStateDir
	}
	if c.PVE.URL == "" {
		c.PVE.URL = "https://127.0.0.1:8006/api2/json"
	}
	if c.PVE.TokenFile == "" {
		c.PVE.TokenFile = filepath.Join(c.Dir, "pve-token")
	}
	if c.PVE.ManageTokenFile == "" {
		c.PVE.ManageTokenFile = filepath.Join(c.Dir, "pve-manage-token")
	}
}

// Paths of the agent's identity files inside Config.Dir.
func (c *Config) KeyPath() string  { return filepath.Join(c.Dir, "agent.key") }
func (c *Config) CertPath() string { return filepath.Join(c.Dir, "agent.crt") }
func (c *Config) CAPath() string   { return filepath.Join(c.Dir, "ca.crt") }

// Policy returns the local remote-control policy as reported to the hub.
func (c *Config) Policy() proto.Policy {
	return proto.Policy{
		Console:   c.RemoteControl.Console,
		Power:     c.RemoteControl.Power,
		HostShell: c.RemoteControl.HostShell,
		HostPower: c.RemoteControl.HostPower,
		Update:    c.UpdateAllowed(),
		Manage:    c.RemoteControl.Manage,
		Diagnose:  c.DiagnoseAllowed(),
	}
}

// DiagnoseAllowed reports whether the assistant's read-only checks are
// allowed: [remote_control] diagnose, default true.
func (c *Config) DiagnoseAllowed() bool {
	return c.RemoteControl.Diagnose == nil || *c.RemoteControl.Diagnose
}

// UpdateAllowed reports whether the agent accepts signed updates: [update]
// allow (default true) and an update key built into the binary.
func (c *Config) UpdateAllowed() bool {
	return (c.Update.Allow == nil || *c.Update.Allow) && UpdateKeyFingerprint() != ""
}
