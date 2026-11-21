package hostmetrics

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"os"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// maxSafe is the largest integer JSON carries exactly (the contract's byte counts stop there).
const maxSafe = 1<<53 - 1

func safe(v uint64) int64 { return int64(min(v, maxSafe)) }

// sat is a·b, saturating.
func sat(a, b uint64) uint64 {
	if a != 0 && b > math.MaxUint64/a {
		return math.MaxUint64
	}
	return a * b
}

// sample is one measurement: the processor's busy share and the memory used at the time, and the bytes moved since
// the previous sample. slot is the 10-second step it belongs to (the middle of the interval it measured).
type sample struct {
	at            int64 // unix seconds
	slot          int64
	cpu           uint16
	cores         int
	memTotal      uint64
	memUsed       uint64
	containersMem *uint64
	uplink        []string
	in, out       uint64
	power         *HostPower // HostNow.power; nil without a battery (not kept in the history)
	cpuTemp       *int64     // HostNow.cpuTempC, °C; nil without a sensor (not kept in the history)
	uptime        *int64     // HostNow.uptimeS
}

// bucket is one step's measurements (BS-03): the samples' processor and memory sums (for the averages), the busiest
// sample and the bytes moved. start 0 is an empty bucket.
type bucket struct {
	start   int64
	n       uint32
	cpuSum  uint32
	cpuPeak uint16
	memSum  uint64
	in, out uint64
}

func (b *bucket) add(s *sample) {
	b.n++
	b.cpuSum += uint32(s.cpu)
	b.cpuPeak = max(b.cpuPeak, s.cpu)
	b.memSum += s.memUsed
	b.in += s.in
	b.out += s.out
}

func (b *bucket) merge(o *bucket) {
	b.n += o.n
	b.cpuSum += o.cpuSum
	b.cpuPeak = max(b.cpuPeak, o.cpuPeak)
	b.memSum += o.memSum
	b.in += o.in
	b.out += o.out
}

// point is the bucket as a chart point; nil when nothing was measured in it.
func (b *bucket) point() *protocol.HostPoint {
	if b.n == 0 {
		return nil
	}
	n := uint64(b.n)
	return &protocol.HostPoint{
		CpuPermille: int64(min((uint64(b.cpuSum)+n/2)/n, 1000)), CpuPeakPermille: int64(min(b.cpuPeak, 1000)),
		MemoryUsedBytes: safe((b.memSum + n/2) / n),
		InBytes:         safe(b.in), OutBytes: safe(b.out),
	}
}

// ring keeps buckets of width seconds, the bucket starting at t at index (t/width) mod capacity, in memory and (with
// a file) on disk. A slot holds one start at a time: a newer start replaces an older one in place.
type ring struct {
	width int64
	recs  []bucket
	file  *ringFile
}

func newRing(width int64, capacity int) *ring {
	return &ring{width: width, recs: make([]bucket, capacity)}
}

func (r *ring) index(start int64) int {
	i := (start / r.width) % int64(len(r.recs))
	if i < 0 {
		i += int64(len(r.recs))
	}
	return int(i)
}

// at is the bucket starting at start, nil when the ring doesn't hold it (never measured, or overwritten since).
func (r *ring) at(start int64) *bucket {
	b := &r.recs[r.index(start)]
	if b.start != start || b.n == 0 {
		return nil
	}
	return b
}

// slot is the bucket starting at start, emptied first when its place held another start.
func (r *ring) slot(start int64) *bucket {
	b := &r.recs[r.index(start)]
	if b.start != start {
		*b = bucket{start: start}
	}
	return b
}

// span is the time the ring covers.
func (r *ring) span() int64 { return r.width * int64(len(r.recs)) }

// oldest is the start of the oldest bucket with samples in [now − span, now], 0 when there is none. Buckets outside
// it are left by a clock that was wrong; they are never shown and are overwritten in time.
func (r *ring) oldest(now int64) int64 {
	var o int64
	for i := range r.recs {
		b := &r.recs[i]
		if b.n == 0 || b.start > now || b.start < now-r.span() {
			continue
		}
		if o == 0 || b.start < o {
			o = b.start
		}
	}
	return o
}

// write puts the bucket starting at start in the ring's file (nothing without a file, or when the ring no longer
// holds that start).
func (r *ring) write(start int64) error {
	if r.file == nil {
		return nil
	}
	i := r.index(start)
	if r.recs[i].start != start {
		return nil
	}
	return r.file.write(i, &r.recs[i])
}

/* The ring file ---------------------------------------------------------------------------------------------------- */

