package broker

import (
	"context"
	"maps"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/lxc/incus/v6/shared/api"
	"github.com/lxc/incus/v6/shared/units"

	"rackoon/internal/proto"
)

// Incus host operations (docs/MANAGE.md 2.5), each in Project ("" =
// default):
//
//	network.leases:  GET /1.0/networks/<n>/leases
//	profile.get:     GET /1.0/profiles/<p> (the ETag is the digest)
//	profile.create:  POST /1.0/profiles (empty, or a copy of another profile)
//	profile.update:  PUT /1.0/profiles/<p> with If-Match: the instance allowlist
//	profile.delete:  DELETE /1.0/profiles/<p> (unused, never "default")
//	volume.*:        /1.0/storage-pools/<pool>/volumes/custom[/<v>] (create, grow, delete unused)
//	image.download:  POST /1.0/images from images: (simplestreams)
//	image.refresh:   POST /1.0/images/<fp>/refresh
//	image.delete:    DELETE /1.0/images/<fp>

// ---- network leases ----------------------------------------------------------------

func (d *incusDriver) networkLeases(req proto.ManageRequest) proto.ManageResponse {
	if !incusDeviceNameRE.MatchString(req.Network) {
		return incusFieldError(proto.CodeInvalidValue, "network", "not a valid network name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	leases, err := c.GetNetworkLeases(req.Network)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	// Incus lists a project's own instances' leases only: the projects
	// that use the default project's networks are asked too.
	if req.Project == "" || req.Project == "default" {
		if projects, err := c.GetProjects(); err == nil {
			seen := map[string]bool{}
			for _, l := range leases {
				seen[l.Address+"|"+l.Hwaddr] = true
			}
			for _, p := range projects {
				if p.Name == "default" || p.Config["features.networks"] == "true" {
					continue
				}
				more, err := c.UseProject(p.Name).GetNetworkLeases(req.Network)
				if err != nil {
					continue
				}
				for _, l := range more {
					if k := l.Address + "|" + l.Hwaddr; !seen[k] {
						seen[k] = true
						leases = append(leases, l)
					}
				}
			}
		}
	}
	// Which instance holds each address: the MACs of every instance.
	byMAC := map[string]string{}
	if all, err := c.GetInstancesAllProjects(api.InstanceTypeAny); err == nil {
		for _, in := range all {
			for k, v := range in.ExpandedConfig {
				if strings.HasPrefix(k, "volatile.") && strings.HasSuffix(k, ".hwaddr") {
					byMAC[strings.ToLower(v)] = incusID(in.Project, in.Name)
				}
			}
		}
	}
	out := []proto.IncusLease{}
	for _, l := range leases {
		il := proto.IncusLease{Hostname: l.Hostname, Address: l.Address, HWAddr: strings.ToLower(l.Hwaddr), Type: l.Type}
		if il.HWAddr != "" {
			il.GuestID = byMAC[il.HWAddr]
		}
		out = append(out, il)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return proto.ManageResponse{OK: true, Leases: out}
}

// ---- profiles --------------------------------------------------------------------

// incusProfileOf converts a profile for profile.get.
func incusProfileOf(p *api.Profile, project, etag string) *proto.IncusProfile {
	out := &proto.IncusProfile{Name: p.Name, Project: incusProjectOr(project), Description: p.Description,
		Config: map[string]string{}, Devices: map[string]map[string]string{}, UsedBy: []string{}, Restricted: []string{},
		Digest: incusDigest(etag)}
	for k, v := range p.Config {
		out.Config[k] = v
		if !incusKeyAllowed(k, "profile") {
			out.Restricted = append(out.Restricted, k)
		}
	}
	for name, dev := range p.Devices {
		out.Devices[name] = maps.Clone(dev)
		if incusDeviceProblem(dev) != "" {
			out.Restricted = append(out.Restricted, "device."+name)
		}
	}
	for _, u := range p.UsedBy {
		if id := incusOpGuest(api.Operation{Resources: map[string][]string{"instances": {incusWithProject(u, project)}}}); id != "" {
			out.UsedBy = append(out.UsedBy, id)
		}
	}
	sort.Strings(out.UsedBy)
	sort.Strings(out.Restricted)
	return out
}

// incusWithProject adds the profile's project to an instance URL that has
// none (Incus leaves it out for the profile's own project).
func incusWithProject(u, project string) string {
	if project == "" || project == "default" || strings.Contains(u, "project=") {
		return u
	}
	if strings.Contains(u, "?") {
		return u + "&project=" + project
	}
	return u + "?project=" + project
}

func (d *incusDriver) profileGet(req proto.ManageRequest) proto.ManageResponse {
	if !incusProfileRE.MatchString(req.Profile) {
		return incusFieldError(proto.CodeInvalidValue, "profile", "not a valid profile name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	p, etag, err := c.GetProfile(req.Profile)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true, Profile: incusProfileOf(p, req.Project, etag)}
}

func (d *incusDriver) profileCreate(req proto.ManageRequest) proto.ManageResponse {
	if !incusProfileRE.MatchString(req.Name) {
		return incusFieldError(proto.CodeInvalidValue, "name", "up to 64 letters, digits, '.', '_' and '-'")
	}
	if msg := incusTextProblem(req.Description, incusMaxText, true); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "description", msg)
	}
	if req.CopyFrom != "" && !incusProfileRE.MatchString(req.CopyFrom) {
		return incusFieldError(proto.CodeInvalidValue, "copy_from", "not a valid profile name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if _, _, err := c.GetProfile(req.Name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "a profile named "+req.Name+" exists")
	}
	body := api.ProfilesPost{Name: req.Name, ProfilePut: api.ProfilePut{Description: req.Description}}
	if req.CopyFrom != "" {
		// A copy holds what the original holds: applying the original is
		// allowed, so copying it adds nothing.
		src, _, err := c.GetProfile(req.CopyFrom)
		if err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return incusFieldError(proto.CodeInvalidValue, "copy_from", "there is no profile "+req.CopyFrom)
			}
			return incusFail(err, proto.CodeNotFound)
		}
		body.Config, body.Devices = maps.Clone(src.Config), maps.Clone(src.Devices)
		if body.Description == "" {
			body.Description = src.Description
		}
	}
	if err := c.CreateProfile(body); err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true}
}

// profileUpdate changes a profile's own config, devices and description
// through the instance allowlist; restricted keys and devices stay as
// they are.
func (d *incusDriver) profileUpdate(req proto.ManageRequest) proto.ManageResponse {
	if !incusProfileRE.MatchString(req.Profile) {
		return incusFieldError(proto.CodeInvalidValue, "profile", "not a valid profile name")
	}
	set, del, msg := incusMergeDevices(req.Set, req.Delete, req.Devices)
	if msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "devices", msg)
	}
	if req.Description != "" {
		if _, ok := set["description"]; ok {
			return incusFieldError(proto.CodeInvalidValue, "description", "given twice")
		}
		set = maps.Clone(set)
		if set == nil {
			set = map[string]string{}
		}
		set["description"] = req.Description
	}
	if len(set) == 0 && len(del) == 0 {
		return proto.ManageResponse{Code: CodeInvalid, Message: "nothing to change"}
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	p, etag, err := c.GetProfile(req.Profile)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	digest := incusDigest(etag)
	if req.Digest != "" && req.Digest != digest {
		return proto.ManageResponse{Code: proto.CodeDigestMismatch, Message: "the profile changed since it was read"}
	}
	before := map[string]string{}
	for k, v := range p.Config {
		before[k] = v
	}
	for name, dev := range p.Devices {
		before["device."+name] = incusDeviceString(dev)
	}
	if p.Description != "" {
		before["description"] = p.Description
	}
	ch := &incusChange{kind: "profile", env: &incusEnv{c: c}, before: before, expanded: p.Devices, errs: map[string]string{},
		own: api.InstancePut{Config: maps.Clone(p.Config), Devices: maps.Clone(p.Devices), Description: p.Description}}
	if ch.own.Config == nil {
		ch.own.Config = api.ConfigMap{}
	}
	if ch.own.Devices == nil {
		ch.own.Devices = api.DevicesMap{}
	}
	ch.apply(set, del)
	if r := ch.refusal(); r != nil {
		return *r
	}
	if len(ch.changes) == 0 {
		return proto.ManageResponse{OK: true}
	}
	put := api.ProfilePut{Config: ch.own.Config, Devices: ch.own.Devices, Description: ch.own.Description}
	if err := c.UpdateProfile(req.Profile, put, digest); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true, Changes: ch.changes}
}

