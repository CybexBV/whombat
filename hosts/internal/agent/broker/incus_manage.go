package broker

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	incus "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"
	"github.com/lxc/incus/v6/shared/units"

	"rackoon/internal/proto"
)

// Guest management on Incus (proto.StreamManage, docs/MANAGE.md 2.5):
//
//	config.get / config.set:  GET / PUT /1.0/instances/<n>; the ETag is the digest (If-Match)
//	disk.resize:              devices.<disk>.size through the same PUT (root disk, grow only)
//	choices:                  projects, storage pools (+ resources), networks, profiles, local and remote images
//	guest.create:             POST /1.0/instances from an image (images: or local), in a project
//	guest.clone:              POST /1.0/instances {source: {type: copy}} (also into another project)
//	guest.delete:             DELETE /1.0/instances/<n> (stopped guests only)
//	guest.rename/move/publish, log.get:          incus_manage_guest.go
//	backup.*:                 incus_manage_backups.go (backups stay on the host)
//	task.list/status/stop:    GET/DELETE /1.0/operations ("incus:<uuid>"), incus_manage_tasks.go
//	profile.*, volume.*, image.*, network.leases: incus_manage_host.go
//
// Config keys and devices go through the allowlist below. Anything else a
// guest has (raw.*, security.privileged, idmaps, proxy, unix-*, gpu, usb
// and pci devices, disks with a host path) is reported as Restricted and
// never changed or removed.

const (
	// incusImageServer is where "images:<alias>" comes from.
	incusImageServer = "https://images.linuxcontainers.org"
	// incusConfigWait: config changes wait this long for their operation,
	// then answer with a task to follow instead.
	incusConfigWait = 60 * time.Second
	// incusTaskKeep: finished operations the agent started stay readable
	// this long (Incus forgets an operation 5 s after it ends); task.list
	// shows them. At most incusTaskMaxKept are kept.
	incusTaskKeep    = 48 * time.Hour
	incusTaskMaxKept = 200
	// incusTaskMax: a watcher gives up on an operation after this long.
	incusTaskMax = 24 * time.Hour
	// incusVMRootSize is Incus' size of a VM root disk without size=
	// (DefaultBlockSize).
	incusVMRootSize = 10 << 30
	// incusMaxValue / incusMaxText: limits for single-line values and for
	// texts (description, user.*).
	incusMaxValue = 1024
	incusMaxText  = 64 << 10
)

// incusFollowRetry is the pause before a task watcher reconnects (tests
// shorten it).
var incusFollowRetry = 5 * time.Second

func (d *incusDriver) manage(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if g == nil && manageGuestOps[req.Op] {
		return proto.ManageResponse{Code: CodeInvalid, Message: "this operation needs a guest"}
	}
	if req.Project != "" && !incusProjectRE.MatchString(req.Project) {
		return incusFieldError(proto.CodeInvalidValue, "project", "not a valid project name")
	}
	switch req.Op {
	case proto.OpConfigGet:
		return d.configGet(g)
	case proto.OpConfigSet:
		return d.configSet(ctx, g, req)
	case proto.OpDiskResize:
		return d.diskResize(ctx, g, req)
	case proto.OpChoices:
		return d.choices(req.Project)
	case proto.OpCreate:
		return d.create(ctx, req)
	case proto.OpClone:
		return d.clone(ctx, g, req)
	case proto.OpDelete:
		return d.deleteGuest(ctx, g)
	case proto.OpTaskStatus:
		return d.taskStatus(req)
	case proto.OpTaskList:
		return d.taskList(g)
	case proto.OpTaskStop:
		return d.taskStop(req)
	case proto.OpRename:
		return d.rename(ctx, g, req)
	case proto.OpMove:
		return d.move(ctx, g, req)
	case proto.OpPublish:
		return d.publish(ctx, g, req)
	case proto.OpLogGet:
		return d.logGet(g, req)
	case proto.OpBackupList:
		return d.backupList(g)
	case proto.OpBackupCreate:
		return d.backupCreate(ctx, g, req)
	case proto.OpBackupDelete:
		return d.backupDelete(ctx, g, req)
	case proto.OpBackupRestore:
		return d.backupRestore(g, req)
	case proto.OpNetworkLeases:
		return d.networkLeases(req)
	case proto.OpProfileGet:
		return d.profileGet(req)
	case proto.OpProfileCreate:
		return d.profileCreate(req)
	case proto.OpProfileUpdate:
		return d.profileUpdate(req)
	case proto.OpProfileDelete:
		return d.profileDelete(req)
	case proto.OpVolumeCreate:
		return d.volumeCreate(req)
	case proto.OpVolumeResize:
		return d.volumeResize(req)
	case proto.OpVolumeDelete:
		return d.volumeDelete(req)
	case proto.OpImageDownload:
		return d.imageDownload(ctx, req)
	case proto.OpImageRefresh:
		return d.imageRefresh(ctx, req)
	case proto.OpImageDelete:
		return d.imageDelete(ctx, req)
	}
	return proto.ManageResponse{Code: CodeUnsupported, Message: "Incus guests cannot do this through Whombat"}
}

// ---- allowlist -----------------------------------------------------------------

// incusKeyRule checks the value of an allowlisted config key.
type incusKeyRule struct {
	valid      func(string) bool
	hint       string
	containers bool // containers only
}

