// Command rackoon-collectdebug runs the agent's collectors in a loop and
// prints each Report as JSON, together with the process's own CPU time and
// RSS, to measure collector overhead.
//
//	sudo rackoon-collectdebug --once                 # one report, pretty JSON
//	sudo rackoon-collectdebug --duration 3m --quiet  # overhead measurement
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"runtime/pprof"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/collect"
)

func main() {
	once := flag.Bool("once", false, "collect one report (after a warm-up collection, so rates are filled) and exit")
	warmup := flag.Duration("warmup", 10*time.Second, "with --once: time between the priming and the printed collection")
	interval := flag.Duration("interval", 10*time.Second, "collection interval")
	duration := flag.Duration("duration", 0, "stop after this long (0 = until interrupted)")
	quiet := flag.Bool("quiet", false, "do not print reports, only per-iteration stats")
	compact := flag.Bool("compact", false, "print compact JSON (one line per report)")
	configDir := flag.String("config", "", "load agent.toml from this directory (default: built-in defaults)")
	cpuProfile := flag.String("cpuprofile", "", "write a CPU profile to this file")
	flag.Parse()

	if *cpuProfile != "" {
		f, err := os.Create(*cpuProfile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "cpuprofile:", err)
			os.Exit(1)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			fmt.Fprintln(os.Stderr, "cpuprofile:", err)
			os.Exit(1)
		}
		defer pprof.StopCPUProfile()
	}

	cfg := &agent.Config{Dir: agent.DefaultConfigDir}
	if *configDir != "" {
		c, err := agent.LoadConfig(*configDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "config:", err)
			os.Exit(1)
		}
		cfg = c
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	col := collect.New(cfg, "debug")
	go func() {
		for ev := range col.Events() {
			fmt.Fprintf(os.Stderr, "event %s %s platform=%s guest=%s state=%s %s\n",
				ev.At.Format(time.RFC3339), ev.Kind, ev.Platform, ev.GuestID, ev.State, ev.Message)
		}
	}()

	start := time.Now()
	cpu0, _ := collect.ProcessCPUSeconds()
	enc := json.NewEncoder(os.Stdout)
	if !*compact {
		enc.SetIndent("", "  ")
	}

	if *once {
		// The first collection primes counters (rates need two samples).
		if _, err := col.Collect(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "collect:", err)
		}
		select {
		case <-time.After(*warmup):
		case <-ctx.Done():
		}
	}

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	var maxCollect time.Duration
	var maxRSS uint64
	n := 0
	for {
		t0 := time.Now()
		r, err := col.Collect(ctx)
		dur := time.Since(t0)
		if dur > maxCollect {
			maxCollect = dur
		}
		n++
		if err != nil {
			fmt.Fprintln(os.Stderr, "collect:", err)
		} else if !*quiet {
			_ = enc.Encode(r)
		}
		cpu, _ := collect.ProcessCPUSeconds()
		wall := time.Since(start).Seconds()
		rss := collect.ProcessRSS()
		maxRSS = max(maxRSS, rss)
		fmt.Fprintf(os.Stderr, "iter=%d collect=%s cpu_total=%.2fs avg_cpu=%.3f%% rss=%.1fMB max_rss=%.1fMB goroutines=%d\n",
			n, dur.Round(time.Millisecond), cpu-cpu0, (cpu-cpu0)/wall*100,
			float64(rss)/1e6, float64(maxRSS)/1e6, runtime.NumGoroutine())
		if err == nil && r != nil {
			for _, s := range r.Collectors {
				if !s.OK {
					fmt.Fprintf(os.Stderr, "  collector %s: %s\n", s.Name, s.Error)
				}
			}
		}
		if *once {
			break
		}
		if *duration > 0 && time.Since(start) >= *duration {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			goto done
		}
	}
done:
	cpu, _ := collect.ProcessCPUSeconds()
	wall := time.Since(start).Seconds()
	fmt.Fprintf(os.Stderr, "summary: iterations=%d wall=%.0fs cpu=%.2fs avg_cpu=%.3f%% of one core (incl. child processes), rss=%.1fMB max_rss_sampled=%.1fMB vmhwm=%.1fMB max_collect=%s\n",
		n, wall, cpu-cpu0, (cpu-cpu0)/wall*100, float64(collect.ProcessRSS())/1e6, float64(maxRSS)/1e6, float64(vmHWM())/1e6, maxCollect.Round(time.Millisecond))
}

// vmHWM returns the peak RSS (VmHWM) of this process in bytes.
func vmHWM() uint64 {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			var kb uint64
			fmt.Sscan(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")), &kb)
			return kb * 1024
		}
	}
	return 0
}
