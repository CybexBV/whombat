package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/internal/recoverykey"
)

// setupPending is an appliance installed from an image before PI-19: the hash on /persist and the key still
// waiting for the console.
func setupPending(t *testing.T) (persist, key string) {
	t.Helper()
	persist = filepath.Join(t.TempDir(), "persist")
	for _, d := range []string{"secrets", recoverykey.PendingDir} {
		if err := os.MkdirAll(filepath.Join(persist, d), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	key, _ = recoverykey.New(nil)
	h, err := recoverykey.Hash(nil, key, recoverykey.Params{MemoryKiB: 64, Time: 1, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(persist, recoverykey.HashFile), []byte(h+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(persist, recoverykey.PendingFile), []byte(`{"v":1,"key":"`+key+`"}`+"\n"), 0o440); err != nil {
		t.Fatal(err)
	}
	return persist, key
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// PI-19, NX-90: a key never confirmed at the console goes with its hash; a confirmed one (no pending file) stays.
func TestDropPending(t *testing.T) {
	persist, _ := setupPending(t)
	hash := filepath.Join(persist, recoverykey.HashFile)
	if err := dropPending(persist, hash); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{recoverykey.PendingFile, recoverykey.PendingDir, recoverykey.HashFile} {
		if exists(filepath.Join(persist, f)) {
			t.Fatalf("%s left", f)
		}
	}
	if err := dropPending(persist, hash); err != nil {
		t.Fatalf("nothing pending: %v", err)
	}

	persist, key := setupPending(t)
	hash = filepath.Join(persist, recoverykey.HashFile)
	_ = os.Remove(filepath.Join(persist, recoverykey.PendingFile))
	if err := dropPending(persist, hash); err != nil {
		t.Fatal(err)
	}
	if err := checkRecoveryKey(hash, key); err != nil {
		t.Fatalf("a confirmed key's hash was touched: %v", err)
	}
}

func TestCheckRecoveryKey(t *testing.T) {
	persist, key := setupPending(t)
	hash := filepath.Join(persist, recoverykey.HashFile)
	if err := checkRecoveryKey(hash, strings.ToUpper(key)+"\n"); err != nil {
		t.Fatal(err)
	}
	other, _ := recoverykey.New(nil)
	if err := checkRecoveryKey(hash, other); !errors.Is(err, ErrWrongKey) {
		t.Fatalf("wrong key: %v", err)
	}
	if err := checkRecoveryKey(hash, ""); !errors.Is(err, ErrWrongKey) {
		t.Fatalf("empty key: %v", err)
	}
	_ = os.Chmod(hash, 0o622)
	if err := checkRecoveryKey(hash, key); err == nil || errors.Is(err, ErrWrongKey) {
		t.Fatalf("a hash others can write was used: %v", err)
	}
	if err := checkRecoveryKey(filepath.Join(persist, "nothing"), key); err == nil || !strings.Contains(err.Error(), "no disk recovery key") {
		t.Fatalf("missing hash: %v", err)
	}
}

func TestParseSelfSettingsPlatform(t *testing.T) {
	s, err := parseSelfSettings([]byte(`{"v":1,"environment":"prod","controlUrl":"https://api.whombat.com","platform":"self-installed","requireSecureBoot":false}`))
	if err != nil || s.Platform != "self-installed" {
		t.Fatalf("%+v %v", s, err)
	}
	o, _, _, err := base(Settings{Environment: "prod", Platform: "self-installed", RequireSecureBoot: new(bool), ManagerUID: new(int), ManagerGID: new(int)}, "/persist")
	if err != nil || o.RequireSecureBoot {
		t.Fatalf("self-installed prod requires Secure Boot: %+v %v", o, err)
	}
	o, _, _, _ = base(Settings{Environment: "prod", RequireSecureBoot: new(bool), ManagerUID: new(int), ManagerGID: new(int)}, "/persist")
	if !o.RequireSecureBoot {
		t.Fatal("hardware prod without Secure Boot")
	}
	for _, bad := range []string{
		`{"v":1,"environment":"dev","controlUrl":"x","platform":"pi"}`,
		// No disk recovery key, so no volumes to enrol it on (PI-19).
		`{"v":1,"environment":"dev","controlUrl":"x","luksDevices":["/dev/disk/by-partlabel/whombat-root"]}`,
	} {
		if _, err := parseSelfSettings([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
