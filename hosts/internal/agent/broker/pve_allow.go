package broker

import (
	"context"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"rackoon/internal/proto"
)

// The Proxmox VE allowlist (docs/MANAGE.md 2.4): the configuration keys
// Whombat changes and the values it accepts for them. Every other key is
// Restricted: shown, changed only in Proxmox VE itself.

// pveKey is the class of an allowlisted key; 0 means not allowlisted.
type pveKey int

const (
	keyPlain    pveKey = iota + 1 // validated by PVE
	keyDisk                       // VM ide/sata/scsi/virtio, CT mp
	keyEFI                        // efidisk0, tpmstate0: new or unchanged
	keyRootFS                     // CT rootfs: create only (later disk.resize / disk.move)
	keyNet                        // net[n]
	keySerial                     // VM serial[n]: socket only
	keyUnused                     // unused[n]: delete only
	keyFeatures                   // CT features: nesting, keyctl, fuse
	keyCreate                     // CT create-only keys
)

var pveVMKeys = map[string]pveKey{
	"name": keyPlain, "description": keyPlain, "tags": keyPlain, "onboot": keyPlain, "startup": keyPlain,
	"protection": keyPlain, "cores": keyPlain, "sockets": keyPlain, "vcpus": keyPlain, "cpu": keyPlain,
	"cpulimit": keyPlain, "cpuunits": keyPlain, "numa": keyPlain, "memory": keyPlain, "balloon": keyPlain,
	"shares": keyPlain, "ostype": keyPlain, "bios": keyPlain, "machine": keyPlain, "scsihw": keyPlain,
	"boot": keyPlain, "agent": keyPlain, "tablet": keyPlain, "hotplug": keyPlain, "acpi": keyPlain,
	"kvm": keyPlain, "localtime": keyPlain, "freeze": keyPlain, "vga": keyPlain, "keyboard": keyPlain,
	"ciuser": keyPlain, "cipassword": keyPlain, "sshkeys": keyPlain, "nameserver": keyPlain,
	"searchdomain": keyPlain, "citype": keyPlain, "ciupgrade": keyPlain,
	"efidisk0": keyEFI, "tpmstate0": keyEFI,
}

var pveCTKeys = map[string]pveKey{
	"hostname": keyPlain, "description": keyPlain, "tags": keyPlain, "onboot": keyPlain, "startup": keyPlain,
	"protection": keyPlain, "cores": keyPlain, "cpulimit": keyPlain, "cpuunits": keyPlain, "memory": keyPlain,
	"swap": keyPlain, "nameserver": keyPlain, "searchdomain": keyPlain, "console": keyPlain, "tty": keyPlain,
	"cmode": keyPlain, "timezone": keyPlain, "features": keyFeatures, "rootfs": keyRootFS,
	"ostemplate": keyCreate, "password": keyCreate, "ssh-public-keys": keyCreate, "unprivileged": keyCreate, "arch": keyCreate,
}

// pveVMIndexed and pveCTIndexed are the numbered keys: prefix -> highest
// index and class.
var pveVMIndexed = map[string]struct {
	max int
	key pveKey
}{
	"serial": {3, keySerial}, "ide": {3, keyDisk}, "sata": {5, keyDisk}, "scsi": {30, keyDisk},
	"virtio": {15, keyDisk}, "net": {31, keyNet}, "ipconfig": {31, keyPlain}, "unused": {255, keyUnused},
}

var pveCTIndexed = map[string]struct {
	max int
	key pveKey
}{
	"net": {31, keyNet}, "mp": {255, keyDisk}, "unused": {255, keyUnused},
}

var indexedKeyRe = regexp.MustCompile(`^([a-z]+)(0|[1-9][0-9]{0,2})$`)

