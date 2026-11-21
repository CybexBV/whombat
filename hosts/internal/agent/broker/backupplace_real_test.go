package broker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// TestPlaceRealDocker sets up a backup place against the real Docker of
// this machine: ensure, then a restic container makes a repository and a
// backup over REST, a delete through the REST server is refused (403),
// the kit user makes /kit/ and stores files named by their sha256 (and
// only so) that it can't delete, the cleanup runs once for real and keeps
// the newest 10 kit files of a Whombat, the backups move to a second root
// (the same port, user and repository, the kit files with them; a second
// backup lands next to the first), and removing takes everything away. It runs only with
// HOSTS_REAL_DOCKER=1 inside an agent-resource lease (for example
// agent-resource run --task "hosts backup place real test" --ttl 2h --
// env HOSTS_REAL_DOCKER=1 go test -run TestPlaceRealDocker
// ./internal/agent/broker/): every container carries the lease's labels
// and name prefix, the data lives in the lease's workspace, and the
// containers run as the caller so the workspace can be removed.
func TestPlaceRealDocker(t *testing.T) {
	if os.Getenv("HOSTS_REAL_DOCKER") != "1" {
		t.Skip("set HOSTS_REAL_DOCKER=1 (inside agent-resource run) to run against Docker")
	}
	lease, ws := os.Getenv("AGENT_RESOURCE_LEASE"), os.Getenv("AGENT_RESOURCE_WORKSPACE")
	if lease == "" || ws == "" {
		t.Fatal("run inside agent-resource run: AGENT_RESOURCE_LEASE and AGENT_RESOURCE_WORKSPACE are needed")
	}
	cfgPath := os.Getenv("AGENT_RESOURCE_CONFIG")
	if cfgPath == "" {
		cfgPath = "/etc/agent-resources.json"
	}
	var arc struct {
		Installation string `json:"installation"`
	}
	if b, err := os.ReadFile(cfgPath); err != nil || json.Unmarshal(b, &arc) != nil || arc.Installation == "" {
		t.Fatalf("agent-resource config: %v", err)
	}
	labels := map[string]string{"io.thebeast.agent-resource.owner": arc.Installation, "io.thebeast.agent-resource.lease": lease}
	prefix := "agent-" + lease + "-"
	user := strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	u := newUnraidManager(t.TempDir())
	u.isUnraid = func() bool { return false }
	m := newPlaceManager(u, func() *proto.Report { return &proto.Report{} })
	m.isUnraid = func() bool { return false }
	m.root = filepath.Join(ws, "whombat-backups")
	otherRoot := filepath.Join(ws, "other-place")
	m.testLocations = map[string]string{"other": otherRoot}
	m.fs = directFS{}
	m.prefix = prefix + "whombat-backup-"
	m.labels = labels
	m.user = user
	d := m.docker
	client := "whombat-real-test"
	restPW := "real-test-rest-password-0123456789"
	repoPW := "real-test-repository-password"
	clientCtr := prefix + "restic-client"
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		for _, n := range []string{clientCtr, m.cleanupName(client), m.serverName(client)} {
			if err := d.removeContainer(cctx, n); err != nil {
				t.Errorf("remove %s: %v", n, err)
			}
		}
	})

	// 1. ensure.
	res, err := m.ensure(ctx, &proto.PlaceRequest{Client: client, RestPassword: restPW})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	port := res.Port
	t.Logf("REST server on port %d", port)
	if !res.Created || port < proto.PlaceFirstPort {
		t.Fatalf("ensure = %+v", res)
	}

	// 2. restic init + backup over REST from a restic container that
	// shares the REST server's network.
	resticRun := func(script string) {
		t.Helper()
		spec := containerSpec{Image: PlaceCleanupImage, Entrypoint: []string{"/bin/sh", "-c", script}, User: user, Labels: labels,
			Env: []string{"RESTIC_REPOSITORY=rest:http://" + client + ":" + restPW + "@127.0.0.1:8000/" + client + "/",
				"RESTIC_PASSWORD=" + repoPW, "RESTIC_CACHE_DIR=/tmp/restic-cache", "HOME=/tmp"}}
		spec.HostConfig.NetworkMode = "container:" + m.serverName(client)
		if err := d.createContainer(ctx, clientCtr, spec); err != nil {
			t.Fatal(err)
		}
		if err := d.startContainer(ctx, clientCtr); err != nil {
			t.Fatal(err)
		}
		if code := waitExit(t, ctx, d, clientCtr); code != 0 {
			t.Fatalf("restic exited %d: %s", code, containerLogs(ctx, d, clientCtr))
		}
		t.Logf("restic: %s", containerLogs(ctx, d, clientCtr))
		if err := d.removeContainer(ctx, clientCtr); err != nil {
			t.Fatal(err)
		}
	}
	resticRun("set -e; restic init; restic backup /etc/alpine-release; restic snapshots --compact")

	// 3. Through the published port: the snapshot is listed, deleting it
	// is refused, and another user's path isn't reachable.
	base := "http://127.0.0.1:" + strconv.Itoa(port) + "/" + client
	rest := func(method, path string) (int, []byte) {
		req, _ := http.NewRequestWithContext(ctx, method, base+path, nil)
		req.SetBasicAuth(client, restPW)
		req.Header.Set("Accept", "application/vnd.x.restic.rest.v2")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	code, body := rest(http.MethodGet, "/snapshots/")
	var snaps []struct {
		Name string `json:"name"`
	}
	if code != 200 || json.Unmarshal(body, &snaps) != nil || len(snaps) != 1 {
		t.Fatalf("snapshots: %d %s", code, body)
	}
	if code, body = rest(http.MethodDelete, "/snapshots/"+snaps[0].Name); code != http.StatusForbidden {
		t.Fatalf("delete a snapshot: %d %s, want 403", code, body)
	}
	if code, _ = rest(http.MethodDelete, "/config"); code != http.StatusForbidden {
		t.Errorf("delete the config: %d, want 403", code)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/someone-else/config", nil)
	req.SetBasicAuth(client, restPW)
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode < 400 {
		t.Errorf("another user's repository: %v %v", resp, err)
	} else {
		resp.Body.Close()
	}
	if code, _ = rest(http.MethodGet, "/snapshots/"); code != 200 {
		t.Errorf("snapshots after the refused delete: %d", code)
	}

	// 3b. The kit user: its own repository /kit/, files stored only with
	// POST under the sha256 of their content, never replaced or deleted,
	// and the two users can't read each other's.
	kitBase := "http://127.0.0.1:" + strconv.Itoa(port)
	call := func(user, pw, method, path string, body []byte) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, kitBase+path, bytes.NewReader(body))
		req.SetBasicAuth(user, pw)
		req.Header.Set("Accept", "application/vnd.x.restic.rest.v2")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	kit := func(method, path string, body []byte) (int, []byte) {
		t.Helper()
		return call(proto.PlaceKitUser, proto.PlaceKitPassword, method, path, body)
	}
	record := func(app string, n int) ([]byte, string) {
		b := []byte(fmt.Sprintf(`{"kind":"whombat.kit-envelope/1","appliance":%q,"applianceName":"Real","credentialId":"c%d","salt":"s",`+
			`"envelope":"wbkit1.n.c%d","generation":%d,"createdAt":"2026-11-04T10:%02d:00.000Z"}`, app, n, n, n, n))
		sum := sha256.Sum256(b)
		return b, hex.EncodeToString(sum[:])
	}
	if code, b := kit(http.MethodPost, "/kit?create=true", nil); code != http.StatusUnauthorized {
		t.Errorf("create without the slash: %d %s, want 401", code, b)
	}
	if code, b := kit(http.MethodPost, "/kit/?create=true", nil); code != 200 {
		t.Fatalf("create /kit/: %d %s", code, b)
	}
	other, otherName := record("wb-real-other", 0)
	for _, c := range []struct {
		method, name string
		body         []byte
		want         int
	}{
		{http.MethodPut, otherName, other, http.StatusMethodNotAllowed},           // uploads are POST
		{http.MethodPost, strings.Repeat("0", 64), other, http.StatusBadRequest},  // not its sha256
		{http.MethodPost, "kit-file", other, http.StatusNotFound},                 // not 64 hex
		{http.MethodPost, strings.ToUpper(otherName), other, http.StatusNotFound}, // upper case
		{http.MethodPost, otherName + ".json", other, http.StatusNotFound},        // anything after it
		{http.MethodPost, otherName, other, http.StatusOK},
		{http.MethodPost, otherName, other, http.StatusForbidden}, // never replaced
		{http.MethodDelete, otherName, nil, http.StatusForbidden}, // never deleted
	} {
		if code, b := kit(c.method, "/kit/keys/"+c.name, c.body); code != c.want {
			t.Errorf("%s /kit/keys/%s: %d %s, want %d", c.method, c.name, code, b, c.want)
		}
	}
	if code, b := kit(http.MethodGet, "/kit/keys/"+otherName, nil); code != 200 || !bytes.Equal(b, other) {
		t.Errorf("read a kit file: %d %s", code, b)
	}
	if code, _ := kit(http.MethodGet, "/"+client+"/config", nil); code != http.StatusUnauthorized {
		t.Errorf("the kit user reads the backups: %d", code)
	}
	if code, _ := call(client, restPW, http.MethodGet, "/kit/keys/", nil); code != http.StatusUnauthorized {
		t.Errorf("the client reads the kit files: %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(kitDirIn(m.rootDir(), client), "keys", otherName)); err != nil || !bytes.Equal(b, other) {
		t.Errorf("the kit file on disk: %v", err)
	}
	// Twelve of one Whombat, stored a minute apart.
	var mine []string
	for i := 1; i <= 12; i++ {
		b, name := record("wb-real-test", i)
		if code, rb := kit(http.MethodPost, "/kit/keys/"+name, b); code != 200 {
			t.Fatalf("store %d: %d %s", i, code, rb)
		}
		at := time.Now().Add(time.Duration(i-20) * time.Minute)
		if err := os.Chtimes(filepath.Join(kitDirIn(m.rootDir(), client), "keys", name), at, at); err != nil {
			t.Fatal(err)
		}
		mine = append(mine, name)
	}
	listKit := func() []string {
		t.Helper()
		code, b := kit(http.MethodGet, "/kit/keys/", nil)
		var l []struct {
			Name string `json:"name"`
		}
		if code != 200 || json.Unmarshal(b, &l) != nil {
			t.Fatalf("list the kit files: %d %s", code, b)
		}
		var names []string
		for _, f := range l {
			names = append(names, f.Name)
		}
		slices.Sort(names)
		return names
	}
	if n := len(listKit()); n != 13 {
		t.Errorf("%d kit files, want 13", n)
	}
	if bp := m.status(ctx); len(bp.Clients) != 1 || bp.Clients[0].Kit == nil || !*bp.Clients[0].Kit {
		t.Errorf("status kit = %+v", bp.Clients)
	}

	// 4. The cleanup: due at once (as if a week had passed), it forgets by
	// age and prunes; the fresh snapshot stays.
	status := m.stateFile(client, "cleanup.json")
	if err := os.WriteFile(status, []byte(`{"keep_within_days":90,"running":false,"last_run_at":null,"last_ok":null,"last_error":"","next_run_epoch":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, err := m.setCleanup(ctx, &proto.PlaceRequest{Client: client, RepositoryPassword: repoPW}); err != nil || !r.Set {
		t.Fatalf("cleanup: %+v %v", r, err)
	}
	var st placeCleanupStatus
	deadline := time.Now().Add(3 * time.Minute)
	for {
		b, _ := os.ReadFile(status)
		if json.Unmarshal(b, &st) == nil && st.LastRunAt != nil && !st.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the cleanup didn't run: %s\n%s", b, containerLogs(ctx, d, m.cleanupName(client)))
		}
		time.Sleep(time.Second)
	}
	if st.LastOK == nil || !*st.LastOK || st.KeepWithinDays != 90 {
		t.Fatalf("cleanup status = %+v", st)
	}
	t.Logf("cleanup ran at %s", *st.LastRunAt)
	if code, body = rest(http.MethodGet, "/snapshots/"); code != 200 || json.Unmarshal(body, &snaps) != nil || len(snaps) != 1 {
		t.Errorf("snapshots after the cleanup: %d %s", code, body)
	}
	// The cleanup kept the newest 10 of the twelve and the other Whombat's.
	wantKit := append([]string{otherName}, mine[2:]...)
	slices.Sort(wantKit)
	if got := listKit(); !slices.Equal(got, wantKit) {
		t.Errorf("kit files after the cleanup = %v, want %v\n%s", got, wantKit, containerLogs(ctx, d, m.cleanupName(client)))
	}

	// The report sees it all.
	bp := m.status(ctx)
	var pc *proto.BackupPlaceClient
	for i := range bp.Clients {
		if bp.Clients[i].Client == client {
			pc = &bp.Clients[i]
		}
	}
	if !bp.Supported || pc == nil || pc.Port != port || !pc.Running || !pc.Cleanup.Set || !pc.Cleanup.Running ||
		pc.Cleanup.LastOK == nil || !*pc.Cleanup.LastOK || pc.UsedBytes == nil || *pc.UsedBytes == 0 {
		t.Errorf("status = %+v client %+v", bp, pc)
	}

	if pc != nil && pc.Location != proto.PlaceLocationLinux {
		t.Errorf("location = %q", pc.Location)
	}

	// 5. Move to the other root: the same port, user and repository.
	oldData := m.dataDir(client)
	res, err = m.ensure(ctx, &proto.PlaceRequest{Client: client, RestPassword: restPW, Location: "other"})
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	t.Logf("moved: %+v", res)
	if !res.Moved || res.Created || res.Port != port || res.Location != "other" || res.Path != dataIn(otherRoot, client) {
		t.Fatalf("move = %+v", res)
	}
	if _, err := os.Stat(oldData); !os.IsNotExist(err) {
		t.Errorf("the old backups are still there: %v", err)
	}
	if left := clientStateFiles(m.rootDir(), client); len(left) > 0 {
		t.Errorf("old files left: %v", left)
	}
	for _, n := range []string{m.serverName(client), m.cleanupName(client)} {
		c, err := d.inspectContainer(ctx, n)
		if err != nil || c == nil || !c.State.Running || clientRoot(c.HostConfig.Binds, client) != otherRoot {
			t.Errorf("%s after the move: %+v %v", n, c, err)
		}
	}
	if code, body = rest(http.MethodGet, "/snapshots/"); code != 200 || json.Unmarshal(body, &snaps) != nil || len(snaps) != 1 {
		t.Errorf("snapshots after the move: %d %s", code, body)
	}
	resticRun("set -e; restic backup /etc/passwd; restic snapshots --compact; restic check")
	if code, body = rest(http.MethodGet, "/snapshots/"); code != 200 || json.Unmarshal(body, &snaps) != nil || len(snaps) != 2 {
		t.Errorf("snapshots after a backup in the new place: %d %s", code, body)
	}
	if code, _ = rest(http.MethodDelete, "/snapshots/"+snaps[0].Name); code != http.StatusForbidden {
		t.Errorf("delete after the move: %d, want 403", code)
	}
	if got := listKit(); !slices.Equal(got, wantKit) {
		t.Errorf("kit files after the move = %v", got)
	}
	if exists(kitDirIn(m.rootDir(), client)) {
		t.Error("the kit folder is still in the old root")
	}
	bp = m.status(ctx)
	pc = nil
	for i := range bp.Clients {
		if bp.Clients[i].Client == client {
			pc = &bp.Clients[i]
		}
	}
	if pc == nil || pc.Location != "other" || pc.Port != port || !pc.Cleanup.Set || pc.Cleanup.LastOK == nil || !*pc.Cleanup.LastOK {
		t.Errorf("status after the move = %+v", pc)
	}

	// 6. remove, with the backups, wherever they are.
	if r, err := m.remove(ctx, &proto.PlaceRequest{Client: client, DeleteData: true}); err != nil || !r.Removed {
		t.Fatalf("remove: %+v %v", r, err)
	}
	for _, n := range []string{m.serverName(client), m.cleanupName(client)} {
		if c, err := d.inspectContainer(ctx, n); err != nil || c != nil {
			t.Errorf("%s still there: %v", n, err)
		}
	}
	for _, dir := range []string{m.dataDir(client), dataIn(otherRoot, client), kitDirIn(m.rootDir(), client), kitDirIn(otherRoot, client)} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("backups still there: %s %v", dir, err)
		}
	}
}

// waitExit waits for a container to stop and returns its exit code.
func waitExit(t *testing.T, ctx context.Context, d *dockerDriver, name string) int {
	t.Helper()
	for {
		c, err := d.inspectContainer(ctx, name)
		if err != nil || c == nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !c.State.Running && c.State.Status == "exited" {
			return c.State.ExitCode
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s didn't end", name)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// containerLogs is a container's output, Docker's stream headers dropped.
func containerLogs(ctx context.Context, d *dockerDriver, name string) string {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+name+"/logs?stdout=1&stderr=1&tail=200", nil)
	resp, err := d.httpClient().Do(req)
	if err != nil {
		return err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out strings.Builder
	for len(b) >= 8 {
		n := int(b[4])<<24 | int(b[5])<<16 | int(b[6])<<8 | int(b[7])
		if 8+n > len(b) {
			break
		}
		out.Write(b[8 : 8+n])
		b = b[8+n:]
	}
	return out.String()
}
