package broker

import (
	"context"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	incus "github.com/lxc/incus/v6/client"
	"github.com/lxc/incus/v6/shared/api"

	"rackoon/internal/proto"
)

// The real-Incus test runs every Incus operation against the host's Incus
// (WHOMBAT_TEST_INCUS=1, the socket from INCUS_SOCKET or
// /var/lib/incus/unix.socket). It works only inside the throwaway project
// whombat-test, which it creates and deletes with everything in it; it
// never touches another project, instance, image, profile, network,
// pool or volume. The project keeps its own images and profiles, so
// nothing lands in the default project.
const realProject = "whombat-test"

func TestIncusReal(t *testing.T) {
	if os.Getenv("WHOMBAT_TEST_INCUS") != "1" {
		t.Skip("set WHOMBAT_TEST_INCUS=1 to run against the host's Incus (project " + realProject + " only)")
	}
	sock := os.Getenv("INCUS_SOCKET")
	if sock == "" {
		sock = "/var/lib/incus/unix.socket"
	}
	pool, network := os.Getenv("WHOMBAT_TEST_INCUS_POOL"), os.Getenv("WHOMBAT_TEST_INCUS_NETWORK")
	if pool == "" {
		pool = "default"
	}
	if network == "" {
		network = "incusbr0"
	}
	root, err := incus.ConnectIncusUnix(sock, &incus.ConnectionArgs{UserAgent: "whombat-agent-test", SkipGetEvents: true})
	if err != nil {
		t.Fatal(err)
	}
	defer root.Disconnect()
	if _, _, err := root.GetProject(realProject); err == nil {
		t.Logf("project %s is left from an earlier run: emptying it", realProject)
		realCleanup(t, root)
	}
	if err := root.CreateProject(api.ProjectsPost{Name: realProject, ProjectPut: api.ProjectPut{
		Description: "Whombat's throwaway test project (deleted by the test)",
		Config: map[string]string{"features.images": "true", "features.profiles": "true", "features.storage.volumes": "true",
			"features.networks": "false"}}}); err != nil {
		t.Fatal(err)
	}
	defer realCleanup(t, root)

	d := &incusDriver{socket: sock}
	ctx := context.Background()
	must := func(what string, r proto.ManageResponse) proto.ManageResponse {
		t.Helper()
		if !r.OK {
			t.Fatalf("%s: %s %s %v", what, r.Code, r.Message, r.FieldErrors)
		}
		if r.Task != nil {
			st := realWait(t, d, r.Task.ID)
			if st.Status != "ok" {
				t.Fatalf("%s: task %s %s: %s", what, st.ID, st.Status, st.Message)
			}
			r.TaskStatus = &st
		}
		return r
	}
	id := func(name string) string { return realProject + "/" + name }
	ct1 := incusGuestOf(id("wbt-ct1"), "container")

	ch := must("choices", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpChoices, Project: realProject}))
	if !slices.Contains(ch.Choices.Projects, realProject) || ch.Choices.Project != realProject || !slices.Contains(ch.Choices.Bridges, network) {
		t.Fatalf("choices: %+v", ch.Choices)
	}

	// Create from images: in the project, on a pool, on a network.
	r := must("create", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Name: "wbt-ct1", Image: "images:alpine/3.22",
		Project: realProject, Pool: pool, Network: network, Set: map[string]string{"limits.cpu": "1", "limits.memory": "256MiB"}}))
	if r.NewID != id("wbt-ct1") {
		t.Fatalf("create: %+v", r)
	}

	// Configuration: read, change with the digest, devices and a schedule.
	cfg := must("config.get", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpConfigGet})).Config
	if cfg.Values["limits.cpu"] != "1" || cfg.Values["device.root"] != "type=disk,path=/,pool="+pool {
		t.Fatalf("config: %+v", cfg.Values)
	}
	r = must("config.set", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpConfigSet, Digest: cfg.Digest,
		Set: map[string]string{"snapshots.schedule": "@daily", "user.note": "Whombat test", "description": "Throwaway"}}))
	if len(r.Changes) != 3 {
		t.Errorf("config.set changes: %+v", r.Changes)
	}
	if r := d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpConfigSet, Digest: cfg.Digest, Set: map[string]string{"limits.cpu": "2"}}); r.Code != proto.CodeDigestMismatch {
		t.Errorf("stale digest: %+v", r)
	}
	if r := d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"security.privileged": "true"}}); r.Code != proto.CodeNotAllowed {
		t.Errorf("privileged: %+v", r)
	}

	// Start it: the log and its lease.
	if err := d.power(ctx, ct1, proto.ActionStart); err != nil {
		t.Fatal(err)
	}
	lg := must("log.get", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpLogGet, Lines: 50}))
	if lg.Log.File != "lxc.log" {
		t.Errorf("log: %+v", lg.Log)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		ls := must("network.leases", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpNetworkLeases, Network: network}))
		if slices.ContainsFunc(ls.Leases, func(l proto.IncusLease) bool { return l.GuestID == id("wbt-ct1") }) {
			break
		}
		if time.Now().After(deadline) {
			t.Logf("no lease for wbt-ct1 within 30 s (leases: %d)", len(ls.Leases))
			break
		}
		time.Sleep(2 * time.Second)
	}
	if err := d.power(ctx, ct1, proto.ActionForceStop); err != nil {
		t.Fatal(err)
	}

	// A snapshot, a backup kept on the host, restored as a new instance.
	if err := d.snapshotCreate(ctx, ct1, "snap0", "before the test", false); err != nil {
		t.Fatal(err)
	}
	must("backup.create", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpBackupCreate, Name: "b1", Compression: "zstd"}))
	bl := must("backup.list", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpBackupList}))
	if len(bl.Backups) != 1 || bl.Backups[0].Volume != "b1" || bl.Backups[0].ExpiresAt == nil {
		t.Fatalf("backups: %+v", bl.Backups)
	}
	r = must("backup.restore", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpBackupRestore, Volume: "b1"}))
	if r.NewID != id("wbt-ct1-restored") || r.TaskStatus.NewID != id("wbt-ct1-restored") {
		t.Fatalf("restore: %+v %+v", r, r.TaskStatus)
	}
	if _, _, err := root.UseProject(realProject).GetInstance("wbt-ct1-restored"); err != nil {
		t.Fatalf("restored instance: %v", err)
	}

	// Rename the copy, then a copy of the copy into the same project.
	r = must("rename", d.manage(ctx, incusGuestOf(id("wbt-ct1-restored"), "container"), proto.ManageRequest{Op: proto.OpRename, Name: "wbt-ct2"}))
	if r.NewID != id("wbt-ct2") {
		t.Fatalf("rename: %+v", r)
	}
	must("clone", d.manage(ctx, incusGuestOf(id("wbt-ct2"), "container"), proto.ManageRequest{Op: proto.OpClone, Name: "wbt-ct3", InstanceOnly: true}))

	// An image of the snapshot, in the project's own image store.
	r = must("publish", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpPublish, Snapshot: "snap0", Alias: "wbt-image", Description: "Whombat test image"}))
	fp := r.TaskStatus.NewID
	if len(fp) != 64 {
		t.Fatalf("publish: no fingerprint: %+v", r.TaskStatus)
	}
	dl := must("image.download", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDownload, Alias: "alpine/3.22", ImageType: "container", Project: realProject}))
	if len(dl.TaskStatus.NewID) != 64 {
		t.Errorf("download: no fingerprint: %+v", dl.TaskStatus)
	} else {
		must("image.refresh", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageRefresh, Fingerprint: dl.TaskStatus.NewID, Project: realProject}))
	}
	must("image.delete", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpImageDelete, Fingerprint: fp[:12], Project: realProject}))

	// Profiles of the project.
	must("profile.create", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileCreate, Name: "wbt-prof", Description: "Test", Project: realProject}))
	pg := must("profile.get", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileGet, Profile: "wbt-prof", Project: realProject}))
	r = must("profile.update", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileUpdate, Profile: "wbt-prof", Project: realProject,
		Digest: pg.Profile.Digest, Set: map[string]string{"limits.cpu": "2"}}))
	if len(r.Changes) != 1 {
		t.Errorf("profile.update: %+v", r.Changes)
	}
	r = must("config.set profiles", d.manage(ctx, incusGuestOf(id("wbt-ct2"), "container"), proto.ManageRequest{Op: proto.OpConfigSet,
		Profiles: []string{"default", "wbt-prof"}}))
	if r := d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "wbt-prof", Project: realProject}); r.Code != proto.CodeInUse {
		t.Errorf("delete a used profile: %+v", r)
	}
	must("config.set profiles back", d.manage(ctx, incusGuestOf(id("wbt-ct2"), "container"), proto.ManageRequest{Op: proto.OpConfigSet,
		Profiles: []string{"default"}}))
	must("profile.delete", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpProfileDelete, Profile: "wbt-prof", Project: realProject}))

	// A custom volume: create, grow, delete.
	must("volume.create", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: pool, Name: "wbt-vol", Size: "1GiB", Project: realProject}))
	r = must("volume.resize", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeResize, Pool: pool, Volume: "wbt-vol", Size: "2GiB", Project: realProject}))
	if len(r.Changes) != 1 || r.Changes[0].New != "2GiB" {
		t.Errorf("volume.resize: %+v", r.Changes)
	}
	must("volume.delete", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: pool, Volume: "wbt-vol", Project: realProject}))

	// Tasks, a backup deletion, deletions.
	tl := must("task.list", d.manage(ctx, nil, proto.ManageRequest{Op: proto.OpTaskList}))
	if len(tl.Tasks) == 0 {
		t.Errorf("task.list is empty")
	}
	must("backup.delete", d.manage(ctx, ct1, proto.ManageRequest{Op: proto.OpBackupDelete, Volume: "b1"}))
	for _, name := range []string{"wbt-ct3", "wbt-ct2", "wbt-ct1"} {
		must("delete "+name, d.manage(ctx, incusGuestOf(id(name), "container"), proto.ManageRequest{Op: proto.OpDelete}))
	}
}

