package hostmetrics

// The battery as a UPS (Whombat DK-10, MG-69): HostNow.power from /sys/class/power_supply, read with every sample.

import (
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// HostPower is HostNow.power (contracts 0.100.0, CT-5xx): absent on machines without a battery.
type HostPower = protocol.HostPower

// supply is one /sys/class/power_supply/<name> as far as it matters here. Energies are µWh, charges µAh, power µW,
// current µA (the kernel's units); -1 where the driver doesn't report it.
type supply struct {
	name, typ, scope, status        string
	online, present, capacity       int64
	energyNow, energyFull, powerNow int64
	chargeNow, chargeFull           int64
	currentNow                      int64
	endThreshold                    int64
}

// readSupplies lists the power supplies under <sys>/class/power_supply, sorted by name.
func readSupplies(sys string) []supply {
	dir := filepath.Join(sys, "class", "power_supply")
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []supply
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		s := supply{name: e.Name(), typ: attr(p, "type"), scope: attr(p, "scope"), status: attr(p, "status"),
			online: num(p, "online"), present: num(p, "present"), capacity: num(p, "capacity"),
			energyNow: num(p, "energy_now"), energyFull: num(p, "energy_full"), powerNow: num(p, "power_now"),
			chargeNow: num(p, "charge_now"), chargeFull: num(p, "charge_full"), currentNow: num(p, "current_now"),
			endThreshold: num(p, "charge_control_end_threshold")}
		if s.typ == "" {
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func attr(dir, name string) string {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || len(b) > 256 {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func num(dir, name string) int64 {
	v, err := strconv.ParseInt(attr(dir, name), 10, 64)
	if err != nil {
		return -1
	}
	return v
}

// The system's batteries: type Battery, not a device's own (a mouse, a headset: scope Device), present.
func (s supply) systemBattery() bool {
	return s.typ == "Battery" && s.scope != "Device" && s.present != 0
}

// An external supply: a mains adapter or a USB/USB-C charger the system runs on (not a device's own).
func (s supply) external() bool { return s.typ != "Battery" && s.scope != "Device" }

// powerReading is what one look at the supplies says, before `since` and the time left are worked out.
type powerReading struct {
	battery  bool  // on battery
	percent  int64 // 0–100
	charging bool
	limit    *int64
	energy   float64 // what the batteries hold now, µWh (or µAh when they report charges only); -1 unknown
	drain    float64 // what they give now, µW (or µA), ≥ 0; -1 unknown
	unit     string  // the pair energy and drain are in: "energy" (µWh, µW) or "charge" (µAh, µA); "" unknown
}

// The unit pairs a battery can report what it holds and gives in (MG-71).
const (
	unitEnergy = "energy"
	unitCharge = "charge"
)

// reports says whether a battery gives both halves of a unit pair: what it holds and its rate.
func (s supply) reports(unit string) bool {
	if unit == unitEnergy {
		return s.energyNow >= 0 && s.powerNow != -1
	}
	return s.chargeNow >= 0 && s.currentNow != -1
}

// readPowerSupplies is nil without a system battery (a VM, a desktop): HostNow then has no power.
func readPowerSupplies(sys string) *powerReading {
	var bats []supply
	externals, online := 0, false
	for _, s := range readSupplies(sys) {
		switch {
		case s.systemBattery():
			bats = append(bats, s)
		case s.external():
			externals++
			if s.online == 1 {
				online = true
			}
		}
	}
	if len(bats) == 0 {
		return nil
	}
	r := &powerReading{energy: -1, drain: -1}
	discharging := false
	for _, b := range bats {
		r.charging = r.charging || b.status == "Charging"
		discharging = discharging || b.status == "Discharging"
	}
	// No charger listed at all (some firmwares): the batteries' own status says.
	r.battery = !online && (externals > 0 || discharging)

	// The percentage: one battery's own capacity (what the firmware and UPower's shutdown at 10 % go by); several,
	// their stored energy (or charge) together.
	var now, full, drain float64
	energies, charges := true, true
	for _, b := range bats {
		energies = energies && b.energyNow >= 0 && b.energyFull > 0
		charges = charges && b.chargeNow >= 0 && b.chargeFull > 0
	}
	switch {
	case len(bats) == 1 && bats[0].capacity >= 0:
		r.percent = bats[0].capacity
	case energies:
		for _, b := range bats {
			now, full = now+float64(b.energyNow), full+float64(b.energyFull)
		}
		r.percent = int64(math.Round(100 * now / full))
	case charges:
		for _, b := range bats {
			now, full = now+float64(b.chargeNow), full+float64(b.chargeFull)
		}
		r.percent = int64(math.Round(100 * now / full))
	default:
		var sum int64
		for _, b := range bats {
			sum += max(b.capacity, 0)
		}
		r.percent = sum / int64(len(bats))
	}
	r.percent = min(max(r.percent, 0), 100)

	// What is left and how fast it goes: energy and power, else charge and current (some report a signed rate), in
	// one pair for every battery (MG-71). Wh and Ah can't be added without the voltage: batteries that only have
	// different pairs leave the time unknown.
	for _, unit := range []string{unitEnergy, unitCharge} {
		all := true
		for _, b := range bats {
			all = all && b.reports(unit)
		}
		if !all {
			continue
		}
		now, drain = 0, 0
		for _, b := range bats {
			if unit == unitEnergy {
				now, drain = now+float64(b.energyNow), drain+math.Abs(float64(b.powerNow))
			} else {
				now, drain = now+float64(b.chargeNow), drain+math.Abs(float64(b.currentNow))
			}
		}
		r.energy, r.drain, r.unit = now, drain, unit
		break
	}
	// The charge limit (DK-10, power.nix): the threshold the batteries stop charging at; 100 is no limit.
	if t := bats[0].endThreshold; t >= 1 && t <= 99 {
		r.limit = &t
	}
	return r
}

// drainKept is how many readings the time left averages over (a minute at the sampler's 10 s): a laptop's power draw
// jumps with every burst of work.
const drainKept = 6

// maxMinutesLeft: more than a week on battery is a reading, not a forecast.
const maxMinutesLeft = 7 * 24 * 60

// powerState is what is carried from one reading to the next: since when on battery, and the recent drain.
type powerState struct {
	since  time.Time // on battery since; zero while on AC
	drains []float64
	unit   string // the drains' unit pair; a reading in another one starts them again
}

// next turns a reading at t into HostNow.power (nil without a battery). `since` is the first reading on battery (the
// manager started on battery: its first reading); the time left is what the batteries hold over their average drain
// of the last minute, only on battery.
func (ps *powerState) next(r *powerReading, t time.Time) *HostPower {
	if r == nil {
		*ps = powerState{}
		return nil
	}
	p := &HostPower{Source: protocol.HostPowerSourceAc, Percent: r.percent, Charging: r.charging, ChargeLimit: r.limit}
	if !r.battery {
		*ps = powerState{}
		return p
	}
	p.Source = protocol.HostPowerSourceBattery
	if ps.since.IsZero() {
		ps.since = t
	}
	s := ps.since.UTC().Format(time.RFC3339)
	p.Since = &s
	// A drain of 0 (a firmware that hasn't measured yet) is no reading; one in another unit pair than the last ones
	// can't be averaged with them.
	if r.unit != ps.unit {
		ps.drains, ps.unit = nil, r.unit
	}
	if r.drain > 0 {
		ps.drains = append(ps.drains, r.drain)
		if len(ps.drains) > drainKept {
			ps.drains = ps.drains[len(ps.drains)-drainKept:]
		}
	}
	if r.energy >= 0 && len(ps.drains) > 0 {
		var sum float64
		for _, d := range ps.drains {
			sum += d
		}
		m := int64(math.Round(r.energy / (sum / float64(len(ps.drains))) * 60))
		m = min(max(m, 0), maxMinutesLeft)
		p.MinutesLeft = &m
	}
	return p
}
