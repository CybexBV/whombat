package broker

import (
	"io"

	libvirt "github.com/digitalocean/go-libvirt"
)

// LibvirtConn is the part of go-libvirt's client the libvirt manager and
// the host view use (*libvirt.Libvirt implements it). Tests and the
// simulator use an in-memory libvirt instead (package lvfake).
type LibvirtConn interface {
	Disconnect() error
	ConnectGetLibVersion() (uint64, error)
	ConnectGetVersion() (uint64, error)
	ConnectGetDomainCapabilities(Emulatorbin libvirt.OptString, Arch libvirt.OptString, Machine libvirt.OptString, Virttype libvirt.OptString, Flags libvirt.ConnectGetDomainCapabilitiesFlags) (string, error)

	ConnectListAllDomains(NeedResults int32, Flags libvirt.ConnectListAllDomainsFlags) ([]libvirt.Domain, uint32, error)
	DomainLookupByName(Name string) (libvirt.Domain, error)
	DomainGetXMLDesc(Dom libvirt.Domain, Flags libvirt.DomainXMLFlags) (string, error)
	DomainGetState(Dom libvirt.Domain, Flags uint32) (int32, int32, error)
	DomainDefineXMLFlags(XML string, Flags libvirt.DomainDefineFlags) (libvirt.Domain, error)
	DomainUndefineFlags(Dom libvirt.Domain, Flags libvirt.DomainUndefineFlagsValues) error
	DomainCreate(Dom libvirt.Domain) error
	DomainRename(Dom libvirt.Domain, NewName libvirt.OptString, Flags uint32) (int32, error)
	DomainUpdateDeviceFlags(Dom libvirt.Domain, XML string, Flags libvirt.DomainDeviceModifyFlags) error
	DomainSetMemoryFlags(Dom libvirt.Domain, Memory uint64, Flags uint32) error
	DomainSetVcpusFlags(Dom libvirt.Domain, Nvcpus uint32, Flags uint32) error
	DomainGetAutostart(Dom libvirt.Domain) (int32, error)
	DomainSetAutostart(Dom libvirt.Domain, Autostart int32) error
	DomainSetMetadata(Dom libvirt.Domain, Type int32, Metadata libvirt.OptString, Key libvirt.OptString, Uri libvirt.OptString, Flags libvirt.DomainModificationImpact) error
	DomainBlockResize(Dom libvirt.Domain, Disk string, Size uint64, Flags libvirt.DomainBlockResizeFlags) error
	DomainSnapshotNum(Dom libvirt.Domain, Flags uint32) (int32, error)
	DomainBackupBegin(Dom libvirt.Domain, BackupXML string, CheckpointXML libvirt.OptString, Flags libvirt.DomainBackupBeginFlags) error
	DomainGetJobStats(Dom libvirt.Domain, Flags libvirt.DomainGetJobStatsFlags) (int32, []libvirt.TypedParam, error)
	DomainAbortJob(Dom libvirt.Domain) error

	ConnectListAllStoragePools(NeedResults int32, Flags libvirt.ConnectListAllStoragePoolsFlags) ([]libvirt.StoragePool, uint32, error)
	StoragePoolLookupByName(Name string) (libvirt.StoragePool, error)
	StoragePoolGetXMLDesc(Pool libvirt.StoragePool, Flags libvirt.StorageXMLFlags) (string, error)
	StoragePoolGetInfo(Pool libvirt.StoragePool) (uint8, uint64, uint64, uint64, error)
	StoragePoolGetAutostart(Pool libvirt.StoragePool) (int32, error)
	StoragePoolIsActive(Pool libvirt.StoragePool) (int32, error)
	StoragePoolRefresh(Pool libvirt.StoragePool, Flags uint32) error
	StoragePoolListAllVolumes(Pool libvirt.StoragePool, NeedResults int32, Flags uint32) ([]libvirt.StorageVol, uint32, error)
	StoragePoolCreateXML(XML string, Flags libvirt.StoragePoolCreateFlags) (libvirt.StoragePool, error)
	StoragePoolDestroy(Pool libvirt.StoragePool) error

	StorageVolLookupByName(Pool libvirt.StoragePool, Name string) (libvirt.StorageVol, error)
	StorageVolLookupByPath(Path string) (libvirt.StorageVol, error)
	StorageVolGetInfo(Vol libvirt.StorageVol) (int8, uint64, uint64, error)
	StorageVolGetPath(Vol libvirt.StorageVol) (string, error)
	StorageVolGetXMLDesc(Vol libvirt.StorageVol, Flags uint32) (string, error)
	StorageVolCreateXML(Pool libvirt.StoragePool, XML string, Flags libvirt.StorageVolCreateFlags) (libvirt.StorageVol, error)
	StorageVolCreateXMLFrom(Pool libvirt.StoragePool, XML string, Clonevol libvirt.StorageVol, Flags libvirt.StorageVolCreateFlags) (libvirt.StorageVol, error)
	StorageVolDelete(Vol libvirt.StorageVol, Flags libvirt.StorageVolDeleteFlags) error
	StorageVolResize(Vol libvirt.StorageVol, Capacity uint64, Flags libvirt.StorageVolResizeFlags) error
	StorageVolUpload(Vol libvirt.StorageVol, outStream io.Reader, Offset uint64, Length uint64, Flags libvirt.StorageVolUploadFlags) error

	ConnectListAllNetworks(NeedResults int32, Flags libvirt.ConnectListAllNetworksFlags) ([]libvirt.Network, uint32, error)
	NetworkLookupByName(Name string) (libvirt.Network, error)
	NetworkGetXMLDesc(Net libvirt.Network, Flags uint32) (string, error)
	NetworkGetAutostart(Net libvirt.Network) (int32, error)
	NetworkIsActive(Net libvirt.Network) (int32, error)
	NetworkGetDhcpLeases(Net libvirt.Network, Mac libvirt.OptString, NeedResults int32, Flags uint32) ([]libvirt.NetworkDhcpLease, uint32, error)
}

var _ LibvirtConn = (*libvirt.Libvirt)(nil)

// LibvirtFS reads the host's files for the libvirt manager: unRAID's
// domain.cfg, backups, QEMU logs, the host's bridges and the free space
// of folders. Whombat writes files only through libvirt (the agent's
// sandbox keeps the file system read-only), so this is read-only.
type LibvirtFS interface {
	ReadFile(path string) ([]byte, error)
	// ReadDir lists a directory's entries (names, directories marked).
	ReadDir(path string) ([]LibvirtDirEntry, error)
	// Stat: the size, the space a file takes (blocks) and its time.
	Stat(path string) (LibvirtFileInfo, error)
	// Statfs: total and available bytes of the file system under path.
	Statfs(path string) (total, avail uint64, err error)
	// Exists reports whether a path exists.
	Exists(path string) bool
}

// LibvirtDirEntry is a directory entry.
type LibvirtDirEntry struct {
	Name string
	Dir  bool
}

// LibvirtFileInfo is what Stat tells.
type LibvirtFileInfo struct {
	Size      int64
	UsedBytes uint64 // blocks × 512 (sparse files take less than Size)
	ModTime   int64  // unix seconds
	Dir       bool
}
