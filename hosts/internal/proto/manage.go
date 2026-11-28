package proto

import "time"

// StreamManage (hub-opened): ManageRequest -> ManageResponse. Guest
// configuration and lifecycle on Proxmox VE and Incus: read and change a
// guest's configuration, disks, firewall, HA and replication; create,
// clone, convert to template and delete guests; back up and restore;
// storage content (ISO images, container templates); follow and stop
// tasks. Needs Policy.Manage.
//
// Requests are typed: the hub names an operation, a platform, a guest and
// values, never an API path, a command or a host file path. The agent
// checks every key and value against its own allowlist (docs/MANAGE.md)
// and, on Proxmox VE, sends the change with its own limited API token, so
// PVE refuses root-only settings too.
//
// The same structs carry JSON tags: the hub decodes request bodies into
// ManageRequest and writes ManageResponse parts as its JSON answers.
const StreamManage = "manage"

// Manage operations (ManageRequest.Op). "guest" ops name a guest
// (GuestID); "host" ops act on the platform of the host.
const (
	OpConfigGet = "config.get" // guest -> Config
	OpConfigSet = "config.set" // guest: Digest, Set, Delete, Revert -> Changes (+ Task when PVE still works on it)

	OpDiskResize = "disk.resize" // guest: Disk, Size ("+8G", grow only) -> Task
	OpDiskMove   = "disk.move"   // guest: Disk, Storage, DeleteSource -> Task

	OpChoices = "choices" // host -> Choices (storages, bridges, ISO images, templates, next id, ...)

	OpCreate   = "guest.create"   // host: Kind, NewID, Name, Set, Start (+ Image, Profiles on Incus) -> Task, NewID
	OpClone    = "guest.clone"    // guest: NewID, Name, Full, Storage -> Task, NewID
	OpTemplate = "guest.template" // guest -> Task (PVE: the guest becomes a template)
	OpDelete   = "guest.delete"   // guest: Purge -> Task
	// OpMigrate moves a guest to another node of its Proxmox VE cluster:
	// running VMs live (online, local disks copied), running containers
	// with a restart, stopped guests offline. Target is the node, Storage
	// an optional target storage, Digest the configuration it was decided
	// on. Needs VM.Migrate on the manage token.
	OpMigrate = "guest.migrate" // guest: Target, Storage, Digest -> Task

	OpBackupList    = "backup.list"    // guest -> Backups (every backup storage of the node)
	OpBackupCreate  = "backup.create"  // guest: Storage, Mode, Compress, Notes, Protected -> Task
	OpBackupRestore = "backup.restore" // host: Volume, NewID | GuestID (overwrite), Storage, Start, Unique -> Task, NewID
	OpBackupUpdate  = "backup.update"  // host: Volume, Notes, Protected
	OpBackupDelete  = "backup.delete"  // host: Volume -> Task (or done)

	OpContentList     = "content.list"     // host: Storage, Content (iso | vztmpl | import) -> Content
	OpContentDownload = "content.download" // host: Storage, Content, URL, Filename, Checksum, ChecksumAlgorithm -> Task
	OpContentDelete   = "content.delete"   // host: Volume -> Task (or done)

	OpApplianceList     = "appliance.list"     // host -> Appliances (container templates offered by Proxmox)
	OpApplianceDownload = "appliance.download" // host: Storage, Template -> Task

	OpTaskList   = "task.list"   // guest (its tasks) or host -> Tasks, newest first
	OpTaskStatus = "task.status" // host: Task, LogStart (-1: no log) -> TaskStatus
	OpTaskStop   = "task.stop"   // host: Task

	OpFirewallGet        = "firewall.get"         // guest -> Firewall
	OpFirewallOptions    = "firewall.options"     // guest: Digest, Set, Delete
	OpFirewallRuleAdd    = "firewall.rule_add"    // guest: Rule (Rule.Pos: insert position, default top)
	OpFirewallRuleUpdate = "firewall.rule_update" // guest: Pos, Digest, Rule, MoveTo
	OpFirewallRuleDelete = "firewall.rule_delete" // guest: Pos, Digest

	OpHASet    = "ha.set"    // guest: HA (PVE cluster only)
	OpHARemove = "ha.remove" // guest

	OpReplicationAdd    = "replication.add"    // guest: Target, Schedule, Rate, Comment (PVE cluster only)
	OpReplicationDelete = "replication.delete" // guest: JobID

	// Scheduled backup jobs (PVE, cluster-wide vzdump schedules). The
	// agent reads them with the manage token and changes them with pvesh
	// as root after checking every value (PVE wants Sys.Modify on / for
	// jobs, which would let the token change node settings).
	OpBackupJobList   = "backupjob.list"   // host -> BackupJobs
	OpBackupJobCreate = "backupjob.create" // host: BackupJob -> JobID
	OpBackupJobUpdate = "backupjob.update" // host: JobID, BackupJob (the changes), Digest -> Changes
	OpBackupJobDelete = "backupjob.delete" // host: JobID
	OpBackupJobRun    = "backupjob.run"    // host: JobID -> Task (vzdump on this node, like Back up now)
)

