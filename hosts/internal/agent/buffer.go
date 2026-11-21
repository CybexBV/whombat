package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Buffer limits: 24 hours of samples (8640 at the 10 s report interval).
// Early reports after events add samples too; past the count limit the
// oldest are dropped, so a long outage keeps the newest day.
const (
	BufferMaxAge = 24 * time.Hour
	BufferMaxLen = 8640
	// BackfillBatch is the maximum number of samples per Backfill message.
	BackfillBatch = 500
)

// BufferFileName is the persisted buffer inside the state dir.
const BufferFileName = "buffer.cbor"

// bufferVersion is the on-disk format written by Save. Version 1 (a plain
// list of samples) is still read.
const bufferVersion = 2

// ErrBufferUnreadable is returned (wrapped) by Load when the persisted
// buffer could not be used: it was moved aside to <file>.corrupt and the
// buffer starts empty.
var ErrBufferUnreadable = errors.New("sample buffer file unreadable")

// Buffer holds samples that could not be delivered to the hub, oldest first.
// It is safe for concurrent use.
//
// A day of samples is kept compactly: the series names of a sample are
// interned as a shared key set (they rarely change between reports), so a
// sample costs its values only, not a map of strings.
type Buffer struct {
	mu      sync.Mutex
	items   []bufItem
	keysets map[string]*keySet
	next    uint64
	dirty   bool
	path    string
	maxAge  time.Duration
	maxLen  int
	nowFunc func() time.Time
}

type bufItem struct {
	id   uint64
	at   time.Time
	keys *keySet
	vals []float64 // in the order of keys.names
}

// keySet is a sorted list of series names shared by many samples.
type keySet struct {
	sig   string
	names []string
}

// bufferFile is the on-disk format. Version 1 wrote Samples; version 2
// writes the key sets and packed samples.
type bufferFile struct {
	Version int            `cbor:"v"`
	Samples []proto.Sample `cbor:"s,omitempty"`
	Keys    [][]string     `cbor:"k,omitempty"`
	Packed  []packedSample `cbor:"p,omitempty"`
}

type packedSample struct {
	At   time.Time `cbor:"t"`
	Keys int       `cbor:"k"` // index into bufferFile.Keys
	Vals []float64 `cbor:"v"`
}

// NewBuffer returns an empty buffer persisted at path ("" = memory only).
func NewBuffer(path string) *Buffer {
	return &Buffer{path: path, maxAge: BufferMaxAge, maxLen: BufferMaxLen, nowFunc: time.Now, keysets: map[string]*keySet{}}
}

func (b *Buffer) setPath(p string) {
	b.mu.Lock()
	b.path = p
	b.mu.Unlock()
}

// intern returns the shared key set for names (sorted in place).
// Callers hold b.mu.
func (b *Buffer) intern(names []string) *keySet {
	sort.Strings(names)
	sig := strings.Join(names, "\x00")
	if ks, ok := b.keysets[sig]; ok {
		return ks
	}
	ks := &keySet{sig: sig, names: names}
	b.keysets[sig] = ks
	return ks
}

// pack converts a sample into a buffer item. Callers hold b.mu.
func (b *Buffer) pack(s proto.Sample) bufItem {
	names := make([]string, 0, len(s.Values))
	for k := range s.Values {
		names = append(names, k)
	}
	ks := b.intern(names)
	vals := make([]float64, len(ks.names))
	for i, k := range ks.names {
		vals[i] = s.Values[k]
	}
	b.next++
	return bufItem{id: b.next, at: s.At, keys: ks, vals: vals}
}

func (it *bufItem) sample() proto.Sample {
	m := make(map[string]float64, len(it.vals))
	for i, k := range it.keys.names {
		m[k] = it.vals[i]
	}
	return proto.Sample{At: it.at, Values: m}
}

// Add appends a sample and drops samples beyond the age and size limits.
func (b *Buffer) Add(s proto.Sample) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.items = append(b.items, b.pack(s))
	b.dirty = true
	b.trimLocked()
}

func (b *Buffer) trimLocked() {
	cut := 0
	if over := len(b.items) - b.maxLen; over > 0 {
		cut = over
	}
	limit := b.nowFunc().Add(-b.maxAge)
	for cut < len(b.items) && b.items[cut].at.Before(limit) {
		cut++
	}
	if cut > 0 {
		b.items = append(b.items[:0:0], b.items[cut:]...)
		b.dirty = true
		b.gcKeysetsLocked()
	}
}

