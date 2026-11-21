package devtuf

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// ParseClientFloor parses a client security floor (CT-53) written as `platform=build,…`, for example
// `android=4021,web=120`. Platforms are web, android, ios, desktop and cli; an unlisted platform has no floor
// (0). An empty string is no floor at all (nil).
func ParseClientFloor(s string) (*release.ClientFloor, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	var f release.ClientFloor
	slots := map[string]*int64{"web": &f.Web, "android": &f.Android, "ios": &f.Ios, "desktop": &f.Desktop, "cli": &f.Cli}
	seen := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		slot := slots[name]
		if !ok || slot == nil {
			return nil, fmt.Errorf("client floor %q: want platform=build with platform web|android|ios|desktop|cli", part)
		}
		if seen[name] {
			return nil, fmt.Errorf("client floor: %s given twice", name)
		}
		seen[name] = true
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 0 || n > 1<<31-1 {
			return nil, fmt.Errorf("client floor %s=%q: want a build number 0…2147483647", name, value)
		}
		*slot = n
	}
	return &f, nil
}