// Incus operations (docs/MANAGE.md 2.5). Host ops take Project ("" =
// default); the Incus parts of the shared ops (create, clone, backups,
// tasks, choices) are described there too.
const (
	OpLogGet  = "log.get"       // guest: Lines -> Log (lxc.log / qemu.log, last 500 lines by default, at most 2000)
	OpRename  = "guest.rename"  // guest: Name (stopped) -> Task, NewID
	OpMove    = "guest.move"    // guest: Pool, Project (stopped) -> Task, NewID
	OpPublish = "guest.publish" // guest: Alias, Description, Snapshot -> Task (TaskStatus.NewID: the image fingerprint)

	OpNetworkLeases = "network.leases" // host: Network, Project -> Leases

	OpProfileGet    = "profile.get"    // host: Profile, Project -> Profile
	OpProfileCreate = "profile.create" // host: Name, Description, CopyFrom, Project
	OpProfileUpdate = "profile.update" // host: Profile, Project, Digest, Set, Delete, Devices, Description -> Changes
	OpProfileDelete = "profile.delete" // host: Profile, Project (unused, never "default")

	OpVolumeCreate = "volume.create" // host: Pool, Name, Size, ContentType, Project, Description
	OpVolumeResize = "volume.resize" // host: Pool, Volume, Size (grow only), Project -> Changes
	OpVolumeDelete = "volume.delete" // host: Pool, Volume, Project (not attached)

	OpImageDownload = "image.download" // host: Alias, ImageType, Project, AutoUpdate -> Task (TaskStatus.NewID: the fingerprint)
	OpImageRefresh  = "image.refresh"  // host: Fingerprint, Project -> Task
	OpImageDelete   = "image.delete"   // host: Fingerprint, Project -> Task (or done)
)

// Backup job selections (BackupJob.Selection).
const (
	BackupSelectAll    = "all"    // every guest, but Exclude
	BackupSelectGuests = "guests" // the guests in Guests
	BackupSelectPool   = "pool"   // the guests of Pool
)

// Error codes of ManageResponse.Code, in addition to the broker's
// invalid_request, unknown_guest, unsupported, platform_error, timeout and
// the runtime's remote_control_disabled.
const (
	CodeDigestMismatch = "digest_mismatch" // the configuration changed since it was read
	CodeLocked         = "locked"          // the guest is locked (backup, migration, ...)
	CodeNotAllowed     = "not_allowed"     // key or value outside Whombat's allowlist (change it in the platform's own UI)
	CodeInvalidValue   = "invalid_value"   // a value failed validation (FieldErrors has details)
	CodeNotFound       = "not_found"       // task, volume, storage, rule or job does not exist
	CodeGuestRunning   = "guest_running"   // the operation needs a stopped guest
	CodeProtected      = "protected"       // the guest or backup has protection set
	CodeExists         = "exists"          // the new id or name is taken
	CodeInUse          = "in_use"          // a profile or volume something still uses
	// CodeSelfGuest: the hosts service refuses to change the guest it runs
	// in ("That’s this Whombat itself."); never sent by an agent.
	CodeSelfGuest = "self_guest"
)