func (d *incusDriver) profileDelete(req proto.ManageRequest) proto.ManageResponse {
	if !incusProfileRE.MatchString(req.Profile) {
		return incusFieldError(proto.CodeInvalidValue, "profile", "not a valid profile name")
	}
	if req.Profile == "default" {
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "the default profile cannot be deleted"}
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	p, _, err := c.GetProfile(req.Profile)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	if n := len(p.UsedBy); n > 0 {
		return proto.ManageResponse{Code: proto.CodeInUse, Message: "the profile is still used by " + plural(n, "instance", "instances")}
	}
	if err := c.DeleteProfile(req.Profile); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// ---- custom volumes ------------------------------------------------------------------

// incusVolumeSize reads an absolute volume size ("10GiB", "512MiB",
// "20G"), at least 1 MiB.
func incusVolumeSize(s string) (uint64, string) {
	n, rel, err := incusParseSize(s)
	switch {
	case err != nil:
		return 0, err.Error()
	case rel:
		return 0, "give the new total size (\"20GiB\")"
	case n < 1<<20:
		return 0, "at least 1MiB"
	}
	return n, ""
}

func (d *incusDriver) pool(c interface {
	GetStoragePool(string) (*api.StoragePool, string, error)
}, pool string) *proto.ManageResponse {
	if !incusVolumeRE.MatchString(pool) {
		r := incusFieldError(proto.CodeInvalidValue, "pool", "not a valid pool name")
		return &r
	}
	if _, _, err := c.GetStoragePool(pool); err != nil {
		var r proto.ManageResponse
		if api.StatusErrorCheck(err, http.StatusNotFound) {
			r = incusFieldError(proto.CodeNotFound, "pool", "there is no storage pool "+pool)
		} else {
			r = incusFail(err, proto.CodeNotFound)
		}
		return &r
	}
	return nil
}

func (d *incusDriver) volumeCreate(req proto.ManageRequest) proto.ManageResponse {
	if !incusVolumeRE.MatchString(req.Name) {
		return incusFieldError(proto.CodeInvalidValue, "name", "up to 128 letters, digits, '.', '_' and '-'")
	}
	size, msg := incusVolumeSize(req.Size)
	if msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "size", msg)
	}
	ct := req.ContentType
	switch ct {
	case "":
		ct = "filesystem"
	case "filesystem", "block":
	default:
		return incusFieldError(proto.CodeInvalidValue, "content_type", "filesystem or block")
	}
	if msg := incusTextProblem(req.Description, incusMaxText, true); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "description", msg)
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if r := d.pool(c, req.Pool); r != nil {
		return *r
	}
	if _, _, err := c.GetStoragePoolVolume(req.Pool, "custom", req.Name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "pool "+req.Pool+" has a volume named "+req.Name)
	}
	body := api.StorageVolumesPost{Name: req.Name, Type: "custom", ContentType: ct,
		StorageVolumePut: api.StorageVolumePut{Config: map[string]string{"size": incusSizeString(size)}, Description: req.Description}}
	if err := c.CreateStoragePoolVolume(req.Pool, body); err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true}
}

