package hub

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

func TestDiskUsageHeadlessAndPersistence(t *testing.T) {
	now := time.Date(2026, 11, 21, 18, 0, 0, 0, time.UTC)
	var clock atomic.Pointer[time.Time]
	clock.Store(&now)
	e := headlessEnv(t, func(c *Config) {
		c.Now = func() time.Time { return *clock.Load() }
	})
	svc := e.service("pe_1|John")

	ag := e.enroll(svc, "srv-disk", "")
	ag.policy = proto.Policy{Diagnose: true}
	if code, err := ag.dial(proto.Hello{MachineID: "mid-disk"}); err != nil || code != 101 {
		t.Fatalf("dial: %d %v", code, err)
	}
	rep := &proto.Report{
		At: now, Seq: 1, Policy: proto.Policy{Diagnose: true},
		Host: proto.HostInfo{Hostname: "srv-disk", OSName: "Debian"},
		Filesystems: []proto.Filesystem{
			{Mount: "/", Device: "/dev/nvme0n1p2", FSType: "ext4", SizeBytes: 200 << 30, UsedBytes: 80 << 30},
			{Mount: "/var/lib/docker", Device: "/dev/nvme0n1p3", FSType: "ext4", SizeBytes: 100 << 30, UsedBytes: 92 << 30},
		},
	}
	ag.send(proto.MsgReport, rep)
	waitFor(t, "report", 5*time.Second, func() bool {
		st, ok := e.h.snapshotOne("srv-disk")
		return ok && st.Report != nil && st.Report.Seq >= 1
	})

	ag.mu.Lock()
	ag.diskUsageAnswer = func(req proto.DiskUsageRequest) proto.DiskUsageResponse {
		return proto.DiskUsageResponse{
			Mount:      req.Mount,
			FSType:     "ext4",
			Device:     "/dev/nvme0n1p3",
			MeasuredAt: now,
			DurationMs: 250,
			TotalBytes: 100 << 30,
			UsedBytes:  92 << 30,
			Categories: []proto.DiskUsageCategory{
				{Key: proto.DiskCatContainerImages, Label: "Container images", Bytes: 32 << 30, ReclaimableBytes: 8 << 30, Detail: "9 images, 2 unused"},
				{Key: proto.DiskCatContainerBuildCache, Label: "Container build cache", Bytes: 14 << 30, ReclaimableBytes: 14 << 30},
			},
			Folders: []proto.DiskUsageFolder{
				{Path: "/var/lib/docker/overlay2", Bytes: 46 << 30},
			},
		}
	}
	ag.mu.Unlock()

	// Viewer cannot trigger a measurement (needs operator).
	if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/srv-disk/disk-usage", map[string]any{}, map[string]string{HeaderRole: "viewer"}); code != 403 {
		t.Fatalf("viewer POST disk-usage: %d, want 403", code)
	}

	// Operator without mount picks the fullest local filesystem (/var/lib/docker at 92%).
	var res map[string]any
	svc.json(http.MethodPost, "/api/v1/servers/srv-disk/disk-usage", map[string]any{}, 200, &res)
	if res["ok"] != true || res["mount"] != "/var/lib/docker" {
		t.Fatalf("POST disk-usage = %v", res)
	}

	// GET /servers/{id} now includes disk_usage while recent.
	type diskUsageJSON struct {
		Mount      string                    `json:"mount"`
		MeasuredAt string                    `json:"measured_at"`
		Categories []model.DiskUsageCategory `json:"categories"`
		Folders    []model.DiskUsageFolder   `json:"folders"`
	}
	var detail struct {
		DiskUsage []diskUsageJSON `json:"disk_usage"`
	}
	svc.json(http.MethodGet, "/api/v1/servers/srv-disk", nil, 200, &detail)
	if len(detail.DiskUsage) != 1 || detail.DiskUsage[0].Mount != "/var/lib/docker" || len(detail.DiskUsage[0].Categories) != 2 || detail.DiskUsage[0].MeasuredAt == "" {
		t.Fatalf("detail.disk_usage = %+v", detail.DiskUsage)
	}

	// Audit log recorded disk_usage.ran.
	if recs := e.audit("disk_usage.ran"); len(recs) != 1 || recs[0].Server != "srv-disk" || recs[0].Outcome != "ok" {
		t.Fatalf("audit = %+v", recs)
	}

	// Spun-down answer returns 200 ok:false without overwriting the stored breakdown.
	ag.mu.Lock()
	ag.diskUsageAnswer = func(req proto.DiskUsageRequest) proto.DiskUsageResponse {
		return proto.DiskUsageResponse{
			Code:            "spun_down",
			Message:         "Skipped /var/lib/docker because sda is spun down.",
			Mount:           req.Mount,
			MeasuredAt:      now.Add(time.Minute),
			SkippedSpunDown: []string{"sda"},
		}
	}
	ag.mu.Unlock()
	var spun map[string]any
	svc.json(http.MethodPost, "/api/v1/servers/srv-disk/disk-usage", map[string]any{"mount": "/var/lib/docker"}, 200, &spun)
	if spun["ok"] != false || spun["code"] != "spun_down" {
		t.Fatalf("spun_down = %v", spun)
	}
	detail.DiskUsage = nil
	svc.json(http.MethodGet, "/api/v1/servers/srv-disk", nil, 200, &detail)
	if len(detail.DiskUsage) != 1 || len(detail.DiskUsage[0].Categories) != 2 {
		t.Fatalf("spun_down overwrote stored breakdown: %+v", detail.DiskUsage)
	}

	// Hub diagnose switch off blocks requests with 403.
	off := false
	svc.json(http.MethodPatch, "/api/v1/servers/srv-disk", map[string]any{"remote_control": map[string]any{"diagnose": off}}, 200, nil)
	if code, _, _ := svc.req(http.MethodPost, "/api/v1/servers/srv-disk/disk-usage", map[string]any{"mount": "/"}, nil); code != 403 {
		t.Fatalf("diagnose off: %d, want 403", code)
	}

	// Reloading from SQLite restores the persisted breakdown.
	e.h.persist(context.Background(), true)
	if err := e.h.load(context.Background()); err != nil {
		t.Fatalf("reload: %v", err)
	}
	var list struct {
		Items []diskUsageJSON `json:"items"`
	}
	svc.json(http.MethodGet, "/api/v1/servers/srv-disk/disk-usage", nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].Mount != "/var/lib/docker" {
		t.Fatalf("after reload: %+v", list.Items)
	}

	// Once older than 24h, GET /servers/{id} omits the stale breakdown.
	later := now.Add(model.DiskUsageRecentWindow + time.Minute)
	clock.Store(&later)
	detail.DiskUsage = nil
	svc.json(http.MethodGet, "/api/v1/servers/srv-disk", nil, 200, &detail)
	if len(detail.DiskUsage) != 0 {
		t.Fatalf("stale breakdown still included: %+v", detail.DiskUsage)
	}
}
