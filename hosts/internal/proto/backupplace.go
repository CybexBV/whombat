package proto

import (
	"regexp"
	"strings"
	"time"
)

// Backup places (docs/MANAGE.md 2.10, Whombat's backup-places decisions):
// a server with Docker keeps a Whombat's backups in a restic REST server
// that only adds (append-only, one user per Whombat), and a second
// container clears old snapshots on the server itself once a week. The
// agent reports what it keeps (Report.BackupPlace) and installs, updates
// and removes the two containers; on Unraid it also makes the share and
// the containers' dockerMan templates. Unraid can also share a folder
// over NFS for a Proxmox VE server's backups, which the Proxmox VE agent
// adds as a storage.

// Backup place operations (ManageRequest.Op, Platform "host"; storage.add
// is a Proxmox VE host op). They answer when done, so the hub waits up to
// LongManageWait for them (pulling an image can take a minute).
const (
	OpPlaceEnsure  = "backup_place.ensure"  // host: Place{Client, RestPassword, Port, Location} -> Place{Client, Port, Path, Created, Location, Moved}
	OpPlaceCleanup = "backup_place.cleanup" // host: Place{Client, RepositoryPassword, KeepWithinDays} -> Place{Set}
	OpPlaceRemove  = "backup_place.remove"  // host: Place{Client, DeleteData} -> Place{Removed}
	OpPlaceNFS     = "backup_place.nfs"     // host (Unraid): Place{Name, Clients} -> Place{Export}
	OpStorageAdd   = "storage.add"          // pve host: PVEStorage -> done
)

// LongManageWait is how long the agent works on, and the hub waits for, a
// backup place operation. PlaceMoveWait is the bound of an ensure that
// moves a Whombat's backups to another location: copying gigabytes takes
// a while.
const (
	LongManageWait = 5 * time.Minute
	PlaceMoveWait  = 60 * time.Minute
)

// ManageBudget is how long the agent may work on an operation: 0 = the
// usual manage budget, LongManageWait for the backup place operations,
// PlaceMoveWait for an ensure that names a location (it may move; the
// agent keeps an ensure that doesn't move to LongManageWait itself).
func ManageBudget(req ManageRequest) time.Duration {
	switch {
	case !LongManageOp(req.Op):
		return 0
	case req.Op == OpPlaceEnsure && req.Place != nil && req.Place.Location != "":
		return PlaceMoveWait
	}
	return LongManageWait
}

// LongManageOp reports whether an operation runs up to LongManageWait
// instead of the usual manage budget.
func LongManageOp(op string) bool {
	switch op {
	case OpPlaceEnsure, OpPlaceCleanup, OpPlaceRemove, OpPlaceNFS, OpStorageAdd:
		return true
	}
	return false
}

// Why a server can't keep backups (BackupPlace.Reason, and the reason of
// a refused operation).
const (
	PlaceNoDocker     = "no_docker"     // Docker isn't installed (or Unraid's Docker is off)
	PlaceDockerDown   = "docker_down"   // Docker is installed but doesn't answer
	PlaceArrayStopped = "array_stopped" // Unraid's array is stopped
	PlaceSelf         = "self"          // the server this Whombat runs on (set by the hub)
	PlaceNFSOff       = "nfs_off"       // Unraid's NFS is off (backup_place.nfs)
	PlaceNotUnraid    = "not_unraid"    // backup_place.nfs on a server without Unraid
)

// Backup place platforms (BackupPlace.Platform).
const (
	PlacePlatformUnraid = "unraid"
	PlacePlatformLinux  = "linux"
)