func (d *incusDriver) volumeResize(req proto.ManageRequest) proto.ManageResponse {
	want, msg := incusVolumeSize(strings.TrimPrefix(req.Size, "+"))
	relative := strings.HasPrefix(req.Size, "+")
	if msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "size", msg)
	}
	if !incusVolumeRE.MatchString(req.Volume) {
		return incusFieldError(proto.CodeInvalidValue, "volume", "not a valid volume name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if r := d.pool(c, req.Pool); r != nil {
		return *r
	}
	v, etag, err := c.GetStoragePoolVolume(req.Pool, "custom", req.Volume)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	cur := uint64(0)
	if n, err := units.ParseByteSizeString(v.Config["size"]); err == nil && n > 0 {
		cur = uint64(n)
	}
	if cur == 0 {
		return incusFieldError(proto.CodeInvalidValue, "size", "this volume has no size limit (it can use the whole pool)")
	}
	if relative {
		want += cur
	}
	switch {
	case want < cur:
		return incusFieldError(proto.CodeInvalidValue, "size", "volumes only grow: it has "+incusSizeString(cur))
	case want == cur:
		return proto.ManageResponse{OK: true}
	}
	put := v.Writable()
	put.Config = maps.Clone(put.Config)
	put.Config["size"] = incusSizeString(want)
	if err := c.UpdateStoragePoolVolume(req.Pool, "custom", req.Volume, put, etag); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "size", Old: v.Config["size"], New: put.Config["size"]}}}
}

