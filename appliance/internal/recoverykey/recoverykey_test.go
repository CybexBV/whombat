package recoverykey

import (
	"bytes"
	"strings"
	"testing"
)

var fast = Params{MemoryKiB: 64, Time: 1, Threads: 1}

func TestNewAndNormalize(t *testing.T) {
	k, err := New(bytes.NewReader(bytes.Repeat([]byte{0x01, 0xfe}, 16)))
	if err != nil || !Valid(k) {
		t.Fatalf("%q %v", k, err)
	}
	if g := strings.Split(k, "-"); len(g) != 8 || g[7] != "cbvucbvu" {
		t.Fatalf("groups of %q", k)
	}
	for _, typed := range []string{
		strings.ToUpper(k),
		strings.ReplaceAll(k, "-", ""),
		" " + strings.ReplaceAll(k, "-", " ") + "\n",
		"\uFEFF" + k,
	} {
		n, err := Normalize(typed)
		if err != nil || n != k {
			t.Errorf("Normalize(%q) = %q, %v", typed, n, err)
		}
	}
	for _, bad := range []string{"", k[:70], k + "c", strings.Replace(k, "c", "a", 1), strings.Replace(k, "c", "ｃ", 1)} {
		if _, err := Normalize(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if Valid(strings.ToUpper(k)) || Valid(strings.ReplaceAll(k, "-", "")) {
		t.Fatal("Valid accepts a non-canonical form")
	}
}

func TestHashVerify(t *testing.T) {
	k, _ := New(nil)
	h, err := Hash(nil, k, fast)
	if err != nil || !strings.HasPrefix(h, "$argon2id$v=19$m=64,t=1,p=1$") {
		t.Fatalf("%q %v", h, err)
	}
	if ok, err := Verify(h, strings.ToUpper(k)); !ok || err != nil {
		t.Fatalf("right key refused: %v", err)
	}
	other, _ := New(nil)
	if ok, _ := Verify(h, other); ok {
		t.Fatal("wrong key accepted")
	}
	if ok, err := Verify(h, "not a key"); ok || err != nil {
		t.Fatalf("garbage: %v %v", ok, err)
	}
	h2, _ := Hash(nil, k, fast)
	if h2 == h {
		t.Fatal("no salt")
	}
	for _, bad := range []string{
		"", "$argon2i$v=19$m=64,t=1,p=1$c2FsdHNhbHQ$" + strings.Repeat("A", 43),
		strings.Replace(h, "m=64", "m=99999999", 1),
		strings.Replace(h, "t=1", "t=0", 1),
		strings.Replace(h, ",p=1", ",p=1,x=2", 1),
		h[:len(h)-4],
	} {
		if _, err := Verify(bad, k); err == nil {
			t.Errorf("accepted hash %q", bad)
		}
	}
	if _, err := Hash(nil, "cbdefghi", fast); err == nil {
		t.Fatal("hashed a non-key")
	}
}
