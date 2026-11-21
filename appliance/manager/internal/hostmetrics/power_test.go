package hostmetrics

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// supplies writes power_supply directories under <sys>/class/power_supply: name → attribute → value.
func supplies(t *testing.T, sys string, s map[string]map[string]string) {
	t.Helper()
	_ = os.RemoveAll(filepath.Join(sys, "class", "power_supply"))
	files := map[string]string{"class/power_supply/": ""}
	for name, attrs := range s {
		for k, v := range attrs {
			files[filepath.Join("class/power_supply", name, k)] = v + "\n"
		}
	}
	tree(t, sys, files)
}

// The ROG Flow Z13 as its drivers show it: the adapter (ACAD), the battery with asus-wmi's threshold, the USB-C port's
// own supply (UCSI) and a wireless mouse's battery, which isn't the system's.
func z13(acOnline, status, capacity, energyNow, powerNow string) map[string]map[string]string {
	return map[string]map[string]string{
		"ACAD": {"type": "Mains", "online": acOnline},
		"BAT0": {"type": "Battery", "present": "1", "status": status, "capacity": capacity, "energy_now": energyNow,
			"energy_full": "70000000", "power_now": powerNow, "charge_control_end_threshold": "80", "scope": "System"},
		"ucsi-source-psy-USBC000:001": {"type": "USB", "online": "0", "scope": "System"},
		"hidpp_battery_0":             {"type": "Battery", "scope": "Device", "status": "Discharging", "capacity": "5"},
	}
}

func TestPowerOnTheZ13(t *testing.T) {
	sys := t.TempDir()
	at := time.Date(2026, 10, 20, 2, 14, 0, 0, time.UTC)
	var ps powerState

	// Plugged in, held at the limit: not charging, no time left, no since.
	supplies(t, sys, z13("1", "Not charging", "80", "56000000", "0"))
	p := ps.next(readPowerSupplies(sys), at)
	if p == nil || p.Source != "ac" || p.Percent != 80 || p.Charging || p.MinutesLeft != nil || p.Since != nil ||
		p.ChargeLimit == nil || *p.ChargeLimit != 80 {
		t.Fatalf("%+v", p)
	}

	// The power goes out: on battery since this reading, 40 Wh at 12 W is 200 minutes.
	supplies(t, sys, z13("0", "Discharging", "57", "40000000", "12000000"))
	p = ps.next(readPowerSupplies(sys), at.Add(10*time.Second))
	if p.Source != "battery" || p.Percent != 57 || *p.MinutesLeft != 200 || *p.Since != "2026-10-20T02:14:10Z" {
		t.Fatalf("%+v %v %v", p, *p.MinutesLeft, *p.Since)
	}
	// A burst of work: the time left averages the last minute's drain (12 and 20 W: 16 W, 150 minutes).
	supplies(t, sys, z13("0", "Discharging", "57", "40000000", "20000000"))
	p = ps.next(readPowerSupplies(sys), at.Add(20*time.Second))
	if *p.MinutesLeft != 150 || *p.Since != "2026-10-20T02:14:10Z" {
		t.Fatalf("%v %v", *p.MinutesLeft, *p.Since)
	}
	// A reading of 0 W (a firmware between measurements) keeps the average.
	supplies(t, sys, z13("0", "Discharging", "57", "40000000", "0"))
	if p = ps.next(readPowerSupplies(sys), at.Add(30*time.Second)); p.MinutesLeft == nil || *p.MinutesLeft != 150 {
		t.Fatalf("%+v", p)
	}
	// Only the last minute counts.
	for i := 0; i < drainKept; i++ {
		supplies(t, sys, z13("0", "Discharging", "56", "40000000", "10000000"))
		p = ps.next(readPowerSupplies(sys), at.Add(time.Duration(40+10*i)*time.Second))
	}
	if *p.MinutesLeft != 240 {
		t.Fatalf("%v", *p.MinutesLeft)
	}

	// Back: on AC, charging, since and the drain forgotten.
	supplies(t, sys, z13("1", "Charging", "56", "39000000", "30000000"))
	p = ps.next(readPowerSupplies(sys), at.Add(2*time.Minute))
	if p.Source != "ac" || !p.Charging || p.Since != nil || p.MinutesLeft != nil || len(ps.drains) != 0 {
		t.Fatalf("%+v", p)
	}
	// Out again: a new since.
	supplies(t, sys, z13("0", "Discharging", "56", "39000000", "13000000"))
	if p = ps.next(readPowerSupplies(sys), at.Add(3*time.Minute)); *p.Since != "2026-10-20T02:17:00Z" || *p.MinutesLeft != 180 {
		t.Fatalf("%+v", p)
	}
}

