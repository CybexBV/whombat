package journal

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

type st struct {
	Phase string `json:"phase"`
	N     int    `json:"n"`
}

func TestTornLatestFallsBack(t *testing.T) {
	d := t.TempDir()
	j, _ := Open(d)
	j.Save(st{"a", 1})
	j.Save(st{"b", 2})
	// Corrupt the newest slot (seq 2 -> journal.a.json).
	p := filepath.Join(d, "journal.a.json")
	b, _ := os.ReadFile(p)
	b[len(b)/2] ^= 0x55
	os.WriteFile(p, b, 0o600)
	var s st
	j2, _ := Open(d)
	if found, err := j2.Load(&s); err != nil || !found || s.N != 1 {
		t.Fatalf("fallback: %v %v %+v", found, err, s)
	}
	// Next save must not reuse a lower sequence than the corrupted one would hide.
	if err := j2.Save(st{"c", 3}); err != nil {
		t.Fatal(err)
	}
	var s3 st
	j3, _ := Open(d)
	j3.Load(&s3)
	if s3.N != 3 {
		t.Fatalf("%+v", s3)
	}
}

func TestCrashBeforeRenameKeepsOld(t *testing.T) {
	d := t.TempDir()
	j, _ := Open(d)
	j.Save(st{"a", 1})
	boom := errors.New("crash")
	atomicfile.FaultHook = func(point, _ string) error {
		if point == "after-temp-sync" {
			return boom
		}
		return nil
	}
	err := j.Save(st{"b", 2})
	atomicfile.FaultHook = nil
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	var s st
	j2, _ := Open(d)
	j2.Load(&s)
	if s.N != 1 {
		t.Fatalf("%+v", s)
	}
}

func TestTooNewRefused(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "journal.a.json"), []byte(`{"format":"whombat-manager-journal","version":9,"minReader":9,"seq":2,"writtenAt":"2026-09-25T00:00:00Z","sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","state":{}}`), 0o600)
	j, _ := Open(d)
	var s st
	if _, err := j.Load(&s); !errors.Is(err, ErrTooNew) {
		t.Fatalf("%v", err)
	}
}

// SR-04: the record sequence orders states across processes; LoadSeq and SaveSeq return it.
func TestSequenceNumbers(t *testing.T) {
	d := t.TempDir()
	j, _ := Open(d)
	var s st
	if seq, found, err := j.LoadSeq(&s); seq != 0 || found || err != nil {
		t.Fatalf("empty journal: %d %v %v", seq, found, err)
	}
	for i := 1; i <= 3; i++ {
		if seq, err := j.SaveSeq(st{"a", i}); err != nil || seq != uint64(i) {
			t.Fatalf("save %d: seq %d %v", i, seq, err)
		}
	}
	if j.Seq() != 3 {
		t.Fatalf("Seq after three saves: %d", j.Seq())
	}
	j2, _ := Open(d) // a new process continues the sequence
	if j2.Seq() != 0 {
		t.Fatalf("Seq before a load: %d", j2.Seq())
	}
	if seq, found, err := j2.LoadSeq(&s); seq != 3 || !found || err != nil || s.N != 3 || j2.Seq() != 3 {
		t.Fatalf("load: %d %v %v %+v, Seq %d", seq, found, err, s, j2.Seq())
	}
	if seq, err := j2.SaveSeq(st{"b", 4}); err != nil || seq != 4 {
		t.Fatalf("save after load: %d %v", seq, err)
	}
}