var (
	incusBoolRE     = regexp.MustCompile(`^(?i:true|false|yes|no|on|off|1|0)$`)
	incusUintRE     = regexp.MustCompile(`^\d{1,10}$`)
	incusCPUsRE     = regexp.MustCompile(`^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$`)
	incusMemoryRE   = regexp.MustCompile(`^\d{1,15}(%|B|kB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)?$`)
	incusScheduleRE = regexp.MustCompile(`^[A-Za-z0-9*/,@ ._-]{1,200}$`)
	incusExpiryRE   = regexp.MustCompile(`^[0-9A-Za-z ]{1,64}$`)
	incusUserKeyRE  = regexp.MustCompile(`^user\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

	// Device and option names, instance names, volume and image names.
	incusDeviceNameRE = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,62}$`)
	incusOptionRE     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,63}$`)
	incusInstanceRE   = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	incusVolumeRE     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	incusProfileRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	incusImageRE      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$`)
	incusHexRE        = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
	incusTaskRE       = regexp.MustCompile(`^incus:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
	incusProjectRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
)

// incusConfigKeys are the instance config keys Whombat changes (besides
// user.* and the description).
var incusConfigKeys = map[string]incusKeyRule{
	"limits.cpu":                 {valid: incusCPUsRE.MatchString, hint: "a number of CPUs or a CPU list (0-3,6)"},
	"limits.memory":              {valid: incusMemoryRE.MatchString, hint: "a size such as 4GiB, or a percentage"},
	"limits.memory.swap":         {valid: incusBoolRE.MatchString, hint: "true or false", containers: true},
	"limits.processes":           {valid: incusUintRE.MatchString, hint: "a whole number", containers: true},
	"boot.autostart":             {valid: incusBoolRE.MatchString, hint: "true or false"},
	"boot.autostart.priority":    {valid: incusUintRE.MatchString, hint: "a whole number"},
	"boot.autostart.delay":       {valid: incusUintRE.MatchString, hint: "a number of seconds"},
	"boot.host_shutdown_timeout": {valid: incusUintRE.MatchString, hint: "a number of seconds"},
	"security.protection.delete": {valid: incusBoolRE.MatchString, hint: "true or false"},
	"security.nesting":           {valid: incusBoolRE.MatchString, hint: "true or false", containers: true},
	"snapshots.schedule":         {valid: incusScheduleRE.MatchString, hint: "a cron expression or @hourly, @daily, ..."},
	"snapshots.expiry":           {valid: incusExpiryRE.MatchString, hint: "a duration such as 2w or 1d 12H"},
	"snapshots.pattern":          {valid: func(s string) bool { return s != "" }, hint: "a name pattern"},
}

// incusCloudInitKey is the cloud-init user data an instance boots with
// (create's cloud_init; /cloud images read it at their first boot).
const incusCloudInitKey = "cloud-init.user-data"

// incusKeyAllowed reports whether Whombat changes the config key on a
// guest of this kind ("profile": a profile, which may carry the
// container-only keys too).
func incusKeyAllowed(key, kind string) bool {
	if key == incusCloudInitKey {
		return true
	}
	if r, ok := incusConfigKeys[key]; ok {
		return !r.containers || kind == "container" || kind == "profile"
	}
	return incusUserKeyRE.MatchString(key)
}

// incusValueProblem checks the value of an allowlisted config key ("" =
// fine).
func incusValueProblem(key, value string) string {
	if key == incusCloudInitKey {
		return incusTextProblem(value, incusMaxCloudInit, true)
	}
	if r, ok := incusConfigKeys[key]; ok {
		if msg := incusTextProblem(value, incusMaxValue, false); msg != "" {
			return msg
		}
		if !r.valid(value) {
			return "expected " + r.hint
		}
		return ""
	}
	return incusTextProblem(value, incusMaxText, true)
}

// incusTextProblem checks a value: valid UTF-8, at most max bytes, no
// control characters (multi-line texts may have line breaks and tabs).
func incusTextProblem(s string, max int, multiline bool) string {
	if !utf8.ValidString(s) {
		return "not valid UTF-8"
	}
	if len(s) > max {
		return fmt.Sprintf("too long (at most %d bytes)", max)
	}
	for _, r := range s {
		if multiline && (r == '\n' || r == '\r' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) {
			return "control characters are not allowed"
		}
	}
	return ""
}

// Device options Whombat changes, per device type.
var (
	incusNICKeys = map[string]bool{
		"type": true, "name": true, "network": true, "nictype": true, "parent": true, "hwaddr": true,
		"mtu": true, "vlan": true, "vlan.tagged": true, "ipv4.address": true, "ipv6.address": true,
		"limits.ingress": true, "limits.egress": true, "limits.max": true, "limits.priority": true,
		"boot.priority": true, "security.mac_filtering": true, "security.ipv4_filtering": true,
		"security.ipv6_filtering": true, "security.port_isolation": true, "queue.tx.length": true,
	}
	incusDiskKeys = map[string]bool{
		"type": true, "path": true, "pool": true, "source": true, "size": true, "size.state": true,
		"readonly": true, "required": true, "boot.priority": true, "limits.read": true,
		"limits.write": true, "limits.max": true, "io.bus": true, "io.cache": true,
	}
)

// incusDeviceProblem says why a device is outside the allowlist ("" =
// Whombat may change it): NICs on an Incus network or a host bridge, and
// disks of a storage pool (the root disk, or a custom volume of the
// pool). It looks at the device alone; incusEnv.checkDevice adds what
// must exist on the host.
func incusDeviceProblem(dev map[string]string) string {
	var keys map[string]bool
	switch dev["type"] {
	case "nic":
		keys = incusNICKeys
	case "disk":
		keys = incusDiskKeys
	case "":
		return "the device has no type"
	default:
		return dev["type"] + " devices are not changed through Whombat"
	}
	for _, k := range slices.Sorted(maps.Keys(dev)) {
		if !keys[k] {
			return "the option " + k + " is not changed through Whombat"
		}
	}
	if dev["type"] == "nic" {
		switch {
		case dev["network"] != "" && dev["nictype"] == "" && dev["parent"] == "":
		case dev["network"] == "" && dev["nictype"] == "bridged" && dev["parent"] != "":
		default:
			return "only NICs on an Incus network (network=) or a host bridge (nictype=bridged,parent=) are changed through Whombat"
		}
		return ""
	}
	if dev["pool"] == "" {
		return "disks outside a storage pool (host paths) are not changed through Whombat"
	}
	if s, ok := dev["source"]; ok && !incusVolumeRE.MatchString(s) {
		return "the source of a disk must be a custom volume of its pool"
	}
	return ""
}

// ---- device strings --------------------------------------------------------------

// incusDeviceString writes a device as "type=disk,path=/,pool=default":
// type first, then the other options sorted by name.
func incusDeviceString(dev map[string]string) string {
	keys := make([]string, 0, len(dev))
	for k := range dev {
		if k != "type" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if _, ok := dev["type"]; ok {
		keys = append([]string{"type"}, keys...)
	}
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + dev[k]
	}
	return strings.Join(parts, ",")
}

// incusParseDevice reads incusDeviceString's format in any order. An item
// without "=" continues the previous value, so lists keep their commas
// ("vlan.tagged=10,20").
func incusParseDevice(s string) (map[string]string, error) {
	dev := map[string]string{}
	last := ""
	for _, item := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(item, "=")
		if !ok {
			if last == "" || item == "" {
				return nil, fmt.Errorf("%q is not an option (name=value)", item)
			}
			dev[last] += "," + item
			continue
		}
		if !incusOptionRE.MatchString(k) {
			return nil, fmt.Errorf("%q is not a valid option name", k)
		}
		if _, dup := dev[k]; dup {
			return nil, fmt.Errorf("the option %s is given twice", k)
		}
		dev[k] = v
		last = k
	}
	if dev["type"] == "" {
		return nil, errors.New("the device has no type (type=nic or type=disk)")
	}
	return dev, nil
}

// incusRootDisk returns the root disk device (type disk, path /).
func incusRootDisk(devs api.DevicesMap) (string, map[string]string) {
	for _, name := range slices.Sorted(maps.Keys(devs)) {
		if dev := devs[name]; dev["type"] == "disk" && dev["path"] == "/" && dev["source"] == "" {
			return name, dev
		}
	}
	return "", nil
}

// ---- requests and answers ----------------------------------------------------------

// incusResp answers with the code of a codeError (connect, validation).
func incusResp(err error) proto.ManageResponse {
	code, msg := errCode(err, CodePlatformError)
	return proto.ManageResponse{Code: code, Message: msg}
}

// incusMsg is the first line of an Incus error, at most 500 characters.
func incusMsg(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if r := []rune(s); len(r) > 500 {
		s = string(r[:500])
	}
	return s
}

// incusFail maps an Incus API error: 412 (ETag) -> digest_mismatch, 404 ->
// notFound, 403 -> not_allowed, 400 -> invalid_value, anything else ->
// platform_error.
func incusFail(err error, notFound string) proto.ManageResponse {
	msg := incusMsg(err.Error())
	code := CodePlatformError
	switch {
	case api.StatusErrorCheck(err, http.StatusPreconditionFailed):
		code, msg = proto.CodeDigestMismatch, "the configuration changed since it was read"
	case api.StatusErrorCheck(err, http.StatusNotFound):
		code = notFound
	case api.StatusErrorCheck(err, http.StatusForbidden):
		code = proto.CodeNotAllowed
	case api.StatusErrorCheck(err, http.StatusBadRequest):
		code = proto.CodeInvalidValue
	}
	return proto.ManageResponse{Code: code, Message: msg}
}

// incusFieldError refuses one field.
func incusFieldError(code, field, msg string) proto.ManageResponse {
	return proto.ManageResponse{Code: code, Message: field + ": " + msg, FieldErrors: map[string]string{field: msg}}
}

// incusDigest is the ETag without its quotes.
func incusDigest(etag string) string { return strings.Trim(etag, `"`) }

func incusKind(typ string) string {
	if typ == string(api.InstanceTypeVM) {
		return "vm"
	}
	return "container"
}

// incusActive: running or frozen (not stopped).
func incusActive(status string) bool {
	s := normIncusState(status)
	return s == proto.StateRunning || s == proto.StatePaused
}

// server connects for host operations (default project).
func (d *incusDriver) server() (incus.InstanceServer, error) {
	c, err := incus.ConnectIncusUnix(d.socket, &incus.ConnectionArgs{UserAgent: "whombat-agent", SkipGetEvents: true})
	if err != nil {
		return nil, codeErr(CodePlatformError, "cannot reach Incus: "+err.Error())
	}
	return c, nil
}

// ---- config.get ------------------------------------------------------------------

func (d *incusDriver) configGet(g *proto.Guest) proto.ManageResponse {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, etag, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	return proto.ManageResponse{OK: true, Config: incusGuestConfig(inst, etag)}
}

// incusGuestConfig is config.get's answer: the expanded config without
// volatile.* keys, the description, and every device (profiles' too) as
// "device.<name>".
func incusGuestConfig(inst *api.Instance, etag string) *proto.GuestConfig {
	kind := incusKind(inst.Type)
	cfg := &proto.GuestConfig{
		Platform: proto.PlatformIncus,
		Kind:     kind,
		Digest:   incusDigest(etag),
		Running:  incusActive(inst.Status),
		Values:   map[string]string{},
		Profiles: append([]string{}, inst.Profiles...),
	}
	for k, v := range inst.ExpandedConfig {
		if strings.HasPrefix(k, "volatile.") {
			continue
		}
		cfg.Values[k] = v
		if _, own := inst.Config[k]; !own {
			cfg.Inherited = append(cfg.Inherited, k)
		}
		if !incusKeyAllowed(k, kind) {
			cfg.Restricted = append(cfg.Restricted, k)
		}
	}
	if inst.Description != "" {
		cfg.Values["description"] = inst.Description
	}
	for name, dev := range inst.ExpandedDevices {
		key := "device." + name
		cfg.Values[key] = incusDeviceString(dev)
		if _, own := inst.Devices[name]; !own {
			cfg.Inherited = append(cfg.Inherited, key)
		}
		if incusDeviceProblem(dev) != "" {
			cfg.Restricted = append(cfg.Restricted, key)
		}
		if dev["type"] == "disk" {
			cfg.Disks = append(cfg.Disks, incusDisk(name, kind, dev))
		}
	}
	sort.Strings(cfg.Inherited)
	sort.Strings(cfg.Restricted)
	sort.Slice(cfg.Disks, func(i, j int) bool {
		if ri, rj := cfg.Disks[i].Path == "/", cfg.Disks[j].Path == "/"; ri != rj {
			return ri
		}
		return cfg.Disks[i].Key < cfg.Disks[j].Key
	})
	return cfg
}

// incusDisk describes a disk device for display. A VM root disk without
// size= has Incus' default size.
func incusDisk(name, kind string, dev map[string]string) proto.GuestDisk {
	d := proto.GuestDisk{Key: name, Storage: dev["pool"], Volume: dev["source"], Media: "disk", Path: dev["path"],
		Boot: dev["path"] == "/" || dev["boot.priority"] != ""}
	if n, err := units.ParseByteSizeString(dev["size"]); err == nil && n > 0 {
		d.SizeBytes = uint64(n)
	} else if kind == "vm" && dev["path"] == "/" && dev["size"] == "" {
		d.SizeBytes = incusVMRootSize
	}
	return d
}

// ---- config.set ------------------------------------------------------------------

// incusEnv is what device checks look up on the host, read once per
// request when a device needs it.
type incusEnv struct {
	c       incus.InstanceServer
	loaded  bool
	err     error
	managed map[string]bool            // managed networks
	bridges map[string]bool            // bridges (managed or not)
	pools   map[string]api.StoragePool // storage pools
}

func (e *incusEnv) load() error {
	if e.loaded {
		return e.err
	}
	e.loaded = true
	nets, err := e.c.GetNetworks()
	if err != nil {
		e.err = err
		return err
	}
	pools, err := e.c.GetStoragePools()
	if err != nil {
		e.err = err
		return err
	}
	e.managed, e.bridges, e.pools = map[string]bool{}, map[string]bool{}, map[string]api.StoragePool{}
	for _, n := range nets {
		if n.Managed {
			e.managed[n.Name] = true
		}
		if n.Type == "bridge" {
			e.bridges[n.Name] = true
		}
	}
	for _, p := range pools {
		e.pools[p.Name] = p
	}
	return nil
}

// checkDevice validates a device a user adds or changes and returns it
// normalized: a NIC whose network= names a host bridge Incus does not
// manage becomes nictype=bridged,parent=<bridge> (Choices.Bridges lists
// both kinds).
func (e *incusEnv) checkDevice(kind string, dev map[string]string) (map[string]string, string, string) {
	for _, k := range slices.Sorted(maps.Keys(dev)) {
		if msg := incusTextProblem(dev[k], incusMaxValue, false); msg != "" {
			return nil, proto.CodeInvalidValue, k + ": " + msg
		}
	}
	if err := e.load(); err != nil {
		return nil, CodePlatformError, incusMsg(err.Error())
	}
	if n := dev["network"]; dev["type"] == "nic" && n != "" && !e.managed[n] && e.bridges[n] && dev["nictype"] == "" && dev["parent"] == "" {
		dev = maps.Clone(dev)
		delete(dev, "network")
		dev["nictype"], dev["parent"] = "bridged", n
	}
	if msg := incusDeviceProblem(dev); msg != "" {
		return nil, proto.CodeNotAllowed, msg
	}
	if dev["type"] == "nic" {
		if n := dev["network"]; n != "" && !e.managed[n] {
			return nil, proto.CodeInvalidValue, "there is no Incus network " + n
		}
		if p := dev["parent"]; p != "" && !e.bridges[p] {
			return nil, proto.CodeInvalidValue, "there is no bridge " + p
		}
		return dev, "", ""
	}
	pool, path, source := dev["pool"], dev["path"], dev["source"]
	if _, ok := e.pools[pool]; !ok {
		return nil, proto.CodeInvalidValue, "there is no storage pool " + pool
	}
	if kind == "container" && path == "" {
		return nil, proto.CodeInvalidValue, "a container disk needs a path inside the container"
	}
	if path != "" && (!strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..")) {
		return nil, proto.CodeInvalidValue, "path must be an absolute path inside the guest"
	}
	if s, ok := dev["size"]; ok {
		if n, err := units.ParseByteSizeString(s); err != nil || n <= 0 {
			return nil, proto.CodeInvalidValue, "size must be a size such as 20GiB"
		}
		if path != "/" || source != "" {
			return nil, proto.CodeInvalidValue, "only the root disk has a size here; resize custom volumes in Incus"
		}
	}
	switch {
	case source == "" && path != "/":
		return nil, proto.CodeInvalidValue, "a disk other than the root disk needs a custom volume of the pool (source=)"
	case source != "" && path == "/":
		return nil, proto.CodeInvalidValue, "the root disk cannot be a custom volume"
	case source != "":
		if _, _, err := e.c.GetStoragePoolVolume(pool, "custom", source); err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return nil, proto.CodeInvalidValue, "pool " + pool + " has no custom volume " + source
			}
			return nil, CodePlatformError, incusMsg(err.Error())
		}
	}
	return dev, "", ""
}

