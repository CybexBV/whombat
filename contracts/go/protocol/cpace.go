package protocol

import (
	"crypto/sha512"
	"errors"
	"io"

	"github.com/gtank/ristretto255"
)

// CPace, cipher suite CPACE-RISTR255-SHA512, initiator-responder setting, exactly as draft-irtf-cfrg-cpace-21
// (checked against Appendix B.3), identical to cpace.ts in @whombat/protocol. K is never exposed.

// CPaceSuite and CPaceDSI (G_Ristretto255.DSI) are in constants_gen.go.
const cpaceSInBytes = 128

// ErrCPaceInvalidShare means the peer's share doesn't decode or scalar_mult_vfy gave the neutral element: abort.
var ErrCPaceInvalidShare = errors.New("cpace: the peer's share is invalid (abort)")

// CPaceIdentity is G.I, the encoding of the neutral element (32 zero bytes).
var CPaceIdentity = make([]byte, 32)

// CPacePrependLen is prepend_len (A.1.1): the LEB128 length of data, then data.
func CPacePrependLen(data []byte) []byte {
	var out []byte
	n := len(data)
	for {
		if n < 128 {
			out = append(out, byte(n))
		} else {
			out = append(out, byte(n&0x7f)|0x80)
		}
		n >>= 7
		if n == 0 {
			break
		}
	}
	return append(out, data...)
}

// CPaceLVCat is lv_cat (A.1.3).
func CPaceLVCat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, CPacePrependLen(p)...)
	}
	return out
}

// CPaceGeneratorString is generator_string(DSI, PRS, CI, sid, s_in_bytes) (A.2) with SHA-512's block size.
func CPaceGeneratorString(dsi, prs, ci, sid []byte) []byte {
	zpad := max(0, cpaceSInBytes-1-len(CPacePrependLen(prs))-len(CPacePrependLen(dsi)))
	return CPaceLVCat(dsi, prs, make([]byte, zpad), ci, sid)
}

func cpaceGeneratorElement(prs, ci, sid []byte) *ristretto255.Element {
	h := sha512.Sum512(CPaceGeneratorString([]byte(CPaceDSI), prs, ci, sid))
	g, err := ristretto255.NewElement().SetUniformBytes(h[:])
	if err != nil {
		panic(err) // 64 bytes by construction
	}
	return g
}

// CPaceGenerator is G.calculate_generator(H, PRS, CI, sid) (§8.3), encoded.
func CPaceGenerator(prs, ci, sid []byte) []byte { return cpaceGeneratorElement(prs, ci, sid).Bytes() }

func cpaceScalar(y []byte) (*ristretto255.Scalar, error) {
	if len(y) != 32 {
		return nil, errors.New("cpace: scalars are 32 bytes")
	}
	wide := make([]byte, 64)
	copy(wide, y)
	return ristretto255.NewScalar().SetUniformBytes(wide) // y mod l
}

// CPaceSampleScalar is G.sample_scalar() (§8.3, recommended form): 32 random bytes with the bits above bit 252
// cleared, little-endian. A zero scalar is drawn again.
func CPaceSampleScalar(r io.Reader) ([]byte, error) {
	for range 8 {
		y := make([]byte, 32)
		if _, err := io.ReadFull(r, y); err != nil {
			return nil, err
		}
		y[31] &= 0x0f
		for _, b := range y {
			if b != 0 {
				return y, nil
			}
		}
	}
	return nil, errors.New("cpace: the randomness source keeps returning zero scalars")
}

// CPaceShare is G.scalar_mult(y, g) for the generator of (PRS, CI, sid).
func CPaceShare(y, prs, ci, sid []byte) ([]byte, error) {
	s, err := cpaceScalar(y)
	if err != nil {
		return nil, err
	}
	if s.Equal(ristretto255.NewScalar()) == 1 {
		return nil, errors.New("cpace: zero scalar")
	}
	return ristretto255.NewElement().ScalarMult(s, cpaceGeneratorElement(prs, ci, sid)).Bytes(), nil
}

