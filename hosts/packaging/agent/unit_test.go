package agentpkg

import (
	"strings"
	"testing"
)

func TestUnitResourceLimits(t *testing.T) {
	u := Unit("/usr/local/bin/whombat-agent")
	for _, want := range []string{
		"ExecStart=/usr/local/bin/whombat-agent run",
		"MemoryHigh=256M", "MemoryMax=512M", "TasksMax=512", "Nice=5",
		"IOSchedulingClass=best-effort", "IOSchedulingPriority=7", "CPUWeight=50",
		"CapabilityBoundingSet=~CAP_SYS_TIME", "ProtectSystem=strict", "Type=exec",
	} {
		if !strings.Contains(u, want+"\n") && !strings.Contains(u, want+" ") {
			t.Errorf("unit lacks %q", want)
		}
	}
	// adjtimex() must stay callable (time synchronisation status).
	for _, line := range strings.Split(u, "\n") {
		if strings.HasPrefix(line, "ProtectClock=") || strings.HasPrefix(line, "SystemCallFilter=") {
			t.Errorf("unit blocks adjtimex: %s", line)
		}
	}
}