// No system battery: no power at all (a VM, a desktop with a wireless mouse).
func TestNoBattery(t *testing.T) {
	sys := t.TempDir()
	var ps powerState
	if p := ps.next(readPowerSupplies(sys), time.Now()); p != nil {
		t.Fatalf("no power_supply class: %+v", p)
	}
	supplies(t, sys, map[string]map[string]string{
		"hidpp_battery_0": {"type": "Battery", "scope": "Device", "status": "Discharging", "capacity": "40"},
		"AC":              {"type": "Mains", "online": "1"},
	})
	if p := ps.next(readPowerSupplies(sys), time.Now()); p != nil {
		t.Fatalf("a mouse's battery: %+v", p)
	}
	// A battery slot without a battery.
	supplies(t, sys, map[string]map[string]string{"BAT0": {"type": "Battery", "present": "0"}, "AC": {"type": "Mains", "online": "1"}})
	if p := ps.next(readPowerSupplies(sys), time.Now()); p != nil {
		t.Fatalf("an empty slot: %+v", p)
	}
}

func TestPowerVariants(t *testing.T) {
	sys := t.TempDir()
	now := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	for name, tc := range map[string]struct {
		s        map[string]map[string]string
		source   string
		percent  int64
		minutes  int64 // -1: none
		limit    int64 // -1: none
		charging bool
	}{
		// No charger listed: the battery's status says.
		"no charger, discharging": {map[string]map[string]string{"BAT1": {"type": "Battery", "status": "Discharging", "capacity": "33"}},
			"battery", 33, -1, -1, false},
		"no charger, full": {map[string]map[string]string{"BAT1": {"type": "Battery", "status": "Full", "capacity": "100"}},
			"ac", 100, -1, -1, false},
		// Charge and a signed current only (µAh, µA): 2 Ah at −1 A is two hours.
		"charge and current": {map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
			"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "40", "charge_now": "2000000",
				"charge_full": "5000000", "current_now": "-1000000"}}, "battery", 40, 120, -1, false},
		// Two batteries: their energy together; a threshold of 100 is no limit.
		"two batteries": {map[string]map[string]string{"AC": {"type": "Mains", "online": "1"},
			"BAT0": {"type": "Battery", "status": "Charging", "capacity": "90", "energy_now": "18000000", "energy_full": "20000000",
				"power_now": "5000000", "charge_control_end_threshold": "100"},
			"BAT1": {"type": "Battery", "status": "Not charging", "capacity": "10", "energy_now": "2000000", "energy_full": "20000000",
				"power_now": "0"}}, "ac", 50, -1, -1, true},
		// Two batteries in different units (MG-71): Wh and Ah aren't added, the time left is unknown, the percentage
		// their capacities' mean.
		"mixed units": {map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
			"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "60", "energy_now": "30000000", "energy_full": "50000000",
				"power_now": "10000000"},
			"BAT1": {"type": "Battery", "status": "Discharging", "capacity": "40", "charge_now": "2000000", "charge_full": "5000000",
				"current_now": "-1000000"}}, "battery", 50, -1, -1, false},
		// The pair every battery has: energy (2 × 10 Wh at 2 × 5 W is two hours) even when one has charges too …
		"both in energy": {map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
			"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "50", "energy_now": "10000000", "energy_full": "20000000",
				"power_now": "5000000"},
			"BAT1": {"type": "Battery", "status": "Discharging", "capacity": "50", "energy_now": "10000000", "energy_full": "20000000",
				"power_now": "5000000", "charge_now": "9000000", "current_now": "9000000"}}, "battery", 50, 120, -1, false},
		// … else charges (2 Ah + 1 Ah at 1 A + 0.5 A, one signed, is two hours).
		"both in charge": {map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
			"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "40", "energy_now": "30000000", "power_now": "10000000",
				"charge_now": "2000000", "charge_full": "5000000", "current_now": "-1000000"},
			"BAT1": {"type": "Battery", "status": "Discharging", "capacity": "20", "charge_now": "1000000", "charge_full": "5000000",
				"current_now": "500000"}}, "battery", 30, 120, -1, false},
		// A USB-C charger the system runs on (no Mains supply at all).
		"usb-c charger": {map[string]map[string]string{"ucsi-source-psy-USBC000:001": {"type": "USB", "online": "1"},
			"BAT0": {"type": "Battery", "status": "Charging", "capacity": "61"}}, "ac", 61, -1, -1, true},
		// No rate reported: no time left.
		"no rate": {map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
			"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "70"}}, "battery", 70, -1, -1, false},
		// A capacity a driver gets wrong is kept within 0–100.
		"capacity out of range": {map[string]map[string]string{"AC": {"type": "Mains", "online": "1"},
			"BAT0": {"type": "Battery", "status": "Full", "capacity": "104", "charge_control_end_threshold": "60"}}, "ac", 100, -1, 60, false},
	} {
		supplies(t, sys, tc.s)
		var ps powerState
		p := ps.next(readPowerSupplies(sys), now)
		if p == nil {
			t.Errorf("%s: no power", name)
			continue
		}
		minutes, limit := int64(-1), int64(-1)
		if p.MinutesLeft != nil {
			minutes = *p.MinutesLeft
		}
		if p.ChargeLimit != nil {
			limit = *p.ChargeLimit
		}
		if string(p.Source) != tc.source || p.Percent != tc.percent || minutes != tc.minutes || limit != tc.limit || p.Charging != tc.charging ||
			(p.Source == "battery") != (p.Since != nil) {
			t.Errorf("%s: %+v minutes %d limit %d", name, p, minutes, limit)
		}
	}
}

