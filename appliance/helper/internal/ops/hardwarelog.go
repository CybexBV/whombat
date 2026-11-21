package ops

// The hardware report's kernel lines (Whombat HD-03; MG-114): read-only, outside the operation lock.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/kernlog"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// hardwareLogTimeout bounds reading the boot's kernel messages.
const hardwareLogTimeout = 10 * time.Second

// Bounds on what journalctl may hand over: a boot's kernel messages are a few thousand; a box whose kernel logs a
// line a second for months stops here (the boot's first messages, where drivers and firmware load, are read).
const (
	kernelLogMaxBytes   = 64 << 20
	kernelLogMaxEntries = 200_000
)

// hardwareLog is hardware-log: the firmware and driver error lines of this boot's kernel messages (kernlog.Select).
func (h *Helper) hardwareLog(ctx context.Context) (*proto.Result, *proto.Error) {
	read := h.cfg.KernelMessages
	if read == nil {
		read = journalKernelMessages
	}
	ctx, cancel := context.WithTimeout(ctx, hardwareLogTimeout)
	defer cancel()
	entries, err := read(ctx)
	if err != nil {
		return nil, fail(proto.CodeInternal, "kernel messages: %v", err)
	}
	return &proto.Result{KernelLog: kernlog.Select(entries)}, nil
}

// journalctl is found on the unit's PATH (NixOS puts systemd there), else in the system profile.
func journalctl() string {
	if p, err := exec.LookPath("journalctl"); err == nil {
		return p
	}
	return "/run/current-system/sw/bin/journalctl"
}

// journalKernelMessages reads this boot's kernel messages from the journal (the helper's sandbox hides /dev/kmsg:
// ProtectKernelLogs), oldest first, with their priority.
func journalKernelMessages(ctx context.Context) ([]kernlog.Entry, error) {
	cmd := exec.CommandContext(ctx, journalctl(), "--dmesg", "--boot=0", "--output=json",
		"--output-fields=MESSAGE,PRIORITY", "--no-pager", "--quiet")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	entries, full := parseJournal(io.LimitReader(out, kernelLogMaxBytes), kernelLogMaxEntries)
	if full {
		_ = cmd.Process.Kill()
	}
	_, _ = io.Copy(io.Discard, out)
	if err := cmd.Wait(); err != nil && !full {
		return nil, fmt.Errorf("journalctl: %v: %s", err, bytes.TrimSpace(stderr.Bytes()))
	}
	return entries, nil
}

// parseJournal reads journalctl's JSON lines: MESSAGE a string (or, not UTF-8, an array of bytes; null when too
// long), PRIORITY a decimal string. At most max entries (full: it stopped there); an unreadable or truncated line ends
// the list or is skipped.
func parseJournal(r io.Reader, max int) (out []kernlog.Entry, full bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		if len(out) == max {
			return out, true
		}
		var e struct {
			Message  json.RawMessage `json:"MESSAGE"`
			Priority string          `json:"PRIORITY"`
		}
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		msg := ""
		switch {
		case len(e.Message) > 0 && e.Message[0] == '"':
			_ = json.Unmarshal(e.Message, &msg)
		case len(e.Message) > 0 && e.Message[0] == '[':
			var b []int
			if json.Unmarshal(e.Message, &b) == nil {
				bs := make([]byte, 0, len(b))
				for _, c := range b {
					bs = append(bs, byte(c))
				}
				msg = string(bs)
			}
		}
		if msg == "" {
			continue
		}
		p, err := strconv.Atoi(e.Priority)
		if err != nil {
			p = -1
		}
		out = append(out, kernlog.Entry{Message: msg, Priority: p})
	}
	return out, false
}