// incusChange applies config.set or create keys to an instance's own
// config and devices, collecting what changed and why keys were refused.
type incusChange struct {
	kind     string
	env      *incusEnv
	before   map[string]string // config.get's Values
	expanded api.DevicesMap    // devices including the profiles'
	own      api.InstancePut   // the instance's own config and devices, being changed
	changes  []proto.ConfigChange
	errs     map[string]string
	denied   bool   // a key outside the allowlist
	failed   string // Incus could not be asked (networks, pools, volumes)
}

func newIncusChange(c incus.InstanceServer, kind string, inst *api.Instance) *incusChange {
	ch := &incusChange{kind: kind, env: &incusEnv{c: c}, before: map[string]string{}, errs: map[string]string{}}
	if inst != nil {
		ch.before = incusGuestConfig(inst, "").Values
		ch.expanded = inst.ExpandedDevices
		ch.own = inst.Writable()
	}
	ch.own.Config = maps.Clone(ch.own.Config)
	if ch.own.Config == nil {
		ch.own.Config = api.ConfigMap{}
	}
	ch.own.Devices = maps.Clone(ch.own.Devices)
	if ch.own.Devices == nil {
		ch.own.Devices = api.DevicesMap{}
	}
	return ch
}

func (ch *incusChange) refuse(key, code, msg string) {
	ch.errs[key] = msg
	switch code {
	case proto.CodeNotAllowed:
		ch.denied = true
	case CodePlatformError:
		ch.failed = msg
	}
}