// ManageRequest is one operation. Only the fields of Op are read.
type ManageRequest struct {
	Op       string `cbor:"op" json:"-"`
	Platform string `cbor:"platform" json:"platform,omitempty"`     // pve | incus
	GuestID  string `cbor:"guest,omitempty" json:"guest,omitempty"` // guest ops; backup.restore over an existing guest

	// Optimistic concurrency: the digest from config.get / firewall.get. A
	// change made meanwhile (in the platform's own UI, say) fails with
	// digest_mismatch instead of being overwritten. Empty: no check.
	Digest string `cbor:"digest,omitempty" json:"digest,omitempty"`

	// config.set, guest.create, firewall.options: key -> new value (raw
	// platform value: PVE property strings; Incus config values, devices as
	// "device.<name>" -> "type=disk,path=/,pool=default"). Delete removes
	// keys; Revert drops pending changes (PVE).
	Set    map[string]string `cbor:"set,omitempty" json:"set,omitempty"`
	Delete []string          `cbor:"delete,omitempty" json:"delete,omitempty"`
	Revert []string          `cbor:"revert,omitempty" json:"revert,omitempty"`

	// Disks.
	Disk         string `cbor:"disk,omitempty" json:"disk,omitempty"`       // config key: scsi0, rootfs, mp1; Incus device name
	Size         string `cbor:"size,omitempty" json:"size,omitempty"`       // "+8G" or the new total "40G" (grow only)
	Storage      string `cbor:"storage,omitempty" json:"storage,omitempty"` // target storage (also backups, clone, restore, downloads)
	DeleteSource bool   `cbor:"del_src,omitempty" json:"delete_source,omitempty"`

	// guest.create, guest.clone, backup.restore.
	Kind     string   `cbor:"kind,omitempty" json:"kind,omitempty"`     // vm | container
	NewID    int      `cbor:"new_id,omitempty" json:"new_id,omitempty"` // PVE vmid (0: next free)
	Name     string   `cbor:"name,omitempty" json:"name,omitempty"`     // PVE name / hostname; Incus instance name
	Full     bool     `cbor:"full,omitempty" json:"full,omitempty"`     // clone: full copy (default linked for templates)
	Start    bool     `cbor:"start,omitempty" json:"start,omitempty"`   // start when done
	Unique   bool     `cbor:"unique,omitempty" json:"unique,omitempty"` // restore: new MAC addresses
	Image    string   `cbor:"image,omitempty" json:"image,omitempty"`   // Incus create: "images:debian/13", local alias or fingerprint
	Profiles []string `cbor:"profiles,omitempty" json:"profiles,omitempty"`
	Purge    bool     `cbor:"purge,omitempty" json:"purge,omitempty"` // delete: also from backup jobs, replication and HA

	// Backups and storage content.
	Volume            string `cbor:"volume,omitempty" json:"volume,omitempty"`     // PVE volume id "pbs:backup/vm/100/2026-10-17T01:00:00Z"
	Mode              string `cbor:"mode,omitempty" json:"mode,omitempty"`         // backup: snapshot | suspend | stop
	Compress          string `cbor:"compress,omitempty" json:"compress,omitempty"` // backup: zstd | lzo | gzip | none
	Notes             string `cbor:"notes,omitempty" json:"notes,omitempty"`
	Protected         *bool  `cbor:"protected,omitempty" json:"protected,omitempty"`
	Content           string `cbor:"content,omitempty" json:"content,omitempty"` // iso | vztmpl | import
	URL               string `cbor:"url,omitempty" json:"url,omitempty"`
	Filename          string `cbor:"filename,omitempty" json:"filename,omitempty"`
	Checksum          string `cbor:"checksum,omitempty" json:"checksum,omitempty"`
	ChecksumAlgorithm string `cbor:"checksum_alg,omitempty" json:"checksum_algorithm,omitempty"` // md5 | sha1 | sha224 | sha256 | sha384 | sha512
	Template          string `cbor:"template,omitempty" json:"template,omitempty"`               // appliance template name

	// Tasks.
	Task     string `cbor:"task,omitempty" json:"task,omitempty"`           // PVE UPID, "incus:<operation uuid>", "unraid:…", "libvirt:…", "pkg:…", "app:…"
	LogStart int    `cbor:"log_start,omitempty" json:"log_start,omitempty"` // first log line to return; -1: none

	// Firewall.
	Pos    *int          `cbor:"pos,omitempty" json:"pos,omitempty"`
	MoveTo *int          `cbor:"move_to,omitempty" json:"move_to,omitempty"`
	Rule   *FirewallRule `cbor:"rule,omitempty" json:"rule,omitempty"`

	// HA and replication.
	HA       *HASettings `cbor:"ha,omitempty" json:"ha,omitempty"`
	Target   string      `cbor:"target,omitempty" json:"target,omitempty"`     // replication or migration target node
	Schedule string      `cbor:"schedule,omitempty" json:"schedule,omitempty"` // replication schedule ("*/15")
	Rate     string      `cbor:"rate,omitempty" json:"rate,omitempty"`         // MB/s limit, "" = none
	Comment  string      `cbor:"comment,omitempty" json:"comment,omitempty"`
	JobID    string      `cbor:"job,omitempty" json:"job,omitempty"` // replication job; backup job (backupjob.*)

	// backupjob.create: the job; backupjob.update: the fields to change.
	// The hub builds it from its own body (hub guest ids become vmids).
	BackupJob *BackupJobSpec `cbor:"backup_job,omitempty" json:"-"`

	// Incus (docs/MANAGE.md 2.5).
	Project      string `cbor:"project,omitempty" json:"project,omitempty"`             // create, clone (target), move (target), host ops
	Pool         string `cbor:"pool,omitempty" json:"pool,omitempty"`                   // create: the root disk's pool; move: the target pool; volumes
	Network      string `cbor:"network,omitempty" json:"network,omitempty"`             // create: eth0's network or bridge; network.leases
	CloudInit    string `cbor:"cloud_init,omitempty" json:"cloud_init,omitempty"`       // create: cloud-init user data (at most 64 KiB)
	InstanceOnly bool   `cbor:"instance_only,omitempty" json:"instance_only,omitempty"` // clone, backup.create: without snapshots
	// Devices: config.set and profile.update: device name -> options; nil
	// removes the device (the same allowlist as "device.<name>" keys).
	Devices     map[string]map[string]string `cbor:"devices,omitempty" json:"devices,omitempty"`
	Description string                       `cbor:"desc,omitempty" json:"description,omitempty"`  // publish, profiles, volumes
	Alias       string                       `cbor:"alias,omitempty" json:"alias,omitempty"`       // publish, image.download
	Snapshot    string                       `cbor:"snapshot,omitempty" json:"snapshot,omitempty"` // publish a snapshot
	ImageType   string                       `cbor:"image_type,omitempty" json:"type,omitempty"`   // image.download: container | virtual-machine
	AutoUpdate  *bool                        `cbor:"auto_update,omitempty" json:"auto_update,omitempty"`
	CopyFrom    string                       `cbor:"copy_from,omitempty" json:"copy_from,omitempty"`       // profile.create
	ContentType string                       `cbor:"content_type,omitempty" json:"content_type,omitempty"` // volume.create: filesystem | block
	// backup.create: when the backup expires (default 7 days), whether it
	// is optimized for the pool's driver, the compression (zstd, gzip,
	// none; Compress is read when this is empty).
	ExpiresAt   *time.Time `cbor:"expires,omitempty" json:"expires_at,omitempty"`
	Optimized   bool       `cbor:"optimized,omitempty" json:"optimized,omitempty"`
	Compression string     `cbor:"compression,omitempty" json:"compression,omitempty"`
	// Path and query values of the Incus routes.
	Profile     string `cbor:"profile,omitempty" json:"-"`
	Fingerprint string `cbor:"fingerprint,omitempty" json:"-"`
	Lines       int    `cbor:"lines,omitempty" json:"-"` // log.get

	// unRAID host ops and the Docker / libvirt guest ops (unraid.go).
	// Disk names the disk of disk.spin_up / spin_down.
	Correct      bool   `cbor:"correct,omitempty" json:"correct,omitempty"` // parity.start: write corrections to parity
	On           *bool  `cbor:"on,omitempty" json:"on,omitempty"`           // guest.autostart
	Plugin       string `cbor:"plugin,omitempty" json:"-"`                  // plugin.update: a .plg file name, or "all"
	Notification string `cbor:"notification,omitempty" json:"id,omitempty"` // notification.archive: one id ("" = all)

	// libvirt (docs/MANAGE.md 2.8); also Name, Storage, Network, Start,
	// Purge, Pool, Volume and Size.
	OSVariant string `cbor:"os_variant,omitempty" json:"os_variant,omitempty"` // guest.create: a Choices.OSVariants id
	ISO       string `cbor:"iso,omitempty" json:"iso,omitempty"`               // guest.create: the installer (a Choices.ISOs volume)
	DiskGB    int    `cbor:"disk_gb,omitempty" json:"disk_gb,omitempty"`       // guest.create: the first disk's size
	Bridge    string `cbor:"bridge,omitempty" json:"bridge,omitempty"`         // guest.create: a host bridge instead of Network
	Format    string `cbor:"format,omitempty" json:"format,omitempty"`         // volume.create: qcow2 | raw

	// packages.install: only these packages (empty: every waiting update;
	// packages.go).
	Packages []string `cbor:"packages,omitempty" json:"packages,omitempty"`

	// app.update (apps.go): the containers to update (their names, at most
	// AppsMax); HoldMajor leaves an app as it is when the new image turns
	// out to be a new major version, or either version isn't known (a run
	// nobody said yes to a new major version for); AppExpect: what was
	// checked of each app, which the update must still find.
	Apps      []string    `cbor:"apps,omitempty" json:"apps,omitempty"`
	HoldMajor bool        `cbor:"hold_major,omitempty" json:"hold_major,omitempty"`
	AppExpect []AppExpect `cbor:"app_expect,omitempty" json:"expect,omitempty"`

	// Backup places (backupplace.go): the place operations' values, and
	// storage.add's storage. The hub builds them from its own bodies.
	Place      *PlaceRequest   `cbor:"place,omitempty" json:"-"`
	PVEStorage *PVEStorageSpec `cbor:"pve_storage,omitempty" json:"-"`
}

