package rules

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// unRAID hints (docs/CONTRACT.md "Hints", IU-08): each has a way out the
// Whombat server maps (start the array, check parity, update plugins,
// archive a notification, update unRAID in its own page).
const (
	HintUnraidArrayStopped = "unraid.array_stopped"
	HintUnraidParityErrors = "unraid.parity_errors"
	HintUnraidParityOld    = "unraid.parity_old"
	HintUnraidDiskErrors   = "unraid.disk_errors"
	HintUnraidPoolFull     = "unraid.pool_full"
	HintUnraidPlugins      = "unraid.plugin_updates"
	HintUnraidNotification = "unraid.notification"
	HintUnraidOSUpdate     = "unraid.os_update"
	// HintDockerUpdate replaces docker.image_updates on unRAID: the
	// containers whose image has an update (unRAID's own check, else the
	// agent's), every name in the detail, comma separated, so each can be
	// offered its Update.
	HintDockerUpdate = "docker.update_available"
)

// Section links of the unRAID server page.
const (
	LinkArray   = "#array"
	LinkPlugins = "#plugins"
)

// unRAID hint thresholds.
const (
	UnraidParityOldDays   = 35.0 // no parity check for this long
	UnraidPoolFullPct     = 90.0 // a pool this full
	UnraidNotificationMax = 5    // notification hints per server (alerts first)
)

