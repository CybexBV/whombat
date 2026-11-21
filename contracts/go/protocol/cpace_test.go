package protocol

import (
	"bytes"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

type cpaceDraft struct {
	PRS             string `json:"prs"`
	CI              string `json:"ci"`
	SID             string `json:"sid"`
	GeneratorString string `json:"generatorString"`
	Generator       string `json:"generator"`
	Ya              string `json:"ya"`
	AdA             string `json:"adA"`
	YaShare         string `json:"Ya"`
	Yb              string `json:"yb"`
	AdB             string `json:"adB"`
	YbShare         string `json:"Yb"`
	K               string `json:"K"`
	TranscriptIr    string `json:"transcriptIr"`
	IskIr           string `json:"iskIr"`
	ScalarMult      struct {
		S      string `json:"s"`
		X      string `json:"X"`
		Result string `json:"result"`
	} `json:"scalarMult"`
	InvalidPoints []struct {
		Name  string `json:"name"`
		Point string `json:"point"`
	} `json:"invalidPoints"`
	PrependLen []struct {
		Data string `json:"data"`
		Out  string `json:"out"`
	} `json:"prependLen"`
	LvCat struct {
		Parts []string `json:"parts"`
		Out   string   `json:"out"`
	} `json:"lvCat"`
	TranscriptIrCases []struct {
		Ya, AdA, Yb, AdB, Out string
	} `json:"transcriptIrCases"`
}

type pakeContext struct {
	Method          string `json:"method"`
	Password        string `json:"password"`
	DeviceID        string `json:"deviceId"`
	AppliancePeerID string `json:"appliancePeerId"`
	ClientPeerID    string `json:"clientPeerId"`
	ClaimID         string `json:"claimId"`
}

func (c pakeContext) ctx() ClaimPakeContext { return ClaimPakeContext(c) }

type tags struct {
	Client    string `json:"client"`
	Appliance string `json:"appliance"`
}

func h(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

func TestCPaceDraftVectors(t *testing.T) {
	var v struct {
		Suite string     `json:"suite"`
		Draft cpaceDraft `json:"draft"`
	}
	vectors.Load(t, "cpace.json", &v)
	d := v.Draft
	if v.Suite != CPaceSuite {
		t.Fatalf("suite %q", v.Suite)
	}
	hx := hex.EncodeToString
	for _, c := range d.PrependLen {
		if got := hx(CPacePrependLen(h(t, c.Data))); got != c.Out {
			t.Errorf("prepend_len(%s) = %s, want %s", c.Data, got, c.Out)
		}
	}
	var parts [][]byte
	for _, p := range d.LvCat.Parts {
		parts = append(parts, h(t, p))
	}
	if got := hx(CPaceLVCat(parts...)); got != d.LvCat.Out {
		t.Errorf("lv_cat = %s", got)
	}
	for _, c := range d.TranscriptIrCases {
		if got := hx(CPaceTranscriptIR(h(t, c.Ya), h(t, c.AdA), h(t, c.Yb), h(t, c.AdB))); got != c.Out {
			t.Errorf("transcript_ir = %s, want %s", got, c.Out)
		}
	}
	prs, ci, sid := h(t, d.PRS), h(t, d.CI), h(t, d.SID)
	if got := hx(CPaceGeneratorString([]byte(CPaceDSI), prs, ci, sid)); got != d.GeneratorString {
		t.Errorf("generator_string = %s", got)
	}
	if got := hx(CPaceGenerator(prs, ci, sid)); got != d.Generator {
		t.Errorf("generator = %s, want %s", got, d.Generator)
	}
	in := CPaceInputs{PRS: prs, CI: ci, SID: sid}
	a, err := NewCPaceInitiator(in, bytes.NewReader(h(t, d.Ya)), h(t, d.AdA))
	if err != nil || hx(a.Share) != d.YaShare {
		t.Fatalf("Ya = %x (%v), want %s", a.Share, err, d.YaShare)
	}
	yb, res, err := CPaceRespond(in, a.Share, h(t, d.AdA), h(t, d.AdB), bytes.NewReader(h(t, d.Yb)))
	if err != nil || hx(yb) != d.YbShare {
		t.Fatalf("Yb = %x (%v), want %s", yb, err, d.YbShare)
	}
	if got := hx(CPaceScalarMultVfy(h(t, d.Ya), h(t, d.YbShare))); got != d.K {
		t.Errorf("K(A) = %s", got)
	}
	if got := hx(CPaceScalarMultVfy(h(t, d.Yb), h(t, d.YaShare))); got != d.K {
		t.Errorf("K(B) = %s", got)
	}
	if hx(res.Transcript) != d.TranscriptIr || hx(res.ISK) != d.IskIr {
		t.Errorf("responder transcript/ISK = %x / %x", res.Transcript, res.ISK)
	}
	if got := hx(CPaceISK(sid, h(t, d.K), res.Transcript)); got != d.IskIr {
		t.Errorf("ISK = %s", got)
	}
	resA, err := a.Finish(yb, h(t, d.AdB))
	if err != nil || hx(resA.ISK) != d.IskIr {
		t.Errorf("initiator ISK = %x (%v)", resA.ISK, err)
	}
	s := h(t, d.ScalarMult.S)
	if got := hx(CPaceScalarMultVfy(s, h(t, d.ScalarMult.X))); got != d.ScalarMult.Result {
		t.Errorf("scalar_mult_vfy valid = %s", got)
	}
	for _, p := range d.InvalidPoints {
		if got := CPaceScalarMultVfy(s, h(t, p.Point)); !bytes.Equal(got, CPaceIdentity) {
			t.Errorf("%s: scalar_mult_vfy = %x, want G.I", p.Name, got)
		}
		if _, err := a.Finish(h(t, p.Point), nil); !errors.Is(err, ErrCPaceInvalidShare) {
			t.Errorf("%s: initiator must abort, got %v", p.Name, err)
		}
		if _, _, err := CPaceRespond(in, h(t, p.Point), nil, nil, bytes.NewReader(h(t, d.Yb))); !errors.Is(err, ErrCPaceInvalidShare) {
			t.Errorf("%s: responder must abort, got %v", p.Name, err)
		}
	}
}

func TestClaimPakeVectors(t *testing.T) {
	var v struct {
		Pake []struct {
			Name            string      `json:"name"`
			Client          pakeContext `json:"client"`
			Appliance       pakeContext `json:"appliance"`
			ClientCI        string      `json:"clientCi"`
			ApplianceCI     string      `json:"applianceCi"`
			ClientRandom    string      `json:"clientRandom"`
			ApplianceRandom string      `json:"applianceRandom"`
			ClientShare     string      `json:"clientShare"`
			ApplianceShare  string      `json:"applianceShare"`
			ClientTags      tags        `json:"clientTags"`
			ApplianceTags   tags        `json:"applianceTags"`
			Agree           bool        `json:"agree"`
		} `json:"pake"`
		InvalidShares []struct {
			Name    string `json:"name"`
			Share   string `json:"share"`
			Refused bool   `json:"refused"`
		} `json:"invalidShares"`
	}
	vectors.Load(t, "cpace.json", &v)
	if len(v.Pake) < 3 || len(v.InvalidShares) == 0 {
		t.Fatal("no claim PAKE vectors")
	}
	agreeing := 0
	for _, c := range v.Pake {
		if got := hex.EncodeToString(ClaimPakeCI(c.Client.ctx())); got != c.ClientCI {
			t.Errorf("%s: client CI %s", c.Name, got)
		}
		if got := hex.EncodeToString(ClaimPakeCI(c.Appliance.ctx())); got != c.ApplianceCI {
			t.Errorf("%s: appliance CI %s", c.Name, got)
		}
		client, err := NewClaimPakeClient(c.Client.ctx(), bytes.NewReader(h(t, c.ClientRandom)))
		if err != nil || client.Share != c.ClientShare {
			t.Fatalf("%s: client share %v (%v), want %s", c.Name, client, err, c.ClientShare)
		}
		share, at, err := ClaimPakeRespond(c.Appliance.ctx(), c.ClientShare, bytes.NewReader(h(t, c.ApplianceRandom)))
		if err != nil || share != c.ApplianceShare || at != ClaimConfirmTags(c.ApplianceTags) {
			t.Errorf("%s: appliance %s %+v (%v)", c.Name, share, at, err)
		}
		ct, err := client.Finish(c.ApplianceShare)
		if err != nil || ct != ClaimConfirmTags(c.ClientTags) {
			t.Errorf("%s: client tags %+v (%v)", c.Name, ct, err)
		}
		agree := ClaimConfirmEqual(at.Client, ct.Client) && ClaimConfirmEqual(ct.Appliance, at.Appliance)
		if agree != c.Agree {
			t.Errorf("%s: agree = %v, want %v", c.Name, agree, c.Agree)
		}
		if agree {
			agreeing++
		}
	}
	if agreeing != 2 {
		t.Errorf("%d agreeing cases, want 2 (code and card)", agreeing)
	}
	base := v.Pake[0].Appliance.ctx()
	for _, c := range v.InvalidShares {
		_, _, err := ClaimPakeRespond(base, c.Share, bytes.NewReader(h(t, v.Pake[0].ApplianceRandom)))
		if (err != nil) != c.Refused || (err != nil && !errors.Is(err, ErrClaimPakeInvalidShare)) {
			t.Errorf("%s: err = %v, refused %v", c.Name, err, c.Refused)
		}
	}
	if _, err := NewClaimPakeClient(ClaimPakeContext{Method: "code", Password: "KXQO"}, bytes.NewReader(make([]byte, 32))); !errors.Is(err, ErrClaimPakeInvalidPassword) {
		t.Errorf("a password outside the alphabet must be refused: %v", err)
	}
	if ClaimConfirmEqual("A", "A") {
		t.Error("ClaimConfirmEqual must refuse non-tags")
	}
}