// BackupJobSpec is a backup job to create, or the changes to one: nil
// fields stay as they are, Clear names the fields to remove (update
// only). Guests and Exclude are vmids.
type BackupJobSpec struct {
	Enabled       *bool       `cbor:"enabled,omitempty"`
	Schedule      *string     `cbor:"schedule,omitempty"` // PVE calendar event ("04:00", "sat 02:30", "*/6:00")
	Storage       *string     `cbor:"storage,omitempty"`  // a storage offering backup content
	Node          *string     `cbor:"node,omitempty"`     // run on this node only
	Selection     *string     `cbor:"selection,omitempty"`
	Guests        []string    `cbor:"guests,omitempty"`   // selection guests
	Exclude       []string    `cbor:"exclude,omitempty"`  // selection all
	Pool          *string     `cbor:"pool,omitempty"`     // selection pool
	Mode          *string     `cbor:"mode,omitempty"`     // snapshot | suspend | stop
	Compress      *string     `cbor:"compress,omitempty"` // zstd | lzo | gzip | 0
	Keep          *BackupKeep `cbor:"keep,omitempty"`     // all zero: keep every backup
	NotesTemplate *string     `cbor:"notes,omitempty"`    // "{{guestname}}"
	Comment       *string     `cbor:"comment,omitempty"`
	// Clear: node, compress, keep, notes_template, comment, exclude.
	Clear []string `cbor:"clear,omitempty"`
}

// BackupKeep is a backup job's retention (PVE prune-backups): how many
// backups of each kind to keep. Every count 0 keeps every backup.
type BackupKeep struct {
	Last    int `cbor:"last,omitempty" json:"last"`
	Hourly  int `cbor:"hourly,omitempty" json:"hourly"`
	Daily   int `cbor:"daily,omitempty" json:"daily"`
	Weekly  int `cbor:"weekly,omitempty" json:"weekly"`
	Monthly int `cbor:"monthly,omitempty" json:"monthly"`
	Yearly  int `cbor:"yearly,omitempty" json:"yearly"`
}

