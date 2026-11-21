package nixexport

import (
	"container/heap"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/CybexBV/whombat/appliance/helper/pkg/narframe"
)

// The write side (UP-X14): one store path's NAR wrapped into an export frame (helper/pkg/narframe, shared with the
// update helper), so `nix-store --import` adds it with its references and deriver, and the deterministic import order
// of a closure.

// ErrNarSize: the NAR given to WriteFrame was not exactly narSize bytes.
var ErrNarSize = narframe.ErrNarSize

// WriteFrame writes one path of an export stream (narframe.WriteFrame).
func WriteFrame(w io.Writer, storePath string, references []string, deriver string, narSize int64, nar io.Reader) error {
	return narframe.WriteFrame(w, storePath, references, deriver, narSize, nar)
}

// WriteEnd writes the end of an export stream.
func WriteEnd(w io.Writer) error { return narframe.WriteEnd(w) }

// TopoOrder returns the store paths of a closure in import order: every reference (other than the path itself)
// before the path, ties broken by store path, so the order is deterministic. refs maps every path to its references;
// a reference outside refs is an error (the closure is incomplete), as is a cycle.
func TopoOrder(refs map[string][]string) ([]string, error) {
	pending := make(map[string]int, len(refs))    // unresolved references
	users := make(map[string][]string, len(refs)) // reference -> paths that reference it
	for p, rs := range refs {
		seen := map[string]bool{}
		for _, r := range rs {
			if r == p || seen[r] {
				continue
			}
			seen[r] = true
			if _, ok := refs[r]; !ok {
				return nil, fmt.Errorf("nixexport: %s references %s, which is not in the closure", p, r)
			}
			pending[p]++
			users[r] = append(users[r], p)
		}
	}
	ready := &strHeap{}
	for p := range refs {
		if pending[p] == 0 {
			heap.Push(ready, p)
		}
	}
	out := make([]string, 0, len(refs))
	for ready.Len() > 0 {
		p := heap.Pop(ready).(string)
		out = append(out, p)
		for _, u := range users[p] {
			if pending[u]--; pending[u] == 0 {
				heap.Push(ready, u)
			}
		}
	}
	if len(out) != len(refs) {
		return nil, errors.New("nixexport: the references form a cycle")
	}
	return out, nil
}

type strHeap struct{ sort.StringSlice }

func (h *strHeap) Push(x any) { h.StringSlice = append(h.StringSlice, x.(string)) }
func (h *strHeap) Pop() any {
	old := h.StringSlice
	x := old[len(old)-1]
	h.StringSlice = old[:len(old)-1]
	return x
}
