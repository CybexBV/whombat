package wire

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestMsgRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := proto.Hello{ProtocolVersion: proto.Version, AgentVersion: "v1", Hostname: "h"}
	if err := WriteMsg(&buf, in); err != nil {
		t.Fatal(err)
	}
	var out proto.Hello
	if err := ReadMsg(&buf, &out); err != nil {
		t.Fatal(err)
	}
	if out.AgentVersion != "v1" || out.Hostname != "h" || out.ProtocolVersion != proto.Version {
		t.Fatalf("%+v", out)
	}
}

func TestOversizeMessageRefused(t *testing.T) {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], MaxMessage+1)
	var v map[string]any
	if err := ReadMsg(bytes.NewReader(hdr[:]), &v); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversize length accepted: %v", err)
	}
	big := struct{ B []byte }{B: make([]byte, MaxMessage)}
	if err := WriteMsg(&bytes.Buffer{}, big); err == nil {
		t.Fatal("oversize message written")
	}
}

func TestUnknownFieldsAreIgnored(t *testing.T) {
	// Older peers must accept messages with fields they do not know.
	type newer struct {
		Version int    `cbor:"pv"`
		Extra   string `cbor:"extra_field"`
	}
	b, _ := Marshal(newer{Version: 1, Extra: "x"})
	var h proto.Hello
	if err := Unmarshal(b, &h); err != nil || h.ProtocolVersion != 1 {
		t.Fatalf("decode with an unknown field: %v %+v", err, h)
	}
}

func TestFrames(t *testing.T) {
	var buf bytes.Buffer
	fw := NewFrameWriter(&buf)
	frames := []Frame{{Kind: FrameData, Channel: 0, Payload: []byte("hello")}, {Kind: FrameControl, Channel: 3, Payload: []byte(`{"type":"open"}`)}, {Kind: FrameData, Channel: 1}}
	for _, f := range frames {
		if err := fw.Write(f); err != nil {
			t.Fatal(err)
		}
	}
	fr := NewFrameReader(&buf)
	for _, want := range frames {
		got, err := fr.Read()
		if err != nil || got.Kind != want.Kind || got.Channel != want.Channel || !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("got %+v %v, want %+v", got, err, want)
		}
	}
	if err := fw.Write(Frame{Payload: make([]byte, MaxFramePayload+1)}); err == nil {
		t.Fatal("oversize frame written")
	}
	var hdr [7]byte
	binary.BigEndian.PutUint32(hdr[3:], MaxFramePayload+1)
	if _, err := NewFrameReader(bytes.NewReader(hdr[:])).Read(); err == nil {
		t.Fatal("oversize frame read")
	}
}

func TestWSFrames(t *testing.T) {
	f := Frame{Kind: FrameControl, Channel: 513, Payload: []byte("x")}
	got, err := DecodeWS(EncodeWS(f))
	if err != nil || got.Kind != f.Kind || got.Channel != 513 || string(got.Payload) != "x" {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := DecodeWS([]byte{1, 2}); err == nil {
		t.Fatal("short frame accepted")
	}
}

func FuzzDecodeWS(f *testing.F) {
	f.Add([]byte{0, 0, 0})
	f.Add([]byte{1, 0, 1, '{', '}'})
	f.Fuzz(func(t *testing.T, b []byte) {
		fr, err := DecodeWS(b)
		if err == nil && len(fr.Payload) != len(b)-3 {
			t.Fatal("payload length")
		}
	})
}

func FuzzReadMsg(f *testing.F) {
	var buf bytes.Buffer
	_ = WriteMsg(&buf, proto.Report{})
	f.Add(buf.Bytes())
	f.Fuzz(func(t *testing.T, b []byte) {
		var r proto.Report
		_ = ReadMsg(bytes.NewReader(b), &r) // must not panic
	})
}

func TestOOMSplitIsAdditive(t *testing.T) {
	// LM-04: a new agent's split reaches a new hub, zero included; an old
	// hub (SystemInfo without the split) reads it; an old agent's report
	// leaves the split nil.
	zero := uint64(0)
	in := proto.SystemInfo{OOMKills: 3, OOMLimitKills: &zero,
		OOMLimited: []proto.OOMKill{{Process: "python3", Cgroup: "/system.slice/docker-ab.scope", Platform: "docker", GuestID: "web"}}}
	b, err := Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out proto.SystemInfo
	if err := Unmarshal(b, &out); err != nil || out.OOMLimitKills == nil || *out.OOMLimitKills != 0 || len(out.OOMLimited) != 1 ||
		out.OOMLimited[0].GuestID != "web" {
		t.Fatalf("new → new: %v %+v", err, out)
	}
	type oldSystem struct {
		OOMKills uint64 `cbor:"oom,omitempty"`
	}
	var old oldSystem
	if err := Unmarshal(b, &old); err != nil || old.OOMKills != 3 {
		t.Fatalf("new → old: %v %+v", err, old)
	}
	b, _ = Marshal(oldSystem{OOMKills: 3})
	out = proto.SystemInfo{}
	if err := Unmarshal(b, &out); err != nil || out.OOMKills != 3 || out.OOMLimitKills != nil || out.OOMLimited != nil {
		t.Fatalf("old → new: %v %+v", err, out)
	}
}