// BackupJob is a scheduled backup job as Proxmox VE stores it. Guests
// and Exclude are vmids; the hub answers with hub guest ids
// (docs/REST-API.md "Manage", backup jobs).
type BackupJob struct {
	ID        string `cbor:"id"`
	Enabled   bool   `cbor:"enabled"`
	Schedule  string `cbor:"schedule"`
	Storage   string `cbor:"storage,omitempty"`
	Node      string `cbor:"node,omitempty"` // "" = every node
	Selection string `cbor:"selection"`      // all | guests | pool
	// Guests: selection guests; Exclude: selection all; Pool: selection pool.
	Guests        []string    `cbor:"guests,omitempty"`
	Exclude       []string    `cbor:"exclude,omitempty"`
	Pool          string      `cbor:"pool,omitempty"`
	Mode          string      `cbor:"mode"`               // snapshot | suspend | stop
	Compress      string      `cbor:"compress,omitempty"` // zstd | lzo | gzip | 0; "" = Proxmox's default
	Keep          *BackupKeep `cbor:"keep,omitempty"`     // nil = the storage's own retention
	NotesTemplate string      `cbor:"notes,omitempty"`
	Comment       string      `cbor:"comment,omitempty"`
	NextRun       *time.Time  `cbor:"next_run,omitempty"` // enabled jobs
	// Digest: SHA-256 of the job as read (its JSON without next-run).
	// backupjob.update refuses a stale one (digest_mismatch).
	Digest string `cbor:"digest"`
}

// ManageResponse answers a ManageRequest. OK with Task set means the
// platform started a task that is still running: follow it with
// task.status.
type ManageResponse struct {
	OK      bool   `cbor:"ok" json:"ok"`
	Code    string `cbor:"code,omitempty" json:"code,omitempty"`
	Message string `cbor:"msg,omitempty" json:"message,omitempty"`
	// FieldErrors: key -> message, from the agent's validation or the
	// platform's parameter check.
	FieldErrors map[string]string `cbor:"fields,omitempty" json:"field_errors,omitempty"`

	Task  *TaskRef `cbor:"task,omitempty" json:"task,omitempty"`
	NewID string   `cbor:"new_id,omitempty" json:"new_id,omitempty"` // create / clone / restore: the new guest's platform id

	// config.set: what changed (secrets masked), for the audit log.
	Changes []ConfigChange `cbor:"changes,omitempty" json:"changes,omitempty"`

	Config     *GuestConfig    `cbor:"config,omitempty" json:"config,omitempty"`
	Choices    *Choices        `cbor:"choices,omitempty" json:"choices,omitempty"`
	Backups    []BackupVolume  `cbor:"backups,omitempty" json:"backups,omitempty"`
	Content    []StorageVolume `cbor:"content,omitempty" json:"content,omitempty"`
	Appliances []Appliance     `cbor:"appliances,omitempty" json:"appliances,omitempty"`
	Tasks      []TaskStatus    `cbor:"tasks,omitempty" json:"tasks,omitempty"`
	TaskStatus *TaskStatus     `cbor:"task_status,omitempty" json:"task_status,omitempty"`
	Firewall   *GuestFirewall  `cbor:"firewall,omitempty" json:"firewall,omitempty"`

	BackupJobs []BackupJob `cbor:"backup_jobs,omitempty" json:"-"`
	JobID      string      `cbor:"job,omitempty" json:"-"` // backupjob.create: the new job's id

	// Incus reads (incus.go).
	Profile *IncusProfile `cbor:"profile,omitempty" json:"-"`
	Leases  []IncusLease  `cbor:"leases,omitempty" json:"-"`
	Log     *GuestLog     `cbor:"log,omitempty" json:"-"`

	// Backup places (backupplace.go).
	Place *PlaceResult `cbor:"place,omitempty" json:"-"`
}

