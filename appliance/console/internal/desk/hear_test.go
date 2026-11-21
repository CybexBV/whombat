package desk_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// CG-363: Talk's mic passes its recording on and gets the words for the box, cleaned to one line of at most 1000
// characters; a recording the voice service couldn't take never reaches the runtime.
func TestHear(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathHear, desktest.Answer{Body: `{"v":1,"text":"Is pve-02 okay?"}`})
	audio := base64.StdEncoding.EncodeToString(wav(16000, 1, 16, 2*16000))
	h, err := c.Hear(ctx, audio)
	if err != nil || h.Text != "Is pve-02 okay?" {
		t.Fatal(h, err)
	}
	var sent desk.HearRequest
	if err := json.Unmarshal([]byte(f.Calls()[len(f.Calls())-1].Body), &sent); err != nil || sent.V != 1 || sent.AudioWav != audio {
		t.Fatal("the recording wasn't passed on as it was", err)
	}
	// Nothing heard is an empty answer, not a refusal.
	f.Set(desk.PathHear, desktest.Answer{Body: `{"v":1,"text":""}`})
	if h, err := c.Hear(ctx, audio); err != nil || h.Text != "" {
		t.Fatal(h, err)
	}
	// Five minutes is voice typing's limit, longer is bad audio; a WAV the service can't take neither goes.
	calls := f.CallsTo(desk.PathHear)
	five := base64.StdEncoding.EncodeToString(wav(16000, 1, 16, desk.MaxHearSeconds*16000))
	if _, err := c.Hear(ctx, five); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]struct{ audio, code string }{
		"longer":     {base64.StdEncoding.EncodeToString(wav(16000, 1, 16, desk.MaxHearSeconds*16000+16)), "bad_audio"},
		"stereo":     {base64.StdEncoding.EncodeToString(wav(16000, 2, 16, 16000)), "bad_audio"},
		"not base64": {"RIFF!!", "bad_request"},
	} {
		if _, err := c.Hear(ctx, bad.audio); !isErr(err, 400, bad.code) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if n := f.CallsTo(desk.PathHear); n != calls+1 {
		t.Fatalf("a bad recording reached the runtime (%d)", n-calls-1)
	}
	// The runtime's refusals pass on with their codes.
	for _, r := range []struct {
		status int
		code   string
	}{{409, "locked"}, {409, "busy"}, {503, "voice_unavailable"}, {413, "too_large"}} {
		f.Set(desk.PathHear, desktest.Answer{Status: r.status, Body: `{"error":{"code":"` + r.code + `","message":"x"}}`})
		if _, err := c.Hear(ctx, audio); !isErr(err, r.status, r.code) {
			t.Errorf("%d %s: %v", r.status, r.code, err)
		}
	}
	// Words the contract refuses (a format character, past 1000 characters) are no answer.
	for _, body := range []string{"{\"v\":1,\"text\":\"Is\\u202epve-02 okay?\"}", `{"v":1,"text":"` + strings.Repeat("x", 1001) + `"}`} {
		f.Set(desk.PathHear, desktest.Answer{Body: body})
		if h, err := c.Hear(ctx, audio); !isErr(err, 502, "failed") {
			t.Fatal(h, err)
		}
	}
}

// CG-363: the console waits as long as the box may take to hear a recording, and a runtime that doesn't answer in that
// time is unavailable.
func TestHearWaits(t *testing.T) {
	if got := desk.HearTimeout(2); got != 100*time.Second {
		t.Fatal(got)
	}
	if got := desk.HearTimeout(desk.MaxHearSeconds); got != 910*time.Second {
		t.Fatal(got)
	}
	audio := base64.StdEncoding.EncodeToString(wav(16000, 1, 16, 4*16000))
	if s := desk.HearSeconds(audio); s < 3.99 || s > 4.01 {
		t.Fatal(s)
	}
	f := desktest.Start(t)
	c := desk.NewForTest(f.Socket, os.Getuid(), 50*time.Millisecond)
	f.Hold()
	if _, err := c.Hear(context.Background(), audio); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatal(err)
	}
}
