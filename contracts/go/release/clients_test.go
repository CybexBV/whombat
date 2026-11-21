package release

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
)

type clientVectors struct {
	Keys     map[string]string `json:"keys"`
	Channels []struct {
		Name         string          `json:"name"`
		Doc          json.RawMessage `json:"doc"`
		Now          int64           `json:"now"`
		Env          string          `json:"env"`
		LastSequence int64           `json:"lastSequence"`
		Expect       string          `json:"expect"`
	} `json:"channels"`
	Bundles []ClientBundle `json:"bundles"`
	Targets []struct {
		Bundle ClientBundle `json:"bundle"`
		Target string       `json:"target"`
	} `json:"targets"`
	Selection []struct {
		Name string `json:"name"`
		Want struct {
			Provider ClientProvider `json:"provider"`
			Os       ClientOs       `json:"os"`
			Arch     ClientArch     `json:"arch"`
			Adapter  int64          `json:"adapter"`
		} `json:"want"`
		Expect *string `json:"expect"`
	} `json:"selection"`
}

func TestClientChannelVectors(t *testing.T) {
	var v clientVectors
	vectors.Load(t, "clients.json", &v)
	keys := map[string]ed25519.PublicKey{}
	for id, k := range v.Keys {
		b, _ := hex.DecodeString(k)
		keys[id] = b
	}
	for _, c := range v.Channels {
		_, err := VerifyClientChannel(c.Doc, ClientChannelContext{
			Keys: keys, Env: Environment(c.Env), Now: c.Now, LastSequence: c.LastSequence,
		})
		got := "ok"
		var ce *ClientChannelError
		if errors.As(err, &ce) {
			got = string(ce.Code)
		} else if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got != c.Expect {
			t.Errorf("%s: got %s, want %s", c.Name, got, c.Expect)
		}
	}
}

func TestClientBundleTargetsAndSelection(t *testing.T) {
	var v clientVectors
	vectors.Load(t, "clients.json", &v)
	for _, c := range v.Targets {
		b := c.Bundle
		if got := ClientBundleTarget(b.Provider, b.Version, b.Os, b.Arch); got != c.Target {
			t.Errorf("target: got %s, want %s", got, c.Target)
		}
	}
	for _, c := range v.Selection {
		b := SelectClientBundle(v.Bundles, c.Want.Provider, c.Want.Os, c.Want.Arch, c.Want.Adapter)
		switch {
		case c.Expect == nil && b != nil:
			t.Errorf("%s: got %s, want none", c.Name, b.Version)
		case c.Expect != nil && (b == nil || b.Version != *c.Expect):
			t.Errorf("%s: got %v, want %s", c.Name, b, *c.Expect)
		}
	}
}
