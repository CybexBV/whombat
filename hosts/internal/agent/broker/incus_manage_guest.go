package broker

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	incus "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/proto"
)

// Incus guest operations (docs/MANAGE.md 2.5):
//
//	guest.rename:  POST /1.0/instances/<n> {name} (stopped)
//	guest.move:    POST /1.0/instances/<n> {migration: true, pool, project} (stopped, on this host)
//	guest.publish: POST /1.0/images {source: instance | snapshot} (a snapshot, or a stopped instance)
//	log.get:       GET /1.0/instances/<n>/logs/lxc.log | qemu.log

// incusRenameRE: Incus instance names start with a letter (brief §2.2).
var incusRenameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,62}$`)

// Log lines returned by log.get.
const (
	incusLogLines    = 500
	incusLogMaxLines = 2000
	incusLogMaxBytes = 16 << 20
)

// stoppedInstance reads an instance and refuses a running one.
func (d *incusDriver) stoppedInstance(g *proto.Guest, what string) (incus.InstanceServer, string, *api.Instance, *proto.ManageResponse) {
	c, name, err := d.connect(g.ID)
	if err != nil {
		r := incusResp(err)
		return nil, "", nil, &r
	}
	inst, _, err := c.GetInstance(name)
	if err != nil {
		c.Disconnect()
		r := incusFail(err, CodeUnknownGuest)
		return nil, "", nil, &r
	}
	if incusActive(inst.Status) {
		c.Disconnect()
		return nil, "", nil, &proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "stop the guest before " + what}
	}
	return c, name, inst, nil
}

func (d *incusDriver) rename(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if !incusRenameRE.MatchString(req.Name) || strings.HasSuffix(req.Name, "-") {
		return incusFieldError(proto.CodeInvalidValue, "name", "1 to 63 letters, digits and '-', starting with a letter, not ending with '-'")
	}
	c, name, _, fail := d.stoppedInstance(g, "renaming it")
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	if req.Name == name {
		return proto.ManageResponse{OK: true}
	}
	if _, _, err := c.GetInstance(req.Name); err == nil {
		return incusFieldError(proto.CodeExists, "name", "an instance named "+req.Name+" exists")
	}
	op, err := c.RenameInstance(name, api.InstancePost{Name: req.Name})
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return incusFieldError(proto.CodeExists, "name", incusMsg(err.Error()))
		}
		return incusFail(err, CodeUnknownGuest)
	}
	project, _ := splitIncusID(g.ID)
	newID := incusID(project, req.Name)
	resp := d.opResult(ctx, c, op.Get(), newID, incusConfigWait)
	if resp.OK {
		resp.NewID = newID
	}
	return resp
}

// move puts a stopped instance on another pool or into another project of
// this host (Incus copies it and deletes the original).
func (d *incusDriver) move(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if req.Pool == "" && req.Project == "" {
		return incusFieldError(proto.CodeInvalidValue, "pool", "choose a pool or a project to move the guest to")
	}
	if req.Pool != "" && !incusVolumeRE.MatchString(req.Pool) {
		return incusFieldError(proto.CodeInvalidValue, "pool", "not a valid pool name")
	}
	srcProject, _ := splitIncusID(g.ID)
	c, name, inst, fail := d.stoppedInstance(g, "moving it")
	if fail != nil {
		return *fail
	}
	defer c.Disconnect()
	body := api.InstancePost{Name: name, Migration: true}
	project := srcProject
	if req.Project != "" && req.Project != incusProjectOr(srcProject) {
		dst, fail := d.projectServer(req.Project)
		if fail != nil {
			return *fail
		}
		_, _, err := dst.GetInstance(name)
		dst.Disconnect()
		if err == nil {
			return incusFieldError(proto.CodeExists, "project", "project "+req.Project+" has an instance named "+name)
		}
		body.Project, project = req.Project, req.Project
	}
	if req.Pool != "" {
		if _, _, err := c.GetStoragePool(req.Pool); err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return incusFieldError(proto.CodeInvalidValue, "pool", "there is no storage pool "+req.Pool)
			}
			return incusFail(err, proto.CodeNotFound)
		}
		if _, root := incusRootDisk(inst.ExpandedDevices); root != nil && root["pool"] == req.Pool && body.Project == "" {
			return proto.ManageResponse{OK: true} // already there
		}
		body.Pool = req.Pool
	}
	if body.Pool == "" && body.Project == "" {
		return proto.ManageResponse{OK: true}
	}
	op, _, err := c.RawOperation("POST", "/instances/"+url.PathEscape(name), body, "")
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	newID := incusID(project, name)
	resp := d.opResult(ctx, c, op.Get(), newID, 0)
	if resp.OK {
		resp.NewID = newID
	}
	return resp
}

// publish makes an image of a stopped instance or of one of its
// snapshots, in the instance's project, with an alias when one is given
// and free. The fingerprint is known when the task ends (TaskStatus.NewID).
func (d *incusDriver) publish(ctx context.Context, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	if req.Alias != "" && (len(req.Alias) > 200 || !incusImageRE.MatchString(req.Alias)) {
		return incusFieldError(proto.CodeInvalidValue, "alias", "letters, digits, '.', '_', '-' and '/' (\"web/2026-10\")")
	}
	if msg := incusTextProblem(req.Description, incusMaxValue, false); msg != "" {
		return incusFieldError(proto.CodeInvalidValue, "description", msg)
	}
	if req.Snapshot != "" && !incusVolumeRE.MatchString(req.Snapshot) {
		return incusFieldError(proto.CodeInvalidValue, "snapshot", "not a valid snapshot name")
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, _, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	src := &api.ImagesPostSource{Type: "instance", Name: name}
	if req.Snapshot != "" {
		if _, _, err := c.GetInstanceSnapshot(name, req.Snapshot); err != nil {
			if api.StatusErrorCheck(err, http.StatusNotFound) {
				return incusFieldError(proto.CodeNotFound, "snapshot", "the guest has no snapshot "+req.Snapshot)
			}
			return incusFail(err, proto.CodeNotFound)
		}
		src = &api.ImagesPostSource{Type: "snapshot", Name: name + "/" + req.Snapshot}
	} else if incusActive(inst.Status) {
		return proto.ManageResponse{Code: proto.CodeGuestRunning, Message: "stop the guest, or make the image from a snapshot"}
	}
	body := api.ImagesPost{Source: src}
	body.Properties = map[string]string{}
	if req.Description != "" {
		body.Properties["description"] = req.Description
	}
	if req.Alias != "" {
		if _, _, err := c.GetImageAlias(req.Alias); err == nil {
			return incusFieldError(proto.CodeExists, "alias", "an image is called "+req.Alias+" already")
		}
		body.Aliases = []api.ImageAlias{{Name: req.Alias, Description: req.Description}}
	}
	op, _, err := c.RawOperation("POST", "/images", body, "")
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	return d.opResult(ctx, c, op.Get(), g.ID, 0)
}

// logGet returns the end of the instance's log: lxc.log for containers,
// qemu.log for VMs.
func (d *incusDriver) logGet(g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	n := req.Lines
	switch {
	case n == 0:
		n = incusLogLines
	case n < 0 || n > incusLogMaxLines:
		return incusFieldError(proto.CodeInvalidValue, "lines", "from 1 to 2000")
	}
	c, name, err := d.connect(g.ID)
	if err != nil {
		return incusResp(err)
	}
	defer c.Disconnect()
	inst, _, err := c.GetInstance(name)
	if err != nil {
		return incusFail(err, CodeUnknownGuest)
	}
	file := "lxc.log"
	if inst.Type == string(api.InstanceTypeVM) {
		file = "qemu.log"
	}
	out := &proto.GuestLog{File: file, Lines: []string{}}
	rc, err := c.GetInstanceLogfile(name, file)
	if err != nil {
		if api.StatusErrorCheck(err, http.StatusNotFound) {
			return proto.ManageResponse{OK: true, Log: out} // never started
		}
		return incusFail(err, proto.CodeNotFound)
	}
	defer rc.Close()
	out.Lines = tailLines(io.LimitReader(rc, incusLogMaxBytes), n)
	return proto.ManageResponse{OK: true, Log: out}
}

// tailLines keeps the last n lines of r, without control characters
// (tabs become spaces), each at most 2000 bytes.
func tailLines(r io.Reader, n int) []string {
	ring := make([]string, n)
	count := 0
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.Map(func(r rune) rune {
			switch {
			case r == '\t':
				return ' '
			case unicode.IsControl(r):
				return -1
			}
			return r
		}, strings.ToValidUTF8(sc.Text(), "\uFFFD"))
		if len(line) > 2000 {
			line = strings.ToValidUTF8(line[:2000], "")
		}
		ring[count%n] = line
		count++
	}
	if count <= n {
		return ring[:count]
	}
	start := count % n
	return append(ring[start:], ring[:start]...)
}
