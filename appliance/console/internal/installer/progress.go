package installer

import (
	"strconv"
	"strings"
)

// The install steps of CG-12, in order, and the share of the whole each one gets on the progress bar: copying
// the system is most of the time; partitioning, file systems, the boot loader and the recovery environment, and
// unmounting are short.
var Steps = []string{"partition", "filesystems", "copy", "boot", "finish"}

var stepSpan = map[string][2]int{
	"partition":   {0, 3},
	"filesystems": {3, 6},
	"copy":        {6, 90},
	"boot":        {90, 98},
	"finish":      {98, 100},
}

// ProgressPrefix starts whombat-install's machine-readable lines: `@@progress <step> <percent>` (CG-12, NX-81).
const ProgressPrefix = "@@progress "

// ParseProgress reads one line of whombat-install. A progress line gives its step and the step's own percentage
// (0–100); before is whatever preceded the marker on the same line (the human log can share a line with it when
// two writers race), "" usually. ok is false for every other line.
func ParseProgress(line string) (step string, percent int, before string, ok bool) {
	i := strings.Index(line, ProgressPrefix)
	if i < 0 {
		return "", 0, "", false
	}
	f := strings.Fields(line[i+len(ProgressPrefix):])
	if len(f) != 2 {
		return "", 0, "", false
	}
	if _, known := stepSpan[f[0]]; !known {
		return "", 0, "", false
	}
	p, err := strconv.Atoi(f[1])
	if err != nil || p < 0 || p > 100 {
		return "", 0, "", false
	}
	return f[0], p, line[:i], true
}

// Overall is the whole install's percentage at step's own percent.
func Overall(step string, percent int) int {
	s, ok := stepSpan[step]
	if !ok {
		return 0
	}
	return s[0] + (s[1]-s[0])*min(max(percent, 0), 100)/100
}