// GuestConfig is a guest's configuration as the platform stores it.
type GuestConfig struct {
	Platform string `cbor:"platform" json:"platform"`
	Kind     string `cbor:"kind" json:"kind"`     // vm | container
	Digest   string `cbor:"digest" json:"digest"` // PVE config digest / Incus ETag
	Lock     string `cbor:"lock,omitempty" json:"lock,omitempty"`
	Running  bool   `cbor:"running" json:"running"`

	// Values: key -> raw value of the current configuration. PVE: the
	// config keys with their property strings ("scsi0":
	// "local-zfs:vm-100-disk-0,iothread=1,size=32G"); Incus: config keys
	// and "device.<name>" -> "type=nic,network=incusbr0" (expanded: devices
	// from profiles included, see Inherited). Secrets are masked as
	// "**********" (cipassword).
	Values map[string]string `cbor:"values" json:"values"`
	// Pending: key -> value that applies at the next restart (PVE: changes
	// a running guest could not take live). PendingDelete: keys removed at
	// the next restart.
	Pending       map[string]string `cbor:"pending,omitempty" json:"pending,omitempty"`
	PendingDelete []string          `cbor:"pending_delete,omitempty" json:"pending_delete,omitempty"`
	// Restricted: keys present in Values that Whombat shows but never
	// changes (PVE root-only settings: args, hookscript, hostpci0, usb0,
	// bind mounts, lxc.*; Incus raw.*, security.privileged, host devices).
	Restricted []string `cbor:"restricted,omitempty" json:"restricted,omitempty"`
	// Inherited: Incus keys whose value comes from a profile.
	Inherited []string `cbor:"inherited,omitempty" json:"inherited,omitempty"`
	Profiles  []string `cbor:"profiles,omitempty" json:"profiles,omitempty"` // Incus

	// Disks: one entry per disk-like key, parsed for display.
	Disks []GuestDisk `cbor:"disks,omitempty" json:"disks,omitempty"`

	// PVE cluster only.
	HA          *HAState         `cbor:"ha,omitempty" json:"ha,omitempty"`
	Replication []ReplicationJob `cbor:"replication,omitempty" json:"replication,omitempty"`
}

// GuestDisk is one disk, CD-ROM or mount point of a guest.
type GuestDisk struct {
	Key       string `cbor:"key" json:"key"`                             // scsi0, ide2, efidisk0, rootfs, mp0, unused0; Incus device name
	Storage   string `cbor:"storage,omitempty" json:"storage,omitempty"` // PVE storage / Incus pool
	Volume    string `cbor:"volume,omitempty" json:"volume,omitempty"`   // "local-zfs:vm-100-disk-0"; ISO volume for CD-ROMs
	SizeBytes uint64 `cbor:"size,omitempty" json:"size_bytes,omitempty"`
	Media     string `cbor:"media,omitempty" json:"media,omitempty"`   // disk | cdrom
	Path      string `cbor:"path,omitempty" json:"path,omitempty"`     // container mount point inside the guest
	Unused    bool   `cbor:"unused,omitempty" json:"unused,omitempty"` // detached, still on storage
	Boot      bool   `cbor:"boot,omitempty" json:"boot,omitempty"`     // in the boot order
}

// ConfigChange is one changed key (Old/New "" when absent; secrets masked).
type ConfigChange struct {
	Key     string `cbor:"key" json:"key"`
	Old     string `cbor:"old,omitempty" json:"old,omitempty"`
	New     string `cbor:"new,omitempty" json:"new,omitempty"`
	Pending bool   `cbor:"pending,omitempty" json:"pending,omitempty"` // applies at the next restart
}

// Choices are what the forms offer on this host.
type Choices struct {
	Platform string `cbor:"platform" json:"platform"`
	Node     string `cbor:"node,omitempty" json:"node,omitempty"`
	Cluster  bool   `cbor:"cluster,omitempty" json:"cluster,omitempty"`
	NextID   int    `cbor:"next_id,omitempty" json:"next_id,omitempty"`

	Storages []ChoiceStorage `cbor:"storages" json:"storages"`
	// Bridges: PVE Linux / OVS bridges and SDN vnets; Incus networks.
	Bridges []string `cbor:"bridges" json:"bridges"`
	// ISOs and CTTemplates on this node's storages.
	ISOs        []StorageVolume `cbor:"isos,omitempty" json:"isos,omitempty"`
	CTTemplates []StorageVolume `cbor:"ct_templates,omitempty" json:"ct_templates,omitempty"`
	// Templates: PVE guest templates on this node (clone sources).
	Templates []TemplateGuest `cbor:"templates,omitempty" json:"templates,omitempty"`
	CPUTypes  []string        `cbor:"cpu_types,omitempty" json:"cpu_types,omitempty"`
	Nodes     []string        `cbor:"nodes,omitempty" json:"nodes,omitempty"` // other cluster nodes (replication targets)
	// Download: content.download works here (PVE: the token has
	// Sys.AccessNetwork on this node; PVE 8.3 and later).
	Download bool `cbor:"download,omitempty" json:"download,omitempty"`

	// Incus.
	Profiles []string     `cbor:"profiles,omitempty" json:"profiles,omitempty"`
	Images   []IncusImage `cbor:"images,omitempty" json:"images,omitempty"`
	// Projects: every Incus project; Project: the one Profiles, Bridges
	// and Images are of. RemoteImages: the common images of images:.
	Projects     []string      `cbor:"projects,omitempty" json:"projects,omitempty"`
	Project      string        `cbor:"project,omitempty" json:"project,omitempty"`
	RemoteImages []RemoteImage `cbor:"remote_images,omitempty" json:"remote_images,omitempty"`

	// libvirt: its networks (Bridges are the host's bridges), the OS
	// types a new VM starts from and what the host's QEMU can give it.
	Networks   []string         `cbor:"networks,omitempty" json:"networks,omitempty"`
	OSVariants []OSVariant      `cbor:"os_variants,omitempty" json:"os_variants,omitempty"`
	Firmware   *LibvirtFirmware `cbor:"firmware,omitempty" json:"firmware,omitempty"`
}

