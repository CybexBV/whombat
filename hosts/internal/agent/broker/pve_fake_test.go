package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// fakePVE is a Proxmox VE API on an httptest TLS server: it records every
// request and answers from routes ("GET /nodes/pve1/storage"), with PVE's
// envelope and, for errors, PVE's reason phrases.
type fakePVE struct {
	t   *testing.T
	srv *httptest.Server

	mu     sync.Mutex
	routes map[string]func(form url.Values) fakeResp
	reqs   []fakeReq
	auth   []string
}

type fakeReq struct {
	Method, Path string
	Form         url.Values
}

func (r fakeReq) String() string { return r.Method + " " + r.Path + " " + r.Form.Encode() }

// fakeResp is an answer: data (status 200) or an error status with PVE's
// message in the reason phrase and, for 400, the parameter errors.
type fakeResp struct {
	status int
	reason string
	data   any
	errors map[string]string
}

func okResp(data any) fakeResp { return fakeResp{status: 200, data: data} }

func errResp(status int, reason string) fakeResp { return fakeResp{status: status, reason: reason} }

func newFakePVE(t *testing.T) *fakePVE {
	f := &fakePVE{t: t, routes: map[string]func(url.Values) fakeResp{}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	f.defaults()
	return f
}

func (f *fakePVE) serve(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	path := strings.TrimPrefix(r.URL.Path, "/api2/json")
	form := r.Form
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		form = r.PostForm
	}
	f.mu.Lock()
	f.reqs = append(f.reqs, fakeReq{Method: r.Method, Path: path, Form: form})
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	h := f.routes[r.Method+" "+path]
	f.mu.Unlock()
	resp := errResp(501, fmt.Sprintf("Method '%s %s' not implemented", r.Method, path))
	if h != nil {
		resp = h(form)
	}
	if resp.status == 200 {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": resp.data})
		return
	}
	// PVE puts the error into the reason phrase, which net/http cannot
	// set: write the response by hand.
	body, _ := json.Marshal(map[string]any{"data": nil, "errors": resp.errors})
	if resp.errors == nil {
		body = []byte(`{"data":null}`)
	}
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		f.t.Errorf("hijack: %v", err)
		return
	}
	defer conn.Close()
	fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		resp.status, resp.reason, len(body), body)
	buf.Flush()
}

func (f *fakePVE) on(route string, h func(form url.Values) fakeResp) {
	f.mu.Lock()
	f.routes[route] = h
	f.mu.Unlock()
}

func (f *fakePVE) data(route string, data any) {
	f.on(route, func(url.Values) fakeResp { return okResp(data) })
}