// restrictedDevice: the guest's current device of that name is outside
// the allowlist (it is never replaced or removed).
func (ch *incusChange) restrictedDevice(name string) bool {
	cur, ok := ch.expanded[name]
	return ok && incusDeviceProblem(cur) != ""
}

func (ch *incusChange) set(key, value string) {
	if value == "" && key != "description" {
		ch.remove(key)
		return
	}
	old := ch.before[key]
	switch {
	case key == "description":
		if msg := incusTextProblem(value, incusMaxText, true); msg != "" {
			ch.refuse(key, proto.CodeInvalidValue, msg)
			return
		}
		if value != old {
			ch.own.Description = value
		}
	case strings.HasPrefix(key, "device."):
		name := strings.TrimPrefix(key, "device.")
		if !incusDeviceNameRE.MatchString(name) {
			ch.refuse(key, proto.CodeInvalidValue, "device names have up to 63 letters, digits, '.', '_' and '-'")
			return
		}
		if ch.restrictedDevice(name) {
			ch.refuse(key, proto.CodeNotAllowed, "this device is not changed through Whombat")
			return
		}
		dev, err := incusParseDevice(value)
		if err != nil {
			ch.refuse(key, proto.CodeInvalidValue, err.Error())
			return
		}
		dev, code, msg := ch.env.checkDevice(ch.kind, dev)
		if code != "" {
			ch.refuse(key, code, msg)
			return
		}
		if value = incusDeviceString(dev); value != old {
			ch.own.Devices[name] = dev
		}
	default:
		if !incusKeyAllowed(key, ch.kind) {
			ch.refuse(key, proto.CodeNotAllowed, "this key is not changed through Whombat")
			return
		}
		if msg := incusValueProblem(key, value); msg != "" {
			ch.refuse(key, proto.CodeInvalidValue, msg)
			return
		}
		if value != old {
			ch.own.Config[key] = value
		}
	}
	if value != old {
		ch.changes = append(ch.changes, proto.ConfigChange{Key: key, Old: old, New: value})
	}
}

// remove drops a key of the instance's own config or devices. Keys that
// come from a profile stay (change the profile in Incus).
func (ch *incusChange) remove(key string) {
	old, present := ch.before[key]
	switch {
	case key == "description":
		ch.own.Description = ""
	case strings.HasPrefix(key, "device."):
		name := strings.TrimPrefix(key, "device.")
		if ch.restrictedDevice(name) {
			ch.refuse(key, proto.CodeNotAllowed, "this device is not changed through Whombat")
			return
		}
		if _, own := ch.own.Devices[name]; !own {
			if present {
				ch.refuse(key, proto.CodeInvalidValue, "this device comes from a profile; change the profile in Incus")
			}
			return
		}
		delete(ch.own.Devices, name)
	default:
		if !incusKeyAllowed(key, ch.kind) {
			ch.refuse(key, proto.CodeNotAllowed, "this key is not changed through Whombat")
			return
		}
		if _, own := ch.own.Config[key]; !own {
			if present {
				ch.refuse(key, proto.CodeInvalidValue, "this key comes from a profile; change the profile in Incus")
			}
			return
		}
		delete(ch.own.Config, key)
	}
	if present {
		ch.changes = append(ch.changes, proto.ConfigChange{Key: key, Old: old})
	}
}

// apply runs Set and Delete in a stable order.
func (ch *incusChange) apply(set map[string]string, del []string) {
	for _, k := range slices.Sorted(maps.Keys(set)) {
		if slices.Contains(del, k) {
			ch.refuse(k, proto.CodeInvalidValue, "set and removed in the same change")
			continue
		}
		ch.set(k, set[k])
	}
	for _, k := range slices.Compact(slices.Sorted(slices.Values(del))) {
		if _, inSet := set[k]; !inSet {
			ch.remove(k)
		}
	}
}

// setProfiles replaces the instance's profiles (in order). Each must be a
// profile of the instance's project; applying an existing profile is an
// everyday Incus change (IU-04), whatever the profile holds.
func (ch *incusChange) setProfiles(profiles []string) {
	for _, p := range profiles {
		if !incusProfileRE.MatchString(p) {
			ch.refuse("profiles", proto.CodeInvalidValue, "not a valid profile name: "+p)
			return
		}
	}
	if len(slices.Compact(slices.Sorted(slices.Values(profiles)))) != len(profiles) {
		ch.refuse("profiles", proto.CodeInvalidValue, "a profile is listed twice")
		return
	}
	names, err := ch.env.c.GetProfileNames()
	if err != nil {
		ch.refuse("profiles", CodePlatformError, incusMsg(err.Error()))
		return
	}
	for _, p := range profiles {
		if !slices.Contains(names, p) {
			ch.refuse("profiles", proto.CodeInvalidValue, "there is no profile "+p)
			return
		}
	}
	if slices.Equal(profiles, ch.own.Profiles) {
		return
	}
	ch.changes = append(ch.changes, proto.ConfigChange{Key: "profiles", Old: strings.Join(ch.own.Profiles, ", "), New: strings.Join(profiles, ", ")})
	ch.own.Profiles = slices.Clone(profiles)
}

// incusMergeDevices turns a Devices map (name -> options, nil removes)
// into "device.<name>" keys of Set and Delete, so they go through the same
// allowlist. A device named twice is refused.
func incusMergeDevices(set map[string]string, del []string, devices map[string]map[string]string) (map[string]string, []string, string) {
	if len(devices) == 0 {
		return set, del, ""
	}
	out := maps.Clone(set)
	if out == nil {
		out = map[string]string{}
	}
	del = slices.Clone(del)
	for _, name := range slices.Sorted(maps.Keys(devices)) {
		key := "device." + name
		if _, dup := out[key]; dup || slices.Contains(del, key) {
			return nil, nil, "the device " + name + " is changed twice"
		}
		dev := devices[name]
		if dev == nil {
			del = append(del, key)
			continue
		}
		if len(dev) == 0 {
			return nil, nil, "the device " + name + " has no options"
		}
		out[key] = incusDeviceString(dev)
	}
	return out, del, ""
}

