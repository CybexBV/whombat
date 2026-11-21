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
	if x, found := m.Find("parakeet"); !found || x.Size != 668757119 {
		t.Fatal(x)
	}
	if _, found := m.Find("whisper"); found {
		t.Fatal("whisper found")
	}
	for name, bad := range map[string]string{
		"unknown id":  strings.Replace(ok, `"parakeet"`, `"canary"`, 1),
		"a path":      strings.Replace(ok, `ggml-parakeet`, `../ggml-parakeet`, 1),
		"a part name": strings.Replace(ok, `q8_0.bin"`, `q8_0.bin.part"`, 1),
		"plain http":  strings.Replace(ok, `https://huggingface.co`, `http://huggingface.co`, 1),
		"no size":     strings.Replace(ok, `668757119`, `0`, 1),
		"upper case":  strings.Replace(ok, sum, strings.ToUpper(sum), 1),
		"twice":       strings.Replace(ok, `}]}`, `},`+ok[11:len(ok)-2]+`]}`, 1),
		"no models":   `{"models":[]}`,
		"not json":    `{`,
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
}