// pveKeyType returns the class of key for a guest kind (0: not
// allowlisted).
func pveKeyType(kind, key string) pveKey {
	plain, indexed := pveVMKeys, pveVMIndexed
	if kind == "container" {
		plain, indexed = pveCTKeys, pveCTIndexed
	}
	if k, ok := plain[key]; ok {
		return k
	}
	if m := indexedKeyRe.FindStringSubmatch(key); m != nil {
		if ix, ok := indexed[m[1]]; ok {
			if n, _ := strconv.Atoi(m[2]); n <= ix.max {
				return ix.key
			}
		}
	}
	return 0
}

var pveDiskKeyRe = regexp.MustCompile(`^(ide|sata|scsi|virtio|unused|mp)\d+$|^(efidisk0|tpmstate0|rootfs)$`)

// isPVEDiskKey reports whether a key holds a disk, CD-ROM, mount point or
// unused volume (allowlisted or not).
func isPVEDiskKey(key string) bool { return pveDiskKeyRe.MatchString(key) }

// pveRestricted reports whether Whombat shows key (with its current value)
// read-only: keys outside the allowlist, create-only keys that stay in
// the configuration, and allowlisted keys whose value Rackoon would refuse
// (bind mounts and host devices, serial ports to host devices, container
// features beyond nesting, keyctl and fuse).
func pveRestricted(kind, key, value string) bool {
	switch pveKeyType(kind, key) {
	case 0, keyCreate:
		return true
	case keySerial:
		return value != "socket"
	case keyFeatures:
		return checkFeatures(key, value) != nil
	case keyDisk, keyEFI, keyRootFS, keyUnused:
		file, _ := parsePropString(value).Default(diskFileKeys(kind)...)
		return strings.HasPrefix(value, "/") || strings.HasPrefix(file, "/")
	}
	return false
}

// diskFileKeys are the default key of a disk value and its alias.
func diskFileKeys(kind string) []string {
	if kind == "container" {
		return []string{"volume"}
	}
	return []string{"file", "volume"}
}

// maxValueLen bounds every value (PVE's own limits are lower).
const maxValueLen = 64 << 10

// checkText refuses invalid UTF-8 and control characters (newlines only
// where multiline).
func checkText(key, v string, multiline bool) error {
	if len(v) > maxValueLen {
		return fieldErr(proto.CodeInvalidValue, key, "the value is too long")
	}
	if !utf8.ValidString(v) {
		return fieldErr(proto.CodeInvalidValue, key, "the value is not valid UTF-8")
	}
	for _, r := range v {
		if r == '\n' && multiline {
			continue
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return fieldErr(proto.CodeInvalidValue, key, "the value contains control characters")
		}
	}
	return nil
}

// pveCheck validates values for one guest (or a guest to create) against
// the allowlist and what the node offers.
type pveCheck struct {
	kind   string
	create bool
	// cur and pend: the guest's current and pending values (nil on create).
	cur, pend map[string]string
	info      *pveNodeInfo
	// listed reports whether a volume of a storage's content type (iso,
	// vztmpl) exists on this node.
	listed func(ctx context.Context, storage, content, volid string) (bool, error)
}

// key refuses a key that is not allowlisted for this operation: Set on
// create (create-only keys too), Set on change, Delete, Revert.
func (c *pveCheck) key(op, key string) error {
	kt := pveKeyType(c.kind, key)
	switch {
	case kt == 0:
		return fieldErr(proto.CodeNotAllowed, key, "Whombat does not change this setting; change it in Proxmox VE")
	case kt == keyCreate && (!c.create || op != "set"):
		return fieldErr(proto.CodeNotAllowed, key, "can only be set when the container is created")
	case kt == keyRootFS && !c.create:
		return fieldErr(proto.CodeNotAllowed, key, "change the root disk with resize or move")
	case kt == keyUnused && op == "set":
		return fieldErr(proto.CodeNotAllowed, key, "unused disks can only be deleted")
	}
	if !c.create {
		for _, m := range []map[string]string{c.cur, c.pend} {
			if v, ok := m[key]; ok && pveRestricted(c.kind, key, v) {
				return fieldErr(proto.CodeNotAllowed, key, "Whombat does not change this value; change it in Proxmox VE")
			}
		}
	}
	return nil
}