// A battery whose driver switches from energy to charge readings (MG-71): the minute's average starts again in the new
// unit, never µW and µA together.
func TestPowerUnitsDontMix(t *testing.T) {
	sys := t.TempDir()
	at := time.Date(2026, 10, 20, 2, 0, 0, 0, time.UTC)
	var ps powerState
	energy := map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
		"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "50", "energy_now": "20000000", "power_now": "1000000"}}
	charge := map[string]map[string]string{"AC": {"type": "Mains", "online": "0"},
		"BAT0": {"type": "Battery", "status": "Discharging", "capacity": "50", "charge_now": "2000000", "current_now": "1000000"}}
	minutes := func(s map[string]map[string]string) int64 {
		t.Helper()
		supplies(t, sys, s)
		at = at.Add(10 * time.Second)
		p := ps.next(readPowerSupplies(sys), at)
		if p == nil || p.MinutesLeft == nil {
			t.Fatalf("no time left: %+v", p)
		}
		return *p.MinutesLeft
	}
	if m := minutes(energy); m != 1200 { // 20 Wh at 1 W
		t.Fatalf("energy: %d minutes", m)
	}
	if m := minutes(charge); m != 120 { // 2 Ah at 1 A, not averaged with the 1 W before
		t.Fatalf("charge after energy: %d minutes", m)
	}
	if len(ps.drains) != 1 || ps.unit != unitCharge {
		t.Fatalf("drains %v in %q", ps.drains, ps.unit)
	}
}

// The sampler puts the power into its samples (HostNow.power).
func TestSamplerPower(t *testing.T) {
	proc, sys := t.TempDir(), t.TempDir()
	tree(t, proc, map[string]string{"stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1\n", "meminfo": "MemTotal: 8000 kB\nMemAvailable: 2000 kB\n",
		"net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"})
	supplies(t, sys, z13("0", "Discharging", "57", "40000000", "12000000"))
	at := time.Date(2026, 10, 20, 2, 14, 0, 0, time.UTC)
	s := New(Config{Proc: proc, Sys: sys, Now: func() time.Time { return at }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.measure(false)
	at = at.Add(time.Second)
	s.measure(true)
	if p := s.latest.power; p == nil || p.Source != "battery" || *p.Since != "2026-10-20T02:14:00Z" || *p.MinutesLeft != 200 {
		t.Fatalf("%+v", s.latest.power)
	}
	// The runtime's answer carries it, and it is the contract's.
	res, err := s.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"})
	if err != nil || res.Metrics.Now.Power == nil || res.Metrics.Now.Power.ChargeLimit == nil || *res.Metrics.Now.Power.ChargeLimit != 80 {
		t.Fatal(err, res)
	}
	if err := res.Validate(); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(res)
	if _, err := local.ParseHostMetricsResponse(b); err != nil {
		t.Fatal(err)
	}
	// Without a battery HostNow has no power member at all.
	supplies(t, sys, map[string]map[string]string{"AC": {"type": "Mains", "online": "1"}})
	at = at.Add(10 * time.Second)
	s.measure(true)
	res, _ = s.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"})
	if b, _ := json.Marshal(res.Metrics.Now); res.Metrics.Now.Power != nil || strings.Contains(string(b), "power") {
		t.Fatalf("%s", b)
	}
}
