package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestMachineSerial(t *testing.T) {
	s, err := machineSerial("0123456789abcdef0123456789abcdef")
	if err != nil || !regexp.MustCompile(`^MID-[0-9A-F]{20}$`).MatchString(s) {
		t.Fatalf("%q %v", s, err)
	}
	if again, _ := machineSerial("0123456789abcdef0123456789abcdef"); again != s {
		t.Fatal("not deterministic")
	}
	if other, _ := machineSerial("fedcba9876543210fedcba9876543210"); other == s {
		t.Fatal("not per machine")
	}
	for _, bad := range []string{"", "xyz", "0123456789abcdef0123456789abcdeg"} {
		if _, err := machineSerial(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := validSerial("SN 1"); err == nil {
		t.Fatal("space in serial accepted")
	}
	if _, err := selfSerial("sn-0001"); err != nil {
		t.Fatal(err)
	}
}

func TestParseSelfSettings(t *testing.T) {
	// A community box: no control (NX-445).
	if s, err := parseSelfSettings([]byte(`{"v":1,"environment":"dev","controlUrl":"","edition":"community","platform":"self-installed"}`)); err != nil || s.Edition != "community" {
		t.Fatalf("%+v %v", s, err)
	}
	s, err := parseSelfSettings([]byte(`{"v":1,"environment":"dev","controlUrl":"https://api.whombat.com","requireSecureBoot":false}`))
	if err != nil || s.ControlURL != "https://api.whombat.com" || s.Environment != "dev" || *s.RequireSecureBoot {
		t.Fatalf("%+v %v", s, err)
	}
	for _, bad := range []string{
		`{"v":2,"environment":"dev","controlUrl":"x"}`,
		`{"v":1,"environment":"dev","controlUrl":"x","tokenFile":"t"}`,
		`{"v":1,"environment":"dev","controlUrl":"x","cardRecipient":"k"}`,
		`{"v":1,"environment":"dev","controlUrl":"x","factoryRelease":"r"}`,
		`{"v":1,"environment":"dev","controlUrl":"x","model":"whombat-one"}`,
		`{"v":1,"environment":"dev","controlUrl":"x","unknown":1}`,
		`{"v":1,"environment":"dev","controlUrl":"x","edition":"community"}`,
		`{"v":1,"environment":"dev","edition":"open"}`,
	} {
		if _, err := parseSelfSettings([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

// The re-registration request is only acted on for the self-installed device it names and never when the
// manager has seen a claim; refusals are ErrRefused (exit 3, the unit drops the request).
func TestReregisterRefusals(t *testing.T) {
	dir := t.TempDir()
	persist := filepath.Join(dir, "persist")
	os.MkdirAll(filepath.Join(persist, "identity"), 0o700)
	dev := func(model string) {
		os.WriteFile(filepath.Join(persist, "identity", "device.json"), []byte(`{"v":1,"deviceId":"dev_1","model":"`+model+`","serial":"SN-1"}`), 0o644)
	}
	req := filepath.Join(dir, "req.json")
	os.WriteFile(req, []byte(`{"v":1,"deviceId":"dev_1","reason":"device_retired","at":"2026-09-26T00:00:00Z"}`), 0o600)
	claimed := filepath.Join(dir, "claim-state.json")
	os.WriteFile(claimed, []byte(`{"v":1,"claimed":true}`), 0o600)
	s := Settings{Environment: "dev", ControlURL: "http://127.0.0.1:1"}

	dev("whombat-one")
	if err := reregisterSelf(context.Background(), s, persist, req, ""); !errors.Is(err, ErrRefused) {
		t.Fatalf("factory device: %v", err)
	}
	dev("self-installed")
	if err := reregisterSelf(context.Background(), s, persist, req, claimed); !errors.Is(err, ErrRefused) {
		t.Fatalf("claimed: %v", err)
	}
	other := filepath.Join(dir, "other.json")
	os.WriteFile(other, []byte(`{"v":1,"deviceId":"dev_2","reason":"device_retired"}`), 0o600)
	if err := reregisterSelf(context.Background(), s, persist, other, ""); !errors.Is(err, ErrRefused) {
		t.Fatalf("other device: %v", err)
	}
	// A box that made its own identity (no control URL: every image today) has nothing to register again.
	if err := reregisterSelf(context.Background(), Settings{Environment: "dev"}, persist, req, ""); !errors.Is(err, ErrRefused) {
		t.Fatalf("own identity: %v", err)
	}
	link := filepath.Join(dir, "link.json")
	os.Symlink(req, link)
	if err := reregisterSelf(context.Background(), s, persist, link, ""); err == nil {
		t.Fatal("followed a symlink")
	}
}