// value validates the new value of an allowlisted key.
func (c *pveCheck) value(ctx context.Context, key, v string) error {
	if err := checkText(key, v, key == "description" || key == "ssh-public-keys"); err != nil {
		return err
	}
	switch pveKeyType(c.kind, key) {
	case keySerial:
		if v != "socket" {
			return fieldErr(proto.CodeNotAllowed, key, "only a serial socket (socket) is allowed")
		}
	case keyFeatures:
		return checkFeatures(key, v)
	case keyNet:
		if c.kind == "vm" {
			return c.vmNet(key, v)
		}
		return c.ctNet(key, v)
	case keyDisk, keyEFI, keyRootFS:
		return c.disk(ctx, key, v)
	case keyCreate:
		switch key {
		case "unprivileged":
			if v != "1" {
				return fieldErr(proto.CodeNotAllowed, key, "privileged containers are not allowed")
			}
		case "ostemplate":
			return c.volume(ctx, key, v, "vztmpl")
		}
	}
	return nil
}

func checkFeatures(key, v string) error {
	for _, it := range parsePropString(v) {
		if !it.HasKey || (it.Key != "nesting" && it.Key != "keyctl" && it.Key != "fuse") {
			return fieldErr(proto.CodeNotAllowed, key, "only the features nesting, keyctl and fuse are allowed")
		}
		if it.Value != "0" && it.Value != "1" {
			return fieldErr(proto.CodeInvalidValue, key, it.Key+" must be 0 or 1")
		}
	}
	return nil
}

// pveNICModels are the VM network card models Rackoon offers;
// pveAllNICModels every model PVE knows (each is also a key: virtio=MAC).
var (
	pveNICModels    = []string{"virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"}
	pveAllNICModels = []string{"model", "e1000", "e1000-82540em", "e1000-82544gc", "e1000-82545em", "e1000e",
		"i82551", "i82557b", "i82559er", "ne2k_isa", "ne2k_pci", "pcnet", "rtl8139", "virtio", "vmxnet3"}
)

func (c *pveCheck) vmNet(key, v string) error {
	p := parsePropString(v)
	if len(p) == 0 {
		return fieldErr(proto.CodeInvalidValue, key, "the network device needs a model")
	}
	model := p[0].Value
	if p[0].HasKey && p[0].Key != "model" {
		model = p[0].Key // virtio=BC:24:11:...
	}
	if !slices.Contains(pveNICModels, model) {
		return fieldErr(proto.CodeNotAllowed, key, "the model must be one of "+strings.Join(pveNICModels, ", "))
	}
	for _, it := range p[1:] {
		if !it.HasKey || slices.Contains(pveAllNICModels, it.Key) {
			return fieldErr(proto.CodeInvalidValue, key, "the model must be the first and only model item")
		}
	}
	return c.netCommon(key, p)
}

func (c *pveCheck) ctNet(key, v string) error {
	p := parsePropString(v)
	for _, it := range p {
		if !it.HasKey {
			return fieldErr(proto.CodeInvalidValue, key, "every item must be key=value")
		}
		if it.Key == "type" && it.Value != "veth" {
			return fieldErr(proto.CodeNotAllowed, key, "only type=veth is allowed")
		}
	}
	return c.netCommon(key, p)
}

func (c *pveCheck) netCommon(key string, p propString) error {
	if br, ok := p.Get("bridge"); ok && (c.info == nil || !slices.Contains(c.info.bridges, br)) {
		return fieldErr(proto.CodeNotAllowed, key, "bridge "+br+" is not a bridge of this node")
	}
	if tag, ok := p.Get("tag"); ok {
		if n, err := strconv.Atoi(tag); err != nil || n < 1 || n > 4094 {
			return fieldErr(proto.CodeInvalidValue, key, "the VLAN tag must be 1-4094")
		}
	}
	return nil
}