// gcKeysetsLocked forgets key sets no buffered sample uses any more (the
// series names change when disks, volumes or guests come and go).
func (b *Buffer) gcKeysetsLocked() {
	if len(b.keysets) <= 16 {
		return
	}
	used := make(map[string]*keySet, len(b.keysets))
	for _, it := range b.items {
		used[it.keys.sig] = it.keys
	}
	b.keysets = used
}

// Len returns the number of buffered samples.
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.items)
}

// Peek returns up to n of the oldest samples and a token for Ack.
func (b *Buffer) Peek(n int) ([]proto.Sample, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.trimLocked()
	if n > len(b.items) {
		n = len(b.items)
	}
	out := make([]proto.Sample, n)
	var last uint64
	for i := 0; i < n; i++ {
		out[i] = b.items[i].sample()
		last = b.items[i].id
	}
	return out, last
}

// Ack removes every sample up to and including the token returned by Peek.
// Samples trimmed or added in between are handled correctly.
func (b *Buffer) Ack(token uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	i := 0
	for i < len(b.items) && b.items[i].id <= token {
		i++
	}
	if i > 0 {
		b.items = append(b.items[:0:0], b.items[i:]...)
		b.dirty = true
		b.gcKeysetsLocked()
	}
}

// Load reads the persisted buffer (missing file = empty) and drops samples
// beyond the age and size limits. A file that cannot be decoded, or that
// has an unknown format version, is renamed to <file>.corrupt so it can be
// inspected; the buffer then starts empty and Load returns an error
// wrapping ErrBufferUnreadable for the caller to log.
func (b *Buffer) Load() error {
	b.mu.Lock()
	path := b.path
	b.mu.Unlock()
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var f bufferFile
	var bad error
	if err := wire.Unmarshal(data, &f); err != nil {
		bad = fmt.Errorf("decode: %w", err)
	} else if f.Version != 1 && f.Version != bufferVersion {
		bad = fmt.Errorf("format version %d, want %d", f.Version, bufferVersion)
	} else if err := f.validate(); err != nil {
		bad = err
	}
	if bad != nil {
		moved := path + ".corrupt"
		if rerr := os.Rename(path, moved); rerr != nil {
			return fmt.Errorf("%w: %s: %v (and it could not be moved aside: %v)", ErrBufferUnreadable, path, bad, rerr)
		}
		return fmt.Errorf("%w: %s: %v; moved to %s, starting empty", ErrBufferUnreadable, path, bad, moved)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch f.Version {
	case 1:
		for _, s := range f.Samples {
			b.items = append(b.items, b.pack(s))
		}
	default:
		sets := make([]*keySet, len(f.Keys))
		for i, names := range f.Keys {
			sets[i] = b.intern(append([]string(nil), names...))
		}
		for _, p := range f.Packed {
			b.next++
			b.items = append(b.items, bufItem{id: b.next, at: p.At, keys: sets[p.Keys], vals: p.Vals})
		}
	}
	b.trimLocked()
	b.dirty = false
	return nil
}

// validate checks a version 2 file's references, so a damaged file is
// moved aside instead of panicking later.
func (f *bufferFile) validate() error {
	if f.Version != 2 {
		return nil
	}
	for i, k := range f.Keys {
		if !sort.StringsAreSorted(k) {
			return fmt.Errorf("key set %d is not sorted", i)
		}
	}
	for i, p := range f.Packed {
		if p.Keys < 0 || p.Keys >= len(f.Keys) || len(p.Vals) != len(f.Keys[p.Keys]) {
			return fmt.Errorf("sample %d: bad key set reference", i)
		}
	}
	return nil
}

// Save writes the buffer if it changed since the last save.
func (b *Buffer) Save() error {
	b.mu.Lock()
	path := b.path
	if path == "" || !b.dirty {
		b.mu.Unlock()
		return nil
	}
	f := bufferFile{Version: bufferVersion, Packed: make([]packedSample, len(b.items))}
	index := map[*keySet]int{}
	for i, it := range b.items {
		k, ok := index[it.keys]
		if !ok {
			k = len(f.Keys)
			index[it.keys] = k
			f.Keys = append(f.Keys, it.keys.names)
		}
		f.Packed[i] = packedSample{At: it.at, Keys: k, Vals: it.vals}
	}
	b.dirty = false
	b.mu.Unlock()
	// Key sets and value slices are never modified after a sample was
	// added, so they can be encoded outside the lock.
	data, err := wire.Marshal(f)
	if err == nil {
		err = WriteFileAtomic(path, data, 0o600)
	}
	if err != nil {
		b.mu.Lock()
		b.dirty = true
		b.mu.Unlock()
	}
	return err
}
