package keyslots

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fakeLUKS simulates keyslots (slot -> passphrase) and TPM2 tokens for the cryptsetup calls Reset makes.
type fakeLUKS struct {
	slots map[int]string
	tpm   []int
	calls int
	crash int // fail the n-th mutating call (0 = never)
}

func (f *fakeLUKS) find(pass string) (int, bool) {
	for n, p := range f.slots {
		if p == pass {
			return n, true
		}
	}
	return -1, false
}

func arg(args []string, prefix string) string {
	for _, a := range args {
		if strings.HasPrefix(a, prefix) {
			return strings.TrimPrefix(a, prefix)
		}
	}
	return ""
}

func (f *fakeLUKS) cs(_ context.Context, stdin string, args ...string) (string, error) {
	pass := func() string {
		kf := arg(args, "--key-file=")
		if kf == "-" {
			return stdin
		}
		b, _ := os.ReadFile(kf)
		return string(b)
	}
	mutate := func() error {
		f.calls++
		if f.crash != 0 && f.calls == f.crash {
			return errors.New("crash")
		}
		return nil
	}
	switch args[0] {
	case "open":
		if n, ok := f.find(pass()); ok {
			return fmt.Sprintf("Key slot %d unlocked.\nCommand successful.\n", n), nil
		}
		return "No key available with this passphrase.", errors.New("exit 2")
	case "luksDump":
		md := map[string]any{"keyslots": map[string]any{}, "tokens": map[string]any{}}
		for n := range f.slots {
			md["keyslots"].(map[string]any)[strconv.Itoa(n)] = map[string]any{"type": "luks2"}
		}
		var ks []string
		for _, n := range f.tpm {
			ks = append(ks, strconv.Itoa(n))
		}
		md["tokens"].(map[string]any)["0"] = map[string]any{"type": "systemd-tpm2", "keyslots": ks}
		b, _ := json.Marshal(md)
		return string(b), nil
	case "luksAddKey":
		if _, ok := f.find(pass()); !ok {
			return "", errors.New("no key")
		}
		if err := mutate(); err != nil {
			return "", err
		}
		b, _ := os.ReadFile(args[len(args)-1])
		for n := 0; ; n++ {
			if _, used := f.slots[n]; !used {
				f.slots[n] = string(b)
				return "", nil
			}
		}
	case "luksKillSlot":
		if _, ok := f.find(pass()); !ok {
			return "", errors.New("no key")
		}
		if err := mutate(); err != nil {
			return "", err
		}
		n, _ := strconv.Atoi(args[len(args)-1])
		delete(f.slots, n)
		return "", nil
	}
	return "", fmt.Errorf("unexpected %v", args)
}

// Regression for N-7 (re-review 2): after a factory reset and re-provisioning, the previous owner's
// recovery key must not open the system volume.
func TestResetRemovesOldOwnersKeys(t *testing.T) {
	d := t.TempDir()
	maint := filepath.Join(d, "maint-whombat-root.key")
	os.WriteFile(maint, []byte("MAINT-OLD"), 0o600)
	f := &fakeLUKS{slots: map[int]string{0: "TPM-SECRET", 1: "MAINT-OLD", 2: "OLD-OWNER-RECOVERY", 3: "NEW-OWNER-RECOVERY"}, tpm: []int{0}}
	res, err := Reset(context.Background(), f.cs, Options{Device: "/dev/x", MaintKey: maint, Keep: []string{"NEW-OWNER-RECOVERY"}, Rotate: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := f.find("OLD-OWNER-RECOVERY"); ok {
		t.Fatal("the old owner's recovery key still opens the volume")
	}
	if _, ok := f.find("MAINT-OLD"); ok {
		t.Fatal("the old maintenance key still opens the volume")
	}
	newMaint, _ := os.ReadFile(maint)
	for _, p := range []string{"TPM-SECRET", "NEW-OWNER-RECOVERY", string(newMaint)} {
		if _, ok := f.find(p); !ok {
			t.Fatalf("slot for %q removed (%+v)", p, res)
		}
	}
	if _, err := os.Stat(maint + ".new"); err == nil {
		t.Fatal("<key>.new left behind")
	}
}

// Crash-safe: at every crash point the volume keeps its TPM slot and a maintenance slot whose key is
// on disk, and a rerun finishes the job.
func TestResetCrashSafe(t *testing.T) {
	for crash := 1; crash <= 4; crash++ {
		t.Run(strconv.Itoa(crash), func(t *testing.T) {
			d := t.TempDir()
			maint := filepath.Join(d, "maint.key")
			os.WriteFile(maint, []byte("MAINT-OLD"), 0o600)
			f := &fakeLUKS{slots: map[int]string{0: "TPM-SECRET", 1: "MAINT-OLD", 2: "OLD-OWNER"}, tpm: []int{0}, crash: crash}
			_, _ = Reset(context.Background(), f.cs, Options{Device: "/dev/x", MaintKey: maint, Rotate: true})
			if _, ok := f.find("TPM-SECRET"); !ok {
				t.Fatal("TPM slot lost")
			}
			usable := false
			for _, p := range []string{maint, maint + ".new"} {
				if b, err := os.ReadFile(p); err == nil {
					if _, ok := f.find(string(b)); ok {
						usable = true
					}
				}
			}
			if !usable {
				t.Fatal("no maintenance key on disk opens the volume")
			}
			f.crash = 0
			if _, err := Reset(context.Background(), f.cs, Options{Device: "/dev/x", MaintKey: maint, Rotate: true}); err != nil {
				t.Fatalf("rerun: %v", err)
			}
			if _, ok := f.find("OLD-OWNER"); ok {
				t.Fatal("old owner's key survived the rerun")
			}
			b, _ := os.ReadFile(maint)
			if _, ok := f.find(string(b)); !ok || len(f.slots) != 2 {
				t.Fatalf("after rerun: %v", f.slots)
			}
		})
	}
}

// Without a TPM slot nothing is removed (the maintenance key would be the only way in).
func TestResetRefusesWithoutTPM(t *testing.T) {
	d := t.TempDir()
	maint := filepath.Join(d, "maint.key")
	os.WriteFile(maint, []byte("M"), 0o600)
	f := &fakeLUKS{slots: map[int]string{1: "M", 2: "OLD"}}
	if _, err := Reset(context.Background(), f.cs, Options{Device: "/dev/x", MaintKey: maint}); err == nil {
		t.Fatal("reset without a TPM slot")
	}
	if len(f.slots) != 2 {
		t.Fatal("slots removed")
	}
}
