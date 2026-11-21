package macos

import (
	"context"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// ---- launchd -------------------------------------------------------------------------

// ParseLaunchctlList reads `launchctl list` (PID, last exit status, label)
// as the inspect view's services: running jobs are active; a job that
// isn't running is failed when its last exit was not clean (a negative
// status is the signal that ended it).
func ParseLaunchctlList(b []byte) []proto.Service {
	out := []proto.Service{}
	for i, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || (i == 0 && f[0] == "PID") {
			continue
		}
		label := strings.Join(f[2:], " ")
		if len(label) > 256 {
			continue
		}
		s := proto.Service{Name: label, Load: "loaded"}
		status, serr := strconv.Atoi(f[1])
		switch {
		case f[0] != "-":
			s.Active, s.Sub = "active", "running"
			s.Description = "pid " + f[0]
		case serr == nil && status != 0:
			s.Active, s.Sub = "failed", "failed"
			if status < 0 {
				s.Description = "ended by signal " + strconv.Itoa(-status)
			} else {
				s.Description = "last exit status " + strconv.Itoa(status)
			}
		default:
			s.Active, s.Sub = "inactive", "exited"
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := serviceRank(out[i].Active), serviceRank(out[j].Active)
		if ri != rj {
			return ri < rj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func serviceRank(active string) int {
	switch active {
	case "failed":
		return 0
	case "active":
		return 1
	}
	return 2
}

// Services lists the system domain's launchd jobs.
func Services(ctx context.Context) ([]proto.Service, error) {
	out, err := Run(ctx, 20*time.Second, Launchctl, "list")
	if err != nil {
		return nil, err
	}
	return ParseLaunchctlList(out), nil
}

// ---- processes ---------------------------------------------------------------------------

// PsArgs is the process list's ps call: pid, ppid, user, %cpu, rss (KiB),
// state, start time (five words), command line.
var PsArgs = []string{"-axww", "-o", "pid=,ppid=,user=,pcpu=,rss=,state=,lstart=,args="}

// PsNameArgs names every process by its executable (`ps -c`).
var PsNameArgs = []string{"-axc", "-o", "pid=,comm="}

// ParsePs reads the two ps calls into processes, by CPU then memory.
func ParsePs(list, names []byte, loc *time.Location) []proto.Process {
	if loc == nil {
		loc = time.Local
	}
	nameOf := map[int]string{}
	for _, line := range strings.Split(string(names), "\n") {
		t := strings.TrimSpace(line)
		p, n, ok := strings.Cut(t, " ")
		if !ok {
			continue
		}
		if pid, err := strconv.Atoi(p); err == nil {
			nameOf[pid] = strings.TrimSpace(n)
		}
	}
	var out []proto.Process
	for _, line := range strings.Split(string(list), "\n") {
		f := strings.Fields(line)
		if len(f) < 12 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		cpu, err3 := strconv.ParseFloat(f[3], 64)
		rss, err4 := strconv.ParseUint(f[4], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			continue
		}
		p := proto.Process{PID: pid, PPID: ppid, User: clip(f[2], 64), CPUPct: cpu, RSSBytes: rss * 1024, State: psState(f[5])}
		if t, err := time.ParseInLocation("Mon Jan 2 15:04:05 2006", strings.Join(f[6:11], " "), loc); err == nil {
			p.Started = t.UTC()
		}
		// The command line is what follows the start time; keep its
		// spacing.
		cmd := strings.TrimSpace(afterFields(line, 11))
		p.Command = clipRunes(cmd, 512)
		p.Name = nameOf[pid]
		if p.Name == "" {
			p.Name = cmd
			if i := strings.IndexByte(p.Name, ' '); i > 0 {
				p.Name = p.Name[:i]
			}
			p.Name = p.Name[strings.LastIndexByte(p.Name, '/')+1:]
		}
		p.Name = clipRunes(p.Name, 64)
		out = append(out, p)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CPUPct != out[j].CPUPct {
			return out[i].CPUPct > out[j].CPUPct
		}
		return out[i].RSSBytes > out[j].RSSBytes
	})
	return out
}

// psState maps BSD ps states to Linux's letters (R S D Z T I).
func psState(s string) string {
	if s == "" {
		return "S"
	}
	switch s[0] {
	case 'R':
		return "R"
	case 'U':
		return "D" // uninterruptible wait
	case 'Z':
		return "Z"
	case 'T':
		return "T"
	case 'I':
		return "I" // idle: asleep more than 20 s
	}
	return "S"
}

// afterFields returns s after its first n whitespace-separated fields.
func afterFields(s string, n int) string {
	i := 0
	for k := 0; k < n; k++ {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		for i < len(s) && s[i] != ' ' && s[i] != '\t' {
			i++
		}
	}
	return s[i:]
}

func clipRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for len(s) > 0 && s[len(s)-1]&0xC0 == 0x80 {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] >= 0xC0 {
		s = s[:len(s)-1]
	}
	return s
}

// Processes lists the processes (two ps calls).
func Processes(ctx context.Context) ([]proto.Process, error) {
	list, err := Run(ctx, 20*time.Second, append([]string{Ps}, PsArgs...)...)
	if err != nil {
		return nil, err
	}
	names, _ := Run(ctx, 20*time.Second, append([]string{Ps}, PsNameArgs...)...)
	return ParsePs(list, names, time.Local), nil
}

// ---- listening sockets -------------------------------------------------------------------

// LsofTCPArgs and LsofUDPArgs list listening TCP and bound UDP sockets in
// lsof's field form (process, command, protocol, type, name).
var (
	LsofTCPArgs = []string{"-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-FpcPtn"}
	LsofUDPArgs = []string{"-nP", "-w", "-iUDP", "-FpcPtn"}
)

// ParseLsof reads lsof's field output: p<pid>, c<command>, then per file
// t<IPv4|IPv6>, P<TCP|UDP>, n<address:port>. Connected UDP sockets
// ("a->b") and unbound ones ("*:*") are left out; duplicates (one socket
// open in several file descriptors) count once.
func ParseLsof(b []byte) []proto.ListenPort {
	var out []proto.ListenPort
	seen := map[proto.ListenPort]bool{}
	pid, cmd, typ, prot := 0, "", "", ""
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" {
			continue
		}
		v := line[1:]
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(v)
			cmd, typ, prot = "", "", ""
		case 'c':
			cmd = v
		case 'f':
			typ, prot = "", ""
		case 't':
			typ = v
		case 'P':
			prot = strings.ToLower(v)
		case 'n':
			if strings.Contains(v, "->") || (prot != "tcp" && prot != "udp") {
				continue
			}
			i := strings.LastIndexByte(v, ':')
			if i < 0 {
				continue
			}
			port, err := strconv.Atoi(v[i+1:])
			if err != nil || port <= 0 || port > 65535 {
				continue
			}
			addr := strings.Trim(v[:i], "[]")
			if j := strings.IndexByte(addr, '%'); j >= 0 {
				addr = addr[:j]
			}
			p := prot
			if typ == "IPv6" {
				p += "6"
			}
			if addr == "*" {
				addr = "0.0.0.0"
				if typ == "IPv6" {
					addr = "::"
				}
			}
			if net.ParseIP(addr) == nil {
				continue
			}
			lp := proto.ListenPort{Proto: p, Address: addr, Port: port, PID: pid, Process: clip(cmd, 64)}
			if seen[lp] {
				continue
			}
			seen[lp] = true
			out = append(out, lp)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		return out[i].Proto < out[j].Proto
	})
	return out
}

// Ports lists the listening TCP and bound UDP sockets. lsof exits 1 when
// it found nothing.
func Ports(ctx context.Context) ([]proto.ListenPort, error) {
	tcp, err := Run(ctx, 30*time.Second, append([]string{Lsof}, LsofTCPArgs...)...)
	if err != nil && ExitCode(err) != 1 {
		return nil, err
	}
	udp, err := Run(ctx, 30*time.Second, append([]string{Lsof}, LsofUDPArgs...)...)
	if err != nil && ExitCode(err) != 1 {
		return nil, err
	}
	return ParseLsof(append(append(tcp, '\n'), udp...)), nil
}