// cloudInitRe is STORAGE:cloudinit, how PVE adds a cloud-init drive.
var cloudInitRe = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9._-]*):cloudinit$`)

// newVolumeRe is STORAGE:SIZE (GiB), how PVE allocates a new volume.
var newVolumeRe = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9._-]*):([0-9]+(\.[0-9]+)?)$`)

func (c *pveCheck) disk(ctx context.Context, key, v string) error {
	kt := pveKeyType(c.kind, key)
	p := parsePropString(v)
	file, n := p.Default(diskFileKeys(c.kind)...)
	switch {
	case strings.HasPrefix(v, "/") || strings.HasPrefix(file, "/"):
		return fieldErr(proto.CodeNotAllowed, key, "host paths, devices and bind mounts are not allowed")
	case n != 1:
		return fieldErr(proto.CodeInvalidValue, key, "the value needs exactly one volume")
	}
	if _, ok := p.Get("import-from"); ok {
		return fieldErr(proto.CodeNotAllowed, key, "import-from is not allowed")
	}
	size, hasSize := p.Get("size")
	curFile, curSize := c.curDisk(key)

	if media, _ := p.Get("media"); media == "cdrom" && c.kind == "vm" && kt == keyDisk {
		switch {
		case file == "none":
		case file == "cdrom":
			return fieldErr(proto.CodeNotAllowed, key, "the host's CD/DVD drive is not allowed")
		case !c.create && file == curFile:
		default:
			return c.volume(ctx, key, file, "iso")
		}
		return nil
	}

	content := "images"
	if c.kind == "container" {
		content = "rootdir"
	}
	// A new cloud-init drive (STORAGE:cloudinit): PVE creates the volume
	// and its CD-ROM itself.
	if m := cloudInitRe.FindStringSubmatch(file); m != nil && c.kind == "vm" && kt == keyDisk {
		return c.storage(key, m[1], "images")
	}
	if m := newVolumeRe.FindStringSubmatch(file); m != nil {
		if gib, _ := strconv.ParseFloat(m[2], 64); gib <= 0 {
			return fieldErr(proto.CodeInvalidValue, key, "the size of a new volume must be more than 0 GiB")
		}
		if hasSize {
			return fieldErr(proto.CodeInvalidValue, key, "give the size of a new volume as STORAGE:SIZE, not size=")
		}
		return c.storage(key, m[1], content)
	}
	if c.create {
		return fieldErr(proto.CodeNotAllowed, key, "a new guest's disk must be a new volume (STORAGE:SIZE)")
	}
	if file == curFile && file != "" {
		if hasSize && size != curSize {
			return fieldErr(proto.CodeNotAllowed, key, "the size cannot be changed here; resize the disk instead")
		}
		return nil
	}
	if kt == keyDisk && c.isUnused(file) {
		if hasSize {
			return fieldErr(proto.CodeInvalidValue, key, "an unused volume is attached without size=")
		}
		return nil
	}
	if kt == keyEFI {
		return fieldErr(proto.CodeNotAllowed, key, "must be a new volume (STORAGE:1) or stay unchanged")
	}
	return fieldErr(proto.CodeNotAllowed, key, "must be a new volume (STORAGE:SIZE), the volume this disk has, or an unused volume of this guest")
}

// curDisk returns the volume and size= of key in the configuration
// (pending value first).
func (c *pveCheck) curDisk(key string) (file, size string) {
	v, ok := c.pend[key]
	if !ok {
		v = c.cur[key]
	}
	p := parsePropString(v)
	file, _ = p.Default(diskFileKeys(c.kind)...)
	size, _ = p.Get("size")
	return file, size
}

