package wall

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/vaultwall/internal/networks"
)

// Sets names the two interval sets in the egress table (IN-60): `ipv4_addr . inet_service` and
// `ipv6_addr . inet_service`.
type Sets struct {
	// Table is "<family> <name>", e.g. "inet whombat-egress".
	Table      string
	Set4, Set6 string
}

// Script is one nft transaction that replaces both sets' elements: `nft -f` applies all of it or nothing, so
// no packet ever sees a half-written list.
func (s Sets) Script(v4, v6 []networks.Element) string {
	var b strings.Builder
	fmt.Fprintf(&b, "flush set %s %s\n", s.Table, s.Set4)
	fmt.Fprintf(&b, "flush set %s %s\n", s.Table, s.Set6)
	add := func(set string, es []networks.Element) {
		if len(es) == 0 {
			return
		}
		fmt.Fprintf(&b, "add element %s %s {", s.Table, set)
		for i, e := range es {
			if i > 0 {
				b.WriteString(",")
			}
			addr := e.Prefix.String()
			if e.Prefix.IsSingleIP() {
				addr = e.Prefix.Addr().String()
			}
			fmt.Fprintf(&b, "\n  %s . %d", addr, e.Port)
		}
		b.WriteString("\n}\n")
	}
	add(s.Set4, v4)
	add(s.Set6, v6)
	return b.String()
}

// NFT applies a script with the nft binary (`nft -f -`).
type NFT struct {
	Path    string
	Timeout time.Duration
}

// Apply runs one transaction.
func (n NFT) Apply(script string) error {
	timeout := n.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, n.Path, "-f", "-")
	cmd.Stdin = strings.NewReader(script)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(out.String())
		if len(msg) > 2000 {
			msg = msg[:2000] + "…"
		}
		return fmt.Errorf("nft: %v: %s", err, msg)
	}
	return nil
}
