// Package narframe writes `nix-store --export` frames: one store path's NAR with its references and deriver, the input
// `nix-store --import` adds a path from (closure indexes, UP-X14). Used by the update helper (import) and the release
// tools (release-tools/nixexport); it has no dependencies so the helper's trusted base stays small.
//
// Format (Nix `exportPaths`): `u64 1`, the NAR, `u64 0x4558494e` ("NIXE"), the store path, the number of references
// and each reference, the deriver, `u64 0` (no signature); after the last path `u64 0`. Integers are little-endian
// u64; strings a u64 length, the bytes, zero padding to a multiple of 8.
package narframe

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// ExportMagic follows the NAR of each path.
const ExportMagic = 0x4558494e

func pad(n uint64) int { return int((8 - n%8) % 8) }

func putU64(w io.Writer, n uint64) error {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], n)
	_, err := w.Write(b[:])
	return err
}

func putStr(w io.Writer, s string) error {
	if err := putU64(w, uint64(len(s))); err != nil {
		return err
	}
	if _, err := io.WriteString(w, s); err != nil {
		return err
	}
	var zero [8]byte
	_, err := w.Write(zero[:pad(uint64(len(s)))])
	return err
}

// ErrNarSize: the NAR given to WriteFrame was not exactly narSize bytes.
var ErrNarSize = errors.New("nixexport: the NAR is not the announced size")

// WriteFrame writes one path of an export stream: `u64 1`, the NAR (exactly narSize bytes read from nar, which must
// end there: one more read must return io.EOF, so a reader that checks the NAR's hash at its end can still refuse it
// before the frame is complete), `u64 0x4558494e`, the store path, the references, the deriver and `u64 0` (no
// signature). WriteEnd ends the stream.
func WriteFrame(w io.Writer, storePath string, references []string, deriver string, narSize int64, nar io.Reader) error {
	if err := putU64(w, 1); err != nil {
		return err
	}
	n, err := io.CopyN(w, nar, narSize)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("%w: %d bytes, want %d", ErrNarSize, n, narSize)
		}
		return err
	}
	var probe [1]byte
	if k, err := nar.Read(probe[:]); k != 0 || !errors.Is(err, io.EOF) {
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		return fmt.Errorf("%w: longer than %d bytes", ErrNarSize, narSize)
	}
	if err := putU64(w, ExportMagic); err != nil {
		return err
	}
	if err := putStr(w, storePath); err != nil {
		return err
	}
	if err := putU64(w, uint64(len(references))); err != nil {
		return err
	}
	for _, r := range references {
		if err := putStr(w, r); err != nil {
			return err
		}
	}
	if err := putStr(w, deriver); err != nil {
		return err
	}
	return putU64(w, 0)
}

// WriteEnd writes the end of an export stream (`u64 0`).
func WriteEnd(w io.Writer) error { return putU64(w, 0) }
