package broker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"rackoon/internal/proto"
)

// fakeDocker is a Docker Engine API on a Unix socket with just what the
// backup places use: ping, containers (list, create, inspect, start,
// stop, remove) and images (inspect, pull).
type fakeDocker struct {
	t      *testing.T
	socket string
	mu     sync.Mutex
	ctrs   map[string]*fakeCtr
	images map[string]bool
	pulls  []string
	seq    int
	down   bool // ping fails
}

type fakeCtr struct {
	id      string
	spec    containerSpec
	running bool
	ports   []int // published by a container that isn't ours
}

func newFakeDocker(t *testing.T) *fakeDocker {
	t.Helper()
	dir, err := os.MkdirTemp("", "fd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fakeDocker{t: t, socket: filepath.Join(dir, "d.sock"), ctrs: map[string]*fakeCtr{}, images: map[string]bool{}}
	l, err := net.Listen("unix", f.socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	return f
}

func (f *fakeDocker) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := r.URL.Path
	notFound := func() { w.WriteHeader(404); fmt.Fprint(w, `{"message":"No such container"}`) }
	switch {
	case p == "/_ping":
		if f.down {
			w.WriteHeader(500)
			return
		}
		fmt.Fprint(w, "OK")
	case r.Method == "GET" && p == "/containers/json":
		var filt struct {
			Label []string `json:"label"`
		}
		_ = json.Unmarshal([]byte(r.URL.Query().Get("filters")), &filt)
		out := []map[string]any{}
		for name, c := range f.ctrs {
			ok := true
			for _, l := range filt.Label {
				k, v, _ := strings.Cut(l, "=")
				if c.spec.Labels[k] != v {
					ok = false
				}
			}
			if !ok {
				continue
			}
			state := "exited"
			ports := []map[string]any{}
			if c.running {
				state = "running"
				for _, b := range c.spec.HostConfig.PortBindings[placeRestPort] {
					n, _ := strconv.Atoi(b.HostPort)
					ports = append(ports, map[string]any{"PrivatePort": 8000, "PublicPort": n, "Type": "tcp"})
				}
				for _, n := range c.ports {
					ports = append(ports, map[string]any{"PrivatePort": 80, "PublicPort": n, "Type": "tcp"})
				}
			}
			mounts := []map[string]any{}
			for _, b := range c.spec.HostConfig.Binds {
				parts := strings.Split(b, ":")
				mounts = append(mounts, map[string]any{"Type": "bind", "Source": parts[0], "Destination": parts[1]})
			}
			out = append(out, map[string]any{"Id": c.id, "Names": []string{"/" + name}, "Image": c.spec.Image, "State": state,
				"Labels": c.spec.Labels, "Ports": ports, "Mounts": mounts})
		}
		_ = json.NewEncoder(w).Encode(out)
	case r.Method == "POST" && p == "/containers/create":
		name := r.URL.Query().Get("name")
		if f.ctrs[name] != nil {
			w.WriteHeader(409)
			fmt.Fprint(w, `{"message":"Conflict"}`)
			return
		}
		var s containerSpec
		if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
			w.WriteHeader(400)
			return
		}
		if !f.images[s.Image] {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"message":"No such image"}`)
			return
		}
		f.seq++
		f.ctrs[name] = &fakeCtr{id: fmt.Sprintf("id%d", f.seq), spec: s}
		w.WriteHeader(201)
		fmt.Fprintf(w, `{"Id":"id%d"}`, f.seq)
	case strings.HasPrefix(p, "/containers/"):
		rest := strings.TrimPrefix(p, "/containers/")
		name, action, _ := strings.Cut(rest, "/")
		c := f.ctrs[name]
		if c == nil {
			notFound()
			return
		}
		switch {
		case r.Method == "GET" && action == "json":
			pc := map[string]any{"Id": c.id, "Name": "/" + name, "Config": map[string]any{"Image": c.spec.Image, "Labels": c.spec.Labels},
				"State":      map[string]any{"Running": c.running, "Status": map[bool]string{true: "running", false: "created"}[c.running]},
				"HostConfig": map[string]any{"PortBindings": c.spec.HostConfig.PortBindings, "Binds": c.spec.HostConfig.Binds}}
			_ = json.NewEncoder(w).Encode(pc)
		case r.Method == "POST" && action == "start":
			c.running = true
			w.WriteHeader(204)
		case r.Method == "POST" && action == "stop":
			if !c.running {
				w.WriteHeader(304)
				return
			}
			c.running = false
			w.WriteHeader(204)
		case r.Method == "DELETE" && action == "":
			if c.running {
				w.WriteHeader(409)
				return
			}
			delete(f.ctrs, name)
			w.WriteHeader(204)
		default:
			w.WriteHeader(400)
		}
	case r.Method == "GET" && strings.HasPrefix(p, "/images/") && strings.HasSuffix(p, "/json"):
		if !f.images[strings.TrimSuffix(strings.TrimPrefix(p, "/images/"), "/json")] {
			w.WriteHeader(404)
			fmt.Fprint(w, `{"message":"No such image"}`)
			return
		}
		fmt.Fprint(w, `{}`)
	case r.Method == "POST" && p == "/images/create":
		ref := r.URL.Query().Get("fromImage") + "@" + r.URL.Query().Get("tag")
		f.pulls = append(f.pulls, ref)
		f.images[ref] = true
		fmt.Fprint(w, `{"status":"Pulling"}`+"\n"+`{"status":"Digest: done"}`+"\n")
	default:
		w.WriteHeader(404)
	}
}

func (f *fakeDocker) ctr(name string) *fakeCtr {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.ctrs[name]
	if c == nil {
		return nil
	}
	cp := *c
	return &cp
}

// placeFixture is a backup place on a temp root with the fake Docker.
type placeFixture struct {
	t    *testing.T
	m    *placeManager
	d    *fakeDocker
	root string
	busy map[int]bool // ports something else listens on
}

func newPlaceFixture(t *testing.T) *placeFixture {
	t.Helper()
	f := &placeFixture{t: t, d: newFakeDocker(t), root: filepath.Join(t.TempDir(), "whombat-backups"), busy: map[int]bool{}}
	u := newUnraidManager(t.TempDir())
	u.isUnraid = func() bool { return false }
	m := newPlaceManager(u, func() *proto.Report {
		return &proto.Report{Host: proto.HostInfo{Addresses: []string{"10.100.0.40", "100.64.1.2", "fd00::1", "10.100.1.23"}}}
	})
	m.docker = &dockerDriver{socket: f.d.socket}
	m.isUnraid = func() bool { return false }
	m.root, m.fs = f.root, directFS{}
	m.portFree = func(p int) bool { return !f.busy[p] }
	m.probe = func(context.Context, int) error { return nil }
	m.poll = time.Millisecond
	f.m = m
	return f
}

func (f *placeFixture) ensure(client, pw string, port int) (proto.PlaceResult, error) {
	return f.m.ensure(context.Background(), &proto.PlaceRequest{Client: client, RestPassword: pw, Port: port})
}

const testRestPW = "correct-horse-battery-staple-42"

func TestPlaceEnsure(t *testing.T) {
	f := newPlaceFixture(t)
	res, err := f.ensure("whombat-home-4hxx", testRestPW, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Port != 8747 || res.Path != filepath.Join(f.root, "whombat-home-4hxx") || res.Client != "whombat-home-4hxx" ||
		!slices.Equal(res.Addresses, []string{"10.100.0.40", "10.100.1.23"}) || !res.Kit {
		t.Fatalf("ensure = %+v", res)
	}
	f.d.mu.Lock()
	pulls := slices.Clone(f.d.pulls)
	f.d.mu.Unlock()
	if !slices.Equal(pulls, []string{PlaceRestImage}) {
		t.Errorf("pulls = %v", f.d.pulls)
	}
	c := f.d.ctr("whombat-backup-whombat-home-4hxx")
	if c == nil || !c.running {
		t.Fatalf("container = %+v", c)
	}
	s := c.spec
	if s.Image != PlaceRestImage || !slices.Equal(s.Entrypoint, []string{"/usr/bin/rest-server"}) ||
		!slices.Contains(s.Cmd, "--append-only") || !slices.Contains(s.Cmd, "--private-repos") ||
		s.HostConfig.RestartPolicy.Name != "unless-stopped" || s.HostConfig.Tmpfs["/data"] == "" ||
		s.HostConfig.PortBindings[placeRestPort][0].HostPort != "8747" ||
		s.Labels["whombat.service"] != "backup-place" || s.Labels["whombat.client"] != "whombat-home-4hxx" || s.Labels["whombat.kit"] != "1" {
		t.Errorf("spec = %+v", s)
	}
	// The kit user's repository /kit/ is the client's kit folder in .whombat.
	kitDir := filepath.Join(f.root, ".whombat/whombat-home-4hxx.kit")
	wantBinds := []string{filepath.Join(f.root, "whombat-home-4hxx") + ":/data/whombat-home-4hxx",
		filepath.Join(f.root, ".whombat/whombat-home-4hxx.htpasswd") + ":/auth/.htpasswd:ro", kitDir + ":/data/kit"}
	if !slices.Equal(s.HostConfig.Binds, wantBinds) {
		t.Errorf("binds = %v", s.HostConfig.Binds)
	}
	if st, err := os.Stat(kitDir); err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Errorf("kit folder: %v %v", st, err)
	}
	ht := filepath.Join(f.root, ".whombat/whombat-home-4hxx.htpasswd")
	b, err := os.ReadFile(ht)
	if err != nil {
		t.Fatal(err)
	}
	if users := htpasswdUsers(t, string(b)); len(users) != 2 ||
		bcrypt.CompareHashAndPassword([]byte(users["whombat-home-4hxx"]), []byte(testRestPW)) != nil ||
		bcrypt.CompareHashAndPassword([]byte(users[proto.PlaceKitUser]), []byte(proto.PlaceKitPassword)) != nil {
		t.Errorf("htpasswd = %q", b)
	}
	if st, _ := os.Stat(ht); st.Mode().Perm() != 0o600 {
		t.Errorf("htpasswd mode = %v", st.Mode())
	}
	if b, _ := os.ReadFile(filepath.Join(f.root, ".whombat/cleanup.sh")); string(b) != placeCleanupScript {
		t.Error("cleanup script not written")
	}
	if bp := f.m.status(context.Background()); len(bp.Clients) != 1 || bp.Clients[0].Kit == nil || !*bp.Clients[0].Kit {
		t.Errorf("status = %+v", bp.Clients)
	}

	// Again with the same password: nothing changes.
	res, err = f.ensure("whombat-home-4hxx", testRestPW, 0)
	if err != nil || res.Created || res.Port != 8747 {
		t.Fatalf("again = %+v %v", res, err)
	}
	if c2 := f.d.ctr("whombat-backup-whombat-home-4hxx"); c2.id != c.id {
		t.Error("the container was recreated without a change")
	}
	if b2, _ := os.ReadFile(ht); string(b2) != string(b) {
		t.Error("the htpasswd line was rewritten")
	}
	// A new password: a new line and a new container on the same port; the
	// kit user's line stays. (The REST server re-reads its htpasswd only
	// when the file it opened changes, and the bind pins the file that was
	// there at the start, so a changed file needs a new container.)
	if res, err = f.ensure("whombat-home-4hxx", "another-password-of-24-chars", 0); err != nil || res.Port != 8747 {
		t.Fatalf("new password = %+v %v", res, err)
	}
	if c3 := f.d.ctr("whombat-backup-whombat-home-4hxx"); c3.id == c.id || !c3.running {
		t.Errorf("not recreated: %+v", c3)
	}
	b3, _ := os.ReadFile(ht)
	if before, after := htpasswdUsers(t, string(b)), htpasswdUsers(t, string(b3)); after[proto.PlaceKitUser] != before[proto.PlaceKitUser] ||
		after["whombat-home-4hxx"] == before["whombat-home-4hxx"] {
		t.Errorf("htpasswd after a new password = %q", b3)
	}
	// A stopped container is started again.
	f.d.mu.Lock()
	f.d.ctrs["whombat-backup-whombat-home-4hxx"].running = false
	f.d.mu.Unlock()
	if _, err = f.ensure("whombat-home-4hxx", "another-password-of-24-chars", 0); err != nil || !f.d.ctr("whombat-backup-whombat-home-4hxx").running {
		t.Errorf("not started again: %v", err)
	}
}

func TestPlaceEnsurePorts(t *testing.T) {
	f := newPlaceFixture(t)
	f.d.images[PlaceRestImage] = true
	f.d.ctrs["nginx"] = &fakeCtr{id: "x", running: true, ports: []int{8747}, spec: containerSpec{Image: "nginx", Labels: map[string]string{}}}
	f.busy[8748] = true
	res, err := f.ensure("whombat-home-4hxx", testRestPW, 0)
	if err != nil || res.Port != 8749 {
		t.Fatalf("first free = %+v %v", res, err)
	}
	f.d.mu.Lock()
	n := len(f.d.pulls)
	f.d.mu.Unlock()
	if n != 0 {
		t.Errorf("pulled an image that was there")
	}
	// A second Whombat gets the next port.
	if res, err = f.ensure("whombat-office-a1b2", testRestPW, 0); err != nil || res.Port != 8750 {
		t.Fatalf("second = %+v %v", res, err)
	}
	// An asked port that is taken.
	if _, err = f.ensure("whombat-office-a1b2", testRestPW, 8747); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Errorf("taken port: %v", err)
	}
	// An asked free port moves it.
	if res, err = f.ensure("whombat-office-a1b2", testRestPW, 9000); err != nil || res.Port != 9000 || res.Created {
		t.Errorf("move = %+v %v", res, err)
	}
}

func TestPlaceEnsureRefusals(t *testing.T) {
	f := newPlaceFixture(t)
	for _, tc := range []struct {
		client, pw string
		port       int
		field      string
	}{
		{"Whombat", testRestPW, 0, "client"},
		{"ab", testRestPW, 0, "client"},
		{"whombat-home", "short", 0, "rest_password"},
		{"whombat-home", strings.Repeat("x", 73), 0, "rest_password"},
		{"whombat-home", testRestPW + "\n", 0, "rest_password"},
		{"whombat-home", testRestPW, 80, "port"},
		{proto.PlaceKitUser, testRestPW, 0, "client"},
	} {
		resp := placeFailure(func() error { _, err := f.ensure(tc.client, tc.pw, tc.port); return err }())
		if resp.Code != proto.CodeInvalidValue || resp.FieldErrors[tc.field] == "" {
			t.Errorf("%+v: %+v", tc, resp)
		}
	}
	f.d.mu.Lock()
	f.d.down = true
	f.d.mu.Unlock()
	_, err := f.ensure("whombat-home", testRestPW, 0)
	if resp := placeFailure(err); resp.Code != CodeUnsupported || resp.Place.Reason != proto.PlaceDockerDown {
		t.Errorf("docker down: %+v", resp)
	}
	f.m.docker = &dockerDriver{socket: filepath.Join(t.TempDir(), "none.sock")}
	f.m.docker.socket = ""
	dockerSockets = []string{filepath.Join(t.TempDir(), "none.sock")}
	defer func() { dockerSockets = []string{"/var/run/docker.sock", "/run/docker.sock"} }()
	_, err = f.ensure("whombat-home", testRestPW, 0)
	if resp := placeFailure(err); resp.Code != CodeUnsupported || resp.Place.Reason != proto.PlaceNoDocker {
		t.Errorf("no docker: %+v", resp)
	}
}

func TestPlaceCleanupAndRemove(t *testing.T) {
	f := newPlaceFixture(t)
	ctx := context.Background()
	cl := func(pw string, days int) (proto.PlaceResult, error) {
		return f.m.setCleanup(ctx, &proto.PlaceRequest{Client: "whombat-home-4hxx", RepositoryPassword: pw, KeepWithinDays: days})
	}
	if _, err := cl("repo-secret", 0); placeFailure(err).Code != proto.CodeNotFound {
		t.Fatalf("cleanup before ensure: %v", err)
	}
	if _, err := f.ensure("whombat-home-4hxx", testRestPW, 0); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []struct {
		pw   string
		days int
	}{{"", 90}, {"two\nlines", 90}, {"ok", 3}, {"ok", 5000}} {
		if _, err := cl(bad.pw, bad.days); placeFailure(err).Code != proto.CodeInvalidValue {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	res, err := cl("repo-secret", 0)
	if err != nil || !res.Set {
		t.Fatalf("cleanup = %+v %v", res, err)
	}
	pass := filepath.Join(f.root, ".whombat/whombat-home-4hxx.pass")
	if b, _ := os.ReadFile(pass); string(b) != "repo-secret" {
		t.Errorf("pass = %q", b)
	}
	if st, _ := os.Stat(pass); st.Mode().Perm() != 0o600 {
		t.Errorf("pass mode = %v", st.Mode())
	}
	c := f.d.ctr("whombat-backup-whombat-home-4hxx-cleanup")
	if c == nil || !c.running {
		t.Fatalf("cleanup container = %+v", c)
	}
	s := c.spec
	if s.Image != PlaceCleanupImage || !slices.Equal(s.Entrypoint, []string{"/bin/sh", "/state/cleanup.sh"}) ||
		!slices.Equal(s.Cmd, []string{"whombat-home-4hxx", "90"}) || s.HostConfig.NetworkMode != "none" ||
		!slices.Equal(s.HostConfig.Binds, []string{filepath.Join(f.root, "whombat-home-4hxx") + ":/data/whombat-home-4hxx",
			filepath.Join(f.root, ".whombat") + ":/state"}) || s.Labels["whombat.role"] != "cleanup" {
		t.Errorf("cleanup spec = %+v", s)
	}
	f.d.mu.Lock()
	pulled := slices.Contains(f.d.pulls, PlaceCleanupImage)
	f.d.mu.Unlock()
	if !pulled {
		t.Error("the cleanup image wasn't pulled")
	}
	// Other days recreate it.
	if _, err := cl("repo-secret", 30); err != nil {
		t.Fatal(err)
	}
	if c2 := f.d.ctr("whombat-backup-whombat-home-4hxx-cleanup"); c2.id == c.id || c2.spec.Cmd[1] != "30" {
		t.Errorf("days not applied: %+v", c2)
	}

	// The report.
	last := "2026-11-03T13:00:00Z"
	os.WriteFile(filepath.Join(f.root, ".whombat/whombat-home-4hxx.cleanup.json"),
		[]byte(`{"keep_within_days":30,"running":false,"last_run_at":"`+last+`","last_ok":false,"last_error":"Fatal: wrong password","next_run_epoch":1}`), 0o600)
	os.WriteFile(filepath.Join(f.root, "whombat-home-4hxx/config"), make([]byte, 5000), 0o600)
	bp := f.m.status(ctx)
	if !bp.Supported || bp.Platform != proto.PlacePlatformLinux || bp.Root != f.root || bp.FreeBytes == nil || len(bp.Clients) != 1 {
		t.Fatalf("status = %+v", bp)
	}
	pc := bp.Clients[0]
	if pc.Client != "whombat-home-4hxx" || pc.Port != 8747 || !pc.Running || pc.Image != PlaceRestImage || pc.UsedBytes == nil || *pc.UsedBytes < 5000 ||
		!pc.Cleanup.Set || !pc.Cleanup.Running || pc.Cleanup.KeepWithinDays != 30 || pc.Cleanup.LastRunAt == nil ||
		pc.Cleanup.LastRunAt.Format(time.RFC3339) != last || pc.Cleanup.LastOK == nil || *pc.Cleanup.LastOK || pc.Cleanup.LastError != "Fatal: wrong password" {
		t.Errorf("client = %+v", pc)
	}

	// Remove keeps the backups unless asked.
	res, err = f.m.remove(ctx, &proto.PlaceRequest{Client: "whombat-home-4hxx"})
	if err != nil || !res.Removed {
		t.Fatalf("remove = %+v %v", res, err)
	}
	f.d.mu.Lock()
	left := len(f.d.ctrs)
	f.d.mu.Unlock()
	if left != 0 {
		t.Errorf("%d containers left", left)
	}
	for _, ext := range []string{"htpasswd", "pass", "cleanup.json"} {
		if _, err := os.Stat(filepath.Join(f.root, ".whombat/whombat-home-4hxx."+ext)); !os.IsNotExist(err) {
			t.Errorf("%s left", ext)
		}
	}
	if _, err := os.Stat(filepath.Join(f.root, "whombat-home-4hxx/config")); err != nil {
		t.Error("the backups were deleted")
	}
	if _, err := os.Stat(filepath.Join(f.root, ".whombat/whombat-home-4hxx.kit")); err != nil {
		t.Error("the locked backup details went without the backups")
	}
	if bp := f.m.status(ctx); len(bp.Clients) != 0 {
		t.Errorf("clients after remove: %+v", bp.Clients)
	}
	// Removing again is fine; with delete_data the backups go.
	if res, err = f.m.remove(ctx, &proto.PlaceRequest{Client: "whombat-home-4hxx", DeleteData: true}); err != nil || !res.Removed {
		t.Fatalf("remove data = %+v %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(f.root, "whombat-home-4hxx")); !os.IsNotExist(err) {
		t.Error("the backups are still there")
	}
	if _, err := os.Stat(filepath.Join(f.root, ".whombat/whombat-home-4hxx.kit")); !os.IsNotExist(err) {
		t.Error("the locked backup details are still there")
	}
}

// htpasswdUsers reads an htpasswd file's lines (user → hash).
func htpasswdUsers(t *testing.T, content string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(content), "\n") {
		u, h, ok := strings.Cut(l, ":")
		if !ok || out[u] != "" {
			t.Fatalf("htpasswd line %q in %q", l, content)
		}
		out[u] = h
	}
	return out
}

// TestPlaceKitForOlderInstalls: a REST server set up before the kit user
// gets it from the next ensure (its user's line kept as it was, the
// container made again with the kit folder), the cleanup is made again for
// the new script with its days and windows, and an ensure after that
// changes nothing.
func TestPlaceKitForOlderInstalls(t *testing.T) {
	f := newPlaceFixture(t)
	ctx := context.Background()
	const client = "whombat-home-4hxx"
	if _, err := f.ensure(client, testRestPW, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.m.setCleanup(ctx, &proto.PlaceRequest{Client: client, RepositoryPassword: "repo-secret", KeepWithinDays: 30,
		KeepDailyDays: 14}); err != nil {
		t.Fatal(err)
	}
	// What an agent from before left: one user, no kit folder, settings
	// hashed by an older version.
	ht := stateFileIn(f.root, client, "htpasswd")
	users := htpasswdUsers(t, readFile(t, ht))
	ownLine := client + ":" + users[client] + "\n"
	writeFile(t, ht, ownLine)
	if err := os.Remove(kitDirIn(f.root, client)); err != nil {
		t.Fatal(err)
	}
	f.d.mu.Lock()
	srv, cl := f.d.ctrs["whombat-backup-"+client], f.d.ctrs["whombat-backup-"+client+"-cleanup"]
	srv.spec.HostConfig.Binds = srv.spec.HostConfig.Binds[:2]
	delete(srv.spec.Labels, "whombat.kit")
	srv.spec.Labels["whombat.config"], cl.spec.Labels["whombat.config"] = "older", "older"
	oldSrv, oldCl, oldCmd := srv.id, cl.id, slices.Clone(cl.spec.Cmd)
	f.d.mu.Unlock()
	if bp := f.m.status(ctx); bp.Clients[0].Kit == nil || *bp.Clients[0].Kit {
		t.Fatalf("before: kit = %v", bp.Clients[0].Kit)
	}

	res, err := f.ensure(client, testRestPW, 0)
	if err != nil || !res.Kit || res.Created || res.Port != 8747 {
		t.Fatalf("ensure = %+v %v", res, err)
	}
	b := readFile(t, ht)
	if !strings.HasPrefix(b, ownLine) || bcrypt.CompareHashAndPassword([]byte(htpasswdUsers(t, b)[proto.PlaceKitUser]),
		[]byte(proto.PlaceKitPassword)) != nil {
		t.Errorf("htpasswd = %q", b)
	}
	s, c := f.d.ctr("whombat-backup-"+client), f.d.ctr("whombat-backup-"+client+"-cleanup")
	if s.id == oldSrv || !s.running || !slices.Contains(s.spec.HostConfig.Binds, kitDirIn(f.root, client)+":/data/kit") ||
		s.spec.Labels["whombat.kit"] != "1" || !exists(kitDirIn(f.root, client)) {
		t.Errorf("server = %+v", s)
	}
	if c.id == oldCl || !c.running || !slices.Equal(c.spec.Cmd, oldCmd) || c.spec.Labels["whombat.keep"] != "30,14,0,0,0" {
		t.Errorf("cleanup = %+v (was %v)", c.spec, oldCmd)
	}
	if bp := f.m.status(ctx); bp.Clients[0].Kit == nil || !*bp.Clients[0].Kit {
		t.Errorf("after: kit = %v", bp.Clients[0].Kit)
	}
	if _, err := f.ensure(client, testRestPW, 0); err != nil {
		t.Fatal(err)
	}
	if s2, c2 := f.d.ctr("whombat-backup-"+client), f.d.ctr("whombat-backup-"+client+"-cleanup"); s2.id != s.id || c2.id != c.id {
		t.Error("an ensure without changes made a container again")
	}
	if readFile(t, ht) != b {
		t.Error("an ensure without changes rewrote the users")
	}
}

// cleanupScript is the cleanup script on this machine's sh with its
// folders in a temporary one; run starts it for client c1 with a fake
// restic (its arguments land in <dir>/args) and returns the status of the
// first run, which is due at once.
func cleanupScript(t *testing.T) (dir, state string, run func(restic string, extra ...string) map[string]any) {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir = t.TempDir()
	state, bin := filepath.Join(dir, "state"), filepath.Join(dir, "bin")
	os.MkdirAll(state, 0o755)
	os.MkdirAll(bin, 0o755)
	script := strings.NewReplacer(`"/state/`, `"`+state+`/`, `"/data/`, `"`+dir+`/data/`, "/tmp/cleanup.log", dir+"/cleanup.log").Replace(placeCleanupScript)
	os.WriteFile(filepath.Join(dir, "cleanup.sh"), []byte(script), 0o755)
	run = func(restic string, extra ...string) map[string]any {
		t.Helper()
		os.WriteFile(filepath.Join(bin, "restic"), []byte("#!/bin/sh\necho \"$@\" >> "+dir+"/args\n"+restic), 0o755)
		status := filepath.Join(state, "c1.cleanup.json")
		os.WriteFile(status, []byte(`{"keep_within_days":90,"running":false,"last_run_at":null,"last_ok":null,"last_error":"","next_run_epoch":1}`), 0o600)
		cmd := exec.Command("sh", append([]string{filepath.Join(dir, "cleanup.sh"), "c1", "90"}, extra...)...)
		cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin"}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() {
			cmd.Process.Signal(os.Interrupt)
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				cmd.Process.Kill()
				t.Error("the script didn't stop on a signal")
			}
		}()
		for range 200 {
			b, _ := os.ReadFile(status)
			var st map[string]any
			if json.Unmarshal(b, &st) == nil && st["last_run_at"] != nil && st["running"] == false {
				return st
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("the cleanup didn't run")
		return nil
	}
	return dir, state, run
}

// TestPlaceCleanupScript runs the cleanup script with a fake restic: a
// due run forgets by age only, its result lands in the status file, and a
// failed run keeps restic's last line without quotes.
func TestPlaceCleanupScript(t *testing.T) {
	dir, state, run := cleanupScript(t)
	st := run("exit 0")
	args, _ := os.ReadFile(filepath.Join(dir, "args"))
	if a := strings.TrimSpace(string(args)); a != "-r "+dir+"/data/c1 --password-file "+state+"/c1.pass --no-cache forget --group-by  --keep-within 90d --prune --retry-lock 2h" {
		t.Errorf("restic %q", a)
	}
	next, _ := st["next_run_epoch"].(float64)
	if st["last_ok"] != true || st["last_error"] != "" || st["keep_within_days"] != float64(90) ||
		int64(next) < time.Now().Unix()+604000 {
		t.Errorf("status = %v", st)
	}
	if _, err := time.Parse(time.RFC3339, st["last_run_at"].(string)); err != nil {
		t.Errorf("last_run_at %v", st["last_run_at"])
	}
	st = run(`echo 'Fatal: "repository" is \locked' >&2; echo >&2; exit 1`)
	if st["last_ok"] != false || st["last_error"] != "Fatal: repository is locked" {
		t.Errorf("failed status = %v", st)
	}
	// The person's windows and a limit the backups are over (HS-251): the windows first, then ever shorter ones,
	// the last 7 days always kept, and the status says it is still over.
	os.Remove(filepath.Join(dir, "args"))
	os.MkdirAll(filepath.Join(dir, "data", "c1"), 0o755)
	os.WriteFile(filepath.Join(dir, "data", "c1", "pack"), make([]byte, 3<<20), 0o644)
	st = run("exit 0", "14", "56", "12", "1000000")
	args, _ = os.ReadFile(filepath.Join(dir, "args"))
	lines := strings.Split(strings.TrimSpace(string(args)), "\n")
	if len(lines) < 4 || !strings.Contains(lines[0], "--keep-within 90d --keep-within-daily 14d --keep-within-weekly 56d --keep-within-monthly 12m") ||
		!strings.Contains(lines[1], "--keep-within-monthly 6m") || !strings.Contains(lines[len(lines)-1], "--keep-within 90d --keep-within-daily 7d") {
		t.Errorf("restic with windows %q", lines)
	}
	if st["over_limit"] != true || st["keep"] != "90,14,56,12,1000000" || st["last_ok"] != true {
		t.Errorf("windows status = %v", st)
	}
	if next, _ := st["next_run_epoch"].(float64); int64(next) > time.Now().Unix()+90000 {
		t.Errorf("with windows the cleanup runs daily: %v", next)
	}
	if strings.Contains(placeCleanupScript, "keep-last") {
		t.Error("the cleanup keeps by count")
	}
}

// TestPlaceCleanupKitFiles: the cleanup keeps the newest 10 kit files of
// each Whombat, newest by when they were stored whatever date they carry,
// and touches nothing that isn't a kit file named by its sha256; without a
// kit folder it runs as before.
func TestPlaceCleanupKitFiles(t *testing.T) {
	dir, state, run := cleanupScript(t)
	keys := filepath.Join(state, "c1.kit", "keys")
	if err := os.MkdirAll(keys, 0o700); err != nil {
		t.Fatal(err)
	}
	base := time.Now().Add(-48 * time.Hour)
	put := func(name, body string, age int) string {
		t.Helper()
		if name == "" {
			sum := sha256.Sum256([]byte(body))
			name = hex.EncodeToString(sum[:])
		}
		p := filepath.Join(keys, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		at := base.Add(time.Duration(age) * time.Minute)
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
		return name
	}
	record := func(app string, n int, created string) string {
		return fmt.Sprintf(`{"kind":"whombat.kit-envelope/1","appliance":%q,"applianceName":"Home","credentialId":"c%d","salt":"s",`+
			`"envelope":"wbkit1.n.c%d","generation":%d,"createdAt":%q}`, app, n, n, n, created)
	}
	// Twelve of one Whombat: the two stored first go, though they claim to
	// be the newest.
	var home []string
	for i := range 12 {
		created := "2026-11-0" + strconv.Itoa(1+i%9) + "T10:00:00.000Z"
		if i < 2 {
			created = "2099-01-01T00:00:00.000Z"
		}
		home = append(home, put("", record("wb-3fkq-8mzt-2049", i, created), i))
	}
	// Three of another, one written with spaces: all stay.
	office := []string{put("", record("wb-office-a1b2", 1, "2026-11-01T00:00:00Z"), 1), put("", record("wb-office-a1b2", 2, "2026-11-02T00:00:00Z"), 2),
		put("", `{ "kind" : "whombat.kit-envelope/1", "appliance" : "wb-office-a1b2", "createdAt" : "2026-11-03T00:00:00Z" }`, 3)}
	// What isn't a kit file stays, however old.
	other := []string{
		put("", `{"kind":"something-else","appliance":"wb-3fkq-8mzt-2049"}`, -100),
		put("", `{"kind":"whombat.kit-envelope/1"}`, -99),
		put("notes.txt", record("wb-3fkq-8mzt-2049", 90, ""), -98),
		put(strings.Repeat("A", 64), record("wb-3fkq-8mzt-2049", 91, ""), -97),
		put(home[5]+".rest-server-temp", record("wb-3fkq-8mzt-2049", 92, ""), -96),
		put("", record("wb-3fkq-8mzt-2049", 93, "")+strings.Repeat(" ", 70_000), -95),
	}
	if err := os.Mkdir(filepath.Join(keys, strings.Repeat("b", 64)), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(dir, "outside")
	os.WriteFile(outside, []byte(record("wb-3fkq-8mzt-2049", 94, "")), 0o600)
	link := strings.Repeat("c", 64)
	if err := os.Symlink(outside, filepath.Join(keys, link)); err != nil {
		t.Fatal(err)
	}

	if st := run("exit 0"); st["last_ok"] != true {
		t.Fatalf("status = %v", st)
	}
	for i, n := range home {
		if want := i >= 2; exists(filepath.Join(keys, n)) != want {
			t.Errorf("home file %d (stored %d min after the first): there = %v, want %v", i, i, !want, want)
		}
	}
	for _, n := range append(append(office, other...), strings.Repeat("b", 64), link) {
		if !exists(filepath.Join(keys, n)) {
			t.Errorf("%s was removed", n)
		}
	}
	if !exists(outside) {
		t.Error("the link's target was removed")
	}
	if !strings.Contains(placeCleanupScript, "keep="+strconv.Itoa(proto.PlaceKitKeep)+" ") {
		t.Error("the script doesn't keep proto.PlaceKitKeep kit files")
	}

	// No kit folder: nothing to tidy, the cleanup runs as before.
	if err := os.RemoveAll(filepath.Join(state, "c1.kit")); err != nil {
		t.Fatal(err)
	}
	if st := run("exit 0"); st["last_ok"] != true || st["last_error"] != "" {
		t.Errorf("without a kit folder: %v", st)
	}
}

func TestPlaceAddresses(t *testing.T) {
	got := PlaceAddresses([]string{"10.100.0.40", "192.168.1.2", "100.100.1.1", "8.8.8.8", "fd00::1", "172.16.5.1", "bad"})
	if !slices.Equal(got, []string{"10.100.0.40", "192.168.1.2", "172.16.5.1"}) {
		t.Errorf("addresses = %v", got)
	}
}

func TestPlaceManageDispatch(t *testing.T) {
	f := newPlaceFixture(t)
	b := NewBroker(nil, func() *proto.Report { return &proto.Report{} }, nil)
	b.placeMgr = f.m
	b.placeOnce.Do(func() {})
	r := b.Manage(context.Background(), proto.ManageRequest{Op: proto.OpPlaceEnsure, Platform: proto.PlatformHost,
		Place: &proto.PlaceRequest{Client: "whombat-home-4hxx", RestPassword: testRestPW}})
	if !r.OK || r.Place == nil || r.Place.Port != 8747 {
		t.Fatalf("ensure = %+v", r)
	}
	r = b.Manage(context.Background(), proto.ManageRequest{Op: proto.OpPlaceNFS, Platform: proto.PlatformHost,
		Place: &proto.PlaceRequest{Name: "whombat-pve-01", Clients: []string{"10.100.1.5"}}})
	if r.Code != CodeUnsupported || r.Place == nil || r.Place.Reason != proto.PlaceNotUnraid {
		t.Errorf("nfs on linux = %+v", r)
	}
	if r = b.Manage(context.Background(), proto.ManageRequest{Op: proto.OpPlaceRemove, Platform: proto.PlatformHost}); r.Code != CodeInvalid {
		t.Errorf("no values = %+v", r)
	}
}
