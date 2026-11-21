package nixexport

import (
	"bytes"
	"encoding/binary"
	"sort"
)

// SyntheticPath is one store path of a synthetic export stream: a directory with regular files.
type SyntheticPath struct {
	StorePath  string
	Files      map[string]string
	References []string
}

type builder struct{ bytes.Buffer }

func (b *builder) u64(n uint64) {
	var x [8]byte
	binary.LittleEndian.PutUint64(x[:], n)
	b.Write(x[:])
}

func (b *builder) str(s string) {
	b.u64(uint64(len(s)))
	b.WriteString(s)
	b.Write(make([]byte, pad(uint64(len(s)))))
}

// Synthetic builds a well-formed `nix-store --export` stream (for tests of the release tooling without Nix).
func Synthetic(paths ...SyntheticPath) []byte {
	var b builder
	for _, p := range paths {
		b.u64(1)
		b.str("nix-archive-1")
		b.str("(")
		b.str("type")
		b.str("directory")
		names := make([]string, 0, len(p.Files))
		for n := range p.Files {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			for _, t := range []string{"entry", "(", "name", n, "node", "(", "type", "regular", "contents"} {
				b.str(t)
			}
			b.str(p.Files[n])
			b.str(")")
			b.str(")")
		}
		b.str(")")
		b.u64(exportMagic)
		b.str(p.StorePath)
		b.u64(uint64(len(p.References)))
		for _, r := range p.References {
			b.str(r)
		}
		b.str("")
		b.u64(0)
	}
	b.u64(0)
	return b.Bytes()
}
