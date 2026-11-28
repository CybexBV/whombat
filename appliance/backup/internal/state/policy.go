package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"time"
	_ "time/tzdata" // the person's zone on a box whose own is UTC

	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// Policy is the person's backup options (BK-37, Whombat backup-options.md BKO-02): how often, in which time zone,
// what to keep, the space limit and the weekly restore check. It lives in <stateDir>/policy.json, written by the
// runtime through PUT /v1/policy. The runtime mirrors the shape (@whombat/protocol BackupPolicy).
type Policy struct {
	V           int        `json:"v"`
	Frequency   string     `json:"frequency"` // nightly | 6h | hourly
	TimeZone    string     `json:"timeZone"`
	Keep        PolicyKeep `json:"keep"`
	LimitBytes  *int64     `json:"limitBytes"`
	WeeklyCheck bool       `json:"weeklyCheck"`
}

// PolicyKeep is restic's --keep-within windows: every backup of AllDays, one a day for DailyDays, one a week for
// WeeklyWeeks, one a month for MonthlyMonths (BKO-03: windows, never counts).
type PolicyKeep struct {
	AllDays       int `json:"allDays"`
	DailyDays     int `json:"dailyDays"`
	WeeklyWeeks   int `json:"weeklyWeeks"`
	MonthlyMonths int `json:"monthlyMonths"`
}

// Frequencies.
const (
	FrequencyNightly = "nightly"
	Frequency6h      = "6h"
	FrequencyHourly  = "hourly"
)

// DefaultPolicy is the recommended options (BKO-01): every 6 hours, up to a year, no limit, a weekly check.
func DefaultPolicy() Policy {
	return Policy{V: 1, Frequency: Frequency6h, TimeZone: "UTC",
		Keep: PolicyKeep{AllDays: 2, DailyDays: 14, WeeklyWeeks: 8, MonthlyMonths: 12}, WeeklyCheck: true}
}

var zoneName = regexp.MustCompile(`^[A-Za-z0-9_+./-]{1,64}$`)

// LimitMinBytes is the smallest space limit (1 GB).
const LimitMinBytes = 1_000_000_000

// Validate checks a policy the runtime sent.
func (p Policy) Validate() error {
	if p.V != 1 {
		return errors.New("v must be 1")
	}
	switch p.Frequency {
	case FrequencyNightly, Frequency6h, FrequencyHourly:
	default:
		return fmt.Errorf("frequency must be nightly, 6h or hourly")
	}
	if !zoneName.MatchString(p.TimeZone) {
		return errors.New("timeZone is not a zone name")
	}
	if _, err := time.LoadLocation(p.TimeZone); err != nil {
		return fmt.Errorf("unknown time zone %q", p.TimeZone)
	}
	k := p.Keep
	if k.AllDays < 1 || k.AllDays > 3650 || k.DailyDays < 0 || k.DailyDays > 3650 || k.WeeklyWeeks < 0 ||
		k.WeeklyWeeks > 520 || k.MonthlyMonths < 0 || k.MonthlyMonths > 240 {
		return errors.New("keep is out of range")
	}
	if p.LimitBytes != nil && *p.LimitBytes < LimitMinBytes {
		return errors.New("limitBytes is below 1 GB")
	}
	return nil
}

// PolicyPath is <stateDir>/policy.json.
func (c *Config) PolicyPath() string { return filepath.Join(c.StateDir, "policy.json") }

// LoadPolicy reads the policy; the default when there is none (or it doesn't parse: a box keeps backing up).
func LoadPolicy(c *Config) Policy {
	b, err := ReadStateFile(c.PolicyPath())
	if err != nil {
		return DefaultPolicy()
	}
	var p Policy
	if json.Unmarshal(b, &p) != nil || p.Validate() != nil {
		return DefaultPolicy()
	}
	return p
}

// SavePolicy writes the policy (0644: the runtime and the units read it).
func SavePolicy(c *Config, p Policy) error {
	if err := p.Validate(); err != nil {
		return err
	}
	return WriteJSON(c.PolicyPath(), p, 0o644)
}

// SlotHours are the hours of the person's day a frequency backs up at (the client's BACKUP_SLOT_HOURS).
func SlotHours(frequency string) []int {
	switch frequency {
	case FrequencyNightly:
		return []int{3}
	case FrequencyHourly:
		h := make([]int, 24)
		for i := range h {
			h[i] = i
		}
		return h
	default:
		return []int{3, 9, 15, 21}
	}
}

