// Package wire implements the framing used on the agent <-> hub connection:
// length-prefixed CBOR messages on yamux streams, the yamux configuration,
// and the console frame format shared by the hub <-> agent stream and the
// browser <-> hub WebSocket.
package wire

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/hashicorp/yamux"

	"rackoon/internal/proto"
)

// MaxMessage bounds a single CBOR message (reports from hosts with many
// guests stay well below this).
const MaxMessage = 8 << 20

var (
	encMode cbor.EncMode
	decMode cbor.DecMode
)

func init() {
	var err error
	encMode, err = cbor.EncOptions{Time: cbor.TimeRFC3339Nano}.EncMode()
	if err != nil {
		panic(err)
	}
	decMode, err = cbor.DecOptions{MaxArrayElements: 1 << 20, MaxMapPairs: 1 << 20}.DecMode()
	if err != nil {
		panic(err)
	}
}

// Marshal encodes v as CBOR.
func Marshal(v any) ([]byte, error) { return encMode.Marshal(v) }

// Unmarshal decodes CBOR into v.
func Unmarshal(b []byte, v any) error { return decMode.Unmarshal(b, v) }

// WriteMsg writes v as one length-prefixed CBOR message.
func WriteMsg(w io.Writer, v any) error {
	b, err := Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > MaxMessage {
		return fmt.Errorf("wire: message too large (%d bytes)", len(b))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(b)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

// ReadMsg reads one length-prefixed CBOR message into v.
func ReadMsg(r io.Reader, v any) error {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > MaxMessage {
		return fmt.Errorf("wire: message too large (%d bytes)", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return err
	}
	return Unmarshal(b, v)
}

// SendEnvelope writes a control-stream message of the given type.
func SendEnvelope(w io.Writer, typ string, body any) error {
	b, err := Marshal(body)
	if err != nil {
		return err
	}
	return WriteMsg(w, proto.Envelope{Type: typ, Body: b})
}

// YamuxConfig is the yamux configuration used by both sides. Per-stream
// flow control keeps a slow console from stalling the control stream.
func YamuxConfig() *yamux.Config {
	c := yamux.DefaultConfig()
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 15 * time.Second
	c.ConnectionWriteTimeout = 20 * time.Second
	c.MaxStreamWindowSize = 1 << 20
	c.StreamOpenTimeout = 15 * time.Second
	c.StreamCloseTimeout = 30 * time.Second
	c.LogOutput = io.Discard
	return c
}

// ---- Console frames ----------------------------------------------------------
//
// A console session carries frames between browser, hub and agent:
//
//	kind (1 byte) | channel (2 bytes, big endian) | payload
//
// On the yamux stream each frame is additionally prefixed with a 4-byte
// payload length; on the browser WebSocket every binary message is exactly
// one frame. Kind:
//
//	FrameData    raw protocol bytes (PTY output/input, RFB, SPICE) for channel
//	FrameControl a JSON ConsoleControl message (channel is ignored, use 0)
//
// Channel 0 is the primary connection and is open from the start. SPICE uses
// additional channels, opened with a ConsoleControl{Type: "open"}.

// Frame kinds.
const (
	FrameData    byte = 0
	FrameControl byte = 1
)

// MaxFramePayload bounds a single console frame.
const MaxFramePayload = 1 << 20

// Frame is one console frame.
type Frame struct {
	Kind    byte
	Channel uint16
	Payload []byte
}

// FrameWriter writes frames to a stream. Not safe for concurrent use; wrap it
// with a mutex when several goroutines write.
type FrameWriter struct{ w io.Writer }

// NewFrameWriter returns a FrameWriter on w.
func NewFrameWriter(w io.Writer) *FrameWriter { return &FrameWriter{w: w} }

// Write writes one frame.
func (fw *FrameWriter) Write(f Frame) error {
	if len(f.Payload) > MaxFramePayload {
		return errors.New("wire: console frame too large")
	}
	var hdr [7]byte
	hdr[0] = f.Kind
	binary.BigEndian.PutUint16(hdr[1:3], f.Channel)
	binary.BigEndian.PutUint32(hdr[3:7], uint32(len(f.Payload)))
	if _, err := fw.w.Write(hdr[:]); err != nil {
		return err
	}
	if len(f.Payload) == 0 {
		return nil
	}
	_, err := fw.w.Write(f.Payload)
	return err
}

// FrameReader reads frames from a stream.
type FrameReader struct{ r *bufio.Reader }

// NewFrameReader returns a FrameReader on r.
func NewFrameReader(r io.Reader) *FrameReader { return &FrameReader{r: bufio.NewReaderSize(r, 64<<10)} }

// Read reads one frame. The returned payload is freshly allocated.
func (fr *FrameReader) Read() (Frame, error) {
	var hdr [7]byte
	if _, err := io.ReadFull(fr.r, hdr[:]); err != nil {
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(hdr[3:7])
	if n > MaxFramePayload {
		return Frame{}, errors.New("wire: console frame too large")
	}
	f := Frame{Kind: hdr[0], Channel: binary.BigEndian.Uint16(hdr[1:3]), Payload: make([]byte, n)}
	if _, err := io.ReadFull(fr.r, f.Payload); err != nil {
		return Frame{}, err
	}
	return f, nil
}

// EncodeWS encodes a frame as a browser WebSocket binary message.
func EncodeWS(f Frame) []byte {
	b := make([]byte, 3+len(f.Payload))
	b[0] = f.Kind
	binary.BigEndian.PutUint16(b[1:3], f.Channel)
	copy(b[3:], f.Payload)
	return b
}

// DecodeWS decodes a browser WebSocket binary message.
func DecodeWS(b []byte) (Frame, error) {
	if len(b) < 3 {
		return Frame{}, errors.New("wire: short console frame")
	}
	return Frame{Kind: b[0], Channel: binary.BigEndian.Uint16(b[1:3]), Payload: b[3:]}, nil
}

// ConsoleControl is the JSON body of a FrameControl frame. Types:
//
//	browser -> agent: "resize" {cols, rows}; "open"/"close" {channel} (SPICE
//	                  sub-channels); "ping" {id}; "activity" (user input seen,
//	                  sent at most every 30 s; the hub uses it for the idle
//	                  timeout and does not forward it)
//	agent -> browser: "status" {state, protocol, resolution}; "opened"/"closed"
//	                  {channel}; "pong" {id}; "error" {code, message}
//	hub -> browser:   "closed" {reason} when the hub ends the session
//	                  (idle, max age, revoked); "error" {code, message}
type ConsoleControl struct {
	Type       string `json:"type"`
	Channel    uint16 `json:"channel,omitempty"`
	Cols       int    `json:"cols,omitempty"`
	Rows       int    `json:"rows,omitempty"`
	ID         int64  `json:"id,omitempty"`
	State      string `json:"state,omitempty"` // "connected"
	Protocol   string `json:"protocol,omitempty"`
	Resolution string `json:"resolution,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
	Reason     string `json:"reason,omitempty"`
}
