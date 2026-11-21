package collect

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// upsCollector reads UPSes through NUT (upsc against the local upsd) and
// apcupsd (apcaccess against its local NIS port) every 30 s. A tool that
// is installed but whose daemon does not answer is not an error: many
// hosts have the client tools only. Absent when neither reports a UPS.
type upsCollector struct {
	toggle toggleFn
	c      *collector

	mu   sync.Mutex
	upss []proto.UPS
}

func newUPSCollector(toggle toggleFn, c *collector) *upsCollector {
	return &upsCollector{toggle: toggle, c: c}
}

func (u *upsCollector) run(ctx context.Context) error {
	var out []proto.UPS
	var errs []string
	if u.toggle.enabled(true) {
		if _, err := lookPath("upsc"); err == nil {
			list, err := runCmd(ctx, 5*time.Second, "upsc", "-l")
			if err == nil {
				for _, name := range strings.Fields(string(list)) {
					b, err := runCmd(ctx, 5*time.Second, "upsc", name)
					if err != nil {
						errs = append(errs, "upsc "+name+": "+err.Error())
						continue
					}
					out = append(out, parseUpsc(name, b))
				}
			}
		}
		if _, err := lookPath("apcaccess"); err == nil {
			if b, err := runCmd(ctx, 5*time.Second, "apcaccess", "-u"); err == nil {
				if x, ok := parseApcaccess(b); ok {
					out = append(out, x)
				}
			}
		}
	}
	if u.c != nil {
		u.c.upsSub.setAbsent(len(out) == 0 && len(errs) == 0)
	}
	u.mu.Lock()
	u.upss = out
	u.mu.Unlock()
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func (u *upsCollector) snapshot() []proto.UPS {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.upss == nil {
		return nil
	}
	out := make([]proto.UPS, len(u.upss))
	for i, x := range u.upss {
		x.ChargePct, x.RuntimeS, x.LoadPct = copyPtr(x.ChargePct), copyPtr(x.RuntimeS), copyPtr(x.LoadPct)
		out[i] = x
	}
	return out
}

// colonKV parses "key: value" lines (upsc, apcaccess).
func colonKV(b []byte) map[string]string {
	kv := map[string]string{}
	scanLines(b, func(line string) {
		k, v, ok := strings.Cut(line, ":")
		if ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	})
	return kv
}

func floatPtr(s string) *float64 {
	f := strings.Fields(s)
	if len(f) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return nil
	}
	return &v
}

// parseUpsc maps `upsc <ups>` output.
func parseUpsc(name string, b []byte) proto.UPS {
	kv := colonKV(b)
	x := proto.UPS{Name: name, Source: "nut", StatusRaw: kv["ups.status"]}
	x.Model = firstNonEmpty(kv["ups.model"], kv["device.model"])
	if mfr := firstNonEmpty(kv["ups.mfr"], kv["device.mfr"]); mfr != "" && x.Model != "" && !strings.HasPrefix(x.Model, mfr) {
		x.Model = mfr + " " + x.Model
	}
	x.Status = nutStatus(x.StatusRaw)
	x.ChargePct = floatPtr(kv["battery.charge"])
	if rt := floatPtr(kv["battery.runtime"]); rt != nil {
		x.RuntimeS = ptr(int(*rt))
	}
	x.LoadPct = floatPtr(kv["ups.load"])
	return x
}

// nutStatus maps NUT's ups.status flags (OL, OB, LB, CHRG, OFF, ...).
func nutStatus(raw string) string {
	flags := map[string]bool{}
	for _, f := range strings.Fields(raw) {
		flags[f] = true
	}
	switch {
	case raw == "":
		return "unknown"
	case flags["OFF"]:
		return "offline"
	case flags["LB"] || flags["FSD"]:
		return "low_battery"
	case flags["OB"]:
		return "on_battery"
	case flags["OL"]:
		return "online"
	}
	return "unknown"
}

// parseApcaccess maps `apcaccess -u` (units stripped). TIMELEFT is in
// minutes. ok is false when the output has no STATUS (daemon down).
func parseApcaccess(b []byte) (proto.UPS, bool) {
	kv := colonKV(b)
	raw, ok := kv["STATUS"]
	if !ok {
		return proto.UPS{}, false
	}
	x := proto.UPS{Name: kv["UPSNAME"], Source: "apcupsd", Model: kv["MODEL"], StatusRaw: raw}
	if x.Name == "" {
		x.Name = "apcupsd"
	}
	if x.Model == "" {
		x.Model = kv["APCMODEL"]
	}
	x.Status = apcStatus(raw)
	x.ChargePct = floatPtr(kv["BCHARGE"])
	if m := floatPtr(kv["TIMELEFT"]); m != nil {
		x.RuntimeS = ptr(int(*m * 60))
	}
	x.LoadPct = floatPtr(kv["LOADPCT"])
	return x, true
}

// apcStatus maps apcupsd's STATUS ("ONLINE", "ONBATT LOWBATT", "COMMLOST").
func apcStatus(raw string) string {
	s := strings.ToUpper(raw)
	switch {
	case strings.Contains(s, "COMMLOST") || strings.Contains(s, "SHUTTING DOWN"):
		return "offline"
	case strings.Contains(s, "LOWBATT"):
		return "low_battery"
	case strings.Contains(s, "ONBATT"):
		return "on_battery"
	case strings.Contains(s, "ONLINE"):
		return "online"
	}
	return "unknown"
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