// ChoiceStorage is a storage (PVE) or storage pool (Incus).
type ChoiceStorage struct {
	ID         string   `cbor:"id" json:"id"`
	Type       string   `cbor:"type" json:"type"`       // dir | zfspool | lvmthin | pbs | ...; Incus driver
	Content    []string `cbor:"content" json:"content"` // images | rootdir | iso | vztmpl | backup | import | snippets
	AvailBytes uint64   `cbor:"avail,omitempty" json:"avail_bytes,omitempty"`
	TotalBytes uint64   `cbor:"total,omitempty" json:"total_bytes,omitempty"`
	Shared     bool     `cbor:"shared,omitempty" json:"shared,omitempty"`
	Thin       bool     `cbor:"thin,omitempty" json:"thin,omitempty"`
}

// TemplateGuest is a PVE guest template.
type TemplateGuest struct {
	ID        string `cbor:"id" json:"id"` // vmid
	Name      string `cbor:"name" json:"name"`
	Kind      string `cbor:"kind" json:"kind"` // vm | container
	Node      string `cbor:"node,omitempty" json:"node,omitempty"`
	DiskBytes uint64 `cbor:"disk,omitempty" json:"disk_bytes,omitempty"`
}

// IncusImage is an image in the local Incus image store.
type IncusImage struct {
	Fingerprint string   `cbor:"fp" json:"fingerprint"`
	Aliases     []string `cbor:"aliases,omitempty" json:"aliases,omitempty"`
	Description string   `cbor:"desc,omitempty" json:"description,omitempty"`
	Type        string   `cbor:"type" json:"type"` // container | virtual-machine
	SizeBytes   uint64   `cbor:"size,omitempty" json:"size_bytes,omitempty"`
}

// StorageVolume is an ISO image, container template or import file.
type StorageVolume struct {
	Volume    string    `cbor:"volume" json:"volume"` // "local:iso/debian-13.iso"
	Storage   string    `cbor:"storage" json:"storage"`
	Content   string    `cbor:"content" json:"content"` // iso | vztmpl | import
	Name      string    `cbor:"name" json:"name"`       // file name
	SizeBytes uint64    `cbor:"size,omitempty" json:"size_bytes,omitempty"`
	Created   time.Time `cbor:"created,omitempty" json:"created,omitzero"`
	// libvirt pool volumes (content.list "images"): the image format, the
	// space it takes and the guests (platform ids) that use it.
	Format    string   `cbor:"format,omitempty" json:"format,omitempty"`
	UsedBytes uint64   `cbor:"used,omitempty" json:"used_bytes,omitempty"`
	UsedBy    []string `cbor:"used_by,omitempty" json:"used_by,omitempty"`
}

// BackupVolume is one backup archive.
type BackupVolume struct {
	Volume    string    `cbor:"volume" json:"volume"`
	Storage   string    `cbor:"storage" json:"storage"`
	GuestID   string    `cbor:"guest,omitempty" json:"guest,omitempty"` // vmid
	Kind      string    `cbor:"kind,omitempty" json:"kind,omitempty"`   // vm | container
	SizeBytes uint64    `cbor:"size,omitempty" json:"size_bytes,omitempty"`
	Created   time.Time `cbor:"created,omitempty" json:"created,omitzero"`
	Format    string    `cbor:"format,omitempty" json:"format,omitempty"` // pbs-vm | vma.zst | tar.zst | ...
	Notes     string    `cbor:"notes,omitempty" json:"notes,omitempty"`
	Protected bool      `cbor:"protected,omitempty" json:"protected,omitempty"`
	Encrypted bool      `cbor:"encrypted,omitempty" json:"encrypted,omitempty"`
	// Verified: Proxmox Backup Server verification: ok | failed | "" (not verified).
	Verified string `cbor:"verified,omitempty" json:"verified,omitempty"`
	// ExpiresAt: when Incus deletes the backup (nil: never).
	ExpiresAt *time.Time `cbor:"expires,omitempty" json:"expires_at,omitempty"`
}

// Appliance is a container template offered by Proxmox (aplinfo).
type Appliance struct {
	Template    string `cbor:"template" json:"template"` // file name, the download key
	Package     string `cbor:"package,omitempty" json:"package,omitempty"`
	Headline    string `cbor:"headline,omitempty" json:"headline,omitempty"`
	Description string `cbor:"desc,omitempty" json:"description,omitempty"`
	OS          string `cbor:"os,omitempty" json:"os,omitempty"`
	Version     string `cbor:"version,omitempty" json:"version,omitempty"`
	Section     string `cbor:"section,omitempty" json:"section,omitempty"` // system | turnkeylinux | mail
}

// TaskRef names a running platform task.
type TaskRef struct {
	ID string `cbor:"id" json:"id"` // PVE UPID, or "incus:<operation uuid>"
}