// Interval is the time between two scheduled backups.
func (p Policy) Interval() time.Duration {
	switch p.Frequency {
	case FrequencyNightly:
		return 24 * time.Hour
	case FrequencyHourly:
		return time.Hour
	default:
		return 6 * time.Hour
	}
}

// StaleAfter is when the status calls the backups stale: 1.5 times the interval plus 2 hours (BKO-02).
func (p Policy) StaleAfter() time.Duration { return p.Interval()*3/2 + 2*time.Hour }

func (p Policy) location() *time.Location {
	loc, err := time.LoadLocation(p.TimeZone)
	if err != nil {
		return time.UTC
	}
	return loc
}

// LastSlot is the newest slot at or before now, in the person's zone. Each day's slots are that day's wall-clock
// hours, made with time.Date: on a day the zone's clock skips a slot's hour (summer time starting at that hour),
// the slot moves to just after the gap instead of being lost; on a day the hour happens twice, it is one of them.
func (p Policy) LastSlot(now time.Time) time.Time {
	loc := p.location()
	hours := SlotHours(p.Frequency)
	local := now.In(loc)
	for day := 0; day < 3; day++ {
		y, m, d := local.Date()
		for i := len(hours) - 1; i >= 0; i-- {
			if s := time.Date(y, m, d-day, hours[i], 0, 0, 0, loc); !s.After(now) {
				return s
			}
		}
	}
	return now.Add(-p.Interval())
}

// DueInput is what Due decides on.
type DueInput struct {
	Now         time.Time
	LastSuccess *time.Time
	LastFailure *time.Time
	// DestinationChanged: the newest checkpoint went elsewhere (a new destination is always due).
	DestinationChanged bool
}

// RetryAfter is how long a failed scheduled backup waits before the next try.
const RetryAfter = 15 * time.Minute

// ClockSlack is how far in the future a recorded time may be before it counts as the clock having moved back since.
const ClockSlack = 10 * time.Minute

// Due says whether a scheduled backup should run now and why (BKO-02). A time recorded while the clock ran ahead
// (after it is put right, it lies in the future) never holds a backup back: a failure dated in the future doesn't
// make the next try wait, and a success dated in the future doesn't count as the newest backup.
func (p Policy) Due(in DueInput) (bool, string) {
	if f := in.LastFailure; f != nil && !f.After(in.Now) && in.Now.Sub(*f) < RetryAfter &&
		(in.LastSuccess == nil || f.After(*in.LastSuccess)) {
		return false, "the last try failed less than 15 minutes ago"
	}
	if in.LastSuccess == nil {
		return true, "no backup yet"
	}
	if in.DestinationChanged {
		return true, "the destination changed"
	}
	if in.LastSuccess.After(in.Now.Add(ClockSlack)) {
		return true, "the last backup is dated in the future: the clock was put back since"
	}
	slot := p.LastSlot(in.Now)
	if in.LastSuccess.Before(slot) {
		return true, "nothing since " + slot.Format("15:04 MST")
	}
	return false, "backed up since " + slot.Format("15:04 MST")
}

// The weekly restore check starts in the person's early morning, after the night's backup (03:00) and before the
// day begins: from DrillFromHour to DrillUntilHour in the policy's time zone. The drill timer asks every hour.
const (
	DrillFromHour  = 4
	DrillUntilHour = 7
	// DrillEvery is how old the last check is before the next is due (6½ days, so the same morning each week).
	DrillEvery = 156 * time.Hour
	// DrillOverdue: a check that missed its mornings this long (the box was off or busy each time) runs at any hour.
	DrillOverdue = 8 * 24 * time.Hour
)

// DrillDue says whether the weekly restore check is due: on, the last one at least 6½ days old, and the person's
// early morning (or the check overdue). A last check dated in the future (the clock was put back) doesn't hold it back.
func (p Policy) DrillDue(now time.Time, last *time.Time) bool {
	if !p.WeeklyCheck {
		return false
	}
	if last != nil && !last.After(now.Add(ClockSlack)) {
		age := now.Sub(*last)
		if age < DrillEvery {
			return false
		}
		if age >= DrillOverdue {
			return true
		}
	}
	h := now.In(p.location()).Hour()
	return h >= DrillFromHour && h < DrillUntilHour
}

