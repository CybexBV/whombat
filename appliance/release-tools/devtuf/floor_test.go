package devtuf

import (
	"testing"

	"github.com/CybexBV/whombat/contracts/go/release"
)

func TestParseClientFloor(t *testing.T) {
	f, err := ParseClientFloor(" android=4021, web=120,cli=0 ")
	if err != nil || f == nil || *f != (release.ClientFloor{Web: 120, Android: 4021}) {
		t.Fatalf("%+v %v", f, err)
	}
	if f, err := ParseClientFloor(""); f != nil || err != nil {
		t.Fatalf("empty: %+v %v", f, err)
	}
	if f, err := ParseClientFloor("ios=2147483647,desktop=3"); err != nil || f.Ios != 2147483647 || f.Desktop != 3 {
		t.Fatalf("%+v %v", f, err)
	}
	for _, bad := range []string{"android", "tv=3", "web=-1", "web=2147483648", "web=1.5", "web=1,web=2", "web=", "android=4021,"} {
		if f, err := ParseClientFloor(bad); err == nil {
			t.Errorf("%q accepted: %+v", bad, f)
		}
	}
}