// realWait follows a task until it ends.
func realWait(t *testing.T, d *incusDriver, task string) proto.TaskStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		r := d.manage(context.Background(), nil, proto.ManageRequest{Op: proto.OpTaskStatus, Task: task})
		if !r.OK {
			t.Fatalf("task %s: %s %s", task, r.Code, r.Message)
		}
		if r.TaskStatus.Status != "running" {
			return *r.TaskStatus
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("task %s did not end in 10 minutes", task)
	return proto.TaskStatus{}
}

// realCleanup deletes everything in the test project, then the project.
// It only ever uses the project's own connection.
func realCleanup(t *testing.T, root incus.InstanceServer) {
	t.Helper()
	proj, _, err := root.GetProject(realProject)
	if err != nil {
		return
	}
	// A project without its own images, profiles or volumes would show
	// the default project's through the scoped connection: only what the
	// project keeps itself is deleted.
	own := func(feature string) bool { return proj.Config["features."+feature] == "true" }
	c := root.UseProject(realProject)
	wait := func(op incus.Operation, err error) {
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			err = op.WaitContext(ctx)
			cancel()
		}
		if err != nil {
			t.Logf("cleanup: %v", err)
		}
	}
	if names, err := c.GetInstanceNames(api.InstanceTypeAny); err == nil {
		for _, n := range names {
			if st, _, err := c.GetInstanceState(n); err == nil && strings.EqualFold(st.Status, "running") {
				wait(c.UpdateInstanceState(n, api.InstanceStatePut{Action: "stop", Force: true, Timeout: -1}, ""))
			}
			wait(c.DeleteInstance(n))
		}
	}
	if images, err := c.GetImages(); err == nil && own("images") {
		for _, im := range images {
			if im.Project == realProject {
				wait(c.DeleteImage(im.Fingerprint))
			}
		}
	}
	if pools, err := c.GetStoragePoolNames(); err == nil && own("storage.volumes") {
		for _, p := range pools {
			vols, err := c.GetStoragePoolVolumes(p)
			if err != nil {
				continue
			}
			for _, v := range vols {
				if v.Type == "custom" && v.Project == realProject {
					if err := c.DeleteStoragePoolVolume(p, "custom", v.Name); err != nil {
						t.Logf("cleanup: volume %s: %v", v.Name, err)
					}
				}
			}
		}
	}
	if profiles, err := c.GetProfileNames(); err == nil && own("profiles") {
		for _, p := range profiles {
			if p != "default" {
				if err := c.DeleteProfile(p); err != nil {
					t.Logf("cleanup: profile %s: %v", p, err)
				}
			}
		}
	}
	if err := root.DeleteProject(realProject); err != nil && !api.StatusErrorCheck(err, http.StatusNotFound) {
		t.Errorf("cleanup: project %s: %v", realProject, err)
	}
}
