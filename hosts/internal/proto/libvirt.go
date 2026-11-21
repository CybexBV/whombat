package proto

// libvirt host view (docs/MANAGE.md 2.7, CONTRACT.md "libvirt"): the
// storage pools, networks, unRAID's VM folders, what the host's QEMU can
// give a new VM and where Whombat's VM backups go. The agent reads it every
// 5 minutes and again after a change it made; it rides on
// Report.Libvirt.Libvirt (Platform.Libvirt).
type LibvirtDetail struct {
	QEMU     string           `cbor:"qemu,omitempty"` // QEMU's version: "10.1.0"
	Pools    []LibvirtPool    `cbor:"pools,omitempty"`
	Networks []LibvirtNetwork `cbor:"networks,omitempty"`
	// Folders: unRAID's VM Manager folders (/boot/config/domain.cfg
	// DOMAINDIR, MEDIADIR) where there are no pools; nil elsewhere.
	Folders  *LibvirtFolders `cbor:"folders,omitempty"`
	Firmware LibvirtFirmware `cbor:"firmware"`
	// BackupsDir: where backup.create writes (agent.toml [libvirt]
	// backups_dir, default <domains folder or first dir pool>/.whombat-backups).
	BackupsDir string `cbor:"backups_dir,omitempty"`
}

// LibvirtPool is a storage pool with its usage.
type LibvirtPool struct {
	Name       string `cbor:"name"`
	Type       string `cbor:"type"` // dir | logical | zfs | netfs | ...
	Active     bool   `cbor:"active"`
	Autostart  bool   `cbor:"autostart,omitempty"`
	Path       string `cbor:"path,omitempty"` // target path
	UsedBytes  uint64 `cbor:"used,omitempty"`
	TotalBytes uint64 `cbor:"total,omitempty"`
	AvailBytes uint64 `cbor:"avail,omitempty"`
	Volumes    int    `cbor:"volumes"` // disk images and ISOs (not directories)
}

// LibvirtNetwork is a libvirt network.
type LibvirtNetwork struct {
	Name      string `cbor:"name"`
	Active    bool   `cbor:"active"`
	Autostart bool   `cbor:"autostart,omitempty"`
	Bridge    string `cbor:"bridge,omitempty"`
	Forward   string `cbor:"forward,omitempty"` // nat | route | bridge | open | none ...
	IPv4      string `cbor:"ipv4,omitempty"`    // "192.168.122.1/24"
	DHCP      bool   `cbor:"dhcp,omitempty"`
	UsedBy    int    `cbor:"used_by"` // network cards of defined VMs on it
}

// LibvirtFolders are unRAID's VM folders (absolute paths, "" = not set).
type LibvirtFolders struct {
	Domains string `cbor:"domains,omitempty" json:"domains"`
	ISOs    string `cbor:"isos,omitempty" json:"isos"`
}

// LibvirtFirmware is what the host's QEMU can give a new VM: UEFI (OVMF),
// Secure Boot (a secure OVMF build) and a TPM (swtpm).
type LibvirtFirmware struct {
	UEFI       bool `cbor:"uefi,omitempty" json:"uefi"`
	SecureBoot bool `cbor:"secure_boot,omitempty" json:"secure_boot"`
	TPM        bool `cbor:"tpm,omitempty" json:"tpm"`
}

// OSVariant is an OS type a new libvirt VM starts from (Choices.OSVariants):
// its firmware and whether it needs a TPM (Windows 11).
type OSVariant struct {
	ID       string `cbor:"id" json:"id"`
	Label    string `cbor:"label" json:"label"`
	Firmware string `cbor:"firmware" json:"firmware"` // bios | uefi
	TPM      bool   `cbor:"tpm,omitempty" json:"tpm"`
}

// Storage ids of unRAID's VM folders where a pool name goes (storage of
// create, clone, restore, content.list and content.download).
const (
	LibvirtDomainsFolder = "folder:domains"
	LibvirtISOsFolder    = "folder:isos"
)
