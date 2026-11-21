package local

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func TestRemoteHelpVectors(t *testing.T) {
	var v struct {
		HelpCodes []struct {
			Input string  `json:"input"`
			Code  *string `json:"code"`
		} `json:"helpCodes"`
		HelpCodeFormats []struct {
			Code  string `json:"code"`
			Shown string `json:"shown"`
		} `json:"helpCodeFormats"`
		HelpCodeBytes []struct {
			Random string `json:"random"`
			Code   string `json:"code"`
		} `json:"helpCodeBytes"`
		RemoteHelpWhos []struct {
			KeyID string `json:"keyId"`
			Who   string `json:"who"`
		} `json:"remoteHelpWhos"`
		RemoteHelpDurations []struct {
			Duration protocol.RemoteHelpDuration `json:"duration"`
			Seconds  *int64                      `json:"seconds"`
		} `json:"remoteHelpDurations"`
		RemoteHelpSteps []struct {
			Step  json.RawMessage `json:"step"`
			Valid bool            `json:"valid"`
		} `json:"remoteHelpSteps"`
		SupportStates []struct {
			State json.RawMessage `json:"state"`
			Valid bool            `json:"valid"`
		} `json:"supportStates"`
		SupportEvents []struct {
			Event json.RawMessage `json:"event"`
			Valid bool            `json:"valid"`
		} `json:"supportEvents"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.HelpCodes) == 0 || len(v.RemoteHelpWhos) == 0 || len(v.SupportStates) == 0 || len(v.SupportEvents) == 0 ||
		len(v.RemoteHelpSteps) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.HelpCodes {
		code, ok := NormalizeHelpCode(c.Input)
		if ok != (c.Code != nil) || (ok && code != *c.Code) {
			t.Errorf("NormalizeHelpCode(%q) = %q, %v; want %v", c.Input, code, ok, c.Code)
		}
	}
	for _, c := range v.HelpCodeFormats {
		if got := FormatHelpCode(c.Code); got != c.Shown {
			t.Errorf("FormatHelpCode(%q) = %q, want %q", c.Code, got, c.Shown)
		}
	}
	for _, c := range v.HelpCodeBytes {
		b, err := hex.DecodeString(c.Random)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := HelpCodeFromBytes(b); err != nil || got != c.Code {
			t.Errorf("HelpCodeFromBytes(%s) = %q, %v; want %q", c.Random, got, err, c.Code)
		}
		if got, err := GenerateHelpCode(bytes.NewReader(b)); err != nil || got != c.Code {
			t.Errorf("GenerateHelpCode(%s) = %q, %v; want %q", c.Random, got, err, c.Code)
		}
	}
	for _, c := range v.RemoteHelpWhos {
		if got := RemoteHelpWho(c.KeyID); got != c.Who {
			t.Errorf("RemoteHelpWho(%q) = %q, want %q", c.KeyID, got, c.Who)
		}
	}
	for _, c := range v.RemoteHelpDurations {
		got, ok := RemoteHelpDurationSeconds(c.Duration)
		if !ok || (got == nil) != (c.Seconds == nil) || (got != nil && *got != *c.Seconds) {
			t.Errorf("RemoteHelpDurationSeconds(%s) = %v, %v; want %v", c.Duration, got, ok, c.Seconds)
		}
	}
	if _, ok := RemoteHelpDurationSeconds("month"); ok {
		t.Error("RemoteHelpDurationSeconds(month) is ok")
	}
	for _, c := range v.RemoteHelpSteps {
		// A step travels inside a visit; parse it there so the schema checks it too.
		a, err := ParseSupportVisitsAnswer([]byte(`{"v":1,"visits":[{"id":"1","who":"Claude","level":"fix",` +
			`"startedAt":"2026-10-21T14:00:00Z","endedAt":null,"truncated":false,"transcriptBytes":0,"steps":[` +
			string(c.Step) + `]}]}`))
		if err != nil {
			t.Fatalf("%s: %v", c.Step, err)
		}
		if got := RemoteHelpStepValid(a.Visits[0].Steps[0]); got != c.Valid {
			t.Errorf("RemoteHelpStepValid(%s) = %v, want %v", c.Step, got, c.Valid)
		}
	}
	for _, c := range v.SupportStates {
		s, err := ParseSupportState(c.State)
		if err != nil {
			t.Fatalf("%s: %v", c.State, err)
		}
		if got := SupportStateValid(*s); got != c.Valid {
			t.Errorf("SupportStateValid(%s) = %v, want %v", c.State, got, c.Valid)
		}
	}
	for _, c := range v.SupportEvents {
		a, err := ParseSupportEventsAnswer([]byte(`{"v":1,"next":99,"events":[` + string(c.Event) + `]}`))
		if err != nil {
			t.Fatalf("%s: %v", c.Event, err)
		}
		if got := SupportEventValid(a.Events[0]); got != c.Valid {
			t.Errorf("SupportEventValid(%s) = %v, want %v", c.Event, got, c.Valid)
		}
	}
}

func TestSupportErrorStatus(t *testing.T) {
	if len(SupportErrorStatus) != 6 || SupportErrorStatus[SupportErrorForeverNotAllowed] != 403 ||
		SupportErrorStatus[SupportErrorUnavailable] != 503 {
		t.Fatalf("SupportErrorStatus = %v", SupportErrorStatus)
	}
}

func TestGenerateHelpCodeShortRead(t *testing.T) {
	if _, err := GenerateHelpCode(bytes.NewReader([]byte{1, 2, 3})); err == nil {
		t.Fatal("a short read made a code")
	}
}
