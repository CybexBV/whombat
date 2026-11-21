package protocol

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"runtime"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

func TestAdmissionVectors(t *testing.T) {
	var v struct {
		JWKS  json.RawMessage `json:"jwks"`
		Cases []struct {
			Name     string `json:"name"`
			Token    string `json:"token"`
			Now      int64  `json:"now"`
			Audience string `json:"audience"`
			Issuer   string `json:"issuer"`
			Role     string `json:"role"`
			Worker   string `json:"worker"`
			Expect   string `json:"expect"`
			Close    int    `json:"close"`
		} `json:"cases"`
	}
	vectors.Load(t, "admission.json", &v)
	jwks, err := ParseAdmissionJwks(v.JWKS)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 20 {
		t.Fatalf("only %d cases", len(v.Cases))
	}
	for _, c := range v.Cases {
		_, claims, err := VerifyAdmissionTicket(c.Token, VerifyAdmissionOptions{
			JWKS: *jwks, Now: c.Now, Audience: c.Audience, Issuer: c.Issuer, Role: TicketRole(c.Role), Worker: c.Worker,
		})
		got := "ok"
		var ae *AdmissionError
		if errors.As(err, &ae) {
			got = string(ae.Code)
			if ae.CloseCode() != c.Close {
				t.Errorf("%s: close %d, want %d", c.Name, ae.CloseCode(), c.Close)
			}
		} else if err != nil {
			t.Fatalf("%s: unexpected error %v", c.Name, err)
		} else if claims == nil {
			t.Fatalf("%s: no claims", c.Name)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
	}
}

type frameJSON struct {
	Type       string `json:"type"`
	StreamID   uint32 `json:"streamId"`
	PayloadHex string `json:"payloadHex,omitempty"`
	Credit     uint32 `json:"credit,omitempty"`
	Code       uint16 `json:"code,omitempty"`
}

var frameTypes = map[string]uint8{
	"control": FrameTypeControl, "data": FrameTypeData, "credit": FrameTypeCredit, "end": FrameTypeEnd, "reset": FrameTypeReset,
}

func TestFrameVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Name    string      `json:"name"`
			Hex     string      `json:"hex"`
			Frames  []frameJSON `json:"frames"`
			Pending int         `json:"pending"`
			Error   string      `json:"error"`
		} `json:"cases"`
	}
	vectors.Load(t, "frames.json", &v)
	for _, c := range v.Cases {
		data, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		var d FrameDecoder
		frames, err := d.Push(data)
		if c.Error != "" {
			var fe *FrameError
			if !errors.As(err, &fe) || string(fe.Code) != c.Error {
				t.Errorf("%s: got %v, want %s", c.Name, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if len(frames) != len(c.Frames) || d.Pending() != c.Pending {
			t.Fatalf("%s: got %d frames, %d pending", c.Name, len(frames), d.Pending())
		}
		var encoded []byte
		for i, want := range c.Frames {
			got := frames[i]
			wantPayload, _ := hex.DecodeString(want.PayloadHex)
			if got.Type != frameTypes[want.Type] || got.StreamID != want.StreamID || got.Credit != want.Credit ||
				got.Code != want.Code || hex.EncodeToString(got.Payload) != hex.EncodeToString(wantPayload) {
				t.Errorf("%s: frame %d = %+v, want %+v", c.Name, i, got, want)
			}
			b, err := EncodeFrame(got)
			if err != nil {
				t.Fatalf("%s: encode: %v", c.Name, err)
			}
			encoded = append(encoded, b...)
		}
		if c.Pending == 0 && hex.EncodeToString(encoded) != c.Hex {
			t.Errorf("%s: re-encoding differs", c.Name)
		}
	}
}

func TestFrameDecoderSplits(t *testing.T) {
	a, _ := EncodeFrame(Frame{Type: FrameTypeData, StreamID: 1, Payload: []byte{1, 2, 3}})
	b, _ := EncodeFrame(Frame{Type: FrameTypeEnd, StreamID: 1})
	stream := append(a, b...)
	var d FrameDecoder
	var got []Frame
	for _, x := range stream {
		fs, err := d.Push([]byte{x})
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, fs...)
	}
	if len(got) != 2 || got[1].Type != FrameTypeEnd || d.Pending() != 0 {
		t.Fatalf("got %+v", got)
	}
}

// A maximal frame fed one byte at a time must not be copied per byte (review L-6 / SC-07 in Go): the decoder's
// total allocation stays linear in the input.
func TestFrameDecoderLinear(t *testing.T) {
	payload := make([]byte, SessionMaxDataBytes)
	enc, err := EncodeFrame(Frame{Type: FrameTypeData, StreamID: 1, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	stream := append(append([]byte{}, enc...), enc...)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	var d FrameDecoder
	got := 0
	for i := range stream {
		fs, err := d.Push(stream[i : i+1])
		if err != nil {
			t.Fatal(err)
		}
		got += len(fs)
	}
	runtime.ReadMemStats(&after)
	if got != 2 || d.Pending() != 0 {
		t.Fatalf("got %d frames, %d pending", got, d.Pending())
	}
	// Quadratic accumulation would allocate ~2 × 64 KiB × 64 KiB ≈ 8 GiB; linear is a few MiB.
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
		t.Fatalf("decoding %d bytes allocated %d bytes", len(stream), alloc)
	}
}

func TestLicenceVectors(t *testing.T) {
	var v struct {
		KeySet json.RawMessage `json:"keySet"`
		Cases  []struct {
			Name   string          `json:"name"`
			Token  string          `json:"token"`
			Device string          `json:"device"`
			Now    int64           `json:"now"`
			KeySet json.RawMessage `json:"keySet"`
			Expect string          `json:"expect"`
		} `json:"cases"`
		Status []struct {
			Name  string `json:"name"`
			Input struct {
				Claims    *LicenceClaims `json:"claims"`
				Now       int64          `json:"now"`
				HighWater int64          `json:"highWater"`
				ClockMark int64          `json:"clockMark"`
				ClaimedAt *int64         `json:"claimedAt"`
				GraceS    int64          `json:"graceS"`
			} `json:"input"`
			Expect json.RawMessage `json:"expect"`
		} `json:"status"`
	}
	vectors.Load(t, "licence.json", &v)
	keySet, err := ParseLicenceKeySet(v.KeySet)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 25 || len(v.Status) < 15 {
		t.Fatalf("only %d cases, %d status cases", len(v.Cases), len(v.Status))
	}
	for _, c := range v.Cases {
		ks := keySet
		if c.KeySet != nil {
			if ks, err = ParseLicenceKeySet(c.KeySet); err != nil {
				t.Fatalf("%s: %v", c.Name, err)
			}
		}
		_, claims, err := VerifyLicenceToken(c.Token, VerifyLicenceOptions{KeySet: *ks, Device: c.Device, Now: c.Now})
		got := "ok"
		var le *LicenceError
		if errors.As(err, &le) {
			got = string(le.Code)
		} else if err != nil {
			t.Fatalf("%s: unexpected error %v", c.Name, err)
		} else if claims == nil {
			t.Fatalf("%s: no claims", c.Name)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
	}
	for _, c := range v.Status {
		in := c.Input
		got := LicenceStatus(LicenceStatusParams{
			Claims: in.Claims, Now: in.Now, HighWater: in.HighWater, ClockMark: in.ClockMark, ClaimedAt: in.ClaimedAt, GraceS: in.GraceS,
		})
		b, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		var gotAny, wantAny any
		if err := json.Unmarshal(b, &gotAny); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(c.Expect, &wantAny); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(gotAny, wantAny) {
			t.Errorf("%s: got %s, want %s", c.Name, b, c.Expect)
		}
		if got != nil {
			if err := got.Validate(); err != nil {
				t.Errorf("%s: %v", c.Name, err)
			}
		}
	}
}
