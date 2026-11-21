package main

import (
	"fmt"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// The assistant's streams (docs/ASSIST.md): a few read-only checks with
// output made up from the fake host, and commands that only echo, so the
// assistant can be tried against a simulated fleet.

var simChecks = []proto.DiagnoseCheck{
	{Name: "system", Description: "Kernel, uptime, OS release, memory and file systems"},
	{Name: "disks", Description: "Block devices and file systems"},
	{Name: "smart", Description: "SMART data of one disk", Args: []proto.DiagnoseArg{{Name: "device", Description: "sda, nvme0n1", Required: true}}},
	{Name: "logs", Description: "The system log", Args: []proto.DiagnoseArg{{Name: "grep", Description: "regular expression"}, {Name: "lines", Description: "at most 2000"}}},
}

func (a *simAgent) diagnose(req proto.DiagnoseRequest) proto.DiagnoseResponse {
	h := a.host
	switch req.Check {
	case proto.DiagnoseList:
		return proto.DiagnoseResponse{Checks: simChecks}
	case "system":
		return proto.DiagnoseResponse{Commands: []string{"uname -a", "uptime"},
			Output: fmt.Sprintf("$ uname -a\nLinux %s %s x86_64 GNU/Linux\n\n$ uptime\n up %s, load average: 0.42, 0.51, 0.48\n(simulated host: %s)\n",
				h.ID, h.Kernel, time.Since(a.start).Round(time.Minute), h.Pretty)}
	case "disks":
		var b strings.Builder
		b.WriteString("$ lsblk\nNAME      SIZE TYPE MODEL\n")
		r := h.Report(time.Now(), 0, "sim")
		for _, d := range r.Disks {
			fmt.Fprintf(&b, "%-9s %4dG disk %s\n", d.Device, d.CapacityBytes>>30, d.Model)
		}
		return proto.DiagnoseResponse{Commands: []string{"lsblk"}, Output: b.String()}
	case "smart":
		dev := req.Args["device"]
		if dev == "" {
			return proto.DiagnoseResponse{Code: "invalid_request", Message: "device is required"}
		}
		return proto.DiagnoseResponse{Commands: []string{"smartctl -x /dev/" + dev},
			Output: "SMART overall-health self-assessment test result: PASSED\n  5 Reallocated_Sector_Ct   0\n197 Current_Pending_Sector  0\n199 UDMA_CRC_Error_Count    0\n(simulated)\n"}
	case "logs":
		lines := []string{
			time.Now().Add(-42*time.Minute).Format(time.RFC3339) + " " + h.ID + " systemd[1]: Started Daily apt download activities.",
			time.Now().Add(-17*time.Minute).Format(time.RFC3339) + " " + h.ID + " kernel: nvme nvme0: I/O 12 QID 3 timeout, aborting",
			time.Now().Add(-3*time.Minute).Format(time.RFC3339) + " " + h.ID + " whombat-agent[812]: report sent",
		}
		if g := req.Args["grep"]; g != "" {
			var keep []string
			for _, l := range lines {
				if strings.Contains(strings.ToLower(l), strings.ToLower(g)) {
					keep = append(keep, l)
				}
			}
			lines = keep
		}
		return proto.DiagnoseResponse{Commands: []string{"journalctl -n 200"}, Output: strings.Join(lines, "\n") + "\n"}
	}
	return proto.DiagnoseResponse{Code: "unsupported", Message: "the simulated host has no check " + req.Check}
}

func (a *simAgent) exec(req proto.ExecRequest) proto.ExecResponse {
	if !a.o.hostShell {
		return proto.ExecResponse{Code: "remote_control_disabled", Message: "host_shell is off in agent.toml (rackoon-sim --host-shell)", ExitCode: -1}
	}
	if resp, ok := a.lastInstall(req); ok {
		return resp
	}
	return proto.ExecResponse{Output: "(simulated host: nothing ran) $ " + req.Command + "\n", DurationMs: 5}
}