// CPaceScalarMultVfy is G.scalar_mult_vfy(y, X) (§8.3): G.I when X doesn't decode, else encode(y * decode(X)).
func CPaceScalarMultVfy(y, x []byte) []byte {
	s, err := cpaceScalar(y)
	if err != nil {
		return append([]byte(nil), CPaceIdentity...)
	}
	p, err := ristretto255.NewElement().SetCanonicalBytes(x)
	if err != nil {
		return append([]byte(nil), CPaceIdentity...)
	}
	return ristretto255.NewElement().ScalarMult(s, p).Bytes()
}

func cpaceIsIdentity(k []byte) bool {
	if len(k) != 32 {
		return false
	}
	var acc byte
	for _, b := range k {
		acc |= b
	}
	return acc == 0
}

// CPaceTranscriptIR is transcript_ir(Ya, ADa, Yb, ADb) = lv_cat(Ya, ADa) || lv_cat(Yb, ADb) (A.3.4).
func CPaceTranscriptIR(ya, adA, yb, adB []byte) []byte {
	return append(CPaceLVCat(ya, adA), CPaceLVCat(yb, adB)...)
}

// CPaceISK is H.hash(lv_cat(G.DSI || "_ISK", sid, K) || transcript) (§7.2).
func CPaceISK(sid, k, transcript []byte) []byte {
	h := sha512.New()
	h.Write(CPaceLVCat([]byte(CPaceDSI+"_ISK"), sid, k))
	h.Write(transcript)
	return h.Sum(nil)
}

// CPaceInputs are what both parties share: PRS, CI and sid.
type CPaceInputs struct {
	PRS, CI, SID []byte
}

// CPaceResult is what a party ends with: ISK and the transcript it was computed over.
type CPaceResult struct {
	ISK, Transcript []byte
}

// CPaceInitiator is party A between its message and B's answer. Keep it in memory only.
type CPaceInitiator struct {
	inputs CPaceInputs
	y      []byte
	// Share is Ya, to send to B (with AD).
	Share []byte
	AD    []byte
}

// NewCPaceInitiator samples ya and computes Ya = scalar_mult(ya, g).
func NewCPaceInitiator(in CPaceInputs, r io.Reader, ad []byte) (*CPaceInitiator, error) {
	y, err := CPaceSampleScalar(r)
	if err != nil {
		return nil, err
	}
	share, err := CPaceShare(y, in.PRS, in.CI, in.SID)
	if err != nil {
		return nil, err
	}
	return &CPaceInitiator{inputs: in, y: y, Share: share, AD: ad}, nil
}

// Finish computes K = scalar_mult_vfy(ya, Yb), aborts with ErrCPaceInvalidShare if K = G.I, else returns ISK.
func (a *CPaceInitiator) Finish(yb, adB []byte) (CPaceResult, error) {
	k := CPaceScalarMultVfy(a.y, yb)
	if cpaceIsIdentity(k) {
		return CPaceResult{}, ErrCPaceInvalidShare
	}
	t := CPaceTranscriptIR(a.Share, a.AD, yb, adB)
	return CPaceResult{ISK: CPaceISK(a.inputs.SID, k, t), Transcript: t}, nil
}

// CPaceRespond is party B on A's Ya: Yb = scalar_mult(yb, g), K = scalar_mult_vfy(yb, Ya), abort with
// ErrCPaceInvalidShare if K = G.I, else ISK. Send Yb (and ADb) back.
func CPaceRespond(in CPaceInputs, ya, adA, adB []byte, r io.Reader) (share []byte, res CPaceResult, err error) {
	y, err := CPaceSampleScalar(r)
	if err != nil {
		return nil, CPaceResult{}, err
	}
	share, err = CPaceShare(y, in.PRS, in.CI, in.SID)
	if err != nil {
		return nil, CPaceResult{}, err
	}
	k := CPaceScalarMultVfy(y, ya)
	if cpaceIsIdentity(k) {
		return nil, CPaceResult{}, ErrCPaceInvalidShare
	}
	t := CPaceTranscriptIR(ya, adA, share, adB)
	return share, CPaceResult{ISK: CPaceISK(in.SID, k, t), Transcript: t}, nil
}