// refusal is the answer when keys were refused (nil: none).
func (ch *incusChange) refusal() *proto.ManageResponse {
	if len(ch.errs) == 0 {
		return nil
	}
	if ch.failed != "" {
		return &proto.ManageResponse{Code: CodePlatformError, Message: ch.failed}
	}
	code := proto.CodeInvalidValue
	if ch.denied {
		code = proto.CodeNotAllowed
	}
	keys := slices.Sorted(maps.Keys(ch.errs))
	msg := keys[0] + ": " + ch.errs[keys[0]]
	if len(keys) > 1 {
		msg += fmt.Sprintf(" (and %d more)", len(keys)-1)
	}
	return &proto.ManageResponse{Code: code, Message: msg, FieldErrors: ch.errs}
}

func (d *incusDriver) configSet(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if len(req.Set) == 0 && len(req.Delete) == 0 && len(req.Revert) == 0 && len(req.Devices) == 0 && len(req.Profiles) == 0 {
		return proto.ManageResponse{Code: CodeInvalid, Message: "nothing to change"}
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, etag, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	digest := incusDigest(etag)
	if req.Digest != "" && req.Digest != digest {
		return proto.ManageResponse{Code: proto.CodeDigestMismatch, Message: "the configuration changed since it was read"}
	}
	ch := newIncusChange(c, incusKind(inst.Type), inst)
	for _, k := range req.Revert {
		ch.refuse(k, proto.CodeInvalidValue, "Incus applies changes at once; there is nothing to revert")
	}
	set, del, msg := incusMergeDevices(req.Set, req.Delete, req.Devices)
	if msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "devices", msg)
	}
	ch.apply(set, del)
	if len(req.Profiles) > 0 {
		ch.setProfiles(req.Profiles)
	}
	if r := ch.refusal(); r != nil {
		return *r
	}
	if len(ch.changes) == 0 {
		return proto.ManageResponse{OK: true}
	}
	op, err := c.UpdateInstance(name, ch.own, digest)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	resp := d.opResult(ctx, c, op.Get(), g.ID, incusConfigWait)
	if resp.OK {
		resp.Changes = ch.changes
	}
	return resp
}

// ---- disk.resize -------------------------------------------------------------------

var incusSizeRE = regexp.MustCompile(`^(\+)?(\d+(?:\.\d+)?)\s*([kKMGTP]?)(i?B)?$`)

// incusParseSize reads a requested size: "+8G" grows by 8 GiB, "40G" is
// the new total. K, M, G, T, P and KiB ... PiB are binary units, kB ... PB
// decimal (as in Incus); a number alone is bytes.
func incusParseSize(s string) (n uint64, relative bool, err error) {
	m := incusSizeRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil || (m[3] == "" && m[4] == "iB") {
		return 0, false, errors.New("expected a size such as +8G or 40GiB")
	}
	f, err := strconv.ParseFloat(m[2], 64)
	if err != nil {
		return 0, false, errors.New("expected a size such as +8G or 40GiB")
	}
	exp := 0
	if m[3] != "" {
		exp = strings.Index("KMGTP", strings.ToUpper(m[3])) + 1
	}
	mult := 1.0
	for range exp {
		if m[4] == "B" {
			mult *= 1000
		} else {
			mult *= 1024
		}
	}
	v := f * mult
	if v < 1 || v > 1<<60 {
		return 0, false, errors.New("the size is out of range")
	}
	return uint64(v), m[1] == "+", nil
}

// incusSizeString writes a size the way Incus does ("48GiB").
func incusSizeString(n uint64) string {
	switch {
	case n%(1<<30) == 0:
		return strconv.FormatUint(n>>30, 10) + "GiB"
	case n%(1<<20) == 0:
		return strconv.FormatUint(n>>20, 10) + "MiB"
	}
	return strconv.FormatUint(n, 10) + "B"
}

func (d *incusDriver) diskResize(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	want, relative, err := incusParseSize(req.Size)
	if err != nil {
		return incusFieldError(proto.CodeInvalidValue, "size", err.Error())
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, etag, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	digest := incusDigest(etag)
	if req.Digest != "" && req.Digest != digest {
		return proto.ManageResponse{Code: proto.CodeDigestMismatch, Message: "the configuration changed since it was read"}
	}
	dev, ok := inst.ExpandedDevices[req.Disk]
	switch {
	case !ok || dev["type"] != "disk":
		return incusFieldError(proto.CodeNotFound, "disk", "the guest has no disk "+req.Disk)
	case incusDeviceProblem(dev) != "":
		return incusFieldError(proto.CodeNotAllowed, "disk", "this disk is not changed through Whombat")
	case dev["source"] != "":
		return incusFieldError(proto.CodeInvalidValue, "disk", "this disk is the custom volume "+dev["source"]+"; resize it in Incus")
	case dev["path"] != "/":
		return incusFieldError(proto.CodeInvalidValue, "disk", "only the root disk can be resized here")
	}
	kind := incusKind(inst.Type)
	cur, err := incusRootSize(c, kind, dev)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	if cur == 0 {
		return incusFieldError(proto.CodeInvalidValue, "disk", "this disk has no size limit (it can use the whole pool)")
	}
	if relative {
		want += cur
	}
	switch {
	case want < cur:
		return incusFieldError(proto.CodeInvalidValue, "size", "disks only grow: the disk has "+incusSizeString(cur))
	case want == cur:
		return proto.ManageResponse{OK: true}
	}
	ndev := maps.Clone(dev) // a profile's root disk becomes the instance's own
	ndev["size"] = incusSizeString(want)
	put := inst.Writable()
	put.Devices = maps.Clone(put.Devices)
	if put.Devices == nil {
		put.Devices = api.DevicesMap{}
	}
	put.Devices[req.Disk] = ndev
	op, err := c.UpdateInstance(name, put, digest)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	resp := d.opResult(ctx, c, op.Get(), g.ID, incusConfigWait)
	if resp.OK {
		resp.Changes = []proto.ConfigChange{{Key: "device." + req.Disk, Old: incusDeviceString(dev), New: incusDeviceString(ndev)}}
	}
	return resp
}

// incusRootSize is the size of a root disk: its size=, else the pool's
// volume.size, else Incus' default for VMs; 0 when it has no limit (a
// container on a file system pool).
func incusRootSize(c incus.InstanceServer, kind string, dev map[string]string) (uint64, error) {
	if s := dev["size"]; s != "" {
		n, err := units.ParseByteSizeString(s)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("cannot read the disk's size %q", s)
		}
		return uint64(n), nil
	}
	pool, _, err := c.GetStoragePool(dev["pool"])
	if err != nil {
		return 0, err
	}
	if s := pool.Config["volume.size"]; s != "" {
		if n, err := units.ParseByteSizeString(s); err == nil && n > 0 {
			return uint64(n), nil
		}
	}
	if kind == "vm" {
		return incusVMRootSize, nil
	}
	return 0, nil
}

// ---- choices ---------------------------------------------------------------------

// incusThin: drivers whose volumes take space as they are written.
func incusThin(p api.StoragePool) bool {
	switch p.Driver {
	case "zfs", "btrfs", "dir", "ceph", "cephfs":
		return true
	case "lvm":
		return p.Config["lvm.use_thinpool"] != "false"
	}
	return false
}