func (c *pveCheck) isUnused(volid string) bool {
	for _, m := range []map[string]string{c.cur, c.pend} {
		for k, v := range m {
			if pveKeyType(c.kind, k) == keyUnused {
				if f, _ := parsePropString(v).Default(diskFileKeys(c.kind)...); f == volid {
					return true
				}
			}
		}
	}
	return false
}

// storage refuses a storage that is not an active storage of this node
// offering content.
func (c *pveCheck) storage(key, id, content string) error {
	if c.info == nil {
		return fieldErr(proto.CodeNotAllowed, key, "storage "+id+" is unknown")
	}
	if err := c.info.storageFor(id, content); err != nil {
		return fieldErr(proto.CodeNotAllowed, key, err.Error())
	}
	return nil
}

// volume refuses a volume that is not STORAGE:CONTENT/NAME of a storage of
// this node offering content, or that the storage does not list.
func (c *pveCheck) volume(ctx context.Context, key, volid, content string) error {
	st, rest, ok := splitVolume(volid)
	if !ok || !strings.HasPrefix(rest, content+"/") {
		return fieldErr(proto.CodeNotAllowed, key, "must be a "+content+" volume of this node (STORAGE:"+content+"/NAME)")
	}
	if err := c.storage(key, st, content); err != nil {
		return err
	}
	if c.listed == nil {
		return nil
	}
	found, err := c.listed(ctx, st, content, volid)
	if err != nil {
		return err
	}
	if !found {
		return fieldErr(proto.CodeNotAllowed, key, volid+" does not exist on this node")
	}
	return nil
}

var storageIDRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]*$`)

// splitVolume splits a volume id "STORAGE:REST"; REST must be a relative
// name without "..", whitespace or control characters.
func splitVolume(volid string) (storage, rest string, ok bool) {
	storage, rest, ok = strings.Cut(volid, ":")
	if !ok || !storageIDRe.MatchString(storage) || rest == "" || len(volid) > 512 ||
		strings.HasPrefix(rest, "/") || strings.Contains(rest, "..") || checkText("volume", rest, false) != nil ||
		strings.ContainsAny(rest, " ,=") {
		return "", "", false
	}
	return storage, rest, true
}

// ---- other values -----------------------------------------------------------------

// pveFirewallOptions are the firewall options Whombat changes and their
// values ("" = boolean).
var pveFirewallOptions = map[string][]string{
	"enable": nil, "dhcp": nil, "ndp": nil, "radv": nil, "macfilter": nil, "ipfilter": nil,
	"policy_in": {"ACCEPT", "REJECT", "DROP"}, "policy_out": {"ACCEPT", "REJECT", "DROP"},
	"log_level_in": pveLogLevels, "log_level_out": pveLogLevels,
}

var pveLogLevels = []string{"emerg", "alert", "crit", "err", "warning", "notice", "info", "debug", "nolog"}

func checkFirewallOption(key, v string) error {
	allowed, ok := pveFirewallOptions[key]
	switch {
	case !ok:
		return fieldErr(proto.CodeNotAllowed, key, "not a firewall option Whombat changes")
	case allowed == nil && v != "0" && v != "1":
		return fieldErr(proto.CodeInvalidValue, key, "must be 0 or 1")
	case allowed != nil && !slices.Contains(allowed, v):
		return fieldErr(proto.CodeInvalidValue, key, "must be one of "+strings.Join(allowed, ", "))
	}
	return nil
}

var (
	fwMacroRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	fwIfaceRe = regexp.MustCompile(`^net\d{1,2}$`)
)

// checkFirewallRule validates a rule; groups are the cluster's security
// groups.
func checkFirewallRule(r *proto.FirewallRule, groups []string) error {
	switch r.Type {
	case "in", "out":
		if r.Action != "ACCEPT" && r.Action != "DROP" && r.Action != "REJECT" {
			return fieldErr(proto.CodeInvalidValue, "action", "must be ACCEPT, DROP or REJECT")
		}
	case "group":
		if !slices.Contains(groups, r.Action) {
			return fieldErr(proto.CodeInvalidValue, "action", "security group "+r.Action+" does not exist")
		}
	default:
		return fieldErr(proto.CodeInvalidValue, "type", "must be in, out or group")
	}
	if r.Macro != "" && !fwMacroRe.MatchString(r.Macro) {
		return fieldErr(proto.CodeInvalidValue, "macro", "invalid macro name")
	}
	if r.Iface != "" && !fwIfaceRe.MatchString(r.Iface) {
		return fieldErr(proto.CodeInvalidValue, "iface", "must be a network device of the guest (net0, net1, ...)")
	}
	if r.Log != "" && !slices.Contains(pveLogLevels, r.Log) {
		return fieldErr(proto.CodeInvalidValue, "log", "must be one of "+strings.Join(pveLogLevels, ", "))
	}
	for k, v := range map[string]string{"proto": r.Proto, "source": r.Source, "dest": r.Dest, "sport": r.SPort, "dport": r.DPort, "comment": r.Comment} {
		if len(v) > 4096 {
			return fieldErr(proto.CodeInvalidValue, k, "the value is too long")
		}
		if err := checkText(k, v, false); err != nil {
			return err
		}
	}
	return nil
}

// downloadExts are the file name endings download-url accepts per content.
var downloadExts = map[string][]string{
	"iso":    {".iso", ".img"},
	"vztmpl": {".tar.gz", ".tar.xz", ".tar.zst"},
	"import": {".ova", ".qcow2", ".vmdk", ".raw", ".img"},
}

var downloadNameRe = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$`)

