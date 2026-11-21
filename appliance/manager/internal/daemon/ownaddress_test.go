package daemon_test

import (
	"os"
	"path/filepath"
	"testing"
)

// A commercial box of env dev has an own address (MG-161): the service is built, its state lives beside the journal,
// and the ACME socket sits beside the local API's. WHOMBAT_OWN_ADDRESS=off leaves the manager as before it.
func TestOwnAddressOnByEnv(t *testing.T) {
	h := startDaemon(t, nil)
	d := h.d
	if d.OwnAddress == nil {
		t.Fatal("no own address on a dev box")
	}
	if got, want := d.OwnAddress.Store.Dir(), filepath.Join(filepath.Dir(h.cfg.JournalDir), "own-address"); got != want {
		t.Fatalf("state in %s, want %s", got, want)
	}
	if fi, err := os.Stat(d.OwnAddress.Store.Dir()); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("state directory: %v %v", fi, err)
	}
	sock := filepath.Join(filepath.Dir(h.cfg.APISocket), "acme.sock")
	if d.ACMESocket() != sock {
		t.Fatal(d.ACMESocket())
	}
	h.eventually("the ACME socket", func() bool {
		fi, err := os.Stat(sock)
		return err == nil && fi.Mode().Type() == os.ModeSocket && fi.Mode().Perm() == 0o660
	}, func() string { return sock })
	if st := d.OwnAddress.State(); !st.Enabled || st.Acme.State != "idle" {
		t.Fatalf("state %+v", st)
	}
}

func TestOwnAddressSwitchedOff(t *testing.T) {
	t.Setenv("WHOMBAT_OWN_ADDRESS", "off")
	h := startDaemon(t, nil)
	if h.d.OwnAddress != nil || h.d.Broker.OwnAddress != nil {
		t.Fatal("an own address with WHOMBAT_OWN_ADDRESS=off")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(h.cfg.APISocket), "acme.sock")); !os.IsNotExist(err) {
		t.Fatalf("an ACME socket: %v", err)
	}
}
