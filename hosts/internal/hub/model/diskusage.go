package model

import (
	"sort"
	"time"

	"rackoon/internal/proto"
)

// DiskUsageRecentWindow is how long an on-request disk breakdown stays shown on
// GET /servers/{id}. Older measurements are omitted so the server page falls
// back to its usual view instead of presenting stale figures.
const DiskUsageRecentWindow = 24 * time.Hour

// DiskUsageCategory is one recognised bucket in a disk usage breakdown.
type DiskUsageCategory struct {
	Key              string `json:"key"`
	Label            string `json:"label"`
	Bytes            uint64 `json:"bytes"`
	ReclaimableBytes uint64 `json:"reclaimable_bytes,omitempty"`
	Detail           string `json:"detail,omitempty"`
}

// DiskUsageFolder is one large directory in a disk usage breakdown.
type DiskUsageFolder struct {
	Path    string `json:"path"`
	Bytes   uint64 `json:"bytes"`
	Partial bool   `json:"partial,omitempty"`
}

// DiskUsage is one on-request breakdown of what fills a mounted filesystem.
type DiskUsage struct {
	Mount           string              `json:"mount"`
	FSType          string              `json:"fs_type,omitempty"`
	Device          string              `json:"device,omitempty"`
	MeasuredAt      Time                `json:"measured_at"`
	DurationMs      int64               `json:"duration_ms,omitempty"`
	TotalBytes      uint64              `json:"total_bytes"`
	UsedBytes       uint64              `json:"used_bytes"`
	Partial         bool                `json:"partial,omitempty"`
	SkippedSpunDown []string            `json:"skipped_spun_down,omitempty"`
	Categories      []DiskUsageCategory `json:"categories"`
	Folders         []DiskUsageFolder   `json:"folders"`
}

// BuildDiskUsage converts an agent disk usage response into the JSON model.
func BuildDiskUsage(r proto.DiskUsageResponse) DiskUsage {
	cats := make([]DiskUsageCategory, 0, len(r.Categories))
	for _, c := range r.Categories {
		cats = append(cats, DiskUsageCategory{
			Key:              c.Key,
			Label:            c.Label,
			Bytes:            c.Bytes,
			ReclaimableBytes: c.ReclaimableBytes,
			Detail:           c.Detail,
		})
	}
	folders := make([]DiskUsageFolder, 0, len(r.Folders))
	for _, f := range r.Folders {
		folders = append(folders, DiskUsageFolder{
			Path:    f.Path,
			Bytes:   f.Bytes,
			Partial: f.Partial,
		})
	}
	out := DiskUsage{
		Mount:      r.Mount,
		FSType:     r.FSType,
		Device:     r.Device,
		MeasuredAt: Time(r.MeasuredAt),
		DurationMs: r.DurationMs,
		TotalBytes: r.TotalBytes,
		UsedBytes:  r.UsedBytes,
		Partial:    r.Partial,
		Categories: cats,
		Folders:    folders,
	}
	if len(r.SkippedSpunDown) > 0 {
		out.SkippedSpunDown = append([]string(nil), r.SkippedSpunDown...)
	}
	return out
}

// BuildRecentDiskUsage returns all stored breakdowns measured within
// DiskUsageRecentWindow of now, newest first.
func BuildRecentDiskUsage(stored map[string]proto.DiskUsageResponse, now time.Time) []DiskUsage {
	if len(stored) == 0 {
		return nil
	}
	var out []DiskUsage
	for _, r := range stored {
		if r.Code != "" || r.Mount == "" || r.MeasuredAt.IsZero() {
			continue
		}
		if age := now.Sub(r.MeasuredAt); age > DiskUsageRecentWindow || age < -time.Hour {
			continue
		}
		out = append(out, BuildDiskUsage(r))
	}
	sort.Slice(out, func(i, j int) bool {
		ti, tj := time.Time(out[i].MeasuredAt), time.Time(out[j].MeasuredAt)
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return out[i].Mount < out[j].Mount
	})
	return out
}