// Backup place names and limits shared by the agent and the hub.
var (
	// PlaceClientRe is a Whombat's name on a backup place: its REST user,
	// its data folder and its containers' names.
	PlaceClientRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,62}$`)
	// PlaceShareRe is an NFS share Whombat makes on Unraid: always
	// "whombat-…", so a person's own shares are never changed.
	PlaceShareRe = regexp.MustCompile(`^whombat-[a-z0-9][a-z0-9-]{0,31}$`)
	// PlaceLocationRe is a location's id: an Unraid share's name (letters,
	// digits, spaces, '.', '_', '-'), or PlaceLocationLinux.
	PlaceLocationRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$`)
	// PVEStorageIDRe is a Proxmox VE storage id.
	PVEStorageIDRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,38}[a-z0-9]$`)
)

const (
	// PlaceRestPasswordMin and Max bound the REST user's password: bcrypt
	// reads at most 72 bytes.
	PlaceRestPasswordMin = 24
	PlaceRestPasswordMax = 72
	// PlaceRepoPasswordMax bounds the restic repository password.
	PlaceRepoPasswordMax = 1024
	// PlaceKeepDaysDefault, Min and Max bound keep_within_days.
	PlaceKeepDaysDefault = 90
	PlaceKeepDaysMin     = 7
	PlaceKeepDaysMax     = 3650
	// With one a day kept for at least a week, every backup needs to be kept only for a day or more.
	PlaceKeepDaysMinWithDaily = 1
	// PlaceFirstPort is where a new REST server's host port search starts.
	PlaceFirstPort = 8747
	// PlaceNFSClientsMax bounds an NFS share's clients.
	PlaceNFSClientsMax = 16
	// PlaceShareName is the Unraid share that holds the backups.
	PlaceShareName = "whombat-backups"
	// PlaceLocationLinux is the one location of a server without Unraid
	// (PlaceRootLinux).
	PlaceLocationLinux = "srv"
	// PlaceRootUnraid and PlaceRootLinux are the dedicated roots; in any
	// other Unraid share the backups are in its folder PlaceShareFolder.
	PlaceRootUnraid  = "/mnt/user/" + PlaceShareName
	PlaceRootLinux   = "/srv/whombat-backups"
	PlaceShareFolder = "whombat"
	// PlaceUnraidSystemShare is never offered: Unraid's own docker.img and
	// libvirt.img.
	PlaceUnraidSystemShare = "system"
	// PlaceKitUser and PlaceKitPassword are the second user of every REST
	// server (Whombat core has the same constants): its private repository
	// /kit/ keeps the locked copies of the Whombats' backup details, which
	// open only with the person's passkey, so the password can be known.
	// No client may take the name.
	PlaceKitUser     = "kit"
	PlaceKitPassword = "whombat-kit"
	// PlaceKitKeep is how many kit files of one Whombat the cleanup keeps.
	PlaceKitKeep = 10
)

// ValidPlaceClient reports whether a name can be a Whombat's on a backup
// place: PlaceClientRe, and not the kit user's.
func ValidPlaceClient(client string) bool {
	return PlaceClientRe.MatchString(client) && client != PlaceKitUser
}

// ValidPlaceLocation reports whether id can name a location ("" = none).
func ValidPlaceLocation(id string) bool {
	return PlaceLocationRe.MatchString(id) && !strings.Contains(id, "..") && strings.TrimSpace(id) == id
}

// PlaceRequest is the request part of the backup place operations; only
// the operation's fields are read. Passwords never reach a log.
type PlaceRequest struct {
	Client       string `cbor:"client,omitempty"`
	RestPassword string `cbor:"rest_pw,omitempty"` // ensure
	Port         int    `cbor:"port,omitempty"`    // ensure: 0 = keep, or the first free from 8747
	// Location: ensure: where the backups live ("" = where they are, or
	// the dedicated share for a new client); another one moves them.
	Location           string `cbor:"loc,omitempty"`
	RepositoryPassword string `cbor:"repo_pw,omitempty"`   // cleanup
	KeepWithinDays     int    `cbor:"keep_days,omitempty"` // cleanup
	// The person's keep windows beyond every backup of KeepWithinDays (HS-251, Whombat backup-options.md): one a
	// day for KeepDailyDays, one a week for KeepWeeklyDays, one a month for KeepMonthlyMonths; LimitBytes thins
	// the oldest first when the client's backups are over it (0 = none). An agent from before ignores them.
	KeepDailyDays     int      `cbor:"keep_daily,omitempty"`
	KeepWeeklyDays    int      `cbor:"keep_weekly,omitempty"`
	KeepMonthlyMonths int      `cbor:"keep_monthly,omitempty"`
	LimitBytes        int64    `cbor:"limit_bytes,omitempty"`
	DeleteData        bool     `cbor:"delete_data,omitempty"`
	Name              string   `cbor:"name,omitempty"`    // nfs: the share
	Clients           []string `cbor:"clients,omitempty"` // nfs: IPv4 addresses
}

// PlaceResult is the answer of a backup place operation.
type PlaceResult struct {
	Client    string   `cbor:"client,omitempty"`
	Port      int      `cbor:"port,omitempty"`
	Addresses []string `cbor:"addrs,omitempty"`
	Path      string   `cbor:"path,omitempty"`
	Created   bool     `cbor:"created,omitempty"`
	Set       bool     `cbor:"set,omitempty"`
	Removed   bool     `cbor:"removed,omitempty"`
	Export    string   `cbor:"export,omitempty"`
	// Location: ensure: where the backups are now; Moved: they were moved
	// there from another location.
	Location string `cbor:"loc,omitempty"`
	Moved    bool   `cbor:"moved,omitempty"`
	// Kit: ensure: the REST server has the kit user (PlaceKitUser).
	Kit bool `cbor:"kit,omitempty"`
	// Reason: why it can't be done (with Code unsupported).
	Reason string `cbor:"reason,omitempty"`
}

// PVEStorageSpec is a storage storage.add adds to Proxmox VE.
type PVEStorageSpec struct {
	Storage string   `cbor:"storage"`
	Type    string   `cbor:"type"` // nfs
	Server  string   `cbor:"server"`
	Export  string   `cbor:"export"`
	Content []string `cbor:"content"` // backup
}

// BackupPlace is what a server offers and keeps as a backup place
// (Report.BackupPlace; nil from agents that don't know backup places).
type BackupPlace struct {
	Supported bool   `cbor:"ok"`
	Reason    string `cbor:"reason,omitempty"`
	Platform  string `cbor:"platform"` // unraid | linux
	Root      string `cbor:"root"`
	// FreeBytes and TotalBytes: the file system the root is on (or would
	// be on); nil when unknown (Unraid's array stopped).
	FreeBytes  *uint64 `cbor:"free,omitempty"`
	TotalBytes *uint64 `cbor:"total,omitempty"`
	// Addresses: the server's private IPv4 addresses, the interface with
	// the default route first.
	Addresses []string `cbor:"addrs,omitempty"`
	// NFS: the server can share a folder over NFS (Unraid with NFS on).
	NFS     bool                `cbor:"nfs,omitempty"`
	Clients []BackupPlaceClient `cbor:"clients,omitempty"`
	// Locations: where on the server backups can live (PlaceLocations);
	// nil from agents that can't move them.
	Locations []BackupPlaceLocation `cbor:"locs,omitempty"`
}

// BackupPlaceLocation is a place on the server a Whombat's backups can
// live: Unraid's dedicated share whombat-backups (made when first used)
// or any other user share (a folder "whombat" in it), or a Linux
// server's /srv/whombat-backups.
type BackupPlaceLocation struct {
	ID        string  `cbor:"id"`
	Name      string  `cbor:"name"`
	FreeBytes *uint64 `cbor:"free,omitempty"`
	// IsNew: the share (or folder) isn't there yet; ensure makes it.
	IsNew bool `cbor:"new,omitempty"`
	// SMB and NFS: how the share is shared on the network (the share's
	// own settings, which Whombat leaves as they are).
	SMB     string `cbor:"smb,omitempty"` // public | secure | private | "" (not shared)
	NFS     bool   `cbor:"nfs,omitempty"`
	Primary string `cbor:"primary,omitempty"` // Unraid: array | <pool>
	Path    string `cbor:"path"`              // the data root
}

// BackupPlaceClient is one Whombat's backups on the place.
type BackupPlaceClient struct {
	Client string `cbor:"client"`
	// Location: the id of the location its data folder is in ("" when it
	// is in none Whombat knows).
	Location string `cbor:"loc,omitempty"`
	Port     int    `cbor:"port"`
	Running  bool   `cbor:"running"`
	Image    string `cbor:"image,omitempty"`
	// UsedBytes: the client's data folder (measured every half hour).
	UsedBytes *uint64            `cbor:"used,omitempty"`
	Cleanup   BackupPlaceCleanup `cbor:"cleanup"`
	// Kit: its REST server has the kit user and /kit/ (PlaceKitUser); nil
	// from agents that don't give REST servers one.
	Kit *bool `cbor:"kit,omitempty"`
}

// BackupPlaceCleanup is the weekly cleanup of a client's backups.
type BackupPlaceCleanup struct {
	Set            bool       `cbor:"set"`     // the cleanup container exists
	Running        bool       `cbor:"running"` // and runs
	KeepWithinDays int        `cbor:"keep_days,omitempty"`
	LastRunAt      *time.Time `cbor:"last_at,omitempty"`
	LastOK         *bool      `cbor:"last_ok,omitempty"`
	LastError      string     `cbor:"last_err,omitempty"`
	// Keep is the windows as the cleanup runs them ("<all>,<daily>,<weekly days>,<monthly months>,<limit bytes>";
	// "" for a cleanup from before them); OverLimit: the last run couldn't bring the backups under the limit.
	Keep      string `cbor:"keep,omitempty"`
	OverLimit bool   `cbor:"over_limit,omitempty"`
}

// PlaceLocations are the locations of a place (BackupPlace.Locations): on
// Unraid the dedicated share first (IsNew while it isn't a share yet; a
// new share goes on the array, or on a server without array disks on its
// first pool), then every other user share but system; on other servers
// the one root. rootExists says whether a Linux root is there.
func PlaceLocations(bp *BackupPlace, u *Unraid, rootExists func(string) bool) []BackupPlaceLocation {
	if bp == nil {
		return nil
	}
	if bp.Platform != PlacePlatformUnraid {
		l := BackupPlaceLocation{ID: PlaceLocationLinux, Name: "this server", FreeBytes: bp.FreeBytes, Path: PlaceRootLinux}
		if rootExists != nil {
			l.IsNew = !rootExists(PlaceRootLinux)
		}
		return []BackupPlaceLocation{l}
	}
	share := func(s UnraidShare, path string) BackupPlaceLocation {
		free := s.FreeBytes
		return BackupPlaceLocation{ID: s.Name, Name: s.Name, FreeBytes: &free, SMB: s.SMB, NFS: s.NFS, Primary: s.Primary, Path: path}
	}
	dedicated := BackupPlaceLocation{ID: PlaceShareName, Name: PlaceShareName, IsNew: true, Primary: "array", Path: PlaceRootUnraid}
	var others []BackupPlaceLocation
	if u != nil {
		if len(u.Array.Disks) == 0 && len(u.Pools) > 0 {
			first := u.Pools[0]
			for _, p := range u.Pools[1:] {
				if p.Name < first.Name {
					first = p
				}
			}
			free := first.FreeBytes
			dedicated.Primary, dedicated.FreeBytes = first.Name, &free
		} else if u.Array.State == UnraidArrayStarted {
			free := u.Array.FreeBytes
			dedicated.FreeBytes = &free
		}
		for _, s := range u.Shares {
			switch {
			case s.Name == PlaceShareName:
				dedicated = share(s, PlaceRootUnraid)
			case s.Name == PlaceUnraidSystemShare || !ValidPlaceLocation(s.Name):
			default:
				others = append(others, share(s, "/mnt/user/"+s.Name+"/"+PlaceShareFolder))
			}
		}
	}
	return append([]BackupPlaceLocation{dedicated}, others...)
}
