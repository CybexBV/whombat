//go:build unix

package diskusage

import (
	"errors"
	"io/fs"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

func TestDarwinPuregoErrnoMasksUpper32Bits(t *testing.T) {
	withUpper32 := func(high, low uint32) uintptr {
		return uintptr(uint64(high)<<32 | uint64(low))
	}

	cases := []struct {
		name      string
		high      uint32
		want      unix.Errno
		stdTarget error
	}{
		{"ERANGE", 0x6dddc000, unix.ERANGE, nil},
		{"EINTR", 0xdeadbeef, unix.EINTR, nil},
		{"ENOENT", 0x00010002, unix.ENOENT, fs.ErrNotExist},
		{"EACCES", 0xffffffff, unix.EACCES, fs.ErrPermission},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := withUpper32(tc.high, uint32(tc.want))
			if unsafe.Sizeof(uintptr(0)) == 8 && unix.Errno(raw) == tc.want {
				t.Fatalf("expected unmasked 64-bit errno %#x to differ from %v", raw, tc.want)
			}
			got := darwinPuregoErrno(raw)
			if got != tc.want || !errors.Is(got, tc.want) {
				t.Fatalf("darwinPuregoErrno(%#x) = %v (%#x), want %v", raw, got, uintptr(got), tc.want)
			}
			if tc.stdTarget != nil && !errors.Is(got, tc.stdTarget) {
				t.Errorf("errors.Is(%v, %v) = false, want true", got, tc.stdTarget)
			}
		})
	}
}
