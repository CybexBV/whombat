package models

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sum = "4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e"

func TestParse(t *testing.T) {
	ok := `{"models":[{"id":"parakeet","file":"ggml-parakeet-tdt-0.6b-v3-q8_0.bin","url":"https://huggingface.co/x","size":668757119,"sha256":"` + sum + `"}]}`
	m, err := Parse([]byte(ok))
	if err != nil || len(m.Models) != 1 {
		t.Fatal(err)
	}
	if x, found := m.Find("parakeet"); !found || x.Size != 668757119 || x.Multi() || x.TotalSize() != 668757119 {
		t.Fatal(x)
	}
	if _, found := m.Find("whisper"); found {
		t.Fatal("whisper found")
	}
	multi := `{"models":[` +
		`{"id":"parakeet","file":"p.bin","url":"https://huggingface.co/p","size":10,"sha256":"` + sum + `"},` +
		`{"id":"supertonic","dir":"supertonic-3-int8","files":[` +
		`{"name":"vocoder.int8.onnx","url":"https://huggingface.co/v","size":100,"sha256":"` + sum + `"},` +
		`{"name":"LICENSE","url":"https://huggingface.co/l","size":25,"sha256":"` + sum + `"}` +
		`]}]}`
	mm, err := Parse([]byte(multi))
	if err != nil || len(mm.Models) != 2 {
		t.Fatal(err)
	}
	if s, found := mm.Find("supertonic"); !found || !s.Multi() || s.TotalSize() != 125 || len(s.Files) != 2 {
		t.Fatal(s)
	}
	for name, bad := range map[string]string{
		"unknown id":        strings.Replace(ok, `"parakeet"`, `"canary"`, 1),
		"a path":            strings.Replace(ok, `ggml-parakeet`, `../ggml-parakeet`, 1),
		"a part name":       strings.Replace(ok, `q8_0.bin"`, `q8_0.bin.part"`, 1),
		"plain http":        strings.Replace(ok, `https://huggingface.co`, `http://huggingface.co`, 1),
		"no size":           strings.Replace(ok, `668757119`, `0`, 1),
		"upper case":        strings.Replace(ok, sum, strings.ToUpper(sum), 1),
		"twice":             strings.Replace(ok, `}]}`, `},`+ok[11:len(ok)-2]+`]}`, 1),
		"no models":         `{"models":[]}`,
		"not json":          `{`,
		"neither file/dir":  `{"models":[{"id":"supertonic"}]}`,
		"both file and dir": `{"models":[{"id":"supertonic","file":"a.bin","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `","dir":"d","files":[{"name":"b","url":"https://huggingface.co/b","size":1,"sha256":"` + sum + `"}]}]}`,
		"multi empty files": `{"models":[{"id":"supertonic","dir":"supertonic-3-int8","files":[]}]}`,
		"multi bad dir":     `{"models":[{"id":"supertonic","dir":"../escape","files":[{"name":"a","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"}]}]}`,
		"multi part dir":    `{"models":[{"id":"supertonic","dir":"supertonic.part","files":[{"name":"a","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"}]}]}`,
		"multi bad file":    `{"models":[{"id":"supertonic","dir":"d","files":[{"name":"../a","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"}]}]}`,
		"multi dup file":    `{"models":[{"id":"supertonic","dir":"d","files":[{"name":"a","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"},{"name":"a","url":"https://huggingface.co/b","size":2,"sha256":"` + sum + `"}]}]}`,
		"multi plain http":  `{"models":[{"id":"supertonic","dir":"d","files":[{"name":"a","url":"http://huggingface.co/a","size":1,"sha256":"` + sum + `"}]}]}`,
		"multi zero size":   `{"models":[{"id":"supertonic","dir":"d","files":[{"name":"a","url":"https://huggingface.co/a","size":0,"sha256":"` + sum + `"}]}]}`,
		"multi bad sha":     `{"models":[{"id":"supertonic","dir":"d","files":[{"name":"a","url":"https://huggingface.co/a","size":1,"sha256":"deadbeef"}]}]}`,
		"duplicate target":  `{"models":[{"id":"parakeet","file":"same","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"},{"id":"supertonic","dir":"same","files":[{"name":"a","url":"https://huggingface.co/a","size":1,"sha256":"` + sum + `"}]}]}`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestPresent(t *testing.T) {
	dir := t.TempDir()
	x := Model{ID: "parakeet", File: "p.bin", Size: 3}
	if Present(dir, x) {
		t.Fatal("present without a file")
	}
	_ = os.WriteFile(filepath.Join(dir, "p.bin"), []byte("ab"), 0o644)
	if Present(dir, x) {
		t.Fatal("present with fewer bytes")
	}
	_ = os.WriteFile(filepath.Join(dir, "p.bin"), []byte("abc"), 0o644)
	if !Present(dir, x) || PartPath(dir, x) != filepath.Join(dir, ".p.bin.part") {
		t.Fatal("not present")
	}
	_ = os.WriteFile(PartPath(dir, x), []byte("ab"), 0o644)
	if got := PartialSize(dir, x); got != 2 {
		t.Fatalf("partial size %d, want 2", got)
	}
}

func TestPresentAndPartialMulti(t *testing.T) {
	dir := t.TempDir()
	x := Model{
		ID:  "supertonic",
		Dir: "supertonic-3-int8",
		Files: []File{
			{Name: "a.bin", Size: 4},
			{Name: "b.bin", Size: 3},
		},
	}
	if Path(dir, x) != filepath.Join(dir, "supertonic-3-int8") || PartPath(dir, x) != filepath.Join(dir, ".supertonic-3-int8.part") {
		t.Fatalf("paths: %q %q", Path(dir, x), PartPath(dir, x))
	}
	if Present(dir, x) {
		t.Fatal("present without directory")
	}
	_ = os.MkdirAll(Path(dir, x), 0o755)
	_ = os.WriteFile(filepath.Join(Path(dir, x), "a.bin"), []byte("1234"), 0o644)
	if Present(dir, x) {
		t.Fatal("present with missing file")
	}
	_ = os.WriteFile(filepath.Join(Path(dir, x), "b.bin"), []byte("12"), 0o644)
	if Present(dir, x) {
		t.Fatal("present with short file")
	}
	_ = os.WriteFile(filepath.Join(Path(dir, x), "b.bin"), []byte("123"), 0o644)
	if !Present(dir, x) {
		t.Fatal("not present when all files match")
	}
	// PartialSize counts completed files and in-progress part files in the staging directory.
	stage := PartPath(dir, x)
	_ = os.MkdirAll(stage, 0o755)
	_ = os.WriteFile(filepath.Join(stage, "a.bin"), []byte("1234"), 0o644)
	_ = os.WriteFile(filepath.Join(stage, ".b.bin.part"), []byte("12"), 0o644)
	if got := PartialSize(dir, x); got != 6 {
		t.Fatalf("multi partial size %d, want 6", got)
	}
}
