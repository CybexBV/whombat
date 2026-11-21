package diagnose

import (
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"rackoon/internal/proto"
)

// The inspect views as text tables.

func table(header string, rows [][]string) string {
	var b strings.Builder
	w := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, header)
	for _, r := range rows {
		fmt.Fprintln(w, strings.Join(r, "\t"))
	}
	w.Flush()
	return b.String()
}

func processTable(rows []proto.Process, now time.Time) string {
	out := make([][]string, 0, len(rows))
	for _, p := range rows {
		age := "-"
		if !p.Started.IsZero() {
			age = shortDuration(now.Sub(p.Started))
		}
		guest := p.Container
		if guest == "" {
			guest = "-"
		}
		cmd := redactArgs(strings.ReplaceAll(p.Command, "\t", " "))
		if r := []rune(cmd); len(r) > 200 {
			cmd = string(r[:200]) + "…"
		}
		out = append(out, []string{
			strconv.Itoa(p.PID), strconv.Itoa(p.PPID), dash(p.User),
			strconv.FormatFloat(p.CPUPct, 'f', 1, 64), mib(p.RSSBytes), dash(p.State),
			strconv.Itoa(p.Threads), age, guest, cmd,
		})
	}
	return table("PID\tPPID\tUSER\tCPU%\tRSS\tSTATE\tTHR\tAGE\tGUEST\tCOMMAND", out)
}

func portTable(ports []proto.ListenPort, truncated bool) string {
	out := make([][]string, 0, len(ports))
	for _, p := range ports {
		pid := "-"
		if p.PID > 0 {
			pid = strconv.Itoa(p.PID)
		}
		out = append(out, []string{p.Proto, p.Address, strconv.Itoa(p.Port), pid, dash(p.Process)})
	}
	s := table("PROTO\tADDRESS\tPORT\tPID\tPROCESS", out)
	if truncated {
		s += "(more sockets than shown)\n"
	}
	return s
}

func updateTable(ups []proto.PackageUpdate, manager string) string {
	if len(ups) == 0 {
		return fmt.Sprintf("No pending updates (%s, from its cached package lists; the agent never refreshes them).\n", manager)
	}
	sec := 0
	out := make([][]string, 0, len(ups))
	for _, u := range ups {
		s := "-"
		if u.Security {
			s, sec = "yes", sec+1
		}
		out = append(out, []string{u.Name, dash(u.Current), u.New, s, dash(u.Source)})
	}
	head := fmt.Sprintf("%d pending updates, %d security (%s, from its cached package lists)\n", len(ups), sec, manager)
	return head + table("NAME\tCURRENT\tNEW\tSECURITY\tSOURCE", out)
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func mib(b uint64) string {
	return strconv.FormatFloat(float64(b)/(1<<20), 'f', 1, 64) + "M"
}

// shortDuration: "45s", "12m", "3h12m", "4d3h".
func shortDuration(d time.Duration) string {
	switch {
	case d < 0:
		return "-"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd%dh", int(d.Hours())/24, int(d.Hours())%24)
}
