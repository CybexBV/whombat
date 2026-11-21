package inspect

import (
	"bufio"
	"context"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// MaxPorts bounds the socket list.
const MaxPorts = 500

// Effort bounds for mapping socket inodes to processes.
const (
	fdScanBudget = 2 * time.Second
	fdScanMax    = 500000
)

// TCP states in /proc/net/tcp*.
const (
	tcpListen = "0A"
	tcpClose  = "07" // unconnected UDP sockets are reported in this state
)

// PortOptions configures Ports.
type PortOptions struct {
	Root  string // procfs mount, default "/proc"
	Limit int    // rows, default and at most MaxPorts
}

type socketRow struct {
	port  proto.ListenPort
	inode string
}

// Ports returns listening TCP sockets and bound, unconnected UDP sockets
// of the host's network namespace with the process owning each (when it
// can be found within the scan budget).
func Ports(ctx context.Context, opts PortOptions) (rows []proto.ListenPort, truncated bool, err error) {
	root := opts.Root
	if root == "" {
		root = "/proc"
	}
	limit := opts.Limit
	if limit <= 0 || limit > MaxPorts {
		limit = MaxPorts
	}
	var socks []socketRow
	var firstErr error
	read := 0
	for _, kind := range []string{"tcp", "tcp6", "udp", "udp6"} {
		rs, err := parseNetFile(filepath.Join(root, "net", kind), kind)
		if err != nil {
			if firstErr == nil && !os.IsNotExist(err) {
				firstErr = err
			}
			continue
		}
		read++
		socks = append(socks, rs...)
	}
	if read == 0 {
		if firstErr == nil {
			firstErr = os.ErrNotExist
		}
		return nil, false, firstErr
	}
	want := make(map[string]bool, len(socks))
	for _, s := range socks {
		want[s.inode] = true
	}
	owners := socketOwners(ctx, root, want)
	seen := map[string]bool{}
	for _, s := range socks {
		if o, ok := owners[s.inode]; ok {
			s.port.PID, s.port.Process = o.pid, o.name
		}
		key := s.port.Proto + "|" + s.port.Address + "|" + strconv.Itoa(s.port.Port) + "|" + strconv.Itoa(s.port.PID)
		if seen[key] {
			continue // SO_REUSEPORT groups
		}
		seen[key] = true
		rows = append(rows, s.port)
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Port != b.Port {
			return a.Port < b.Port
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		if a.Address != b.Address {
			return a.Address < b.Address
		}
		return a.PID < b.PID
	})
	if len(rows) > limit {
		rows, truncated = rows[:limit], true
	}
	return rows, truncated, nil
}

// parseNetFile reads /proc/net/{tcp,tcp6,udp,udp6}.
func parseNetFile(path, kind string) ([]socketRow, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	udp := strings.HasPrefix(kind, "udp")
	var out []socketRow
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	header := true
	for sc.Scan() {
		if header {
			header = false
			continue
		}
		// sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		st := fields[3]
		if (!udp && st != tcpListen) || (udp && st != tcpClose) {
			continue
		}
		addr, port, ok := parseHexAddr(fields[1])
		if !ok || port == 0 {
			continue
		}
		out = append(out, socketRow{
			port:  proto.ListenPort{Proto: kind, Address: addr, Port: port},
			inode: fields[9],
		})
	}
	return out, sc.Err()
}

// parseHexAddr decodes "0100007F:0035" (IPv4, little-endian words) or the
// 32-digit IPv6 form.
func parseHexAddr(s string) (string, int, bool) {
	h, p, ok := strings.Cut(s, ":")
	if !ok {
		return "", 0, false
	}
	port, err := strconv.ParseUint(p, 16, 16)
	if err != nil {
		return "", 0, false
	}
	b, err := hex.DecodeString(h)
	if err != nil || (len(b) != 4 && len(b) != 16) {
		return "", 0, false
	}
	// Each 32-bit word is in host (little-endian) byte order.
	for i := 0; i < len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	return net.IP(b).String(), int(port), true
}

type owner struct {
	pid  int
	name string
}

// socketOwners walks /proc/<pid>/fd for the wanted socket inodes, within a
// time and file-descriptor budget; unreadable processes are skipped.
func socketOwners(ctx context.Context, root string, want map[string]bool) map[string]owner {
	out := map[string]owner{}
	if len(want) == 0 {
		return out
	}
	ents, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	deadline := time.Now().Add(fdScanBudget)
	scanned := 0
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		if ctx.Err() != nil || time.Now().After(deadline) || scanned > fdScanMax || len(out) == len(want) {
			break
		}
		fdDir := filepath.Join(root, e.Name(), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		var name string
		for _, fd := range fds {
			scanned++
			link, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			ino, ok := strings.CutPrefix(link, "socket:[")
			if !ok {
				continue
			}
			ino = strings.TrimSuffix(ino, "]")
			if !want[ino] {
				continue
			}
			if _, have := out[ino]; have {
				continue
			}
			if name == "" {
				b, _ := os.ReadFile(filepath.Join(root, e.Name(), "comm"))
				name = strings.TrimSpace(string(b))
			}
			out[ino] = owner{pid: pid, name: name}
		}
	}
	return out
}
