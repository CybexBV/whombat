package trust

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"

	"github.com/klauspost/compress/zstd"
)

// ErrNarMismatch: a blob does not decompress to the NAR the index names (hash or size).
var ErrNarMismatch = errors.New("blob does not decompress to the indexed NAR")

// MaxDecoderWindow bounds the zstd window a blob may ask for (decoder memory).
const MaxDecoderWindow = 128 << 20

// NarReader decompresses a blob (zstd). Reading more than narSize+1 bytes is never possible: the reader ends there
// (a longer output is reported by VerifyNar / the import as a size mismatch). Close releases the decoder.
type NarReader struct {
	dec *zstd.Decoder
	r   io.Reader
}

// NewNarReader returns a bounded decompressor for one blob (one decoder goroutine, window ≤ 128 MiB, low memory).
func NewNarReader(compressed io.Reader, narSize int64) (*NarReader, error) {
	dec, err := zstd.NewReader(compressed, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxWindow(MaxDecoderWindow),
		zstd.WithDecoderLowmem(true))
	if err != nil {
		return nil, err
	}
	return &NarReader{dec: dec, r: io.LimitReader(dec, narSize+1)}, nil
}

// Read implements io.Reader.
func (n *NarReader) Read(p []byte) (int, error) { return n.r.Read(p) }

// Close releases the decoder.
func (n *NarReader) Close() error { n.dec.Close(); return nil }

// VerifyNar decompresses a blob and checks that it is exactly the NAR (sha256:<hex> narHash, narSize bytes). Errors
// of the data (corrupt zstd, too long, wrong hash) wrap ErrNarMismatch.
func VerifyNar(compressed io.Reader, narHash string, narSize int64) error {
	nr, err := NewNarReader(compressed, narSize)
	if err != nil {
		return err
	}
	defer nr.Close()
	h := sha256.New()
	n, err := io.Copy(h, nr)
	if err != nil {
		var rerr readError
		if errors.As(err, &rerr) {
			return rerr.err
		}
		return fmt.Errorf("%w: %v", ErrNarMismatch, err)
	}
	if n != narSize {
		return fmt.Errorf("%w: %d bytes, want %d", ErrNarMismatch, n, narSize)
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != narHash {
		return fmt.Errorf("%w: NAR hash %s, want %s", ErrNarMismatch, got, narHash)
	}
	return nil
}

// readError marks an error of the underlying reader (I/O), not of the data.
type readError struct{ err error }

func (e readError) Error() string { return e.err.Error() }

// IOReader wraps r so that VerifyNar reports its errors as they are (not as ErrNarMismatch).
func IOReader(r io.Reader) io.Reader { return ioReader{r} }

type ioReader struct{ r io.Reader }

func (i ioReader) Read(p []byte) (int, error) {
	n, err := i.r.Read(p)
	if err != nil && err != io.EOF {
		return n, readError{err}
	}
	return n, err
}

// CheckingNarReader passes a decompressed NAR through and, where it ends, checks its size and hash: instead of io.EOF
// a wrong NAR yields an error wrapping ErrNarMismatch, so a consumer that completes its work only at a clean EOF (an
// export frame) never accepts it.
func CheckingNarReader(r io.Reader, narHash string, narSize int64) io.Reader {
	return &checkingReader{r: r, h: sha256.New(), want: narHash, size: narSize}
}

type checkingReader struct {
	r    io.Reader
	h    hash.Hash
	n    int64
	want string
	size int64
}

func (c *checkingReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n += int64(k)
	c.h.Write(p[:k])
	if c.n > c.size {
		return k, fmt.Errorf("%w: longer than %d bytes", ErrNarMismatch, c.size)
	}
	if errors.Is(err, io.EOF) {
		if c.n != c.size {
			return k, fmt.Errorf("%w: %d bytes, want %d", ErrNarMismatch, c.n, c.size)
		}
		if got := "sha256:" + hex.EncodeToString(c.h.Sum(nil)); got != c.want {
			return k, fmt.Errorf("%w: NAR hash %s, want %s", ErrNarMismatch, got, c.want)
		}
	}
	return k, err
}
