package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/internal/ops"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

func startServer(t *testing.T, uid uint32) string {
	t.Helper()
	d := t.TempDir()
	fake, err := activator.NewFake(filepath.Join(d, "fake"), "")
	if err != nil {
		t.Fatal(err)
	}
	h, err := ops.New(ops.Config{DeviceID: "d", Env: "dev", PinnedRootPath: filepath.Join(d, "none"), MirrorDir: d,
		StagingDir: d, AssignmentPath: filepath.Join(d, "a"), NetworkCandidatesDir: d, StateDir: filepath.Join(d, "st")}, fake)
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(d, "h.sock")
	a, _ := net.ResolveUnixAddr("unix", sock)
	ln, err := net.ListenUnix("unix", a)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &Server{H: h, ManagerUID: uid}
	go s.Serve(ctx, ln)
	return sock
}

func raw(t *testing.T, sock, line string) proto.Response {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	c.Write([]byte(line + "\n"))
	l, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var r proto.Response
	json.Unmarshal([]byte(l), &r)
	return r
}

func TestWrongPeerUIDRejected(t *testing.T) {
	sock := startServer(t, uint32(os.Getuid())+1)
	r := raw(t, sock, `{"v":1,"op":"bless-boot"}`)
	if r.OK || r.Error.Code != proto.CodeForbidden {
		t.Fatalf("%+v", r)
	}
	if _, err := proto.Do(context.Background(), sock, proto.Request{Op: proto.OpRollbackRuntime}); proto.CodeOf(err) != proto.CodeForbidden {
		t.Fatalf("client: %v", err)
	}
}

func TestOnlyTypedOpsAccepted(t *testing.T) {
	sock := startServer(t, uint32(os.Getuid()))
	for _, line := range []string{
		`{"v":1,"op":"exec","argv":["/bin/sh","-c","id"]}`,
		`{"v":1,"op":"stage-runtime","releaseId":"r1","path":"/etc/shadow"}`,
		`{"v":1,"op":"stage-runtime","releaseId":"https://evil.example/x"}`,
		`{"v":1,"op":"activate-runtime","releaseId":"/nix/store/aaaa-evil"}`,
		`{"v":1,"op":"stage-host","releaseId":"with import <nixpkgs> {}; hello"}`,
		`rm -rf /`,
		`{"v":1,"op":"bless-boot"}` + strings.Repeat(" ", 2000),
	} {
		r := raw(t, sock, line)
		if r.OK || r.Error == nil || r.Error.Code != proto.CodeBadRequest {
			t.Errorf("%q -> %+v", line, r)
		}
	}
	// A typed op reaches the helper (and fails there for lack of state, not for the protocol).
	r := raw(t, sock, `{"v":1,"op":"rollback-runtime"}`)
	if r.OK || r.Error.Code != proto.CodeNothingToRollBack {
		t.Fatalf("%+v", r)
	}
}

func TestHelperDoesNotImportManager(t *testing.T) {
	const module = "github.com/CybexBV/whombat/appliance"
	out, err := exec.Command("go", "list", "-deps", module+"/helper/cmd/whombat-update-helper").Output()
	if err != nil {
		t.Skipf("go list unavailable: %v", err)
	}
	own := false
	for _, p := range strings.Fields(string(out)) {
		if strings.HasPrefix(p, module+"/manager") || strings.HasPrefix(p, module+"/release-tools") {
			t.Errorf("helper binary depends on %s", p)
		}
		own = own || strings.HasPrefix(p, module+"/helper/")
	}
	// Without this a renamed module would pass by matching nothing.
	if !own {
		t.Fatalf("no package of %s among the helper's dependencies: is that still the module's path?", module)
	}
}