// TaskStatus is a task's state and, when asked, its log.
type TaskStatus struct {
	ID      string     `cbor:"id" json:"id"`
	Type    string     `cbor:"type" json:"type"`                       // qmclone | vzdump | qmigrate | download | ...
	GuestID string     `cbor:"guest,omitempty" json:"guest,omitempty"` // vmid / instance, when the task is about one
	User    string     `cbor:"user,omitempty" json:"user,omitempty"`
	Started time.Time  `cbor:"started" json:"started"`
	Ended   *time.Time `cbor:"ended,omitempty" json:"ended,omitempty"`
	// Status: running | ok | warning | error. Message: the exit status
	// ("OK", "WARNINGS: 2", the error text) or the progress line.
	Status  string `cbor:"status" json:"status"`
	Message string `cbor:"msg,omitempty" json:"message,omitempty"`
	// Log lines from LogStart on (at most 500); LogNext is the line to ask
	// for next.
	Log     []string `cbor:"log,omitempty" json:"log,omitempty"`
	LogNext int      `cbor:"log_next,omitempty" json:"log_next,omitempty"`
	// Cancellable: task.stop can stop it (Incus operations that say so).
	Cancellable bool `cbor:"cancellable,omitempty" json:"cancellable,omitempty"`
	// NewID: what the finished task made when it is not known before
	// (an Incus image's fingerprint after publish or download).
	NewID string `cbor:"new_id,omitempty" json:"new_id,omitempty"`
	// Packages: what an ended package task did (packages.go).
	Packages *PackageResult `cbor:"packages,omitempty" json:"packages,omitempty"`
	// Apps: what an ended app task did, app by app (apps.go).
	Apps []AppResult `cbor:"apps,omitempty" json:"apps,omitempty"`
	// Code: why an ended task didn't do its work, as a refusal code
	// (TaskCodeBusy, TaskCodeTimeout); package tasks only.
	Code string `cbor:"code,omitempty" json:"code,omitempty"`
}

// GuestFirewall is a guest's firewall (PVE).
type GuestFirewall struct {
	// Options: enable, policy_in, policy_out, dhcp, ndp, radv, macfilter,
	// ipfilter, log_level_in, log_level_out (raw values).
	Options       map[string]string `cbor:"options" json:"options"`
	OptionsDigest string            `cbor:"options_digest,omitempty" json:"options_digest,omitempty"`
	Rules         []FirewallRule    `cbor:"rules" json:"rules"`
	RulesDigest   string            `cbor:"rules_digest,omitempty" json:"rules_digest,omitempty"`
	Groups        []string          `cbor:"groups,omitempty" json:"groups,omitempty"` // cluster security groups
	// Enabled: whether the datacenter firewall is on (rules do nothing
	// otherwise).
	ClusterEnabled bool `cbor:"cluster_enabled" json:"cluster_enabled"`
}

// FirewallRule is one rule (PVE).
type FirewallRule struct {
	Pos     int    `cbor:"pos" json:"pos"`
	Type    string `cbor:"type" json:"type"`     // in | out | group
	Action  string `cbor:"action" json:"action"` // ACCEPT | DROP | REJECT; group name for type group
	Enable  bool   `cbor:"enable" json:"enable"`
	Macro   string `cbor:"macro,omitempty" json:"macro,omitempty"`
	Proto   string `cbor:"proto,omitempty" json:"proto,omitempty"`
	Source  string `cbor:"source,omitempty" json:"source,omitempty"`
	Dest    string `cbor:"dest,omitempty" json:"dest,omitempty"`
	SPort   string `cbor:"sport,omitempty" json:"sport,omitempty"`
	DPort   string `cbor:"dport,omitempty" json:"dport,omitempty"`
	Iface   string `cbor:"iface,omitempty" json:"iface,omitempty"`
	Log     string `cbor:"log,omitempty" json:"log,omitempty"`
	Comment string `cbor:"comment,omitempty" json:"comment,omitempty"`
}

// HASettings are the HA settings of a guest (PVE cluster).
type HASettings struct {
	State       string `cbor:"state" json:"state"` // started | stopped | ignored | disabled
	MaxRestart  *int   `cbor:"max_restart,omitempty" json:"max_restart,omitempty"`
	MaxRelocate *int   `cbor:"max_relocate,omitempty" json:"max_relocate,omitempty"`
	Comment     string `cbor:"comment,omitempty" json:"comment,omitempty"`
}

// HAState is a guest's HA resource, when it has one.
type HAState struct {
	HASettings
	Status string `cbor:"status,omitempty" json:"status,omitempty"` // the HA manager's current state ("started", "fence", ...)
}

// ReplicationJob is a storage replication job of a guest.
type ReplicationJob struct {
	ID       string     `cbor:"id" json:"id"` // "100-0"
	Target   string     `cbor:"target" json:"target"`
	Schedule string     `cbor:"schedule,omitempty" json:"schedule,omitempty"`
	Rate     string     `cbor:"rate,omitempty" json:"rate,omitempty"`
	Comment  string     `cbor:"comment,omitempty" json:"comment,omitempty"`
	Disabled bool       `cbor:"disabled,omitempty" json:"disabled,omitempty"`
	LastSync *time.Time `cbor:"last_sync,omitempty" json:"last_sync,omitempty"`
	Error    string     `cbor:"error,omitempty" json:"error,omitempty"`
}