func (d *incusDriver) volumeDelete(req proto.ManageRequest) proto.ManageResponse {
	if !incusVolumeRE.MatchString(req.Volume) {
		return incusFieldError(proto.CodeInvalidValue, "volume", "not a valid volume name")
	}
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if r := d.pool(c, req.Pool); r != nil {
		return *r
	}
	v, _, err := c.GetStoragePoolVolume(req.Pool, "custom", req.Volume)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	if n := len(v.UsedBy); n > 0 {
		return proto.ManageResponse{Code: proto.CodeInUse, Message: "the volume is attached to " + plural(n, "instance", "instances") + "; detach it first"}
	}
	if err := c.DeleteStoragePoolVolume(req.Pool, "custom", req.Volume); err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return proto.ManageResponse{OK: true}
}

// ---- images ----------------------------------------------------------------------

// imageDownload copies an image of images: into the local store. The
// alias names it locally too when that name is free.
func (d *incusDriver) imageDownload(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	alias := strings.TrimPrefix(req.Alias, "images:")
	if alias == "" || len(alias) > 200 || !incusImageRE.MatchString(alias) {
		return incusFieldError(proto.CodeInvalidValue, "alias", "an image of images: such as debian/13")
	}
	switch req.ImageType {
	case "container", "virtual-machine":
	default:
		return incusFieldError(proto.CodeInvalidValue, "type", "container or virtual-machine")
	}
	auto := req.AutoUpdate == nil || *req.AutoUpdate
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	body := api.ImagesPost{Source: &api.ImagesPostSource{Type: "image", Mode: "pull", Server: incusImageServer, Protocol: "simplestreams",
		Alias: alias, ImageType: req.ImageType}, ImagePut: api.ImagePut{AutoUpdate: auto}}
	if _, _, err := c.GetImageAlias(alias); err != nil {
		body.Aliases = []api.ImageAlias{{Name: alias}}
	}
	op, _, err := c.RawOperation("POST", "/images", body, "")
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return d.opResult(ctx, c, op.Get(), "", 0)
}

// resolveImage finds a local image of the project by fingerprint (or a
// prefix of at least 12 characters).
func (d *incusDriver) resolveImage(c interface {
	GetImages() ([]api.Image, error)
}, fp string) (string, *proto.ManageResponse) {
	fp = strings.ToLower(fp)
	if !incusHexRE.MatchString(fp) {
		r := incusFieldError(proto.CodeInvalidValue, "fingerprint", "not an image fingerprint")
		return "", &r
	}
	images, err := c.GetImages()
	if err != nil {
		r := incusFail(err, proto.CodeNotFound)
		return "", &r
	}
	var found []string
	for _, im := range images {
		if strings.HasPrefix(im.Fingerprint, fp) {
			found = append(found, im.Fingerprint)
		}
	}
	switch len(slices.Compact(found)) {
	case 0:
		r := incusFieldError(proto.CodeNotFound, "fingerprint", "the image store has no image "+fp)
		return "", &r
	case 1:
		return found[0], nil
	}
	r := incusFieldError(proto.CodeInvalidValue, "fingerprint", "more than one image matches "+fp)
	return "", &r
}

func (d *incusDriver) imageRefresh(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	fp, r := d.resolveImage(c, req.Fingerprint)
	if r != nil {
		return *r
	}
	op, err := c.RefreshImage(fp)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return d.opResult(ctx, c, op.Get(), "", 0)
}

func (d *incusDriver) imageDelete(ctx context.Context, req proto.ManageRequest) proto.ManageResponse {
	c, fail := d.projectServer(req.Project)
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	fp, r := d.resolveImage(c, req.Fingerprint)
	if r != nil {
		return *r
	}
	op, err := c.DeleteImage(fp)
	if err != nil {
		return incusFail(err, proto.CodeNotFound)
	}
	return d.opResult(ctx, c, op.Get(), "", incusConfigWait)
}