func checkDownloadName(content, name string) error {
	exts, ok := downloadExts[content]
	if !ok {
		return fieldErr(proto.CodeInvalidValue, "content", "must be iso, vztmpl or import")
	}
	if !downloadNameRe.MatchString(name) || strings.Contains(name, "..") {
		return fieldErr(proto.CodeInvalidValue, "filename", "use 1-200 letters, digits, '.', '_' and '-'")
	}
	for _, e := range exts {
		if strings.HasSuffix(name, e) && len(name) > len(e) {
			return nil
		}
	}
	return fieldErr(proto.CodeInvalidValue, "filename", "must end in "+strings.Join(exts, ", "))
}

// checkDownloadURL accepts http(s) URLs without credentials.
func checkDownloadURL(s string) error {
	if err := checkText("url", s, false); err != nil || len(s) > 2048 || strings.ContainsAny(s, " \\") {
		return fieldErr(proto.CodeInvalidValue, "url", "invalid URL")
	}
	u, err := url.Parse(s)
	switch {
	case err != nil || u.Host == "" || u.Opaque != "":
		return fieldErr(proto.CodeInvalidValue, "url", "invalid URL")
	case u.Scheme != "http" && u.Scheme != "https":
		return fieldErr(proto.CodeInvalidValue, "url", "only http:// and https:// URLs are allowed")
	case u.User != nil:
		return fieldErr(proto.CodeInvalidValue, "url", "credentials in the URL are not allowed")
	}
	return nil
}

var (
	checksumRe     = regexp.MustCompile(`^[0-9A-Fa-f]{32,128}$`)
	checksumAlgs   = []string{"md5", "sha1", "sha224", "sha256", "sha384", "sha512"}
	scheduleRe     = regexp.MustCompile(`^[A-Za-z0-9 *,/:.~-]{1,128}$`)
	rateRe         = regexp.MustCompile(`^[0-9]{1,6}(\.[0-9]{1,3})?$`)
	applianceRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)
	replicationRe  = regexp.MustCompile(`^([1-9][0-9]{2,8})-([0-9]{1,9})$`)
	haStates       = []string{"started", "stopped", "ignored", "disabled"}
	backupModes    = []string{"snapshot", "suspend", "stop"}
	backupCompress = map[string]string{"zstd": "zstd", "lzo": "lzo", "gzip": "gzip", "none": "0"}
)