// ForgetArgs are restic's forget flags for the keep windows (BKO-03).
func (k PolicyKeep) ForgetArgs() []string {
	args := []string{"--keep-within", fmt.Sprintf("%dd", k.AllDays)}
	if k.DailyDays > 0 {
		args = append(args, "--keep-within-daily", fmt.Sprintf("%dd", k.DailyDays))
	}
	if k.WeeklyWeeks > 0 {
		args = append(args, "--keep-within-weekly", fmt.Sprintf("%dd", k.WeeklyWeeks*7))
	}
	if k.MonthlyMonths > 0 {
		args = append(args, "--keep-within-monthly", fmt.Sprintf("%dm", k.MonthlyMonths))
	}
	return args
}

// Expired are the snapshots of snaps that the keep windows don't keep, by restic's own rule for ForgetArgs' flags
// (restic 0.18 `forget`, one group): counted back from the newest snapshot not dated ahead of now (now when all are),
// every snapshot within AllDays, the newest of each day, ISO week and month within the other windows, by each
// snapshot's own clock, and the oldest of all when a window reaches back to it. A clearing that may touch only some of a
// repository's snapshots (the copy's, where another Whombat may write too) names what goes by id, so the rule runs here
// over exactly that set, never over everything a machine name matches.
func (k PolicyKeep) Expired(snaps []restic.Snapshot, now time.Time) []restic.Snapshot {
	list := slices.Clone(snaps)
	sort.SliceStable(list, func(i, j int) bool { return list[i].Time.After(list[j].Time) })
	latest := now
	for _, sn := range list {
		if !sn.Time.After(now) {
			latest = sn.Time
			break
		}
	}
	type window struct {
		from   time.Time
		on     bool
		bucket func(time.Time) int
		last   int
	}
	windows := []window{
		{latest.AddDate(0, 0, -k.DailyDays), k.DailyDays > 0, func(t time.Time) int {
			return t.Year()*10000 + int(t.Month())*100 + t.Day()
		}, -1},
		{latest.AddDate(0, 0, -7*k.WeeklyWeeks), k.WeeklyWeeks > 0, func(t time.Time) int {
			y, w := t.ISOWeek()
			return y*100 + w
		}, -1},
		{latest.AddDate(0, -k.MonthlyMonths, 0), k.MonthlyMonths > 0, func(t time.Time) int {
			return t.Year()*100 + int(t.Month())
		}, -1},
	}
	all := latest.AddDate(0, 0, -k.AllDays)
	var out []restic.Snapshot
	for nr, sn := range list {
		keep := k.AllDays > 0 && sn.Time.After(all)
		for i := range windows {
			w := &windows[i]
			if !w.on || !sn.Time.After(w.from) {
				continue
			}
			if b := w.bucket(sn.Time); b != w.last || nr == len(list)-1 {
				keep, w.last = true, b
			}
		}
		if !keep {
			out = append(out, sn)
		}
	}
	return out
}

// LimitLadder is how the space limit thins old backups when the repository is over it (Whombat backup-options.md
// BKO-05, the same steps as a backup place's cleanup): ever shorter windows, the oldest first: months to 6, to 3, to
// none, weeks to 4, to none, days to 7; every backup of the last max(AllDays, 7) days always stays. A step that
// shortens nothing is left out. Each entry is the whole set of windows for one forget.
func (k PolicyKeep) LimitLadder() []PolicyKeep {
	cur := k
	cur.AllDays = max(k.AllDays, 7)
	steps := []struct {
		field *int
		to    int
	}{
		{&cur.MonthlyMonths, 6}, {&cur.MonthlyMonths, 3}, {&cur.MonthlyMonths, 0},
		{&cur.WeeklyWeeks, 4}, {&cur.WeeklyWeeks, 0}, {&cur.DailyDays, 7},
	}
	var out []PolicyKeep
	for _, st := range steps {
		if *st.field > st.to {
			*st.field = st.to
			out = append(out, cur)
		}
	}
	return out
}

// policyFileExists: whether the person (or the runtime for them) ever set a policy.
func policyFileExists(c *Config) bool {
	_, err := os.Stat(c.PolicyPath())
	return err == nil
}