// incusDockerBridgeRE matches the bridges Docker makes: Incus lists them,
// but no instance belongs on them.
var incusDockerBridgeRE = regexp.MustCompile(`^(docker0|br-[0-9a-f]{12})$`)

// incusRemoteImages are the common images of images: offered by the create
// form (a free alias is accepted too). Each base image comes as container
// and VM, and most with a /cloud variant that runs cloud-init.
var incusRemoteImages = func() []proto.RemoteImage {
	var out []proto.RemoteImage
	for _, im := range []struct {
		alias, desc string
		cloud       bool
	}{
		{"debian/13", "Debian 13 (trixie)", true}, {"debian/12", "Debian 12 (bookworm)", true},
		{"ubuntu/24.04", "Ubuntu 24.04 LTS (noble)", true}, {"ubuntu/22.04", "Ubuntu 22.04 LTS (jammy)", true},
		{"alpine/3.22", "Alpine 3.22", true}, {"fedora/42", "Fedora 42", true}, {"archlinux", "Arch Linux", true},
		{"rockylinux/9", "Rocky Linux 9", true}, {"nixos/25.05", "NixOS 25.05", false},
	} {
		for _, typ := range []string{"container", "virtual-machine"} {
			out = append(out, proto.RemoteImage{Alias: im.alias, Description: im.desc, Type: typ})
			if im.cloud {
				out = append(out, proto.RemoteImage{Alias: im.alias + "/cloud", Description: im.desc + " with cloud-init", Type: typ})
			}
		}
	}
	return out
}()

func (d *incusDriver) choices(project string) proto.ManageResponse {
	c, err := d.server()
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	out := &proto.Choices{Platform: proto.PlatformIncus, Storages: []proto.ChoiceStorage{}, Bridges: []string{},
		RemoteImages: incusRemoteImages, Project: "default"}
	if out.Projects, err = c.GetProjectNames(); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	sort.Strings(out.Projects)
	if project != "" {
		if !slices.Contains(out.Projects, project) {
			return incusFieldError(proto.CodeInvalidValue, "project", "there is no project "+project)
		}
		c = c.UseProject(project)
		out.Project = project
	}
	pools, err := c.GetStoragePools()
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	for _, p := range pools {
		if p.Driver == "cephobject" || (p.Status != "" && p.Status != "Created") {
			continue // buckets only, or not usable
		}
		s := proto.ChoiceStorage{ID: p.Name, Type: p.Driver, Content: []string{"images", "rootdir"}, Thin: incusThin(p),
			Shared: slices.Contains([]string{"ceph", "cephfs", "lvmcluster", "linstor"}, p.Driver)}
		if res, err := c.GetStoragePoolResources(p.Name); err == nil && res.Space.Total > 0 {
			s.TotalBytes = res.Space.Total
			if res.Space.Used < res.Space.Total {
				s.AvailBytes = res.Space.Total - res.Space.Used
			}
		}
		out.Storages = append(out.Storages, s)
	}
	sort.Slice(out.Storages, func(i, j int) bool { return out.Storages[i].ID < out.Storages[j].ID })
	nets, err := c.GetNetworks()
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	for _, n := range nets {
		// Managed networks (network=) and host bridges (nictype=bridged),
		// not Docker's.
		if (n.Managed && n.Type != "loopback") || (n.Type == "bridge" && !incusDockerBridgeRE.MatchString(n.Name)) {
			out.Bridges = append(out.Bridges, n.Name)
		}
	}
	sort.Strings(out.Bridges)
	if out.Profiles, err = c.GetProfileNames(); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	sort.Strings(out.Profiles)
	images, err := c.GetImages()
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	for _, im := range images {
		ii := proto.IncusImage{Fingerprint: im.Fingerprint, Description: im.Properties["description"], Type: im.Type}
		if im.Size > 0 {
			ii.SizeBytes = uint64(im.Size)
		}
		for _, a := range im.Aliases {
			ii.Aliases = append(ii.Aliases, a.Name)
		}
		out.Images = append(out.Images, ii)
	}
	sort.Slice(out.Images, func(i, j int) bool {
		a, b := out.Images[i], out.Images[j]
		if (len(a.Aliases) > 0) != (len(b.Aliases) > 0) {
			return len(a.Aliases) > 0
		}
		if len(a.Aliases) > 0 && a.Aliases[0] != b.Aliases[0] {
			return a.Aliases[0] < b.Aliases[0]
		}
		return a.Fingerprint < b.Fingerprint
	})
	return proto.ManageResponse{OK: true, Choices: out}
}

// ---- guest.create / guest.clone / guest.delete ------------------------------------

// incusNameProblem checks a new instance name (Incus: a host name that is
// not a number).
func incusNameProblem(name string) string {
	if !incusInstanceRE.MatchString(name) {
		return "1 to 63 letters, digits and '-', not starting or ending with '-'"
	}
	if _, err := strconv.ParseUint(name, 10, 64); err == nil {
		return "a name cannot be a number"
	}
	return ""
}

// incusImageSource turns the requested image into the instance source:
// "images:<alias>" from the public image server, or an image of the local
// store by alias or fingerprint (optionally "local:<...>"). Other remotes
// are refused. local is the reference to resolve in the local store.
func incusImageSource(image string) (src api.InstanceSource, local string, code, msg string) {
	if image == "" {
		return src, "", proto.CodeInvalidValue, "choose an image"
	}
	ref := image
	if remote, rest, ok := strings.Cut(image, ":"); ok {
		switch remote {
		case "images":
			ref = rest
		case "local":
			ref, local = rest, rest
		default:
			return src, "", proto.CodeNotAllowed, "images come from images: (images.linuxcontainers.org) or the local image store"
		}
	} else {
		local = image
	}
	if len(ref) > 200 || !incusImageRE.MatchString(ref) {
		return src, "", proto.CodeInvalidValue, "not a valid image name"
	}
	if local != "" {
		return api.InstanceSource{Type: "image"}, local, "", ""
	}
	return api.InstanceSource{Type: "image", Mode: "pull", Server: incusImageServer, Protocol: "simplestreams", Alias: ref}, "", "", ""
}

// incusResolveImage finds a local image by alias or by a fingerprint
// prefix of at least 12 characters.
func incusResolveImage(images []api.Image, ref string) (*api.Image, string) {
	for i := range images {
		for _, a := range images[i].Aliases {
			if a.Name == ref {
				return &images[i], ""
			}
		}
	}
	if !incusHexRE.MatchString(ref) {
		return nil, "the local image store has no image " + ref
	}
	var found *api.Image
	for i := range images {
		if strings.HasPrefix(images[i].Fingerprint, ref) {
			if found != nil {
				return nil, "more than one local image matches " + ref
			}
			found = &images[i]
		}
	}
	if found == nil {
		return nil, "the local image store has no image " + ref
	}
	return found, ""
}

// incusMaxCloudInit is the largest cloud-init user data accepted.
const incusMaxCloudInit = 64 << 10

// incusID is an instance's platform id in a project ("lab/db"; the
// default project is left out).
func incusID(project, name string) string {
	if project != "" && project != "default" {
		return project + "/" + name
	}
	return name
}

