package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// A day of samples fits; past the count limit the newest are kept.
func TestBufferCapacityKeepsNewest(t *testing.T) {
	b := NewBuffer("")
	now := time.Now().UTC()
	b.nowFunc = func() time.Time { return now }
	if BufferMaxLen != 8640 || BufferMaxAge != 24*time.Hour {
		t.Fatalf("limits %d %s", BufferMaxLen, BufferMaxAge)
	}
	n := BufferMaxLen + 100
	start := now.Add(-time.Duration(n) * 10 * time.Second)
	for i := 0; i < n; i++ {
		b.Add(proto.Sample{At: start.Add(time.Duration(i) * 10 * time.Second), Values: map[string]float64{"cpu_pct": float64(i), "mem_pct": 1}})
	}
	if b.Len() != BufferMaxLen {
		t.Fatalf("len %d, want %d", b.Len(), BufferMaxLen)
	}
	got, _ := b.Peek(1)
	if got[0].Values["cpu_pct"] != 100 {
		t.Fatalf("oldest kept sample %v, want 100", got[0].Values["cpu_pct"])
	}
	// All samples share one key set.
	if len(b.keysets) != 1 {
		t.Fatalf("key sets: %d", len(b.keysets))
	}
}

// Samples with different series names round-trip through the file.
func TestBufferPackedRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), BufferFileName)
	b := NewBuffer(path)
	now := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < 30; i++ {
		v := map[string]float64{"cpu_pct": float64(i)}
		if i%3 == 0 {
			v[fmt.Sprintf("vol_pct:fs:/srv%d", i%2)] = 50
		}
		b.Add(proto.Sample{At: now.Add(time.Duration(i) * time.Second), Values: v})
	}
	if err := b.Save(); err != nil {
		t.Fatal(err)
	}
	b2 := NewBuffer(path)
	if err := b2.Load(); err != nil {
		t.Fatal(err)
	}
	a, _ := b.Peek(100)
	c, _ := b2.Peek(100)
	if len(a) != 30 || len(c) != 30 {
		t.Fatalf("len %d %d", len(a), len(c))
	}
	for i := range a {
		if !a[i].At.Equal(c[i].At) || fmt.Sprint(a[i].Values) != fmt.Sprint(c[i].Values) {
			t.Fatalf("sample %d: %+v != %+v", i, a[i], c[i])
		}
	}
}

// Version 1 files (a plain list of samples) are still read.
func TestBufferLoadsVersion1(t *testing.T) {
	path := filepath.Join(t.TempDir(), BufferFileName)
	now := time.Now().UTC()
	data, _ := wire.Marshal(bufferFile{Version: 1, Samples: []proto.Sample{{At: now, Values: map[string]float64{"cpu_pct": 7}}}})
	os.WriteFile(path, data, 0o600)
	b := NewBuffer(path)
	if err := b.Load(); err != nil || b.Len() != 1 {
		t.Fatalf("load v1: %v len %d", err, b.Len())
	}
	if s, _ := b.Peek(1); s[0].Values["cpu_pct"] != 7 {
		t.Fatalf("v1 sample %+v", s)
	}
}

// An undecodable file or an unknown version is moved aside, the buffer
// starts empty, and Load says so.
func TestBufferCorruptFileMovedAside(t *testing.T) {
	newer, _ := wire.Marshal(bufferFile{Version: 99})
	dangling, _ := wire.Marshal(bufferFile{Version: 2, Keys: [][]string{{"a"}}, Packed: []packedSample{{Keys: 3, Vals: []float64{1}}}})
	for name, data := range map[string][]byte{
		"garbage":  []byte("\xff\x00 not cbor"),
		"version":  newer,
		"dangling": dangling,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), BufferFileName)
			os.WriteFile(path, data, 0o600)
			b := NewBuffer(path)
			err := b.Load()
			if !errors.Is(err, ErrBufferUnreadable) {
				t.Fatalf("err = %v", err)
			}
			if b.Len() != 0 {
				t.Fatal("buffer not empty")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("corrupt file still in place")
			}
			if got, err := os.ReadFile(path + ".corrupt"); err != nil || string(got) != string(data) {
				t.Fatalf("moved file: %v", err)
			}
			// The buffer works and saves a fresh file.
			b.Add(proto.Sample{At: time.Now(), Values: map[string]float64{"cpu_pct": 1}})
			if err := b.Save(); err != nil {
				t.Fatal(err)
			}
			if err := NewBuffer(path).Load(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
