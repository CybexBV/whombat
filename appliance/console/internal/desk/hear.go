package desk

// Talk's mic is voice typing (Whombat dictation.md; contracts 3.3 `DESK_PATHS.hear`, `DeskHearRequest`, `DeskHeard`;
// CG-359…CG-363): the page records until *Done* (at most voice typing's five minutes), the console checks the WAV and
// passes it on, and the runtime answers the words it heard for Talk's box. Nothing is sent to the assistant here: the
// person sends the words afterwards as a typed question with `spoken`. The runtime takes it only while the screen is
// unlocked (409 `locked`), with Talk's voice on (503 `voice_unavailable`), one at a time (409 `busy`).

import (
	"context"
	"encoding/base64"
	"math"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathHear is DESK_PATHS.hear.
const PathHear = local.DeskPathHear

// MaxHearSeconds is voice typing's five minutes (VOICE_TYPING_MAX_SECONDS).
const MaxHearSeconds = local.VoiceTypingMaxSeconds

type (
	// HearRequest is DeskHearRequest.
	HearRequest = local.DeskHearRequest
	// Heard is DeskHeard.
	Heard = local.DeskHeard
)

// HearTimeout is how long the box may take to hear a recording of seconds: three times its length, at least 90 s (the
// speech service's queue, the runtime's transcribeTimeoutMs), and a little more. The console server keeps the page's
// request open as long.
func HearTimeout(seconds float64) time.Duration {
	return max(90*time.Second, time.Duration(math.Ceil(seconds*3))*time.Second) + 10*time.Second
}

// HearSeconds is how long a recording the page sent is, from its base64's length (16 kHz mono 16-bit PCM).
func HearSeconds(audioWav string) float64 {
	return float64(max(0, base64.StdEncoding.DecodedLen(len(audioWav))-44)) / float64(talkRate*2)
}

// Hear passes a recording from Talk's mic on and answers the words heard, cleaned to one line of at most
// DESK_TALK_TEXT_MAX characters (empty: nothing was heard). A WAV that isn't 16 kHz mono 16-bit PCM of at most five
// minutes is 400 `bad_audio` without asking; the runtime's refusals pass on with their codes.
func (c *Client) Hear(ctx context.Context, audioWav string) (*Heard, error) {
	wav, err := base64.StdEncoding.DecodeString(audioWav)
	if err != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	if err := checkWav(wav, MaxHearSeconds); err != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadAudio}
	}
	req := &HearRequest{V: 1, AudioWav: audioWav}
	if req.Validate() != nil {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	timeout := c.hearTimeout(HearSeconds(audioWav))
	h, err := post(c, ctx, PathHear, req, timeout, local.ParseDeskHeard)
	if err != nil {
		return nil, err
	}
	h.Text = line(h.Text, local.DeskTalkTextMax)
	return h, nil
}
