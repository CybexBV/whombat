package wire

import (
	"slices"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func strs[T ~string](vs []T) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = string(v)
	}
	return out
}

// The untyped mirrors are the generated values, all of them.
func TestMirrors(t *testing.T) {
	for name, c := range map[string]struct{ ours, gen []string }{
		"levels":       {[]string{LevelLook, LevelFix}, strs(protocol.RemoteHelpLevelValues)},
		"environments": {[]string{EnvLocal, EnvDev, EnvProd}, strs(local.SupportEnvironmentValues)},
		"durations": {[]string{DurationHour, DurationDay, DurationWeek, DurationForever},
			strs(protocol.RemoteHelpDurationValues)},
		"stop reasons": {[]string{StopOwner, StopDesk}, strs(local.SupportStopReasonValues)},
		"step kinds": {[]string{StepConnected, StepLeft, StepLook, StepExec, StepShell, StepRestart, StepForward,
			StepRefused, StepWrongCode}, strs(protocol.RemoteHelpStepKindValues)},
		"refusals": {[]string{ReasonLevel, ReasonCode, ReasonCertificate, ReasonLimit, ReasonUnknownCommand,
			ReasonBadArguments}, strs(protocol.RemoteHelpRefusalValues)},
		"event kinds": {[]string{EventGrant, EventStop, EventExpired, EventVisitStart, EventVisitEnd, EventLockedOut},
			strs(local.SupportEventKindValues)},
		"look commands": {LookCommands, strs(protocol.LookCommandValues)},
	} {
		if !slices.Equal(c.ours, c.gen) {
			t.Errorf("%s: %v, generated %v", name, c.ours, c.gen)
		}
	}
}

func TestDurations(t *testing.T) {
	for name, want := range map[string]int64{DurationHour: 3600, DurationDay: 86400, DurationWeek: 604800} {
		s, ok := DurationSeconds(name)
		if !ok || s == nil || *s != want {
			t.Fatalf("%s: %v %v", name, s, ok)
		}
		if back, ok := DurationName(s); !ok || back != name {
			t.Fatalf("%d: %q", want, back)
		}
	}
	if s, ok := DurationSeconds(DurationForever); !ok || s != nil {
		t.Fatal("forever has seconds")
	}
	if n, ok := DurationName(nil); !ok || n != DurationForever {
		t.Fatal("nil isn't forever")
	}
	if _, ok := DurationSeconds("month"); ok {
		t.Fatal("a month")
	}
	if _, ok := DurationName(Ptr(int64(60))); ok {
		t.Fatal("a minute")
	}
}

func TestHelpCodes(t *testing.T) {
	for range 50 {
		c, err := NewHelpCode()
		if err != nil || NormalizeHelpCode(c) != c {
			t.Fatalf("%q %v", c, err)
		}
	}
	for typed, ok := range map[string]bool{"KQ72MX": true, "kq7·2mx": true, "KQ7-2MX": true, "kq7 2mx": true,
		"KQ7.2MX": true, "KQ72M": false, "KQ72MXX": false, "KQ72MU": false, "": false, "support": false} {
		if HelpCodeMatches(typed, "KQ72MX") != ok {
			t.Errorf("%q", typed)
		}
	}
	// O, I and L are read as 0 and 1.
	if !HelpCodeMatches("OIL000", "011000") {
		t.Error("O I L")
	}
	if Who("Claude (op_7Hq2 via john)") != "Claude" {
		t.Error("who")
	}
}
