package screen

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

// Every socket descriptor of the helper's process must be read: one the
// kernel won't describe is read again from a fresh list once, and when it
// still can't be, nothing is answered (it could be the connection held a
// second time).
func TestHolderRefs(t *testing.T) {
	near := unixSock{so: 0xa1, conn: 0xb2}
	socks := map[int]unixSock{
		3: {so: 0x10, conn: 0x11},               // another connection
		7: {so: 0xb2, conn: 0xa1},               // the far end of the agent's
		9: {so: 0xb2, conn: 0xa1, shared: true}, // the same, shared
	}
	lists := 0
	fds := [][]int{{3, 7}, {3, 7}}
	unreadable := map[int]int{} // fd: how many more reads fail
	list := func() ([]int, error) {
		l := fds[min(lists, len(fds)-1)]
		lists++
		return l, nil
	}
	read := func(fd int) (unixSock, bool, error) {
		if unreadable[fd] > 0 {
			unreadable[fd]--
			return unixSock{}, false, errors.New("can't read descriptor")
		}
		s, ok := socks[fd]
		return s, ok, nil
	}
	refs, err := holderRefs(42, near, list, read)
	if err != nil || !slices.Equal(refs, []sockRef{{fd: 7}}) || lists != 1 {
		t.Fatalf("all read: %+v %v after %d lists", refs, err, lists)
	}
	// One can't be read once: the list is read again, and it can then.
	lists, unreadable[3] = 0, 1
	if refs, err := holderRefs(42, near, list, read); err != nil || len(refs) != 1 || lists != 2 {
		t.Fatalf("read again: %+v %v after %d lists", refs, err, lists)
	}
	// Closed meanwhile: gone from the second list.
	lists, unreadable[3], fds = 0, 1, [][]int{{3, 7}, {7}}
	if refs, err := holderRefs(42, near, list, read); err != nil || len(refs) != 1 || lists != 2 {
		t.Fatalf("closed meanwhile: %+v %v", refs, err)
	}
	// Still unreadable: no answer, and so no trust.
	lists, unreadable[3], fds = 0, 2, [][]int{{3, 7}, {3, 7}}
	if refs, err := holderRefs(42, near, list, read); err == nil || refs != nil || !strings.Contains(err.Error(), "every descriptor of process 42") {
		t.Fatalf("unreadable twice: %+v %v", refs, err)
	}
	// Held twice, one copy shared.
	fds = [][]int{{7, 9}}
	if refs, err := holderRefs(42, near, list, read); err != nil || !slices.Equal(refs, []sockRef{{fd: 7}, {fd: 9, shared: true}}) {
		t.Fatalf("twice: %+v %v", refs, err)
	}
	// The list itself can't be read.
	if _, err := holderRefs(42, near, func() ([]int, error) { return nil, errors.New("no list") }, read); err == nil {
		t.Fatal("no list: answered")
	}
}
