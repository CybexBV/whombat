package local

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/internal/vectors"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

func TestNetworkVectors(t *testing.T) {
	var v struct {
		HostNetworks []struct {
			Network json.RawMessage `json:"network"`
			Valid   bool            `json:"valid"`
		} `json:"hostNetworks"`
		NetworkChanges []struct {
			Change json.RawMessage `json:"change"`
			Valid  bool            `json:"valid"`
		} `json:"networkChanges"`
		Ssids []struct {
			Ssid  string `json:"ssid"`
			Valid bool   `json:"valid"`
		} `json:"ssids"`
		WifiSignals []struct {
			DBm    int   `json:"dbm"`
			Signal int64 `json:"signal"`
		} `json:"wifiSignals"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.HostNetworks) == 0 || len(v.NetworkChanges) == 0 || len(v.Ssids) == 0 || len(v.WifiSignals) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.HostNetworks {
		// The network travels inside NetworkStateResponse; parse it there so the schema checks it too.
		r, err := ParseNetworkStateResponse([]byte(`{"v":1,"network":` + string(c.Network) + `}`))
		if err != nil {
			t.Fatalf("%s: %v", c.Network, err)
		}
		if got := HostNetworkValid(r.Network); got != c.Valid {
			t.Errorf("HostNetworkValid(%s) = %v, want %v", c.Network, got, c.Valid)
		}
	}
	for _, c := range v.NetworkChanges {
		r, err := ParseWifiChangeResponse([]byte(`{"v":1,"change":` + string(c.Change) + `}`))
		if err != nil {
			t.Fatalf("%s: %v", c.Change, err)
		}
		if got := NetworkChangeValid(r.Change); got != c.Valid {
			t.Errorf("NetworkChangeValid(%s) = %v, want %v", c.Change, got, c.Valid)
		}
	}
	for _, c := range v.Ssids {
		if got := SsidValid(c.Ssid); got != c.Valid {
			t.Errorf("SsidValid(%q) = %v, want %v", c.Ssid, got, c.Valid)
		}
	}
	for _, c := range v.WifiSignals {
		if got := WifiSignalFromDBm(c.DBm); got != c.Signal {
			t.Errorf("WifiSignalFromDBm(%d) = %d, want %d", c.DBm, got, c.Signal)
		}
	}
}

// HostText cleans display strings as TypeScript does (CT-560), and what it makes passes the report's schema.
func TestHostTextVectors(t *testing.T) {
	var v struct {
		HostTexts []struct {
			Input  string `json:"input"`
			Max    int    `json:"max"`
			Output string `json:"output"`
		} `json:"hostTexts"`
	}
	vectors.Load(t, "local.json", &v)
	if len(v.HostTexts) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.HostTexts {
		if got := HostText(c.Input, c.Max); got != c.Output {
			t.Errorf("HostText(%q, %d) = %q, want %q", c.Input, c.Max, got, c.Output)
		}
	}
	// Bytes that aren't UTF-8 go too, so a name read from sysfs always validates.
	if got := HostText("Realtek\xff\xfe RTL8153", 120); got != "Realtek RTL8153" {
		t.Errorf("HostText with invalid UTF-8 = %q", got)
	}
	name := HostText(strings.Repeat("Wi\u2011Fi\u00a0Kärtchen\u200b ", 20), 120)
	doc := protocol.HostHardware{
		CollectedAt: "2026-10-20T15:00:00Z",
		Kernel:      HostText("6.18.53\n", 64),
		Cpu:         protocol.HardwareCpu{Model: HostText("\t", 120), Cores: 1, Threads: 1},
		Devices: []protocol.HardwareDevice{
			{Kind: protocol.HardwareKindWifi, Name: name, Bus: protocol.HardwareBusPci, Status: protocol.HardwareStatusOk},
		},
		Log: []string{HostText(strings.Repeat("firmware load failed ", 20), 240)},
	}
	r := HostHardwareResponse{V: 1, Hardware: doc}
	if err := r.Validate(); err != nil {
		t.Errorf("cleaned text refused: %v", err)
	}
}

func TestSsidLimits(t *testing.T) {
	ok := []string{"Home", strings.Repeat("x", 32), strings.Repeat("ä", 16), " "}
	bad := []string{"", strings.Repeat("x", 33), strings.Repeat("ä", 17), "a\u200bb", "a\nb", "a\u00a0b", "\xff"}
	for _, s := range ok {
		if !SsidValid(s) {
			t.Errorf("SsidValid(%q) = false", s)
		}
	}
	for _, s := range bad {
		if SsidValid(s) {
			t.Errorf("SsidValid(%q) = true", s)
		}
	}
	// The schema takes 32 code points; only SsidValid sees the bytes.
	in := `{"v":1,"ssid":"` + strings.Repeat("ä", 32) + `"}`
	r, err := ParseWifiForgetRequest([]byte(in))
	if err != nil {
		t.Fatalf("refused 32 code points: %v", err)
	}
	if SsidValid(r.Ssid) {
		t.Error("SsidValid accepted 64 bytes")
	}
}