// projectServer connects for host operations in a project ("" =
// default), checking that the project exists.
func (d *incusDriver) projectServer(project string) (incus.InstanceServer, *proto.ManageResponse) {
	c, err := d.server()
	if err != nil {
		r := incusResp(err)
		return nil, &r
	}
	if project == "" || project == "default" {
		return c, nil
	}
	if _, _, err := c.GetProject(project); err != nil {
		c.Disconnect()
		var r proto.ManageResponse
		if api.StatusErrorCheck(err, http.StatusNotFound) {
			r = incusFieldError(proto.CodeInvalidValue, "project", "there is no project "+project)
		} else {
			r = incusFail(err, proto.CodeNotFound)
		}
		return nil, &r
	}
	return c.UseProject(project), nil
}

func (d *incusDriver) create(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	var typ api.InstanceType
	switch req.Kind {
	case "vm":
		typ = api.InstanceTypeVM
	case "container":
		typ = api.InstanceTypeContainer
	default:
		return incusFieldError(proto.CodeInvalidValue, "kind", "vm or container")
	}
	if msg := incusNameProblem(req.Name); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "name", msg)
	}
	src, local, code, msg := incusImageSource(req.Image)
	if code != "" {
		return incusFieldError(code, "image", msg)
	}
	for _, p := range req.Profiles {
		if !incusProfileRE.MatchString(p) {
			return incusFieldError(proto.CodeInvalidValue, "profiles", "not a valid profile name: "+p)
		}
	}
	if msg := incusTextProblem(req.CloudInit, incusMaxCloudInit, true); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "cloud_init", msg)
	}
	if req.Pool != "" && !incusVolumeRE.MatchString(req.Pool) {
		return incusFieldError(proto.CodeInvalidValue, "pool", "not a valid pool name")
	}
	if req.Network != "" && !incusDeviceNameRE.MatchString(req.Network) {
		return incusFieldError(proto.CodeInvalidValue, "network", "not a valid network name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if local != "" {
		images, err := c.GetImages()
		if err != nil {
			return incusFail(err, proto.CodeNotFound)
		}
		im, msg := incusResolveImage(images, local)
		if im == nil {
			return incusFieldError(proto.CodeInvalidValue, "image", msg)
		}
		if im.Type != "" && im.Type != string(typ) {
			return incusFieldError(proto.CodeInvalidValue, "image", "this image is for a "+strings.ReplaceAll(im.Type, "-", " "))
		}
		src.Fingerprint = im.Fingerprint
	}
	if len(req.Profiles) > 0 {
		names, err := c.GetProfileNames()
		if err != nil {
			return incusFail(err, proto.CodeNotFound)
		}
		for _, p := range req.Profiles {
			if !slices.Contains(names, p) {
				return incusFieldError(proto.CodeInvalidValue, "profiles", "there is no profile "+p)
			}
		}
		if len(slices.Compact(slices.Sorted(slices.Values(req.Profiles)))) != len(req.Profiles) {
			return incusFieldError(proto.CodeInvalidValue, "profiles", "a profile is listed twice")
		}
	}
	set := maps.Clone(req.Set)
	if set == nil {
		set = map[string]string{}
	}
	// The pool, network and cloud-init fields are shorthands for the root
	// disk, eth0 and cloud-init.user-data; they go through the allowlist
	// like every other key.
	if req.Pool != "" {
		root := map[string]string{"type": "disk", "path": "/"}
		if v, ok := set["device.root"]; ok {
			dev, err := incusParseDevice(v)
			if err != nil {
				return incusFieldError(proto.CodeInvalidValue, "device.root", err.Error())
			}
			root = dev
		}
		root["pool"] = req.Pool
		set["device.root"] = incusDeviceString(root)
	}
	if _, ok := set["device.eth0"]; req.Network != "" && !ok {
		set["device.eth0"] = incusDeviceString(map[string]string{"type": "nic", "name": "eth0", "network": req.Network})
	}
	if req.CloudInit != "" {
		set["cloud-init.user-data"] = req.CloudInit
	}
	ch := newIncusChange(c, req.Kind, nil)
	ch.apply(set, nil)
	if r := ch.refusal(); r != nil {
		return *r
	}
	if _, _, err := c.GetInstance(req.Name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "an instance named "+req.Name+" exists")
	}
	body := api.InstancesPost{Name: req.Name, Type: typ, Source: src, Start: req.Start, InstancePut: ch.own}
	if len(req.Profiles) > 0 { // none: the default profile
		body.Profiles = req.Profiles
	}
	op, err := c.CreateInstance(body)
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, proto.CodeNotFound)
	}
	newID := incusID(req.Project, req.Name)
	resp := d.opResult(ctx, c, op.Get(), newID, 0)
	if resp.OK {
		resp.NewID = newID
	}
	return resp
}

// clone copies an instance, into its own project or req.Project, onto
// req.Storage (a pool) when given, without its snapshots when
// req.InstanceOnly.
func (d *incusDriver) clone(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if msg := incusNameProblem(req.Name); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "name", msg)
	}
	srcProject, _ := splitIncusID(g.ID)
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, _, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	project := srcProject
	dst := c
	if req.Project != "" && req.Project != incusProjectOr(srcProject) {
		var fail *proto.ManageResponse
		if dst, fail = d.projectServer(req.Project); fail != nil {
			return *fail
		}
		defer dst.Disconnect()
		project = req.Project
	}
	if _, _, err := dst.GetInstance(req.Name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "an instance named "+req.Name+" exists")
	}
	body := api.InstancesPost{Name: req.Name, Source: api.InstanceSource{Type: "copy", Source: name, InstanceOnly: req.InstanceOnly}}
	if project != srcProject {
		body.Source.Project = incusProjectOr(srcProject)
	}
	if req.Storage != "" {
		if !incusVolumeRE.MatchString(req.Storage) {
			return incusFieldError(proto.CodeInvalidValue, "storage", "not a valid pool name")
		}
		if _, _, err := c.GetStoragePool(req.Storage); err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return incusFieldError(proto.CodeInvalidValue, "storage", "there is no storage pool "+req.Storage)
			}
			return incusFail(err, proto.CodeNotFound)
		}
		root, dev := incusRootDisk(inst.ExpandedDevices)
		if root == "" {
			return incusFieldError(proto.CodeInvalidValue, "storage", "the guest has no root disk")
		}
		dev = maps.Clone(dev)
		dev["pool"] = req.Storage
		body.Devices = api.DevicesMap{root: dev}
	}
	op, err := dst.CreateInstance(body)
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, proto.CodeNotFound)
	}
	newID := incusID(project, req.Name)
	resp := d.opResult(ctx, dst, op.Get(), newID, 0)
	if resp.OK {
		resp.NewID = newID
	}
	return resp
}

// incusProjectOr is the project's name, "default" for "".
func incusProjectOr(project string) string {
	if project == "" {
		return "default"
	}
	return project
}

func (d *incusDriver) deleteGuest(ctx context.Context, g *proto.Guest) proto.ManageResponse {
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, _, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	if incusActive(inst.Status) {
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "stop the guest before deleting it"}
	}
	if v := strings.ToLower(inst.ExpandedConfig["security.protection.delete"]); v == "true" || v == "1" || v == "yes" || v == "on" {
		return proto.ManageResponse{Code: proto.CodeProtected, Message: "the guest is protected from deletion (security.protection.delete)"}
	}
	op, err := c.DeleteInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	return d.opResult(ctx, c, op.Get(), g.ID, 0)
}

// ---- operations and tasks -------------------------------------------------------------

