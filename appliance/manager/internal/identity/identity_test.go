package identity

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateLoadAndPermissions(t *testing.T) {
	p := filepath.Join(t.TempDir(), "id", "management.key")
	k, err := Generate(p)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := Load(p)
	if err != nil || !k2.Public.Equal(k.Public) {
		t.Fatalf("load: %v", err)
	}
	if _, err := Generate(p); err == nil {
		t.Fatal("overwrote key")
	}
	os.Chmod(p, 0o640)
	if _, err := Load(p); !errors.Is(err, ErrPermissions) {
		t.Fatalf("0640 accepted: %v", err)
	}
	os.Chmod(p, 0o600)
	link := filepath.Join(t.TempDir(), "link.key")
	os.Symlink(p, link)
	if _, err := Load(link); err == nil {
		t.Fatal("symlink followed")
	}
}