// A ring file (BS-03) is a 64-byte header and capacity fixed-size 64-byte records, each bucket written in place at its
// index (pwrite), so the file never grows and is never rewritten whole: the manager writes two records a minute (128
// bytes). Little-endian.
//
//	header:  0 "WBHM"  4 version u16  6 record size u16  8 width s u32  12 capacity u32  16… zero  60 crc32(0:60)
//	record:  0 start i64  8 n u32  12 cpuSum u32  16 memSum u64  24 in u64  32 out u64  40 zero u64
//	         48 zero u64  56 cpuPeak u16  58 zero u16  60 crc32(0:60)
//
// Bytes 40…55 were the computers' traffic until they went (NX-455, NX-468): written as zero, never read, so the
// file's version and what it holds stay.
//
// A header that doesn't match (another version, width or capacity, a torn or foreign file) or a file of another size
// starts the ring afresh; a record whose checksum, start or place is wrong (a torn write, a sector gone bad) reads
// as empty. All zeros is an empty record.
const (
	fileMagic   = "WBHM"
	fileVersion = 1
	headerSize  = 64
	recordSize  = 64
)

type ringFile struct {
	f        *os.File
	width    int64
	capacity int
}

var errFresh = errors.New("started afresh")

// openRing opens (or creates) the ring file at path, loads its buckets into r and makes it r's file. A file it can't
// use is started afresh: openRing then returns the file and an error wrapping errFresh, which says why.
func openRing(path string, r *ring) (*ringFile, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	rf := &ringFile{f: f, width: r.width, capacity: len(r.recs)}
	why := rf.load(r)
	if why == nil {
		r.file = rf
		return rf, nil
	}
	if err := rf.reset(); err != nil {
		f.Close()
		return nil, err
	}
	for i := range r.recs {
		r.recs[i] = bucket{}
	}
	r.file = rf
	return rf, fmt.Errorf("%w: %v", errFresh, why)
}

func (rf *ringFile) size() int64 { return headerSize + int64(rf.capacity)*recordSize }

func (rf *ringFile) header() []byte {
	h := make([]byte, headerSize)
	copy(h, fileMagic)
	binary.LittleEndian.PutUint16(h[4:], fileVersion)
	binary.LittleEndian.PutUint16(h[6:], recordSize)
	binary.LittleEndian.PutUint32(h[8:], uint32(rf.width))
	binary.LittleEndian.PutUint32(h[12:], uint32(rf.capacity))
	binary.LittleEndian.PutUint32(h[60:], crc32.ChecksumIEEE(h[:60]))
	return h
}

// load reads the file into r; an error says why the file can't be used (an empty new file is one too).
func (rf *ringFile) load(r *ring) error {
	fi, err := rf.f.Stat()
	if err != nil {
		return err
	}
	if fi.Size() != rf.size() {
		return fmt.Errorf("%d bytes, not %d", fi.Size(), rf.size())
	}
	buf := make([]byte, rf.size())
	if _, err := io.ReadFull(io.NewSectionReader(rf.f, 0, rf.size()), buf); err != nil {
		return err
	}
	if string(buf[:headerSize]) != string(rf.header()) {
		return errors.New("another header")
	}
	for i := range r.recs {
		r.recs[i] = bucket{}
		if b, ok := decodeRecord(buf[headerSize+i*recordSize:][:recordSize]); ok && b.start%r.width == 0 && r.index(b.start) == i {
			r.recs[i] = b
		}
	}
	return nil
}

// reset makes the file a new empty ring: the header, then zeros (a sparse file until written).
func (rf *ringFile) reset() error {
	if err := rf.f.Truncate(0); err != nil {
		return err
	}
	if _, err := rf.f.WriteAt(rf.header(), 0); err != nil {
		return err
	}
	return rf.f.Truncate(rf.size())
}

func (rf *ringFile) write(i int, b *bucket) error {
	_, err := rf.f.WriteAt(encodeRecord(b), headerSize+int64(i)*recordSize)
	return err
}

func (rf *ringFile) close() error { return rf.f.Close() }

func encodeRecord(b *bucket) []byte {
	p := make([]byte, recordSize)
	le := binary.LittleEndian
	le.PutUint64(p[0:], uint64(b.start))
	le.PutUint32(p[8:], b.n)
	le.PutUint32(p[12:], b.cpuSum)
	le.PutUint64(p[16:], b.memSum)
	le.PutUint64(p[24:], b.in)
	le.PutUint64(p[32:], b.out)
	le.PutUint16(p[56:], b.cpuPeak)
	le.PutUint32(p[60:], crc32.ChecksumIEEE(p[:60]))
	return p
}

// decodeRecord reads a record; false for an empty or damaged one.
func decodeRecord(p []byte) (bucket, bool) {
	le := binary.LittleEndian
	if le.Uint32(p[60:]) != crc32.ChecksumIEEE(p[:60]) {
		return bucket{}, false
	}
	b := bucket{start: int64(le.Uint64(p[0:])), n: le.Uint32(p[8:]), cpuSum: le.Uint32(p[12:]), memSum: le.Uint64(p[16:]),
		in: le.Uint64(p[24:]), out: le.Uint64(p[32:]), cpuPeak: le.Uint16(p[56:])}
	if b.n == 0 || b.start <= 0 || b.cpuPeak > 1000 || uint64(b.cpuSum) > uint64(b.n)*1000 {
		return bucket{}, false
	}
	return b, true
}