// incusWait waits up to wait for an operation to end (bounded by ctx's
// deadline) and returns its last state.
func incusWait(ctx context.Context, c incus.InstanceServer, op api.Operation, wait time.Duration) api.Operation {
	deadline := time.Now().Add(wait)
	if dl, ok := ctx.Deadline(); ok && dl.Add(-5*time.Second).Before(deadline) {
		deadline = dl.Add(-5 * time.Second)
	}
	for !op.StatusCode.IsFinal() && ctx.Err() == nil {
		left := time.Until(deadline)
		if left < time.Second {
			break
		}
		got, _, err := c.GetOperationWait(op.ID, int(min(left, 10*time.Second)/time.Second))
		if err != nil {
			break
		}
		op = *got
	}
	return op
}

// opResult answers for an operation the agent started: done, failed, or
// (after waiting up to wait) still running, with a task to follow.
func (d *incusDriver) opResult(ctx context.Context, c incus.InstanceServer, op api.Operation, guest string, wait time.Duration) proto.ManageResponse {
	if wait > 0 {
		op = incusWait(ctx, c, op, wait)
	}
	switch {
	case op.StatusCode == api.Success:
		return proto.ManageResponse{OK: true}
	case op.StatusCode.IsFinal():
		msg := incusMsg(op.Err)
		if msg == "" {
			msg = "the operation was cancelled"
		}
		code := CodePlatformError
		if strings.Contains(strings.ToLower(msg), "invalid") {
			code = proto.CodeInvalidValue
		}
		return proto.ManageResponse{Code: code, Message: msg}
	}
	st := incusTaskStatus(op)
	st.GuestID = guest
	d.tasks.put(st)
	go d.follow(op.ID)
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: st.ID}}
}

// incusTaskStatus converts an operation. Message is the error, "OK", or
// the progress the operation reports ("rootfs: 45% (12.3MB/s)").
func incusTaskStatus(op api.Operation) proto.TaskStatus {
	st := proto.TaskStatus{ID: "incus:" + op.ID, Type: op.Description, Started: op.CreatedAt.UTC(), GuestID: incusOpGuest(op)}
	if st.Type == "" {
		st.Type = op.Class
	}
	switch {
	case op.StatusCode == api.Success:
		st.Status, st.Message = "ok", "OK"
		// Image operations (publish, download) end with the new image.
		if fp, ok := op.Metadata["fingerprint"].(string); ok && incusHexRE.MatchString(fp) {
			st.NewID = fp
		}
	case op.StatusCode.IsFinal():
		st.Status, st.Message = "error", incusMsg(op.Err)
		if st.Message == "" {
			st.Message = "cancelled"
		}
	default:
		st.Status = "running"
		st.Cancellable = op.MayCancel
		for _, k := range slices.Sorted(maps.Keys(op.Metadata)) {
			if s, ok := op.Metadata[k].(string); ok && strings.HasSuffix(k, "_progress") && s != "" {
				st.Message = incusMsg(s)
				break
			}
		}
	}
	if op.StatusCode.IsFinal() {
		end := op.UpdatedAt.UTC()
		st.Ended = &end
	}
	return st
}

// incusOpGuest is the first instance an operation names
// ("/1.0/instances/web?project=lab" -> "lab/web").
func incusOpGuest(op api.Operation) string {
	for _, raw := range op.Resources["instances"] {
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		rest, ok := strings.CutPrefix(u.Path, "/1.0/instances/")
		if !ok || rest == "" {
			continue
		}
		name, _, _ := strings.Cut(rest, "/")
		if p := u.Query().Get("project"); p != "" && p != "default" {
			return p + "/" + name
		}
		return name
	}
	return ""
}

// incusTasks remembers the operations manage started: Incus forgets an
// operation 5 s after it ends, so task.status answers from here once it
// is gone.
type incusTasks struct {
	mu sync.Mutex
	m  map[string]proto.TaskStatus // by "incus:<uuid>"
}

func (t *incusTasks) put(st proto.TaskStatus) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		t.m = map[string]proto.TaskStatus{}
	}
	t.m[st.ID] = st
	for id, s := range t.m {
		if s.Ended != nil && time.Since(*s.Ended) > incusTaskKeep {
			delete(t.m, id)
		}
	}
	for len(t.m) > incusTaskMaxKept {
		// Drop the oldest finished task.
		oldest := ""
		for id, s := range t.m {
			if s.Ended != nil && (oldest == "" || s.Started.Before(t.m[oldest].Started)) {
				oldest = id
			}
		}
		if oldest == "" {
			break
		}
		delete(t.m, oldest)
	}
}

// all returns the kept tasks.
func (t *incusTasks) all() []proto.TaskStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]proto.TaskStatus, 0, len(t.m))
	for _, s := range t.m {
		out = append(out, s)
	}
	return out
}

func (t *incusTasks) get(id string) (proto.TaskStatus, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.m[id]
	return st, ok
}

// update records the new state of an operation the agent started (the
// guest it named stays).
func (t *incusTasks) update(op api.Operation) {
	st := incusTaskStatus(op)
	if old, ok := t.get(st.ID); ok {
		if old.GuestID != "" {
			st.GuestID = old.GuestID
		}
		if old.Type != "" {
			st.Type = old.Type
		}
		t.put(st)
	}
}

// lost ends a task the agent can no longer follow.
func (t *incusTasks) lost(id, msg string) {
	st, ok := t.get(id)
	if !ok || st.Status != "running" {
		return
	}
	now := time.Now().UTC()
	st.Status, st.Message, st.Ended = "error", msg, &now
	t.put(st)
}

// follow records an operation's state until it ends, so its outcome stays
// readable after Incus forgets it.
func (d *incusDriver) follow(uuid string) {
	id := "incus:" + uuid
	deadline := time.Now().Add(incusTaskMax)
	for fails := 0; fails < 10 && time.Now().Before(deadline); fails++ {
		c, err := d.server()
		if err != nil {
			time.Sleep(incusFollowRetry)
			continue
		}
		for time.Now().Before(deadline) {
			start := time.Now()
			op, _, err := c.GetOperationWait(uuid, 30)
			if err != nil {
				if api.StatusErrorCheck(err, http.StatusNotFound) {
					c.Disconnect()
					d.tasks.lost(id, "Incus no longer knows this operation")
					return
				}
				break
			}
			fails = 0
			d.tasks.update(*op)
			if op.StatusCode.IsFinal() {
				c.Disconnect()
				return
			}
			if time.Since(start) < time.Second {
				time.Sleep(time.Second)
			}
		}
		c.Disconnect()
		time.Sleep(incusFollowRetry)
	}
	d.tasks.lost(id, "the agent lost track of this operation")
}

func (d *incusDriver) taskStatus(req proto.ManageRequest) proto.ManageResponse {
	m := incusTaskRE.FindStringSubmatch(req.Task)
	if m == nil {
		return incusFieldError(proto.CodeInvalidValue, "task", "not an Incus task id (incus:<operation uuid>)")
	}
	c, err := d.server()
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	op, _, err := c.GetOperation(m[1])
	if err != nil {
		if !api.StatusErrorCheck(err, http.StatusNotFound) {
			return incusFail(err, proto.CodeNotFound)
		}
		if st, ok := d.tasks.get(req.Task); ok {
			return proto.ManageResponse{OK: true, TaskStatus: &st}
		}
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: "Incus has no operation " + m[1]}
	}
	d.tasks.update(*op)
	st := incusTaskStatus(*op)
	if known, ok := d.tasks.get(req.Task); ok && known.GuestID != "" {
		st.GuestID = known.GuestID
	}
	return proto.ManageResponse{OK: true, TaskStatus: &st}
}
