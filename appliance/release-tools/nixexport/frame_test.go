package nixexport

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// A frame written around a path's NAR reads back as an export stream with the same NAR hash, size, references and
// deriver; a NAR of the wrong size never completes the frame.
func TestWriteFrameRoundTrip(t *testing.T) {
	lib := "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-lib"
	app := "/nix/store/1123456789abcdfghijklmnpqrsvwxyz-app"
	src, nars, err := ReadNARs(bytes.NewReader(Synthetic(
		SyntheticPath{StorePath: lib, Files: map[string]string{"libc.so": "libc"}},
		SyntheticPath{StorePath: app, Files: map[string]string{"bin": "app", "odd": "x"}, References: []string{lib, app}},
	)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	for _, p := range src.Paths {
		if err := WriteFrame(&out, p.StorePath, p.References, "/nix/store/2123456789abcdfghijklmnpqrsvwxyz-app.drv", p.NarSize, bytes.NewReader(nars[p.StorePath])); err != nil {
			t.Fatal(err)
		}
	}
	WriteEnd(&out)
	got, err := Read(&out)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range got.Paths {
		w := src.Paths[i]
		if p.StorePath != w.StorePath || p.NarHash != w.NarHash || p.NarSize != w.NarSize || strings.Join(p.References, ",") != strings.Join(w.References, ",") ||
			!strings.HasSuffix(p.Deriver, "-app.drv") {
			t.Fatalf("%+v != %+v", p, w)
		}
	}
	nar := nars[lib]
	for name, r := range map[string][]byte{"short": nar[:len(nar)-8], "long": append(append([]byte{}, nar...), 0)} {
		if err := WriteFrame(&bytes.Buffer{}, lib, nil, "", int64(len(nar)), bytes.NewReader(r)); !errors.Is(err, ErrNarSize) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestTopoOrder(t *testing.T) {
	refs := map[string][]string{"d": {"b", "c", "d"}, "c": {"a"}, "b": {"a"}, "a": {"a"}, "e": {}}
	got, err := TopoOrder(refs)
	if err != nil || strings.Join(got, "") != "abcde" {
		t.Fatalf("%v %v", got, err)
	}
	// Ties are broken by name, independent of map order: the same input always gives the same order.
	for i := 0; i < 20; i++ {
		again, _ := TopoOrder(refs)
		if strings.Join(again, "") != "abcde" {
			t.Fatalf("not deterministic: %v", again)
		}
	}
	if _, err := TopoOrder(map[string][]string{"a": {"b"}}); err == nil {
		t.Fatal("missing reference accepted")
	}
	if _, err := TopoOrder(map[string][]string{"a": {"b"}, "b": {"a"}}); err == nil {
		t.Fatal("cycle accepted")
	}
}
