package protocol

import (
	"encoding/binary"
	"fmt"
)

// FrameErrorCode mirrors FrameErrorCode in @whombat/protocol.
type FrameErrorCode string

const (
	FrameTooLarge       FrameErrorCode = "frame_too_large"
	FrameTooShort       FrameErrorCode = "frame_too_short"
	FrameUnknownType    FrameErrorCode = "unknown_type"
	FrameBadStream      FrameErrorCode = "bad_stream"
	FrameBadPayload     FrameErrorCode = "bad_payload"
	FrameBufferOverflow FrameErrorCode = "buffer_overflow"
)

// FrameError is a framing violation; the session must be closed.
type FrameError struct {
	Code    FrameErrorCode
	Message string
}

func (e *FrameError) Error() string { return fmt.Sprintf("frame: %s: %s", e.Code, e.Message) }

// Frame is one session frame. Payload is set for CONTROL and DATA, Credit for CREDIT, Code for RESET.
type Frame struct {
	Type     uint8
	StreamID uint32
	Payload  []byte
	Credit   uint32
	Code     uint16
}

func frameErr(code FrameErrorCode, format string, args ...any) error {
	return &FrameError{Code: code, Message: fmt.Sprintf(format, args...)}
}

func checkStream(t uint8, stream uint32) error {
	if (t == FrameTypeControl) != (stream == ControlStreamID) {
		return frameErr(FrameBadStream, "type %d on stream %d", t, stream)
	}
	return nil
}

func checkPayload(t uint8, n int) error {
	switch t {
	case FrameTypeControl, FrameTypeData:
		limit := SessionMaxControlBytes
		if t == FrameTypeData {
			limit = SessionMaxDataBytes
		}
		if n < 1 {
			return frameErr(FrameBadPayload, "empty payload")
		}
		if n > limit {
			return frameErr(FrameTooLarge, "payload of %d bytes", n)
		}
	case FrameTypeCredit:
		if n != 4 {
			return frameErr(FrameBadPayload, "credit must be 4 bytes")
		}
	case FrameTypeEnd:
		if n != 0 {
			return frameErr(FrameBadPayload, "end must be empty")
		}
	case FrameTypeReset:
		if n != 2 {
			return frameErr(FrameBadPayload, "reset must be 2 bytes")
		}
	default:
		return frameErr(FrameUnknownType, "unknown frame type 0x%x", t)
	}
	return nil
}

// EncodeFrame encodes f with its u32 length prefix.
func EncodeFrame(f Frame) ([]byte, error) {
	var payload []byte
	switch f.Type {
	case FrameTypeControl, FrameTypeData:
		payload = f.Payload
	case FrameTypeCredit:
		if f.Credit < 1 || f.Credit > SessionMaxStreamCredit {
			return nil, frameErr(FrameBadPayload, "credit %d out of range", f.Credit)
		}
		payload = binary.BigEndian.AppendUint32(nil, f.Credit)
	case FrameTypeEnd:
	case FrameTypeReset:
		payload = binary.BigEndian.AppendUint16(nil, f.Code)
	default:
		return nil, frameErr(FrameUnknownType, "unknown frame type 0x%x", f.Type)
	}
	if err := checkStream(f.Type, f.StreamID); err != nil {
		return nil, err
	}
	if err := checkPayload(f.Type, len(payload)); err != nil {
		return nil, err
	}
	out := make([]byte, 0, FrameHeaderBytes+len(payload))
	out = binary.BigEndian.AppendUint32(out, uint32(5+len(payload)))
	out = append(out, f.Type)
	out = binary.BigEndian.AppendUint32(out, f.StreamID)
	return append(out, payload...), nil
}

// DecodeFrameBody decodes `[type][streamId][payload]` (without the length prefix).
func DecodeFrameBody(body []byte) (Frame, error) {
	if len(body) < 5 {
		return Frame{}, frameErr(FrameTooShort, "frame body shorter than 5 bytes")
	}
	if len(body) > SessionMaxFrameBodyBytes {
		return Frame{}, frameErr(FrameTooLarge, "frame too large")
	}
	t := body[0]
	if t < FrameTypeControl || t > FrameTypeReset {
		return Frame{}, frameErr(FrameUnknownType, "unknown frame type 0x%x", t)
	}
	f := Frame{Type: t, StreamID: binary.BigEndian.Uint32(body[1:5])}
	if err := checkStream(t, f.StreamID); err != nil {
		return Frame{}, err
	}
	payload := body[5:]
	if err := checkPayload(t, len(payload)); err != nil {
		return Frame{}, err
	}
	switch t {
	case FrameTypeControl, FrameTypeData:
		f.Payload = append([]byte(nil), payload...)
	case FrameTypeCredit:
		f.Credit = binary.BigEndian.Uint32(payload)
		if f.Credit < 1 || f.Credit > SessionMaxStreamCredit {
			return Frame{}, frameErr(FrameBadPayload, "credit %d out of range", f.Credit)
		}
	case FrameTypeReset:
		f.Code = binary.BigEndian.Uint16(payload)
	}
	return f, nil
}

// FrameDecoder decodes frames from a byte stream, buffering at most one incomplete frame. It runs in time linear
// in its input however the stream is split: bytes are appended (amortized), and only the unconsumed tail — which
// after a completed frame came from the current chunk — is moved to the front. After an error it stays failed.
type FrameDecoder struct {
	buf    []byte
	failed bool
}

// Push feeds bytes and returns the frames they complete. On error it returns no frames (like the TypeScript
// decoder, which throws) and the session must close.
func (d *FrameDecoder) Push(chunk []byte) ([]Frame, error) {
	if d.failed {
		return nil, frameErr(FrameBufferOverflow, "decoder failed earlier")
	}
	d.buf = append(d.buf, chunk...)
	var frames []Frame
	start := 0
	for len(d.buf)-start >= 4 {
		n := binary.BigEndian.Uint32(d.buf[start:])
		if n < 5 {
			d.failed, d.buf = true, nil
			return nil, frameErr(FrameTooShort, "frame length %d", n)
		}
		if n > SessionMaxFrameBodyBytes {
			d.failed, d.buf = true, nil
			return nil, frameErr(FrameTooLarge, "frame length %d", n)
		}
		if uint32(len(d.buf)-start-4) < n {
			break
		}
		f, err := DecodeFrameBody(d.buf[start+4 : start+4+int(n)])
		if err != nil {
			d.failed, d.buf = true, nil
			return nil, err
		}
		frames = append(frames, f)
		start += 4 + int(n)
	}
	if start > 0 {
		rest := copy(d.buf, d.buf[start:])
		d.buf = d.buf[:rest]
	}
	return frames, nil
}

// Pending is the number of buffered bytes of an incomplete frame.
func (d *FrameDecoder) Pending() int { return len(d.buf) }