// unraidHints are the hints of an unRAID server.
func unraidHints(r *proto.Report, open []Alert, now time.Time) []Hint {
	u := r.Unraid
	if u == nil {
		return nil
	}
	var out []Hint
	a := u.Array
	switch a.State {
	case proto.UnraidArrayStopped:
		out = append(out, Hint{Kind: HintUnraidArrayStopped, Severity: HintWarning, Entity: "raid:unraid", Link: LinkArray,
			Code:  HintUnraidArrayStopped,
			Title: "Array stopped", Detail: "Its shares, containers and VMs are not available until it starts"})
	case proto.UnraidArrayInvalid:
		out = append(out, Hint{Kind: HintUnraidArrayStopped, Severity: HintWarning, Entity: "raid:unraid", Link: LinkArray,
			Code:  HintUnraidArrayStopped + ".invalid",
			Title: "Array stopped", Detail: "Unraid can’t start it as it is set up now: open Unraid’s Main page"})
	}
	p := a.Parity
	if p.State == "idle" && p.Last != nil && p.Last.Errors > 0 && (p.Last.Result == "errors" || p.Last.Result == "ok") {
		out = append(out, Hint{Kind: HintUnraidParityErrors, Severity: HintWarning, Entity: "raid:unraid", Link: LinkArray,
			Code: HintUnraidParityErrors, Params: map[string]any{"count": int64(p.Last.Errors), "checkedAt": p.Last.At.Unix()},
			Title:  "The last parity check found " + plural(int64(p.Last.Errors), "error", "errors"),
			Detail: "Checked " + p.Last.At.UTC().Format("2 Jan 2006") + " · run it again and let it fix them"})
	}
	if p.Disks > 0 && p.State == "idle" && a.State == proto.UnraidArrayStarted {
		var last time.Time
		for _, run := range append([]proto.UnraidParityRun{}, p.History...) {
			if run.Result == "ok" || run.Result == "errors" {
				last = run.At
				break
			}
		}
		if p.Last != nil && (p.Last.Result == "ok" || p.Last.Result == "errors") && p.Last.At.After(last) {
			last = p.Last.At
		}
		switch {
		case last.IsZero():
			out = append(out, Hint{Kind: HintUnraidParityOld, Severity: HintInfo, Entity: "raid:unraid", Link: LinkArray,
				Code:  HintUnraidParityOld + ".never",
				Title: "Parity never checked", Detail: "A monthly check finds disk problems early"})
		case now.Sub(last) > time.Duration(UnraidParityOldDays*24)*time.Hour:
			out = append(out, Hint{Kind: HintUnraidParityOld, Severity: HintInfo, Entity: "raid:unraid", Link: LinkArray,
				Code: HintUnraidParityOld, Params: map[string]any{"checkedAt": last.Unix()},
				Title: "Parity not checked lately", Detail: "Last checked " + last.UTC().Format("2 Jan 2006")})
		}
	}
	var errDisks, errNames, errCounts []string
	disks := append([]proto.UnraidDisk{}, a.Disks...)
	for _, pl := range u.Pools {
		disks = append(disks, pl.Disks...)
	}
	for _, d := range disks {
		if d.Errors > 0 {
			errDisks = append(errDisks, fmt.Sprintf("%s (%s)", d.Name, plural(int64(d.Errors), "error", "errors")))
			errNames = append(errNames, d.Name)
			errCounts = append(errCounts, strconv.FormatUint(d.Errors, 10))
		}
	}
	if len(errDisks) > 0 {
		title := errDisks[0][:strings.IndexByte(errDisks[0], ' ')] + " has read or write errors"
		if len(errDisks) > 1 {
			title = fmt.Sprintf("%d disks have read or write errors", len(errDisks))
		}
		out = append(out, Hint{Kind: HintUnraidDiskErrors, Severity: HintWarning, Entity: "raid:unraid", Link: LinkArray,
			Code: HintUnraidDiskErrors, Params: map[string]any{"count": len(errDisks),
				"names": firstN(errNames, UnhealthyNames), "errorCounts": firstN(errCounts, UnhealthyNames)},
			Title: title, Detail: joinFirst(errDisks, UnhealthyNames)})
	}
	for _, pl := range u.Pools {
		if pl.SizeBytes == 0 || alerted(open, "fs:/mnt/"+pl.Name, RuleSpaceHigh) {
			continue
		}
		pct := float64(pl.UsedBytes) / float64(pl.UsedBytes+pl.FreeBytes) * 100
		if pl.UsedBytes+pl.FreeBytes == 0 || pct < UnraidPoolFullPct-eps {
			continue
		}
		out = append(out, Hint{Kind: HintUnraidPoolFull, Severity: HintWarning, Entity: "pool:" + pl.Name, Link: LinkArray,
			Code: HintUnraidPoolFull, Params: map[string]any{"name": pl.Name, "pct": pct, "freeGB": float64(pl.FreeBytes) / GB},
			Title:  fmt.Sprintf("Storage “%s” %s%% full", pl.Name, pct0(pct)),
			Detail: FormatStorageGB(float64(pl.FreeBytes)/1e9) + " free"})
	}
	var updates []string
	for _, pl := range u.Plugins {
		if pl.Update != "" {
			updates = append(updates, pl.Name)
		}
	}
	if len(updates) > 0 {
		out = append(out, Hint{Kind: HintUnraidPlugins, Severity: HintInfo, Entity: "unraid", Link: LinkPlugins,
			Code: HintUnraidPlugins, Params: map[string]any{"count": len(updates), "names": firstN(updates, UnhealthyNames)},
			Title: plural(int64(len(updates)), "plugin update", "plugin updates"), Detail: joinFirst(updates, UnhealthyNames)})
	}
	n := 0
	for _, imp := range []string{"alert", "warning"} {
		for _, x := range u.Notifications {
			if x.Importance != imp || n >= UnraidNotificationMax {
				continue
			}
			n++
			sev := HintInfo
			if imp == "alert" {
				sev = HintWarning
			}
			title := x.Subject
			if title == "" {
				title = x.Event
			}
			title, detail := truncateRunes(title, 120), truncateRunes(x.Description, 300)
			out = append(out, Hint{Kind: HintUnraidNotification, Severity: sev, Entity: x.ID, Link: LinkArray,
				Title: title, Detail: detail, Code: HintUnraidNotification, Params: map[string]any{"subject": title, "description": detail}})
		}
	}
	if r.Docker != nil {
		var names []string
		for _, g := range r.Docker.Guests {
			if g.UpdateAvailable != nil && *g.UpdateAvailable {
				names = append(names, orDefault(g.Name, g.ID))
			}
		}
		if n := len(names); n > 0 {
			title := fmt.Sprintf("%d apps have an update", n)
			if n == 1 {
				title = "1 app has an update"
			}
			out = append(out, Hint{Kind: HintDockerUpdate, Severity: HintInfo, Entity: "docker", Link: LinkGuests,
				Code: HintDockerUpdate, Params: map[string]any{"count": n, "names": firstN(names, 50)},
				Title: title, Detail: strings.Join(firstN(names, 50), ", ")})
		}
	}
	if u.OSUpdate != "" {
		out = append(out, Hint{Kind: HintUnraidOSUpdate, Severity: HintInfo, Entity: "unraid", Link: LinkPlugins,
			Code: HintUnraidOSUpdate, Params: map[string]any{"version": u.OSUpdate},
			Title: "Unraid " + u.OSUpdate + " has come out", Detail: "Install it on Unraid’s own page; it restarts the server"})
	}
	return out
}

func joinFirst(l []string, n int) string {
	d := strings.Join(firstN(l, n), ", ")
	if len(l) > n {
		d += ", …"
	}
	return d
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