// requests returns the recorded requests other than GETs.
func (f *fakePVE) changes() []fakeReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeReq
	for _, r := range f.reqs {
		if r.Method != http.MethodGet {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakePVE) requested(method, path string) []fakeReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeReq
	for _, r := range f.reqs {
		if r.Method == method && r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakePVE) reset() {
	f.mu.Lock()
	f.reqs, f.auth = nil, nil
	f.mu.Unlock()
}

const testUPID = "UPID:pve1:0000A1B2:0012C3D4:6710F0A0:qmconfig:100:whombat-manage@pve!agent-pve1:"

func upidFor(typ, id string) string {
	return "UPID:pve1:0000A1B2:0012C3D4:6710F0A0:" + typ + ":" + id + ":whombat-manage@pve!agent-pve1:"
}

// defaults is a standalone node pve1 with a few storages, two bridges, VM
// 100 (running) and container 200 (stopped).
func (f *fakePVE) defaults() {
	f.data("GET /nodes/pve1/storage", []map[string]any{
		{"storage": "local", "type": "dir", "content": "iso,vztmpl,backup,import", "active": 1, "enabled": 1, "shared": 0, "avail": 50 << 30, "total": 100 << 30},
		{"storage": "local-zfs", "type": "zfspool", "content": "images,rootdir", "active": 1, "enabled": 1, "shared": 0, "avail": 400 << 30, "total": 900 << 30},
		{"storage": "tank", "type": "zfspool", "content": "rootdir,images", "active": 1, "enabled": 1, "shared": 0, "avail": 1 << 40, "total": 2 << 40},
		{"storage": "pbs", "type": "pbs", "content": "backup", "active": 1, "enabled": 1, "shared": 1},
		{"storage": "nas-iso", "type": "nfs", "content": "iso", "active": 0, "enabled": 1, "shared": 1},
	})
	f.data("GET /storage", []map[string]any{
		{"storage": "local", "type": "dir", "content": "iso,vztmpl,backup,import"},
		{"storage": "local-zfs", "type": "zfspool", "content": "images,rootdir", "sparse": 1},
		{"storage": "tank", "type": "zfspool", "content": "rootdir,images"},
		{"storage": "pbs", "type": "pbs", "content": "backup"},
	})
	f.data("GET /nodes/pve1/network", []map[string]any{
		{"iface": "vmbr0", "type": "bridge", "active": 1},
		{"iface": "vmbr1", "type": "OVSBridge", "active": 1},
	})
	f.on("GET /cluster/sdn/vnets", func(url.Values) fakeResp { return errResp(403, "Permission check failed (/sdn/zones, SDN.Audit)") })
	f.data("GET /cluster/status", []map[string]any{{"type": "node", "name": "pve1", "local": 1, "online": 1, "nodeid": 0}})
	f.data("GET /cluster/nextid", "105")
	f.data("GET /cluster/resources", []map[string]any{
		{"id": "qemu/100", "type": "qemu", "vmid": 100, "name": "web", "node": "pve1", "status": "running", "template": 0},
		{"id": "lxc/200", "type": "lxc", "vmid": 200, "name": "dns", "node": "pve1", "status": "stopped", "template": 0},
	})
	f.on("GET /nodes/pve1/storage/local/content", func(q url.Values) fakeResp {
		switch q.Get("content") {
		case "iso":
			return okResp([]map[string]any{{"volid": "local:iso/debian-13.0.0-amd64-netinst.iso", "content": "iso", "format": "iso", "size": 754974720, "ctime": 1760000000}})
		case "vztmpl":
			return okResp([]map[string]any{{"volid": "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", "content": "vztmpl", "format": "tzst", "size": 130000000, "ctime": 1760000100}})
		case "import":
			return okResp([]map[string]any{{"volid": "local:import/haos_ova-16.2.qcow2", "content": "import", "format": "qcow2", "size": 500000000, "ctime": 1760000200}})
		case "backup":
			var out []map[string]any
			for _, b := range []map[string]any{
				{"volid": "local:backup/vzdump-qemu-100-2026_10_16-01_00_02.vma.zst", "content": "backup", "format": "vma.zst", "size": 2 << 30, "ctime": 1760576402, "vmid": 100, "subtype": "qemu", "notes": "nightly"},
				{"volid": "local:backup/vzdump-lxc-200-2026_10_16-01_10_00.tar.zst", "content": "backup", "format": "tar.zst", "size": 1 << 30, "ctime": 1760577000, "vmid": 200, "subtype": "lxc", "protected": 1},
			} {
				if v := q.Get("vmid"); v == "" || fmt.Sprint(b["vmid"]) == v {
					out = append(out, b)
				}
			}
			return okResp(out)
		}
		return okResp([]any{})
	})

	// VM 100: running, one disk, a CD-ROM, an unused volume, root-only keys.
	f.data("GET /nodes/pve1/qemu/100/pending", []map[string]any{
		{"key": "name", "value": "web"},
		{"key": "memory", "value": 4096, "pending": "8192"},
		{"key": "cores", "value": 2},
		{"key": "sockets", "value": 1},
		{"key": "onboot", "value": 1},
		{"key": "tags", "value": "prod;web", "delete": 1},
		{"key": "boot", "value": "order=scsi0;ide2;net0"},
		{"key": "scsi0", "value": "local-zfs:vm-100-disk-0,iothread=1,size=32G"},
		{"key": "ide2", "value": "local:iso/debian-13.0.0-amd64-netinst.iso,media=cdrom,size=737280K"},
		{"key": "efidisk0", "value": "local-zfs:vm-100-disk-2,efitype=4m,pre-enrolled-keys=1,size=1M"},
		{"key": "unused0", "value": "local-zfs:vm-100-disk-1"},
		{"key": "net0", "value": "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1"},
		{"key": "serial0", "value": "socket"},
		{"key": "serial1", "value": "/dev/ttyS0"},
		{"key": "hostpci0", "value": "0000:01:00.0,pcie=1"},
		{"key": "args", "value": "-cpu host,+invtsc"},
		{"key": "smbios1", "value": "uuid=6f1c2a4e-0000-4000-8000-000000000100"},
		{"key": "cipassword", "value": "**********"},
		{"key": "digest", "value": "0123456789abcdef0123456789abcdef01234567"},
		{"key": "scsi1", "pending": "local-zfs:vm-100-disk-3,size=10G"},
	})
	f.data("GET /nodes/pve1/qemu/100/config", map[string]any{"name": "web", "memory": "8192", "digest": "0123456789abcdef0123456789abcdef01234567"})
	f.data("GET /nodes/pve1/qemu/100/status/current", map[string]any{"status": "running", "vmid": 100})

	// Container 200: stopped, a volume mount point and a bind mount.
	f.data("GET /nodes/pve1/lxc/200/pending", []map[string]any{
		{"key": "hostname", "value": "dns"},
		{"key": "memory", "value": 512},
		{"key": "arch", "value": "amd64"},
		{"key": "ostype", "value": "debian"},
		{"key": "unprivileged", "value": 1},
		{"key": "features", "value": "nesting=1"},
		{"key": "rootfs", "value": "local-zfs:subvol-200-disk-0,size=8G"},
		{"key": "mp0", "value": "local-zfs:subvol-200-disk-1,mp=/data,size=20G"},
		{"key": "mp1", "value": "/mnt/backup,mp=/backup"},
		{"key": "net0", "value": "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:C8,ip=dhcp,type=veth"},
		{"key": "lxc.cgroup2.devices.allow", "value": "c 10:200 rwm"},
		{"key": "lock", "value": "backup"},
	})
	f.data("GET /nodes/pve1/lxc/200/config", map[string]any{"hostname": "dns", "digest": "fedcba9876543210fedcba9876543210fedcba98"})
	f.data("GET /nodes/pve1/lxc/200/status/current", map[string]any{"status": "stopped", "vmid": 200})
}

// newTestManage returns a manager for node pve1 that talks to f with the
// token "whombat-manage@pve!agent-pve1=s3cret".
func newTestManage(t *testing.T, f *fakePVE) *pveManage {
	t.Helper()
	tok := filepath.Join(t.TempDir(), "pve-manage-token")
	if err := os.WriteFile(tok, []byte("whombat-manage@pve!agent-pve1=s3cret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return &pveManage{
		node: "pve1", baseURL: f.srv.URL + "/api2/json", tokenFile: tok,
		run: func(ctx context.Context, argv ...string) ([]byte, error) {
			t.Errorf("unexpected command %q", argv)
			return nil, fmt.Errorf("unexpected command")
		},
		isNode: func() bool { return true },
		now:    time.Now,
		newAPI: func(base, token string) (*pveAPI, error) {
			return &pveAPI{base: base, token: token, hc: f.srv.Client()}, nil
		},
	}
}

var (
	testVM = &proto.Guest{ID: "100", Name: "web", Kind: "vm", State: proto.StateRunning, VMID: 100, Node: "pve1"}
	testCT = &proto.Guest{ID: "200", Name: "dns", Kind: "container", State: proto.StateStopped, VMID: 200, Node: "pve1"}
)

func guestCopy(g *proto.Guest) *proto.Guest { c := *g; return &c }
